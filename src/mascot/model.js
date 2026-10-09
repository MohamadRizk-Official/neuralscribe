// The canonical SparkScribe mascot as a real 3D character (Three.js). Every animation uses this one model.
//
// Built from the reference art: a round faceted crystal body (blue / cyan / violet / pink), a large speaker
// in the middle of the body that acts as its eye, a faceted crystal lightning bolt (the SparkScribe spark) on a
// metal collar on top, pink "blush" bars
// beside the speaker, two small faceted arms and two faceted feet. No eyes, no face.
//
// Units: the body radius is 1. The origin is the body's center (its center of mass).
//
// Rig (each node is an independently controllable joint):
//   spin (screen roll: throws, falls)
//    └ yaw (facing: front / side / back)
//       └ body (lean, twist, bob)
//          ├ torso (squash)  → body mesh, blush, speaker (rim, ring, cone, eye: dome + catchlight), gem pivot
//          ├ shoulder L / R  → arm
//          └ hip L / R       → foot
// Geometry is deterministic (seeded), so the character is identical on every page and every load.
import {
  Group, Mesh, IcosahedronGeometry, LatheGeometry, TorusGeometry, CylinderGeometry, SphereGeometry, CapsuleGeometry,
  PlaneGeometry, Shape, ExtrudeGeometry, MeshStandardMaterial, MeshBasicMaterial, Color, Vector2, Vector3, CanvasTexture, AdditiveBlending,
  DoubleSide, BufferAttribute, SRGBColorSpace,
} from 'three';
import { DIM, FOOT_Y } from './motion.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- palette ----------
const C = {
  blue: new Color('#2a4ae6'), cyan: new Color('#3bbcff'), deep: new Color('#1c27a6'), violet: new Color('#7a45f5'),
  pink: new Color('#d659ff'), ringA: new Color('#22d3ee'), ringB: new Color('#ff3fd2'),
};
// crystal facets: cyan where the light hits (top / right / front), deep blue underneath, violet and the odd
// pink facet along the left edge, like the reference
function crystalPaint(n, rnd, out) {
  const hi = clamp(n.x * 0.42 + n.y * 0.68 + n.z * 0.34, 0, 1);
  out.copy(C.blue).lerp(C.cyan, hi * hi * 0.85);
  out.lerp(C.deep, clamp(-n.y * 0.85 - n.x * 0.15, 0, 1) * 0.55);
  out.lerp(C.violet, clamp((-n.x - 0.3) * 1.5, 0, 1) * 0.7);
  const r = rnd();
  if (r < 0.06) out.lerp(C.pink, 0.6);
  else if (r < 0.17) out.lerp(C.violet, 0.4);
  else if (r > 0.9) out.lerp(C.cyan, 0.35);
  out.multiplyScalar(0.88 + rnd() * 0.24);
}

// flat per-face colors (geometry must be non-indexed)
function paintFaces(g, paint, rnd) {
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), out = new Color();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    n.copy(a).add(b).add(c).normalize();
    paint(n, rnd, out);
    for (let k = 0; k < 3; k++) col.set([out.r, out.g, out.b], (i + k) * 3);
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
}

// a faceted crystal lump: an icosphere with seeded vertex jitter (shared vertices move together, so no cracks)
function faceted(r, detail, [sx, sy, sz], seed, jitter, paint) {
  const g = new IcosahedronGeometry(r, detail);
  const p = g.attributes.position, rnd = rng(seed), J = new Map();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    if (!J.has(key)) J.set(key, 1 + (rnd() * 2 - 1) * jitter);
    const f = J.get(key);
    p.setXYZ(i, x * f * sx, y * f * sy, z * f * sz);
  }
  paintFaces(g, paint, rng(seed * 7 + 3));
  g.computeVertexNormals();
  return g;
}

// open a round socket in the front of the body where the speaker sits (drops the faces inside it)
const SPEAKER_Y = -0.11;
function carveSocket(g, cx, cy, r) {
  const p = g.attributes.position, col = g.attributes.color, keep = [];
  for (let i = 0; i < p.count; i += 3) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += p.getX(i + k) / 3; y += p.getY(i + k) / 3; z += p.getZ(i + k) / 3; }
    if (!(z > 0 && Math.hypot(x - cx, y - cy) < r)) keep.push(i);
  }
  const P = new Float32Array(keep.length * 9), Cc = new Float32Array(keep.length * 9);
  keep.forEach((i, n) => { for (let k = 0; k < 9; k++) { P[n * 9 + k] = p.array[i * 3 + k]; Cc[n * 9 + k] = col.array[i * 3 + k]; } });
  g.setAttribute('position', new BufferAttribute(P, 3));
  g.setAttribute('color', new BufferAttribute(Cc, 3));
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g.computeVertexNormals();
}

