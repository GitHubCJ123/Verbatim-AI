# Silero VAD ONNX model

`silero_vad.onnx` is the Silero VAD **v5** voice-activity-detection network,
used by the Silero-ONNX `FrameVad` implementation (see
`src/lib/vad/silero.ts` / `sileroLoader.ts`, issue #34).

- **Source:** https://github.com/snakers4/silero-vad
  (`src/silero_vad/data/silero_vad.onnx`)
- **License:** MIT — © Silero Team, 2020–present.
  https://github.com/snakers4/silero-vad/blob/master/LICENSE
- **Size:** ~2.3 MB
- **I/O contract** (verified against this file):
  - input `input` float32 `[1, 512]` — one 16 kHz mono window
  - input `state` float32 `[2, 1, 128]` — LSTM state (zeros at reset)
  - input `sr` int64 scalar — sample rate (16000)
  - output `output` float32 `[1, 1]` — speech probability
  - output `stateN` float32 `[2, 1, 128]` — next LSTM state

The model is bundled as a static asset and loaded lazily at runtime; the
JS wrapper around it is an original clean-room implementation.
