// Result-page intelligence: the TRANSCRIPT / SUMMARY / NOTES / ASK / CREATE tabs, plus the recording-type control
// in the page header. Summary = what happened; Notes = what was said, extracted and organized; Ask = questions;
// Create = new things made from the recording.
// Used by the live result page (src/main.js) and the saved transcript page (src/pages/transcript.js).
// The transcript stays the source of truth: everything here is generated from it on request, stored with
// it, and every reference points back to a real line and timestamp.
import { fetchState, requestInsight, requestTool, askQuestion, gradeAnswer, ApiError } from './api.js';
import { createToolsUI, artifactBlocks, blocksToText, TOOL_INFO, toolsFor } from './tools.js';
import { openExportDialog } from './export.js';
import { watchNames, renameInText } from '../lib/speaker-names.js';
import { cleanText } from '../lib/clean.js';
import { supabase } from '../lib/supabase.js';
import { normalizeToolSettings, describeSettings } from '../lib/tool-settings.js';
import { makeDialog } from '../library/dialogs.js';
import { mascotSignal } from '../mascot/bus.js';
import { fmtClock, splitCitations, RECORDING_TYPES, RECORDING_TYPE_LABEL, normalizeRecordingType, isNotFound, refersToPlayback } from '../lib/segments.js';

const CONSENT_KEY = 'sparkscribe.aiConsent';
const POLL_MS = 3000;
const CHAPTER_MIN_S = 8 * 60;

const hasConsent = () => { try { return localStorage.getItem(CONSENT_KEY) === '1'; } catch { return false; } };
const giveConsent = () => { try { localStorage.setItem(CONSENT_KEY, '1'); } catch {} };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4m0 3v.01"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

// Notes are built from two stored analyses of the recording: topic notes (kind "notes") and the structured
// extraction (kind "insights", formerly its own tab). A voice message only needs the structured part.
const NOTES_PARTS = (t) => (t === 'voice_message' ? ['insights'] : ['notes', 'insights']);
const NOTES_INTRO = {
  general: 'Main topics, key information, actions, decisions and dates & times.',
  meeting: 'Discussion topics, decisions, action items with owners and deadlines, open questions and follow-ups.',
  lecture: 'Topics, concepts, definitions, examples, what the lecturer stressed and explicit exam information.',
  interview: 'Questions and answers, themes, observations and important quotes.',
  podcast: 'Topics, arguments, examples, key takeaways and quotes.',
  voice_message: 'Key information, requested actions and dates & times.',
};
const TOPICS_LABEL = { general: 'Main topics', meeting: 'Discussion topics', lecture: 'Topics', interview: 'Themes & observations', podcast: 'Topics', voice_message: 'Notes' };
// For interviews and voice messages the structured part leads; elsewhere the topic notes do.
const STRUCTURED_FIRST = new Set(['interview', 'voice_message']);
// When both parts exist, each piece of information is shown once: these structured sections are already
// covered by the topic notes, and these note types are shown (with evidence) in the structured sections.
const HIDE_SECTIONS = { lecture: ['key_concepts', 'important_topics'], interview: ['major_topics'], podcast: ['main_topics'] };
const HIDE_NOTE_TYPES = { meeting: ['decision', 'open_issue', 'follow_up'], lecture: ['definition', 'exam'], interview: ['question', 'response'], podcast: ['takeaway'] };

// small label in front of a note; plain points and details get none
const NOTE_TYPE_LABEL = {
  statement: 'Said', concept: 'Concept', definition: 'Definition', example: 'Example', emphasis: 'Emphasised', exam: 'Exam',
  decision: 'Decision', open_issue: 'Open issue', follow_up: 'Follow-up', question: 'Question', response: 'Response',
  theme: 'Theme', observation: 'Observation', argument: 'Argument', takeaway: 'Takeaway',
};
// notes that always get a timestamp, even when the model did not mark them as key
const NOTE_ALWAYS_TIMED = new Set(['decision', 'exam', 'follow_up', 'definition']);

const SECTION_ORDER = {
  general: ['action_items', 'decisions', 'important_dates', 'suggestions', 'priorities', 'concerns'],
  meeting: ['decisions', 'action_items', 'important_dates', 'open_questions', 'follow_ups', 'suggestions', 'priorities', 'concerns'],
  lecture: ['definitions', 'exam_points', 'worth_reviewing', 'key_concepts', 'important_topics'],
  interview: ['questions', 'notable_quotes', 'key_takeaways', 'major_topics'],
  podcast: ['key_takeaways', 'notable_quotes', 'main_topics'],
  voice_message: ['important_information', 'requested_actions', 'dates_times'],
};
const SECTION_LABEL = {
  action_items: 'Action items', decisions: 'Decisions', suggestions: 'Ideas & suggestions', important_dates: 'Dates & times',
  priorities: 'Priorities', concerns: 'Concerns raised',
  open_questions: 'Open questions', follow_ups: 'Follow-ups', key_concepts: 'Key concepts',
  definitions: 'Definitions', important_topics: 'Important topics', exam_points: 'Explicit exam information', worth_reviewing: 'Worth reviewing',
  questions: 'Questions & answers', major_topics: 'Major topics', notable_quotes: 'Important quotes', key_takeaways: 'Key takeaways',
  main_topics: 'Main topics', important_information: 'Key information', requested_actions: 'Requested actions', dates_times: 'Dates & times',
};
// Notes groups get one restrained accent each: actions cyan, dates violet, decisions blue, questions pink
const SECTION_ACCENT = {
  action_items: 'cyan', requested_actions: 'cyan', follow_ups: 'cyan',
  important_dates: 'violet', dates_times: 'violet',
  decisions: 'blue', priorities: 'blue',
  open_questions: 'pink', questions: 'pink', concerns: 'pink',
  important_information: 'key', key_takeaways: 'key', key_concepts: 'key', definitions: 'key', exam_points: 'key',
};
const SECTION_NOTE = {
  decisions: 'Only where agreement or a decision was stated, with the words that show it.',
  suggestions: 'Proposed in the conversation, but no decision was stated.',
  priorities: 'Stated as priorities or goals, not as decisions.',
  exam_points: 'Only where the lecturer mentioned an exam, test, quiz or assignment.',
  worth_reviewing: 'Stressed in the lecture, but not tied to an exam.',
};
const TYPE_DESC = {
  general: 'Anything else',
  lecture: 'Class or talk: study notes, flashcards, quizzes',
  meeting: 'Decisions, action items, recap and follow-up email',
  interview: 'Questions and answers, quotes',
  podcast: 'Topics, takeaways, episode notes',
  voice_message: 'Short message: key info, tasks, reply draft',
};

