// Mascot animation: poses, procedural cycles (idle, walk/run, climb, hang, sit, ...), keyframed clips
// (hop, wave, get-up, celebrate, ...) and an animator that blends between them.
//
// A pose is a flat set of channels (radians / body units, body radius = 1):
//   sx sy sr     whole character: screen offset and screen roll (jumps, get-up)
//   bx by bz     body offset in the facing frame (bob, shifts)
//   sq           squash (+) / stretch (−), kept subtle: the mascot is solid crystal
//   pitch roll twist    body lean forward, side tilt, turn about its own vertical axis
//   aLx aLy aLz / aRx aRy aRz   shoulders (z: raise out to the side, x: swing forward(−) / back(+))
//   lLx lLz / lRx lRz           hips (x: swing forward(−) / back(+), z: out to the side)
//   fLy fRy fLp fRp             foot lift and toe pitch
//   gemT         gem tilt
//   eyeX eyeY eyeW   an authored look direction for the speaker, and how much it overrides tracking
// L is the mascot's own left (screen right while it faces you).

export const CH = ['sx', 'sy', 'sr', 'bx', 'by', 'bz', 'sq', 'pitch', 'roll', 'twist',
  'aLx', 'aLy', 'aLz', 'aRx', 'aRy', 'aRz', 'lLx', 'lLz', 'lRx', 'lRz', 'fLy', 'fRy', 'fLp', 'fRp', 'gemT', 'eyeX', 'eyeY', 'eyeW'];
export const K = Object.fromEntries(CH.map((c, i) => [c, i]));
const NCH = CH.length;
export const ARM = 1.42;

// key measurements of the model (body radius = 1), shared by the model, the motion and the physics
export const FOOT_Y = -0.27;     // foot center below the hip joint
export const DIM = {
  foot: 1.19,        // body center → bottom of the feet (standing support height)
  top: 1.7,          // body center → tip of the gem
  shoulder: [0.88, -0.02, 0.04],
  hip: [0.45, -0.7, 0.02],
  armRest: ARM,      // arms rest held out to the sides (rotation about z)
};
// distance from the body center down to the floor when the character is rolled by `theta` in the screen
// plane (its silhouette: body, feet, gem; arms move out of the way when it lies down)
const HULL = [];
for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; HULL.push([1.02 * Math.cos(a), 0.93 * Math.sin(a)]); }
for (const s of [-1, 1]) HULL.push([s * 0.95, -1.08], [s * 0.62, -1.19], [s * 0.3, -1.17], [s * 0.95, -0.9], [s * 0.41, 1.3], [s * 0.19, 0.95]);
HULL.push([0, 1.7]);
export function support(theta) {
  const s = Math.sin(theta), c = Math.cos(theta);
  let m = 0;
  for (const [x, y] of HULL) { const d = -(x * s + y * c); if (d > m) m = d; }
  return m;
}
const PI = Math.PI, TAU = PI * 2;

export const REST = new Float32Array(NCH);
REST[K.aLz] = ARM; REST[K.aRz] = -ARM;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const ss = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const lerp = (a, b, t) => a + (b - a) * t;

export function pose(fields = {}) {
  const p = REST.slice();
  for (const k in fields) p[K[k]] = fields[k];
  return p;
}
// left ↔ right
const SWAP = [['aLx', 'aRx', 1], ['aLy', 'aRy', -1], ['aLz', 'aRz', -1], ['lLx', 'lRx', 1], ['lLz', 'lRz', -1], ['fLy', 'fRy', 1], ['fLp', 'fRp', 1]];
const NEG = ['sx', 'sr', 'bx', 'roll', 'twist', 'eyeX', 'gemT'];
export function mirror(p) {
  const o = p.slice();
  for (const [a, b, s] of SWAP) { o[K[a]] = p[K[b]] * s; o[K[b]] = p[K[a]] * s; }
  for (const n of NEG) o[K[n]] = -p[K[n]];
  return o;
}
export function lerpPose(a, b, t, out) { for (let i = 0; i < NCH; i++) out[i] = a[i] + (b[i] - a[i]) * t; return out; }

