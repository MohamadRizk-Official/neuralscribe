// Database access for the AI functions, through a Supabase client that carries the signed-in user's own
// access token. Every query therefore runs under Row Level Security as that user: the server can only
// read and write what the user could, and it never chooses user_id (the database fills it in).
// No service-role / secret key is used anywhere.
import { AIError } from './ai/provider.js';

const TRANSCRIPT_COLUMNS = 'id, title, duration_seconds, language, recording_type, transcript_text, segments, content_version';
const INSIGHT_COLUMNS = 'id, transcription_id, kind, recording_type, status, content, error, source_version, updated_at';

function check(error, what) {
  if (error) throw new AIError(`Couldn't ${what}.`, { status: 500, code: 'db_error' });
}

export function supabaseStore(sb) {
  return {
    async getTranscription(id) {
      const { data, error } = await sb.from('transcriptions').select(TRANSCRIPT_COLUMNS).eq('id', id).maybeSingle();
      check(error, 'load the transcript');
      return data;
    },
    async listInsights(transcriptionId) {
      const { data, error } = await sb.from('transcription_insights').select(INSIGHT_COLUMNS).eq('transcription_id', transcriptionId);
      check(error, 'load saved results');
      return data;
    },
    async getInsight(transcriptionId, kind, recordingType) {
      const { data, error } = await sb.from('transcription_insights').select(INSIGHT_COLUMNS)
        .eq('transcription_id', transcriptionId).eq('kind', kind).eq('recording_type', recordingType).maybeSingle();
      check(error, 'load saved results');
      return data;
    },
    // Mark a result as being generated. Returns the row, or null if another request claimed it first.
    async startInsight(existing, { transcriptionId, kind, recordingType, version }) {
      const fields = { status: 'generating', error: null, source_version: version };
      if (existing) {
        const { data, error } = await sb.from('transcription_insights').update(fields).eq('id', existing.id)
          .eq('updated_at', existing.updated_at) // only if nobody touched it since we read it
          .select(INSIGHT_COLUMNS);
        check(error, 'save progress');
        return data[0] || null;
      }
      const { data, error } = await sb.from('transcription_insights')
        .insert({ transcription_id: transcriptionId, kind, recording_type: recordingType, ...fields }).select(INSIGHT_COLUMNS);
      if (error?.code === '23505') return null; // unique (transcription, kind, type): someone else just started it
      check(error, 'save progress');
      return data[0];
    },
    async finishInsight(id, { content, model, usage }) {
      const { data, error } = await sb.from('transcription_insights')
        .update({ status: 'ready', content, error: null, model, input_tokens: usage.input, output_tokens: usage.output })
        .eq('id', id).select(INSIGHT_COLUMNS).single();
      check(error, 'save the result');
      return data;
    },
    async failInsight(id, message) {
      await sb.from('transcription_insights').update({ status: 'failed', error: String(message).slice(0, 500) }).eq('id', id);
    },
    async listQuestions(transcriptionId) {
      const { data, error } = await sb.from('transcription_questions').select('id, question, answer, refs, found, source_version, created_at')
        .eq('transcription_id', transcriptionId).order('created_at', { ascending: true }).limit(100);
      check(error, 'load questions');
      return data;
    },
    async findAnswer(transcriptionId, normalized, version, norm) {
      const { data, error } = await sb.from('transcription_questions').select('id, question, answer, refs, found')
        .eq('transcription_id', transcriptionId).eq('source_version', version).order('created_at', { ascending: false }).limit(100);
      check(error, 'load questions');
      return data.find((q) => norm(q.question) === normalized) || null;
    },
    async saveQuestion({ transcriptionId, question, answer, refs, found, version, model, usage }) {
      const { data, error } = await sb.from('transcription_questions').insert({
        transcription_id: transcriptionId, question, answer, refs, found, source_version: version, model,
        input_tokens: usage.input, output_tokens: usage.output,
      }).select('id').single();
      if (error) return null; // the answer was still shown; failing to keep it isn't worth an error
      return data;
    },
  };
}