// Starter questions per recording type: things people actually want to know about that kind of recording.
const STARTERS = {
  general: ['What was this about?', 'What needs to happen next?', 'Were any dates or deadlines mentioned?', 'What still needs clarification?'],
  meeting: ['What decisions were made?', 'What are my action items?', 'What is still unresolved?', 'Were there deadlines?'],
  lecture: ['What were the main concepts?', 'What did the professor emphasize?', 'Was anything mentioned about the exam?', 'What should I review?'],
  interview: ['What were the main questions asked?', 'What are the key takeaways?', 'What stood out in the answers?'],
  podcast: ['What are the main topics?', 'What are the key takeaways?', 'Were any recommendations made?'],
  voice_message: ['What do they need from me?', 'What should I follow up on?', 'Were any dates or deadlines mentioned?', 'What still needs clarification?'],
};

/**
 * @param {object} o
 * @param {HTMLElement} o.tabBar           container for the tab buttons
 * @param {HTMLElement[]} o.transcriptEls  existing elements that make up the Transcript tab
 * @param {HTMLElement} o.host             where the Summary / Notes / Ask / Create panels are inserted
 * @param {object} o.ctx                   page hooks (see below)
 *   getId() → saved transcription id or null; isSignedIn() → bool; signIn() → void (optional)
 *   getSegments() → [{id,start,end,speaker,text}]; seek(seconds) → void; playbackTime() → seconds|null
 *   getRecordingType() → type|null; setRecordingType(type|null) → Promise; duration() → seconds; savedNote() → html|null
 *   typeSlot() → element for the compact recording-type control (in the page header)
 */
