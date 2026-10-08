# SparkScribe

Free, private transcription with speaker detection. Audio is processed 100% in your browser;
signed-in users can save the finished transcript text to their account, and turn it into a summary, key points,
chapters, action items and answers (from the transcript text only; audio is never sent anywhere).

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
CPU it needed 2½ minutes just to process three short clips. The `q4f16` turbo weights were chosen by
measurement: 1.0 % vs 0.9 % WER for the 1.6 GB fp16 version on the synthetic set, at a third of the download.

### Pipeline

0. **Decode** to 16 kHz mono (browser decoder, or FFmpeg/WASM for long or unusual files). The original file is
   kept untouched for playback and saving.
1. **Analyse** the recording: speech level, background level (speech-to-noise), clipping and how much of it is
   speech → *Good / Fair / Difficult* with the measured values. Echo/reverb and overlapping speech are not measured.
2. **Preprocess a working copy** (same length, so every timestamp still maps 1:1 to the original): remove DC offset,
   70 Hz high-pass (rumble), normalise speech to ≈ −20 dBFS (max +24 dB, peaks soft-limited). No denoising.
3. **Find speech + speakers** — pyannote segmentation 3.0 on 10 s chunks, WeSpeaker ResNet34 voice fingerprints,
   average-linkage clustering across the whole file (or exactly *N* speakers if chosen). With speaker labels off,
   an energy-based detector finds speech instead.
   - **Expected speakers = 1**: every speech region is that one speaker; no voice comparison is done, so pitch,
     whisper, laughter or a louder word can never create a second speaker. Silence/noise stays non-speech.
   - **Context smoothing** (`smoothSpeakers` in `src/worker.js`): short pieces are re-checked against their
     neighbours. Candidates are Unknown pieces ≤ 3 s and pieces ≤ 1.5 s that sit between two turns of the *same*
     other speaker (each neighbour within 1.5 s). Pieces ≥ 0.25 s get a voice fingerprint; a piece keeps its own
     label only if it matches that voice at least 0.10 (cosine) better than the surrounding speaker — so a genuine
     "yeah" from another person survives, while a pitch-shifted word of the main speaker rejoins them. Pieces too
     short to fingerprint take the surrounding speaker. Unknown pieces go to the closest known voice (similarity
     ≥ 0.25), else a neighbour within 0.5 s (no fingerprint) or one whose voice is at least loosely similar (≥ 0.15).
   - **New voices** (Auto): pieces unlike every known speaker (< 0.15) are grouped by fingerprint (≥ 0.50 to the
     group). A group becomes a new speaker if it has ≥ 2 pieces and ≥ max(1.5 s, 0.5 % of the speech), or ≥ 3
     pieces totalling ≥ 1 s that are very consistent (≥ 0.60) — the typical pattern of short interjections.
     With a chosen speaker count, such groups fill only the missing speaker slots.
   - **Unknown** is kept only where the evidence is genuinely insufficient: a voice ≥ 0.5 s that matches no
     speaker and no consistent group. It is never hidden in the transcript.
4. **Chunk** into speaker turns (silence skipped). Recognised speech and "only loud" stretches the speech detector
   did not recognise as a voice (tapping, noise, breath — or a missed word) are never merged into one clip; the loud
   stretches are transcribed separately and must pass the no-speech check. Turns longer than 27.5 s are split at the
   quietest 300 ms between 16 s and 27.5 s; if even that is speech, both pieces share 1 s of audio and the words
   transcribed twice are removed afterwards (`src/engine/merge.js`). Every segment keeps its original start/end time.
5. **English only (V1).** Every clip is decoded with `<|en|>` + `<|transcribe|>`: English speech → English text.
   No language detection, never Whisper's *translate* task.
