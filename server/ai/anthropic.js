// Anthropic Messages API client (plain fetch, no SDK). Server-side only: the key comes from
// process.env.ANTHROPIC_API_KEY and is never sent to the browser or logged.
const API_URL = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const TIMEOUT_MS = 55_000;

export class AIError extends Error {
  constructor(message, { status = 502, code = 'ai_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function buildBody({ model, system, messages, schema, maxTokens, effort, stream }) {
  const output_config = {};
  if (effort) output_config.effort = effort;
  if (schema) output_config.format = { type: 'json_schema', schema };
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(Object.keys(output_config).length && { output_config }),
    ...(stream && { stream: true }),
  };
}

async function post(apiKey, body) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = new AIError(err.name === 'TimeoutError' ? 'The analysis took too long.' : 'Could not reach the analysis service.', { status: 504 });
      continue;
    }
    if (res.ok) return res;
    // retry once on overload / rate limit / server errors
    if ([429, 500, 502, 503, 529].includes(res.status) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      lastErr = new AIError('The analysis service is busy.', { status: 503 });
      continue;
    }
    // details stay in the server log (status and error type only — never the request or the key)
    let type = '';
    try { type = (await res.json())?.error?.type || ''; } catch {}
    console.error(`[ai] Anthropic request failed: HTTP ${res.status}${type ? ` (${type})` : ''}`);
    throw new AIError(res.status === 401 ? 'The analysis service is not set up correctly.' : 'The analysis service returned an error.',
      { status: res.status === 429 ? 503 : 502 });
  }
  throw lastErr;
}

// input = all prompt tokens; the parts are priced differently (cache reads are 10% of the input price)
const usageOf = (u = {}) => ({
  input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
  uncached: u.input_tokens || 0,
  cacheWrite: u.cache_creation_input_tokens || 0,
  cacheRead: u.cache_read_input_tokens || 0,
  output: u.output_tokens || 0,
});

export function anthropicProvider(apiKey) {
  return {
    name: 'anthropic',
    async complete(opts) {
      const res = await post(apiKey, buildBody(opts));
      const msg = await res.json();
      if (msg.stop_reason === 'max_tokens') throw new AIError('The result was too long to finish.', { code: 'too_long' });
      if (msg.stop_reason === 'refusal') throw new AIError('The analysis was declined for this content.', { code: 'refused' });
      const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      let json = null;
      if (opts.schema) {
        try { json = JSON.parse(text); } catch { throw new AIError('The analysis came back in an unexpected format.'); }
      }
      return { text, json, model: msg.model || opts.model, usage: usageOf(msg.usage) };
    },
    // Streams text deltas to onDelta; resolves with the full text.
    async stream(opts, onDelta) {
      const res = await post(apiKey, buildBody({ ...opts, stream: true }));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '', model = opts.model, stop = null;
      const usage = { input: 0, output: 0 };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.type === 'message_start') { model = ev.message?.model || model; Object.assign(usage, usageOf(ev.message?.usage)); }
          else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { text += ev.delta.text; onDelta(ev.delta.text); }
          else if (ev.type === 'message_delta') { stop = ev.delta?.stop_reason || stop; if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens; }
          else if (ev.type === 'error') throw new AIError(ev.error?.message || 'The analysis stream failed.');
        }
      }
      if (stop === 'refusal') throw new AIError('The analysis was declined for this content.', { code: 'refused' });
      return { text, model, usage, truncated: stop === 'max_tokens' };
    },
  };
}
