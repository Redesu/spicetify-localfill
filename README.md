# LocalFill

LocalFill is a Spicetify extension for Spotify desktop that replaces unavailable tracks with local audio files.

Spotify greys out tracks that are unavailable in your region or catalogue. LocalFill lets you bind a local file to any track, then plays that file through an in-app player when Spotify reaches the track.

Repository: <https://github.com/Redesu/spicetify-localfill>

## Features

- Right-click a track and choose a local audio file.
- Right-click a playlist and scan it for unavailable tracks.
- Scan the current playlist from the topbar `LocalFill` button.
- Per-song file picker for unavailable tracks.
- Optional folder matching: choose a folder and LocalFill fuzzy-matches filenames to track titles and artists.
- Apply one suggestion, selected suggestions, or all suggestions.
- Remove a single replacement or clear replacements for a playlist.
- `LOCAL` badges on playlist rows that already have a stored replacement.
- Floating player with progress, seek, volume, play/pause, next, and stop controls.
- Mappings and audio files persist in Spotify's app storage (IndexedDB).
- Automatic preemption of Spotify's unavailable-track skipping.
- Diagnostics export from the settings window.

## Requirements

- Spotify desktop.
- Spicetify 2.46.x or newer.
- Windows, Linux, or macOS.

This build was developed against Spicetify 2.46.7 and Spotify 1.3.10.

## Install

### Windows

From PowerShell in this repository:

```powershell
.\install.ps1
```

To avoid restarting Spotify automatically:

```powershell
.\install.ps1 -NoRestart
```

### Linux and macOS

```bash
chmod +x install.sh
./install.sh
```

### Manual install

1. Find your Spicetify user data directory:

   ```bash
   spicetify path userdata
   ```

2. Copy `extension.js` into `Extensions/localfill.js`.

3. Enable it:

   ```bash
   spicetify config extensions localfill.js
   spicetify apply
   ```

4. Restart Spotify.

## Usage

### Map one track

1. Right-click a track.
2. Open `LocalFill`.
3. Choose `Choose local audio file...`.
4. Pick an audio file.

If the track is currently playing, LocalFill pauses Spotify and starts the local file.

If the track is playable on Spotify and you want to use the local file anyway, enable `Override playable tracks` in LocalFill settings.

Spotify keeps its own unavailable marker on the row. Click the mapped row or its play button anyway: LocalFill intercepts the click and starts the local file instead of asking Spotify to play it.

### Scan an unavailable track playlist

1. Open a playlist or `Liked Songs`.
2. Click `LocalFill` in the topbar, or right-click the playlist and choose `LocalFill: Find unavailable songs`.
3. In the scanner window:
   - Use `Choose file...` on individual rows.
   - Use `Choose folder...` to fuzzy-match a folder of audio files.
   - Use `Use` to accept one suggestion.
   - Use `Apply selected` or `Apply all suggestions` to store mappings in bulk.
   - Use `Clear playlist replacements` to remove mappings for tracks in this playlist.

A track is listed when Spotify reports `isPlayable: false` for its playlist row.

### Floating player

While a local file is playing, LocalFill shows a floating player above the bottom-right corner of Spotify. It provides:

- Progress and seek.
- Play and pause.
- Next track.
- Stop.
- A local volume slider. Moving it switches the local file to its own volume; use `Follow Spotify volume` in settings to re-enable Spotify volume/mute synchronization.

Mapped rows display a green `LOCAL` badge so you can see which unavailable tracks already have a stored replacement.

Spotify's own play/pause button and Space key are intercepted while a local file is active.

### Manage replacements

Open the profile menu and choose `LocalFill`, or use the topbar button when you are not on a playlist page.

The settings window shows:

- Stored replacement count and storage usage.
- Automatic replacement toggle.
- Floating player toggle.
- Playable-track override toggle.
- Follow-Spotify-volume toggle.
- Current playlist scanner shortcut.
- Clear-all action.
- Diagnostics copy action.
- Stored replacement list with play and remove actions.

## How it works

- Audio files are copied into IndexedDB inside Spotify's app storage. The original file is not referenced after selection.
- Playback uses a hidden HTML audio element and an object URL.
- When Spotify reaches an unavailable mapped track, LocalFill pauses Spotify before it can auto-skip, plays the local file, and then advances Spotify to the next playable track.
- Pressing Next while Spotify is playing also checks the next playlist row and starts its local file instead of letting Spotify skip it.
- Consecutive mapped unavailable tracks are played as a local chain.
- Upcoming tracks are read from the visible tracklist rows first when skipping, then from `Player.data.nextItems`, with queue and playlist-order fallbacks.
- Playlist availability comes from `PlaylistAPI`, with `sp://core-playlist` rows as a fallback.

## Limitations

- Local files play only on the computer where they are stored.
- Spotify still displays its own unavailable marker; LocalFill does not change Spotify's catalogue state.
- Spotify's native progress bar and seek do not reflect local playback; use the LocalFill player.
- Automatic preemption is best-effort because it relies on Spotify's internal queue state.
- A duplicate release with a different Spotify track ID may need a direct click; title-based row interception handles it even when the IDs differ.
- Spotify crossfade can make replacement timing less reliable. Disable crossfade for the best results.
- Files are stored in Spotify's app storage. Clearing Spotify site data/cache can remove mappings.
- Very large libraries consume storage; check the storage figure in settings.
- If Spotify's autoplay policy blocks a local file, press play in the LocalFill player.

## Troubleshooting

### The LocalFill button does not appear

- Confirm the extension is enabled in your Spicetify config:

  ```bash
  spicetify config extensions
  ```

- Re-run `spicetify apply` and restart Spotify.
- Check the Spotify developer console for `[LocalFill]` messages.

### A track is skipped before the local file starts

- Turn off Spotify crossfade.
- Open `LocalFill` settings and choose `Copy diagnostics`.
- Check that the next unavailable track appears in `nextItems` or `nextTracks` in the diagnostics output.

### The local file does not start automatically

- Press play in the LocalFill player.
- Check that the file is a supported audio format.
- Re-map the track if the stored file is reported as missing.

### I need to reset everything

Use `Clear all replacements` in LocalFill settings. Uninstalling the extension does not delete stored mappings by default.

## Uninstall

Windows:

```powershell
.\uninstall.ps1
```

Linux/macOS:

```bash
./uninstall.sh
```

Or manually:

```bash
spicetify config extensions localfill.js-
spicetify apply
```

Then delete `Extensions/localfill.js` from your Spicetify user data directory and restart Spotify.

## Development

The extension is plain JavaScript with no build step.

Run the matcher tests:

```bash
node --test tests/matcher.test.js
```

Files:

- `extension.js` - the Spicetify extension.
- `install.ps1`, `install.sh` - installers.
- `uninstall.ps1`, `uninstall.sh` - uninstall helpers.
- `tests/matcher.test.js` - pure filename-matching tests.

## License

MIT
