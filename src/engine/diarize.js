// Speaker detection ("who spoke when"), shared by the transcription worker (src/worker.js) and the
// diarization test runner (accuracy/diarize-eval.mjs), so what is measured is exactly what ships.
//
//   1. pyannote segmentation on 10 s chunks  -> where speech is and which *local* voice (≤3 per chunk)
//   2. WeSpeaker ResNet34 voice fingerprint  -> one embedding per (chunk, local voice)
//   3. clustering of all fingerprints of the whole file -> global speakers
//   3b. context smoothing of short, isolated runs
//
// The models are loaded by the caller and handed over with configureDiarizer().

export const SR = 16000;
export const UNKNOWN = 'Unknown';
export const MIN_GAP_SPEECH_S = 1.0; // loud-but-unlabelled stretches shorter than this are ignored

// Speaker detection
const SEG_CHUNK_S = 10; // pyannote segmentation is trained on 10 s windows
const EMB_CLIP_S = 5; // every fingerprint is computed on exactly 5 s (cropped or looped) so they batch
const EMB_MIN_S = 0.5; // less clean speech than this in a chunk can't be fingerprinted -> Unknown
const CLUSTER_MIN_S = 1.2; // only fingerprints with at least this much speech decide the clusters
const LINK_DIST = 0.7; // average-linkage cosine distance at which voices stop being merged
const ASSIGN_SIM = 0.25; // short/rare voices join the closest speaker only if at least this cosine-similar
const MIN_SPEAKER_S = 15; // a "speaker" needs this much speech (or 1% of the file) to count as a real person

// Context smoothing of speaker labels (see smoothSpeakers)
const SMOOTH_JOIN_GAP_S = 0.3; // same-speaker speech closer than this is one run
const SMOOTH_CONTEXT_GAP_S = 1.5; // a neighbouring run within this gap counts as context
const SMOOTH_MAX_S = 1.5; // a different-speaker run this short, inside one person's speech, is re-checked
const SMOOTH_MAX_UNKNOWN_S = 3; // Unknown runs up to this long are re-checked
const SMOOTH_EMB_MIN_S = 0.25; // shortest stretch that gets its own voice fingerprint for the check
const SMOOTH_MARGIN = 0.1; // another speaker must be this much more similar (cosine) to win
const OTHER_VOICE_SIM = 0.15; // below this similarity to the surrounding speaker = clearly another voice
const CORROBORATE_MIN_S = 0.5; // a lone anomaly shorter than this needs a recurring voice to stay separate
const K_SPLIT_MIN_DIST = 0.5; // with a chosen speaker count, only split groups this far apart (cosine distance)
const NEW_VOICE_MIN_S = 1.5; // a voice found only in short moments needs at least this much speech in total…
const NEW_VOICE_MIN_SHARE = 0.005; // …and at least 0.5% of all speech to become a new speaker (Auto)
const NEW_VOICE_COHESION = 0.5; // each of its moments must be this similar (cosine) to the group's average voice
const NEW_VOICE_RECUR_N = 3; // …or the voice recurs at least this many times
const NEW_VOICE_RECUR_S = 1.0; // …adding up to at least this much speech
const NEW_VOICE_RECUR_COHESION = 0.6; // …and its moments agree with each other at least this well
const NEW_VOICE_RECUR_KNOWN = 0.2; // …and is less similar than this to every known speaker
const MISSING_SLOT_SIM = 0.3; // with a chosen count and someone missing: a voice less similar than this to every known speaker can be them

// Identity verification (see verifySpeakers): every stretch of speech is re-checked against every speaker's
// voice, so one person keeps one label from the first minute to the last.
const VERIFY_WIN_S = 4; // longer runs are checked in windows of about this length…
const VERIFY_MIN_S = 1.5; // …and a stretch must be at least this long to be judged on its own voice
const VERIFY_MARGIN = 0.12; // another speaker must be this much more similar (cosine) to take a stretch over
const VERIFY_TAKE_SIM = 0.3; // …and at least this similar in absolute terms
const VERIFY_LOST_SIM = 0.1; // a stretch this unlike its own speaker, and unlike everyone else, becomes Unknown
const VERIFY_PASSES = 2; // reassign, recompute every speaker's voice, reassign again
const VERIFY_PAUSE_S = 0.25; // a pause this long inside a run is a natural boundary: each side is checked on its own
const VERIFY_SHORT_S = 1.5; // pieces shorter than this (down to VERIFY_PIECE_MIN_S) need clearer evidence…
const VERIFY_PIECE_MIN_S = 1.0;
const VERIFY_SHORT_MARGIN = 0.2; // …a bigger margin…
const VERIFY_SHORT_TAKE = 0.4; // …and a higher similarity to move

// Which refinements run (all on in the app; the test runner switches them off one at a time)
export const FEATURES = { overlap: true, reply: true, segDiff: true, pausePieces: true, subItems: false, unsure: true, mergeSplits: true }; // subItems off: it lost a quiet real person (AMI TS3003a)
// One person split in two (Auto only): merged when the two voices are this similar, never talk over each other
// anywhere in the recording, and the smaller one has less than this share of the speech
const SPLIT_MERGE_SIM = 0.45;
const SPLIT_MERGE_MAX_SHARE = 0.25;
// Noise can make a voice unrecognisable, so noisy stretches of one person can turn into a "new" speaker. A small
// group whose speech is this much noisier (signal-to-noise, dB) than the rest of the recording, and that is almost
// always surrounded by one speaker it never talks over, is folded back into that speaker.
const NOISY_DB = 8;
const NOISY_NEIGHBOUR_SHARE = 0.7;
const UNSURE_SIM = 0.4; // a stretch whose best voice match is this weak…
const UNSURE_MARGIN = 0.12; // …and barely ahead of the next person becomes Unknown rather than a guess
const SUB_GAP_S = 0.5; // a local voice that pauses this long inside a 10 s chunk is fingerprinted per stretch

// Overlapping speech (see diarize)
const OVERLAP_MIN_S = 1.0; // two voices at once for at least this long = shown as overlapping speech, nobody's
const REPLY_TAKE_SIM = 0.25; // a short reply over someone joins a known voice only if at least this similar


