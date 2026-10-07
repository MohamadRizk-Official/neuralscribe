# NeuralScribe

Free, private transcription with speaker detection. Audio is processed 100% in your browser;
signed-in users can save the finished transcript text to their account.

Drop a voice note, MP3, M4A, MP4, WAV, OGG or WebM file and get a timestamped transcript
split by speaker ("Speaker 1", "Speaker 2", … or "Unknown" when it can't tell). Rename
speakers, click any line to play it, and export as `.txt` or `.srt`.

## How it works

Everything runs in a Web Worker on your device (WebGPU when available, CPU/WASM otherwise). Your audio
is never uploaded. Models download once from Hugging Face and are cached by the browser.

### Modes

| Mode | GPU (WebGPU) | CPU only | Extra work |
| --- | --- | --- | --- |
| **Fast** | Whisper base (fp16/fp32 encoder, 4-bit decoder) | Whisper base (8-bit) | – |
| **Best Accuracy** (default) | Whisper large-v3-turbo, 4-bit weights / fp16 maths (`q4f16`, ≈565 MB) | Whisper small (8-bit) | second pass on segments Whisper is unsure about |

Advanced settings can override the model (tiny / base / small / large-v3-turbo). large-v3-turbo is GPU-only: on a
CPU it needed 2½ minutes just to detect the language of three short clips. The `q4f16` turbo weights were chosen by
measurement: 1.0 % vs 0.9 % WER for the 1.6 GB fp16 version on the synthetic set, at a third of the download.

### Pipeline

0. **Decode** to 16 kHz mono (browser decoder, or FFmpeg/WASM for long or unusual files). The original file is
   kept untouched for playback and saving.
1. **Analyse** the recording: speech level, background level (speech-to-noise), clipping and how much of it is
   speech → *Good / Fair / Difficult* with the measured values. Echo/reverb and overlapping speech are not measured.
2. **Preprocess a working copy** (same length, so every timestamp still maps 1:1 to the original): remove DC offset,
   70 Hz high-pass (rumble), normalise speech to ≈ −20 dBFS (max +24 dB, peaks soft-limited). No denoising.
3. **Find speech + speakers** — pyannote segmentation 3.0 on 10 s chunks, WeSpeaker ResNet34 voice fingerprints,
   average-linkage clustering across the whole file (or exactly *N* speakers if chosen). Voices too brief to
   fingerprint are labelled **Unknown**. With speaker labels off, an energy-based detector finds speech instead.
4. **Chunk** into speaker turns (silence skipped). Turns longer than 27.5 s are split at the quietest 300 ms between
   16 s and 27.5 s; if even that is speech, both pieces share 1 s of audio and the words transcribed twice are removed
   afterwards (`src/engine/merge.js`). Every segment keeps its original start/end time.
5. **Language** — fixed if the user picks one. On Auto-detect, Whisper's language probabilities are read for up to
   8 clips spread across the file and weighted by length. If a second language holds a real share (≥ 15 %, or one
   clip ≥ 3 s that is clearly in it, e.g. Arabic + English), each turn may choose among those languages only, and
   the task is forced to *transcribe* (never translate).
6. **Transcribe** turns in batches with Whisper. *Important words* become a Whisper prompt
   (`<|startofprev|>` + the words), the same mechanism as OpenAI's `initial_prompt`.
7. **Second pass (Best Accuracy)** — for each turn, Whisper's own average token log-probability and the text's
   compression ratio are recorded (`src/engine/decoding.js`). Turns below −1.0 avg log-prob, above 2.4 compression
   (repetition), hitting the token limit, or that look like the important-words prompt leaking into a short clip are
   retried (without the prompt, then sampling at temperature 0.2 and 0.5); a retry is kept only if it scores better.
   Turns still below the threshold are marked "worth double-checking" in the transcript. No percentages are shown.

Long recordings (15+ minutes) and unusual formats are converted with FFmpeg compiled to WebAssembly
(`public/ffmpeg/`, one-time ~32 MB download).

### Known limitations

- Whisper sees one speaker turn at a time (≤ 30 s), without the previous turn's text as context.
- Language is chosen per turn, so a switch *inside* one turn (code-switching mid-sentence) is transcribed in one language.
- Important words are a hint, not a guarantee, and very long word lists are trimmed to the last ~100 tokens.
- Speaker detection can merge similar voices or split one voice; it can be fixed by hand in the transcript.
- The audio-quality check cannot detect echo/reverb or overlapping speakers.
- Accuracy numbers in `accuracy/results/` come from synthetic speech and are regression checks only.

See [accuracy/README.md](accuracy/README.md) for measuring accuracy on real recordings.

## In the app

- Speaker timeline — click anywhere to jump there; click any timestamp or paragraph to play from there
- Rename speakers; click the name above any paragraph to fix a wrong label; merge two speakers
- Search (`/` to focus, Enter / Shift+Enter to step through matches)
- Player: space to play/pause, ← / → to skip, speed control, auto-follow
- Export as .txt or .srt

## Accounts & saved transcripts (Supabase)

Optional. Without the two variables below the app works exactly as before, with account features hidden.

- **Pages:** `/auth` (sign in, sign up, forgot/reset password, Google), `/auth/callback`, `/library`, `/transcript?id=…`.
- **Client:** `@supabase/supabase-js` in the browser with the PKCE flow (`src/lib/supabase.js`). There is no
  server code; all protection is enforced by Postgres Row Level Security.
- **Saving:** when a signed-in user finishes a transcription it is saved automatically (title, duration,
  language and the transcript in the same format as the .txt export). Later speaker renames sync to the saved copy.
  Signed-out users can choose "Sign in to save": the transcript waits in that browser's localStorage and is
  saved right after sign-in.
- **Privacy:** audio never leaves the device. Only transcript text and its metadata are stored, and only for
  signed-in users.

### Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (Production) + `.env.local` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel (Production) + `.env.local` | the `sb_publishable_…` key |

Vite is configured (`envPrefix`) to expose only `VITE_*` / `NEXT_PUBLIC_*` variables to the browser.
**Never** put the secret / service-role key in either prefix. Copy `.env.example` to `.env.local` for local
development; `.env*` files are git-ignored.

### Database

The schema lives in `supabase/migrations/`. Apply it with the Supabase CLI (`supabase db push`) or by pasting
the SQL into the dashboard's SQL editor. It creates `profiles`, `transcriptions`, `usage` and `subscriptions`,
a trigger that creates a profile for every new auth user, indexes, column privileges and RLS policies:

- users can read and edit only their own profile (`display_name`, `avatar_url` only)
- users can read, create, edit and delete only their own transcriptions; `user_id` always comes from `auth.uid()`
- `usage` and `subscriptions` are read-only for users; only trusted server code (service role) may write them
- signed-out visitors (`anon`) have no access to any of these tables

### Supabase dashboard settings (one-time)

- Authentication → URL Configuration: **Site URL** = your production URL; **Redirect URLs** include
  `https://<your-domain>/**` and `http://localhost:5173/**`.
- Authentication → Sign In / Providers → Google: enable it with a Google OAuth client whose authorised redirect
  URI is `https://<project-ref>.supabase.co/auth/v1/callback`.

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
