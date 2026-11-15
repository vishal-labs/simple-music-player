# music-player

A terminal-styled web player for a folder of music. Point it at a folder, and
every sub-folder that contains audio becomes a list you can play from the
browser.

## Run it

```sh
cp .env.example .env        # then set MUSIC_PATH to your music folder
docker compose up -d --build
```

Open <http://localhost:8080>.

The music folder is mounted read-only. Nothing in it is ever changed.

## Settings

Set these in `.env` (or edit `compose.yaml` directly).

| Name              | Default  | What it does                                                    |
| ----------------- | -------- | --------------------------------------------------------------- |
| `MUSIC_PATH`      | required | Folder on the host that holds the music.                        |
| `PORT`            | `8080`   | Port the player is served on.                                   |
| `SITE_TITLE`      | `bhakti` | Name shown in the browser tab.                                  |
| `RESCAN_MINUTES`  | `10`     | How often to look for added or removed files. `0` turns it off. |
| `IGNORE_PREFIXES` | `.,_`    | Folders and files starting with any of these are hidden.        |

## How the folder is read

- Each folder that directly contains audio files becomes one list. Nested
  folders work and are shown as `Parent / Child`.
- Files sitting directly in the music folder go into a list called `Unsorted`.
- The song name is the file name without its extension. Tags inside the file
  are only used to read the duration.
- Supported: `mp3`, `m4a`, `aac`, `flac`, `ogg`, `opus`, `wav`, `webm`. The
  server does not convert anything, so a file plays only if the browser can
  play that format.
- New files show up at the next rescan, or straight away with `[rescan]`.

## Controls

- Click a song to play it; the list it came from becomes the queue.
- `[prev] [-30] [stop] [+30] [next]`, `[v-] [v+]`, `[random]`.
- `[shuffle]` and `[repeat:off|all|one]` apply to the current queue.
- `[ ]` next to a song marks it as a favourite.
- Space plays or pauses; left and right arrows skip 30 seconds.
- Tracks longer than ten minutes resume where you stopped.

Favourites, volume and the other options are saved in the browser, so they are
separate on each device.

## Without Docker

```sh
npm install
MUSIC_DIR=/path/to/music npm start
```

## Notes

- There is no login. Keep it on your home network, or put it behind a reverse
  proxy that adds authentication before exposing it.
- On iPhone and iPad the spectrum display stays flat and the interface tick is
  silent. iOS stops audio that is routed through the Web Audio API when the
  screen locks, so there the file is played directly instead.
- The typeface is IBM Plex Mono, under the SIL Open Font License
  (`public/fonts/OFL.txt`).