// Models and callbacks from the caller (worker or test runner).
const env = {
  segModel: null, segProcessor: null, segDevice: null, embModel: null, embProcessor: null, embDevice: null,
  Tensor: null, debugVoices: false, status: () => {}, lap: () => {}, post: () => {},
  onChunks: null, // test runner only: receives the raw per-chunk segmentation
};
export function configureDiarizer(opts) { Object.assign(env, opts); }

// ---------- 1. segmentation ----------
// Splits combined labels ("SPEAKER_00 + SPEAKER_01") into their parts.
// The segmentation model (pyannote powerset) labels each frame NO_SPEAKER, SPEAKER_n, or SPEAKERS_a_AND_b when two
// people talk at once. (This used to look for "a + b", which never matched, so overlapping speech was treated as a
// voice of its own and handed to one person.)
const parts = (label) => {
  if (label === 'NO_SPEAKER') return [];
  const m = /^SPEAKERS_(\d+)_AND_(\d+)$/.exec(label);
  return m ? [`SPEAKER_${m[1]}`, `SPEAKER_${m[2]}`] : label.split(' + ');
};
const isOverlap = (label) => parts(label).length > 1;

async function segmentChunks(audio) {
  const chunkLen = SR * SEG_CHUNK_S;
  const n = Math.ceil(audio.length / chunkLen);
  const batch = env.segDevice === 'webgpu' ? 32 : 8;
  const id2label = env.segModel.config.id2label || {};
  const chunks = []; // [{ offset, segs: [{start,end,label}] }]

  for (let i = 0; i < n; i += batch) {
    const b = Math.min(batch, n - i);
    const data = new Float32Array(b * chunkLen); // zero-padded past the end of the audio
    for (let k = 0; k < b; k++) {
      const s = (i + k) * chunkLen;
      data.set(audio.subarray(s, Math.min(audio.length, s + chunkLen)), k * chunkLen);
    }
    const { logits } = await env.segModel({ input_values: new env.Tensor('float32', data, [b, 1, chunkLen]) });
    const results = env.segProcessor.post_process_speaker_diarization(logits, chunkLen);
    results.forEach((segs, k) => {
      const offset = (i + k) * SEG_CHUNK_S;
      chunks.push({
        offset,
        segs: segs
          .map((s) => ({ start: s.start + offset, end: Math.min(s.end + offset, audio.length / SR), label: id2label[s.id] ?? String(s.id) }))
          .filter((s) => s.end > s.start),
      });
    });
    env.status(`Finding speech… ${Math.round(((i + b) / n) * 100)}%`);
  }
  return chunks;
}

// ---------- 2. voice fingerprints ----------
// One item per (chunk, local voice), using only the parts where that voice speaks alone.
function collectVoices(audio, chunks) {
  const items = [];
  chunks.forEach((chunk, c) => {
    const byLocal = new Map();
    for (const s of chunk.segs) {
      if (s.label === 'NO_SPEAKER' || isOverlap(s.label)) continue; // skip silence and overlap
      if (!byLocal.has(s.label)) byLocal.set(s.label, []);
      byLocal.get(s.label).push(s);
    }
    for (const [local, segs] of byLocal) {
      // The segmentation can give two people the same local label inside one chunk (a reply, then someone else
      // continuing). One fingerprint for all of it mixes them, so a local voice is split where it pauses for
      // SUB_GAP_S: each stretch gets its own fingerprint; stretches too short to fingerprint follow their siblings.
      const groups = [];
      for (const x of segs) {
        const g = groups[groups.length - 1];
        if (g && (!FEATURES.subItems || x.start - g.at(-1).end < SUB_GAP_S)) g.push(x); else groups.push([x]);
      }
      groups.forEach((g, k) => {
        const key = groups.length === 1 ? `${c}|${local}` : `${c}|${local}|${k}`;
        for (const x of g) x.key = key;
        const dur = g.reduce((t, x) => t + (x.end - x.start), 0);
        items.push({ key, chunk: c, local, segs: g, dur, emb: null, sub: groups.length > 1 });
      });
    }
  });
  return items;
}

function clipForVoice(audio, segs) {
  const want = SR * EMB_CLIP_S;
  const pieces = segs.map((s) => audio.subarray(Math.floor(s.start * SR), Math.floor(s.end * SR)));
  const total = pieces.reduce((t, p) => t + p.length, 0);
  const out = new Float32Array(want);
  if (!total) return out;
  // concatenate, looping if the voice spoke for less than EMB_CLIP_S (mean/std pooling is unaffected)
  let w = 0;
  while (w < want) {
    for (const p of pieces) {
      const take = Math.min(p.length, want - w);
      out.set(p.subarray(0, take), w);
      w += take;
      if (w >= want) break;
    }
  }
  return out;
}

// Voice fingerprints for arbitrary stretches of audio (each entry = list of {start,end} segments).
export async function embedClips(audio, segLists, onProgress) {
  const out = new Array(segLists.length).fill(null);
  const batch = env.embDevice === 'webgpu' ? 16 : 4;
  for (let i = 0; i < segLists.length; i += batch) {
    const group = segLists.slice(i, i + batch);
    const feats = [];
    for (const segs of group) feats.push((await env.embProcessor(clipForVoice(audio, segs))).input_features);
    const [, F, D] = feats[0].dims;
    const data = new Float32Array(group.length * F * D);
    feats.forEach((f, k) => data.set(f.data, k * F * D));
    const res = await env.embModel({ input_features: new env.Tensor('float32', data, [group.length, F, D]) });
    const embs = res.last_hidden_state ?? res.embeddings ?? Object.values(res)[0];
    const dim = embs.dims[1];
    group.forEach((_, k) => { out[i + k] = normalize(embs.data.slice(k * dim, (k + 1) * dim)); });
    onProgress?.(i + group.length, segLists.length);
  }
  return out;
}