// ---------- clips: keyframes interpolated with smooth (monotone Hermite) curves ----------
function clip(keys, opts = {}) {
  const ks = keys.map(([t, f]) => ({ t, p: f instanceof Float32Array ? f : pose(f) }));
  return { keys: ks, dur: ks.at(-1).t, ...opts };
}
function tangent(ks, i, j) {
  if (i === 0 || i === ks.length - 1) return 0;
  const a = ks[i - 1], b = ks[i], c = ks[i + 1];
  const d0 = b.p[j] - a.p[j], d1 = c.p[j] - b.p[j];
  if (d0 * d1 <= 0) return 0;                       // hold extremes: no overshoot past a key
  return (c.p[j] - a.p[j]) / (c.t - a.t);
}
export function sampleClip(c, t, out) {
  const ks = c.keys, n = ks.length;
  if (t <= ks[0].t) { out.set(ks[0].p); return out; }
  if (t >= ks[n - 1].t) { out.set(ks[n - 1].p); return out; }
  let i = 0; while (i < n - 2 && ks[i + 1].t <= t) i++;
  const A = ks[i], B = ks[i + 1], h = B.t - A.t, u = (t - A.t) / h, u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  for (let j = 0; j < NCH; j++) out[j] = h00 * A.p[j] + h10 * h * tangent(ks, i, j) + h01 * B.p[j] + h11 * h * tangent(ks, i + 1, j);
  return out;
}

// fallen on its side. side +1: lying toward screen-left (roll +90°), its right arm is the one on the floor;
// that arm lies stretched past its head, the other rests on its front
const FALLEN = { aRz: -2.75, aRx: -0.15, aLz: 0.85, aLx: -0.45, lLz: 0.12, lRz: -0.05, lLx: -0.15 };
const fallenPose = pose(FALLEN);

const sideClip = (build) => { const c = build(); const m = { keys: c.keys.map((k) => ({ t: k.t, p: mirror(k.p) })), dur: c.dur, snapEnd: c.snapEnd }; return (s) => (s < 0 ? m : c); };