// The bolt from the logo (src/lib/brand-markup.js, 40×40 artboard, y down) as a faceted 3D crystal
const BOLT_H = 0.92;
const BOLT_PTS = [[22.8, 1.5], [16, 21.4], [20, 21.4], [17.2, 38.5], [24, 17.6], [19.8, 17.6]];
const BOLT_C = [new Color('#7fe7ff'), new Color('#3b82f6'), new Color('#8b5cf6'), new Color('#f472b6')];
function boltGeometry() {
  const s = BOLT_H / 37, wide = 1.8;      // a little wider than the logo's bolt, so it reads as a solid crystal
  const shape = new Shape(BOLT_PTS.map(([x, y]) => new Vector2((x - 20) * s * wide, (38.5 - y) * s)));
  const g = new ExtrudeGeometry(shape, { depth: 0.16, steps: 1, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.055, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, 0, -0.08);
  const flat = g.index ? g.toNonIndexed() : g;
  const p = flat.attributes.position, col = new Float32Array(p.count * 3), c = new Color(), a = new Vector3(), b = new Vector3(), d = new Vector3(), n = new Vector3();
  const rnd = rng(9);
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); d.fromBufferAttribute(p, i + 2);
    const y = (a.y + b.y + d.y) / 3;
    n.subVectors(d, b).cross(a.clone().sub(b)).normalize();
    const t = clamp(1 - y / BOLT_H, 0, 1) * (BOLT_C.length - 1), k = Math.floor(Math.min(t, BOLT_C.length - 1.001));
    c.copy(BOLT_C[k]).lerp(BOLT_C[k + 1], t - k);
    c.lerp(C.cyan, clamp(n.y * 0.4 + n.x * 0.3, 0, 1) * 0.35);       // facets catching the key light
    c.multiplyScalar(0.9 + rnd() * 0.2);
    for (let j = 0; j < 3; j++) col.set([c.r, c.g, c.b], (i + j) * 3);
  }
  flat.setAttribute('color', new BufferAttribute(col, 3));
  flat.deleteAttribute('normal'); flat.deleteAttribute('uv');
  flat.computeVertexNormals();
  return flat;
}

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(cv);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function buildMascot() {
  const glowTex = glowTexture();
  const glow = (size, color, opacity) => new Mesh(new PlaneGeometry(size, size), new MeshBasicMaterial({
    map: glowTex, color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  const crystal = new MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.3, metalness: 0.22,
    emissive: new Color('#1a26a0'), emissiveIntensity: 0.55, envMapIntensity: 0.38,
  });
  const darkMetal = new MeshStandardMaterial({ color: '#12163a', roughness: 0.28, metalness: 0.7, emissive: new Color('#0a0f3a'), emissiveIntensity: 0.4 });

  // ---------- hierarchy ----------
  const spin = new Group();
  const yaw = new Group(); spin.add(yaw);
  const body = new Group(); body.rotation.order = 'YXZ'; yaw.add(body);
  const torso = new Group(); body.add(torso);

  // body: faceted, a little wider than tall like the reference
  const bodyGeo = faceted(1, 1, [1.02, 0.93, 0.97], 11, 0.035, crystalPaint);
  carveSocket(bodyGeo, 0, SPEAKER_Y, 0.6);
  const bodyMesh = new Mesh(bodyGeo, crystal);
  torso.add(bodyMesh);

  // ---------- blush: two short glowing pink bars on each side of the speaker ----------
  const blushMat = new MeshBasicMaterial({ color: '#ff5ad8', toneMapped: false, transparent: true, opacity: 0.95 });
  const blush = [];
  for (const sx of [-1, 1]) {
    const dir = new Vector3(sx * 0.8, -0.06, 0.6).normalize();
    const g = new Group();
    g.position.set(dir.x * 1.04, dir.y * 0.95, dir.z * 0.99);
    g.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
    for (const o of [-0.055, 0.055]) {
      const bar = new Mesh(new CapsuleGeometry(0.034, 0.14, 3, 8), blushMat);
      bar.position.x = o; bar.rotation.z = sx * 0.12;
      g.add(bar);
    }
    const h = glow(0.42, '#ff4fd8', 0.35); h.position.z = 0.01; g.add(h);
    torso.add(g); blush.push(g);
  }

  // ---------- speaker: the mascot's eye and expression ----------
  const speaker = new Group(); speaker.position.set(0, SPEAKER_Y, 0.8); torso.add(speaker);
  // the socket: an open tube with a back plate, so the speaker sits recessed in the crystal
  const housing = new Mesh(new CylinderGeometry(0.57, 0.57, 0.4, 40, 1, true), new MeshStandardMaterial({ color: '#0d1033', roughness: 0.35, metalness: 0.6, side: DoubleSide }));
  housing.rotation.x = Math.PI / 2; housing.position.z = -0.18;
  speaker.add(housing);
  const back = new Mesh(new CylinderGeometry(0.57, 0.57, 0.02, 40), darkMetal);
  back.rotation.x = Math.PI / 2; back.position.z = -0.3; speaker.add(back);
  const rim = new Mesh(new TorusGeometry(0.555, 0.06, 14, 60), new MeshStandardMaterial({ color: '#171c46', roughness: 0.2, metalness: 0.8, emissive: new Color('#0c1250'), emissiveIntensity: 0.5 }));
  rim.position.z = 0.03; speaker.add(rim);
  // glowing ring: cyan on one side, magenta on the other
  const ringGeo = new TorusGeometry(0.47, 0.024, 10, 80);
  {
    const p = ringGeo.attributes.position, col = new Float32Array(p.count * 3), c = new Color();
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getY(i), p.getX(i));
      const k = (Math.cos(a - 2.4) + 1) / 2;                 // 1 at the upper left, 0 at the lower right
      c.copy(C.ringB).lerp(C.ringA, k);
      col.set([c.r, c.g, c.b], i * 3);
    }
    ringGeo.setAttribute('color', new BufferAttribute(col, 3));
  }
  const ringMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new Color(1, 1, 1) });
  const ring = new Mesh(ringGeo, ringMat); ring.position.z = 0.05; speaker.add(ring);
  const ringGlowMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false });
  const ringGlow = new Mesh(new TorusGeometry(0.47, 0.075, 8, 80), ringGlowMat);
  {
    const p = ringGlow.geometry.attributes.position, col = new Float32Array(p.count * 3), c = new Color();
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getY(i), p.getX(i));
      c.copy(C.ringB).lerp(C.ringA, (Math.cos(a - 2.4) + 1) / 2);
      col.set([c.r, c.g, c.b], i * 3);
    }
    ringGlow.geometry.setAttribute('color', new BufferAttribute(col, 3));
  }
  ringGlow.position.z = 0.05; speaker.add(ringGlow);
  // cone: dark, slightly purple, recessed toward the middle; closed in the center, so the eye can move over it
  // without ever showing the socket behind
  const coneMat = new MeshStandardMaterial({ color: '#1a1040', roughness: 0.5, metalness: 0.25, emissive: new Color('#5a22c8'), emissiveIntensity: 0.45, side: DoubleSide });
  const cone = new Mesh(new LatheGeometry([new Vector2(0.455, 0.03), new Vector2(0.4, 0.0), new Vector2(0.31, -0.05), new Vector2(0.23, -0.08), new Vector2(0.12, -0.09), new Vector2(0.001, -0.092)], 48), coneMat);
  cone.rotation.x = Math.PI / 2; speaker.add(cone);
  const groove = new Mesh(new TorusGeometry(0.33, 0.008, 6, 56), new MeshBasicMaterial({ color: '#7c4dff', transparent: true, opacity: 0.45, toneMapped: false }));
  groove.position.z = -0.05; speaker.add(groove);
  // the eye: dome + catchlight + iris ring; it moves inside the speaker to look at things
  const eye = new Group(); eye.position.z = -0.07; speaker.add(eye);
  const dome = new Mesh(new SphereGeometry(0.19, 28, 18), new MeshStandardMaterial({ color: '#06050e', roughness: 0.12, metalness: 0.45, envMapIntensity: 1.2 }));
  dome.scale.z = 0.6; eye.add(dome);
  const irisMat = new MeshBasicMaterial({ color: '#ff4fd8', transparent: true, opacity: 0.55, toneMapped: false, blending: AdditiveBlending, depthWrite: false });
  const iris = new Mesh(new TorusGeometry(0.205, 0.012, 6, 48), irisMat); iris.position.z = 0.02; eye.add(iris);
  const catchMat = new MeshBasicMaterial({ color: '#ffe3f8', toneMapped: false, transparent: true });
  const catchlight = new Mesh(new SphereGeometry(0.033, 12, 8), catchMat);
  catchlight.position.set(0.06, 0.06, 0.1); eye.add(catchlight);
  const catchGlow = glow(0.22, '#ff8be6', 0.6); catchGlow.position.set(0.06, 0.06, 0.12); eye.add(catchGlow);
  // light spill around the speaker (expression intensity)
  const halo = glow(1.9, new Color('#7c5cff'), 0.18); halo.position.z = 0.08; speaker.add(halo);
  // processing: a short arc of light running around inside the ring
  const arcMat = new MeshBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0, toneMapped: false, blending: AdditiveBlending, depthWrite: false });
  const arc = new Mesh(new TorusGeometry(0.4, 0.02, 6, 32, 1.3), arcMat); arc.position.z = 0.02; speaker.add(arc);
  const arc2 = new Mesh(new TorusGeometry(0.4, 0.016, 6, 32, 0.8), arcMat.clone()); arc2.material.color.set('#f472b6'); arc2.position.z = 0.02; speaker.add(arc2);
  // listening: soft rings that breathe with an imagined voice
  const listen = [0.27, 0.34, 0.41].map((r, i) => {
    const m = new Mesh(new TorusGeometry(r, 0.008, 6, 56), new MeshBasicMaterial({ color: i === 1 ? '#a78bfa' : '#22d3ee', transparent: true, opacity: 0, toneMapped: false, blending: AdditiveBlending, depthWrite: false }));
    m.position.z = 0.03; speaker.add(m); return m;
  });
  // success / surprise pulses: rings that expand out of the speaker
  const pulses = ['#22d3ee', '#a78bfa', '#f472b6'].map((c) => {
    const m = new Mesh(new TorusGeometry(0.5, 0.022, 6, 64), new MeshBasicMaterial({ color: c, transparent: true, opacity: 0, toneMapped: false, blending: AdditiveBlending, depthWrite: false }));
    m.position.z = 0.1; m.visible = false; speaker.add(m); return { m, t: -1, delay: 0 };
  });

  // ---------- gem on its collar ----------
  const gemPivot = new Group(); gemPivot.position.set(0, 0.88, 0); torso.add(gemPivot);
  const collar = new Mesh(new CylinderGeometry(0.15, 0.19, 0.15, 20), darkMetal); collar.position.y = 0.07; gemPivot.add(collar);
  const collarGlow = new Mesh(new TorusGeometry(0.158, 0.017, 8, 32), new MeshBasicMaterial({ color: '#ff4fd8', toneMapped: false }));
  collarGlow.rotation.x = Math.PI / 2; collarGlow.position.y = 0.13; gemPivot.add(collarGlow);
  // the head piece: the SparkScribe bolt (same outline as the logo) as a solid crystal, extruded with
  // chamfered (faceted) edges and colored like the body: cyan at the top → blue → violet → pink at the tip
  const gemGeo = boltGeometry();
  const gemMat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.16, metalness: 0.15, emissive: new Color('#2d6bff'), emissiveIntensity: 0.4, envMapIntensity: 1.3 });
  const gem = new Mesh(gemGeo, gemMat); gem.position.y = 0.1; gemPivot.add(gem);
  const gemHalo = glow(1.1, new Color('#22d3ee'), 0.12); gemHalo.position.set(0, 0.45, 0.2); gemPivot.add(gemHalo);

  // ---------- arms ----------
  const arm = (side, seed) => {
    const sh = new Group(); sh.position.set(side * DIM.shoulder[0], DIM.shoulder[1], DIM.shoulder[2]);
    const m = new Mesh(faceted(0.33, 1, [0.95, 1.1, 0.92], seed, 0.06, crystalPaint), crystal);
    m.position.y = -0.3; sh.add(m);
    sh.rotation.z = side * DIM.armRest;
    sh.userData.mesh = m;
    body.add(sh);
    return sh;
  };
  const armL = arm(1, 21), armR = arm(-1, 22);   // L = the mascot's left (screen right while facing you)

  // ---------- legs / feet ----------
  const leg = (side, seed) => {
    const hip = new Group(); hip.position.set(side * DIM.hip[0], DIM.hip[1], DIM.hip[2]);
    const foot = new Group(); foot.position.set(side * 0.07, FOOT_Y, 0.05); hip.add(foot);
    const m = new Mesh(faceted(0.34, 1, [1.08, 0.6, 1.15], seed, 0.05, crystalPaint), crystal);
    foot.add(m);
    body.add(hip);
    return { hip, foot };
  };
  const legL = leg(1, 31), legR = leg(-1, 32);

  // ---------- expression state (speaker + gem), smoothed ----------
  const STATES = {
    //            ring halo  rate  amp  cone  iris  arc  listen gem  gemHalo body  tint
    idle:       [0.9, 0.16, 0.22, 0.05, 0.45, 0.55, 0,   0,     0.35, 0.12, 0.55, 0],
    happy:      [1.1, 0.28, 0.8,  0.08, 0.6,  0.7,  0,   0,     0.5,  0.2,  0.6,  0],
    curious:    [1.0, 0.24, 0.5,  0.07, 0.55, 0.75, 0,   0,     0.55, 0.22, 0.55, 0],
    excited:    [1.35, 0.42, 2.2, 0.14, 0.8,  0.9,  0,   0,     0.8,  0.35, 0.62, 0],
    listening:  [1.0, 0.26, 1.1,  0.08, 0.6,  0.6,  0,   1,     0.5,  0.2,  0.55, 0],
    processing: [0.9, 0.22, 0.6,  0.06, 0.65, 0.5,  1,   0,     0.6,  0.24, 0.55, 0],
    success:    [1.5, 0.55, 1.4,  0.12, 0.9,  0.9,  0,   0,     1.0,  0.45, 0.65, 0],
    bright:     [1.25, 0.34, 0.6, 0.05, 0.7,  0.85, 0,   0,     0.55, 0.2,  0.58, 0],
    tired:      [0.45, 0.06, 0.12, 0.04, 0.25, 0.3, 0,   0,     0.15, 0.04, 0.38, 0],
    error:      [0.6, 0.18, 0.3,  0.07, 0.35, 0.5,  0,   0,     0.12, 0.05, 0.42, 1],
  };
  const N = 12;
  const cur = Float32Array.from(STATES.idle);
  const expr = { base: 'idle', temp: null, tempUntil: 0, gemMode: '', gemUntil: 0, surpriseT: -1, flashT: -1, time: 0 };
  const tint = new Color('#c45cff');
  const white = new Color(1, 1, 1);
  const haloA = new Color('#7c5cff'), haloSuccess = new Color('#f472b6'), haloError = new Color('#c026d3');
  const gemCyan = new Color('#2d6bff'), gemViolet = new Color('#8b5cf6'), gemPink = new Color('#ec4899');
  const tmpC = new Color();

  function setBase(name) { if (STATES[name]) expr.base = name; }
  function flash(name, ms = 900) { if (!STATES[name]) return; expr.temp = name; expr.tempUntil = expr.time + ms / 1000; }
  function gemFx(mode, ms = 900) { expr.gemMode = mode; expr.gemUntil = expr.time + ms / 1000; }
  function pulse(n = 3) {
    pulses.forEach((p, i) => { if (i < n) { p.t = 0; p.delay = i * 0.14; p.m.visible = true; } });
  }
  function surprise() { expr.surpriseT = 0; }

  // eye position inside the speaker: x, y in -1..1 (smoothed by the caller)
  const EYE_R = 0.12;
  function setEye(x, y) {
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    eye.position.x = x * EYE_R; eye.position.y = y * EYE_R;
    eye.rotation.y = x * 0.35; eye.rotation.x = -y * 0.35;
    cone.position.x = x * 0.025; cone.position.y = y * 0.025;   // the cone follows a little, like a lens
  }

  function update(dt) {
    expr.time += dt;
    const t = expr.time;
    if (expr.temp && t > expr.tempUntil) expr.temp = null;
    const target = STATES[expr.temp || expr.base];
    const k = 1 - Math.exp(-dt * 7);
    for (let i = 0; i < N; i++) cur[i] += (target[i] - cur[i]) * k;
    const [ringB, haloB, rate, amp, coneB, irisB, arcB, listenB, gemB, gemHaloB, bodyB, tintB] = cur;
    const breathe = Math.sin(t * Math.PI * 2 * rate);
    // ring: brighter or dimmer, tinted for errors
    tmpC.copy(white).lerp(tint, tintB * 0.7).multiplyScalar(ringB * (1 + breathe * amp));
    ringMat.color.copy(tmpC);
    ringGlowMat.opacity = clamp(0.22 + (ringB - 0.9) * 0.6 + breathe * amp * 1.5, 0.05, 0.9);
    halo.material.opacity = clamp(haloB * (1 + breathe * amp * 3), 0, 0.9);
    halo.material.color.copy(haloA).lerp(haloError, tintB).lerp(haloSuccess, expr.temp === 'success' ? 0.7 : 0);
    coneMat.emissiveIntensity = coneB * (1 + breathe * amp * 2);
    irisMat.opacity = irisB;
    crystal.emissiveIntensity = bodyB;
    blushMat.opacity = 0.55 + bodyB * 0.75;
    // surprise: the iris contracts, then opens wide
    let irisS = 1;
    if (expr.surpriseT >= 0) {
      expr.surpriseT += dt;
      const s = expr.surpriseT;
      irisS = s < 0.12 ? 1 - s / 0.12 * 0.45 : s < 0.35 ? 0.55 + (s - 0.12) / 0.23 * 0.75 : 1.3 - Math.min(1, (s - 0.35) / 0.4) * 0.3;
      if (s > 0.8) expr.surpriseT = -1;
    }
    dome.scale.set(irisS, irisS, irisS * 0.6); iris.scale.setScalar(irisS);
    catchMat.opacity = clamp(0.5 + ringB * 0.5, 0, 1);
    // processing arcs
    arc.material.opacity = arcB * 0.95; arc2.material.opacity = arcB * 0.7;
    arc.rotation.z = -t * 4.2; arc2.rotation.z = -t * 4.2 + Math.PI;
    // listening rings
    listen.forEach((m, i) => {
      const v = 0.5 + 0.5 * Math.sin(t * (5 + i * 1.7) + i * 2) * Math.sin(t * 2.3 + i);
      m.material.opacity = listenB * (0.25 + v * 0.6);
      m.scale.setScalar(1 + v * 0.08 * listenB);
    });
    // pulses
    for (const p of pulses) {
      if (p.t < 0) continue;
      p.t += dt;
      const s = (p.t - p.delay) / 0.9;
      if (s < 0) { p.m.material.opacity = 0; continue; }
      if (s >= 1) { p.t = -1; p.m.visible = false; continue; }
      p.m.scale.setScalar(1 + s * 1.5);
      p.m.material.opacity = (1 - s) * 0.9;
    }
    // gem
    let gB = gemB, gHalo = gemHaloB;
    tmpC.copy(gemCyan);
    const gm = t < expr.gemUntil ? expr.gemMode : '';
    if (gm === 'flash') { const f = (expr.gemUntil - t); gB += f * 1.6; gHalo += f * 0.6; }
    else if (gm === 'success') { const h = (t * 1.6) % 1; tmpC.copy(h < 0.33 ? gemCyan : h < 0.66 ? gemViolet : gemPink); gB += 0.8; gHalo += 0.35; }
    else if (gm === 'shimmer') { tmpC.lerp(gemViolet, 0.5 + 0.5 * Math.sin(t * 9)); gB += 0.25; }
    if (expr.base === 'excited' || expr.temp === 'excited') tmpC.lerp(Math.sin(t * 12) > 0 ? gemPink : gemCyan, 0.6);
    if (expr.base === 'processing') { tmpC.lerp(gemViolet, 0.5 + 0.5 * Math.sin(t * 2)); gem.rotation.y = t * 0.9; }
    else gem.rotation.y += (Math.round(gem.rotation.y / (Math.PI * 2)) * Math.PI * 2 - gem.rotation.y) * k;   // settles facing front
    if (expr.base === 'error') tmpC.lerp(gemViolet, 0.6);
    gemMat.emissive.copy(tmpC); gemMat.emissiveIntensity = gB;
    gemHalo.material.color.copy(tmpC).lerp(white, 0.2); gemHalo.material.opacity = clamp(gHalo, 0, 0.9);
  }

  const dispose = () => {
    spin.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    glowTex.dispose();
  };

  return {
    root: spin, spin, yaw, body, torso, armL, armR, legL, legR, gemPivot, gem, speaker, eye,
    expr: { setBase, flash, gemFx, pulse, surprise, setEye, get base() { return expr.base; } },
    update, dispose, blush,
  };
}
