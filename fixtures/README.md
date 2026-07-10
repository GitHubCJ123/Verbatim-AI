# Test fixtures

Golden fixtures for the engine test matrix (see
`docs/testing/automated-testing-strategy.md`).

## `hello-world.16k.wav`

Ground-truth speech for transcription (ASR) golden tests. 16 kHz mono
32-bit-float WAV of the utterance:

> "hello world this is a test of the transcription engine"

Regenerate (macOS) with:

```bash
say -o fixtures/hello-world.16k.wav \
    --data-format=LEF32@16000 \
    "hello world this is a test of the transcription engine"
```

It is committed (not generated at test time) because `say` is macOS-only but
the fixture must be available on every CI runner. Transcription engine tests
assert `wer(expected, result) < 0.15` (see `src/test/wer.ts`).

## `messy-transcript.txt`

Ground-truth input for cleanup (LLM) golden tests: a disfluent transcript.
Cleanup tests assert on *shape* (positive match on content, negative match on
disfluencies), never exact strings, because LLM output is nondeterministic.
