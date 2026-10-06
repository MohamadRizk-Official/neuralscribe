// Turn any audio/video file into 16 kHz mono Float32 samples — what Whisper and pyannote expect.
//
// Two paths:
//  1. Fast path: the browser's own decoder (decodeAudioData). Great for short files, but it
//     unpacks the entire file into raw memory at once, so it dies on long recordings and on
//     codecs the browser doesn't ship.
//  2. Robust path: FFmpeg compiled to WebAssembly. Handles every format and streams the
//     conversion, so an hour-long voice message is fine. Costs a one-time ~32 MB download.
export const SAMPLE_RATE = 16000;

const FAST_PATH_MAX_SECONDS = 15 * 60; // beyond this, go straight to FFmpeg
const FAST_PATH_MAX_BYTES = 40 * 1e6;

export async function decodeToMono16k(file, onStatus = () => {}, { forceFFmpeg = false } = {}) {
  const duration = await probeDuration(file); // null if the browser can't even read the header
  const useFast = !forceFFmpeg && duration !== null && duration <= FAST_PATH_MAX_SECONDS && file.size <= FAST_PATH_MAX_BYTES;

  if (useFast) {
    try {
      onStatus('Decoding audio…');
      return await decodeWithBrowser(file);
    } catch (err) {
      console.warn('Browser decode failed, falling back to FFmpeg:', err);
    }
  }
  return decodeWithFFmpeg(file, onStatus);
}

// Ask an <audio> element for the duration without decoding the whole file.
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('audio');
    a.preload = 'metadata';
    const done = (v) => { URL.revokeObjectURL(url); a.src = ''; resolve(v); };
    const timer = setTimeout(() => done(null), 6000);
    a.onloadedmetadata = () => { clearTimeout(timer); done(Number.isFinite(a.duration) ? a.duration : null); };
    a.onerror = () => { clearTimeout(timer); done(null); };
    a.src = url;
  });
}

async function decodeWithBrowser(file) {
  const bytes = await file.arrayBuffer();
  const probe = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(bytes);
  } finally {
    probe.close().catch(() => {});
  }
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded; // the offline context resamples + mixes to mono for us
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), duration: decoded.duration };
}

let ffmpegPromise = null;
async function getFFmpeg(onStatus) {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');
    const ff = new FFmpeg();
    const base = `${location.origin}/ffmpeg`;
    onStatus('Loading audio converter (one-time ~32 MB download)…');
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ff;
  })();
  ffmpegPromise.catch(() => { ffmpegPromise = null; });
  return ffmpegPromise;
}

async function decodeWithFFmpeg(file, onStatus) {
  const ff = await getFFmpeg(onStatus);
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'bin').toLowerCase();
  const inName = `in.${ext}`;
  const outName = 'out.f32';

  let lastPct = -1;
  const onProgress = ({ progress }) => {
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (pct !== lastPct) { lastPct = pct; onStatus(`Converting audio… ${pct}%`); }
  };
  ff.on('progress', onProgress);
  try {
    onStatus('Converting audio…');
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    // -vn: drop video, mono, 16 kHz, raw 32-bit float samples (no WAV header to parse)
    const code = await ff.exec(['-i', inName, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', outName]);
    if (code !== 0) throw new Error(`FFmpeg could not read this file (exit code ${code}).`);
    const data = await ff.readFile(outName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    // Copy into a fresh buffer so the samples outlive FFmpeg's memory.
    const samples = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!samples.length) throw new Error('FFmpeg produced no audio. Is there an audio track in this file?');
    return { samples, duration: samples.length / SAMPLE_RATE };
  } finally {
    ff.off('progress', onProgress);
    await ff.deleteFile(inName).catch(() => {});
    await ff.deleteFile(outName).catch(() => {});
  }
}

// Downsample to N peaks for drawing a waveform.
export function peaks(samples, n = 400) {
  const block = Math.max(1, Math.floor(samples.length / n));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let max = 0;
    const start = i * block;
    const end = Math.min(samples.length, start + block);
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}
