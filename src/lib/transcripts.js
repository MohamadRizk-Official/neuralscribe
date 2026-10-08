// Saved transcripts. Every query runs as the signed-in user; Row Level Security in the database
// decides which rows exist for them, so nothing here can reach another user's data.
// user_id is never sent from the browser — the database fills it from auth.uid().
import { supabase } from './supabase.js';

const LIST_COLUMNS = 'id, title, status, duration_seconds, language, recording_type, created_at';

// segments: line-level transcript [{ s, e, sp, t }] (see lib/segments.js) so summaries and answers can
// point at exact moments. recordingType: one of RECORDING_TYPES, or null when the user didn't choose.
export async function saveTranscript({ title, durationSeconds, language, text, segments = null, recordingType = null }) {
  const { data, error } = await supabase
    .from('transcriptions')
    .insert({
      title: (title || 'Untitled transcript').slice(0, 300),
      status: 'completed',
      duration_seconds: Number.isFinite(durationSeconds) ? Math.round(durationSeconds) : null,
      language: language || null,
      recording_type: recordingType || null,
      transcript_text: text,
      segments,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

// Speaker renames / reassignments. The database bumps content_version when text or segments change,
// which marks summaries made from the previous version as out of date.
export async function updateTranscriptText(id, text, segments) {
  const patch = { transcript_text: text };
  if (segments) patch.segments = segments;
  const { data, error } = await supabase.from('transcriptions').update(patch).eq('id', id).select('id');
  if (error) throw error;
  if (!data.length) throw new Error('This transcript no longer exists in your library.');
}

export async function updateRecordingType(id, recordingType) {
  const { error } = await supabase.from('transcriptions').update({ recording_type: recordingType }).eq('id', id);
  if (error) throw error;
}

export async function listTranscripts() {
  const { data, error } = await supabase.from('transcriptions').select(LIST_COLUMNS).order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}

export async function getTranscript(id) {
  const { data, error } = await supabase.from('transcriptions').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data; // null if it doesn't exist or isn't yours
}

export async function deleteTranscript(id) {
  const { data, error } = await supabase.from('transcriptions').delete().eq('id', id).select('id');
  if (error) throw error;
  if (!data.length) throw new Error("This transcript couldn't be deleted (it may already be gone).");
}

// ---- hand-off when someone signs in *after* transcribing ----
// The transcript is parked in this browser's localStorage, then saved once they're signed in.
const PENDING_KEY = 'sparkscribe.pendingSave';
const PENDING_TTL = 24 * 60 * 60 * 1000;

export function stashPending(payload) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...payload, at: Date.now() })); return true; } catch { return false; }
}
export function peekPending() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (!p || Date.now() - p.at > PENDING_TTL) { localStorage.removeItem(PENDING_KEY); return null; }
    return p;
  } catch { return null; }
}
export function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}

// ---- display helpers shared by Library / detail pages ----
export function fmtDuration(s) {
  if (s == null) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
export function langName(code) {
  if (!code) return '';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}

// transcript_text is the same format as the .txt export:
//   <file name>\nLength: … · Speakers: …\n\n[0:14] Speaker 1:\ntext…\n\n[0:31] Speaker 2:\ntext…
export function parseTranscriptText(text) {
  const groups = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\[(\d{1,2}(?::\d{2}){1,2})\] (.+):$/.exec(line);
    if (m) { cur = { time: m[1], speaker: m[2], text: '' }; groups.push(cur); }
    else if (cur && line.trim()) cur.text += (cur.text ? ' ' : '') + line.trim();
  }
  return groups;
}
