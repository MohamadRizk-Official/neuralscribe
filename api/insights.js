// GET  /api/insights?transcriptionId=…   → everything already generated for a transcript (no AI call)
// POST /api/insights { transcriptionId, kind, recordingType?, force? }
//      → generates one result, or returns the stored one if it is still current
// Requires a signed-in user (Authorization: Bearer <Supabase access token>).
import { authenticate, readJson, sendJson, sendError, isUuid } from '../server/http.js';
import { getState, generate } from '../server/ai/service.js';
import { AIError } from '../server/ai/provider.js';

export default async function handler(req, res) {
  try {
    const { db, user } = await authenticate(req);
    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('transcriptionId');
      if (!isUuid(id)) throw new AIError('Invalid transcript.', { status: 400, code: 'bad_request' });
      return sendJson(res, 200, await getState(db, id));
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!isUuid(body.transcriptionId)) throw new AIError('Invalid transcript.', { status: 400, code: 'bad_request' });
      const out = await generate(db, {
        transcriptionId: body.transcriptionId, kind: String(body.kind || ''), recordingType: body.recordingType, force: body.force === true,
        userId: user.id,
      });
      return sendJson(res, 200, out);
    }
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    sendError(res, err);
  }
}