export const CLIPS = {
  hop: clip([[0, {}], [0.12, { sq: 0.12, by: -0.05, aLz: 1.15, aRz: -1.15 }],
    [0.3, { sy: 0.55, sq: -0.08, aLz: 2.0, aRz: -2.0, lLx: 0.2, lRx: 0.2, fLp: 0.3, fRp: 0.3 }],
    [0.42, { sy: 0.6, sq: -0.03, aLz: 2.1, aRz: -2.1, lLx: 0.1, lRx: 0.1 }],
    [0.58, { sy: 0, sq: 0.13, by: -0.05, aLz: 1.2, aRz: -1.2 }], [0.74, { sq: -0.03 }], [0.92, {}]]),
  wave: clip([[0, {}], [0.22, { aLz: 2.75, aLx: -0.25, roll: -0.06, eyeX: 0.2, eyeW: 0.3 }],
    [0.4, { aLz: 2.3, aLy: 0.35, roll: -0.05 }], [0.58, { aLz: 2.8, aLy: -0.25, roll: -0.06 }],
    [0.76, { aLz: 2.3, aLy: 0.35, roll: -0.05 }], [0.94, { aLz: 2.75, aLy: -0.2, roll: -0.06 }], [1.2, {}]]),
  stepBack: clip([[0, {}], [0.1, { sq: -0.06, pitch: -0.22, bz: -0.04, aLz: 2.15, aRz: -2.15, aLx: -0.6, aRx: -0.6 }],
    [0.26, { bz: -0.16, pitch: -0.18, lLx: 0.45, fLy: 0.12, aLz: 2.0, aRz: -2.0, aLx: -0.4, aRx: -0.4 }],
    [0.42, { bz: -0.22, pitch: -0.08, lRx: 0.35, fRy: 0.1, aLz: 1.8, aRz: -1.8 }],
    [0.62, { bz: -0.22, sq: 0.04 }], [0.95, { bz: -0.14, lLx: -0.3, fLy: 0.1 }], [1.15, { bz: -0.04, lRx: -0.25, fRy: 0.08 }], [1.35, {}]]),
  shake: clip([[0, {}], [0.1, { twist: 0.38, roll: 0.04, aLx: 0.2, aRx: -0.2 }], [0.23, { twist: -0.38, roll: -0.04, aLx: -0.2, aRx: 0.2 }],
    [0.36, { twist: 0.3, aLx: 0.15, aRx: -0.15 }], [0.49, { twist: -0.26 }], [0.62, { twist: 0.12 }], [0.78, {}]]),
  cheer: clip([[0, {}], [0.15, { sq: 0.07, aLz: 1.1, aRz: -1.1 }],
    [0.35, { sy: 0.28, sq: -0.05, aLz: 2.9, aRz: -2.9, aLx: -0.2, aRx: -0.2 }], [0.55, { sy: 0, sq: 0.07, aLz: 2.7, aRz: -2.7 }],
    [0.75, { aLz: 2.95, aRz: -2.95 }], [0.95, { aLz: 2.65, aRz: -2.65 }], [1.3, {}]]),
  dance: clip([[0, {}],
    [0.25, { roll: 0.12, bx: 0.08, aLz: 2.4, aRz: -1.0, fRy: 0.12, lRz: -0.2, twist: 0.18 }], [0.5, { sq: 0.06, aLz: 1.5, aRz: -1.5 }],
    [0.75, { roll: -0.12, bx: -0.08, aLz: 1.0, aRz: -2.4, fLy: 0.12, lLz: 0.2, twist: -0.18 }], [1.0, { sq: 0.06 }],
    [1.25, { roll: 0.12, bx: 0.08, aLz: 2.4, aRz: -1.0, fRy: 0.12, lRz: -0.2, twist: 0.18 }],
    [1.5, { sy: 0.28, sq: -0.05, aLz: 2.65, aRz: -2.65 }], [1.68, { sq: 0.09 }], [1.95, {}]]),
  // a playful spin: the body really turns all the way round (front → side → back → side → front)
  spin: clip([[0, {}], [0.14, { sq: 0.1, aLz: 1.15, aRz: -1.15 }],
    [0.32, { sy: 0.36, sq: -0.05, twist: PI * 0.65, aLz: 2.2, aRz: -2.2 }], [0.5, { sy: 0.42, twist: PI * 1.4, aLz: 2.3, aRz: -2.3 }],
    [0.68, { sy: 0, sq: 0.1, twist: TAU, aLz: 1.6, aRz: -1.6 }], [0.86, { twist: TAU }]], { snapEnd: true }),
  celebrate: clip([[0, {}], [0.16, { sq: 0.14, by: -0.06, aLz: 1.1, aRz: -1.1 }],
    [0.36, { sy: 0.9, sq: -0.1, aLz: 2.9, aRz: -2.9, lLx: 0.25, lRx: 0.25, fLp: 0.35, fRp: 0.35, twist: PI * 0.7 }],
    [0.55, { sy: 1.05, aLz: 2.95, aRz: -2.95, twist: PI * 1.6 }],
    [0.74, { sy: 0.3, twist: TAU, aLz: 2.6, aRz: -2.6 }],
    [0.84, { sy: 0, sq: 0.15, by: -0.05, twist: TAU, aLz: 2.2, aRz: -2.2 }],
    [1.0, { sq: -0.04, twist: TAU, aLz: 2.85, aRz: -2.85 }], [1.25, { twist: TAU, aLz: 2.55, aRz: -2.55 }],
    [1.45, { twist: TAU, aLz: 2.85, aRz: -2.85 }], [1.8, { twist: TAU }]], { snapEnd: true }),
  nod: clip([[0, {}], [0.15, { pitch: 0.17, eyeY: -0.4, eyeW: 0.5 }], [0.32, { pitch: -0.04 }], [0.48, { pitch: 0.12 }], [0.66, {}]]),
  wobble: clip([[0, {}], [0.12, { roll: 0.12, bx: 0.04, aLz: 1.7 }], [0.28, { roll: -0.1, bx: -0.03, aRz: -1.7 }], [0.44, { roll: 0.06 }], [0.6, { roll: -0.03 }], [0.78, {}]]),
  stretch: clip([[0, {}], [0.5, { sq: 0.05, aLz: 1.2, aRz: -1.2 }],
    [1.2, { sy: 0.1, sq: -0.08, aLz: 3.0, aRz: -3.0, aLx: -0.1, aRx: -0.1, fLp: 0.25, fRp: 0.25, eyeY: 0.7, eyeW: 0.8 }],
    [1.9, { sy: 0.12, sq: -0.09, aLz: 3.05, aRz: -3.05, roll: 0.08, eyeY: 0.7, eyeW: 0.8 }],
    [2.4, { sy: 0.1, sq: -0.08, aLz: 3.0, aRz: -3.0, roll: -0.06, eyeW: 0.5 }], [2.9, { sq: 0.04, aLz: 1.3, aRz: -1.3 }], [3.3, {}]]),
  footTap: (() => {
    const hips = { aLz: 0.95, aRz: -0.95, aLx: 0.25, aRx: 0.25, roll: -0.04, eyeY: -0.15, eyeW: 0.3 };
    const k = [[0, {}], [0.3, hips]];
    for (let i = 0; i < 3; i++) { k.push([0.45 + i * 0.3, { ...hips, fRp: -0.45, lRx: -0.12 }]); k.push([0.6 + i * 0.3, { ...hips, fRp: 0 }]); }
    k.push([1.6, {}]);
    return clip(k);
  })(),
  lookAround: clip([[0, {}], [0.4, { eyeX: -0.95, eyeY: 0.1, eyeW: 1, twist: -0.14 }], [1.2, { eyeX: -0.95, eyeY: 0.05, eyeW: 1, twist: -0.16 }],
    [1.65, { eyeX: 0.95, eyeY: 0.2, eyeW: 1, twist: 0.15 }], [2.4, { eyeX: 0.95, eyeY: 0.15, eyeW: 1, twist: 0.13 }],
    [2.8, { eyeX: 0, eyeY: 0.55, eyeW: 1 }], [3.25, { eyeW: 0 }]]),
  land: clip([[0, { sq: 0.18, by: -0.07, aLz: 1.9, aRz: -1.9 }], [0.12, { sq: -0.04, aLz: 1.6, aRz: -1.6 }], [0.26, { sq: 0.03 }], [0.42, {}]]),
  catch: clip([[0, {}], [0.1, { aLz: 2.3, aRz: -2.3, sq: 0.05 }], [0.45, { aLz: 1.8, aRz: -1.8 }], [0.75, {}]]),
  gemTouch: clip([[0, {}], [0.25, { aLz: 2.85, aLx: -0.55, aLy: 0.3, eyeY: 0.9, eyeW: 1 }], [0.45, { aLz: 2.95, aLx: -0.5, eyeY: 0.9, eyeW: 1, gemT: 0.12 }],
    [0.6, { aLz: 2.85, aLx: -0.55, gemT: -0.1, eyeY: 0.9, eyeW: 1 }], [0.75, { aLz: 2.95, gemT: 0.06, eyeY: 0.9, eyeW: 1 }], [1.1, {}]]),
  tilt: clip([[0, {}], [0.3, { roll: 0.15, twist: -0.12, aLz: 1.6 }], [1.3, { roll: 0.16, twist: -0.1, aLz: 1.6 }], [1.7, {}]]),
  armUp: clip([[0, {}], [0.2, { aRz: -2.85, aRx: -0.2, roll: 0.05 }], [0.7, { aRz: -2.75, roll: 0.05 }], [1.0, {}]]),
  pressUp: clip([[0, { by: -0.25, lLx: -1.25, lRx: -1.25, lLz: 0.15, lRz: -0.15, fLp: 0.4, fRp: 0.4, aLz: 0.75, aRz: -0.75, pitch: -0.08 }],
    [0.25, { by: -0.22, lLx: -0.6, lRx: -1.2, aLz: 0.55, aRz: -0.55, aLx: 0.3, aRx: 0.3, pitch: 0.1 }],
    [0.5, { by: -0.1, lLx: 0, lRx: -0.5, fLp: 0, aLz: 0.7, aRz: -0.7, pitch: 0.15, sq: 0.04 }],
    [0.75, { by: 0, lRx: 0, fRp: 0, sq: 0.05 }], [0.95, { sq: -0.02 }], [1.1, {}]]),
  // getting up from lying on its side: look, plant a hand, the other arm helps, pull a foot underneath,
  // push the body up, the second foot comes down, straighten, settle. side +1 = lying toward screen-left.
  getUp: sideClip(() => clip([
    [0, FALLEN],
    [0.5, { ...FALLEN, eyeX: 0.5, eyeY: 0.35, eyeW: 1 }],
    [0.85, { aRz: -1.55, aRx: -0.25, aLz: 0.1, aLx: -1.2, lLz: 0.12, lRz: -0.05, eyeX: 0.2, eyeY: -0.3, eyeW: 0.8 }],
    [1.2, { aRz: -1.45, aRx: -0.25, aLz: 0.05, aLx: -1.25, lRz: -0.75, lRx: -0.35, fRy: 0.08, lLz: 0.15, sr: -0.12, eyeY: -0.4, eyeW: 0.8 }],
    [1.65, { aRz: -1.0, aRx: -0.15, aLz: 0.5, aLx: -0.85, lRz: -0.4, lRx: -0.15, lLz: 0.35, sr: -0.85, sq: 0.03, eyeW: 0.4 }],
    [2.0, { aRz: -1.15, aLz: 1.0, aLx: -0.3, lRz: -0.12, lLz: 0.05, sr: -1.28, sq: 0.05, eyeW: 0.2 }],
    [2.3, { aLz: 1.5, aRz: -1.5, sr: -PI / 2, sq: 0.07, by: -0.03 }],
    [2.45, { sr: -PI / 2, sq: -0.03 }], [2.6, { sr: -PI / 2, sq: 0.015 }], [2.75, { sr: -PI / 2 }],
  ], { snapEnd: true })),
};

