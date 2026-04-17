# WebTerm

A mobile-friendly web terminal for [exe.dev](https://exe.dev) VMs. Built with Go, xterm.js, and WebSockets.

## Features

**Terminal**
- Full PTY-backed bash shell over WebSocket
- xterm.js with 256-color support, clickable links, 5000-line scrollback
- Proper UTF-8 handling (emoji, Unicode symbols, etc.)
- Auto-reconnect on disconnect

**Mobile-first UI**
- Quick-action bar: `Tab`, `Esc`, `↑`, `↓`, `|`, `~`, `/`
- Two-tap **Ctrl** submenu: tap Ctrl then pick C/D/Z/L/A/E/R/U/W
- Buttons don't steal focus — on-screen keyboard stays open
- `interactive-widget=resizes-content` viewport meta + flexbox layout so the terminal resizes when the keyboard opens

**Gestures**
- **Swipe right** → Tab (autocomplete)
- **Swipe left** → Alt+B (back one word)
- **Swipe up** → previous command (only when scrolled to bottom)
- **Tap on cursor row** → reposition cursor (sends arrow keys, like iTerm2)

**Command history & bookmarks**
- Commands are saved to SQLite automatically
- Searchable history panel (⏱ button)
- Bookmark commands with labels (★ button)
- Tap any history/bookmark entry to paste it into the terminal

## Running

```bash
make build
./webterm -listen :8000
```

Or as a systemd service:

```bash
sudo cp srv.service /etc/systemd/system/webterm.service
sudo systemctl daemon-reload
sudo systemctl enable --now webterm
```

Then visit `https://<vmname>.exe.xyz:8000/`.

## Code layout

```
cmd/srv/          entrypoint
srv/
  server.go       HTTP handlers, WebSocket PTY, REST API
  templates/      HTML (single page)
  static/         CSS + JS (xterm.js frontend)
db/
  migrations/     SQLite schema (history, bookmarks)
  db.go           open + migrate
```

## Tech

- **Backend**: Go, [gorilla/websocket](https://github.com/gorilla/websocket), [creack/pty](https://github.com/creack/pty), SQLite
- **Frontend**: [xterm.js](https://xtermjs.org/) v5.5, vanilla JS, CSS flexbox
