// POST /api/ask { transcriptionId, question, at? }  → Server-Sent Events:
//   event: status  {status: "searching" | "answering"}
//   event: delta   {text}                 (answer text as it is written)
//   event: done    {id, answer, refs, found, unsupported, cached}
//   event: error   {error, message}
// Requires a signed-in user. `at` is the current playback position, used for "explain this part".
import { authenticate, readJson, sendError, isUuid } from '../server/http.js';
import { askTranscript } from '../server/ai/service.js';
import { AIError } from '../server/ai/provider.js';

export default async function handler(req, res) {
  let streaming = false;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    if (req.method !== 'POST') throw new AIError('Method not allowed.', { status: 405, code: 'method_not_allowed' });
    const { db } = await authenticate(req);
    const body = await readJson(req);
    if (!isUuid(body.transcriptionId)) throw new AIError('Invalid transcript.', { status: 400, code: 'bad_request' });
    const at = Number.isFinite(body.at) && body.at >= 0 ? body.at : null;

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    streaming = true;

    const result = await askTranscript(db, { transcriptionId: body.transcriptionId, question: body.question, at }, (ev) => {
      if (ev.type === 'delta') send('delta', { text: ev.text });
      else if (ev.type === 'status') send('status', { status: ev.status });
    });
    send('done', result);
    res.end();
  } catch (err) {
    if (!streaming) return sendError(res, err);
    const known = err instanceof AIError;
    if (!known) console.error('[ask] unexpected error:', err?.name || 'Error');
    send('error', { error: known ? err.code : 'server_error', message: known ? err.message : "The answer couldn't be generated. Try again." });
    res.end();
  }
}
