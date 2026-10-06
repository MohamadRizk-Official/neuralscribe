// Decode any audio/video file the browser understands (mp3, m4a, mp4, wav, ogg, webm…)
// into 16 kHz mono Float32 samples — the format Whisper and pyannote expect.
export const SAMPLE_RATE = 16000;

export async function decodeToMono16k(file) {
  const bytes = await file.arrayBuffer();

  // Decode at native rate first (OfflineAudioContext needs a length up front,
  // and decodeAudioData on an AudioContext gives us the true duration).
  const probe = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(bytes.slice(0));
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
