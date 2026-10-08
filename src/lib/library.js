// My Library: listing, search, favorites, folders, renaming. Everything runs as the signed-in user through
// Supabase; Row Level Security decides what exists for them, and the database functions (library_list,
// search_library, library_stats) are SECURITY INVOKER, so they see exactly the same rows. No AI is used here.
import { supabase } from './supabase.js';

export const PAGE_SIZE = 24;
export const SEARCH_PAGE_SIZE = 10;

const raise = (error) => { if (error) throw error; };

// One page of the Library. view: 'all' | 'favorites' | 'recent'; type: recording type or null;
// folder: folder id or null; since: Date or null; sort: 'newest' | 'oldest' | 'longest' | 'shortest' | 'az' | 'recent'.
export async function listLibrary({ view = 'all', type = null, folder = null, since = null, sort = 'newest', offset = 0, limit = PAGE_SIZE } = {}) {
  const { data, error } = await supabase.rpc('library_list', {
    p_view: view, p_type: type, p_folder: folder, p_since: since ? since.toISOString() : null,
    p_sort: sort, p_limit: limit, p_offset: offset,
  });
  raise(error);
  return { rows: data || [], total: data?.length ? Number(data[0].total) : offset ? null : 0 };
}

// Search titles, transcripts, speaker names and (labelled) Notes. Each result carries its matching lines with
// timestamps; snippets mark matched words with \u0002…\u0003 (see highlight()).
export async function searchLibrary(query, { offset = 0, limit = SEARCH_PAGE_SIZE } = {}) {
  const { data, error } = await supabase.rpc('search_library', { p_query: query, p_limit: limit, p_offset: offset });
  raise(error);
  return data || [];
}

export async function libraryStats() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1); // the user's own month, not UTC's
  const { data, error } = await supabase.rpc('library_stats', { p_month_start: monthStart.toISOString() });
  raise(error);
  return data?.[0] || { recordings: 0, seconds: 0, this_month: 0, favorites: 0, by_type: {} };
}

// ---- recordings ----
export async function renameTranscript(id, title) {
  title = String(title || '').trim().slice(0, 300);
  if (!title) throw new Error('The name can’t be empty.');
  const { data, error } = await supabase.from('transcriptions').update({ title }).eq('id', id).select('id');
  raise(error);
  if (!data.length) throw new Error('This recording no longer exists in your library.');
  return title;
}

export async function setFavorite(ids, value) {
  ids = [].concat(ids);
  const { error } = await supabase.from('transcriptions').update({ is_favorite: !!value }).in('id', ids);
  raise(error);
}

export async function deleteTranscripts(ids) {
  ids = [].concat(ids);
  const { data, error } = await supabase.from('transcriptions').delete().in('id', ids).select('id');
  raise(error);
  return data.length;
}

// "Recent" = recently opened. Best effort: a failure here must never block opening a recording.
export function markOpened(id) {
  supabase.from('transcriptions').update({ last_opened_at: new Date().toISOString() }).eq('id', id).then(() => {}, () => {});
}

export async function getRecordingMeta(id) {
  const { data, error } = await supabase.from('transcriptions').select('is_favorite, folder_items(folder_id)').eq('id', id).maybeSingle();
  raise(error);
  return data ? { isFavorite: data.is_favorite, folderIds: (data.folder_items || []).map((f) => f.folder_id) } : null;
}

// ---- folders ----
export async function listFolders() {
  const { data, error } = await supabase.from('folders').select('id, name, created_at, folder_items(count)').order('name');
  raise(error);
  return (data || []).map((f) => ({ id: f.id, name: f.name, count: f.folder_items?.[0]?.count ?? 0 }));
}

const folderError = (error) => {
  if (error?.code === '23505') return new Error('You already have a folder with that name.');
  if (error?.code === '23514') return new Error('Folder names need 1–80 characters.');
  return error;
};

export async function createFolder(name) {
  const { data, error } = await supabase.from('folders').insert({ name: String(name || '').trim() }).select('id, name').single();
  if (error) throw folderError(error);
  return { ...data, count: 0 };
}

export async function renameFolder(id, name) {
  const { error } = await supabase.from('folders').update({ name: String(name || '').trim() }).eq('id', id);
  if (error) throw folderError(error);
}

// Removes the folder and its memberships only. Recordings are never deleted with a folder.
export async function deleteFolder(id) {
  const { error } = await supabase.from('folders').delete().eq('id', id);
  raise(error);
}

export async function addToFolder(folderId, ids) {
  const rows = [].concat(ids).map((transcription_id) => ({ folder_id: folderId, transcription_id }));
  const { error } = await supabase.from('folder_items').upsert(rows, { onConflict: 'folder_id,transcription_id', ignoreDuplicates: true });
  raise(error);
}

export async function removeFromFolder(folderId, ids) {
  const { error } = await supabase.from('folder_items').delete().eq('folder_id', folderId).in('transcription_id', [].concat(ids));
  raise(error);
}

// ---- display helpers ----
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Snippet from search_library -> safe HTML with <mark> around matched words.
export function highlight(snippet) {
  return String(snippet || '').replace(/[&<>"']/g, (c) => ESC[c]).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');
}

export function fmtHours(seconds) {
  const h = (seconds || 0) / 3600;
  if (h < 1) return `${Math.round((seconds || 0) / 60)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
}