async function embedVoices(audio, items) {
  const todo = items.filter((it) => it.dur >= EMB_MIN_S);
  const embs = await embedClips(audio, todo.map((it) => it.segs), (done, total) => env.status(`Recognizing voices… ${Math.round((done / total) * 100)}%`));
  todo.forEach((it, k) => { it.emb = embs[k]; });
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// ---------- 3. clustering ----------
// Average-linkage agglomerative clustering on cosine distance (far more stable on real meetings than
// centroid linkage, which snowballs everything into one cluster).
//   Auto: merge until the closest clusters are LINK_DIST apart.
//   N speakers: walk the full merge tree and stop where N *substantial* clusters exist (so asking
//   for more people than the threshold would find still splits them), then merge the closest
//   substantial clusters down to N. Tiny outlier clusters are folded in or handled afterwards.
function clusterVoices(items, numSpeakers, minSpeakerS) {
  const pts = items.filter((it) => it.emb && it.dur >= CLUSTER_MIN_S);
  const n = pts.length;
  if (!n) return [];
  const dim = pts[0].emb.length;
  const D0 = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D0[i * n + j] = D0[j * n + i] = 1 - dot(pts[i].emb, pts[j].emb);

  function run(stopAt) {
    const D = Float32Array.from(D0);
    const size = new Int32Array(n).fill(1);
    const dur = Float64Array.from(pts, (p) => p.dur);
    const members = pts.map((p) => [p]);
    const alive = new Uint8Array(n).fill(1);
    const best = new Int32Array(n).fill(-1);
    const bestD = new Float32Array(n).fill(Infinity);
    let big = 0;
    for (let i = 0; i < n; i++) if (dur[i] >= minSpeakerS) big++;
    const history = [{ dist: 0, big }];
    const refreshBest = (i) => {
      best[i] = -1;
      bestD[i] = Infinity;
      for (let j = 0; j < n; j++) if (j !== i && alive[j] && D[i * n + j] < bestD[i]) { bestD[i] = D[i * n + j]; best[i] = j; }
    };
    for (let i = 0; i < n; i++) refreshBest(i);
    const merge = (i, j) => {
      for (let k = 0; k < n; k++) {
        if (!alive[k] || k === i || k === j) continue;
        D[i * n + k] = D[k * n + i] = (size[i] * D[i * n + k] + size[j] * D[j * n + k]) / (size[i] + size[j]);
      }
      big -= (dur[i] >= minSpeakerS) + (dur[j] >= minSpeakerS);
      size[i] += size[j];
      dur[i] += dur[j];
      big += dur[i] >= minSpeakerS;
      members[i].push(...members[j]);
      alive[j] = 0;
      // average linkage never brings a cluster closer, so only neighbours of i or j need a refresh
      for (let k = 0; k < n; k++) if (alive[k] && (k === i || best[k] === i || best[k] === j)) refreshBest(k);
    };
    let steps = 0;
    for (;;) {
      if (stopAt != null && steps >= stopAt) break;
      let i = -1;
      for (let k = 0; k < n; k++) if (alive[k] && best[k] >= 0 && (i < 0 || bestD[k] < bestD[i])) i = k;
      if (i < 0) break;
      if (stopAt == null && bestD[i] > LINK_DIST) break; // threshold (Auto) result
      const d = bestD[i];
      merge(i, best[i]);
      steps++;
      history.push({ dist: d, big });
    }
    return { D, dur, members, alive, history, merge };
  }

  const countBig = (st) => { let k = 0; for (let i = 0; i < n; i++) if (st.alive[i] && st.dur[i] >= minSpeakerS) k++; return k; };
  let state = run(null); // threshold result (Auto)
  if (numSpeakers && countBig(state) < numSpeakers) {
    // Fewer people than chosen: look deeper in the merge tree for the point where N substantial
    // clusters exist — but only accept it if the split being undone is a real voice difference
    // (one person's voice must never be cut in two just to reach the number). Otherwise keep the
    // Auto result; a recurring different voice can still become the missing person later.
    const { history } = run(Infinity);
    let stop = -1;
    history.forEach((h, s) => { if (h.big >= numSpeakers) stop = s; });
    const undone = stop >= 0 ? history[stop + 1] : null;
    if (undone && undone.dist >= K_SPLIT_MIN_DIST) state = run(stop);
  }
  // More groups than the chosen count are NOT merged pairwise here: merging "the two closest groups" joined
  // two real people whenever an extra group was something else (a laugh, crosstalk, one person on a worse
  // mic). labelVoices keeps the N biggest groups as the people and re-homes the rest piece by piece.

  const clusters = [];
  for (let i = 0; i < n; i++) {
    if (!state.alive[i]) continue;
    const c = new Float32Array(dim);
    for (const p of state.members[i]) for (let d = 0; d < dim; d++) c[d] += p.emb[d];
    clusters.push({ members: state.members[i], centroid: normalize(c), dur: state.dur[i] });
  }
  return clusters;
}

// Gives every (chunk, local voice) a global speaker label (or Unknown), plus each speaker's voice centroid.
function labelVoices(items, numSpeakers) {
  // A "person" needs a meaningful share of the speech: 15 s, but at most 15% of a short recording
  // (otherwise someone who speaks 8 s of a 40 s call could never count) and at least 1% of a long one.
  const totalSpeech = items.reduce((t, it) => t + it.dur, 0);
  let minSpeakerS = Math.max(Math.min(MIN_SPEAKER_S, totalSpeech * 0.15), totalSpeech * 0.01);
  if (numSpeakers > 1) minSpeakerS = Math.min(minSpeakerS, totalSpeech / (numSpeakers * 3));
  const clusters = clusterVoices(items, numSpeakers, minSpeakerS);

  // Tiny clusters are usually a real speaker on a bad-mic moment (or a cough / laugh). Fold them
  // into the closest real speaker when similar enough; otherwise context smoothing decides later.
  let big = clusters.filter((c) => c.dur >= minSpeakerS);
  let small = clusters.filter((c) => c.dur < minSpeakerS);
  if (!big.length) { big = clusters; small = []; }
  if (numSpeakers && big.length > numSpeakers) {
    // a chosen count: the N groups with the most speech are the people; the others are dissolved below
    big.sort((a, b) => b.dur - a.dur);
    small = [...small, ...big.splice(numSpeakers)];
  }
  const nearest = (emb) => {
    let bi = -1, bs = -Infinity;
    big.forEach((c, i) => { const s = dot(emb, c.centroid); if (s > bs) { bs = s; bi = i; } });
    return [bi, bs];
  };

  const label = new Map(); // key -> cluster index in `big`, or -1 for unknown
  big.forEach((c, i) => c.members.forEach((p) => label.set(p.key, i)));
  // each piece of a dissolved / tiny group joins the speaker it sounds most like (or stays Unknown)
  for (const c of small) {
    for (const p of c.members) {
      const [bi, bs] = nearest(p.emb);
      label.set(p.key, bs >= ASSIGN_SIM ? bi : -1);
    }
  }
  for (const it of items) {
    if (label.has(it.key)) continue;
    if (!it.emb) continue; // resolved below from neighbouring chunks, then by context smoothing
    const [bi, bs] = nearest(it.emb);
    label.set(it.key, bs >= ASSIGN_SIM ? bi : -1);
  }

  // Too little speech to fingerprint: if it touches the chunk edge and the neighbouring chunk has a
  // voice running across the same edge, it is almost certainly the same person mid-sentence.
  const byChunk = new Map();
  for (const it of items) { if (!byChunk.has(it.chunk)) byChunk.set(it.chunk, []); byChunk.get(it.chunk).push(it); }
  for (const it of items) {
    if (label.has(it.key) || !it.sub) continue;
    const votes = new Map();
    for (const o of byChunk.get(it.chunk)) if (o !== it && o.local === it.local && label.get(o.key) >= 0) votes.set(label.get(o.key), (votes.get(label.get(o.key)) || 0) + o.dur);
    const top = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (top) label.set(it.key, top[0]);
  }
  const EDGE = 0.25;
  for (const it of items) {
    if (label.has(it.key)) continue;
    const t0 = it.chunk * SEG_CHUNK_S;
    const t1 = t0 + SEG_CHUNK_S;
    let inherited = -1;
    const touchesStart = it.segs.some((s) => s.start - t0 < EDGE);
    const touchesEnd = it.segs.some((s) => t1 - s.end < EDGE);
    for (const [cond, other, edge] of [[touchesStart, it.chunk - 1, t0], [touchesEnd, it.chunk + 1, t1]]) {
      if (!cond || inherited >= 0) continue;
      for (const o of byChunk.get(other) || []) {
        const l = label.get(o.key);
        if (l >= 0 && o.segs.some((s) => Math.abs((other < it.chunk ? s.end : s.start) - edge) < EDGE)) { inherited = l; break; }
      }
    }
    label.set(it.key, inherited);
  }

  // Name clusters in order of first appearance.
  const order = new Map();
  for (const it of [...items].sort((a, b) => a.chunk - b.chunk)) {
    const ci = label.get(it.key);
    if (ci >= 0 && !order.has(ci)) order.set(ci, `SPEAKER_${String(order.size).padStart(2, '0')}`);
  }
  const names = new Map();
  for (const [key, ci] of label) names.set(key, ci >= 0 ? order.get(ci) : UNKNOWN);
  const centroids = new Map();
  for (const [ci, name] of order) centroids.set(name, big[ci].centroid);
  return { names, centroids };
}

// ---------- 3c. identity verification ----------
// Labels come from one fingerprint per (10 s chunk, local voice), taken from that voice's first 5 s. When the
// segmentation model gives two people the same local label inside a chunk, or a fingerprint is not
// representative, a whole stretch was carried by the wrong person and nothing looked at it again: the same
// voice could be "Speaker 3" at minute 2 and "Speaker 1" at minute 15.
// Here every stretch of speech (in windows of ~4 s) gets its own fingerprint and is compared with every
// speaker's average voice, built from all of that speaker's stretches. A stretch moves to another speaker
// only when that speaker is clearly more similar; a stretch that matches nobody becomes Unknown (Unknown is
// better than the wrong person). Then the voices are recomputed and everything is checked once more.
// Short stretches (< 1.5 s) keep their label: too little audio to judge, and context smoothing has
// already looked at them.
async function verifySpeakers(audio, segments) {
  const isReal = (sp) => sp && sp !== UNKNOWN;
  const sorted = segments.filter((x) => !x.overlap).sort((a, b) => a.start - b.start);
  // runs of one label, cut into windows of about VERIFY_WIN_S
  const runs = [];
  for (const sg of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === sg.speaker && sg.start - last.end <= SMOOTH_JOIN_GAP_S) { last.end = Math.max(last.end, sg.end); last.segs.push(sg); }
    else runs.push({ speaker: sg.speaker, start: sg.start, end: sg.end, segs: [sg] });
  }
  const wins = [];
  for (const run of runs) {
    // natural pieces: a pause of VERIFY_PAUSE_S or more ends a piece ("It's very impressive." | "Very nice machine.")
    const groups = [];
    for (const x of run.segs) {
      const g = groups[groups.length - 1];
      if (g && (!FEATURES.pausePieces || x.start - g.end < VERIFY_PAUSE_S)) { g.end = Math.max(g.end, x.end); g.segs.push(x); }
      else groups.push({ start: x.start, end: x.end, segs: [x] });
    }
    for (const r of groups) {
      const k = Math.max(1, Math.round((r.end - r.start) / VERIFY_WIN_S));
      const step = (r.end - r.start) / k;
      for (let i = 0; i < k; i++) {
        const w0 = r.start + i * step, w1 = i === k - 1 ? r.end : r.start + (i + 1) * step;
        const pieces = r.segs.map((x) => ({ start: Math.max(x.start, w0), end: Math.min(x.end, w1) })).filter((x) => x.end > x.start);
        const len = pieces.reduce((t, x) => t + (x.end - x.start), 0);
        if (len >= (FEATURES.pausePieces ? VERIFY_PIECE_MIN_S : VERIFY_MIN_S * 0.8)) wins.push({ run, w0, w1, pieces, len, speaker: run.speaker, from: run.speaker, short: FEATURES.pausePieces && len < VERIFY_SHORT_S });
      }
    }
  }
  if (!wins.length) return { segments, stats: { windows: 0 } };
  const embs = await embedClips(audio, wins.map((w) => w.pieces));
  wins.forEach((w, i) => { w.emb = embs[i]; });

  const voices = () => {
    const acc = new Map();
    for (const w of wins) {
      if (!isReal(w.speaker)) continue;
      const a = acc.get(w.speaker) || new Float32Array(w.emb.length);
      for (let d = 0; d < a.length; d++) a[d] += w.emb[d] * w.len;
      acc.set(w.speaker, a);
    }
    for (const [k, a] of acc) acc.set(k, normalize(a));
    // robust: a voice is re-averaged without its stretches that don't sound like it
    for (const [k, cen] of [...acc]) {
      const a = new Float32Array(cen.length);
      let used = 0;
      for (const w of wins) if (w.speaker === k && dot(w.emb, cen) >= 0.2) { for (let d = 0; d < a.length; d++) a[d] += w.emb[d] * w.len; used++; }
      if (used) acc.set(k, normalize(a));
    }
    return acc;
  };
  let moved = 0, toUnknown = 0, fromUnknown = 0;
  for (let pass = 0; pass < VERIFY_PASSES; pass++) {
    const cen = voices();
    if (cen.size < 2) break;
    for (const w of wins) {
      const own = isReal(w.speaker) ? dot(w.emb, cen.get(w.speaker)) : -1;
      let best = null, bs = -Infinity;
      for (const [k, c] of cen) { const v = dot(w.emb, c); if (v > bs) { bs = v; best = k; } }
      const margin = w.short ? VERIFY_SHORT_MARGIN : VERIFY_MARGIN, take = w.short ? VERIFY_SHORT_TAKE : VERIFY_TAKE_SIM;
      let second = -Infinity;
      for (const [k, c] of cen) if (k !== best) second = Math.max(second, dot(w.emb, c));
      if (FEATURES.unsure && pass === VERIFY_PASSES - 1 && bs < UNSURE_SIM && bs - second < UNSURE_MARGIN) w.speaker = UNKNOWN; // too close to call
      else if (best !== w.speaker && bs >= take && bs >= own + margin) w.speaker = best;
      else if (isReal(w.speaker) && own < VERIFY_LOST_SIM && bs < VERIFY_TAKE_SIM) w.speaker = UNKNOWN;
    }
  }
  // apply: a window that changed hands takes its pieces of speech with it
  const out = [];
  const changed = wins.filter((w) => w.speaker !== w.from);
  for (const w of changed) {
    if (isReal(w.from) && isReal(w.speaker)) moved++;
    else if (!isReal(w.speaker)) toUnknown++;
    else fromUnknown++;
  }
  const cuts = new Map(); // segment -> windows that changed inside it
  for (const w of changed) for (const sg of w.run.segs) if (sg.end > w.w0 && sg.start < w.w1) (cuts.get(sg) || cuts.set(sg, []).get(sg)).push(w);
  for (const sg of segments) {
    const ws = cuts.get(sg);
    if (!ws) { out.push(sg); continue; }
    // split the segment at the changed windows' edges
    let t = sg.start;
    for (const w of [...ws].sort((a, b) => a.w0 - b.w0)) {
      const a = Math.max(sg.start, w.w0), b = Math.min(sg.end, w.w1);
      if (a > t) out.push({ ...sg, start: t, end: a });
      out.push({ ...sg, start: a, end: b, speaker: w.speaker });
      t = b;
    }
    if (t < sg.end) out.push({ ...sg, start: t, end: sg.end });
  }
  return { segments: out.filter((x) => x.end - x.start > 0.01), stats: { windows: wins.length, moved, toUnknown, fromUnknown } };
}

