# Port Web Browser

A small Electron desktop app for seeing which ports are in use on your Mac, what's behind them, and opening them in tabs.

## Run it

```sh
cd desktop
npm install
npm start
```

Runs on macOS and Linux. It uses `lsof` and `ps`, so install those if your Linux distribution doesn't include them. Docker is optional and adds container details. Windows isn't supported.

## Build an installer

```sh
cd desktop
npm run dist:mac    # dist/Dev Deck-<version>-arm64.dmg
npm run dist:linux  # dist/Dev Deck-<version>.AppImage
```

Mac builds aren't notarized. If macOS blocks a downloaded copy, open it from System Settings > Privacy & Security, or run `xattr -dr com.apple.quarantine "/Applications/Dev Deck.app"`.

## Ports tab

- Lists TCP and UDP ports with their process or container, project folder, CPU and memory.
- Stop, pause, resume and start your own servers and containers, or copy the matching command.
- Highlights ports reachable from other devices in pink, with a tooltip on how to bind them to `127.0.0.1`.
- Click a row to open that server in a new tab. HTTPS, self-signed localhost certificates and basic auth are supported.
- macOS system services, apps in `/Applications` and the Docker backend are protected from these actions.

Every tab has an address bar with back, forward and reload. Edit the URL and press Enter to go there. You can leave off `http://`, or type just `/path`, `?query` or `#hash` to stay on the current site.

Port tabs use [Dark Reader](https://github.com/darkreader/darkreader) by default. Toggle it with the ◐ button or Cmd+Shift+D.

## Music tab

A queue player built on the official YouTube IFrame API. Add tracks in the app with a title and a YouTube URL. They're saved locally.

To start with your own list, create `player/tracks.local.json`, which git ignores:

```json
[{ "id": "1", "title": "Song title", "artists": ["Artist"] }]
```

Then link a video to each track in the app. Set `YT_API_KEY` to search from inside the app.

`player/extract-tracks.cjs` writes that file from a track page. It needs Playwright (`npm install playwright`) and Chrome.

## Shortcuts

| Keys | Action |
|---|---|
| Cmd+1 to Cmd+9 | Switch tabs |
| Cmd+W | Close a port tab |
| Cmd+L | Edit the address |
| Cmd+R | Reload the tab |
| Cmd+[ and Cmd+] | Back and forward |
| Cmd+Shift+D | Toggle dark mode for the tab |

## Running without Electron

`node port-viewer/server.cjs` serves the port viewer on http://localhost:4818, and `node player/server.cjs` serves the player on http://localhost:4817.

## License

MIT. See [LICENSE](LICENSE).
