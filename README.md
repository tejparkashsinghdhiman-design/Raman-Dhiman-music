# Raman Dhiman: official music app

A fast, installable web app for Raman Dhiman's music.

- **Lossless playback** (FLAC) with a quality switch: Auto, Lossless, High (MP3 320) or Data saver (MP3 128)
- **Stats that update themselves** every 6 hours, each with its source and date
- **Drafts**: a private place for unreleased songs, lyrics, notes and voice ideas. Stored on the device, never published
- **Offline listening**, lock-screen controls, sleep timer, queue, keyboard shortcuts, light and dark themes
- Installs on a phone like a normal app

The abstract note-and-ripples icon is in `assets/icon.svg`.

## Put it online (one-time, about 2 minutes)

1. Open **Settings → Pages**.
2. Under *Build and deployment*, set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**. Save.
3. After a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.

The **Actions** tab will show the workflows below. If GitHub asks you to enable workflows, click the button.

## Adding a song in lossless

The app plays whatever audio files are in this repository. **No audio is included yet**, because the master files belong to Raman and have to come from him.

1. Export the final mix from your music software as **FLAC** (best) or WAV, and name it after the song, in lowercase with dashes: `panjab.flac`, `shokeen-kudte-pajame-de.flac`. The name must match the song's `id` in `data/catalog.json`.
2. Upload it to the **`audio/lossless`** folder (*Add file → Upload files*). The website accepts files up to 25 MB. Bigger files need [GitHub Desktop](https://desktop.github.com/) or git.
3. Wait a few minutes. The **Build audio tiers** workflow creates the High and Data saver versions, reads the real sample rate and bit depth from the file, and updates the catalogue. Nothing else to edit.

Converting a WAV to FLAC (free): `ffmpeg -i panjab.wav panjab.flac`, or use Audacity or fre:ac.

**What "lossless" means here.** The FLAC file is served untouched, so nothing is discarded between the master and the player. The player shows exactly what is playing, for example `FLAC · 16-bit · 44.1 kHz`. If a song has no lossless file, the app plays the next best version and *says so*; it never labels a lossy file as lossless. Your phone or browser may still resample the sound on its way to the speakers; that is outside any web app's control.

### Space and bandwidth

A lossless song is roughly 25 to 40 MB. GitHub Pages sites should stay under about 1 GB and about 100 GB of traffic per month, which comfortably fits a catalogue of this size. If the audience grows beyond that, move the `audio/` folder to cheap object storage (Cloudflare R2, Backblaze B2) and change the `src` paths in `data/catalog.json`. Nothing else changes.

### Heads-up: this repository is public

GitHub Pages is free only for public repositories, so anyone can download the files in `audio/`. That is fine for songs that are already released. **Do not put unreleased songs in this repository.** Use **Drafts** for those.

## Keeping stats and releases current

The **Sync stats and releases** workflow runs every 6 hours (or press *Run workflow* on the Actions tab).

| Source | Needs a key? | What it provides |
|---|---|---|
| Apple Music (iTunes API) | No | New releases, release dates, artwork, 30-second previews |
| Spotify artist page | No | Monthly listeners |
| Spotify API | Optional | Followers, popularity, release links |
| YouTube Data API | Optional | Subscribers and views, per song |

**Monthly listeners come from reading Spotify's public artist page.** Spotify doesn't offer them through its API. If Spotify changes that page, the app keeps the last good number and marks it "Out of date" instead of showing a wrong one.

To switch on the optional sources, open **Settings → Secrets and variables → Actions → New repository secret**:

- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`: create a free app at [developer.spotify.com](https://developer.spotify.com/dashboard)
- `YOUTUBE_API_KEY`: from the Google Cloud console (YouTube Data API v3). Then put the channel ID in `data/config.json` as `youtubeChannelId`, and add each song's video link under `links.youtube` in `data/catalog.json`

Release dates and details Raman has written by hand are never overwritten by the sync.

## Drafts

Open **Drafts** to save unreleased songs: title, stage (Idea to Ready), tempo, key, lyrics, notes, and any number of audio takes, with waveforms. You can record a voice idea straight from the phone's microphone.

- Everything is stored in the browser on that device. **It is never uploaded and never written to this repository.**
- Browsers can clear storage when a device is low on space. In **Settings**, press *Keep my saved files from being cleared*, and use **Export backup** now and then.
- A PIN screen lock is available in Settings. It keeps casual eyes out; it is not encryption.
- *Prepare for release* gives a checklist and a ready-made catalogue entry for when a draft is finished.

## Editing the information

| File | What it controls |
|---|---|
| `data/artist.json` | Bio, roles, links, collaborators, photo (`"photo": "assets/raman.jpg"`) |
| `data/catalog.json` | Songs: titles, dates, credits, lyrics, links |
| `data/config.json` | Country, Spotify and YouTube IDs |

Every fact in these files came from Raman's official pages, Apple Music, Spotify or Amazon Music. Anything unconfirmed is left blank on purpose. Fill it in as it becomes known: hometown, genre, a first-person bio, lyrics, cover art (put images in `assets/covers/` and set `"cover"` on the song).

## Developing

```bash
npm test             # 13 tests: merge logic, sync (mocked network), audio pipeline (needs ffmpeg)
node scripts/serve.mjs   # http://localhost:8080
```

No build step. It is plain HTML, CSS and JavaScript modules.
