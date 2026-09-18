# shared/

Drop-in modules used by more than one music tool. Keep them dependency-free
and backward-compatible — every tool that includes them ships to users who
may have cached an older copy (use `?v=N` cache-busting on the script tag).

## song-notes.js — "why did I like it?" notes

`window.SongNotes`. A shared per-track free-text store: notes are keyed by
Spotify track ID, so a note written in MusicTrainer appears in Autopsy and
vice versa. Browser localStorage (`songnotes.v1`), JSON export/import built in.

Include in any ranker/scoring tool:

```html
<script src="../shared/song-notes.js?v=1"></script>
```

Then in per-track HTML: `SongNotes.fieldHTML(trackId, {name, artists, uri})`
and after render: `SongNotes.bind(rootEl)`. `fieldHTML` renders a collapsed
`<details>` that auto-opens when a note exists; a ● dot marks annotated tracks.
API: `get / set / has / count / all / exportJSON / importJSON / onChange /
trackId(uri)`.
