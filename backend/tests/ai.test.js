import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn() } }));
import fetch from 'node-fetch';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('AI_PROVIDER', 'groq');
  vi.stubEnv('GROQ_API_KEY', 'mock-test-key');
  vi.stubEnv('AI_MODEL_STREAM', '');
  vi.stubEnv('AI_MODEL_CALL', '');
  vi.stubEnv('AI_MAX_TOKENS', '4096');
});
afterEach(() => vi.unstubAllEnvs());

describe('managed Groq defaults', () => {
  it('uses GPT-OSS routine JSON mode with a reasoning-aware budget', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) });
    const { callOnce, activeProvider } = await import('../services/ai.js');
    const signal = new AbortController().signal;
    const result = await callOnce('Return JSON.', 'Question', { json: true, maxTokens: 320, signal });
    const [url, init] = fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.signal).toBe(signal);
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.include_reasoning).toBe(false);
    expect(body.reasoning_effort).toBe('low');
    expect(body.reasoning_format).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(result.json).toEqual({ ok: true });
    expect(activeProvider().streamModel).toBe('openai/gpt-oss-120b');
    expect(activeProvider().key).toBeUndefined();
  });

  it('streams chat with the configured signal and clamps the maximum budget', async () => {
    fetch.mockResolvedValue({ ok: true, body: Readable.from([
      Buffer.from('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n'),
    ]) });
    const { callStream } = await import('../services/ai.js');
    const signal = new AbortController().signal;
    let text = '';
    for await (const chunk of callStream([{ role: 'user', content: 'Question' }], { maxTokens: 10000, signal })) text += chunk;
    const init = fetch.mock.calls[0][1];
    expect(text).toBe('Hello');
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body)).toMatchObject({ model: 'openai/gpt-oss-120b', max_completion_tokens: 4096, include_reasoning: false, stream: true });
  });

  it('propagates upstream SSE errors to the route instead of silently completing', async () => {
    fetch.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from('data: {"error":{"message":"Overloaded"}}\n\n')]) });
    const { callStream } = await import('../services/ai.js');
    await expect(callStream([{ role: 'user', content: 'Question' }]).next()).rejects.toThrow('AI provider stream failed');
  });

  it('rejects length-limited streams instead of completing them successfully', async () => {
    fetch.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')]) });
    const { callStream } = await import('../services/ai.js');
    await expect(callStream([{ role: 'user', content: 'Question' }]).next()).rejects.toThrow('length limit');
  });

  it('rejects upstream EOF after partial content without a DONE marker', async () => {
    fetch.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n')]) });
    const { callStream } = await import('../services/ai.js');
    const stream = callStream([{ role: 'user', content: 'Question' }]);
    expect((await stream.next()).value).toBe('Partial');
    await expect(stream.next()).rejects.toThrow('ended early');
  });

  it('rejects empty and whitespace-only completions even with DONE', async () => {
    const { callStream } = await import('../services/ai.js');
    for (const wire of ['data: [DONE]\n\n', 'data: {"choices":[{"delta":{"content":"  "}}]}\n\ndata: [DONE]\n\n']) {
      fetch.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from(wire)]) });
      const consume = async () => { for await (const _chunk of callStream([{ role: 'user', content: 'Question' }])) { /* drain */ } };
      await expect(consume()).rejects.toThrow('empty response');
    }
  });

  it('accepts a complete final DONE frame without a trailing newline', async () => {
    fetch.mockResolvedValue({ ok: true, body: Readable.from([Buffer.from('data: {"choices":[{"delta":{"content":"Complete"}}]}\n\ndata: [DONE]')]) });
    const { callStream } = await import('../services/ai.js');
    let text = '';
    for await (const chunk of callStream([{ role: 'user', content: 'Question' }])) text += chunk;
    expect(text).toBe('Complete');
  });

  it('preserves the default token budget for other providers', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai');
    vi.stubEnv('AI_MAX_TOKENS', '');
    vi.stubEnv('OPENAI_API_KEY', 'mock-test-key');
    fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'Answer' } }] }) });
    const { callOnce } = await import('../services/ai.js');
    await callOnce('System', 'Question');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 2000 });
  });
});