export function mountInsights({ tabBar, transcriptEls, host, ctx }) {
  const st = {
    tab: 'transcript', loaded: false, loadingState: false, contentVersion: null, insights: new Map(), questions: [],
    busy: new Map(), errors: new Map(), stateError: null, notConfigured: false, ask: null, autoDone: false,
    artifacts: new Map(), // Create tab outputs, keyed "kind|settingsKey"
  };
  const akey = (kind, settingsKey = '') => `${kind}|${settingsKey}`;
  const key = (kind, type) => `${kind}:${kind === 'overview' ? 'general' : type}`;
  // One type for the whole recording. Nothing chosen yet -> a free suggestion from length and speakers (no AI),
  // shown as "Auto"; the user can always pick another one (or go back to automatic).
  const storedType = () => (RECORDING_TYPES.includes(ctx.getRecordingType()) ? ctx.getRecordingType() : null);
  function detectType() {
    const segs = ctx.getSegments();
    if (!segs.length) return 'general';
    const speakers = new Set(segs.map((x) => x.speaker).filter((x) => x !== 'Unknown')).size;
    const dur = ctx.duration() || segs.at(-1)?.end || 0;
    const questions = segs.filter((x) => /\?\s*$/.test(x.text)).length / segs.length;
    if (dur <= 180 && speakers <= 1) return 'voice_message';
    if (speakers <= 1 && dur >= 600) return 'lecture';
    if (speakers === 2 && dur >= 300 && questions >= 0.12) return 'interview';
    if (speakers >= 3) return 'meeting';
    return 'general';
  }
  const isAuto = () => !storedType();
  const type = () => normalizeRecordingType(storedType() || detectType());

  // ---------- tabs ----------
  const TABS = [['transcript', 'Transcript'], ['summary', 'Summary'], ['notes', 'Notes'], ['ask', 'Ask'], ['create', 'Create']];
  tabBar.className = 'tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.innerHTML = TABS.map(([k, label]) => `<button class="tab${k === 'transcript' ? ' on' : ''}" type="button" role="tab" data-tab="${k}" aria-selected="${k === 'transcript'}">${label}</button>`).join('')
    + '<span class="tab-ink" aria-hidden="true"></span>';
  // one soft highlight that slides to the active tab
  const ink = tabBar.querySelector('.tab-ink');
  function moveInk() {
    const on = tabBar.querySelector('.tab.on');
    if (!on || !on.offsetWidth) return;
    ink.style.width = `${on.offsetWidth}px`;
    ink.style.transform = `translateX(${on.offsetLeft}px)`;
    tabBar.classList.add('has-ink');
  }
  requestAnimationFrame(moveInk);
  addEventListener('resize', moveInk, { passive: true });
  document.fonts?.ready.then(moveInk);
  if ('ResizeObserver' in window) new ResizeObserver(moveInk).observe(tabBar);
  const panels = {};
  watchNames(host, () => ctx.nameMap?.() || new Map()); // renamed speakers show their new name in every result
  for (const k of ['summary', 'notes', 'ask', 'create']) {
    const p = document.createElement('section');
    p.className = 'tab-panel hidden';
    p.dataset.panel = k;
    p.setAttribute('role', 'tabpanel');
    host.appendChild(p);
    panels[k] = p;
  }
  tabBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    showTab(b.dataset.tab);
    b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); // narrow screens scroll the tab row
  });

  function showTab(name) {
    if (name === 'insights') name = 'notes'; // the former Insights tab now lives in Notes
    if (!TABS.some(([k]) => k === name)) name = 'transcript';
    st.tab = name;
    tabBar.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    moveInk();
    transcriptEls.forEach((el) => el.classList.toggle('tab-hidden', name !== 'transcript'));
    for (const [k, p] of Object.entries(panels)) p.classList.toggle('hidden', k !== name);
    if (name !== 'transcript') { ensureLoaded(); render(); }
  }

  // ---------- data ----------
  async function ensureLoaded(force = false) {
    const id = ctx.getId();
    if (!id || !ctx.isSignedIn() || st.loadingState || (st.loaded && !force)) return;
    st.loadingState = true;
    st.stateError = null;
    try {
      const s = await fetchState(id);
      st.contentVersion = s.contentVersion;
      st.insights = new Map(s.insights.map((i) => [key(i.kind, i.recordingType), i]));
      st.questions = s.questions;
      st.artifacts = new Map((s.artifacts || []).map((a) => [akey(a.kind, a.settingsKey), a]));
      st.loaded = true;
      for (const i of s.insights) if (i.status === 'generating') poll(i.kind, i.recordingType);
      for (const a of s.artifacts || []) if (a.status === 'generating') pollTool(a.kind, a.settingsKey);
    } catch (err) {
      st.stateError = err;
    }
    st.loadingState = false;
    render();
    maybeAuto();
  }

  // After a fresh transcription (live page): once the user has turned summaries on, the overview is made
  // automatically; mode-specific insights too when a recording type was chosen up front.
  function maybeAuto() {
    if (!ctx.autoGenerate || st.autoDone || !st.loaded || !hasConsent()) return;
    st.autoDone = true;
    if (!st.insights.get(key('overview'))) generate('overview');
    if (storedType() && !st.insights.get(key('insights', type()))) generate('insights');
  }

  async function generate(kind, { force = false } = {}) {
    const id = ctx.getId();
    const t = type();
    const k = key(kind, t);
    if (!id || st.busy.has(k)) return;
    giveConsent();
    st.busy.set(k, true);
    st.errors.delete(k);
    render();
    mascotSignal('think-start');
    try {
      const r = await requestInsight(id, kind, t, force);
      st.insights.set(k, r.insight);
      if (r.insight.status === 'generating') poll(kind, t);
      mascotSignal('think-done');
    } catch (err) {
      if (err.code === 'not_configured') st.notConfigured = true;
      st.errors.set(k, err);
      mascotSignal('think-error');
    }
    st.busy.delete(k);
    render();
  }

  // ---------- Create tab outputs (Phase 5): only ever generated by an explicit click ----------
  async function generateTool(kind, settings = {}, force = false) {
    const id = ctx.getId();
    const k = akey(kind, normalizeToolSettings(kind, settings).key);
    if (!id || st.busy.has(`tool:${k}`)) return; // a request for this output is already running
    giveConsent();
    st.busy.set(`tool:${k}`, true);
    st.errors.delete(`tool:${k}`);
    render();
    try {
      const r = await requestTool(id, kind, settings, force);
      st.artifacts.set(akey(r.artifact.kind, r.artifact.settingsKey), r.artifact);
      if (r.artifact.status === 'generating') pollTool(r.artifact.kind, r.artifact.settingsKey);
    } catch (err) {
      if (err.code === 'not_configured') st.notConfigured = true;
      st.errors.set(`tool:${k}`, err);
      // the server kept the previous version; reload it so it stays on screen
      try { const s = await fetchState(id); st.artifacts = new Map((s.artifacts || []).map((a) => [akey(a.kind, a.settingsKey), a])); } catch {}
    }
    st.busy.delete(`tool:${k}`);
    render();
  }
  const pollingTools = new Set();
  function pollTool(kind, settingsKey) {
    const k = akey(kind, settingsKey);
    if (pollingTools.has(k)) return;
    pollingTools.add(k);
    const started = Date.now();
    const tick = async () => {
      try {
        const s = await fetchState(ctx.getId());
        const a = (s.artifacts || []).find((x) => akey(x.kind, x.settingsKey) === k);
        if (a) st.artifacts.set(k, a);
        st.contentVersion = s.contentVersion;
        if (a?.status === 'generating' && Date.now() - started < 150_000) return setTimeout(tick, POLL_MS);
      } catch {}
      pollingTools.delete(k);
      render();
    };
    setTimeout(tick, POLL_MS);
  }
  async function removeArtifact(a) {
    const { error } = await supabase.from('transcription_artifacts').delete().eq('id', a.id);
    if (error) return ctx.toast?.("Couldn't delete it. Try again.");
    st.artifacts.delete(akey(a.kind, a.settingsKey));
    ctx.toast?.('Deleted');
    render();
  }
  async function saveProgress(a, progress) {
    a.progress = progress; // shown right away; saving is best effort (it is only the latest score)
    await supabase.from('transcription_artifacts').update({ progress }).eq('id', a.id).then(() => {}, () => {});
  }

  // Another tab/device is generating this result: wait for it rather than starting a second one.
  const polling = new Set();
  function poll(kind, t) {
    const k = key(kind, t);
    if (polling.has(k)) return;
    polling.add(k);
    const started = Date.now();
    const tick = async () => {
      try {
        const s = await fetchState(ctx.getId());
        const i = s.insights.find((x) => key(x.kind, x.recordingType) === k);
        if (i) st.insights.set(k, i);
        st.contentVersion = s.contentVersion;
        if (i?.status === 'generating' && Date.now() - started < 150_000) return setTimeout(tick, POLL_MS);
      } catch {}
      polling.delete(k);
      render();
    };
    setTimeout(tick, POLL_MS);
  }

  // ---------- rendering helpers ----------
  const segById = () => {
    const m = new Map();
    for (const s of ctx.getSegments()) m.set(s.id, s);
    return m;
  };
  function chips(refs, byId) {
    const seen = new Set();
    return (refs || []).map((r) => byId.get(r)).filter((s) => s && !seen.has(Math.floor(s.start)) && seen.add(Math.floor(s.start)))
      .map((s) => `<button class="cite" type="button" data-seek="${s.start}" data-ref="${s.id}" title="Go to ${fmtClock(s.start)}">${fmtClock(s.start)}</button>`).join('');
  }
  // Model text with [12] citations → escaped HTML with timestamp chips; "- " lines become a list.
  function rich(text, byId) {
    const line = (t) => splitCitations(t, (id) => byId.has(id)).map((p) => (p.refs ? `<span class="cites">${chips(p.refs, byId)}</span>` : esc(p.text))).join('');
    const out = [];
    let list = null;
    for (const raw of String(text).split('\n')) {
      const l = raw.trim();
      if (!l) { list = null; continue; }
      if (/^[-•*]\s+/.test(l)) {
        if (!list) { list = []; out.push(list); }
        list.push(line(l.replace(/^[-•*]\s+/, '')));
      } else { list = null; out.push(`<p>${line(l)}</p>`); }
    }
    return out.map((x) => (Array.isArray(x) ? `<ul>${x.map((i) => `<li>${i}</li>`).join('')}</ul>` : x)).join('');
  }
  const loading = (label) => `<div class="ins-loading" role="status"><span class="spinner sm" aria-hidden="true"></span><span>${esc(label)}…</span></div>`;
  function errorBox(err, retryAct, lead = "Analysis couldn't be generated.") {
    if (err?.code === 'not_configured') return `<div class="ins-msg">${ICON.lock}<span>${esc(err.message)}</span></div>`;
    // add the reason only when it says something specific (busy, timed out, signed out…)
    const msg = String(err?.message || '');
    const detail = msg && !/failed\.?$|couldn['’]t be generated|went wrong|^Request failed/i.test(msg) ? ` ${msg}` : '';
    return `<div class="ins-msg bad">${ICON.warn}<span>${esc(lead + detail)} Try again.</span><button class="btn btn-ghost btn-sm" type="button" data-act="${retryAct}">Try again</button></div>`;
  }
  function staleBox(i, act) {
    if (st.contentVersion == null || i.sourceVersion >= st.contentVersion) return '';
    return `<div class="ins-msg warn">${ICON.refresh}<span>The transcript changed after this was generated (for example, a speaker was renamed), so it may be out of date.</span><button class="btn btn-ghost btn-sm" type="button" data-act="${act}">Update</button></div>`;
  }

  function gate(panel) {
    if (ctx.isSignedIn() && !ctx.getId()) {
      panel.innerHTML = `<div class="panel ins-card">${ctx.saving?.()
        ? loading('Saving this transcript to My Library first')
        : `<div class="ins-msg">${ICON.lock}<span>Summary, Notes, Ask and Create work on transcripts saved in My Library. This one isn't saved yet — use Retry in the bar above.</span></div>`}</div>`;
      return true;
    }
    if (!ctx.getId() || !ctx.isSignedIn()) {
      const can = typeof ctx.signIn === 'function';
      panel.innerHTML = `<div class="panel ins-card ins-gate">
        <div class="ins-gate-icon">${ICON.spark}</div>
        <h3>Summaries, notes, answers and more</h3>
        <p>Get a summary, organized notes, answers about this recording and things made from it, like study guides or reply drafts. These are saved with the transcript, so ${can ? 'they need' : 'it needs'} your free account.</p>
        ${can ? '<button class="btn btn-primary" type="button" data-act="signin">Sign in to continue</button>' : ''}
        ${ctx.savedNote?.() || ''}
      </div>`;
      panel.querySelector('[data-act="signin"]')?.addEventListener('click', () => ctx.signIn());
      return true;
    }
    if (st.stateError) {
      panel.innerHTML = `<div class="panel ins-card">${errorBox(st.stateError, 'reload')}</div>`;
      panel.querySelector('[data-act="reload"]').addEventListener('click', () => ensureLoaded(true));
      return true;
    }
    if (!st.loaded) { panel.innerHTML = `<div class="panel ins-card">${loading('Loading')}</div>`; return true; }
    return false;
  }

  const privacyLine = '<p class="ins-privacy">Created from this transcript\'s text by our AI provider (Anthropic). Your audio is never sent.</p>';

  // ---------- Summary tab ----------
  function renderSummary() {
    const p = panels.summary;
    if (gate(p)) return;
    const byId = segById();
    const ov = st.insights.get(key('overview'));
    const ovBusy = st.busy.has(key('overview')) || ov?.status === 'generating';
    const ovErr = st.errors.get(key('overview')) || (ov?.status === 'failed' ? { message: ov.error } : null);
    const long = (ctx.duration() || 0) >= CHAPTER_MIN_S;
    let html = '';

    if (!ov && !ovBusy && !ovErr) {
      html += `<div class="panel ins-card ins-intro">
        <div class="ins-gate-icon">${ICON.spark}</div>
        <h3>Understand this recording in seconds</h3>
        <p>A short summary and the key points${long ? ', plus chapters you can jump between' : ''}. Created once from the transcript text and saved with it.</p>
        <button class="btn btn-primary" type="button" data-act="overview">Summarize</button>
        ${privacyLine}
      </div>`;
    } else if (ov?.status === 'ready' && ov.content && !ovBusy) {
      const c = ov.content;
      html += staleBox(ov, 'overview-retry');
      html += `<section class="sum-tldr"><span class="sum-eyebrow">${ICON.spark}TL;DR</span><p>${esc(c.short_summary)}</p></section>`;
      if (c.key_points?.length) {
        html += `<section class="sum-sec" aria-labelledby="sumKp"><h3 class="sum-h" id="sumKp">Key points <span>${c.key_points.length}</span></h3>
          <ol class="kp-grid">${c.key_points.map((k, i) => `<li class="kp-card"><span class="kp-n" aria-hidden="true">${i + 1}</span><span class="kp-text">${esc(k.text)}</span>${chips(k.refs, byId)}</li>`).join('')}</ol></section>`;
      }
      if (c.chapters?.length) {
        html += `<section class="sum-sec" aria-labelledby="sumCh"><h3 class="sum-h" id="sumCh">Chapters <span>${c.chapters.length}</span></h3><ol class="chapters timeline">${c.chapters.map((ch) => {
          const s = byId.get(ch.start_ref);
          if (!s) return '';
          return `<li><button type="button" class="chapter" data-seek="${s.start}" data-ref="${s.id}"><span class="ch-time">${fmtClock(s.start)}</span><span class="ch-body"><span class="ch-title">${esc(ch.title)}</span>${ch.summary ? `<span class="ch-sum">${esc(ch.summary)}</span>` : ''}</span></button></li>`;
        }).join('')}</ol></section>`;
      }
    } else {
      html += `<div class="panel ins-card">`;
      if (ovBusy) html += loading(long ? 'Generating summary, key points and chapters' : 'Generating summary and key points');
      else if (ovErr) html += errorBox(ovErr, 'overview-retry');
      html += `</div>`;
    }

    // detailed summary (on demand)
    const t = type();
    const dk = key('detailed_summary', t);
    const ds = st.insights.get(dk);
    const dsBusy = st.busy.has(dk) || ds?.status === 'generating';
    const dsErr = st.errors.get(dk) || (ds?.status === 'failed' ? { message: ds.error } : null);
    if (ov?.status === 'ready' || ds) {
      if (ds?.status === 'ready' && ds.content && !dsBusy) {
        html += `<details class="panel sum-detail"${st.detailOpen ? ' open' : ''}><summary><span class="sum-h">Detailed summary${t !== 'general' ? ` <span>${esc(RECORDING_TYPE_LABEL[t])}</span>` : ''}</span><span class="sum-detail-hint">${ds.content.sections.length} sections</span><svg class="sum-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
          <div class="sum-detail-body">${staleBox(ds, 'detailed-retry')}${ds.content.sections.map((s) => `<h4 class="ins-h">${esc(s.heading)}</h4><ul class="ins-points">${s.points.map((pt) => `<li><span>${esc(pt.text)}</span>${chips(pt.refs, byId)}</li>`).join('')}</ul>`).join('')}</div></details>`;
      }
      html += `<div class="panel ins-card${ds?.status === 'ready' && ds.content && !dsBusy ? ' hidden' : ''}">`;
      if (dsBusy) html += loading('Writing detailed summary');
      else if (dsErr) html += errorBox(dsErr, 'detailed-retry');
      if (ds?.status === 'ready' && ds.content) {
        /* shown above as an expandable section */
      } else if (!dsBusy && !dsErr) {
        html += `<div class="ins-row"><div><div class="ins-label">Detailed summary</div><p class="ins-sub">A structured, section-by-section summary${t !== 'general' ? ` for a ${esc(RECORDING_TYPE_LABEL[t].toLowerCase())}` : ''}.</p></div><button class="btn btn-ghost" type="button" data-act="detailed">Write detailed summary</button></div>`;
      }
      html += `</div>`;
    }
    p.innerHTML = html;
    p.querySelector('[data-act="overview"]')?.addEventListener('click', () => generate('overview'));
    p.querySelector('[data-act="overview-retry"]')?.addEventListener('click', () => generate('overview', { force: true }));
    p.querySelector('[data-act="detailed"]')?.addEventListener('click', () => generate('detailed_summary'));
    p.querySelector('[data-act="detailed-retry"]')?.addEventListener('click', () => generate('detailed_summary', { force: true }));
    p.querySelector('.sum-detail')?.addEventListener('toggle', (e) => { st.detailOpen = e.currentTarget.open; });
  }

  // ---------- recording type control (page header) ----------
  function renderTypeControl() {
    const slot = ctx.typeSlot?.();
    if (!slot) return;
    const t = type();
    slot.innerHTML = `<button type="button" class="type-ctl" aria-haspopup="dialog" title="Recording type: changes how Notes are organized and which Create tools are suggested">Type <b>${isAuto() ? '<span class="type-auto">Auto</span> · ' : ''}${esc(RECORDING_TYPE_LABEL[t])}</b><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>`;
    slot.querySelector('.type-ctl').addEventListener('click', openTypeDialog);
  }
  function openTypeDialog() {
    const cur = storedType();
    const auto = detectType();
    const opt = (value, label, desc, on) => `<button type="button" class="type-opt${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-type="${value}"><span class="type-opt-name">${esc(label)}</span><span class="type-opt-desc">${esc(desc)}</span></button>`;
    const { dlg, dismiss } = makeDialog('type-dlg', `<h3>Recording type</h3>
      <p class="dlg-dim">Changes how SparkScribe organizes Notes and which Create tools it suggests. The transcript itself never changes.</p>
      <div class="type-list" role="radiogroup" aria-label="Recording type">
        ${opt('', `Automatic (${RECORDING_TYPE_LABEL[auto]})`, 'Suggested from the length and number of speakers', !cur)}
        ${RECORDING_TYPES.map((t) => opt(t, RECORDING_TYPE_LABEL[t], TYPE_DESC[t], cur === t)).join('')}
      </div>
      <div class="confirm-actions"><button class="btn btn-ghost" type="button" data-act="close">Close</button></div>`);
    dlg.querySelector('[data-act=close]').addEventListener('click', dismiss);
    dlg.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', async () => {
      dismiss();
      const next = b.dataset.type || null;
      if (next === cur) return;
      try { await ctx.setRecordingType(next); } catch { ctx.toast?.("Couldn't save the type. Try again."); }
      renderTypeControl();
      tools.reset();
      render(); // Notes and Create follow the new type; nothing is generated by this
      ctx.toast?.(`Type: ${next ? RECORDING_TYPE_LABEL[next] : `Auto (${RECORDING_TYPE_LABEL[detectType()]})`}`);
    }));
  }
  const evidenceLine = (item) => (item.evidence ? `<blockquote class="evidence">“${esc(item.evidence)}”</blockquote>` : '');
  function renderItem(sec, item, byId) {
    const c = chips(item.refs, byId);
    switch (sec) {
      case 'action_items': case 'requested_actions':
        return `<li class="ins-item action"><div class="act-task">${esc(item.task)}</div><dl class="act-meta"><div><dt>Assigned to</dt><dd class="${item.owner ? '' : 'ns'}">${esc(item.owner || 'Not specified')}</dd></div><div><dt>Deadline</dt><dd class="${item.deadline ? '' : 'ns'}">${esc(item.deadline || 'Not specified')}</dd></div></dl>${evidenceLine(item)}${c ? `<div class="act-cites">${c}</div>` : ''}</li>`;
      case 'decisions': case 'exam_points':
        return `<li class="ins-item"><span>${esc(item.text)}</span>${evidenceLine(item)}${c}</li>`;
      case 'important_dates': case 'dates_times':
        return `<li class="ins-item date"><span class="date-when">${esc(item.when)}</span><span class="date-what">${esc(item.what)}</span>${c}</li>`;
      case 'notable_quotes':
        return `<li class="ins-item quote"><blockquote>“${esc(item.quote)}”</blockquote><span class="q-by">${esc(item.speaker)}</span>${c}</li>`;
      case 'key_concepts':
        return `<li class="ins-item"><b>${esc(item.term)}</b> — ${esc(item.explanation)}${c}</li>`;
      case 'definitions':
        return `<li class="ins-item"><b>${esc(item.term)}</b>: ${esc(item.definition)}${c}</li>`;
      case 'questions':
        return `<li class="ins-item qa"><div class="qa-q"><span class="qa-who">${esc(item.asked_by || 'Question')}</span>${esc(item.question)}</div><div class="qa-a"><span class="qa-who">${esc(item.answered_by || 'Answer')}</span>${esc(item.answer)}</div>${c}</li>`;
      default:
        return `<li class="ins-item"><span>${esc(item.text)}</span>${c}</li>`;
    }
  }
  // ---------- Notes tab ----------
  // Everything extracted and organized from the recording: topic notes plus the structured sections that used
  // to be the Insights tab (actions, decisions, dates, quotes, definitions, exam information…). Only sections
  // with content are shown, and each piece of information appears once.
  function notesParts() {
    const t = type();
    const get = (kind) => st.insights.get(key(kind, t));
    const ready = (kind) => { const i = get(kind); return i?.status === 'ready' && i.content ? i : null; };
    const parts = NOTES_PARTS(t);
    const ins = ready('insights');
    // topic notes saved earlier for a voice message still show if nothing else exists
    const nt = parts.includes('notes') || !ins ? ready('notes') : null;
    return { t, parts, get, ready, ins, nt, both: !!(ins && nt) };
  }
  function topicNotes(nt, t, both) {
    const hide = new Set(both ? HIDE_NOTE_TYPES[t] || [] : []);
    return nt.content.sections.map((sec) => ({ ...sec, items: sec.items.filter((it) => !hide.has(it.type)) })).filter((sec) => sec.items.length);
  }
  function structuredSections(ins, t, both) {
    const hide = new Set(both ? HIDE_SECTIONS[t] || [] : []);
    return (SECTION_ORDER[t] || []).filter((sec) => !hide.has(sec) && (ins.content[sec] || []).length);
  }
  function renderNotes() {
    const p = panels.notes;
    if (gate(p)) return;
    const byId = segById();
    const { t, parts, get, ready, ins, nt, both } = notesParts();
    const busyOf = (kind) => st.busy.has(key(kind, t)) || get(kind)?.status === 'generating';
    const errOf = (kind) => st.errors.get(key(kind, t)) || (get(kind)?.status === 'failed' ? { message: get(kind).error } : null);
    const busy = parts.some(busyOf);
    const errKinds = parts.filter((k) => !busyOf(k) && errOf(k));
    const missing = parts.filter((k) => !ready(k) && !busyOf(k));
    const stale = [ins && 'insights', nt && 'notes'].filter((k) => k && st.contentVersion != null && ready(k).sourceVersion < st.contentVersion);
    let html = '<div class="panel ins-card notes-card">';
    if (busy) html += loading('Organizing your notes');
    if (errKinds.length) html += errorBox(errOf(errKinds[0]), 'notes-retry', "Part of your notes couldn't be created.");
    if (!ins && !nt) {
      if (!busy && !errKinds.length) {
        html += `<div class="ins-intro-row"><p>${esc(NOTES_INTRO[t])} Only what was said in this recording, nothing added.</p><button class="btn btn-primary" type="button" data-act="notes-make">Organize notes</button></div>${privacyLine}`;
      }
    } else {
      if (stale.length && !busy) html += `<div class="ins-msg warn">${ICON.refresh}<span>The transcript changed after these notes were made (for example, a speaker was renamed), so they may be out of date.</span><button class="btn btn-ghost btn-sm" type="button" data-act="notes-update">Update</button></div>`;
      html += `<div class="ins-label">Notes <span>· ${esc(RECORDING_TYPE_LABEL[t])}${isAuto() ? ' (auto)' : ''}</span></div>`;
      const topicsHtml = () => {
        const secs = nt ? topicNotes(nt, t, both) : [];
        if (!secs.length) return '';
        return `<section class="notes-group"><div class="notes-group-h">${esc(TOPICS_LABEL[t])}</div>${secs.map((sec) => {
          const s0 = byId.get(sec.start_ref);
          const time = s0 ? `<button class="cite" type="button" data-seek="${s0.start}" data-ref="${s0.id}" title="Go to ${fmtClock(s0.start)}">${fmtClock(s0.start)}</button>` : '';
          return `<section class="note-sec"><h4 class="note-h"><span>${esc(sec.heading)}</span>${time}</h4><ul class="note-list">${sec.items.map((it) => {
            const label = NOTE_TYPE_LABEL[it.type];
            const timed = it.key || NOTE_ALWAYS_TIMED.has(it.type);
            return `<li class="note-item${it.key ? ' key' : ''}">${label ? `<span class="note-tag">${esc(label)}</span>` : ''}<span>${esc(it.text)}</span>${timed ? chips(it.refs, byId) : ''}</li>`;
          }).join('')}</ul></section>`;
        }).join('')}</section>`;
      };
      const structuredHtml = () => (ins ? structuredSections(ins, t, both).map((sec) => {
        const items = ins.content[sec];
        return `<section class="ins-sec acc-${SECTION_ACCENT[sec] || 'plain'}"><div class="ins-label">${esc(SECTION_LABEL[sec])} <span>${items.length}</span></div>${SECTION_NOTE[sec] ? `<p class="ins-sub">${SECTION_NOTE[sec]}</p>` : ''}<ul class="ins-list">${items.map((it) => renderItem(sec, it, byId)).join('')}</ul></section>`;
      }).join('') : '');
      const body = STRUCTURED_FIRST.has(t) ? structuredHtml() + topicsHtml() : topicsHtml() + structuredHtml();
      html += body || '<p class="ins-none">Nothing to organize in this recording.</p>';
      if (missing.length && !busy && !errKinds.length) {
        html += `<div class="ins-row notes-more"><p class="ins-sub">${missing.includes('insights') ? 'Actions, decisions, dates and other key details haven’t been organized yet.' : 'Notes by topic haven’t been created yet.'}</p><button class="btn btn-ghost btn-sm" type="button" data-act="notes-make">Complete notes</button></div>`;
      }
    }
    html += '</div>';
    p.innerHTML = html;
    p.querySelector('[data-act="notes-make"]')?.addEventListener('click', () => missing.forEach((k) => generate(k)));
    p.querySelector('[data-act="notes-retry"]')?.addEventListener('click', () => errKinds.forEach((k) => generate(k, { force: true })));
    p.querySelector('[data-act="notes-update"]')?.addEventListener('click', () => stale.forEach((k) => generate(k, { force: true })));
  }

  // ---------- Ask tab ----------
  function answerHtml(q, byId) {
    // older answers may be the generic "not found" sentence; newer ones say what wasn't mentioned
    if (isNotFound(q.answer) || !q.answer) return `<div class="ask-a nf"><p>${esc(q.answer || "I couldn't find that in this recording.")}</p></div>`;
    if (!q.found) return `<div class="ask-a">${rich(q.answer, byId)}</div>`;
    const unsupported = !(q.refs || []).length;
    return `<div class="ask-a">${rich(q.answer, byId)}${unsupported ? '<p class="ask-warn">No supporting passage was cited. Check the transcript before relying on this.</p>' : ''}${q.sourceVersion != null && st.contentVersion != null && q.sourceVersion < st.contentVersion ? '<p class="ask-warn">Answered before the transcript was last changed.</p>' : ''}</div>`;
  }
  function renderAsk() {
    const p = panels.ask;
    if (gate(p)) return;
    const byId = segById();
    const t = type();
    const starters = [...STARTERS[t]];
    // only once the user is somewhere in the recording, and saying where, so it's clear which part is meant
    const pos = ctx.playbackTime();
    if (pos > 0) starters.push(`Explain the part at ${fmtClock(pos)} more simply`);
    const pending = st.ask;
    const thread = st.questions.map((q) => `<div class="ask-turn"><div class="ask-q">${esc(q.question)}</div>${answerHtml(q, byId)}</div>`).join('');
    const live = pending ? `<div class="ask-turn"><div class="ask-q">${esc(pending.question)}</div>${
      pending.error ? `<div class="ask-a">${errorBox(pending.error, 'ask-retry', "The answer couldn't be generated.")}</div>`
      : pending.text ? `<div class="ask-a streaming">${rich(pending.text, byId)}</div>`
      : `<div class="ask-a thinking" role="status"><span class="ask-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${pending.status === 'searching' ? 'Finding the moments that answer this…' : 'Writing the answer…'}</span></div>`}</div>` : '';
    const empty = !(thread || live);
    p.innerHTML = `<div class="panel ins-card ask-card${empty ? ' is-empty' : ''}">
      <div class="ask-thread" aria-live="polite">${empty ? `<div class="ask-empty"><span class="ask-empty-ic" aria-hidden="true">${ICON.spark}</span><h3>Ask anything about this recording</h3><p>Answers come from what was said, with the moments they rely on.</p></div>` : thread + live}</div>
      ${empty ? '<p class="ask-try">Try one of these</p>' : ''}
      <div class="ask-starters${empty ? ' big' : ''}">${starters.map((s) => `<button type="button" class="starter" data-q="${esc(s)}"${pending && !pending.error ? ' disabled' : ''}><span>${esc(s)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m0 0-5-5m5 5-5 5"/></svg></button>`).join('')}</div>
      <form class="ask-form" autocomplete="off">
        <textarea class="ask-input" rows="1" maxlength="500" placeholder="Ask anything about this recording" aria-label="Your question" enterkeyhint="send"${pending && !pending.error ? ' disabled' : ''}></textarea>
        <button class="ask-send" type="submit" aria-label="Ask"${pending && !pending.error ? ' disabled' : ''}>${ICON.send}</button>
      </form>
      ${privacyLine}
    </div>`;
    const form = p.querySelector('.ask-form');
    const input = p.querySelector('.ask-input');
    if (st.askDraft) input.value = st.askDraft;
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
    grow();
    input.addEventListener('input', () => { st.askDraft = input.value; grow(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
    p.querySelectorAll('.starter').forEach((b) => b.addEventListener('click', () => ask(b.dataset.q)));
    p.querySelector('[data-act="ask-retry"]')?.addEventListener('click', () => ask(pending.question));
    const th = p.querySelector('.ask-thread');
    th.scrollTop = th.scrollHeight;
  }

  async function ask(question) {
    question = String(question || '').trim();
    if (!question || (st.ask && !st.ask.error)) return;
    giveConsent();
    st.askDraft = '';
    st.ask = { question, text: '', status: null, error: null };
    render();
    mascotSignal('ask-start');
    try {
      const at = refersToPlayback(question) ? ctx.playbackTime() : null;
      const r = await askQuestion(ctx.getId(), question, at, {
        onStatus: (s) => { st.ask.status = s; if (!st.ask.text) render(); },
        onDelta: (t) => { st.ask.text += t; scheduleRender(); },
      });
      st.questions.push({ id: r.id, question, answer: r.answer, refs: r.refs, found: r.found, sourceVersion: st.contentVersion });
      st.ask = null;
      mascotSignal('ask-done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_configured') st.notConfigured = true;
      st.ask.error = err;
      mascotSignal('ask-error');
    }
    render();
  }
  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (st.tab === 'ask') renderAsk(); }); };

  // ---------- Create tab ----------
  const timeOf = (refs) => { const s = segById().get((refs || [])[0]); return s ? s.start : null; };
  const tools = createToolsUI({
    type,
    contentVersion: () => st.contentVersion,
    artifact: (kind, k = '') => st.artifacts.get(akey(kind, k)),
    artifactsOf: (kind) => [...st.artifacts.values()].filter((a) => a.kind === kind),
    busy: (kind, k = '') => st.busy.has(`tool:${akey(kind, k)}`),
    error: (kind, k = '') => st.errors.get(`tool:${akey(kind, k)}`),
    generate: generateTool,
    remove: removeArtifact,
    saveProgress,
    chips, segById, loading, errorBox, timeOf, privacyLine,
    canPlay: () => ctx.playbackTime?.() != null,
    gradeShort: (a, index, answer) => gradeAnswer(ctx.getId(), a.id, index, answer),
    duration: () => ctx.duration?.() || 0,
    makeDialog,
    showTab,
    openExport: (pre) => openExport(pre),
    panel: () => panels.create,
    refresh: () => render(),
    confirm: (title, text, okLabel, danger) => (ctx.confirm ? ctx.confirm(title, text, okLabel, danger) : Promise.resolve(window.confirm(`${title}\n\n${text}`))),
    copy: async (text, label) => {
      try { await navigator.clipboard.writeText(text); ctx.toast?.(`Copied ${label}`); } catch { ctx.toast?.('Copy failed — try Export instead'); }
    },
  });
  function renderCreate() {
    const p = panels.create;
    if (gate(p)) return;
    tools.render(p);
  }

  // ---------- Export (no AI; built in the browser from what this page already loaded) ----------
  function openExport(preselect) {
    const segs = ctx.getSegments();
    const t = type();
    const ready = (i) => i?.status === 'ready' && i.content ? i : null;
    const outdated = (x) => (st.contentVersion != null && x.sourceVersion < st.contentVersion ? '(out of date)' : '');
    const transcriptBlocks = (clean) => {
      const out = [];
      for (const s of segs) {
        const last = out[out.length - 1];
        const text = clean ? cleanText(s.text) : s.text;
        if (last && last.speaker === s.speaker) last.text += ' ' + text;
        else out.push({ speaker: s.speaker, start: s.start, text });
      }
      return out.flatMap((g) => [{ t: 'h', text: `[${fmtClock(g.start)}] ${g.speaker}` }, { t: 'p', text: g.text }]);
    };
    const ov = ready(st.insights.get(key('overview')));
    const ds = ready(st.insights.get(key('detailed_summary', t)));
    const parts = notesParts();
    const { nt, ins, both } = parts;
    const signedIn = !!ctx.getId() && ctx.isSignedIn();
    const sources = [
      { id: 'transcript', group: 'Transcript', label: 'Original transcript', ready: segs.length > 0, blocks: () => transcriptBlocks(false) },
      { id: 'transcript_clean', group: 'Transcript', label: 'Clean transcript', ready: segs.length > 0, note: 'hesitations removed', blocks: () => transcriptBlocks(true) },
      { id: 'summary', group: 'From this recording', label: 'Summary', ready: !!(ov || ds), note: ov ? outdated(ov) : '', blocks: () => [
        ...(ov ? [{ t: 'p', text: ov.content.short_summary }, ...(ov.content.key_points?.length ? [{ t: 'h', text: 'Key points' }, ...ov.content.key_points.map((k) => ({ t: 'li', text: k.text, time: timeOf(k.refs) }))] : []),
          ...(ov.content.chapters?.length ? [{ t: 'h', text: 'Chapters' }, ...ov.content.chapters.map((c) => ({ t: 'li', text: `${c.title} — ${c.summary}`, time: timeOf([c.start_ref]) }))] : [])] : []),
        ...(ds ? ds.content.sections.flatMap((s) => [{ t: 'h', text: s.heading }, ...s.points.map((pt) => ({ t: 'li', text: pt.text, time: timeOf(pt.refs) }))]) : []),
      ] },
      { id: 'notes', group: 'From this recording', label: 'Notes', ready: !!(nt || ins), note: [nt, ins].filter(Boolean).map(outdated).find(Boolean) || '', blocks: () => {
        const topics = nt ? topicNotes(nt, t, both).flatMap((s) => [{ t: 'h', text: s.heading, time: timeOf([s.start_ref]) }, ...s.items.map((it) => ({ t: 'li', text: it.text, time: it.key ? timeOf(it.refs) : null }))]) : [];
        const structured = ins ? insightBlocks(ins.content, t, both) : [];
        return STRUCTURED_FIRST.has(t) ? [...structured, ...topics] : [...topics, ...structured];
      } },
    ];
    for (const kind of toolsFor(t).tools) {
      const found = [...st.artifacts.values()].filter((a) => a.kind === kind && a.content);
      if (!found.length && signedIn) sources.push({ id: `tool:${kind}:`, group: 'Created', label: TOOL_INFO[kind].label, ready: false });
      for (const a of found) {
        const extra = describeSettings(kind, a.settings);
        sources.push({ id: `tool:${kind}:${a.settingsKey}`, group: 'Created', label: TOOL_INFO[kind].label + (extra ? ` (${extra})` : ''), ready: true, note: outdated(a), blocks: () => artifactBlocks(kind, a.content, timeOf) });
      }
    }
    // outputs of other recording types that were created earlier stay exportable
    for (const a of st.artifacts.values()) {
      if (!a.content || toolsFor(t).tools.includes(a.kind)) continue;
      sources.push({ id: `tool:${a.kind}:${a.settingsKey}`, group: 'Created', label: TOOL_INFO[a.kind].label, ready: true, note: outdated(a), blocks: () => artifactBlocks(a.kind, a.content, timeOf) });
    }
    // signed out / not saved yet: only the transcript can be exported (nothing else exists)
    if (!signedIn) sources.splice(2);
    // results written with an earlier speaker name ("Speaker 1") export with the current one ("Hadi")
    const names = ctx.nameMap?.() || new Map();
    if (names.size) for (const s of sources) if (s.blocks && !s.id.startsWith('transcript')) { const b = s.blocks; s.blocks = () => b().map((x) => ({ ...x, text: renameInText(x.text, names) })); }
    const title = ctx.title?.() || 'SparkScribe transcript';
    const meta = [ctx.createdAt?.() ? `Recorded ${new Date(ctx.createdAt()).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}` : null, 'Exported from SparkScribe'].filter(Boolean);
    openExportDialog({ title, meta, sources, segments: segs, coarse: !!ctx.coarse, preselect, onDone: (m) => ctx.toast?.(m) });
  }
  function insightBlocks(c, t, both) {
    const out = [];
    for (const sec of structuredSections({ content: c }, t, both)) {
      const items = c[sec];
      out.push({ t: 'h', text: SECTION_LABEL[sec] });
      for (const it of items) {
        let text = it.text;
        if (it.task) text = `${it.task} — Owner: ${it.owner || 'Not specified'} · Deadline: ${it.deadline || 'Not specified'}`;
        else if (it.when) text = `${it.when}: ${it.what}`;
        else if (it.quote) text = `“${it.quote}” — ${it.speaker}`;
        else if (it.term) text = `${it.term}: ${it.explanation || it.definition}`;
        else if (it.question) text = `Q: ${it.question} — A: ${it.answer}`;
        out.push({ t: 'li', text, time: timeOf(it.refs) });
      }
    }
    return out;
  }

  // ---------- shared ----------
  function render() {
    if (st.tab === 'summary') renderSummary();
    else if (st.tab === 'notes') renderNotes();
    else if (st.tab === 'ask') renderAsk();
    else if (st.tab === 'create') renderCreate();
  }

  renderTypeControl();

  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seek]');
    if (!b) return;
    ctx.seek(Number(b.dataset.seek), Number(b.dataset.ref));
  });

  return {
    showTab,
    // a transcript was saved / opened: load what exists for it
    setTranscription() { renderTypeControl(); st.loaded = false; st.autoDone = false; st.insights.clear(); st.artifacts.clear(); st.questions = []; st.ask = null; tools.reset(); ensureLoaded(); render(); },
    // the transcript text or speakers changed and were saved: fetch the new version → stale banners
    async transcriptChanged() { if (st.loaded) { st.loaded = false; await ensureLoaded(true); } },
    refresh: render,
    reset() { st.loaded = false; st.autoDone = false; st.insights.clear(); st.artifacts.clear(); st.questions = []; st.ask = null; st.errors.clear(); tools.reset(); showTab('transcript'); },
    // the page's own Export button: works signed out too (transcript only); adds saved results once loaded
    openExport: (pre) => { ensureLoaded(); return openExport(pre); },
    // the page re-rendered its header: draw the type control again
    refreshType: renderTypeControl,
  };
}
