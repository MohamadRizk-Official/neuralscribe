# NeuralScribe

Free, private transcription with speaker detection — runs 100% in your browser.

Drop a voice note, MP3, M4A, MP4, WAV, OGG or WebM file and get a timestamped transcript
split by speaker ("Speaker 1", "Speaker 2", … or "Unknown" when it can't tell). Rename
speakers, click any line to play it, and export as `.txt` or `.srt`.

## How it works

- **Whisper** (OpenAI, via [Transformers.js](https://github.com/huggingface/transformers.js)) turns speech into words with timestamps.
- **pyannote segmentation 3.0** detects who is speaking when.
- Both models run inside a Web Worker on your device (WebGPU when available, CPU/WASM otherwise).
  Nothing is uploaded anywhere. Models are downloaded once from Hugging Face and cached by the browser.
- Short files are decoded by the browser itself. Long recordings (15+ minutes) and unusual formats are
  converted by FFmpeg compiled to WebAssembly (`public/ffmpeg/`, one-time ~32 MB download), so an
  hour-long voice message works. Speaker detection runs in 4-minute windows that are stitched together,
  so memory stays flat no matter how long the file is.

## Run locally

```bash
npm install
npm run dev
```

## Build / deploy

```bash
npm run build   # outputs to dist/
```

Deployed on Vercel — zero config, static site.

## Notes & limits

- First run downloads the chosen model (Tiny ≈ 40 MB, Base ≈ 75 MB, Small ≈ 250 MB, Large v3 Turbo ≈ 1 GB).
- Speaker detection distinguishes voices but cannot know names — rename them yourself.
- Long recordings take a while on CPU; a GPU (Chrome/Edge with WebGPU) is much faster.
- Speaker detection works best with up to 3 clearly different voices and little overlap.
