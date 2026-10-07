// Result-page intelligence: the TRANSCRIPT / SUMMARY / ASK / INSIGHTS tabs.
// Used by the live result page (src/main.js) and the saved transcript page (src/pages/transcript.js).
// The transcript stays the source of truth: everything here is generated from it on request, stored with
// it, and every reference points back to a real line and timestamp.
import { fetchState, requestInsight, askQuestion, ApiError } from './api.js';
import { fmtClock, splitCitations, RECORDING_TYPES, RECORDING_TYPE_LABEL, normalizeRecordingType, isNotFound } from '../lib/segments.js';

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

const INSIGHT_LOADING = {
  general: 'Finding action items, decisions and dates',
  meeting: 'Analyzing decisions and action items',
  lecture: 'Building study notes',
  interview: 'Finding questions, answers and quotes',
  podcast: 'Finding topics and takeaways',
  voice_message: 'Finding what this message needs from you',
};

const SECTION_ORDER = {
  general: ['action_items', 'decisions', 'suggestions', 'important_dates'],
  meeting: ['decisions', 'action_items', 'important_dates', 'open_questions', 'follow_ups', 'suggestions'],
  lecture: ['notes', 'key_concepts', 'definitions', 'important_topics', 'exam_points'],
  interview: ['questions', 'major_topics', 'notable_quotes', 'key_takeaways'],
  podcast: ['main_topics', 'key_takeaways', 'notable_quotes'],
  voice_message: ['requested_actions', 'important_information', 'dates_times'],
};
const SECTION_LABEL = {
  action_items: 'Action items', decisions: 'Decisions', suggestions: 'Discussed, not decided', important_dates: 'Important dates',
  open_questions: 'Open questions', follow_ups: 'Follow-ups', notes: 'Structured notes', key_concepts: 'Key concepts',
  definitions: 'Definitions', important_topics: 'Important topics', exam_points: 'Possible exam points',
  questions: 'Questions & answers', major_topics: 'Major topics', notable_quotes: 'Notable quotes', key_takeaways: 'Key takeaways',
  main_topics: 'Main topics', important_information: 'Important information', requested_actions: 'Requested actions', dates_times: 'Dates & times',
};
const SECTION_NOTE = {
  suggestions: 'Proposed in the conversation, but no decision was stated.',
  exam_points: 'Only where the lecturer signalled importance (exams, "remember this", emphasis).',
};

const STARTERS = {
  general: ['Summarize the main discussion', 'What decisions were made?', 'What action items were assigned?', 'What deadlines were mentioned?'],
  meeting: ['What decisions were made?', 'What action items were assigned?', 'What deadlines were mentioned?', 'What questions are still open?'],
  lecture: ['What should I study?', 'What were the main concepts?', 'Did the lecturer mention the exam?'],
  interview: ['What were the main questions asked?', 'What are the key takeaways?', 'Summarize the answers'],
  podcast: ['What are the main topics?', 'What are the key takeaways?'],
  voice_message: ['What does this person need from me?', 'Are there dates or times I need to remember?', 'Summarize this in one sentence'],
};

/**
 * @param {object} o
 * @param {HTMLElement} o.tabBar           container for the tab buttons
 * @param {HTMLElement[]} o.transcriptEls  existing elements that make up the Transcript tab
 * @param {HTMLElement} o.host             where the Summary / Ask / Insights panels are inserted
 * @param {object} o.ctx                   page hooks (see below)
 *   getId() → saved transcription id or null; isSignedIn() → bool; signIn() → void (optional)
 *   getSegments() → [{id,start,end,speaker,text}]; seek(seconds) → void; playbackTime() → seconds|null
 *   getRecordingType() → type|null; setRecordingType(type) → Promise; duration() → seconds; savedNote() → html|null
 */
