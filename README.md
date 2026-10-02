# Chopshop

Paste a YouTube link to a drum video (a break, solo, fill or kit demo) and get a sample pack back: one pad per distinct sound, ready to audition and download as WAVs or a ZIP.

## Run it

Needs Node 20+, [ffmpeg](https://ffmpeg.org/) and [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your PATH (`pip install yt-dlp`).

```bash
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts both the Vite app and the small audio server (`server/index.mjs`, port 8787) that fetches audio with yt-dlp and decodes it with ffmpeg. You can also drop or open a local audio file, which skips the server.

## How the chopping works

Everything after the download runs in the browser, in a Web Worker (`src/engine/analyze.ts`):

1. **Onsets.** Spectral flux on 48 log-spaced bands (SuperFlux-style, with a max filter against vibrato), adaptive threshold, then each onset is pinned to the sample by the steepest rise in the envelope.
2. **Flams.** Two strikes within 30 ms become one hit.
3. **Continuations.** An onset with almost no energy jump whose spectrum matches the tail it sits on (a cymbal swell, a re-trigger) is merged into the previous sound instead of becoming a new one.
4. **Timbre per hit.** The first ~80 ms of each hit, with whatever was already ringing before it subtracted, so bleed from the previous sound doesn't change its fingerprint.
5. **Grouping.** Average-linkage clustering on loudness-normalised spectral shape plus decay. Hits closer than the *Merge similar* threshold are the same sound. The best take (closest to the group's centre, least bleed, not cut off, not inside a roll) becomes **A** and the runner-up becomes **B**.
6. **Overlaps.** A group whose spectrum is best explained as two other groups added together (for example kick + hat) is split. A group that is a known sound plus something never heard alone (for example a crash only ever played on the kick) gets that unknown part separated out with a Wiener-style spectral mask and becomes its own pad.
7. **Tails.** A hit cut off by the next one is extended by masking the following audio with its own decaying spectrum against the next hit's.
8. **Rolls.** Three or more strokes of the same sound under 150 ms apart, at a steady rate, become a roll sample. Rolls of the same drum are deduplicated the same way as hits.

`npm run probe path/to/file.wav` runs the analyzer from the command line and prints what it found.