// ---------- 3b. context smoothing ----------
// The segmentation model works on 10 s windows and can give a single word its own "voice" when the
// speaker's pitch, loudness or delivery changes for a moment. Such a stretch is often too short to
// fingerprint at first, so it ended up as "Unknown" (or as a different speaker) mid-sentence.
// Here every short, isolated run is re-checked with a fingerprint of that exact stretch and its
// neighbours: a moment sandwiched inside one person's speech stays with that person unless its voice
// clearly matches someone else. A different voice that recurs (e.g. "yeah", "right" from a listener)
// is kept as its own speaker, so genuine interjections survive.
async function smoothSpeakers(audio, allSegments, centroids, numSpeakers, totalSpeech) {
  const isReal = (s) => s && s !== UNKNOWN;
  // overlapping speech is left as it is: it belongs to nobody in particular
  const segments = allSegments.filter((s) => !s.overlap);
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const runs = [];
  for (const s of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end <= SMOOTH_JOIN_GAP_S) {
      last.end = Math.max(last.end, s.end);
      last.segs.push(s);
    } else runs.push({ speaker: s.speaker, start: s.start, end: s.end, segs: [s] });
  }
  const near = (a, b) => a && b && Math.max(a.start, b.start) - Math.min(a.end, b.end) <= SMOOTH_CONTEXT_GAP_S;

  const cands = [];
  runs.forEach((r, i) => {
    const dur = r.end - r.start;
    const prev = near(runs[i - 1], r) ? runs[i - 1] : null;
    const next = near(runs[i + 1], r) ? runs[i + 1] : null;
    const sandwich = prev && next && isReal(prev.speaker) && prev.speaker === next.speaker && prev.speaker !== r.speaker ? prev.speaker : null;
    // the segmentation itself heard a different voice here: inside the same 10 s chunk, this run's local voice
    // differs from the neighbouring run's (a reply, not just a pitch change of the same local voice)
    const edge = (a, b) => a && b && a.chunk != null && a.chunk === b.chunk && a.local && b.local && a.local !== b.local;
    const segDiff = r.segs.every((x) => x.local) && (edge(prev?.segs.at(-1), r.segs[0]) || edge(r.segs.at(-1), next?.segs[0]));
    // a short reply said over someone: never give it back to the person talking through it
    const replyOver = r.segs.find((x) => x.replyOver)?.replyOver || null;
    if (r.speaker === UNKNOWN ? dur <= SMOOTH_MAX_UNKNOWN_S : sandwich && dur <= SMOOTH_MAX_S) cands.push({ r, prev, next, sandwich, dur, segDiff, replyOver });
  });
  if (!cands.length) return { segments: allSegments, stats: { candidates: 0, reassigned: 0, newSpeakers: 0 } };

  const withEmb = cands.filter((c) => c.dur >= SMOOTH_EMB_MIN_S);
  const embs = await embedClips(audio, withEmb.map((c) => c.r.segs));
  withEmb.forEach((c, k) => { c.emb = embs[k]; });

  const sim = (emb, spk) => (centroids.has(spk) ? dot(emb, centroids.get(spk)) : -1);
  const bestKnown = (emb, except) => {
    let spk = null, s = -Infinity;
    for (const [name, cen] of centroids) {
      if (name === except) continue;
      const v = dot(emb, cen);
      if (v > s) { s = v; spk = name; }
    }
    return [spk, s];
  };
  const fallback = (c) => (c.noAbsorb ? UNKNOWN : c.sandwich || nearestNeighbour(c));
  function nearestNeighbour(c) {
    const opts = [c.prev, c.next].filter((x) => x && isReal(x.speaker));
    if (!opts.length) return null;
    opts.sort((a, b) => Math.max(a.start - c.r.end, c.r.start - a.end) - Math.max(b.start - c.r.end, c.r.start - b.end));
    return opts[0].speaker;
  }

  let reassigned = 0;
  const pending = [];
  const assign = (c, spk) => { if (spk && spk !== c.r.speaker) { c.r.speaker = spk; reassigned++; } };
  for (const c of cands) {
    if (c.replyOver) {
      // a reply over someone: the best other voice if it is similar enough, else Unknown (never the speaker it interrupts)
      if (isReal(c.r.speaker) && c.r.speaker !== c.replyOver) continue;
      const [other, s2] = c.emb ? bestKnown(c.emb, c.replyOver) : [null, -1];
      assign(c, other && s2 >= REPLY_TAKE_SIM ? other : UNKNOWN);
      continue;
    }
    if (c.sandwich && c.segDiff && FEATURES.segDiff) {
      // The segmentation heard a different voice. Keep it apart unless the voice clearly is the surrounding
      // speaker (one person's pitch change can still be split by the segmentation); if unsure, Unknown.
      if (!c.emb) continue;
      const simS = sim(c.emb, c.sandwich);
      const own = isReal(c.r.speaker) ? sim(c.emb, c.r.speaker) : -1;
      if (isReal(c.r.speaker) && own >= simS - 0.05) continue;
      const [other, simO] = bestKnown(c.emb, c.sandwich);
      if (other && simO >= ASSIGN_SIM && simO >= simS - 0.05) { assign(c, other); continue; }
      if (simS >= Math.max(0.35, own + SMOOTH_MARGIN)) { assign(c, c.sandwich); continue; }
      c.noAbsorb = true; // the segmentation heard someone else: never fall back to the surrounding speaker
      pending.push(c); // a voice nobody matches: may be a new / missing person (decided below), else Unknown
      continue;
    }
    if (c.sandwich) {
      if (!c.emb) { assign(c, c.sandwich); continue; } // too short to judge: context wins
      const simS = sim(c.emb, c.sandwich);
      if (isReal(c.r.speaker) && sim(c.emb, c.r.speaker) >= simS + SMOOTH_MARGIN) continue; // clearly the other known person
      const [other, simO] = bestKnown(c.emb, c.sandwich);
      if (other && simO >= ASSIGN_SIM && simO >= simS + SMOOTH_MARGIN) assign(c, other);
      else if (simS < OTHER_VOICE_SIM) pending.push(c); // clearly not the surrounding speaker
      else assign(c, c.sandwich);
    } else {
      // Unknown at a speaker change / edge
      if (!c.emb) {
        const nb = [c.prev, c.next].filter((x) => x && isReal(x.speaker) && Math.max(x.start - c.r.end, c.r.start - x.end) <= 0.5);
        if (nb.length === 1 || (nb.length === 2 && nb[0].speaker === nb[1].speaker)) assign(c, nb[0].speaker);
        continue;
      }
      const [spk, s] = bestKnown(c.emb, null);
      if (spk && s >= ASSIGN_SIM) assign(c, spk);
      else {
        const nb = nearestNeighbour(c);
        if (nb && sim(c.emb, nb) >= OTHER_VOICE_SIM) assign(c, nb);
        else pending.push(c);
      }
    }
  }

  // Voices that match nobody nearby. Only a *new person* if the evidence is strong: the moments sound
  // like each other (each close to the group's average voice), unlike every known speaker, recur, and
  // add up to a real share of the speech. Everything else goes back to its context (if brief) or
  // stays Unknown — noises, laughs and crosstalk must not become extra speakers.
  const newVoiceMinS = Math.max(NEW_VOICE_MIN_S, (totalSpeech || 0) * NEW_VOICE_MIN_SHARE);
  const groupLog = [];
  function voiceGroups(list) {
    const groups = [];
    for (const c of [...list].sort((a, b) => b.dur - a.dur)) {
      const g = groups.find((g) => dot(normalize(g.reduce((acc, o) => { for (let d = 0; d < acc.length; d++) acc[d] += o.emb[d]; return acc; }, new Float32Array(c.emb.length))), c.emb) >= NEW_VOICE_COHESION);
      if (g) g.push(c); else groups.push([c]);
    }
    return groups.map((g) => {
      const cen = normalize(g.reduce((acc, o) => { for (let d = 0; d < acc.length; d++) acc[d] += o.emb[d]; return acc; }, new Float32Array(g[0].emb.length)));
      const cohesion = Math.min(...g.map((o) => dot(o.emb, cen)));
      const knownSim = Math.max(-1, ...[...centroids.values()].map((k) => dot(cen, k)));
      const total = g.reduce((t, c) => t + c.dur, 0);
      groupLog.push({ n: g.length, total: +total.toFixed(2), cohesion: +cohesion.toFixed(3), knownSim: +knownSim.toFixed(3) });
      return { g, total, cohesion, knownSim, strong: cohesion >= NEW_VOICE_COHESION && knownSim < OTHER_VOICE_SIM };
    });
  }
  let newSpeakers = 0;
  if (pending.length) {
    if (!numSpeakers) {
      for (const { g, total, cohesion, knownSim, strong } of voiceGroups(pending)) {
        // a substantial new voice, or a short one that keeps coming back (e.g. a listener's "yeah", "right"): coming
        // back with the same voice is evidence of its own, so that case may be a little closer to a known voice
        const recurring = g.length >= NEW_VOICE_RECUR_N && total >= NEW_VOICE_RECUR_S && cohesion >= NEW_VOICE_RECUR_COHESION && knownSim < NEW_VOICE_RECUR_KNOWN;
        if ((strong || recurring) && g.length >= 2 && (total >= newVoiceMinS || recurring)) {
          const name = `SPEAKER_N${newSpeakers++}`;
          for (const c of g) assign(c, name);
        } else {
          for (const c of g) assign(c, c.dur < CORROBORATE_MIN_S ? fallback(c) || UNKNOWN : UNKNOWN);
        }
      }
    } else {
      // A chosen count: if fewer people were found than chosen, a recurring (or long enough) voice that
      // matches nobody becomes one of the missing speakers; otherwise it joins the closest known person.
      let room = Math.max(0, numSpeakers - centroids.size);
      const groups = voiceGroups(pending).sort((a, b) => b.total - a.total);
      for (const { g, total, strong, cohesion, knownSim } of groups) {
        // the user said more people are present, so a coherent unfamiliar voice may fill a missing slot (a bit
        // less strict than Auto: the voice must agree with itself and clearly not be anyone already known)
        if (room > 0 && (strong || (cohesion >= NEW_VOICE_RECUR_COHESION && knownSim < MISSING_SLOT_SIM)) && (g.length >= 2 || total >= CORROBORATE_MIN_S)) {
          const name = `SPEAKER_N${newSpeakers++}`;
          room--;
          for (const c of g) assign(c, name);
          continue;
        }
        for (const c of g) {
          const [spk, s] = bestKnown(c.emb, c.noAbsorb ? c.sandwich : null);
          assign(c, spk && s >= OTHER_VOICE_SIM ? spk : c.dur < CORROBORATE_MIN_S ? fallback(c) : c.noAbsorb ? UNKNOWN : spk || UNKNOWN);
        }
      }
    }
  }

  for (const r of runs) for (const s of r.segs) s.speaker = r.speaker;
  return { segments: allSegments, stats: { candidates: cands.length, reassigned, newSpeakers, pending: pending.length, groups: groupLog.slice(0, 20) } };
}

