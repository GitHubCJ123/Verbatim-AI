# Speech benchmark recordings

These 33 clips are used by **Settings → AI model → Test every model on this
computer**. Their reference transcripts and selection rules are in
[`src/lib/ai/benchmarkClips.ts`](../../../src/lib/ai/benchmarkClips.ts).

## Source and license

The audio comes from the `test-other` set of the **LibriSpeech ASR corpus** by
Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur
(<https://www.openslr.org/12>), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). LibriSpeech is
derived from public-domain LibriVox audiobooks.

Reference: V. Panayotov, G. Chen, D. Povey and S. Khudanpur, "LibriSpeech: an
ASR corpus based on public domain audio books", ICASSP 2015.

**Changes:** only the 33 utterances listed in `benchmarkClips.ts` are included,
re-encoded from the original FLAC to 16 kHz mono MP3 at 48 kbit/s to keep the
app small.
