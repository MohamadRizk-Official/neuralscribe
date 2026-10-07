# NeuralScribe

Free, private transcription with speaker detection. Audio is processed 100% in your browser;
signed-in users can save the finished transcript text to their account.

Drop a voice note, MP3, M4A, MP4, WAV, OGG or WebM file and get a timestamped transcript
split by speaker ("Speaker 1", "Speaker 2", … or "Unknown" when it can't tell). Rename
speakers, click any line to play it, and export as `.txt` or `.srt`.

## How it works

Everything runs in a Web Worker on your device (WebGPU when available, CPU/WASM otherwise). Your audio
is never uploaded. Models download once from Hugging Face and are cached by the browser.

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