// ---------- cycles (procedural loops). Each writes a full pose into `o` (pre-filled with REST). ----------
function idle(t, prm, o) {
  const b = Math.sin(t * 1.5);
  o[K.by] += 0.012 * b; o[K.sq] += 0.01 * b;
  o[K.aLz] += 0.05 * Math.sin(t * 1.1); o[K.aRz] -= 0.05 * Math.sin(t * 1.1 + 0.8);
  o[K.aLx] += 0.04 * Math.sin(t * 0.7); o[K.aRx] += 0.04 * Math.sin(t * 0.7 + 1);
  o[K.gemT] += 0.02 * Math.sin(t * 0.9);
}
// walking ↔ running, driven by the brain: prm.phase (radians, advanced with the distance travelled, so the
// feet never skate), prm.amt (0 standing … 1 full stride), prm.run (0 walk … 1 run)
function gait(t, prm, o) {
  idle(t, prm, o);
  const amt = prm.amt || 0, run = prm.run || 0;
  if (amt <= 0.001) return;
  const s = Math.sin(prm.phase), c = Math.cos(prm.phase), c2 = Math.cos(prm.phase * 2);
  const A = lerp(0.55, 0.95, run) * amt, lift = lerp(0.12, 0.22, run) * amt;
  o[K.lLx] += -A * s; o[K.lRx] += A * s;
  o[K.fLy] += lift * Math.max(0, c); o[K.fRy] += lift * Math.max(0, -c);
  o[K.fLp] += -0.3 * Math.max(0, c) * amt; o[K.fRp] += -0.3 * Math.max(0, -c) * amt;
  o[K.by] += amt * lerp(0.04, 0.09, run) * (0.5 + 0.5 * c2) - amt * 0.02;
  o[K.sq] += amt * run * 0.04 * c2;
  o[K.pitch] += amt * lerp(0.06, 0.26, run);
  o[K.roll] += amt * 0.04 * s * (1 - run * 0.5);
  o[K.twist] += amt * 0.07 * s;
  o[K.aLx] += 0.85 * A * s; o[K.aRx] += -0.85 * A * s;
  o[K.aLz] -= run * amt * 0.45; o[K.aRz] += run * amt * 0.45;
  o[K.gemT] += 0.05 * s * amt;
}
// climbing a wall it faces. prm.phase in cycles: each cycle both arms reach and pull once; the legs push
export function climbRise(phase) {
  const n = Math.floor(phase), f = phase - n;
  return 2 * n + ss((f - 0.2) / 0.3) + ss((f - 0.7) / 0.3);
}
function climbArm(psi) {
  if (psi < 0.2) return lerp(-1.5, -2.55, ss(psi / 0.2));
  if (psi < 0.5) return lerp(-2.55, -1.35, ss((psi - 0.2) / 0.3));
  return lerp(-1.35, -1.5, (psi - 0.5) / 0.5);
}
function climbLeg(psi) {
  if (psi < 0.2) return lerp(0.2, -0.95, ss(psi / 0.2));
  if (psi < 0.5) return lerp(-0.95, 0.25, ss((psi - 0.2) / 0.3));
  return lerp(0.25, 0.2, (psi - 0.5) / 0.5);
}
function climb(t, prm, o) {
  const ph = prm.phase || 0;
  const pl = ((ph % 1) + 1) % 1, pr = (((ph + 0.5) % 1) + 1) % 1;
  o[K.aLz] = 0.32; o[K.aRz] = -0.32;
  o[K.aLx] = climbArm(pl); o[K.aRx] = climbArm(pr);
  o[K.lLx] = climbLeg(pr); o[K.lRx] = climbLeg(pl);
  o[K.fLp] = -0.3; o[K.fRp] = -0.3;
  o[K.pitch] = 0.16; o[K.bz] = 0.05;
  o[K.roll] = 0.05 * Math.sin(ph * TAU);
  o[K.sq] = 0.02 * Math.sin(ph * TAU * 2);
  o[K.eyeY] = 0.6; o[K.eyeW] = 0.6;
}
function hang(t, prm, o) {
  const w = Math.sin(t * 2.2);
  o[K.aLz] = 0.28; o[K.aRz] = -0.28; o[K.aLx] = -2.9; o[K.aRx] = -2.85;
  o[K.lLx] = 0.38 * w; o[K.lRx] = 0.38 * Math.sin(t * 2.2 + 0.6); o[K.lLz] = 0.1; o[K.lRz] = -0.1;
  o[K.fLp] = 0.25; o[K.fRp] = 0.25;
  o[K.pitch] = 0.06 - 0.05 * w; o[K.by] = -0.06; o[K.sq] = -0.03;
  o[K.twist] = prm.twist || 0;
}
function slide(t, prm, o) {
  o[K.aLz] = 0.3; o[K.aRz] = -0.3; o[K.aLx] = -2.75; o[K.aRx] = -2.7;
  o[K.lLx] = -0.3; o[K.lRx] = -0.25; o[K.fLp] = -0.2; o[K.fRp] = -0.2;
  o[K.pitch] = 0.12; o[K.roll] = 0.025 * Math.sin(t * 38); o[K.sq] = -0.03;
}
function sit(t, prm, o) {
  const b = Math.sin(t * 1.1);
  o[K.by] = -0.25 + 0.012 * b; o[K.sq] = 0.012 * b;
  o[K.lLx] = -1.25; o[K.lRx] = -1.25; o[K.lLz] = 0.15; o[K.lRz] = -0.15; o[K.fLp] = 0.4; o[K.fRp] = 0.4;
  o[K.aLz] = 0.75 + 0.03 * b; o[K.aRz] = -0.75 - 0.03 * b; o[K.aLx] = -0.15; o[K.aRx] = -0.15;
  o[K.pitch] = -0.08;
  if (prm.sleepy) { o[K.pitch] = 0.1 + 0.03 * b; o[K.eyeY] = -0.5; o[K.eyeW] = 0.8; }
}
function held(t, prm, o) {
  const f = prm.flail || 0;
  o[K.aLz] = 2.05 + 0.25 * f * Math.sin(t * 11); o[K.aRz] = -2.05 - 0.25 * f * Math.sin(t * 11 + 1.2);
  o[K.aLx] = 0.2 * Math.sin(t * 3); o[K.aRx] = 0.2 * Math.sin(t * 3 + 1);
  o[K.lLx] = 0.25 * Math.sin(t * 3) + 0.4 * f * Math.sin(t * 13); o[K.lRx] = 0.25 * Math.sin(t * 3 + 1.3) - 0.4 * f * Math.sin(t * 13);
  o[K.lLz] = 0.15; o[K.lRz] = -0.15; o[K.fLp] = 0.3; o[K.fRp] = 0.3;
  o[K.sq] = -0.03;
}
function air(t, prm, o) {
  o[K.aLz] = 2.2 + 0.3 * Math.sin(t * 9); o[K.aRz] = -2.2 - 0.3 * Math.sin(t * 9 + 1);
  o[K.aLx] = 0.4 * Math.sin(t * 7); o[K.aRx] = -0.4 * Math.sin(t * 7 + 0.5);
  o[K.lLx] = 0.5 * Math.sin(t * 8); o[K.lRx] = -0.5 * Math.sin(t * 8); o[K.lLz] = 0.2; o[K.lRz] = -0.2;
  o[K.sq] = -0.03;
}
function fallen(t, prm, o) {
  o.set(prm.side < 0 ? fallenMirror : fallenPose);
  o[K.by] += 0.008 * Math.sin(t * 1.3);
}
const fallenMirror = mirror(fallenPose);
function sad(t, prm, o) {
  const b = Math.sin(t * 0.9);
  o[K.pitch] = 0.16 + 0.02 * b; o[K.by] = -0.04; o[K.sq] = 0.03;
  o[K.aLz] = 0.75; o[K.aRz] = -0.75; o[K.aLx] = -0.15; o[K.aRx] = -0.15;
  o[K.eyeY] = -0.6; o[K.eyeX] = 0.15 * Math.sin(t * 0.4); o[K.eyeW] = 0.85;
}
function think(t, prm, o) {
  idle(t, prm, o);
  o[K.aRz] = -0.9; o[K.aRx] = -1.55 + 0.08 * Math.sin(t * 3); o[K.aRy] = 0.4;
  o[K.aLz] = 1.1; o[K.twist] = 0.12; o[K.roll] = -0.06;
  o[K.eyeX] = -0.5; o[K.eyeY] = 0.6; o[K.eyeW] = 0.8;
}
function working(t, prm, o) {
  idle(t, prm, o);
  o[K.by] += 0.018 * Math.sin(t * 4.2); o[K.roll] += 0.025 * Math.sin(t * 2.1);
}
function excited(t, prm, o) {
  const b = Math.abs(Math.sin(t * 6.5));
  o[K.sy] = 0.12 * b; o[K.sq] = -0.04 * b + 0.05 * (1 - b) * (1 - b);
  o[K.aLz] = 1.9 + 0.22 * Math.sin(t * 13); o[K.aRz] = -1.9 - 0.22 * Math.sin(t * 13 + 1);
  o[K.gemT] = 0.04 * Math.sin(t * 6.5);
}
export const CYCLES = { idle, gait, climb, hang, slide, sit, held, air, fallen, sad, think, working, excited };

