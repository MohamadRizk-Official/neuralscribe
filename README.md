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

Deployed on Vercel as a static site.

## Locking the deployed site to your GitHub collaborators

`middleware.js` runs in front of every request. A visitor needs a signed session cookie, which
`/api/auth/callback` only issues after GitHub confirms the signed-in account has **write access
to this repository** (owner, collaborator or team with push). Add someone as a collaborator on GitHub
and they can open the site; remove them and their next sign-in (or within 7 days) is refused.

The gate fails closed: if any setting below is missing, nobody gets in.

1. Create a GitHub OAuth app (Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://<your-site>.vercel.app`
   - Authorization callback URL: `https://<your-site>.vercel.app/api/auth/callback`
2. Add these Production environment variables in Vercel:

| Name | Value |
| --- | --- |
| `GITHUB_CLIENT_ID` | from the OAuth app |
| `GITHUB_CLIENT_SECRET` | from the OAuth app (keep private) |
| `GITHUB_REPO` | `owner/repo` whose collaborators may enter |
| `CANONICAL_HOST` | `<your-site>.vercel.app` |
| `SESSION_SECRET` | a long random string, e.g. `openssl rand -hex 32` |

3. Turn Vercel's own Deployment Protection off (the gate replaces it) and redeploy.

The repository must stay public (or the sign-in scope must be widened), because the check reads the
signed-in user's permissions on the repo. To work on the gate locally, run `vercel dev` with the same
variables in `.env.local`.
