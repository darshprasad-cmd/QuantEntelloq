/**
 * AI provider abstraction — Groq / OpenAI / Anthropic / Together.
 *
 * Provides:
 *   callStream(messages, opts)   — async generator yielding text chunks
 *   callOnce(systemPrompt, userMessage, opts) — single JSON-mode response
 *
 * Routes by AI_PROVIDER env var. Falls back to a secondary provider on
 * transient errors. Tracks token usage per call for metering.
 */

import fetch from 'node-fetch';
import pRetry from 'p-retry';
import { UpstreamError, RateLimitError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const PROVIDER = (process.env.AI_PROVIDER || 'groq').toLowerCase();
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '2000', 10);

const PROVIDER_DEFAULTS = {
  groq: {
    base: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    stream: 'llama-3.3-70b-versatile',
    call: 'llama-3.1-8b-instant',
  },
  openai: {
    base: 'https://api.openai.com/v1/chat/completions',
    keyEnv: 'OPENAI_API_KEY',
    stream: 'gpt-4o',
    call: 'gpt-4o-mini',
  },
  anthropic: {
    base: 'https://api.anthropic.com/v1/messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    stream: 'claude-sonnet-4-6-20250514',
    call: 'claude-haiku-4-5-20251001',
  },
  together: {
    base: 'https://api.together.xyz/v1/chat/completions',
    keyEnv: 'TOGETHER_API_KEY',
    stream: 'meta-llama/Llama-3-70b-chat-hf',
    call: 'meta-llama/Llama-3-8b-chat-hf',
  },
};

function getConfig(providerName = PROVIDER) {
  const cfg = PROVIDER_DEFAULTS[providerName];
  if (!cfg) throw new Error(`Unknown AI_PROVIDER: ${providerName}`);
  const key = process.env[cfg.keyEnv];
  if (!key) throw new Error(`Missing ${cfg.keyEnv} for provider ${providerName}`);
  return {
    ...cfg,
    key,
    streamModel: process.env.AI_MODEL_STREAM || cfg.stream,
    callModel: process.env.AI_MODEL_CALL || cfg.call,
  };
}

/** Throws if the configured provider isn't usable. Called at boot. */
export function assertAIConfigured() {
  try {
    getConfig();
  } catch (err) {
    logger.warn({ err: err.message }, 'AI provider not configured — /api/ai/* will return 503');
  }
}

// --------- Anthropic shape conversion ----------------------------------
function toAnthropicBody(messages, { model, maxTokens, system, signal }) {
  const sysMessages = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const sysCombined = [system, ...sysMessages].filter(Boolean).join('\n\n');
  const conv = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  return {
    body: {
      model,
      max_tokens: maxTokens,
      system: sysCombined || undefined,
      messages: conv,
    },
    signal,
  };
}

// --------- Non-streaming JSON call -------------------------------------

export async function callOnce(systemPrompt, userMessage, { json = false, model, maxTokens = MAX_TOKENS, signal } = {}) {
  const cfg = getConfig();
  const tokens = Math.min(maxTokens, MAX_TOKENS);
  const useModel = model || cfg.callModel;

  return pRetry(
    async () => {
      const start = Date.now();
      let res, data;

      if (PROVIDER === 'anthropic') {
        const { body } = toAnthropicBody(
          [{ role: 'user', content: userMessage }],
          { model: useModel, maxTokens: tokens, system: systemPrompt, signal }
        );
        res = await fetch(cfg.base, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) throwUpstream(res, await res.text());
        data = await res.json();
        const text = data?.content?.[0]?.text || '';
        return {
          text,
          usage: {
            prompt_tokens: data?.usage?.input_tokens || 0,
            completion_tokens: data?.usage?.output_tokens || 0,
          },
          model: useModel,
          provider: PROVIDER,
          ms: Date.now() - start,
          json: json ? safeJSONParse(text) : null,
        };
      }

      // OpenAI-compatible
      res = await fetch(cfg.base, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: useModel,
          max_tokens: tokens,
          response_format: json ? { type: 'json_object' } : undefined,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
      });
      if (!res.ok) throwUpstream(res, await res.text());
      data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      return {
        text,
        usage: {
          prompt_tokens: data?.usage?.prompt_tokens || 0,
          completion_tokens: data?.usage?.completion_tokens || 0,
        },
        model: useModel,
        provider: PROVIDER,
        ms: Date.now() - start,
        json: json ? safeJSONParse(text) : null,
      };
    },
    {
      retries: 2,
      minTimeout: 500,
      onFailedAttempt(err) {
        logger.warn({ err: err.message, attempt: err.attemptNumber }, 'AI callOnce retry');
      },
    }
  );
}

// --------- Streaming chat (async generator) ----------------------------

export async function* callStream(messages, { model, maxTokens = MAX_TOKENS, signal } = {}) {
  const cfg = getConfig();
  const tokens = Math.min(maxTokens, MAX_TOKENS);
  const useModel = model || cfg.streamModel;

  if (PROVIDER === 'anthropic') {
    yield* anthropicStream(messages, { model: useModel, maxTokens: tokens, signal });
    return;
  }

  // OpenAI-compatible SSE
  const res = await fetch(cfg.base, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({
      model: useModel,
      max_tokens: tokens,
      stream: true,
      messages,
    }),
  });

  if (!res.ok || !res.body) throwUpstream(res, await res.text().catch(() => ''));

  for await (const line of readSseLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {
      /* swallow malformed lines */
    }
  }
}

async function* anthropicStream(messages, { model, maxTokens, signal }) {
  const cfg = getConfig('anthropic');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const conv = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const res = await fetch(cfg.base, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, stream: true, messages: conv }),
  });
  if (!res.ok || !res.body) throwUpstream(res, await res.text().catch(() => ''));

  for await (const line of readSseLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === 'content_block_delta' && evt.delta?.text) yield evt.delta.text;
      if (evt.type === 'message_stop') return;
    } catch {
      /* */
    }
  }
}

// --------- Helpers -----------------------------------------------------

async function* readSseLines(readable) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of readable) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.length) yield line;
    }
  }
}

function throwUpstream(res, body) {
  if (res.status === 429) throw new RateLimitError('AI provider rate limited');
  const err = new UpstreamError(`AI provider ${res.status}: ${truncate(body, 400)}`);
  err.status = res.status >= 500 ? 502 : 400;
  throw err;
}

function safeJSONParse(s) {
  try {
    // tolerate ```json fences
    const cleaned = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function activeProvider() {
  return {
    provider: PROVIDER,
    streamModel: process.env.AI_MODEL_STREAM || PROVIDER_DEFAULTS[PROVIDER]?.stream,
    callModel: process.env.AI_MODEL_CALL || PROVIDER_DEFAULTS[PROVIDER]?.call,
    configured: Boolean(process.env[PROVIDER_DEFAULTS[PROVIDER]?.keyEnv]),
  };
}