// ---------- animator: one base cycle + one clip on top, with crossfades ----------
export class Animator {
  constructor() {
    this.out = REST.slice();
    this.A = REST.slice(); this.B = REST.slice(); this.from = null;
    this.base = { name: 'idle', fn: idle, t: 0, prm: {} };
    this.fade = 1; this.fadeDur = 0.3;
    this.clip = null;
  }
  // switch the looping base (crossfades from wherever the character is). prm is kept by reference, so the
  // caller can keep steering it (gait phase, hang twist, ...)
  setBase(name, prm = {}, fadeDur = 0.35) {
    if (this.base.name === name) { if (prm !== this.base.prm) Object.assign(this.base.prm, prm); return; }
    this.from = this.out.slice(); this.fade = 0; this.fadeDur = Math.max(0.01, fadeDur);
    this.base = { name, fn: CYCLES[name], t: 0, prm };
  }
  get baseName() { return this.base.name; }
  // play a clip over the base; onEnd runs in the same frame the clip ends (before that frame's pose is
  // computed), so a clip can hand over to a new state without a single odd frame
  play(c, { fadeIn = 0.12, fadeOut = 0.25, speed = 1, onEnd = null } = {}) {
    if (this.clip && !this.clip.ended) this.clip.resolve(false);
    return new Promise((resolve) => {
      this.clip = { c, t: 0, fadeIn, fadeOut: c.snapEnd ? 0 : fadeOut, speed, resolve, onEnd, ended: false, from: this.out.slice() };
    });
  }
  // let go of the current clip: blend from the pose it is in right now back to the base
  release(fadeOut = 0.25) {
    const c = this.clip;
    if (!c) return;
    if (!c.ended) { c.ended = true; c.resolve(false); }
    c.c = { keys: [{ t: 0, p: this.out.slice() }], dur: 0 }; c.t = 0; c.fadeOut = fadeOut; c.fadeIn = 0;
  }
  get playing() { return !!this.clip && !this.clip.ended; }
  update(dt) {
    const c = this.clip;
    if (c) {
      c.t += dt * c.speed;
      if (c.t >= c.c.dur && !c.ended) {
        c.ended = true;
        c.onEnd?.();
        c.resolve(true);
        if (c.fadeOut <= 0) this.clip = null;
      }
    }
    const b = this.base, A = this.A;
    b.t += dt;
    A.set(REST);
    b.fn(b.t, b.prm, A);
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeDur);
      lerpPose(this.from, A, ss(this.fade), A);
    }
    const cl = this.clip;
    if (cl) {
      sampleClip(cl.c, Math.min(cl.t, cl.c.dur), this.B);
      let w;
      if (cl.t < cl.c.dur) w = cl.fadeIn > 0 ? Math.min(1, cl.t / cl.fadeIn) : 1;
      else w = cl.fadeOut > 0 ? 1 - (cl.t - cl.c.dur) / cl.fadeOut : 0;
      if (w <= 0) this.clip = null;
      else if (cl.t < cl.fadeIn) { lerpPose(cl.from, this.B, ss(w), A); }   // fade in from where it actually was
      else lerpPose(A, this.B, ss(w), A);
    }
    this.out.set(A);
    return this.out;
  }
}
