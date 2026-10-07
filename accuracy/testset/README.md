# Test recordings (not committed)

Put each test set in its own folder here, e.g. `accuracy/testset/real/`:

```
lecture-01.m4a
lecture-01.ref.txt      exact reference transcript
lecture-01.meta.json    {"category":"classroom-lecture","language":"en","speakers":1,"vocabulary":["biomechanics"]}
```

Then run `node accuracy/make-index.mjs accuracy/testset/real` and load `/accuracy/testset/real/` in the lab.
Audio, references and generated files in this folder are git-ignored; see ../README.md.
