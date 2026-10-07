# Accuracy testing

Reproducible accuracy measurement for the on-device pipeline. Nothing here is uploaded anywhere.

## What it measures

| Metric | Meaning |
| --- | --- |
| **WER** | Word Error Rate = (substitutions + deletions + insertions) ÷ reference words, after normalisation (case, punctuation, Unicode, Arabic alef/yaa/taa-marbuta/diacritic variants). Pooled across items = total errors ÷ total reference words. |
| **CER** | Character Error Rate, same idea on characters with spaces removed. Prefer it for Arabic and Arabic/English mixes, where word boundaries and clitics make WER harsh. |
| **Important words** | How many of the item's `vocabulary` terms appear in the transcript (whole-phrase match). |
| **Speaker count** | Whether the number of detected speakers equals the expected number. |
| **Wrong-speaker words** | Needs `<name>.turns.json`. Words are aligned as for WER; each hypothesis speaker is mapped 1:1 to the true speaker it overlaps most; the share of aligned words given to the wrong person or to Unknown (a word-level diarization error rate). Unknown words are also counted separately. |
| **False / missed changes** | Speaker changes shown where the same person kept talking (e.g. a pitch change split off as another speaker), and real changes the transcript did not show. |
| **Speed** | Seconds of audio processed per second, on the machine running the lab. |
| **Diff** | Word-level alignment for manual review (substitutions, deletions, insertions highlighted). |

The metric code is `src/lib/metrics.js` (unit-tested), shared by the lab and the CLI.

## Test sets

```
accuracy/testset/<set>/<name>.<wav|mp3|m4a|mp4|…>   the recording
accuracy/testset/<set>/<name>.ref.txt               exact reference transcript (UTF-8, plain text)
accuracy/testset/<set>/<name>.meta.json             optional: {"category","language","speakers","vocabulary":[…]}
accuracy/testset/<set>/<name>.turns.json            optional: [{"speaker":"A","text":"…"}, …] who said what, in order
```

Audio under `accuracy/testset/` is git-ignored (recordings can be private). Run
`node accuracy/make-index.mjs accuracy/testset/<set>` after adding files.

Suggested real-recording categories (one folder or a `category` field each): `clean-english`, `noisy-english`,
`classroom-lecture`, `distant-microphone`, `two-speakers`, `three-speakers`, `accented-english`, `fast-speaker`,
`quiet-speaker`, `technical-vocabulary`, `names`, `arabic`, `arabic-english`, `phone-recording`, `car-recording`, `echo`.

Writing references: transcribe exactly what is said (keep filler words if you want them scored), no speaker labels or
timestamps. For Arabic, write the words as spoken; spelling variants of alef/yaa/taa marbuta and diacritics are
normalised away. For code-switching, write each word in the script it was spoken in.

### Synthetic set

`accuracy/synthetic/` generates a reproducible English set with Windows text-to-speech plus degraded copies
(noise, very heavy noise, quiet, quiet+noise, phone band, echo, car rumble, clipping, a mid-recording volume dip).
One-speaker items use SSML prosody for a pitched word, whispered/soft, raised, laughing, emphasised and pitch-changing
speech, to catch false speaker changes; two- and three-speaker items include short interjections:

```
powershell -ExecutionPolicy Bypass -File accuracy/synthetic/generate.ps1
```

TTS speech is far easier than real speech, so absolute numbers are **not** real-world accuracy. Use it to catch
regressions and to compare settings (chunking, preprocessing, important words, models).

## Running

Interactive lab (runs the real worker, same code as the app):

```
npm run eval:build      # builds the app + eval.html into dist-eval/ and copies the test sets in
npm run eval:serve      # http://localhost:4174/eval.html
```

Load `/accuracy/testset/synthetic/` (or pick a folder), edit the configurations, press **Run**, then
**Download JSON**. A configuration is merged into the worker's `run` message, e.g.

```json
[{ "label": "Fast", "mode": "fast" },
 { "label": "Best", "mode": "best" },
 { "label": "Best, no preprocessing", "mode": "best", "preprocess": false },
 { "label": "Small model", "mode": "best", "model": "small" }]
```

Single transcript from the command line (accepts the app's `.txt` export):

```
npm run accuracy:score -- reference.txt exported.txt --terms "Hadi Salame, SparkScribe" --diff
```

Results worth keeping go in `accuracy/results/` with the date, engine version and device.
