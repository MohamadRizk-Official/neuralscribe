// The SparkScribe mascot: a small 3D audio companion that lives along the bottom edge of the page.
//
// Character: one canonical rigged 3D model (src/mascot/model.js, rendered by stage.js with Three.js, which
// is loaded only after the page is ready). Animation: src/mascot/motion.js (cycles, clips, blending).
// This file is its mind: a state machine, a small task runner for multi-step behaviors, floor locomotion
// with real turning, throw physics, climbing, getting up, autonomy and the app's signals.
//
//   • the speaker is its eye: it looks at the cursor, the dragged file, the progress panel, ...; the body
//     stays put unless the mascot decides to move. To move it looks first, turns to face the way it goes,
//     then walks or runs (the feet are driven by the distance travelled, so they never skate)
//   • on its own (every 8–20 s, often nothing): look around, tap a foot, stretch, sit, take a few steps,
//     wander, inspect the upload panel, look at the page, climb a screen edge and hang there, dance
//   • grab and throw it: it tumbles, bounces off the edges, lands upright, tilted or on its side; from its
//     side it gets up by itself (hand down, foot under, push up)
//   • app signals (src/mascot/bus.js): file accepted, working, done, results, error, Ask, Quiz, search
//   • never while you type or read; quiet in dialogs and quizzes; On / Quiet / Off; "reduce motion": still
//   • everything runs locally: no network, no sound
import './mascot.css';
import { Animator, CLIPS, REST, DIM, K, support, climbRise, ss } from './motion.js';
import { MASCOT_KEY, getMascotPref } from '../lib/prefs.js';

