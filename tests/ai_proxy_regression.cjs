const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const start = source.indexOf('function qzGetProvider()');
const end = source.indexOf('/* ============================================================', start);
assert.ok(start > 0 && end > start, 'production AI functions are present');

function setup(fetch, { server = false, timeout = false } = {}) {
  let now = Date.now();
  const context = vm.createContext({
    window: { _QZ_SERVER_MODE: server }, fetch,
    localStorage: { getItem() { throw new Error('AI must not read browser keys'); } },
    document: { querySelectorAll: () => [] },
    AbortController, TextDecoder,
    Date: { now: () => (now += 10000) },
    setTimeout(fn, ms) {
      const timer = setTimeout(fn, timeout && ms === 45000 ? 1 : ms);
      if (ms === 45000 && !timeout) timer.unref();
      return timer;
    },
    clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source.slice(start, end) + '\nthis.ai = {qzGetProvider,qzAIStream,qzAICall,_qzRL};', context);
  context.ai._testContext = context;
  return context.ai;
}

const encoder = new TextEncoder();
function sse(text, splitAt = 0) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      if (splitAt) {
        controller.enqueue(bytes.slice(0, splitAt));
        controller.enqueue(bytes.slice(splitAt));
      } else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function collect(iterator) {
  let result = '';
  for await (const chunk of iterator) result += chunk;
  return result;
}
const messages = [{ role: 'user', content: 'Explain volatility.' }];

test('static assistants explicitly call the managed proxy without browser credentials', async () => {
  let request;
  const ai = setup(async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return Response.json({ choices: [{ message: { content: 'A useful answer.' } }] });
  });
  assert.equal(ai.qzGetProvider().provider, 'proxy');
  assert.equal(await ai.qzAICall('System', 'Question', 320), 'A useful answer.');
  assert.equal(request.url, 'https://groq-proxy.physicsedge.workers.dev/openai/v1/chat/completions');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.ok(request.init.signal);
  assert.equal(request.body.model, 'openai/gpt-oss-20b');
  assert.equal(request.body.max_completion_tokens, 2048);
  assert.equal(request.body.include_reasoning, false);
  assert.equal(request.body.reasoning_effort, 'low');
  assert.equal(request.body.reasoning_format, undefined);
  assert.equal(ai._qzRL.inflight(), 0);
});

test('routine calls accept older Worker aliases during rollout', async () => {
  for (const alias of ['text', 'content', 'result']) {
    const ai = setup(async () => Response.json({ [alias]: 'Legacy answer' }));
    assert.equal(await ai.qzAICall('System', 'Question'), 'Legacy answer');
  }
});

test('routine failures and empty responses are not shown as successful answers', async () => {
  const failed = setup(async () => Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }));
  await assert.rejects(failed.qzAICall('System', 'Question'), /Service unavailable/);
  const empty = setup(async () => Response.json({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(empty.qzAICall('System', 'Question'), /empty response/);
});

test('streaming handles split Unicode, no-space data fields and final unterminated frame', async () => {
  let request;
  const wire = 'data:{"choices":[{"delta":{"content":"Risk → reward"}}]}\r\n\r\ndata: [DONE]';
  const ai = setup(async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return sse(wire, encoder.encode(wire.slice(0, wire.indexOf('→'))).length + 1);
  });
  assert.equal(await collect(ai.qzAIStream('System', messages, 512)), 'Risk → reward');
  assert.equal(request.body.model, 'openai/gpt-oss-120b');
  assert.equal(request.body.max_completion_tokens, 2048);
  assert.equal(request.init.signal.aborted, true, 'completion releases request timer');
  assert.equal(ai._qzRL.inflight(), 0);
});

test('authenticated server mode matches route payloads and backend SSE delta shape', async () => {
  const requests = [];
  const ai = setup(async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return url.endsWith('/call') ? Response.json({ text: 'Server answer' })
      : sse('data: {"delta":"Server stream"}\n\nevent: done\ndata: {"ok":true}\n\n');
  }, { server: true });
  assert.equal(await ai.qzAICall('System', 'Question', 512), 'Server answer');
  assert.equal(requests[0].url, '/api/ai/call');
  assert.equal(requests[0].body.message, 'Question');
  assert.equal(requests[0].body.userMessage, undefined);
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal(await collect(ai.qzAIStream('System', messages)), 'Server stream');
  assert.equal(requests[1].url, '/api/ai/stream');
  assert.deepEqual(requests[1].body.messages[0], { role: 'system', content: 'System' });
  assert.equal(requests[1].body.systemPrompt, undefined);
});

test('SSE error events are surfaced and never cached as partial successes', async () => {
  for (const wire of [
    'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"message":"Provider overloaded"}}\n\n',
    'data: {"delta":"Partial"}\n\nevent: error\ndata: {"message":"Provider overloaded"}\n\n',
  ]) {
    let requests = 0;
    const ai = setup(async () => { requests++; return sse(wire); });
    await assert.rejects(collect(ai.qzAIStream('System', messages)), /Provider overloaded/);
    await assert.rejects(collect(ai.qzAIStream('System', messages)), /Provider overloaded/);
    assert.equal(requests, 2);
    assert.equal(ai._qzRL.inflight(), 0);
  }
});

