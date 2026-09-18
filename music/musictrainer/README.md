# MusicTrainer

A weekly scoring instrument for Discover Weekly and Release Radar. Static site, deploys to GitHub Pages. No backend — all data lives in the browser's localStorage, with JSON export/import for backup.

## How it works

1. **New week** — paste the week's track list (Spotify URLs, URIs, or `uri | title | artists` lines) and the model's predictions (JSON or `uri, keep, 0.39` lines).
2. **Lock predictions** — timestamped, then uneditable. This preserves the blind test: predictions are frozen before the first listen.
3. **Score** — for each track: `skip` (do nothing) / `like` (liked only) / `keep` (liked + into the current playlist). Click the track to load its Spotify embed player, or listen in your own Spotify. Keyboard: `j`/`k` move, `1`/`2`/`3` score, `p` loads the player.
4. **Scoreboard** — per-track accuracy, precision, and recall against the locked predictions, plus a cumulative panel tracking progress toward the 240-decision / 90%-accuracy target.

## Deploy

Push to `main`; GitHub Pages serves the site root.

## Seed data

`js/seed.js` ships week 1 (Discover Weekly, Sep 14 2026) with 30 tracks and the model's locked predictions, so the baseline test is ready to score out of the box.

## "Why?" notes

Every track has a collapsible **WHY?** field — write what grabbed you about the track, in your own words. Notes live in the shared `songnotes.v1` localStorage store (keyed by Spotify track ID), so they travel with the track into Autopsy and survive export/import: week exports carry each track's note, and importing a week restores them.