export async function diarize(audio, numSpeakers) {
  env.status('Finding speech…');
  const chunks = await segmentChunks(audio);
  env.lap('segmentation');
  env.onChunks?.(chunks);

  // speech the segmentation model didn't attribute (≥ 1 s of clearly loud audio) — may be a laugh,
  // a missed word or noise; it enters smoothing as Unknown instead of being dropped
  const rms = frameEnergy(audio);
  const rawSpeech = [];
  chunks.forEach((chunk) => { for (const s of chunk.segs) if (parts(s.label).length) rawSpeech.push({ start: s.start, end: s.end }); });
  rawSpeech.sort((a, b) => a.start - b.start);
  const fills = [];
  for (const r of energyRuns(rms)) for (const g of subtract(r, rawSpeech)) fills.push(g);

  // One person: speaker identity is known, so every bit of speech belongs to them.
  // Fills keep `fill: true`: they are transcribed as their own clips and must pass the no-speech check.
  if (numSpeakers === 1) {
    const segments = [...rawSpeech, ...fills.map((f) => ({ ...f, fill: true }))].map((s) => ({ ...s, speaker: 'SPEAKER_00' }));
    return { segments, stats: { mode: 'single' } };
  }

  const items = collectVoices(audio, chunks);
  env.status('Recognizing voices…');
  await embedVoices(audio, items);
  env.lap(`fingerprints (${items.filter((i) => i.emb).length})`);

  if (env.debugVoices) env.post({ type: 'debug', voices: items.map((it) => ({ key: it.key, chunk: it.chunk, dur: it.dur, emb: it.emb ? Array.from(it.emb) : null })) });
  env.status('Grouping voices into speakers…');
  const { names, centroids } = labelVoices(items, numSpeakers);
  env.lap('clustering');

  const segments = [];
  const overlapPairs = new Set(); // pairs of speakers heard talking at the same time somewhere: certainly two people
  const stretches = new Map(); // `${chunk}|${local}` -> [{ key, start, end }]
  for (const it of items) { const k = `${it.chunk}|${it.local}`; (stretches.get(k) || stretches.set(k, []).get(k)).push({ key: it.key, start: it.segs[0].start, end: it.segs.at(-1).end }); }
  const nameAt = (c, local, t) => {
    if (names.has(`${c}|${local}`)) return names.get(`${c}|${local}`);
    const list = stretches.get(`${c}|${local}`) || [];
    let best = null, bd = Infinity;
    for (const x of list) { const d = Math.max(0, x.start - t, t - x.end); if (d < bd) { bd = d; best = x; } }
    return best ? names.get(best.key) ?? UNKNOWN : UNKNOWN;
  };
  chunks.forEach((chunk, c) => {
    const segs = chunk.segs;
    segs.forEach((s, i) => {
      const ps = parts(s.label);
      if (!ps.length) return;
      if (ps.length === 1) { segments.push({ start: s.start, end: s.end, speaker: (s.key && names.get(s.key)) ?? nameAt(c, ps[0], s.start), chunk: c, local: ps[0] }); return; }
      // two voices at once
      const mid = (s.start + s.end) / 2;
      const g = ps.map((p) => nameAt(c, p, mid));
      if (g[0] !== UNKNOWN && g[1] !== UNKNOWN && g[0] !== g[1]) overlapPairs.add([...g].sort().join('|'));
      if (g[0] !== UNKNOWN && g[0] === g[1]) { segments.push({ start: s.start, end: s.end, speaker: g[0], chunk: c, local: ps[0] }); return; }
      if (FEATURES.overlap && s.end - s.start >= OVERLAP_MIN_S) { segments.push({ start: s.start, end: s.end, speaker: UNKNOWN, overlap: true, chunk: c }); return; }
      // Short: either a quick reply over someone who keeps talking ("of course", "yeah"), or the hand-over
      // between two people. The voice heard on both sides is the one talking through it; the other voice is
      // the reply. At a hand-over, the person who continues afterwards takes it.
      const single = (j) => { const x = segs[j]; return x && !isOverlap(x.label) && x.label !== 'NO_SPEAKER' && Math.abs((j < i ? s.start - x.end : x.start - s.end)) < 0.5 ? x.label : null; };
      const before = single(i - 1), after = single(i + 1);
      const main = before && before === after && ps.includes(before) ? before : null;
      if (main && FEATURES.reply) {
        const reply = ps.find((p) => p !== main);
        segments.push({ start: s.start, end: s.end, speaker: nameAt(c, reply, mid), chunk: c, local: reply, replyOver: nameAt(c, main, mid) });
      } else {
        const next = after && ps.includes(after) ? after : ps[0];
        segments.push({ start: s.start, end: s.end, speaker: nameAt(c, next, mid), chunk: c, local: next });
      }
    });
  });
  // One person split in two by a change in how they sound (much higher or lower, noise, another microphone): in
  // Auto, the two groups are merged only with strong evidence on both counts: their voices are similar AND they
  // never talk at the same time (one person can't overlap with themselves; two people in a conversation do).
  // With a chosen count nothing is merged here: the N biggest groups are already the people.
  let mergedSplits = 0;
  if (FEATURES.mergeSplits && !numSpeakers && centroids.size > 1) {
    const talk = new Map();
    for (const x of segments) if (!x.overlap && x.speaker !== UNKNOWN) talk.set(x.speaker, (talk.get(x.speaker) || 0) + x.end - x.start);
    const total = [...talk.values()].reduce((a, b) => a + b, 0) || 1;
    for (;;) {
      let best = null;
      for (const [a, ca] of centroids) for (const [b, cb] of centroids) {
        if (a >= b) continue;
        const sim = dot(ca, cb);
        if (sim < SPLIT_MERGE_SIM || overlapPairs.has([a, b].sort().join('|'))) continue;
        const small = (talk.get(a) || 0) <= (talk.get(b) || 0) ? a : b, big = small === a ? b : a;
        if ((talk.get(small) || 0) / total >= SPLIT_MERGE_MAX_SHARE) continue;
        if (!best || sim > best.sim) best = { sim, small, big };
      }
      if (!best) break;
      for (const x of segments) { if (x.speaker === best.small) x.speaker = best.big; if (x.replyOver === best.small) x.replyOver = best.big; }
      const wb = talk.get(best.big) || 1, ws = talk.get(best.small) || 1, cb = centroids.get(best.big), cs = centroids.get(best.small);
      centroids.set(best.big, normalize(cb.map((v, i) => v * wb + cs[i] * ws)));
      centroids.delete(best.small); talk.set(best.big, wb + ws); talk.delete(best.small);
      mergedSplits++;
    }
  }
  for (const f of fills) segments.push({ ...f, speaker: UNKNOWN, fill: true });

  env.status('Checking speaker changes…');
  const totalSpeech = segments.reduce((t, s) => t + (s.speaker === UNKNOWN ? 0 : s.end - s.start), 0);
  const smoothed = await smoothSpeakers(audio, segments, centroids, numSpeakers, totalSpeech);
  env.lap(`smoothing ${JSON.stringify(smoothed.stats)}`);
  if (FEATURES.mergeSplits && !numSpeakers) mergedSplits += foldNoisyGroups(smoothed.segments, rms, overlapPairs);
  const verified = await verifySpeakers(audio, smoothed.segments);
  env.lap(`verification ${JSON.stringify(verified.stats)}`);
  return { segments: verified.segments, stats: { ...smoothed.stats, verify: verified.stats, mergedSplits } };
}