const POS_KEY = 'sparkscribe.mascot.pos';
const TRAVEL_KEY = 'sparkscribe.mascot.travel';
const VIEW = 4.6;                         // = stage.js VIEW (body units across the canvas)
const PI = Math.PI;
const G = 2600;                           // gravity, px/s²
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (weighted) => { const w = weighted.filter(([, x]) => x > 0); let r = Math.random() * w.reduce((s, [, x]) => s + x, 0); for (const [v, x] of w) { r -= x; if (r <= 0) return v; } return w[0]?.[0]; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => { a = ((a + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI; return a; };
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.5c.7 6 2.6 8.6 9.5 10.5-6.9 1.9-8.8 4.5-9.5 10.5-.7-6-2.6-8.6-9.5-10.5C9.4 10.1 11.3 7.5 12 1.5Z" fill="currentColor"/></svg>';
const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role="button"],[tabindex],[contenteditable],.dropzone';


const CANCEL = { cancelled: true };
let instance = null;

/** @param {{ page: 'home' | 'library' | 'transcript' | 'other' }} opts */
export function mountMascot({ page = 'other' } = {}) {
  if (instance) return instance;
  const calmQ = matchMedia('(prefers-reduced-motion: reduce)');
  const calm = () => calmQ.matches;
  const touch = matchMedia('(hover: none), (pointer: coarse)').matches || innerWidth < 640;
  const readingPage = page === 'transcript';
  let pref = getMascotPref();

  // ---------- DOM: a floor shadow, the canvas (travels with the mascot), effects, and a round hit area ----------
  const el = document.createElement('div');
  el.className = `mascot${touch ? ' m-touch' : ''}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'SparkScribe mascot');
  el.innerHTML = '<div class="m-shadow"></div><div class="m-stage"><canvas class="m-canvas"></canvas><div class="m-fx"></div></div><div class="m-hit"></div>';
  document.body.appendChild(el);
  const shadowEl = el.querySelector('.m-shadow');
  const stageEl = el.querySelector('.m-stage');
  const canvas = el.querySelector('canvas');
  const fxLayer = el.querySelector('.m-fx');
  const hit = el.querySelector('.m-hit');
  let stage = null;                        // set once Three.js has loaded

  // ---------- size & places ----------
  let H = 110, k = 38, S = 175, sc = 1, dpr = 1;
  const vw = () => document.documentElement.clientWidth || innerWidth;
  const FLOOR = () => innerHeight - (touch ? 6 : 8);
  const standY = () => FLOOR() - DIM.foot * k;
  let away = false;                                         // phones during a quiz: fully below the edge
  const peekY = () => innerHeight + (away ? 2.4 : 0.08) * k; // only the gem, the top of the body and the speaker's rim show
  const minX = () => 1.3 * k + 4;
  const maxX = () => vw() - 1.3 * k - 4;
  const clampX = (v) => clamp(v, minX(), maxX());
  // Home is anchored to the page's content (getBoundingClientRect), not to a viewport fraction: at 67 % zoom
  // or on a wide screen the viewport grows but the content column doesn't, so a viewport-relative spot
  // drifted away from everything. It stands just beside the content when there's room, else at the edge.
  const HOME_ANCHOR = { home: ['.hear-grid', 'main.app'], transcript: ['main.app'], library: ['main.app'] };
  function homeX() {
    const edge = clampX(vw() - (touch ? 1.5 : 2.3) * k - (touch ? 4 : 14));
    if (touch) return edge;
    for (const sel of HOME_ANCHOR[page] || ['main.app']) {
      const el = document.querySelector(sel);
      const r = el?.offsetParent !== null ? el?.getBoundingClientRect() : null;
      if (!r || !r.width) continue;
      return vw() - r.right >= 2.8 * k ? clampX(r.right + 1.45 * k) : edge;
    }
    return edge;
  }
  function size() {
    H = touch ? 72 : Math.round(clamp(innerHeight * 0.15, 100, 132));
    k = H / (DIM.foot + DIM.top);
    sc = k / 38;
    S = Math.ceil(VIEW * k);
    dpr = Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2);
    stageEl.style.width = stageEl.style.height = `${S}px`;
    hit.style.width = hit.style.height = `${(2.25 * k).toFixed(0)}px`;
    shadowEl.style.width = `${(1.9 * k).toFixed(0)}px`; shadowEl.style.height = `${(0.34 * k).toFixed(0)}px`;
    stage?.resize(S, dpr);
  }
  size();

  // ---------- state ----------
  let X = homeX(), Y = standY(), yaw = 0, roll = 0;
  let mode = 'stand';                      // stand | wall | held | air | roll | leap | perch (on the quiz card)
  let mood = 'idle';                       // idle | excited | working | celebrating | sad | thinking
  let peek = false, peekK = 0, moved = false, readingMode = readingPage;
  let speed = 0, lastDir = 1, accel = 0, phase = 0, loco = null, turnStep = 0;
  const gaitPrm = { phase: 0, amt: 0, run: 0 };
  let yawTw = null;
  let vx = 0, vy = 0, w = 0, wy = 0, launch = 0, dizzyNext = false, rollTarget = 0;
  let wallBaseY = 0, climb = null, climbPhase = 0, sliding = 0;
  const climbPrm = { phase: 0 }, hangPrm = { twist: 0 }, heldPrm = { flail: 0 };
  let hangTwistTarget = 0;
  let leap = null, perchSide = 1, perchWanted = false, afterLand = null, perchCheckAt = 0;
  const perchPrm = { side: 1 };
  const anim = new Animator();
  let P = anim.out;
  const F = REST.slice();                  // final pose (animation + secondary motion)
  const spr = { lean: 0, leanV: 0, leanT: 0, gem: 0, gemV: 0, sq: 0, sqV: 0 };
  let ex = 0, ey = 0, look = null, glance = { x: 0, y: 0, next: 0 };
  const cursor = { x: -1, y: -1, t: -1e9 };
  let clock = 0;
  const cool = { near: 0, fast: 0, search: 0, look: 0 };
  let listeningAudio = false;
  const quiet = () => pref === 'quiet';
  const live = () => pref !== 'off' && !document.hidden;
  const sx = () => X + P[K.sx] * k, sy = () => Y - P[K.sy] * k;

  // restore this session's position
  try {
    const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
    if (saved?.moved) { X = clampX(saved.xf * vw()); moved = true; }
  } catch { /* fine */ }
  if (readingPage && !touch) { peek = true; peekK = 1; }

  // expression helpers (no-ops until the model exists)
  const E = {
    base: (s) => stage?.m.expr.setBase(s), flash: (s, ms) => stage?.m.expr.flash(s, ms), gem: (s, ms) => stage?.m.expr.gemFx(s, ms),
    pulse: (n) => stage?.m.expr.pulse(n), surprise: () => stage?.m.expr.surprise(),
  };

  function busy() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    if (document.querySelector('dialog[open]')) return true;
    const q = document.querySelector('.quiz');
    if (q) { const r = q.getBoundingClientRect(); if (r.bottom > 0 && r.top < innerHeight) return true; }
    return false;
  }
  let lastScroll = -1e9, lastKey = -1e9;
  addEventListener('scroll', () => { lastScroll = clock; }, { passive: true, capture: true });
  addEventListener('keydown', () => { lastKey = clock; }, { passive: true });
  const reading = () => clock - lastScroll < 6 || clock - lastKey < 6 || !!String(getSelection?.() || '').trim();

  // ---------- tasks: multi-step behaviors that can be interrupted at any step ----------
  let taskId = 0, taskActive = false;
  let waiters = [];
  const chk = (id) => { if (id !== taskId) throw CANCEL; };
  function wait(sec, id) { chk(id); return new Promise((res, rej) => waiters.push({ at: clock + sec, res, rej })); }
  function until(pred, id) { chk(id); return new Promise((res, rej) => waiters.push({ pred, res, rej })); }
  function tickWaiters() {
    if (!waiters.length) return;
    const ready = waiters.filter((x) => (x.pred ? x.pred() : clock >= x.at));
    if (!ready.length) return;
    waiters = waiters.filter((x) => !ready.includes(x));
    ready.forEach((x) => x.res());
  }
  function cancelTask() {
    taskId++;
    const ws = waiters; waiters = [];
    ws.forEach((x) => x.rej(CANCEL));
    anim.release(0.3);
    loco = null; climb = null; sliding = 0; look = null;
    if (['gait', 'sit', 'hang', 'climb', 'slide'].includes(anim.baseName) && mode === 'stand') anim.setBase(moodBase(), {}, 0.4);
    if (mode === 'wall') { mode = 'air'; vx = 0; vy = 0; w = 0; wy = 0; anim.setBase('air', {}, 0.25); }   // it lets go of the wall
    if (mode === 'perch' || mode === 'leap') anim.setBase('perch', perchPrm, 0.2);
    if (mode === 'intro') abortIntro();   // interrupted mid-entrance: it simply appears
  }
  function run(fn) {
    cancelTask();
    const id = taskId;
    taskActive = true;
    fn(id).catch((e) => { if (e !== CANCEL) { /* the mascot never breaks the app */ } }).finally(() => {
      if (id !== taskId) return;
      taskActive = false;
      if (mood === 'working' && mode === 'stand') run((i) => workLoop(i, false));
    });
  }
  // play a clip and wait for it
  function act(c, id, opts = {}) {
    chk(id);
    if (calm()) return Promise.resolve();
    let done = false;
    anim.play(c, opts).then(() => { done = true; });
    return until(() => done, id);
  }
  function lookAt(x, y, sec = 1.2) { look = { x, y, until: clock + sec }; }

  async function turnTo(to, id, dur) {
    chk(id);
    if (calm()) { yaw = to; return; }
    yaw = Math.abs(to - yaw) > PI * 1.01 ? wrap(yaw) : yaw;
    const d = Math.abs(to - yaw);
    if (d < 0.02) { yaw = to; return; }
    yawTw = { from: yaw, to, t: 0, dur: dur ?? 0.3 + 0.24 * d / (PI / 2), moving: !!loco };
    if (anim.baseName !== 'gait' && !anim.playing) anim.setBase('gait', gaitPrm, 0.2);
    await until(() => !yawTw, id);
  }
  // walk / run along the floor: look first, turn to face the way, go, settle, maybe face front again
  async function go(tx, id, { run: running = false, face = 'front', raw = false, look: lk = true } = {}) {
    chk(id);
    tx = raw ? clamp(tx, 1.02 * k, vw() - 1.02 * k) : clampX(tx);
    if (Math.abs(tx - X) < 6) return;
    if (calm()) { X = tx; return; }
    await rise(id);
    const dir = Math.sign(tx - X);
    anim.setBase('gait', gaitPrm, 0.25);
    if (lk) { lookAt(tx + dir * 240, Y - 0.3 * k, 0.8); await wait(0.24, id); }     // the speaker notices first
    spr.sqV += 0.9;                                                                  // a tiny anticipation dip
    await wait(0.08, id);
    if (Math.abs(wrap(yaw - dir * PI / 2)) > 0.05) await turnTo(dir * PI / 2, id);
    loco = { tx, run: running };
    await until(() => !loco, id);
    if (face === 'front') { await wait(rand(0.3, 1.0), id); await turnTo(0, id); }
    anim.setBase(moodBase(), {}, 0.35);
  }
  async function rise(id) {
    away = false;
    if (peekK < 0.02 && !peek) return;
    peek = false;
    await until(() => peekK < 0.03, id);
    peekK = 0;
  }
  // before reacting to you or to the app: up from the edge, and facing you
  async function ready(id) {
    await rise(id);
    if (mode === 'stand' && Math.abs(wrap(yaw)) > 0.05) { yaw = wrap(yaw); await turnTo(0, id); anim.setBase(moodBase(), {}, 0.25); }
  }
  function moodBase() { return { excited: 'excited', working: 'working', sad: 'sad', thinking: 'think' }[mood] || 'idle'; }
  function setMood(m) {
    mood = m;
    E.base({ excited: 'excited', working: 'processing', sad: 'error', thinking: 'listening' }[m] || (listeningAudio ? 'listening' : 'idle'));
    if (mode === 'stand' && !['gait', 'climb', 'hang', 'slide', 'fallen'].includes(anim.baseName)) anim.setBase(moodBase(), {}, 0.4);
  }

  // ---------- effects (small DOM sparkles / marks around the mascot) ----------
  function fx(type) {
    if (calm() || pref === 'off') return;
    const add = (html, ms) => { const d = document.createElement('div'); d.innerHTML = html; const n = d.firstElementChild; fxLayer.appendChild(n); setTimeout(() => n.remove(), ms); return n; };
    if (type === 'sparkles') {
      const colors = ['#22d3ee', '#a78bfa', '#f472b6', '#60a5fa', '#e0f2fe'];
      for (let i = 0; i < 8; i++) {
        const n = add(`<span class="fx-star" style="color:${colors[i % colors.length]}">${STAR}</span>`, 1200);
        n.style.setProperty('--dx', `${rand(-1.6, 1.6) * k | 0}px`);
        n.style.setProperty('--dy', `${rand(-2.0, -0.6) * k | 0}px`);
        n.style.animationDelay = `${i * 40}ms`;
      }
    } else if (type === 'question') add('<span class="fx-q">?</span>', 1700);
    else if (type === 'dizzy') add(`<span class="fx-dizzy"><i style="color:#22d3ee">${STAR}</i><i style="color:#f472b6">${STAR}</i><i style="color:#a78bfa">${STAR}</i></span>`, 1300);
  }

  // ---------- the frame loop ----------
  let raf = 0, lastTs = 0, running = false, calmTick = 0;
  let devSlow = 1;                         // development only: slow motion for inspecting animations
  function start() {
    if (running || !stage || !live()) return;
    running = true; lastTs = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); raf = 0; }
  function frame(ts) {
    raf = 0;
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000)) * devSlow;
    lastTs = ts;
    clock += dt;
    if (calm()) { calmFrame(dt); return; }
    tickWaiters();
    if (mode === 'held') stepHeld(dt);
    else if (mode === 'air') stepAir(dt);
    else if (mode === 'roll') stepRoll(dt);
    else stepGround(dt);
    stepYaw(dt);
    P = anim.update(dt);
    if (mode === 'stand') Y = lerp(FLOOR() - support(roll + P[K.sr]) * k, peekY(), ss(peekK));
    if (glideTo != null) { if (mode !== 'stand' || loco || grab) glideTo = null; else { X += (glideTo - X) * (1 - Math.exp(-dt * 5)); if (Math.abs(glideTo - X) < 0.5) { X = glideTo; glideTo = null; } } }
    stepSecondary(dt);
    stepEye(dt);
    autonomy();
    if (perchWanted && mode === 'stand' && !taskActive && !grab && clock - perchCheckAt > 0.5) {
      perchCheckAt = clock;
      const A = perchAnchor();
      if (!A) perchWanted = false; else if (A.visible) { perchWanted = false; run(perchOn); }
    }
    // standing still and just breathing: 30 frames a second is plenty (saves battery)
    const still = mode === 'stand' && !loco && speed < 1 && !yawTw && !anim.playing && Math.abs(spr.sqV) + Math.abs(spr.leanV) + Math.abs(spr.gemV) < 0.02;
    drawDt += dt;
    if (still && (frameN++ & 1)) return;
    draw(drawDt);
    drawDt = 0;
  }
  let frameN = 0, drawDt = 0;
  // reduce motion: no movement at all; the speaker and gem still show state with light, drawn ~10× a second
  function calmFrame(dt) {
    calmTick += dt;
    if (calmTick < 0.1) return;
    tickWaiters();
    mode = 'stand'; roll = 0; yaw = 0; loco = null; yawTw = null;
    P = REST; ex = ey = 0;
    Y = peek ? peekY() : standY();
    draw(calmTick);
    calmTick = 0;
  }
  function draw(dt) {
    F.set(P);
    F[K.pitch] += spr.lean; F[K.gemT] += spr.gem; F[K.sq] += spr.sq;
    stage.apply(F, yaw, roll);
    stage.m.expr.setEye(ex, ey);
    stage.render(dt);
    place();
  }
  function place() {
    const cx = sx(), cy = sy();
    stageEl.style.transform = `translate3d(${(cx - S / 2).toFixed(1)}px, ${(cy - S / 2).toFixed(1)}px, 0)`;
    const edge = mode === 'intro' && intro ? intro.edge : null;
    stageEl.style.clipPath = edge != null ? `inset(0 0 ${Math.max(0, cy + S / 2 - edge).toFixed(1)}px 0)` : '';
    const r = 1.125 * k;
    hit.style.transform = `translate3d(${(cx - r).toFixed(1)}px, ${(cy - r).toFixed(1)}px, 0)`;
    const ground = FLOOR() - support(roll + P[K.sr]) * k;
    const alt = mode === 'wall' || mode === 'perch' || mode === 'leap' || mode === 'intro' ? 2 : Math.max(0, ground - cy) / (3 * k);
    const sw = 1.9 * k, sh = 0.34 * k;
    shadowEl.style.transform = `translate3d(${(cx - sw / 2).toFixed(1)}px, ${(FLOOR() - sh * 0.55).toFixed(1)}px, 0) scale(${(1 - Math.min(alt, 0.6)).toFixed(3)})`;
    shadowEl.style.opacity = peekK > 0.5 ? '0' : (1 - Math.min(alt, 0.85)).toFixed(2);
  }

  // ---------- ground: walking / running, climbing ----------
  const WALK = 80, RUN = 290;
  // ---------- the quiz card: it jumps up and hangs from the card's top corner by one arm ----------
  const PERCH_SEL = '.study.quiz .q-card';
  function perchAnchor() {
    const el = document.querySelector(PERCH_SEL);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    const side = vw() - r.right > 2.9 * k ? 1 : -1;      // outside the card when there's room, else just inside
    const gx = r.right - (side > 0 ? 0.1 : 0.25) * k, gy = r.top + 0.06 * k;
    return { side, gx, gy, x: gx + side * 1.35 * k, y: gy + 0.95 * k, visible: gy > 0.7 * k && gy < innerHeight - 2.6 * k };
  }
  function letGo(hop = true) {
    mode = 'air'; leap = null;
    vx = hop ? perchSide * 140 : 0; vy = hop ? -260 : 40; w = 0; wy = 0; roll = 0;
    anim.setBase('air', {}, 0.15);
  }
  function stepPerch(dt) {
    const A = perchAnchor();
    if (mode === 'leap') {
      const T = leap.to ? leap.to() : A;
      if (!T || (!leap.to && !A.visible)) { letGo(false); return; }
      leap.t = Math.min(1, leap.t + dt / leap.dur);
      const u = ss(leap.t);
      X = lerp(leap.fx, T.x, u);
      Y = lerp(leap.fy, T.y, u) - leap.peak * 4 * leap.t * (1 - leap.t);
      if (leap.t >= 1 && leap.done) { const f = leap.done; leap = null; f(); return; }
      if (leap.t >= 1) {
        mode = 'perch'; leap = null;
        perchSide = perchPrm.side = A.side;
        anim.setBase('perch', perchPrm, 0.14);
        spr.sqV -= 1.2; E.flash('bright', 400);
      }
      return;
    }
    if (!A || !A.visible) { perchWanted = !!A; letGo(false); return; }   // scrolled away: drops down, tries again later
    if (A.side !== perchSide) { perchSide = perchPrm.side = A.side; }
    X = A.x; Y = A.y;
  }
  async function perchOn(id) {
    const A = perchAnchor();
    if (!A || !A.visible || touch || calm() || mode === 'perch' || mode === 'leap') return;
    await rise(id);
    lookAt(A.gx, A.gy, 1.2);                     // sees the card first
    await wait(0.25, id);
    if (mode !== 'stand') return;
    if (Math.abs(wrap(yaw)) > 0.05) { yaw = wrap(yaw); await turnTo(0, id); }
    anim.setBase('idle', {}, 0.15);
    spr.sqV += 1.8;                              // crouch
    await wait(0.14, id);
    perchPrm.side = A.side;
    leap = { t: 0, dur: 0.72, fx: X, fy: Y, peak: Math.max(90, Math.min(260, Math.abs(Y - A.y) * 0.35 + 80)) };
    mode = 'leap';
    anim.setBase('air', {}, 0.1);
    await until(() => mode !== 'leap', id);
    const q = document.querySelector('.study.quiz .q-text')?.getBoundingClientRect();
    if (q) lookAt(q.left + q.width / 2, q.top + q.height / 2, 2.5);
  }
  // ---------- homepage entrance (first homepage visit in a session) ----------
  // It hides behind the "Use it" card: a hand comes up over the card's top edge and grabs it, the bolt peeks
  // out, then the speaker; it looks around, the other hand grabs, it pulls itself up, hops out, lands with a
  // squash and a happy pulse. Everything below the card's edge is clipped, so it really is behind the card.
  const INTRO_KEY = 'sparkscribe.mascot.intro';
  const INTRO_CARD = '.hear-card:last-child';
  // how far (body units) the body center is below the card's top edge over time
  const INTRO_Y = [[0, 2.6], [0.7, 1.55], [1.0, 1.6], [1.8, 1.45], [2.4, 0.1], [3.8, 0.05], [4.3, -0.95], [4.6, -0.9]];
  let intro = null;
  const introCard = () => {
    const el = document.querySelector(INTRO_CARD);
    const r = el?.getBoundingClientRect();
    return r && r.width ? r : null;
  };
  const introVisible = (r) => r && r.top > 1.5 * k && r.top < innerHeight - 3.2 * k && r.right < vw() + 4;
  function introY(t) {
    let i = 0; while (i < INTRO_Y.length - 2 && INTRO_Y[i + 1][0] <= t) i++;
    const [t0, a] = INTRO_Y[i], [t1, b] = INTRO_Y[i + 1];
    return lerp(a, b, ss((t - t0) / (t1 - t0)));
  }
  function stepIntro(dt) {
    const r = introCard();
    if (!r || !introVisible(r)) { abortIntro(); return; }
    intro.t += dt;
    intro.edge = r.top;
    X = r.right - 1.9 * k;
    Y = r.top + introY(intro.t) * k;
  }
  function abortIntro() {                       // the card scrolled away mid-entrance: just appear normally
    intro = null; mode = 'stand'; roll = 0;
    stageEl.style.clipPath = '';
    X = homeX(); anim.release(0.1); anim.setBase('idle', {}, 0.1);
  }
  async function playIntro(id) {
    const r = introCard();
    if (!r || !introVisible(r)) return false;
    try { sessionStorage.setItem(INTRO_KEY, String(Date.now())); } catch { /* fine */ }
    hidden(false);
    intro = { t: 0, edge: r.top };
    mode = 'intro'; roll = 0; yaw = 0; peek = false; peekK = 0;
    X = r.right - 1.9 * k; Y = r.top + 2.6 * k;
    anim.setBase('idle', {}, 0.01);
    E.base('idle');
    setTimeout(() => E.flash('curious', 1400), 1700);          // the speaker "notices" you as it peeks
    await act(CLIPS.intro, id, { fadeIn: 0.01 });
    if (mode !== 'intro') return true;
    // hop out and down to its place
    intro = null; mode = 'leap';
    const fx = X, fy = Y;
    leap = { t: 0, dur: 0.75, fx, fy, peak: 140, to: () => ({ x: homeX(), y: standY() }), done: () => { mode = 'stand'; roll = 0; anim.setBase('idle', {}, 0.15); } };
    anim.setBase('air', {}, 0.1);
    await until(() => mode === 'stand', id);
    spr.sqV += 3.2;                              // landing squash
    E.pulse(2); E.flash('happy', 1000);
    await act(CLIPS.land, id, { fadeIn: 0.02 });
    return true;
  }
  function hidden(on) { el.classList.toggle('m-hiding', on); }

  // quiz over (or ended): let go of the card, land, then `then` runs instead of the usual landing
  function releasePerch(then = null) {
    perchWanted = false;
    if (mode !== 'perch' && mode !== 'leap') { then?.(); return; }
    afterLand = then;
    letGo(true);
  }

  function stepGround(dt) {
    peekK += ((peek ? 1 : 0) - peekK) * (1 - Math.exp(-dt * 3.2));
    if (mode === 'perch' || mode === 'leap') { stepPerch(dt); return; }
    if (mode === 'intro') { stepIntro(dt); return; }
    const prev = speed;
    if (mode === 'stand') {
      if (loco) {
        const d = loco.tx - X, dist = Math.abs(d), dir = Math.sign(d) || lastDir;
        const vmax = (loco.run ? RUN : WALK) * sc, acc = (loco.run ? 1100 : 360) * sc, dec = (loco.run ? 760 : 320) * sc;
        const target = Math.min(vmax, Math.sqrt(2 * dec * Math.max(0, dist - 1)));
        speed += clamp(target - speed, -dec * 1.4 * dt, acc * dt);
        if (dist < 1.5 && speed < 22 * sc) { X = loco.tx; speed = 0; loco = null; }
        else X += dir * Math.min(dist, Math.max(4 * sc, speed) * dt);
        lastDir = dir;
      } else if (speed > 0) {
        speed = Math.max(0, speed - 900 * sc * dt);
        X = clamp(X + lastDir * speed * dt, 1.02 * k, vw() - 1.02 * k);
      }
      accel = (speed - prev) / dt;
      if (anim.baseName === 'gait') {
        const run = clamp((speed - WALK * sc * 0.9) / ((RUN - WALK) * sc * 0.7), 0, 1);
        const amt = clamp(speed / (WALK * sc * 0.55), 0, 1);
        const L = lerp(1.15, 2.4, run) * k * Math.max(0.35, amt);           // distance covered per stride cycle
        phase += (speed * dt) / L * PI * 2;
        if (turnStep > 0 && speed < 5) phase += dt * 9;                      // little steps while turning in place
        gaitPrm.phase = phase; gaitPrm.amt = Math.max(amt, turnStep); gaitPrm.run = run;
      }
      spr.leanT = speed > 2 || prev > 2 ? clamp(-accel * 0.00028 / sc, -0.1, 0.24) : 0;
    } else if (mode === 'wall') {
      if (climb) {
        climbPhase = Math.max(0, climbPhase + climb.dir * climb.rate * dt);
        climbPrm.phase = climbPhase;
        Y = wallBaseY - climbRise(climbPhase) * 0.5 * k;
      } else if (sliding) {
        sliding = Math.min(250 * sc, sliding + 520 * sc * dt);
        Y = Math.min(wallBaseY, Y + sliding * dt);
      }
      hangPrm.twist += (hangTwistTarget - hangPrm.twist) * (1 - Math.exp(-dt * 3));
      spr.leanT = 0;
    }
  }
  function stepYaw(dt) {
    turnStep = 0;
    if (!yawTw) return;
    yawTw.t += dt;
    const u = Math.min(1, yawTw.t / yawTw.dur);
    yaw = yawTw.from + (yawTw.to - yawTw.from) * ss(u);
    if (speed < 5) turnStep = 0.38 * Math.sin(PI * u);
    if (u >= 1) { yaw = yawTw.to; yawTw = null; }
  }

  // ---------- held, thrown, rolling to rest ----------
  let grab = null;
  function stepHeld(dt) {
    const tx = grab.px - grab.ox, ty = grab.py - grab.oy;
    const kk = 1 - Math.exp(-dt * 22);
    const nx = X + (tx - X) * kk, ny = Y + (ty - Y) * kk;
    const hv = (nx - X) / dt;
    X = nx; Y = ny;
    const tgt = clamp(-hv * 0.00045, -0.6, 0.6);           // swings against the way it's carried
    w += (60 * (tgt - roll) - 9 * w) * dt; roll += w * dt;
    heldPrm.flail = clamp(Math.abs(hv) / 1400, 0, 1);
    accel = 0; spr.leanT = 0;
  }
  function stepAir(dt) {
    vy += G * dt; vx *= 1 - 0.25 * dt;
    X += vx * dt; Y += vy * dt;
    roll += w * dt; yaw += wy * dt; wy *= 1 - 0.9 * dt;
    const r = 1.05 * k;
    if (X < r) { X = r; vx = Math.abs(vx) * 0.55; w = -w * 0.6 - vy * 0.0012; impact(vx); }
    if (X > vw() - r) { X = vw() - r; vx = -Math.abs(vx) * 0.55; w = -w * 0.6 + vy * 0.0012; impact(-vx); }
    if (Y < r) { Y = r; vy = Math.abs(vy) * 0.4; }
    const fl = FLOOR() - support(roll) * k;
    if (Y >= fl) {
      Y = fl;
      if (vy > 420) { impact(vy); vy = -vy * 0.36; vx *= 0.72; w = w * 0.55 - (vx / k) * 0.25; }
      else { vy = 0; enterRoll(); }
    }
    spr.leanT = 0;
  }
  function impact(v) {
    spr.sqV += Math.min(4, v / 500);
    E.flash('bright', 260);
  }
  // on the ground after a throw: it rocks / rolls to the nearest resting position (upright or on a side)
  function enterRoll() {
    mode = 'roll';
    roll = wrap(roll);
    rollTarget = Math.abs(roll) < 0.55 ? 0 : Math.sign(roll) * PI / 2;
    w = w * 0.5 - (vx / k) * 0.5;
    yaw = wrap(yaw);
    const yawRest = rollTarget ? 0 : [-PI / 2, 0, PI / 2].reduce((a, b) => (Math.abs(b - yaw) < Math.abs(a - yaw) ? b : a));
    yawTw = { from: yaw, to: yawRest, t: 0, dur: 0.4 };
    if (rollTarget) anim.setBase('fallen', { side: Math.sign(rollTarget) }, 0.35);
    else { anim.setBase('idle', {}, 0.3); if (Math.abs(roll) > 0.3) anim.play(CLIPS.catch); }
  }
  function stepRoll(dt) {
    // rocked too far to recover on its feet: it tips over onto that side
    if (rollTarget === 0 && Math.abs(roll) > 1.0) { rollTarget = Math.sign(roll) * PI / 2; anim.setBase('fallen', { side: Math.sign(roll) }, 0.35); }
    w += (-40 * (roll - rollTarget) - 6.5 * w) * dt;
    const prev = roll;
    roll += w * dt;
    X = clamp(X - (roll - prev) * k * 0.95 + vx * dt, 1.02 * k, vw() - 1.02 * k);
    vx *= Math.exp(-5 * dt);
    Y = FLOOR() - support(roll + P[K.sr]) * k;
    if (Math.abs(w) < 0.06 && Math.abs(roll - rollTarget) < 0.012 && Math.abs(vx) < 12) {
      roll = rollTarget; vx = 0; w = 0; mode = 'stand';
      moved = true; save();
      if (!rollTarget && afterLand) { const f = afterLand; afterLand = null; anim.setBase(moodBase(), {}, 0.3); f(); }
      else if (rollTarget) run(getUp); else run(landed);
    }
  }
  async function landed(id) {
    if (launch > 2300 || dizzyNext) { dizzyNext = false; fx('dizzy'); E.flash('curious', 1400); await act(CLIPS.wobble, id); await wait(0.4, id); }
    await wait(rand(0.3, 0.7), id);
    if (Math.abs(yaw) > 0.05) await turnTo(0, id);
    anim.setBase(moodBase(), {}, 0.3);
  }
  // getting up from its side: a real sequence, never a flip
  async function getUp(id) {
    const s = Math.sign(roll) || 1;
    anim.setBase('fallen', { side: s }, 0.3);
    await wait(rand(0.6, 1.1), id);
    E.surprise(); E.flash('curious', 900);
    if (dizzyNext) { dizzyNext = false; fx('dizzy'); }
    await act(CLIPS.getUp(s), id, { fadeIn: 0.2, onEnd: () => { roll = 0; anim.setBase(moodBase(), {}, 0.01); } });
    E.pulse(1); E.flash('happy', 700);
  }

  // ---------- secondary motion: settle after stops, gem wobble, impact squash ----------
  let prevVX = 0;
  function stepSecondary(dt) {
    spr.leanV += (70 * (spr.leanT - spr.lean) - 9 * spr.leanV) * dt; spr.lean += spr.leanV * dt;
    const hvx = mode === 'stand' ? lastDir * speed : vx;
    const ax = (hvx - prevVX) / dt; prevVX = hvx;
    const gemT = clamp(-ax * 0.00006, -0.25, 0.25) * (Math.abs(yaw) > 1 ? 0 : 1);
    spr.gemV += (110 * (gemT - spr.gem) - 5 * spr.gemV) * dt; spr.gem += spr.gemV * dt;
    spr.sqV += (-170 * spr.sq - 11 * spr.sqV) * dt; spr.sq += spr.sqV * dt;
    spr.sq = clamp(spr.sq, -0.12, 0.2);
  }

  // ---------- the speaker looks at things ----------
  function stepEye(dt) {
    let tx = null, ty = null;
    if (look && clock < look.until) { tx = look.x; ty = look.y; }
    else if (fileDrag.active) { tx = fileDrag.x; ty = fileDrag.y; }
    else if (!touch && clock - cursor.t < 5 && Math.hypot(cursor.x - X, cursor.y - Y) < 950) { tx = cursor.x; ty = cursor.y; }
    let gx, gy;
    if (tx != null && mode !== 'held') [gx, gy] = stage.lookDir((tx - X) / k, -(ty - Y) / k);
    else {
      if (clock > glance.next) {
        glance.next = clock + rand(1.6, 4.5);
        if (Math.random() < 0.45) { glance.x = 0; glance.y = 0; } else { glance.x = rand(-0.85, 0.85); glance.y = rand(-0.3, 0.6); }
      }
      gx = glance.x; gy = glance.y;
      if (mode === 'held') { gx = 0; gy = -0.3; }
    }
    const wE = P[K.eyeW];
    gx = lerp(gx, P[K.eyeX], wE); gy = lerp(gy, P[K.eyeY], wE);
    const kk = 1 - Math.exp(-dt * 16);
    ex += (gx - ex) * kk; ey += (gy - ey) * kk;
  }

  // ---------- autonomy: now and then it decides to do something small ----------
  let autoAt = 8;
  const canAct = () => live() && !calm() && mood === 'idle' && mode === 'stand' && !taskActive && !peek && !grab && !fileDrag.active && !hovering && !busy() && !reading();
  function autonomy() {
    if (clock < autoAt) return;
    autoAt = clock + rand(8, 12);
    if (!canAct() || pref !== 'on') return;
    const dz = document.getElementById('dropzone');
    const dzOK = page === 'home' && dz && dz.offsetParent !== null;
    const far = Math.abs(X - homeX()) > 3 * k;
    const cursorNear = clock - cursor.t < 3 && Math.abs(cursor.x - X) < 520 && Math.abs(cursor.x - X) > 2 * k;
    const b = touch
        ? pick([['nothing', 40], ['lookAround', 20], ['footTap', 12], ['hop', 8], ['stretch', 10], ['sit', 10]])
        : pick([['nothing', 26], ['lookAround', 14], ['footTap', 8], ['hop', 5], ['stretch', 6], ['sit', 6], ['rest', 3],
          ['steps', 10], ['wander', 4], ['home', far ? 9 : 0], ['inspect', dzOK ? 6 : 0], ['climb', readingMode ? 0 : 6],
          ['page', 5], ['dance', 3], ['approach', cursorNear ? 6 : 0]]);
    if (!b || b === 'nothing') return;
    run((id) => behave(b, id));
  }
  async function behave(b, id) {
    if (['lookAround', 'footTap', 'hop', 'stretch', 'dance'].includes(b)) { await act(CLIPS[b], id); return; }
    if (b === 'sit' || b === 'rest') return sitFor(id, b === 'rest');
    if (b === 'steps') return go(X + (Math.random() < 0.5 ? -1 : 1) * rand(1.5, 3.5) * k, id);
    if (b === 'wander') return go(rand(minX(), maxX()), id);
    if (b === 'home') return go(homeX(), id);
    if (b === 'approach') { await go(cursor.x + (cursor.x > X ? -1.8 : 1.8) * k, id); lookAt(cursor.x, cursor.y, 1.5); E.flash('curious', 1200); return; }
    if (b === 'page') {                                     // turns around and looks at the page for a moment
      await turnTo(PI * (Math.random() < 0.5 ? 1 : -1), id);
      anim.setBase('idle', {}, 0.3);
      await wait(rand(1.8, 3.2), id);
      if (Math.random() < 0.5) await act(CLIPS.nod, id);
      await turnTo(0, id);
      anim.setBase('idle', {}, 0.3);
      return;
    }
    if (b === 'inspect') return inspect(id);
    if (b === 'climb') return climbEdge(id);
  }
  async function sitFor(id, sleepy) {
    anim.setBase('sit', { sleepy }, 0.7);
    if (sleepy) E.base('tired');
    try { await wait(rand(4, 9), id); } finally { if (sleepy) E.base('idle'); }
    const p = act(CLIPS.pressUp, id, { fadeIn: 0.15 });
    anim.setBase('idle', {}, 0.01);
    await p;
  }
  async function inspect(id) {
    const dz = document.getElementById('dropzone');
    if (!dz) return;
    const r = dz.getBoundingClientRect();
    const side = X > r.left + r.width / 2 ? 1 : -1;
    const tx = side > 0 ? r.right + 1.7 * k : r.left - 1.7 * k;
    await go(tx, id, { face: 'none' });
    await turnTo(-side * PI / 2 * 0.75, id);
    anim.setBase('idle', {}, 0.3);
    lookAt(r.left + r.width / 2, r.top + r.height / 2, 3.5);
    E.flash('curious', 1500);
    await wait(0.6, id);
    await act(CLIPS.nod, id);
    await wait(rand(1, 2), id);
    await turnTo(0, id);
    anim.setBase('idle', {}, 0.3);
  }
  // how high can it climb at this edge without covering a control?
  function safeClimb(side, hugX) {
    const top = standY() - innerHeight * 0.4, xs = [hugX - side * 1.3 * k, hugX, hugX + side * 0.6 * k].map((x) => clamp(x, 1, vw() - 1));
    for (let y = standY() - 0.4 * k; y > top; y -= 12) {
      for (const x of xs) {
        for (const n of document.elementsFromPoint(x, y)) {
          if (el.contains(n)) continue;
          if (n.closest(INTERACTIVE)) return standY() - y - 2 * k;
        }
      }
    }
    return standY() - top;
  }
  async function climbEdge(id) {
    const side = X > vw() / 2 ? 1 : -1;
    const wallX = side > 0 ? vw() : 0;
    const hugX = wallX - side * 1.0 * k;
    const room = safeClimb(side, hugX);
    if (room < 1.6 * k) { await act(CLIPS.lookAround, id); return; }
    await go(hugX, id, { face: 'none', raw: true });
    if (Math.abs(wrap(yaw - side * PI / 2)) > 0.05) await turnTo(side * PI / 2, id);
    lookAt(X, Y - 4 * k, 1.2);
    await wait(0.5, id);
    // up: arm over arm, the feet pushing
    mode = 'wall'; wallBaseY = Y; climbPhase = 0; climbPrm.phase = 0;
    anim.setBase('climb', climbPrm, 0.35);
    const goal = Math.min(room, rand(0.2, 0.33) * innerHeight);
    climb = { dir: 1, rate: 1.0 };
    await until(() => wallBaseY - Y >= goal, id);
    climb = null;
    // hang there and look around (it turns a little toward you)
    hangPrm.twist = 0; hangTwistTarget = -side * 0.75;
    anim.setBase('hang', hangPrm, 0.45);
    await wait(0.6, id);
    lookAt(side > 0 ? X - 600 : X + 600, Y + 80, 1.4);
    await wait(rand(1.2, 2.2), id);
    lookAt(X, FLOOR(), 1);
    await wait(0.9, id);
    hangTwistTarget = 0;
    await wait(0.4, id);
    // down: sometimes climbs down, sometimes slides
    if (Math.random() < 0.55) {
      anim.setBase('slide', {}, 0.3);
      sliding = 1;
      await until(() => Y >= wallBaseY - 0.5, id);
      sliding = 0;
    } else {
      anim.setBase('climb', climbPrm, 0.35);
      climb = { dir: -1, rate: 1.1 };
      await until(() => climbPhase <= 0, id);
      climb = null;
    }
    Y = wallBaseY; mode = 'stand';
    anim.setBase('gait', gaitPrm, 0.2);
    await act(CLIPS.land, id, { fadeIn: 0.05 });
    await wait(0.3, id);
    await go(X - side * rand(2.5, 4) * k, id);
  }

  // ---------- working (transcription in progress) ----------
  async function workLoop(id, walk) {
    const panel = document.getElementById('progressPanel');
    if (walk && panel && panel.offsetParent !== null && !quiet()) {
      const r = panel.getBoundingClientRect();
      await go(Math.min(r.right + 1.8 * k, maxX()), id);
    }
    anim.setBase('working', {}, 0.4);
    for (;;) {
      await wait(rand(3, 6), id);
      if (quiet() && Math.random() < 0.6) continue;
      const p = document.getElementById('progressPanel');
      // what it does follows the stage: watches the bar while the model downloads, listens while the
      // audio is checked and speakers are found, pulses its speaker while words come in
      const setup = workStage === 'setup', listening = workStage === 'analyze' || workStage === 'speakers', writing = workStage === 'run';
      const a = pick([['tap', setup ? 10 : 28], ['look', setup ? 60 : 30], ['listen', listening ? 55 : 22], ['pulse', writing ? 40 : 0], ['nod', 12], ['sit', clock - workSince > 25 ? 8 : 0]]);
      if (a === 'tap') await act(CLIPS.footTap, id);
      else if (a === 'pulse') E.pulse(2);
      else if (a === 'look' && p && p.offsetParent !== null) {
        const bar = setup ? document.getElementById('pctBar') : null;
        const r = (bar && bar.offsetParent !== null ? bar : p).getBoundingClientRect();
        lookAt(bar ? r.right : r.left + r.width / 2, r.top + r.height / 2, 2.5);
      }
      else if (a === 'listen') E.flash('listening', 2000);
      else if (a === 'nod') await act(CLIPS.nod, id);
      else if (a === 'sit') { anim.setBase('sit', {}, 0.7); await wait(rand(5, 9), id); const q = act(CLIPS.pressUp, id); anim.setBase('working', {}, 0.01); await q; }
    }
  }
  let workSince = 0, workStage = '';

  // ---------- cursor: the speaker follows it; sometimes a small reaction ----------
  let hovering = false, hoverAt = 0, nearSince = 0, lastMove = null;
  function onPointerMove(e) {
    if (e.pointerType !== 'mouse' || touch) return;
    cursor.x = e.clientX; cursor.y = e.clientY; cursor.t = clock;
    const now = performance.now();
    const spd = lastMove ? Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / Math.max(1, now - lastMove.t) : 0;
    lastMove = { x: e.clientX, y: e.clientY, t: now };
    if (grab || !live() || calm() || mood !== 'idle' || mode !== 'stand' || taskActive || peek || quiet() || busy()) { nearSince = 0; return; }
    const dx = e.clientX - X, d = Math.hypot(dx, e.clientY - Y);
    if (d < 200 * sc && !hovering) {
      if (!nearSince) nearSince = clock;
      else if (clock - nearSince > 0.8 && clock > cool.near) {
        cool.near = clock + 6; nearSince = Infinity;
        const r = pick([['nothing', 40], ['curious', 35], ['step', 25]]);
        if (r === 'curious') { E.flash('curious', 1600); run((id) => act(CLIPS.tilt, id)); }
        else if (r === 'step') run((id) => go(X + Math.sign(dx) * rand(0.9, 1.6) * k, id));
      }
    } else nearSince = 0;
    if (spd > 1.7 && d < 260 * sc && clock > cool.fast) {
      cool.fast = clock + 9;
      const dir = Math.sign(e.clientX - X) || 1;
      const r = pick([['notice', 35], ['hop', 22], ['turn', 23], ['chase', page === 'home' ? 20 : 0]]);
      if (r === 'notice') { E.surprise(); E.flash('bright', 500); }
      else if (r === 'hop') { E.surprise(); run((id) => act(CLIPS.hop, id)); }
      else if (r === 'turn') run(async (id) => { await turnTo(dir * PI / 2 * 0.7, id); anim.setBase('idle', {}, 0.3); await wait(1.1, id); await turnTo(0, id); anim.setBase('idle', {}, 0.3); });
      else run((id) => go(X + dir * rand(1.8, 3) * k, id, { run: true }));
    }
  }
  hit.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || grab || !live()) return;
    hovering = true;
    if (peek && mood === 'idle') { peek = false; }
    if (mood === 'idle' && !calm()) E.flash('bright', 700);
    hoverAt = clock;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => {
      if (hovering && mood === 'idle' && !grab && mode === 'stand' && !taskActive) { fx('question'); E.flash('curious', 1600); run((id) => act(CLIPS.tilt, id)); }
    }, 3000);
  });
  let hoverT = 0;
  hit.addEventListener('pointerleave', () => { hovering = false; clearTimeout(hoverT); afterAction(3500); });

  // ---------- click, grab, throw ----------
  let down = null, clicks = 0, clickT = 0, lastReaction = '';
  hit.addEventListener('pointerdown', (e) => {
    if (!live() || e.button !== 0) return;
    e.preventDefault();
    // the top of the character (the gem) in its own frame
    const th = roll + P[K.sr], dx = e.clientX - sx(), dy = sy() - e.clientY;
    const upY = -dx * Math.sin(th) + dy * Math.cos(th);
    down = { id: e.pointerId, sx: e.clientX, sy: e.clientY, gem: upY > 0.8 * k, samples: [], turn: 0, lastAng: null, moved: false };
    if (!touch && e.pointerType === 'mouse' && !calm()) { try { hit.setPointerCapture(e.pointerId); } catch { /* fine */ } }
  });
  hit.addEventListener('pointermove', (e) => {
    if (!down || down.id !== e.pointerId || touch || e.pointerType !== 'mouse' || calm()) return;
    const dist = Math.hypot(e.clientX - down.sx, e.clientY - down.sy);
    if (!down.moved && dist < 6) return;
    if (!down.moved) {
      down.moved = true;
      cancelTask();
      grab = { ox: e.clientX - X, oy: e.clientY - Y, px: e.clientX, py: e.clientY };
      mode = 'held'; peek = false; peekK = 0; loco = null; speed = 0; climb = null;
      roll = wrap(roll + P[K.sr]); w = 0;
      yaw = wrap(yaw); yawTw = { from: yaw, to: 0, t: 0, dur: 0.35 };
      anim.release(0.15);
      anim.setBase('held', heldPrm, 0.2);
      E.surprise(); E.flash('excited', 99999);
      hit.classList.add('m-grabbing');
    }
    grab.px = e.clientX; grab.py = e.clientY;
    const now = performance.now();
    const prev = down.samples.at(-1);
    down.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (down.samples.length > 2 && now - down.samples[0].t > 110) down.samples.shift();
    if (prev) {   // dragging it in circles makes it dizzy
      const mx = e.clientX - prev.x, my = e.clientY - prev.y;
      if (Math.hypot(mx, my) > 3) {
        const ang = Math.atan2(my, mx);
        if (down.lastAng != null) { let da = ang - down.lastAng; if (da > PI) da -= 2 * PI; if (da < -PI) da += 2 * PI; down.turn += da; }
        down.lastAng = ang;
      }
    }
  });
  function release(e, cancelled) {
    if (!down || (e && down.id !== e.pointerId)) return;
    const d = down; down = null;
    if (!d.moved) { if (!cancelled) onClick(d.gem); return; }
    grab = null;
    hit.classList.remove('m-grabbing');
    E.flash('excited', 1);
    const s = d.samples, a = s[0], b = s.at(-1);
    const dt = a && b ? Math.max(16, b.t - a.t) : 16;
    vx = a && b ? clamp(((b.x - a.x) / dt) * 1000, -3200, 3200) : 0;
    vy = a && b ? clamp(((b.y - a.y) / dt) * 1000, -3200, 3200) : 0;
    launch = Math.hypot(vx, vy);
    dizzyNext = Math.abs(d.turn) > PI * 3.2;
    w += clamp(vx * 0.0045, -10, 10);
    wy = Math.abs(vx) > 700 ? clamp(vx * 0.0016, -4, 4) : 0;
    mode = 'air';
    anim.setBase('air', {}, 0.15);
  }
  hit.addEventListener('pointerup', (e) => release(e, false));
  hit.addEventListener('pointercancel', (e) => release(e, true));
  hit.addEventListener('dragstart', (e) => e.preventDefault());

  function onClick(onGem) {
    if (pref === 'off') return;
    if (peek) peek = false;
    clicks++;
    clearTimeout(clickT);
    clickT = setTimeout(() => {
      const n = clicks; clicks = 0;
      if (calm() || mode !== 'stand') { E.flash('happy', 900); E.pulse(1); return; }
      if (n >= 3) run(async (id) => { await ready(id); E.flash('success', 1500); E.gem('success', 1400); E.pulse(3); fx('sparkles'); await act(CLIPS.cheer, id); });
      else if (n === 2) run(async (id) => { await ready(id); E.flash('happy', 900); await act(CLIPS.spin, id); });
      else if (onGem) run(async (id) => { await ready(id); E.gem('flash', 900); E.flash('bright', 600); await act(CLIPS.gemTouch, id); });
      else react();
      afterAction();
    }, 260);
  }
  function react() {
    const opts = [['hop', 22], ['wave', 18], ['stepBack', 14], ['pulse', 14], ['dance', 8], ['shake', 10], ['cheer', 8], ['spin', 8]].filter(([v]) => v !== lastReaction);
    const r = pick(opts);
    lastReaction = r;
    run(async (id) => {
      await ready(id);
      if (r === 'pulse') { E.flash('happy', 1100); E.pulse(3); await act(CLIPS.nod, id); return; }
      if (r === 'stepBack') { E.surprise(); E.flash('bright', 700); }
      else if (r === 'dance') E.flash('excited', 1900);
      else E.flash('happy', 900);
      await act(CLIPS[r], id);
    });
  }

  // ---------- a file dragged over the page ----------
  const fileDrag = { active: false, x: 0, y: 0, at: 0, endT: 0 };
  const dropzone = () => document.getElementById('dropzone');
  function fileDragAllowed() {
    const dz = dropzone();
    return page === 'home' && live() && dz && dz.offsetParent !== null && mood !== 'working' && !grab;
  }
  function onDragMove(e) {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files') || !fileDragAllowed()) return;
    clearTimeout(fileDrag.endT);
    fileDrag.x = e.clientX; fileDrag.y = e.clientY;
    if (!fileDrag.active) {
      fileDrag.active = true;
      el.classList.add('m-passthrough');
      run(async (id) => {
        await wait(0.25, id);                     // the speaker notices it first
        setMood('excited'); E.surprise(); E.gem('flash', 600);
        if (!touch && !calm()) await act(CLIPS.hop, id);
        fx('sparkles');
        // then runs over to the upload panel and waits beside it, watching the file
        const r = dropzone().getBoundingClientRect();
        const tx = X > r.left + r.width / 2 ? r.right + 1.7 * k : r.left - 1.7 * k;
        if (!touch && !quiet() && Math.abs(tx - X) > 1.5 * k) await go(tx, id, { run: Math.abs(tx - X) > 6 * k, look: false });
        anim.setBase('excited', {}, 0.3);
        await until(() => !fileDrag.active, id);
      });
    }
  }
  function endDrag(delay = 120) {
    if (!fileDrag.active) return;
    clearTimeout(fileDrag.endT);
    fileDrag.endT = setTimeout(() => {
      fileDrag.active = false;
      el.classList.remove('m-passthrough');
      if (mood === 'excited') setMood('idle');
    }, delay);
  }
  window.addEventListener('dragenter', onDragMove);
  window.addEventListener('dragover', onDragMove);
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endDrag(250); });
  window.addEventListener('drop', () => endDrag(400));
  window.addEventListener('dragend', () => endDrag(0));

  // ---------- reading pages: it sinks to peek over the bottom edge while you read ----------
  function afterAction(ms = 6000) {
    if (!readingMode || touch) return;
    clearTimeout(afterAction.t);
    afterAction.t = setTimeout(() => { if (mood === 'idle' && !hovering && !grab && mode === 'stand' && !taskActive) peek = true; }, ms);
  }

  // ---------- app signals ----------
  let sadT = 0;
  function toIdle() { clearTimeout(sadT); setMood('idle'); }
  async function runIn(id) {
    const target = moved ? clampX(X) : homeX();
    if (calm()) { X = target; peek = false; return; }
    if (quiet()) { peek = false; await ready(id); E.flash('happy', 900); await act(CLIPS.nod, id); return; }
    peek = false; peekK = 0; mode = 'stand'; roll = 0;
    X = -1.6 * k; yaw = PI / 2; yawTw = null; speed = 0;
    anim.setBase('gait', gaitPrm, 0.01);
    loco = { tx: target, run: true };
    await until(() => !loco, id);
    await wait(0.2, id);
    await turnTo(0, id);
    anim.setBase(moodBase(), {}, 0.3);
    E.flash('happy', 900);
    await act(CLIPS.nod, id);
  }
  const signals = {
    'file-accepted': () => {
      endDrag(0);
      setMood('excited');
      run(async (id) => { await ready(id); E.flash('happy', 1100); E.pulse(3); E.gem('flash', 700); await act(CLIPS.hop, id); });
    },
    stage: ({ stage }) => { workStage = stage || ''; },
    working: () => {
      setMood('working'); workSince = clock;
      run((id) => workLoop(id, true));
    },
    'transcribe-done': () => {
      setMood('celebrating');
      E.flash('success', 1800); E.gem('success', 1600); E.pulse(3);
      run(async (id) => {
        await ready(id);
        setTimeout(() => fx('sparkles'), 380);
        await act(CLIPS.celebrate, id);
        setMood('idle');
      });
    },
    'results-shown': () => { readingMode = true; run(async (id) => { await runIn(id); afterAction(7000); }); },
    reset: () => { readingMode = readingPage; toIdle(); if (!moved) run((id) => go(homeX(), id)); },
    error: () => {
      setMood('sad');
      run(async (id) => { await ready(id); fx('question'); lookAt(vw() / 2, innerHeight / 2, 2); });
      clearTimeout(sadT);
      sadT = setTimeout(() => { if (mood === 'sad') { toIdle(); run(async (id) => { await act(CLIPS.shake, id); E.flash('happy', 800); }); } }, 9000);
    },
    'ask-start': () => { if (mood !== 'idle') return; setMood('thinking'); E.gem('shimmer', 99999); run((id) => ready(id)); },
    'ask-done': () => {
      if (mood === 'thinking') toIdle();
      E.gem('flash', 600); E.flash('success', 900);
      E.pulse(1); run(async (id) => { await ready(id); await act(CLIPS.nod, id); });
      afterAction(4000);
    },
    'ask-error': () => { if (mood === 'thinking') toIdle(); E.gem('', 1); E.flash('error', 1600); run((id) => act(CLIPS.wobble, id)); afterAction(4000); },
    // Practice Quiz: the mascot is a quiet study buddy. Focus mode is automatic while a question is on screen
    // (busy() sees the .quiz), so it never roams; it only watches, listens and reacts to answers.
    'quiz-start': () => {
      E.flash('listening', 1600);
      if (touch) { cancelTask(); away = true; peek = true; return; }   // small screens: out of the way of the answers
      if (mode === 'perch' || mode === 'leap') return;
      perchWanted = true;      // the card is drawn right after this signal; the frame loop jumps once it's on screen
      perchCheckAt = clock - 0.3;
    },
    'quiz-next': () => {
      E.flash('listening', 900);
      const q = document.querySelector('.study.quiz .q-text')?.getBoundingClientRect();
      if (q && (mode === 'perch' || mode === 'leap')) setTimeout(() => lookAt(q.left + q.width / 2, q.top + q.height / 2, 2.5), 60);
      else if (!touch) perchWanted = true;
    },
    'quiz-end': () => {
      E.flash('idle', 1);
      if (away) { away = false; peek = readingMode; }
      releasePerch();
    },
    'quiz-correct': () => {
      E.flash('happy', 900); E.pulse(1); E.gem('flash', 600);
      if (mode === 'perch') run((id) => act(CLIPS.perchCheer(perchSide), id));
      else run((id) => act(Math.random() < 0.5 ? CLIPS.nod : CLIPS.hop, id));
    },
    'quiz-wrong': () => {
      E.flash('curious', 900);
      if (mode === 'perch') run((id) => act(CLIPS.perchAww(perchSide), id));
      else run((id) => act(CLIPS.wobble, id));
    },
    'quiz-done': ({ score = 0, total = 1 }) => {
      const k2 = total ? score / total : 0;
      const celebrate = () => run(async (id) => {
        await ready(id);
        if (k2 >= 1) {            // perfect: the bigger celebration
          E.flash('success', 2400); E.gem('success', 2200); E.pulse(3); fx('sparkles');
          setTimeout(() => { fx('sparkles'); E.pulse(3); }, 700);
          await act(CLIPS.celebrate, id);
          await act(CLIPS.cheer, id);
        } else if (k2 >= 0.6) { E.flash('success', 1500); E.gem('success', 1200); E.pulse(2); await act(CLIPS.cheer, id); }
        else { E.flash('happy', 1200); E.pulse(1); await act(CLIPS.hop, id); }
      });
      releasePerch(celebrate);
      afterAction(5000);
    },
    // a glance only (hovering a Create tool): never a walk or a jump
    'look': ({ x: lx, y: ly }) => {
      if (lx == null || mood !== 'idle' || clock < cool.look) return;
      cool.look = clock + 0.8;
      lookAt(lx, ly, 1.4);
    },
    // Summary / Notes being written: a short reading/thinking state, a small pulse when done
    'think-start': () => { if (mood === 'idle') { setMood('thinking'); E.gem('shimmer', 99999); } },
    'think-done': () => { if (mood === 'thinking') toIdle(); E.gem('', 1); E.flash('success', 800); E.pulse(1); },
    'think-error': () => { if (mood === 'thinking') toIdle(); E.gem('', 1); E.flash('error', 1200); },
    // the recording is playing: the speaker listens along (no dancing)
    'audio-play': () => { listeningAudio = true; if (mood === 'idle') E.base('listening'); },
    'audio-pause': () => { listeningAudio = false; if (mood === 'idle') E.base('idle'); },
    'flashcard-flip': () => { if (!quiet() && Math.random() < 0.15 && mode === 'stand') run((id) => act(CLIPS.spin, id)); },
    'search-found': () => {
      if (clock < cool.search) return;
      cool.search = clock + 12;
      lookAt(vw() * 0.3, innerHeight * 0.4, 1.8);
      E.flash('happy', 1000);
      run(async (id) => { await ready(id); await act(CLIPS.wave, id); });
    },
    'cta-hover': ({ x: px, y: py }) => {
      if (mood !== 'idle' || quiet() || px == null) return;
      if (Math.abs(px - X) < 520) { lookAt(px, py ?? innerHeight / 2, 1.2); E.flash('happy', 800); }
    },
  };
  window.addEventListener('sparkscribe:mascot', (e) => {
    if (pref === 'off') return;
    if (el.classList.contains('m-hiding')) hidden(false);
    const { type, ...detail } = e.detail || {};
    try { signals[type]?.(detail); } catch { /* the mascot never breaks the app */ }
  });

  // ---------- persistence, visibility, resize ----------
  function save() { try { sessionStorage.setItem(POS_KEY, JSON.stringify({ xf: (loco ? loco.tx : clampX(X)) / vw(), moved })); } catch { /* fine */ } }
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  // browser zoom and resizing fire 'resize': the anchor is measured again; a small move glides, a big jump
  // (the layout really changed) fades out and back in at the new place instead of teleporting
  let reanchorT = 0, glideTo = null;
  function reanchor() {
    if (mode !== 'stand' || taskActive || grab || loco || !stage) return;
    const target = moved ? clampX(X) : homeX();
    const d = target - X;
    if (Math.abs(d) < 3) return;
    if (Math.abs(d) < 3 * k) { glideTo = target; return; }
    stageEl.classList.add('m-fading');
    setTimeout(() => { X = target; glideTo = null; stageEl.classList.remove('m-fading'); }, 220);
  }
  addEventListener('resize', () => { size(); if (mode === 'stand') X = clampX(X); clearTimeout(reanchorT); reanchorT = setTimeout(reanchor, 160); }, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(() => { clearTimeout(reanchorT); reanchorT = setTimeout(reanchor, 160); }).observe(document.body);
  if (!touch) addEventListener('pointermove', onPointerMove, { passive: true });

  // ---------- On / Quiet / Off (chosen in Settings → Preferences, src/lib/prefs.js) ----------
  function applyPref() {
    el.classList.toggle('m-off', pref === 'off');
    if (pref === 'off') { cancelTask(); stop(); return; }
    if (!booted) bootSoon(); else start();
  }
  function setPref(v) {
    if (!['on', 'quiet', 'off'].includes(v) || v === pref) return;
    const was = pref;
    pref = v; applyPref();
    if (v !== 'on') { cancelTask(); peek = peek && readingMode; }
    if (was === 'off' && stage) run(async (id) => { await wait(0.3, id); E.flash('happy', 900); await act(CLIPS.hop, id); });
  }
  addEventListener('sparkscribe:mascot-pref', (e) => setPref(e.detail));
  addEventListener('storage', (e) => { if (e.key === MASCOT_KEY) setPref(getMascotPref()); });   // other tabs

  // ---------- start: load the 3D character once the page is ready ----------
  let travelled = false;
  try {
    const t = Number(sessionStorage.getItem(TRAVEL_KEY) || 0);
    sessionStorage.removeItem(TRAVEL_KEY);
    travelled = t && Date.now() - t < 12000;
  } catch { /* fine */ }
  function fallback() {
    el.classList.add('m-static');
    stageEl.innerHTML = '<img class="m-still" src="/mascot/full.webp" alt="" draggable="false" />';
    Y = standY(); P = REST; place();
  }
  let booted = false;
  const boot = () => import('./stage.js').then(({ createStage }) => {
    try { stage = createStage(canvas); } catch { fallback(); return; }
    size();
    if (!moved) X = homeX();
    el.classList.add('m-ready');
    applyPref();
    if (pref === 'off') return;
    if (travelled) run(async (id) => { await runIn(id); afterAction(5000); });
    else if (introWanted()) waitForIntro();
    else if (!peek) run(async (id) => { await wait(0.5, id); E.flash('happy', 900); await act(CLIPS.hop, id); });
  }).catch(fallback);
  // the entrance plays once per session, on the homepage, when the "Use it" card is on screen; until then the
  // mascot stays hidden. Any real product moment (a file, an upload) or ~9 s without the card: it just appears.
  function introWanted() {
    if (page !== 'home' || touch || calm() || pref !== 'on') return false;
    try { if (sessionStorage.getItem(INTRO_KEY)) return false; } catch { return false; }
    return !!document.querySelector(INTRO_CARD);
  }
  function waitForIntro() {
    hidden(true);
    const started = performance.now();
    const check = () => {
      if (!el.classList.contains('m-hiding')) return;                 // something else showed it already
      if (pref !== 'on' || mood !== 'idle' || fileDrag.active) { appearNormally(); return; }
      if (introVisible(introCard()) && mode === 'stand' && !taskActive) { run(playIntro); return; }
      if (performance.now() - started > 9000) { appearNormally(); return; }
      setTimeout(check, 250);
    };
    setTimeout(check, 400);
  }
  function appearNormally() {
    if (!el.classList.contains('m-hiding')) return;
    hidden(false);
    run(async (id) => { await wait(0.2, id); E.flash('happy', 900); await act(CLIPS.hop, id); });
  }

  // Off: the 3D character isn't even loaded until it's switched on
  function bootSoon() {
    if (booted) return;
    booted = true;
    if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 1500 }); else setTimeout(boot, 300);
  }
  applyPref();

  instance = {
    setPref, get pref() { return pref; },
    signal: (type, detail) => signals[type]?.(detail || {}),
  };
  if (import.meta.env?.DEV) {
    window.__mascot = {
      ...instance,
      debug: () => ({ mood, mode, pref, touch, peek, peekK, X, Y, yaw, roll, base: anim.baseName, clip: anim.playing, taskActive, speed, k, S, ready: !!stage }),
      behave: (b) => run((id) => behave(b, id)),
      throwIt: (tvx, tvy, tw) => { cancelTask(); mode = 'air'; vx = tvx; vy = tvy; w = tw ?? clamp(tvx * 0.0045, -10, 10); wy = 0; launch = Math.hypot(tvx, tvy); anim.setBase('air', {}, 0.15); },
      // step the simulation by hand (a hidden tab pauses requestAnimationFrame)
      slow: (f = 1) => { devSlow = f; },
      tick: (sec, fps = 60) => { running = true; for (let i = 0; i < sec * fps; i++) { frame(lastTs + 1000 / fps); cancelAnimationFrame(raf); } },
      shot: () => { draw(0.016); return canvas.toDataURL('image/png'); },
      pose: () => ({ X, Y, yaw, roll, sr: P[K.sr], sy: P[K.sy], aLz: P[K.aLz], aRz: P[K.aRz], lLx: P[K.lLx], twist: P[K.twist] }),
    };
  }
  return instance;
}
