// Audio analysis + conservative preprocessing. Pure functions on 16 kHz mono Float32 samples.
//
// Nothing here changes the user's file: the app keeps the original File for playback and saving,
// and these functions only work on the decoded processing copy. Sample count never changes, so
// every timestamp still maps 1:1 to the original recording.

const FRAME = 480; // 30 ms at 16 kHz
const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

function frameLevels(x) {
  const n = Math.floor(x.length / FRAME);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * FRAME, e = j + FRAME; j < e; j++) s += x[j] * x[j];
    db[i] = toDb(Math.sqrt(s / FRAME));
  }
  return db;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

// Real measurements only. Echo/reverb and overlapping speech are NOT measured here.
export function analyzeAudio(x) {
  const db = frameLevels(x);
  if (!db.length) return { rating: 'difficult', issues: ['Recording is too short'], measured: {} };
  const sorted = Float32Array.from(db).sort();
  const noiseDb = percentile(sorted, 0.1); // quietest 10% of 30 ms frames ≈ background level
  const speechDb = percentile(sorted, 0.9); // loudest 10% ≈ speech level
  const snrDb = speechDb - noiseDb;
  let active = 0;
  for (const v of db) if (v > Math.max(noiseDb + 10, -55)) active++;
  const speechRatio = active / db.length;

  let peak = 0, clipped = 0, run = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) { if (++run >= 2) clipped++; } else run = 0; // flat tops of ≥2 samples, not single peaks
  }
  const clippedRatio = clipped / x.length;

  const issues = [];
  let score = 0; // 0 good, 1 fair, 2 difficult
  const flag = (sev, text) => { issues.push(text); score = Math.max(score, sev); };
  if (speechRatio < 0.03) flag(2, 'Very little speech detected');
  if (snrDb < 10) flag(2, 'Strong background noise');
  else if (snrDb < 22) flag(1, 'Some background noise');
  if (speechDb < -45) flag(2, 'Very quiet recording');
  else if (speechDb < -35) flag(1, 'Quiet recording');
  if (clippedRatio > 0.01) flag(2, 'Heavy distortion (clipping)');
  else if (clippedRatio > 0.001) flag(1, 'Some distortion (clipping)');

  return {
    rating: ['good', 'fair', 'difficult'][score],
    issues,
    measured: {
      speechLevelDb: +speechDb.toFixed(1),
      noiseLevelDb: +noiseDb.toFixed(1),
      snrDb: +Math.min(snrDb, 60).toFixed(1), // digital silence gives absurd values; 60 dB is already 'no audible noise'
      peakDb: +toDb(peak).toFixed(1),
      clippedPercent: +(clippedRatio * 100).toFixed(3),
      speechPercent: Math.round(speechRatio * 100),
    },
  };
}

// 2nd-order Butterworth high-pass (RBJ biquad), in place.
function highpass(x, hz, sr = 16000) {
  const w = (2 * Math.PI * hz) / sr, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, b2 = (1 + c) / 2 / a0, a1 = (-2 * c) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; x[i] = v;
  }
}

// Conservative, speech-safe cleanup of the processing copy (in place):
//   1. remove DC offset
//   2. 70 Hz high-pass: removes rumble (car, AC, handling noise) below the lowest voice fundamentals
//   3. level normalisation: bring speech to about -20 dBFS (max +24 dB), never pushing peaks past -0.2 dBFS
// No denoising / spectral subtraction: that can smear consonants and make Whisper worse.
export function preprocess(x, analysis) {
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  if (Math.abs(mean) > 1e-6) for (let i = 0; i < x.length; i++) x[i] -= mean;

  highpass(x, 70);

  const speechDb = analysis?.measured?.speechLevelDb ?? -20;
  let gainDb = Math.max(-6, Math.min(24, -20 - speechDb));
  // headroom: keep the 99.95th-percentile sample under -0.2 dBFS; rarer spikes are soft-limited
  const step = Math.max(1, Math.floor(x.length / 200000));
  const sample = [];
  for (let i = 0; i < x.length; i += step) sample.push(Math.abs(x[i]));
  sample.sort((a, b) => a - b);
  const p = percentile(sample, 0.9995) || 1e-9;
  gainDb = Math.min(gainDb, toDb(0.977 / p));
  if (Math.abs(gainDb) >= 0.5) {
    const g = 10 ** (gainDb / 20);
    for (let i = 0; i < x.length; i++) {
      const v = x[i] * g;
      x[i] = Math.abs(v) <= 0.9 ? v : Math.sign(v) * (0.9 + 0.1 * Math.tanh((Math.abs(v) - 0.9) / 0.1));
    }
  } else gainDb = 0;
  return { dcRemoved: true, highpassHz: 70, gainDb: +gainDb.toFixed(1) };
}
