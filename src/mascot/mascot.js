// The SparkScribe mascot: a small audio companion that lives on the bottom edge of the page.
//
// Rig: the canonical art cut into aligned layers (public/mascot/*.webp) — body (with speaker), gem, arms, feet.
// Every pose only moves / rotates / squashes those same layers, so the character never changes. The speaker
// and gem express state through light overlays (mascot.css). Everything runs locally; no network, no sound.
//
// Behavior, in short:
//   • idle: occasional small actions with real pauses in between
//   • cursor: notices and leans toward it, sometimes a pulse or a step; quick passes may get a hop or a short
//     run (with cooldowns); it never follows the cursor around
//   • dragging a file: excited, follows the file for a bit, waits beside the upload panel (never touches the
//     drag & drop itself: it lets events pass through)
//   • app signals (src/mascot/bus.js): file accepted, working, done, results, error, Ask, Quiz, flashcards, search
//   • click: one of several short reactions; double / triple click, gem click, hover 3 s: small easter eggs
//   • drag it, throw it: light physics, bounces off the edges, lands upright on the bottom edge
//   • reading pages: it peeks from the bottom edge and rises only when something happens
//   • quiet automatically while typing, in dialogs or during a quiz; user setting On / Quiet / Off
//   • reduce motion: stands still, shows state through color only
import './mascot.css';

const PREF_KEY = 'sparkscribe.mascot';
const POS_KEY = 'sparkscribe.mascot.pos';
const TRAVEL_KEY = 'sparkscribe.mascot.travel';
const ASPECT = 1.1245;
const PARTS = ['foot-l', 'foot-r', 'arm-l', 'arm-r', 'body', 'gem'];
const POSE_MS = { hop: 700, bounce: 550, shift: 1400, sway: 2200, tap: 900, wave: 1200, spin: 750, surprised: 800, shake: 600,
  celebrate: 1500, land: 450, bonk: 350, curious: 1600, dizzy: 1100, wobble: 700 };
