# prog2keys

Type a chord progression, see it as keys on a piano. Click any chord to hear
it (WebAudio, no samples needed).

- `index.html` — the whole UI
- `prog2keys.js` — chord-symbol parser + voicing math. Pure JS, zero imports;
  also runs in Node (`node test-prog2keys.mjs`)
- `app.js` — DOM, keyboard render, audio, transport
- `test-prog2keys.mjs` — 29 parser/voicing/transpose checks

Understood qualities: maj m 7 maj7 m7 mmaj7 dim dim7 ø/m7b5 aug 7#5 sus
sus2 7sus4 add9 madd9 9 m9 maj9 11 m11 13 m13 7b5 7#9 7b9 7#11 6 6/9 5…
plus slash chords (`G/B`) and unicode (`Δ ø ° ♯ ♭`).

Shift+click a chord chip to flip through its inversions — the keyboard shows
the actual voicing, orange key is the root.
