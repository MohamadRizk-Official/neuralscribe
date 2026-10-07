# NeuralScribe

Free, private transcription with speaker detection — runs 100% in your browser.

Drop a voice note, MP3, M4A, MP4, WAV, OGG or WebM file and get a timestamped transcript
split by speaker ("Speaker 1", "Speaker 2", … or "Unknown" when it can't tell). Rename
speakers, click any line to play it, and export as `.txt` or `.srt`.

## How it works

Everything runs in a Web Worker on your device (WebGPU when available, CPU/WASM otherwise). Nothing is
uploaded. Models download once from Hugging Face and are cached by the browser.

1. **Find speech** — pyannote segmentation 3.0 runs on 10-second chunks and marks where each (local) voice speaks.
2. **Voice fingerprints** — WeSpeaker ResNet34 turns each voice in each chunk into a 256-number embedding.
3. **Group into speakers** — average-linkage clustering on cosine distance groups the fingerprints across the
   whole file, so a person keeps the same label even after being silent for an hour. If you tell it how many
   people there are, it stops at exactly that many. Voices too brief to fingerprint are labelled **Unknown**.
4. **Transcribe** — the audio is cut into speaker turns (silence skipped) and **Whisper** transcribes many turns
   at once in batches. Each turn already knows its speaker.

Long recordings (15+ minutes) and unusual formats are converted with FFmpeg compiled to WebAssembly
(`public/ffmpeg/`, one-time ~32 MB download).

On a laptop GPU a 1.5-hour, 5-person meeting takes about 2½ minutes with the base model.

## In the app

- Speaker timeline — click anywhere to jump there
- Rename speakers; click the name above any paragraph to fix a wrong label; merge two speakers
- Search (`/` to focus, Enter / Shift+Enter to step through matches)
- Player: space to play/pause, ← / → to skip, speed control, auto-follow
- Export as .txt or .srt

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