// ---------- 3d. noisy splits ----------
// Signal-to-noise of a stretch from its own 100 ms frames: loud frames (speech) against the quiet frames between
// words (in a quiet room near silence, under background noise not). Returns the median over a speaker's stretches.
function foldNoisyGroups(segments, rms, overlapPairs) {
  const real = (x) => !x.overlap && x.speaker !== UNKNOWN;
  const runs = [];
  for (const x of [...segments].filter(real).sort((a, b) => a.start - b.start)) {
    const l = runs[runs.length - 1];
    if (l && l.speaker === x.speaker && x.start - l.end < 0.5) l.end = Math.max(l.end, x.end); else runs.push({ speaker: x.speaker, start: x.start, end: x.end });
  }
  const snr = (r) => {
    const f = []; for (let i = Math.floor(r.start * 10); i < Math.min(rms.length, Math.ceil(r.end * 10)); i++) f.push(rms[i]);
    if (f.length < 15) return null;
    f.sort((a, b) => a - b);
    return 20 * Math.log10((f[Math.floor(f.length * 0.9)] + 1e-6) / (f[Math.floor(f.length * 0.1)] + 1e-6));
  };
  const med = (a) => { const v = a.filter((x) => x != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const talk = new Map(); for (const r of runs) talk.set(r.speaker, (talk.get(r.speaker) || 0) + r.end - r.start);
  const total = [...talk.values()].reduce((a, b) => a + b, 0) || 1;
  let folded = 0;
  for (const [g, t] of [...talk].sort((a, b) => a[1] - b[1])) {
    if (t / total >= SPLIT_MERGE_MAX_SHARE) continue;
    const mine = med(runs.filter((r) => r.speaker === g).map(snr)), rest = med(runs.filter((r) => r.speaker !== g).map(snr));
    if (mine == null || rest == null || rest - mine < NOISY_DB) continue;
    // who is around it
    const around = new Map(); let n = 0;
    runs.forEach((r, i) => {
      if (r.speaker !== g) return;
      for (const o of [runs[i - 1], runs[i + 1]]) if (o && o.speaker !== g && Math.max(o.start - r.end, r.start - o.end) < 2) { around.set(o.speaker, (around.get(o.speaker) || 0) + 1); n++; }
    });
    const [x, c] = [...around].sort((a, b) => b[1] - a[1])[0] || [];
    if (!x || c / n < NOISY_NEIGHBOUR_SHARE || overlapPairs.has([g, x].sort().join('|'))) continue;
    for (const s of segments) if (s.speaker === g) s.speaker = x;
    for (const r of runs) if (r.speaker === g) r.speaker = x;
    talk.set(x, (talk.get(x) || 0) + t); talk.delete(g);
    folded++;
  }
  return folded;
}

// RMS energy in 100 ms frames; used to find speech the speaker model missed and to pick quiet cut points.
export function frameEnergy(audio) {
  const frame = SR / 10;
  const n = Math.floor(audio.length / frame);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * frame, end = j + frame; j < end; j++) sum += audio[j] * audio[j];
    rms[i] = Math.sqrt(sum / frame);
  }
  return rms;
}

export function energyRuns(rms) {
  if (!rms.length) return [];
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(floor * 3, 0.008);
  const runs = [];
  let start = -1;
  let quiet = 0;
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] > thr) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 3) {
      runs.push({ start: start / 10, end: (i - quiet + 1) / 10 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start: start / 10, end: rms.length / 10 });
  return runs.filter((r) => r.end - r.start >= MIN_GAP_SPEECH_S);
}

// Parts of `run` not covered by the (time-ordered) `speech` segments.
export function subtract(run, speech) {
  const out = [];
  let cur = run.start;
  for (const s of speech) {
    if (s.end <= cur) continue;
    if (s.start >= run.end) break;
    if (s.start > cur) out.push({ start: cur, end: s.start });
    cur = Math.max(cur, s.end);
  }
  if (cur < run.end) out.push({ start: cur, end: run.end });
  return out.filter((x) => x.end - x.start >= MIN_GAP_SPEECH_S);
}