test('truncated streams are reported and not cached', async () => {
  let requests = 0;
  const ai = setup(async () => { requests++; return sse('data: {"delta":"Partial"}\n\n'); });
  await assert.rejects(collect(ai.qzAIStream('System', messages)), /ended early/);
  await assert.rejects(collect(ai.qzAIStream('System', messages)), /ended early/);
  assert.equal(requests, 2);
});

test('length-limited responses are errors even when followed by DONE', async () => {
  let requests = 0;
  const ai = setup(async () => {
    requests++;
    return sse('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
  });
  await assert.rejects(collect(ai.qzAIStream('System', messages)), /length limit/);
  await assert.rejects(collect(ai.qzAIStream('System', messages)), /length limit/);
  assert.equal(requests, 2);
  const routine = setup(async () => Response.json({ choices: [{ message: { content: 'Partial' }, finish_reason: 'length' }] }));
  await assert.rejects(routine.qzAICall('System', 'Question'), /length limit/);
});

test('stream cancellation reaches fetch and releases the active reader and timer', async () => {
  let signal;
  const ai = setup(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"delta":"Partial"}\n\n'));
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    }));
  });
  const stream = ai.qzAIStream('System', messages);
  assert.equal((await stream.next()).value, 'Partial');
  ai._qzRL.cancelCurrent();
  await assert.rejects(stream.next(), error => error.code === 'AI_STREAM_ERROR' && /interrupted/.test(error.message));
  assert.equal(signal.aborted, true);
  assert.equal(ai._qzRL.inflight(), 0);
  assert.equal(ai._qzRL.cacheGet(ai._qzRL.hash('System', messages)), null);
});

test('empty completed streams fail instead of entering the response cache', async () => {
  for (const wire of ['data: [DONE]\n\n', 'data: {"delta":"  "}\n\nevent: done\ndata: {"ok":true}\n\n']) {
    const ai = setup(async () => sse(wire));
    await assert.rejects(collect(ai.qzAIStream('System', messages)), error => error.code === 'AI_STREAM_ERROR' && /empty response/.test(error.message));
    assert.equal(ai._qzRL.cacheGet(ai._qzRL.hash('System', messages)), null);
  }
});

test('actual chat and voice callers do not save or speak interrupted or empty answers', async () => {
  const chatStart = source.indexOf('  window.sendChat = async function sendChat()');
  const callerEnd = source.indexOf("  console.log('[Quant Entelloq] Part 11 + 12 loaded", chatStart);
  assert.ok(chatStart > 0 && callerEnd > chatStart);
  for (const failure of ['empty', 'abort']) {
    const ai = setup(async () => {
      if (failure === 'empty') return sse('data: [DONE]\n\n');
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (sent) controller.error(new DOMException('Stopped after partial response', 'AbortError'));
        else { sent = true; controller.enqueue(encoder.encode('data: {"delta":"Partial answer"}\n\n')); }
      } }));
    });
    const context = ai._testContext;
    const bubble = { innerHTML: '', dataset: {} };
    const voiceText = { innerHTML: '', textContent: '' };
    const input = { value: 'Explain volatility.', disabled: false, focus() {} };
    const container = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
    const saved = [];
    let spoken = 0;
    let fallback = 0;
    Object.assign(context, {
      MAX_HISTORY: 6,
      addToHistory(role, content) { saved.push({ role, content }); context.window._qeChatHistory.push({ role, content }); },
      buildContext: () => ({ page: 'dashboard' }),
      buildSystemPrompt: () => 'System',
      escapeHtml: text => text,
      formatResponse: text => text,
      confidenceFromText: () => { throw new Error('Incomplete answer must not get confidence'); },
      thinkingHTML: () => 'Thinking',
      getAIResponse: () => { fallback++; return 'Local fallback'; },
      qzSpeak: () => { spoken++; },
      document: { getElementById(id) {
        if (id === 'chat-input') return input;
        if (id === 'chat-messages' || id === 'qe-transcript') return container;
        if (id.startsWith('qe-ai-')) return id.endsWith('-text') ? { innerHTML: '' } : { querySelector: () => bubble };
        if (id.startsWith('qe-think-')) return { querySelector: () => voiceText };
        return null;
      } },
    });
    context.window._qeChatHistory = [];
    context.window.qeHandleQuery = () => { fallback++; };
    vm.runInContext(source.slice(chatStart, callerEnd), context);
    await context.window.sendChat();
    await context.window.qeHandleQuery('Explain volatility.');
    assert.equal(saved.filter(entry => entry.role === 'assistant').length, 0, failure);
    assert.equal(spoken, 0, failure);
    assert.equal(fallback, 0, failure);
    assert.equal(bubble.dataset.aiState, 'error');
    assert.match(bubble.innerHTML, /empty response|interrupted/);
    assert.match(voiceText.textContent, /empty response|interrupted/);
    assert.equal(input.disabled, false);
  }
});

test('routine timeout aborts the network request and clears inflight state', async () => {
  let signal;
  const ai = setup((_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError'))));
  }, { timeout: true });
  await assert.rejects(ai.qzAICall('System', 'Question'), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(ai._qzRL.inflight(), 0);
});
