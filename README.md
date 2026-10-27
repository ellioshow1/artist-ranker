# Artist Ranker

Rank every Spotify track an artist is credited on (their own songs, features, collabs), two songs at a time, and save the result as a Spotify playlist. Works for any artist; each artist gets its own save.

## Run it on your computer

Double-click `start.bat`. It serves the app at http://127.0.0.1:8766/ and opens it.
(Or run `python -m http.server 8766 --bind 127.0.0.1` in this folder.)

## Share it with friends

It's a plain static site (no server code), so any static host works: GitHub Pages, Netlify, Cloudflare Pages.
Upload everything except `.claude/` and `start.bat`.

Then decide how friends log in to Spotify:

- **Your Client ID, up to 5 friends (easiest for them).** Put your Client ID in `js/config.js` before uploading.
  In your Spotify developer dashboard, add the hosted address (for example `https://you.github.io/artist-ranker/`) as a Redirect URI,
  and add each friend's Spotify email under **User Management**. Friends then just click "Log in with Spotify".
  Spotify caps developer apps at 5 users.
- **Everyone uses their own Client ID (no limit).** Leave `js/config.js` empty. The app walks each friend through making their
  own free developer app (about 3 minutes, needs Premium) using the hosted address as the Redirect URI.

Both work at once: with a shared ID set, friends beyond your 5 can still expand "Set up your own Spotify access".

Everyone's progress lives in their own browser. Nothing is sent anywhere except to Spotify.

## How the ranking works

1. **Swiss rounds.** Every song plays every round against a song with a similar record. Nobody gets knocked out.
2. **Finals.** The top songs (50 by default) get sorted exactly, head to head, reusing picks already made. Extend 25 at a time.
3. Everything below the finals is ordered by a Bradley-Terry rating fitted on every pick.

Keys: `←`/`→` pick, `↓` can't split them, `S` ask me later, `Z` undo, `A`/`D` play/pause left/right.

## Files

- `js/config.js`: optional shared Spotify Client ID
- `js/spotify.js`: login (PKCE), artist search, catalog scan, playlist export
- `js/catalog.js`: merges duplicates (single + album + deluxe + clean) and tags sped-up/instrumental/remix/live versions
- `js/engine.js`: Swiss pairing, finals insertion sort, ratings
- `js/app.js`: UI and per-artist saves