6. **Transcribe** turns in batches with Whisper, each clip under `WhisperControl` (`src/engine/decoding.js`):
   - output is read only up to that clip's `<|endoftext|>` (Transformers.js keeps stepping finished rows until the
     whole batch is done — reading past the end is what once produced "so, so, so…" / "m m m…");
   - Whisper's **no-speech probability** (`<|nospeech|>` after `<|startoftranscript|>`) is recorded; a clip with
     no-speech > 0.6 and avg log-prob < −1.0 (OpenAI's rule), or a "loud only" clip with no-speech > 0.5, gives no text;
   - a **token budget** from the clip's own length (7 tokens/s + 12) instead of the batch's longest clip;
   - a **loop guard**: a single token repeated 8+ times or a 2–8 token unit repeated 6+ times stops the clip, and
     the run is removed (`src/engine/loops.js`; one copy of a repeated phrase is kept, none of a repeated filler).
     Emphasis like "no, no, no" or "very, very important" is far below these limits and kept as said.
   *Important words* become a Whisper prompt (`<|startofprev|>` + the words), like OpenAI's `initial_prompt`.
   No previous-text context is carried between clips, so one bad clip cannot poison the next.
7. **Second pass (Best Accuracy)** — for each turn, Whisper's own average token log-probability and the text's
   compression ratio are recorded. Turns below −1.0 avg log-prob, above 2.4 compression, stopped by the loop guard
   or the token budget, or that look like the important-words prompt leaking into a short clip are retried (without
   the prompt, then sampling at temperature 0.2 and 0.5); a retry is kept only if it is loop-free and scores better.
   Turns still below the threshold, or where a loop was cut, are marked "worth double-checking". No percentages.

Long recordings (15+ minutes) and unusual formats are converted with FFmpeg compiled to WebAssembly
(`public/ffmpeg/`, one-time ~32 MB download).

### Known limitations

- Whisper sees one speaker turn at a time (≤ 30 s), without the previous turn's text as context.
- English only in V1: speech in other languages is not supported (and is never translated).
- Important words are a hint, not a guarantee, and very long word lists are trimmed to the last ~100 tokens.
- Speaker detection can merge similar voices or split one voice; it can be fixed by hand in the transcript.
- The audio-quality check cannot detect echo/reverb or overlapping speakers.
- Accuracy numbers in `accuracy/results/` come from synthetic speech and are regression checks only.

See [accuracy/README.md](accuracy/README.md) for measuring accuracy on real recordings.

## In the app

- Speaker timeline — click anywhere to jump there; click any timestamp or paragraph to play from there
- Rename speakers; click the name above any paragraph to fix a wrong label; merge two speakers
- Search (`/` to focus, Enter / Shift+Enter to step through matches)
- Player: space to play/pause, ← / → to skip, speed control, volume slider + mute (`M`, remembered for the
  browser session), auto-follow. Volume only affects playback — transcription uses its own decoded copy of the file.
- Export as .txt or .srt
- **Original / Clean** transcript view. Clean removes hesitations (um, uh, erm…), directly repeated words and short
  repeated phrases, and stutters, by fixed rules (`src/lib/clean.js`): it can only delete, never add or reword, so
  it can't change meaning. The original is never modified and is what gets saved; exports follow the view on screen.
- **Tabs:** Transcript · Summary · Notes · Ask · Create (below). One recording type per recording, set from the compact "Type" control in the header (or automatic).
- **My Library:** search across every saved transcript with timestamps, folders, favorites, filters (below).
- **Create:** study guides, flashcards, quizzes, meeting recaps, drafts and exports (below).

## Summary, Notes and Ask

Built on top of a saved transcript; the transcript stays the source of truth. Requires a signed-in user.

| Tab | What | When it's generated |
| --- | --- | --- |
| Summary | short summary (TL;DR for voice messages), key points, chapters (recordings ≥ 8 min) | automatically after a fresh transcription once the user has turned summaries on once (first time: one click); otherwise on click |
| Summary | detailed summary, structured for the recording type | on click |
| Notes | everything extracted and organized from the recording: topic notes plus the structured sections that used to be the Insights tab — General: main topics, actions, decisions, dates & times, ideas, priorities, concerns · Meeting: discussion topics, decisions, action items (owner / deadline only when said), dates, open questions, follow-ups · Lecture: topics, concepts, examples, definitions, explicit exam information (needs exam wording) vs worth reviewing · Interview: Q&A, important quotes, takeaways, themes · Podcast: topics, arguments, takeaways, quotes · Voice Message: key information, requested actions, dates & times. Only sections with content are shown, and each item appears once | on click ("Organize notes"), or automatically when a recording type was chosen before transcribing |
| Ask | questions answered only from the recording, with clickable timestamp citations, streamed | per question |

**Recording type** (General, Lecture, Meeting, Interview, Podcast, Voice Message) is optional: pick it in Advanced
settings before transcribing or from the Type control in the recording header. With no type chosen, SparkScribe suggests one from the length and number of speakers ("Auto", no AI). It decides how Notes are organized and which Create tools are offered; the transcript never changes. It is stored on the transcript.

**Grounding.** The model sees each transcript line as `[id] m:ss Speaker: text` and cites line ids, never
timestamps. The server (`server/ai/grounding.js`) keeps only ids that exist (for Ask: only ids it actually sent),
drops any item without a valid line, drops "quotes" that don't appear word for word in the cited lines, drops
decisions and action items whose supporting words (`evidence`) aren't word for word in the cited lines, and builds
chapter times from real lines. Prompts (`server/ai/prompts.js`) share one rule set for every feature: keep the
speakers' own hedges and frequency words (sometimes ≠ often, might ≠ will, suggested ≠ agreed), no outside
knowledge, quotation marks only around exact words, a decision only where agreement is stated, owner/deadline only
when said ("Not specified" otherwise), and speakers named only by their transcript labels. Ask may reason from what was said
when a question calls for it ("What does he want from me?", "Does this seem urgent?"), but keeps explicit statements and
inference apart ("He said…" vs "It sounds like…"), cites the lines behind an inference, never claims to have heard tone
of voice (the model only gets text), and answers questions the recording doesn't cover specifically ("No deadline was
mentioned.") without outside knowledge. Follow-ups ("Why?") use the last few turns for context, never as evidence. An
answer that states something without any citation is labelled as unsupported. Speaker labels are never turned into guessed
names, and relative dates ("next Friday") are kept as said.

**Retrieval (Ask).** Transcripts up to ~7k tokens (≈ 25–30 min) are sent whole. Longer ones: a cheap call expands
the question into likely keywords, BM25 scores ~75-second chunks of the transcript, chunks get boosted for a speaker
named in the question, for "this part" (current playback position) and for lines behind already-extracted insights
that match the question's intent (decisions, deadlines…); the best chunks plus their neighbours are sent, up to
~6k tokens, with "…" marking gaps. No embeddings or vector store: segments are retrieved on the fly from the stored
transcript, so nothing extra is stored or regenerated (`server/ai/retrieve.js`).

**Caching & staleness.** Results are stored in `transcription_insights` (one row per transcript, kind and recording
type) and Ask answers in `transcription_questions`. Reopening a recording reads them; nothing regenerates by
itself. Identical questions on the same transcript version are answered from storage. `transcriptions.content_version`
is bumped by a database trigger whenever the text or segments change (e.g. a speaker rename); results from an older
version are shown with an "out of date — Update" notice instead of as current.

**Long transcripts.** Each prompt stays under ~80k tokens (Haiku 5.5's cheaper price band is ≤ 100k); longer
transcripts are analysed in parts and the partial results merged in one more call.

**Model & cost.** Claude Haiku 5.5 (`claude-haiku-5-5`) for everything, called only from the server
(`server/ai/`). Per-task overrides: `AI_MODEL_SUMMARY`, `AI_MODEL_INSIGHTS`, `AI_MODEL_ASK` (or `AI_MODEL` for all).
At $0.10 / $0.50 per million input / output tokens, a 1-hour recording (~15k tokens) costs roughly $0.002–0.005
per summary or insight set and about $0.001–0.002 per question (thinking tokens included in output).

**Privacy.** Only transcript text (plus length and speaker labels) is sent to Anthropic, and only when one of these
features runs. Audio is never sent. API keys stay on the server.

## Create: study tools, outputs and exports

The **Create** tab on a saved recording (`src/insights/tools.js`, server `server/ai/tools.js`, endpoint `api/tools.js`)
turns it into finished material. What it offers depends on the recording type; nothing is generated until the user
clicks Create, and every result is saved with the recording.

| Type | Tools |
| --- | --- |
| Lecture | Study Guide (focus: balanced / exam / key concepts / detailed), Flashcards (fewer / recommended / more), Practice Quiz (count, difficulty, question types; multiple choice, true/false, short answer; score, review, free retakes) |
| Meeting | Meeting Recap, Action Plan, Follow-up Email draft |
| Interview | Interview Q&A with verbatim quotes |
| Podcast | Episode Notes (summary, chapter outline, takeaways, verbatim quotes) |
| General | Action Plan |
| Voice message | Reply Draft |

Plus **Export** for every type. Extracted information (actions, dates, decisions, definitions, exam information, quotes) lives in Notes, not Create. Reply Draft and Follow-up Email require the user to write what the draft should be about (no preset buttons): the request decides the purpose, facts come from the recording, anything the request itself states (e.g. "tell him I'll call Friday") is included because the user asked for it, and no other commitments are added; other dates, times, amounts or urgency are flagged.

- **Grounding.** Same rules as Phase 3 (exact meaning, no outside knowledge, speaker labels only), and every item must
  cite real lines. `quote` and `evidence` fields must appear word for word. On top of that: an "explicit exam" item
  needs exam wording in its quote or line (otherwise it becomes "worth reviewing"); quiz questions must have exactly
  one matching option and verbatim evidence; flashcards are de-duplicated and vague cards dropped; meeting decisions
  and action items need evidence, owner/deadline only when stated; drafts list the facts they use, and any date, time,
  amount or urgency word in a draft that the recording never mentions is flagged for the user to check.
- **Storage.** `transcription_artifacts`, one row per (recording, kind, settings), with `source_version` for "Out of
  date" + Update, a unique key so concurrent clicks share one generation, `progress` for the latest quiz score, RLS
  like `transcription_insights`, and `on delete cascade` from the recording. A failed update keeps the previous result.
  Created outputs are not part of Library search.
- **Cost.** Claude Haiku 5.5; each generation is logged with the Phase 3 usage meter (`feature: tool:<kind>`). Long
  recordings use the same part-by-part analysis as summaries, so late sections are covered. `api/tools.js` may run up
  to 300 s.
- **Export** (`src/insights/export.js`): choose any of Original / Clean transcript, Summary, Notes, Insights and created
  outputs, then PDF (jsPDF), Word (docx), Markdown or text; SRT / VTT subtitles for the transcript when it has
  line-level timestamps (older recordings: disabled, with the reason). Files are built in the browser from data the
  signed-in user already loaded, with clean file names; PDF and Word code loads only when used.

## My Library

The signed-in user's searchable archive (`/library`, `src/pages/library.js`, data layer `src/lib/library.js`).
Nothing here uses AI; it's all Postgres.

- **Views:** Recent (recently opened), All, Favorites, Folders. **Filters:** recording type (chips appear once
  there is more than one type), date (7 days / 30 days / year). **Sort:** newest, oldest, longest, shortest, A–Z.
  View, filters, sort, folder and search are kept in the URL, so Back and reload work.
- **Cards:** title, type badge, date, length, speaker count, and the saved AI summary when one exists (otherwise
  the first transcript line). Star = favorite; ⋯ = open, rename, favorite, folders, remove from folder, delete.
- **Folders:** create, rename, delete; a recording can be in several folders. Deleting a folder never deletes
  recordings. **Select** mode adds several recordings to a folder, favorites them, or deletes them (with a
  confirmation that lists everything removed).
- **Paging:** 24 recordings per page from `library_list()`, loaded as you scroll (plus a "Show more" button).
- **Search:** `search_library()` — Postgres full-text search (English stemming: "pricing" finds "price"; quotes
  for exact phrases; `or`, `-word`). Matches titles, transcript text and real speaker names (generic
  "Speaker 1" labels are not indexed), plus generated Notes, which are labelled **Notes**, rank below the
  transcript, and only count while they match the current transcript version (out-of-date Notes stay stored but
  are not searched until regenerated). Ranking: title match first, then transcript relevance (`ts_rank_cd`), then Notes. Each result
  shows up to 3 matching lines with their timestamps; clicking one opens `/transcript?id=…&t=…&line=…`, which
  jumps to and highlights that line (or starts Play along there). Older saves without line timestamps link to
  the start of the matching paragraph, marked ¶. A recording that has all the words but never on one line shows
  lines with any of them, marked "Words found separately".
- **Performance:** search runs in the database against a stored `tsvector` per recording with a per-user GIN
  index (`btree_gin` on `(user_id, search_tsv)`); line snippets are computed only for the page of results.
  Tested with 1,000 one-hour recordings in one account: search 0.25–0.7 s, a list page ~50 ms. No transcript is
  sent to the browser for searching.
- **Recording page:** rename (pencil next to the title), favorite, folders; everything from Phase 3 unchanged.
- **Later (global Ask across recordings):** `search_library()` already returns ranked recordings with exact line
  ids and timestamps, so a future multi-recording Ask can use it as its retrieval step and send only those lines.

## Accounts & saved transcripts (Supabase)

Optional. Without the two variables below the app works exactly as before, with account features hidden.

- **Pages:** `/auth` (sign in, sign up, forgot/reset password, Google), `/auth/callback`, `/library`, `/transcript?id=…`.
- **Client:** `@supabase/supabase-js` in the browser with the PKCE flow (`src/lib/supabase.js`). All data
  protection is enforced by Postgres Row Level Security.
- **Server:** two Vercel functions, `api/insights.js` and `api/ask.js` (code in `server/`). They verify the
  caller's Supabase access token with Supabase Auth and then query the database *as that user* (their token,
  the publishable key), so RLS applies to the server too. No service-role key is used.
- **Saving:** when a signed-in user finishes a transcription it is saved automatically (title, duration,
  language, recording type, the transcript in the same format as the .txt export, and line-level `segments`
  with start/end/speaker for timestamps). Later speaker renames sync to the saved copy.
  Signed-out users can choose "Sign in to save": the transcript waits in that browser's localStorage and is
  saved right after sign-in.
- **Privacy:** audio never leaves the device. Only transcript text and its metadata are stored, and only for
  signed-in users. Summary, Notes, Ask and Insights send transcript text (never audio) to Anthropic when used.

### Environment variables

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel (Production) + `.env.local` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel (Production) + `.env.local` | the `sb_publishable_…` key |
| `ANTHROPIC_API_KEY` | Vercel (Production + Preview, Sensitive) + `.env.local` | **server only**; enables Summary / Notes / Ask / Insights |
| `AI_MODEL`, `AI_MODEL_SUMMARY`, `AI_MODEL_INSIGHTS`, `AI_MODEL_ASK` | optional | override `claude-haiku-5-5` |
| `AI_PROVIDER=mock` | `.env.local` only | local development without a key (ignored in production) |

Vite is configured (`envPrefix`) to expose only `VITE_*` / `NEXT_PUBLIC_*` variables to the browser.
**Never** put the secret / service-role key or `ANTHROPIC_API_KEY` in either prefix. Copy `.env.example` to
`.env.local` for local development; `.env*` files are git-ignored. `npm run dev` also runs the `api/` functions.

### Database

The schema lives in `supabase/migrations/`. Apply it with the Supabase CLI (`supabase db push`) or by pasting
the SQL into the dashboard's SQL editor. It creates `profiles`, `transcriptions`, `usage` and `subscriptions`,
a trigger that creates a profile for every new auth user, indexes, column privileges and RLS policies:

- users can read and edit only their own profile (`display_name`, `avatar_url` only)
- users can read, create, edit and delete only their own transcriptions; `user_id` always comes from `auth.uid()`
- `usage` and `subscriptions` are read-only for users; only trusted server code (service role) may write them
- signed-out visitors (`anon`) have no access to any of these tables
- Phase 3 (`20261008000000_phase3_insights.sql`): `transcriptions.segments` + `content_version` (trigger-managed,
  not writable by users); `transcription_insights` and `transcription_questions`, readable/writable only when
  `user_id = auth.uid()` **and** the parent transcription belongs to that user; `user_id` is never writable;
  deleting a transcription deletes its results.
- Phase 4 (`20261009000000_phase4_library.sql` + two follow-ups): `transcriptions.is_favorite`,
  `last_opened_at` (both user-writable) and `search_tsv` (generated, not writable); `folders` and
  `folder_items` (a membership can only link the user's own folder to the user's own recording);
  `transcription_insights.search_tsv` for Notes (trigger-managed); `search_library`, `library_list`,
  `library_stats` are SECURITY INVOKER (RLS applies) and not executable by `anon`. Notes count in search only
  while they match the transcript's current version (`20261010000000_phase4_current_notes_only.sql`).
- Phase 5 (`20261010010000_phase5_artifacts.sql`): `transcription_artifacts`, readable/writable only when
  `user_id = auth.uid()` and the recording is the user's; `user_id` never writable; deleted with the recording.

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

Deployed on Vercel: the static site plus the two functions in `api/` (`vercel.json` sets their max duration).

- **Production:** https://sparkscribe-moerizz.vercel.app (Vercel project `sparkscribe`, GitHub repo `MohamadRizk-Official/sparkscribe`).
  Every push to `main` deploys production; other branches get preview deployments.
- The app was called NeuralScribe until 2026-10-08. The old addresses (`neuralscribe-moerizz.vercel.app`,
  `neuralscribe-five.vercel.app`) and the old GitHub URL still point here, so links in earlier emails keep working.
  No custom domain yet.

## Notes & limits

- First run downloads the chosen model (Tiny ≈ 40 MB, Base ≈ 75 MB, Small ≈ 250 MB, Large v3 Turbo ≈ 1 GB).
- Speaker detection distinguishes voices but cannot know names — rename them yourself.
- Long recordings take a while on CPU; a GPU (Chrome/Edge with WebGPU) is much faster.
- Speaker detection works best with up to 3 clearly different voices and little overlap.