const LOOPING = new Set(['sad', 'think', 'notice']);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (weighted) => { let r = Math.random() * weighted.reduce((s, [, w]) => s + w, 0); for (const [v, w] of weighted) { r -= w; if (r <= 0) return v; } return weighted[0][0]; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.5c.7 6 2.6 8.6 9.5 10.5-6.9 1.9-8.8 4.5-9.5 10.5-.7-6-2.6-8.6-9.5-10.5C9.4 10.1 11.3 7.5 12 1.5Z" fill="currentColor"/></svg>';

function readPref() { try { return ['on', 'quiet', 'off'].includes(localStorage.getItem(PREF_KEY)) ? localStorage.getItem(PREF_KEY) : 'on'; } catch { return 'on'; } }
function writePref(v) { try { localStorage.setItem(PREF_KEY, v); } catch { /* fine */ } }

let instance = null;

/** @param {{ page: 'home' | 'library' | 'transcript' | 'other' }} opts */
export function mountMascot({ page = 'other' } = {}) {
  if (instance) return instance;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const touch = matchMedia('(hover: none), (pointer: coarse)').matches || innerWidth < 640;
  const readingPage = page === 'transcript';
  let pref = readPref();

  // ---------- DOM ----------
  const el = document.createElement('div');
  el.className = `mascot${touch ? ' m-touch' : ''}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', 'SparkScribe mascot');
  const img = (n, cls) => `<img class="${cls}" src="/mascot/${n}.webp" alt="" draggable="false" decoding="async" />`;
  el.innerHTML = `<div class="m-shadow"></div>
    <div class="m-rig"><div class="m-lean"><div class="m-pose">
      ${img('foot-l', 'm-foot l')}${img('foot-r', 'm-foot r')}
      <div class="m-upper">
        ${img('arm-l', 'm-arm l')}${img('arm-r', 'm-arm r')}
        ${img('body', 'm-body')}
        <div class="m-speaker"><i class="m-glow"></i><i class="m-spin"></i><i class="m-ring"></i></div>
        ${img('gem', 'm-gem')}<div class="m-gemglow"></div>
      </div>
    </div></div></div>
    <div class="m-fx"></div>`;
  document.body.appendChild(el);
  const rig = el.querySelector('.m-rig');
  const pose = el.querySelector('.m-pose');
  const fxLayer = el.querySelector('.m-fx');

  // ---------- size & position ----------
  let H = 100, W = 112;
  function size() {
    H = touch ? 60 : Math.round(clamp(innerHeight * 0.13, 84, 118));
    W = H * ASPECT;
    el.style.setProperty('--mh', `${H}px`);
  }
  size();
  const floorY = () => innerHeight - H - (touch ? 8 : 10);
  const peekY = () => innerHeight - H * 0.44;
  const clampX = (v) => clamp(v, 6, innerWidth - W - 6);
  const homeX = () => clampX(innerWidth - W - (touch ? 14 : 28));
  let x = homeX(), y = floorY(), rot = 0;
  let peek = false, moved = false;

  function place() {
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    const air = Math.max(0, (peek ? peekY() : floorY()) - y);
    el.style.setProperty('--air', `${air.toFixed(1)}px`);
    el.style.setProperty('--airk', (air / 300).toFixed(3));
  }
  function glideY(target, ms = 500) {
    el.style.transition = `transform ${ms}ms cubic-bezier(.2,.8,.2,1)`;
    y = target; place();
    clearTimeout(glideY.t);
    glideY.t = setTimeout(() => { el.style.transition = ''; }, ms + 30);
  }
  function setPeek(on) {
    if (on === peek || held || air) return;
    peek = on;
    glideY(on ? peekY() : floorY(), on ? 650 : 420);
  }

  // restore this session's position
  try {
    const saved = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null');
    if (saved?.moved) { x = clampX(saved.xf * innerWidth); moved = true; }
  } catch { /* fine */ }
  if (readingPage && !touch) { peek = true; y = peekY(); }
  place();

  // ---------- state ----------
  let mood = 'idle';            // idle | excited | working | celebrating | sad | thinking
  let held = false, air = false, walk = null;
  let vx = 0, vy = 0, spin = 0, launch = 0;
  const cool = { small: 0, big: 0, search: 0 };
  let lastPose = '', poseToken = 0;
  const quiet = () => pref === 'quiet';
  const motionOK = () => !reduced.matches;
  const live = () => pref !== 'off' && !document.hidden;

  function busy() {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return true;
    if (document.querySelector('dialog[open]')) return true;
    const q = document.querySelector('.quiz');
    if (q) { const r = q.getBoundingClientRect(); if (r.bottom > 0 && r.top < innerHeight) return true; }
    return false;
  }

  // ---------- poses, speaker, gem, effects ----------
  function play(name, { force = false } = {}) {
    if (!motionOK() && !force) return;
    if (!motionOK()) return;
    const token = ++poseToken;
    pose.className = 'm-pose';
    void pose.offsetWidth;
    pose.classList.add(`a-${name}`);
    lastPose = name;
    if (!LOOPING.has(name)) setTimeout(() => { if (token === poseToken) pose.className = 'm-pose'; }, POSE_MS[name] || 800);
  }
  function stopPose() { poseToken++; pose.className = 'm-pose'; }
  let speakerBase = '';
  function setSpeaker(state, ms = 0) {
    el.dataset.speaker = state || speakerBase;
    clearTimeout(setSpeaker.t);
    if (ms) setSpeaker.t = setTimeout(() => { el.dataset.speaker = speakerBase; }, ms);
  }
  function baseSpeaker(state) { speakerBase = state; el.dataset.speaker = state; }
  let gemBase = '';
  function setGem(state, ms = 0) {
    el.dataset.gem = state || gemBase;
    clearTimeout(setGem.t);
    if (ms) setGem.t = setTimeout(() => { el.dataset.gem = gemBase; }, ms);
  }
  function baseGem(state) { gemBase = state; el.dataset.gem = state; }
  function fx(type) {
    if (!motionOK() || pref === 'off') return;
    const add = (html, ms) => { const d = document.createElement('div'); d.innerHTML = html; const n = d.firstElementChild; fxLayer.appendChild(n); setTimeout(() => n.remove(), ms); return n; };
    if (type === 'rings') ['', 'v', 'p'].forEach((c, i) => setTimeout(() => add(`<span class="fx-ring ${c}"></span>`, 1000), i * 150));
    else if (type === 'ring') add('<span class="fx-ring"></span>', 1000);
    else if (type === 'sparkles') {
      const colors = ['#22d3ee', '#a78bfa', '#f472b6', '#60a5fa', '#e0f2fe'];
      for (let i = 0; i < 7; i++) {
        const n = add(`<span class="fx-star" style="color:${colors[i % colors.length]}">${STAR}</span>`, 1100);
        n.style.setProperty('--dx', `${rand(-70, 70).toFixed(0)}px`);
        n.style.setProperty('--dy', `${rand(-80, -20).toFixed(0)}px`);
        n.style.animationDelay = `${i * 40}ms`;
      }
    } else if (type === 'question') add('<span class="fx-q">?</span>', 1700);
    else if (type === 'dizzy') add(`<span class="fx-dizzy"><i style="color:#22d3ee">${STAR}</i><i style="color:#f472b6">${STAR}</i><i style="color:#a78bfa">${STAR}</i></span>`, 1200);
    else if (type === 'wave') add('<span class="fx-wave"></span>', 1300);
  }

  // ---------- lean (looking toward something) ----------
  let leanNow = 0;
  function setLean(k) {           // k in -1..1
    if (!motionOK()) k = 0;
    if (Math.abs(k - leanNow) < 0.04) return;
    leanNow = k;
    el.style.setProperty('--lean', `${(k * 7).toFixed(2)}deg`);
    el.style.setProperty('--look', `${(k * 5).toFixed(1)}%`);
  }
  function leanToward(px) { const cx = x + W / 2; setLean(clamp((px - cx) / 180, -1, 1)); }

  // ---------- frame loop (runs only while something moves) ----------
  let raf = 0, lastT = 0;
  function wake() { if (!raf && live()) { lastT = performance.now(); raf = requestAnimationFrame(frame); } }
  function frame(t) {
    raf = 0;
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    let again = false;
    if (held) {
      rot *= 1 - Math.min(1, dt * 6);
      rig.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      again = Math.abs(rot) > 0.3;
    } else if (air) {
      again = physics(dt);
    } else if (walk) {
      again = stepWalk(dt);
    }
    if (again) raf = requestAnimationFrame(frame);
  }

  // walking / running along the bottom edge
  function walkTo(tx, { run = false, onArrive = null } = {}) {
    tx = clampX(tx);
    if (!motionOK() || touch) { x = tx; place(); onArrive?.(); return; }
    if (peek) setPeek(false);
    walk = { tx, speed: run ? 430 : 150, onArrive };
    el.classList.add('m-walking');
    el.classList.toggle('m-running', run);
    setLean(Math.sign(tx - x) * (run ? 1.2 : 0.7));
    wake();
  }
  function stepWalk(dt) {
    const dx = walk.tx - x;
    const dist = Math.abs(dx);
    const v = Math.min(walk.speed, dist * 4 + 24);
    if (dist < 1.2) {
      x = walk.tx; place();
      const done = walk.onArrive;
      walk = null;
      el.classList.remove('m-walking', 'm-running');
      setLean(0);
      done?.();
      return false;
    }
    x += Math.sign(dx) * Math.min(dist, v * dt);
    place();
    return true;
  }

  // throw physics: gravity, drag, bouncing off the edges, landing upright on the bottom edge
  function physics(dt) {
    vy += 2600 * dt;
    vx *= 1 - 0.85 * dt;
    x += vx * dt; y += vy * dt;
    rot += spin * dt; spin *= 1 - 1.4 * dt;
    const minX = 6, maxX = innerWidth - W - 6, minY = 6, floor = floorY();
    if (x < minX) { x = minX; vx = -vx * 0.55; bonk(); }
    if (x > maxX) { x = maxX; vx = -vx * 0.55; bonk(); }
    if (y < minY) { y = minY; vy = Math.abs(vy) * 0.4; }
    if (y >= floor) {
      y = floor;
      if (vy > 260) { vy = -vy * 0.33; vx *= 0.7; spin *= 0.5; play('land'); }
      else {
        vy = 0; air = false;
        el.classList.remove('m-airborne');
        rig.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1)'; rot = 0; rig.style.transform = '';
        setTimeout(() => { rig.style.transition = ''; }, 380);
        play('land'); fx('ring');
        if (launch > 2300) setTimeout(() => { play('dizzy'); fx('dizzy'); }, 450);
        moved = true; save();
        if (Math.abs(vx) > 40) walkTo(x + vx * 0.12);
        afterAction();
        place();
        return false;
      }
    }
    rig.style.transform = `rotate(${rot.toFixed(1)}deg)`;
    place();
    return true;
  }
  let bonkAt = 0;
  function bonk() { const n = performance.now(); if (n - bonkAt > 200) { bonkAt = n; play('bonk'); setSpeaker('bright', 300); } }

  // ---------- idle life ----------
  let idleT = 0;
  function scheduleIdle(ms) { clearTimeout(idleT); if (!live()) return; idleT = setTimeout(idleTick, ms ?? rand(5500, 11000)); }
  function idleTick() {
    if (live() && mood === 'idle' && !held && !air && !walk && !hovering) {
      if (peek || quiet() || busy()) {
        if (Math.random() < 0.35 && !busy()) { setSpeaker('happy', 1400); }
      } else {
        const action = pick([['still', 30], ['pulse', 14], ['shift', 12], ['bounce', 10], ['sway', 10], ['tap', 10], ['wave', 6], ['stroll', page === 'library' ? 12 : (page === 'home' && !touch ? 4 : 0)]]);
        if (action === 'pulse') { setSpeaker('happy', 1600); fx('ring'); }
        else if (action === 'wave') { fx('wave'); setSpeaker('listening', 1300); }
        else if (action === 'stroll') walkTo(clampX(x + rand(-1, 1) * innerWidth * 0.25), { onArrive: () => { if (Math.random() < 0.5) play('bounce'); } });
        else if (action !== 'still') play(action);
      }
    }
    scheduleIdle();
  }
  function afterAction(sinkMs = 6000) {
    if (!readingNow() || touch) return;
    clearTimeout(afterAction.t);
    afterAction.t = setTimeout(() => { if (mood === 'idle' && !hovering && !held && !air && !walk) setPeek(true); }, sinkMs);
  }
  let readingMode = readingPage;
  const readingNow = () => readingMode;

  // ---------- cursor awareness ----------
  let hovering = false, hoverT = 0, nearSince = 0, lastMove = null;
  function onPointerMove(e) {
    if (e.pointerType !== 'mouse' || touch || !live() || held || air || dragging) return;
    const now = performance.now();
    const speed = lastMove ? Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / Math.max(1, now - lastMove.t) : 0;
    lastMove = { x: e.clientX, y: e.clientY, t: now };
    if (mood !== 'idle' || walk) return;
    const cx = x + W / 2, cy = y + H * 0.55;
    const dx = e.clientX - cx, d = Math.hypot(dx, e.clientY - cy);
    if (busy() || quiet()) { setLean(0); return; }
    if (d < 380) leanToward(e.clientX); else setLean(0);
    if (peek) return;
    // lingering close by: sometimes curious, sometimes a step closer, often nothing
    if (d < 170) {
      if (!nearSince) nearSince = now;
      else if (now - nearSince > 750 && now > cool.small) {
        cool.small = now + 5200; nearSince = Infinity;
        const r = pick([['nothing', 40], ['curious', 32], ['step', page === 'home' ? 28 : 0]]);
        if (r === 'curious') { setSpeaker('curious', 1700); fx('wave'); }
        else if (r === 'step') walkTo(x + Math.sign(dx) * rand(26, 50));
      }
    } else nearSince = 0;
    // something flew past: a quick reaction now and then
    if (speed > 1.7 && d < 240 && now > cool.big) {
      cool.big = now + 8500;
      const r = pick([['turn', 30], ['hop', 25], ['pulse', 20], ['run', page === 'home' ? 25 : 0]]);
      if (r === 'turn') { setLean(Math.sign(dx) * 1.3); play('shift'); }
      else if (r === 'hop') play('hop');
      else if (r === 'pulse') { setSpeaker('excited', 700); fx('ring'); }
      else walkTo(x + Math.sign(e.clientX - lastMove.x || dx) * rand(55, 95), { run: true, onArrive: () => play('bounce') });
    }
  }
  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || held || !live()) return;
    hovering = true;
    if (peek) setPeek(false);
    if (mood === 'idle' && !walk && !air) { play('notice'); setSpeaker('bright'); }
    clearTimeout(hoverT);
    hoverT = setTimeout(() => { if (hovering && mood === 'idle' && !held) { play('curious'); fx('question'); setSpeaker('curious', 1600); } }, 3000);
  });
  el.addEventListener('pointerleave', () => {
    hovering = false; clearTimeout(hoverT);
    if (!held && pose.classList.contains('a-notice')) stopPose();
    if (el.dataset.speaker === 'bright') setSpeaker('');
    afterAction(3500);
  });

  // ---------- click, drag, throw ----------
  let down = null, clicks = 0, clickT = 0, lastReaction = '';
  el.addEventListener('pointerdown', (e) => {
    if (!live() || e.button !== 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    down = { id: e.pointerId, sx: e.clientX, sy: e.clientY, t: performance.now(), ox: e.clientX - x, oy: e.clientY - y,
      gem: (e.clientY - r.top) / r.height < 0.27, samples: [], turn: 0, lastAng: null, moved: false };
    if (!touch && e.pointerType === 'mouse') el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!down || down.id !== e.pointerId || touch || e.pointerType !== 'mouse') return;
    const dist = Math.hypot(e.clientX - down.sx, e.clientY - down.sy);
    if (!down.moved && dist < 6) return;
    if (!down.moved) {
      down.moved = true; held = true; walk = null; air = false; peek = false;
      el.classList.remove('m-walking', 'm-running', 'm-airborne');
      el.classList.add('m-held');
      stopPose(); setSpeaker('excited'); setLean(0);
    }
    const now = performance.now();
    const prev = down.samples.at(-1);
    down.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (down.samples.length > 2 && now - down.samples[0].t > 110) down.samples.shift();
    // tilt with the drag direction
    if (prev) {
      const vxi = (e.clientX - prev.x) / Math.max(1, now - prev.t);
      rot = clamp(rot * 0.7 + vxi * 9, -24, 24);
      // dragging in circles makes it dizzy
      const mx = e.clientX - prev.x, my = e.clientY - prev.y;
      if (Math.hypot(mx, my) > 3) {
        const ang = Math.atan2(my, mx);
        if (down.lastAng != null) { let da = ang - down.lastAng; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; down.turn += da; }
        down.lastAng = ang;
      }
    }
    x = clamp(e.clientX - down.ox, -W * 0.3, innerWidth - W * 0.7);
    y = clamp(e.clientY - down.oy, -H * 0.2, innerHeight - H * 0.7);
    place();
    rig.style.transform = `rotate(${rot.toFixed(1)}deg)`;
  });
  function release(e, cancelled) {
    if (!down || (e && down.id !== e.pointerId)) return;
    const d = down; down = null;
    if (!d.moved) { if (!cancelled) onClick(d.gem); return; }
    held = false;
    el.classList.remove('m-held');
    setSpeaker('');
    const s = d.samples, a = s[0], b = s.at(-1);
    const dt = a && b ? Math.max(16, b.t - a.t) : 16;
    vx = a && b ? clamp((b.x - a.x) / dt * 1000, -3200, 3200) : 0;
    vy = a && b ? clamp((b.y - a.y) / dt * 1000, -3200, 3200) : 0;
    launch = Math.hypot(vx, vy);
    if (!motionOK()) { vx = vy = 0; x = clampX(x); y = floorY(); rot = 0; rig.style.transform = ''; place(); moved = true; save(); return; }
    spin = vx * 0.35;
    air = true;
    el.classList.add('m-airborne');
    if (Math.abs(d.turn) > Math.PI * 3.2) setTimeout(() => { play('dizzy'); fx('dizzy'); }, 500);
    wake();
  }
  el.addEventListener('pointerup', (e) => release(e, false));
  el.addEventListener('pointercancel', (e) => release(e, true));
  el.addEventListener('dragstart', (e) => e.preventDefault());

  function onClick(onGem) {
    if (pref === 'off') return;
    if (peek) setPeek(false);
    clicks++;
    clearTimeout(clickT);
    clickT = setTimeout(() => {
      const n = clicks; clicks = 0;
      if (!motionOK() || quiet()) { setSpeaker('happy', 900); return; }
      if (n >= 3) { setSpeaker('success', 1300); setGem('success', 1300); fx('rings'); fx('sparkles'); play('bounce'); }
      else if (n === 2) { play('spin'); setSpeaker('happy', 800); }
      else if (onGem) { setGem('flash', 700); setSpeaker('bright', 500); setTimeout(() => fx('ring'), 180); play('bounce'); }
      else react();
      afterAction();
    }, 260);
  }
  function react() {
    const options = [['hop', 24], ['pulse', 20], ['wave', 18], ['spin', 10], ['surprised', 10], ['shake', 12], ['celebrate', 6]].filter(([v]) => v !== lastReaction);
    const r = pick(options);
    lastReaction = r;
    if (r === 'pulse') { setSpeaker('happy', 1200); fx('rings'); play('bounce'); }
    else if (r === 'celebrate') { play('celebrate'); fx('sparkles'); fx('rings'); setGem('success', 1300); setSpeaker('success', 1400); }
    else { play(r); if (r === 'hop' || r === 'wave') setSpeaker('happy', 900); if (r === 'surprised') setSpeaker('bright', 600); }
  }

  // ---------- dragging a file across the page ----------
  let dragging = false, dragFollowAt = 0, dragEndT = 0;
  const dropzone = () => document.getElementById('dropzone');
  function fileDragAllowed() {
    const dz = dropzone();
    return page === 'home' && live() && !quiet() && !touch && dz && dz.offsetParent !== null && mood !== 'working';
  }
  function onDragMove(e) {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files') || !fileDragAllowed()) return;
    clearTimeout(dragEndT);
    const now = performance.now();
    if (!dragging) {
      dragging = true; mood = 'excited';
      el.classList.add('m-passthrough', 'm-excited');
      if (peek) setPeek(false);
      setSpeaker('excited'); setGem('excited');
      play('hop'); fx('sparkles');
    }
    if (now - dragFollowAt < 220) return;
    dragFollowAt = now;
    const r = dropzone().getBoundingClientRect();
    const over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    // the nearer the file gets to the upload panel, the more excited
    const near = clamp(1 - Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / 700, 0, 1);
    el.style.setProperty('--ex', near.toFixed(2));
    leanToward(e.clientX);
    if (over) {
      const tx = r.left - W * 0.85 > 8 ? r.left - W * 0.85 : r.right - W * 0.2;
      if (!walk || Math.abs(walk.tx - clampX(tx)) > 4) walkTo(tx, { run: true, onArrive: () => { if (dragging) { play('hop'); fx('ring'); } } });
    } else {
      // follow the file for a short distance, never across the whole page in one go
      const target = clampX(e.clientX - W / 2 + (e.clientX > x + W / 2 ? -W * 0.8 : W * 0.8));
      const tx = x + clamp(target - x, -220, 220);
      if (Math.abs(tx - x) > 30) walkTo(tx, { run: true });
    }
  }
  function endDrag(delay = 120) {
    if (!dragging) return;
    clearTimeout(dragEndT);
    dragEndT = setTimeout(() => {
      dragging = false;
      el.classList.remove('m-passthrough', 'm-excited');
      if (mood === 'excited') { mood = 'idle'; setSpeaker(''); setGem(''); }
    }, delay);
  }
  window.addEventListener('dragenter', onDragMove);
  window.addEventListener('dragover', onDragMove);
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) endDrag(250); });
  window.addEventListener('drop', () => endDrag(400));
  window.addEventListener('dragend', () => endDrag(0));

  // ---------- app signals ----------
  let workT = 0, sadT = 0;
  function rise() { if (peek) setPeek(false); clearTimeout(afterAction.t); }
  function toIdle() {
    mood = 'idle'; stopPose(); clearTimeout(workT); clearTimeout(sadT);
    el.classList.remove('m-working', 'm-excited');
    baseSpeaker(''); baseGem('');
    setLean(0);
  }
  function workingLoop() {
    clearTimeout(workT);
    if (mood !== 'working') return;
    const panel = document.getElementById('progressPanel');
    const act = pick([['tap', 30], ['listen', 30], ['look', 25], ['bounce', 15]]);
    if (act === 'listen') { setSpeaker('listening', 1800); fx('wave'); }
    else if (act === 'look' && panel) { const r = panel.getBoundingClientRect(); leanToward(r.left + r.width / 2); setTimeout(() => setLean(0), 1600); }
    else play(act);
    workT = setTimeout(workingLoop, rand(2800, 5200));
  }
  const signals = {
    'file-accepted': () => {
      endDrag(0); rise(); mood = 'excited';
      play('hop'); fx('rings'); setSpeaker('happy', 1100); setGem('flash', 700);
    },
    working: () => {
      toIdle(); mood = 'working';
      el.classList.add('m-working');
      baseSpeaker('processing'); baseGem('thinking');
      const panel = document.getElementById('progressPanel');
      if (panel && !quiet()) { const r = panel.getBoundingClientRect(); walkTo(Math.min(r.right + 12, innerWidth - W - 16), { onArrive: () => { if (mood === 'working') { const rr = panel.getBoundingClientRect(); leanToward(rr.left + rr.width / 2); } } }); }
      workT = setTimeout(workingLoop, 2200);
    },
    'transcribe-done': () => {
      toIdle(); rise(); mood = 'celebrating';
      if (quiet()) { setSpeaker('success', 1400); setGem('success', 1400); }
      else { play('celebrate'); fx('rings'); setTimeout(() => fx('sparkles'), 300); setSpeaker('success', 1500); setGem('success', 1400); }
      setTimeout(() => { if (mood === 'celebrating') mood = 'idle'; }, 1600);
    },
    'results-shown': () => {
      // the same mascot "follows" into the transcript: it runs in from the left
      readingMode = true;
      runIn(() => afterAction(7000));
    },
    reset: () => { readingMode = readingPage; toIdle(); if (!moved) walkTo(homeX()); },
    error: () => {
      toIdle(); rise(); mood = 'sad';
      baseSpeaker('error'); baseGem('dim');
      play('sad'); fx('question'); leanToward(innerWidth / 2);
      sadT = setTimeout(() => { if (mood === 'sad') { toIdle(); play('bounce'); } }, 9000);
    },
    'ask-start': () => { if (mood !== 'idle') return; rise(); mood = 'thinking'; baseSpeaker('listening'); baseGem('thinking'); if (!quiet()) play('think'); },
    'ask-done': () => {
      if (mood === 'thinking') toIdle();
      setSpeaker('success', 900); if (!quiet()) fx('ring');
      afterAction(4000);
    },
    'ask-error': () => { if (mood === 'thinking') toIdle(); setSpeaker('error', 1600); if (!quiet()) play('wobble'); afterAction(4000); },
    'quiz-correct': () => { setSpeaker('happy', 900); if (!quiet()) { fx('ring'); play('bounce'); } },
    'quiz-wrong': () => { setSpeaker('curious', 900); if (!quiet()) play('wobble'); },
    'quiz-done': ({ score = 0, total = 1 }) => {
      rise();
      const k = total ? score / total : 0;
      if (quiet()) { setSpeaker(k >= 0.5 ? 'success' : 'happy', 1200); return; }
      if (k >= 0.8) { play('celebrate'); fx('sparkles'); fx('rings'); setSpeaker('success', 1500); setGem('success', 1400); }
      else if (k >= 0.5) { play('hop'); fx('rings'); setSpeaker('happy', 1200); }
      else { play('bounce'); setSpeaker('happy', 1200); }
      afterAction(5000);
    },
    'flashcard-flip': () => { if (!quiet() && Math.random() < 0.15) play('spin'); },
    'search-found': () => {
      const now = performance.now();
      if (now < cool.search || quiet()) return;
      cool.search = now + 12000;
      setLean(-1); play('wave'); setSpeaker('happy', 1000);
      setTimeout(() => setLean(0), 1400);
    },
    'cta-hover': ({ x: px }) => {
      if (mood !== 'idle' || quiet() || px == null) return;
      if (Math.abs(px - (x + W / 2)) < 420) { leanToward(px); setSpeaker('happy', 800); setTimeout(() => setLean(0), 1100); }
    },
  };
  window.addEventListener('sparkscribe:mascot', (e) => {
    if (pref === 'off') return;
    const { type, ...detail } = e.detail || {};
    try { signals[type]?.(detail); } catch { /* the mascot never breaks the app */ }
  });

  function runIn(done) {
    const target = moved ? x : homeX();
    if (!motionOK() || touch) { x = target; y = floorY(); peek = false; place(); done?.(); return; }
    peek = false; y = floorY(); x = -W - 20; place();
    walkTo(target, { run: true, onArrive: () => { play('land'); setSpeaker('happy', 900); done?.(); } });
  }

  // ---------- persistence, visibility, resize ----------
  function save() { try { sessionStorage.setItem(POS_KEY, JSON.stringify({ xf: (walk ? walk.tx : clampX(x)) / innerWidth, moved })); } catch { /* fine */ } }
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; clearTimeout(idleT); }
    else { if (air || walk) wake(); scheduleIdle(); }
  });
  addEventListener('blur', () => clearTimeout(idleT));
  addEventListener('focus', () => scheduleIdle());
  addEventListener('resize', () => { size(); x = clampX(x); if (!air && !held) { y = peek ? peekY() : floorY(); } place(); }, { passive: true });
  if (!touch) addEventListener('pointermove', onPointerMove, { passive: true });

  // ---------- On / Quiet / Off ----------
  function applyPref() {
    el.classList.toggle('m-off', pref === 'off');
    document.querySelectorAll('.mascot-toggle').forEach((b) => { b.textContent = `Mascot: ${pref[0].toUpperCase()}${pref.slice(1)}`; });
    if (pref === 'off') { clearTimeout(idleT); walk = null; }
    else scheduleIdle(2500);
    if (pref === 'quiet') { setLean(0); }
  }
  function cycle() { pref = pref === 'on' ? 'quiet' : pref === 'quiet' ? 'off' : 'on'; writePref(pref); applyPref(); if (pref === 'on') { play('hop'); setSpeaker('happy', 900); } }
  function mountToggle(container) {
    if (!container || container.querySelector('.mascot-toggle')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mascot-toggle';
    b.title = 'On: lively · Quiet: stays put, no big reactions · Off: hidden';
    b.addEventListener('click', cycle);
    container.appendChild(b);
    applyPref();
  }
  mountToggle(document.querySelector('.foot'));
  addEventListener('storage', (e) => { if (e.key === PREF_KEY) { pref = readPref(); applyPref(); } });
  addEventListener('sparkscribe:mascot-cycle', cycle);   // from the account menu

  // ---------- start ----------
  let travelled = false;
  try {
    const t = Number(sessionStorage.getItem(TRAVEL_KEY) || 0);
    sessionStorage.removeItem(TRAVEL_KEY);
    travelled = t && Date.now() - t < 12000;
  } catch { /* fine */ }
  applyPref();
  if (travelled && pref !== 'off') runIn(() => afterAction(5000));
  else if (pref !== 'off' && motionOK() && !peek) setTimeout(() => { play('bounce'); setSpeaker('happy', 900); }, 500);
  scheduleIdle(6000);

  instance = {
    cycle, mountToggle, get pref() { return pref; },
    signal: (type, detail) => signals[type]?.(detail || {}),
  };
  if (import.meta.env?.DEV) window.__mascot = { ...instance, debug: () => ({ mood, pref, touch, peek, held, air, walk: !!walk, dragging, x, y, live: live(), allowed: fileDragAllowed() }) };
  return instance;
}
