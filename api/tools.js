// POST /api/tools { transcriptionId, kind, settings?, force? }  (or { action: 'grade', … }: see below)
//      → generates one Create-tab output (study guide, flashcards, quiz, recap, draft…), or returns the stored
//        one if it is still current for these settings. Saved outputs come back with GET /api/insights.
// Requires a signed-in user (Authorization: Bearer <Supabase access token>); everything runs as that user,
// so Row Level Security decides which recordings and outputs exist for them.
import { authenticate, readJson, sendJson, sendError, isUuid } from '../server/http.js';
import { generateArtifact, gradeShortAnswer } from '../server/ai/service.js';
import { AIError } from '../server/ai/provider.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    const { db, user } = await authenticate(req);
    const body = await readJson(req);
    if (!isUuid(body.transcriptionId)) throw new AIError('Invalid transcript.', { status: 400, code: 'bad_request' });
    // { action: 'grade', artifactId, index, answer }: check one Practice Quiz short answer by meaning
    if (body.action === 'grade') {
      if (!isUuid(body.artifactId)) throw new AIError('Invalid quiz.', { status: 400, code: 'bad_request' });
      return sendJson(res, 200, await gradeShortAnswer(db, { transcriptionId: body.transcriptionId, artifactId: body.artifactId, index: Number(body.index), answer: body.answer, userId: user.id }));
    }
    const settings = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : {};
    const out = await generateArtifact(db, {
      transcriptionId: body.transcriptionId, kind: String(body.kind || ''), settings, force: body.force === true, userId: user.id,
    });
    return sendJson(res, 200, out);
  } catch (err) {
    sendError(res, err);
  }
}
