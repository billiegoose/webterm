// === WebTerm Client ===
(function () {
  'use strict';

  // --- State ---
  let ws = null;
  let term = null;
  let fitAddon = null;
  let currentLine = '';
  let historyCache = [];
  let bookmarkCache = [];
  let panelMode = null; // 'history' | 'bookmarks' | null
  let reconnectDelay = 1000;
  let reconnectTimer = null;

  // Swipe state
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isSwiping = false;
  let swipeCompletionText = '';

  // --- Init ---
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    setupTerminal();
    connectWebSocket();
    setupQuickBar();
    setupToolbar();
    setupGestures();
    setupPanelSearch();
    window.addEventListener('resize', debounce(fitTerminal, 100));
    // Expose for inline onclick
    window.closePanel = closePanel;
  }


  // --- Terminal Setup ---
  function setupTerminal() {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 15,
      fontFamily: "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: 'rgba(88,166,255,0.3)',
        black: '#0d1117',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#e6edf3',
        brightBlack: '#484f58',
        brightRed: '#ff7b72',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc'
      },
      allowTransparency: false,
      scrollback: 5000,
      tabStopWidth: 8,
      drawBoldTextInBrightColors: true
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(webLinksAddon);

    term.open(document.getElementById('terminal'));
    fitTerminal();

    // Track current input line for history/autocomplete
    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: toBase64(data) }));
      }
      // Track line buffer for command detection
      if (data === '\r') {
        // Enter pressed — save to history
        const cmd = currentLine.trim();
        if (cmd.length > 0) {
          saveHistory(cmd);
        }
        currentLine = '';
      } else if (data === '\x7f' || data === '\b') {
        currentLine = currentLine.slice(0, -1);
      } else if (data === '\x03' || data === '\x04') {
        currentLine = '';
      } else if (data.charCodeAt(0) >= 32) {
        currentLine += data;
      }
    });
  }

  function fitTerminal() {
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows
        }));
      }
    } catch (e) {
      console.warn('fit error', e);
    }
  }

  // --- WebSocket ---
  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      fitTerminal();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output' && msg.data) {
          term.write(fromBase64(msg.data));
        }
      } catch (e) {
        console.warn('ws message error', e);
      }
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[33m[Connection closed. Reconnecting...]\x1b[0m\r\n');
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    }, reconnectDelay);
  }

  // --- Quick Bar (two-state: normal + Ctrl mode) ---
  let ctrlMode = false;

  function setupQuickBar() {
    const quickBar = document.getElementById('quick-bar');
    const normalBar = document.getElementById('qk-normal');
    const ctrlBar = document.getElementById('qk-ctrl');

    // Prevent quick-bar interactions from stealing focus (keeps mobile keyboard open).
    // pointerdown preventDefault stops the focus shift without blocking click events.
    // But it also breaks :active/:hover state cleanup, so we handle press feedback manually.
    quickBar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const btn = e.target.closest('.qk');
      if (btn) {
        btn.classList.add('qk-pressed');
        const clear = () => { btn.classList.remove('qk-pressed'); };
        btn.addEventListener('pointerup', clear, { once: true });
        btn.addEventListener('pointerleave', clear, { once: true });
        btn.addEventListener('pointercancel', clear, { once: true });
      }
    });

    // Normal mode buttons (with data-key)
    normalBar.querySelectorAll('.qk[data-key]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const key = btn.dataset.key;
        const data = key.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                        .replace(/\\x1b/g, '\x1b')
                        .replace(/\\r/g, '\r');
        sendKey(data);
        term.focus();
      });
    });

    // Ctrl button → switch to Ctrl mode
    document.getElementById('btn-ctrl').addEventListener('click', (e) => {
      e.preventDefault();
      ctrlMode = true;
      normalBar.classList.add('hidden');
      ctrlBar.classList.remove('hidden');
    });

    // Back button → return to normal mode
    document.getElementById('btn-ctrl-back').addEventListener('click', (e) => {
      e.preventDefault();
      exitCtrlMode();
      term.focus();
    });

    // Ctrl+<key> buttons
    ctrlBar.querySelectorAll('.qk[data-ctrl]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const letter = btn.dataset.ctrl.toLowerCase();
        const code = letter.charCodeAt(0) - 96; // Ctrl+A=1, Ctrl+C=3, etc.
        sendKey(String.fromCharCode(code));
        exitCtrlMode();
        term.focus();
      });
    });
  }

  function exitCtrlMode() {
    ctrlMode = false;
    document.getElementById('qk-normal').classList.remove('hidden');
    document.getElementById('qk-ctrl').classList.add('hidden');
  }

  // --- Toolbar ---
  function setupToolbar() {
    document.getElementById('btn-history').addEventListener('click', () => togglePanel('history'));
    document.getElementById('btn-bookmarks').addEventListener('click', () => togglePanel('bookmarks'));
    document.getElementById('btn-keyboard').addEventListener('click', () => {
      term.focus();
      // On mobile, focusing the xterm textarea triggers the keyboard
      const textarea = document.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.focus();
    });
    document.getElementById('btn-menu').addEventListener('click', () => {
      showToast('Swipe → autocomplete · ← back word · ↑ prev cmd');
    });
  }

  // --- Gestures ---
  // --- Alternate screen detection (tmux, vim, less, etc.) ---
  function isAlternateScreen() {
    return term && term.buffer.active.type === 'alternate';
  }

  // Track cumulative touch-scroll distance for converting to discrete mouse wheel events
  let scrollAccumulator = 0;
  let lastTouchY = 0;

  // Pixels of touch movement needed to trigger one 3-line scroll tick.
  // Computed dynamically from actual terminal cell height.
  function scrollThreshold() {
    const screen = document.querySelector('.xterm-screen');
    if (screen && term) return (screen.getBoundingClientRect().height / term.rows) * 3;
    return 60;
  }

  function setupGestures() {
    const container = document.getElementById('terminal-container');

    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      isSwiping = false;
      swipeCompletionText = '';
      scrollAccumulator = 0;
      lastTouchY = e.touches[0].clientY;
    }, { passive: true });

    container.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;

      // In alternate screen (tmux, vim, less): convert vertical drag to mouse wheel
      if (isAlternateScreen() && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        e.preventDefault();
        // Accumulate delta since last touchmove
        scrollAccumulator += (e.touches[0].clientY - lastTouchY);
        const thresh = scrollThreshold();

        while (Math.abs(scrollAccumulator) >= thresh) {
          if (scrollAccumulator > 0) {
            // Finger moves down = natural scroll = content moves up
            sendMouseWheel(true);
            scrollAccumulator -= thresh;
          } else {
            // Finger moves up = natural scroll = content moves down
            sendMouseWheel(false);
            scrollAccumulator += thresh;
          }
        }
        isSwiping = true; // Prevent other gesture handling
        return;
      }
      lastTouchY = e.touches[0].clientY;

      // Only consider horizontal swipes
      if (Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        isSwiping = true;

        if (dx > 0) {
          showSwipeHint('Tab ⇥ (autocomplete)');
        } else {
          showSwipeHint('← Back word');
        }
      } else if (dy < -30 && Math.abs(dy) > Math.abs(dx) * 1.5) {
        if (isScrolledToBottom()) {
          isSwiping = true;
          showSwipeHint('↑ Previous command');
        }
      }
    }, { passive: false });

    container.addEventListener('touchend', (e) => {
      hideSwipeHint();
      lastTouchY = 0;

      // If we were doing alternate-screen scroll, just consume the event
      if (isAlternateScreen() && isSwiping) {
        isSwiping = false;
        return;
      }

      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const elapsed = Date.now() - touchStartTime;

      if (isSwiping) {
        if (elapsed > 800) { isSwiping = false; return; }

        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx > 0) {
            sendKey('\t');
          } else {
            sendKey('\x1bb');
          }
        } else if (dy < -60 && Math.abs(dy) > Math.abs(dx) * 1.5 && isScrolledToBottom()) {
          sendKey('\x1b[A');
        }
        isSwiping = false;
        return;
      }

      // Short tap (not a swipe) — tap-to-reposition cursor
      if (elapsed < 300 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        handleTapToReposition(e.changedTouches[0]);
      }
    }, { passive: true });
  }

  // Send mouse wheel escape sequences to the PTY.
  // tmux with `set -g mouse on` responds to these by scrolling in copy-mode.
  // We send 3 lines per event for comfortable scroll speed.
  function sendMouseWheel(up) {
    // Try SGR first (\x1b[< encoding), then fall back to legacy X10.
    // Most modern terminals (tmux included) negotiate SGR mode,
    // but we send both — the one the app didn't request is ignored.
    const button = up ? 64 : 65;
    const lines = 3;
    for (let i = 0; i < lines; i++) {
      // SGR encoding: \x1b[<btn;col;rowM
      sendKey(`\x1b[<${button};1;1M`);
    }
  }

  // --- Tap to reposition cursor ---
  // Works like iTerm2: calculates column delta from current cursor to tap
  // position and sends left/right arrow keys to move there.
  // Only works on the cursor row (same line).
  function handleTapToReposition(touch) {
    if (!term) return;
    // Only reposition when scrolled to bottom (live input)
    if (!isScrolledToBottom()) return;

    const termEl = document.querySelector('.xterm-screen');
    if (!termEl) return;

    const rect = termEl.getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // Calculate cell dimensions
    const cellWidth = rect.width / term.cols;
    const cellHeight = rect.height / term.rows;

    const tappedCol = Math.floor(x / cellWidth);
    const tappedRow = Math.floor(y / cellHeight);

    // Current cursor position (relative to viewport)
    const cursorCol = term.buffer.active.cursorX;
    const cursorRow = term.buffer.active.cursorY;

    // Only reposition on the same row as the cursor
    if (tappedRow !== cursorRow) return;

    const delta = tappedCol - cursorCol;
    if (delta === 0) return;

    // Send arrow keys to move cursor
    const arrow = delta > 0 ? '\x1b[C' : '\x1b[D'; // right : left
    const keys = arrow.repeat(Math.abs(delta));
    sendKey(keys);
    term.focus();
  }

  function sendKey(key) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: toBase64(key) }));
    }
  }

  function showSwipeHint(text) {
    const el = document.getElementById('swipe-hint');
    document.getElementById('swipe-hint-text').textContent = text;
    el.classList.remove('hidden');
  }

  function hideSwipeHint() {
    document.getElementById('swipe-hint').classList.add('hidden');
  }

  // --- Panel (History / Bookmarks) ---
  function togglePanel(mode) {
    if (panelMode === mode) {
      closePanel();
      return;
    }
    panelMode = mode;
    document.getElementById('panel-title').textContent = mode === 'history' ? 'Command History' : 'Bookmarks';
    document.getElementById('panel-search').value = '';
    document.getElementById('side-panel').classList.remove('hidden');
    document.getElementById('panel-overlay').classList.remove('hidden');

    // Highlight active button
    document.getElementById('btn-history').classList.toggle('active', mode === 'history');
    document.getElementById('btn-bookmarks').classList.toggle('active', mode === 'bookmarks');

    loadPanelData();
  }

  function closePanel() {
    panelMode = null;
    document.getElementById('side-panel').classList.add('hidden');
    document.getElementById('panel-overlay').classList.add('hidden');
    document.getElementById('btn-history').classList.remove('active');
    document.getElementById('btn-bookmarks').classList.remove('active');
    term.focus();
  }

  async function loadPanelData() {
    const content = document.getElementById('panel-content');
    content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">Loading…</div>';

    try {
      if (panelMode === 'history') {
        const res = await fetch('/api/history');
        historyCache = await res.json();
        renderHistoryPanel(historyCache);
      } else {
        const res = await fetch('/api/bookmarks');
        bookmarkCache = await res.json();
        renderBookmarksPanel(bookmarkCache);
      }
    } catch (e) {
      content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Failed to load</div>';
    }
  }

  function renderHistoryPanel(items) {
    const content = document.getElementById('panel-content');
    if (!items || items.length === 0) {
      content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">No commands yet.<br>Start typing to build history.</div>';
      return;
    }
    content.innerHTML = items.map(item => `
      <div class="panel-item" data-cmd="${escHtml(item.command)}">
        <div class="panel-item-cmd" title="${escHtml(item.command)}">${escHtml(item.command)}</div>
        <div class="panel-item-time">${timeAgo(item.created_at)}</div>
        <div class="panel-item-actions">
          <button class="panel-item-btn" onclick="event.stopPropagation();bookmarkFromHistory('${escAttr(item.command)}')" title="Bookmark">★</button>
        </div>
      </div>
    `).join('');

    content.querySelectorAll('.panel-item').forEach(el => {
      el.addEventListener('click', () => {
        typeCommand(el.dataset.cmd);
        closePanel();
      });
    });
  }

  function renderBookmarksPanel(items) {
    const content = document.getElementById('panel-content');
    if (!items || items.length === 0) {
      content.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim)">No bookmarks yet.<br>Star commands from history to save them.</div>';
      return;
    }
    content.innerHTML = items.map(item => `
      <div class="panel-item" data-cmd="${escHtml(item.command)}">
        <div class="panel-item-cmd" title="${escHtml(item.command)}">
          ${escHtml(item.command)}
          ${item.label ? `<span class="panel-item-label">${escHtml(item.label)}</span>` : ''}
        </div>
        <div class="panel-item-actions">
          <button class="panel-item-btn danger" onclick="event.stopPropagation();deleteBookmark(${item.id})" title="Remove">✕</button>
        </div>
      </div>
    `).join('');

    content.querySelectorAll('.panel-item').forEach(el => {
      el.addEventListener('click', () => {
        typeCommand(el.dataset.cmd);
        closePanel();
      });
    });
  }

  function setupPanelSearch() {
    document.getElementById('panel-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      if (panelMode === 'history') {
        renderHistoryPanel(historyCache.filter(i => i.command.toLowerCase().includes(q)));
      } else if (panelMode === 'bookmarks') {
        renderBookmarksPanel(bookmarkCache.filter(i =>
          i.command.toLowerCase().includes(q) || (i.label || '').toLowerCase().includes(q)
        ));
      }
    });
  }

  // --- API helpers ---
  async function saveHistory(command) {
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command })
      });
    } catch (e) {
      console.warn('save history error', e);
    }
  }

  // Exposed globally for inline onclick
  window.bookmarkFromHistory = async function (command) {
    const label = prompt('Bookmark label (optional):') || '';
    try {
      await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, label })
      });
      showToast('Bookmarked!');
    } catch (e) {
      showToast('Failed to bookmark');
    }
  };

  window.deleteBookmark = async function (id) {
    try {
      await fetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
      showToast('Removed');
      loadPanelData();
    } catch (e) {
      showToast('Failed to remove');
    }
  };

  function typeCommand(cmd) {
    // Clear current line first, then type the command
    sendKey('\x15'); // Ctrl+U
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: toBase64(cmd) }));
      }
      currentLine = cmd;
      term.focus();
    }, 50);
  }

  // --- Toast ---
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2000);
  }

  // --- Utilities ---
  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function isScrolledToBottom() {
    if (!term) return true;
    return term.buffer.active.viewportY >= term.buffer.active.baseY;
  }

  // --- Base64 helpers for proper binary/UTF-8 handling ---
  // Encode a string (which may contain raw bytes from xterm onData) to base64
  function toBase64(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // Decode base64 to Uint8Array, then write as bytes to xterm (which handles UTF-8)
  function fromBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

})();