export function mountInsights({ tabBar, transcriptEls, host, ctx }) {
  const st = {
    tab: 'transcript', loaded: false, loadingState: false, contentVersion: null, insights: new Map(), questions: [],
    busy: new Map(), errors: new Map(), stateError: null, notConfigured: false, ask: null, autoDone: false,
  };
  const key = (kind, type) => `${kind}:${kind === 'overview' ? 'general' : type}`;
  const type = () => normalizeRecordingType(ctx.getRecordingType());

  // ---------- tabs ----------
  const TABS = [['transcript', 'Transcript'], ['summary', 'Summary'], ['ask', 'Ask'], ['insights', 'Insights']];
  tabBar.className = 'tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.innerHTML = TABS.map(([k, label]) => `<button class="tab${k === 'transcript' ? ' on' : ''}" type="button" role="tab" data-tab="${k}" aria-selected="${k === 'transcript'}">${label}</button>`).join('');
  const panels = {};
  for (const k of ['summary', 'ask', 'insights']) {
    const p = document.createElement('section');
    p.className = 'tab-panel hidden';
    p.dataset.panel = k;
    p.setAttribute('role', 'tabpanel');
    host.appendChild(p);
    panels[k] = p;
  }
  tabBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  function showTab(name) {
    st.tab = name;
    tabBar.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
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
      st.loaded = true;
      for (const i of s.insights) if (i.status === 'generating') poll(i.kind, i.recordingType);
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
    if (ctx.getRecordingType() && !st.insights.get(key('insights', type()))) generate('insights');
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
    try {
      const r = await requestInsight(id, kind, t, force);
      st.insights.set(k, r.insight);
      if (r.insight.status === 'generating') poll(kind, t);
    } catch (err) {
      if (err.code === 'not_configured') st.notConfigured = true;
      st.errors.set(k, err);
    }
    st.busy.delete(k);
    render();
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
        : `<div class="ins-msg">${ICON.lock}<span>Summary, Ask and Insights work on transcripts saved in My Library. This one isn't saved yet — use Retry in the bar above.</span></div>`}</div>`;
      return true;
    }
    if (!ctx.getId() || !ctx.isSignedIn()) {
      const can = typeof ctx.signIn === 'function';
      panel.innerHTML = `<div class="panel ins-card ins-gate">
        <div class="ins-gate-icon">${ICON.spark}</div>
        <h3>Summaries, answers and insights</h3>
        <p>Get a summary, key points, chapters, action items and answers about this recording. These are saved with the transcript, so ${can ? 'they need' : 'it needs'} your free account.</p>
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
    } else {
      html += `<div class="panel ins-card">`;
      if (ovBusy) html += loading(long ? 'Generating summary, key points and chapters' : 'Generating summary and key points');
      else if (ovErr) html += errorBox(ovErr, 'overview-retry');
      if (ov?.status === 'ready' && ov.content) {
        const c = ov.content;
        html += staleBox(ov, 'overview-retry');
        html += `<div class="ins-label">${type() === 'voice_message' ? 'TL;DR' : 'Summary'}</div><div class="ins-summary"><p>${esc(c.short_summary)}</p></div>`;
        if (c.key_points?.length) {
          html += `<div class="ins-label">Key points</div><ul class="ins-points">${c.key_points.map((k) => `<li><span>${esc(k.text)}</span>${chips(k.refs, byId)}</li>`).join('')}</ul>`;
        }
        if (c.chapters?.length) {
          html += `<div class="ins-label">Chapters</div><ol class="chapters">${c.chapters.map((ch) => {
            const s = byId.get(ch.start_ref);
            if (!s) return '';
            return `<li><button type="button" class="chapter" data-seek="${s.start}" data-ref="${s.id}"><span class="ch-time">${fmtClock(s.start)}</span><span class="ch-body"><span class="ch-title">${esc(ch.title)}</span>${ch.summary ? `<span class="ch-sum">${esc(ch.summary)}</span>` : ''}</span></button></li>`;
          }).join('')}</ol>`;
        }
      }
      html += `</div>`;
    }

    // detailed summary (on demand)
    const t = type();
    const dk = key('detailed_summary', t);
    const ds = st.insights.get(dk);
    const dsBusy = st.busy.has(dk) || ds?.status === 'generating';
    const dsErr = st.errors.get(dk) || (ds?.status === 'failed' ? { message: ds.error } : null);
    if (ov?.status === 'ready' || ds) {
      html += `<div class="panel ins-card">`;
      if (dsBusy) html += loading('Writing detailed summary');
      else if (dsErr) html += errorBox(dsErr, 'detailed-retry');
      if (ds?.status === 'ready' && ds.content) {
        html += staleBox(ds, 'detailed-retry');
        html += `<div class="ins-label">Detailed summary${t !== 'general' ? ` <span>· ${esc(RECORDING_TYPE_LABEL[t])}</span>` : ''}</div>`;
        html += ds.content.sections.map((s) => `<h4 class="ins-h">${esc(s.heading)}</h4><ul class="ins-points">${s.points.map((pt) => `<li><span>${esc(pt.text)}</span>${chips(pt.refs, byId)}</li>`).join('')}</ul>`).join('');
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
  }

  // ---------- Insights tab ----------
  function typePicker() {
    const cur = ctx.getRecordingType();
    return `<div class="type-pick"><span class="ins-label">Recording type</span><div class="type-chips" role="radiogroup" aria-label="Recording type">${RECORDING_TYPES.map((t) =>
      `<button type="button" class="type-chip${(cur || 'general') === t ? ' on' : ''}" role="radio" aria-checked="${(cur || 'general') === t}" data-type="${t}">${RECORDING_TYPE_LABEL[t]}</button>`).join('')}</div></div>`;
  }
  function renderItem(sec, item, byId) {
    const c = chips(item.refs, byId);
    switch (sec) {
      case 'action_items': case 'requested_actions':
        return `<li class="ins-item action"><div class="act-task">${esc(item.task)}</div><dl class="act-meta"><div><dt>Assigned to</dt><dd class="${item.owner ? '' : 'ns'}">${esc(item.owner || 'Not specified')}</dd></div><div><dt>Deadline</dt><dd class="${item.deadline ? '' : 'ns'}">${esc(item.deadline || 'Not specified')}</dd></div></dl>${c}</li>`;
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
      case 'notes':
        return `<li class="ins-item note"><h4 class="ins-h">${esc(item.heading)}</h4><ul class="ins-points">${(item.points || []).map((pt) => `<li><span>${esc(pt.text)}</span>${chips(pt.refs, byId)}</li>`).join('')}</ul></li>`;
      default:
        return `<li class="ins-item"><span>${esc(item.text)}</span>${c}</li>`;
    }
  }
  function renderInsights() {
    const p = panels.insights;
    if (gate(p)) return;
    const byId = segById();
    const t = type();
    const k = key('insights', t);
    const ins = st.insights.get(k);
    const busy = st.busy.has(k) || ins?.status === 'generating';
    const err = st.errors.get(k) || (ins?.status === 'failed' ? { message: ins.error } : null);
    let html = `<div class="panel ins-card">${typePicker()}</div>`;
    html += `<div class="panel ins-card">`;
    if (busy) html += loading(INSIGHT_LOADING[t]);
    else if (err) html += errorBox(err, 'insights-retry');
    if (ins?.status === 'ready' && ins.content) {
      html += staleBox(ins, 'insights-retry');
      html += SECTION_ORDER[t].map((sec) => {
        const items = ins.content[sec] || [];
        const label = t === 'meeting' && sec === 'important_dates' ? 'Deadlines & dates' : SECTION_LABEL[sec];
        return `<section class="ins-sec"><div class="ins-label">${esc(label)}${items.length ? ` <span>${items.length}</span>` : ''}</div>${SECTION_NOTE[sec] && items.length ? `<p class="ins-sub">${SECTION_NOTE[sec]}</p>` : ''}${items.length
          ? `<ul class="ins-list${sec === 'notes' ? ' notes' : ''}">${items.map((it) => renderItem(sec, it, byId)).join('')}</ul>`
          : '<p class="ins-none">None mentioned in this recording.</p>'}</section>`;
      }).join('');
    } else if (!busy && !err) {
      html += `<div class="ins-intro-row"><p>${esc(INSIGHT_LOADING[t].replace(/^Finding /, 'Find ').replace(/^Analyzing /, 'Analyze ').replace(/^Building /, 'Build '))} for this ${esc(RECORDING_TYPE_LABEL[t].toLowerCase())}. Only what was actually said is included, each with the moment it was said.</p><button class="btn btn-primary" type="button" data-act="insights">Analyze</button></div>${privacyLine}`;
    }
    html += `</div>`;
    p.innerHTML = html;
    p.querySelector('[data-act="insights"]')?.addEventListener('click', () => generate('insights'));
    p.querySelector('[data-act="insights-retry"]')?.addEventListener('click', () => generate('insights', { force: true }));
    p.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', async () => {
      const nt = b.dataset.type;
      if (nt === ctx.getRecordingType()) return;
      try { await ctx.setRecordingType(nt); } catch {}
      render();
      // choosing a type is an explicit request: analyse it right away unless it's already stored
      if (!st.insights.get(key('insights', nt)) && hasConsent()) generate('insights');
    }));
  }

  // ---------- Ask tab ----------
  function answerHtml(q, byId) {
    if (!q.found || isNotFound(q.answer)) return `<div class="ask-a nf"><p>${esc(q.answer || "I couldn't find that in this recording.")}</p></div>`;
    const unsupported = !(q.refs || []).length;
    return `<div class="ask-a">${rich(q.answer, byId)}${unsupported ? '<p class="ask-warn">No supporting passage was cited. Check the transcript before relying on this.</p>' : ''}${q.sourceVersion != null && st.contentVersion != null && q.sourceVersion < st.contentVersion ? '<p class="ask-warn">Answered before the transcript was last changed.</p>' : ''}</div>`;
  }
  function renderAsk() {
    const p = panels.ask;
    if (gate(p)) return;
    const byId = segById();
    const t = type();
    const starters = [...STARTERS[t]];
    if (ctx.playbackTime() != null) starters.push('Explain this part more simply');
    const pending = st.ask;
    const thread = st.questions.map((q) => `<div class="ask-turn"><div class="ask-q">${esc(q.question)}</div>${answerHtml(q, byId)}</div>`).join('');
    const live = pending ? `<div class="ask-turn"><div class="ask-q">${esc(pending.question)}</div>${
      pending.error ? `<div class="ask-a">${errorBox(pending.error, 'ask-retry', "The answer couldn't be generated.")}</div>`
      : pending.text ? `<div class="ask-a streaming">${rich(pending.text, byId)}</div>`
      : `<div class="ask-a">${loading(pending.status === 'searching' ? 'Finding the relevant parts of the recording' : 'Writing the answer')}</div>`}</div>` : '';
    p.innerHTML = `<div class="panel ins-card ask-card">
      <div class="ask-thread" aria-live="polite">${thread || live ? thread + live : `<div class="ask-empty"><h3>Ask about this recording</h3><p>Answers come only from what was said, with the moments they're based on.</p></div>`}</div>
      <div class="ask-starters">${starters.map((s) => `<button type="button" class="starter" data-q="${esc(s)}"${pending && !pending.error ? ' disabled' : ''}>${esc(s)}</button>`).join('')}</div>
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
    try {
      const at = /\b(this|here|now|just)\b/i.test(question) ? ctx.playbackTime() : null;
      const r = await askQuestion(ctx.getId(), question, at, {
        onStatus: (s) => { st.ask.status = s; if (!st.ask.text) render(); },
        onDelta: (t) => { st.ask.text += t; scheduleRender(); },
      });
      st.questions.push({ id: r.id, question, answer: r.answer, refs: r.refs, found: r.found, sourceVersion: st.contentVersion });
      st.ask = null;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_configured') st.notConfigured = true;
      st.ask.error = err;
    }
    render();
  }
  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (st.tab === 'ask') renderAsk(); }); };

  // ---------- shared ----------
  function render() {
    if (st.tab === 'summary') renderSummary();
    else if (st.tab === 'insights') renderInsights();
    else if (st.tab === 'ask') renderAsk();
  }

  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-seek]');
    if (!b) return;
    ctx.seek(Number(b.dataset.seek), Number(b.dataset.ref));
  });

  return {
    showTab,
    // a transcript was saved / opened: load what exists for it
    setTranscription() { st.loaded = false; st.autoDone = false; st.insights.clear(); st.questions = []; st.ask = null; ensureLoaded(); render(); },
    // the transcript text or speakers changed and were saved: fetch the new version → stale banners
    async transcriptChanged() { if (st.loaded) { st.loaded = false; await ensureLoaded(true); } },
    refresh: render,
    reset() { st.loaded = false; st.autoDone = false; st.insights.clear(); st.questions = []; st.ask = null; st.errors.clear(); showTab('transcript'); },
  };
}
