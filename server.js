#!/usr/bin/env node
// Linux Desktop MCP server for Claude Desktop (X11 and Wayland sessions).
// Pure Node, no npm deps. On X11 shells out to xdotool, wmctrl, xclip,
// maim/scrot/gnome-screenshot. On Wayland uses ydotool, wl-clipboard,
// gnome-screenshot/grim, and (on GNOME) the bundled helper Shell extension.
// https://github.com/LukeLamb/claude-linux-mcp — MIT License.

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const SHOTS_ROOT = '/tmp/claude-linux-mcp/shots';

// ─── System-dep discovery ────────────────────────────────────────────────
function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const BIN = {
  xdotool: which('xdotool'),
  wmctrl: which('wmctrl'),
  xclip: which('xclip'),
  gnomeShot: which('gnome-screenshot'),
  scrot: which('scrot'),
  maim: which('maim'),
  tesseract: which('tesseract'),
  ydotool: which('ydotool'),
  wlCopy: which('wl-copy'),
  wlPaste: which('wl-paste'),
  grim: which('grim'),
  busctl: which('busctl'),
  gsettings: which('gsettings'),
};

// Package that provides each BIN entry, for install hints.
const APT_PKG = {
  xdotool: 'xdotool', wmctrl: 'wmctrl', xclip: 'xclip', gnomeShot: 'gnome-screenshot',
  scrot: 'scrot', maim: 'maim', tesseract: 'tesseract-ocr', ydotool: 'ydotool',
  wlCopy: 'wl-clipboard', wlPaste: 'wl-clipboard', grim: 'grim', busctl: 'systemd',
};

// ─── Session detection ────────────────────────────────────────────────────
// CLAUDE_LINUX_MCP_BACKEND=x11|wayland overrides auto-detection.
function detectSession() {
  const forced = (process.env.CLAUDE_LINUX_MCP_BACKEND || '').toLowerCase();
  if (forced === 'x11' || forced === 'wayland') return forced;
  if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) return 'wayland';
  return 'x11';
}
const SESSION = detectSession();
const WAYLAND = SESSION === 'wayland';

// ydotool 1.x talks to the ydotoold daemon and takes raw keycodes; 0.1.x
// (what older Ubuntu releases package) drives /dev/uinput directly and takes
// key names. Both print their command list when run without arguments.
let ydotoolFlavorCache;
function ydotoolFlavor() {
  if (ydotoolFlavorCache !== undefined) return ydotoolFlavorCache;
  ydotoolFlavorCache = null;
  if (BIN.ydotool) {
    const r = spawnSync(BIN.ydotool, [], { encoding: 'utf8', timeout: 3000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    ydotoolFlavorCache = /\brecorder\b/.test(out) ? 'legacy' : 'modern';
  }
  return ydotoolFlavorCache;
}

function haveScreenshotTool() {
  return WAYLAND ? (BIN.gnomeShot || BIN.grim) : (BIN.gnomeShot || BIN.scrot || BIN.maim);
}

// ─── Logging (stderr) ─────────────────────────────────────────────────────
function log(...args) {
  try {
    process.stderr.write('[linux-desktop-mcp] ' + args.map(a =>
      typeof a === 'string' ? a : JSON.stringify(a)
    ).join(' ') + '\n');
  } catch (_) {}
}

// ─── JSON-RPC plumbing ────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function error(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
}
function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function requireBin(name) {
  if (!BIN[name]) {
    return `Required system tool "${name}" is not installed. Install with: sudo apt install ${APT_PKG[name] || name}`;
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({
      code,
      stdout: out.toString('utf8'),
      stderr: err.toString('utf8'),
    }));
  });
}

// Strip Snap-confinement env vars before spawning — these can pollute
// library paths (e.g. /snap/core20/...) and break GNOME tools that expect
// the system libc. Only used for screenshot tools where we've seen the
// issue in the wild; the rest of the server uses default env.
function cleanEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SNAP_') || k === 'SNAP' || k === 'GTK_PATH' || k === 'GIO_MODULE_DIR' || k === 'LD_LIBRARY_PATH' || k === 'LD_PRELOAD') continue;
    e[k] = v;
  }
  return e;
}

function buttonCode(name, isScroll = false) {
  if (isScroll) {
    return { up: '4', down: '5', left: '6', right: '7' }[name] || null;
  }
  return { left: '1', middle: '2', right: '3' }[name] || null;
}

// ─── Wayland input (ydotool) ──────────────────────────────────────────────
// ydotool injects events through /dev/uinput, i.e. as physical keys. Key
// combos are translated from xdotool keysym notation to Linux KEY_* codes.

// Linux input-event-codes.h values for the keys we can name.
const KEYCODES = {
  ESC: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11,
  MINUS: 12, EQUAL: 13, BACKSPACE: 14, TAB: 15,
  Q: 16, W: 17, E: 18, R: 19, T: 20, Y: 21, U: 22, I: 23, O: 24, P: 25,
  LEFTBRACE: 26, RIGHTBRACE: 27, ENTER: 28, LEFTCTRL: 29,
  A: 30, S: 31, D: 32, F: 33, G: 34, H: 35, J: 36, K: 37, L: 38,
  SEMICOLON: 39, APOSTROPHE: 40, GRAVE: 41, LEFTSHIFT: 42, BACKSLASH: 43,
  Z: 44, X: 45, C: 46, V: 47, B: 48, N: 49, M: 50,
  COMMA: 51, DOT: 52, SLASH: 53, RIGHTSHIFT: 54, LEFTALT: 56, SPACE: 57, CAPSLOCK: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88, RIGHTCTRL: 97, SYSRQ: 99, RIGHTALT: 100,
  HOME: 102, UP: 103, PAGEUP: 104, LEFT: 105, RIGHT: 106, END: 107, DOWN: 108,
  PAGEDOWN: 109, INSERT: 110, DELETE: 111, LEFTMETA: 125, RIGHTMETA: 126, COMPOSE: 127,
};

// xdotool keysym names (lower-cased) -> KEY_* names.
const KEYSYM_TO_KEY = {
  ctrl: 'LEFTCTRL', control: 'LEFTCTRL', control_l: 'LEFTCTRL', ctrl_l: 'LEFTCTRL',
  control_r: 'RIGHTCTRL', ctrl_r: 'RIGHTCTRL',
  shift: 'LEFTSHIFT', shift_l: 'LEFTSHIFT', shift_r: 'RIGHTSHIFT',
  alt: 'LEFTALT', alt_l: 'LEFTALT', alt_r: 'RIGHTALT', altgr: 'RIGHTALT', iso_level3_shift: 'RIGHTALT',
  super: 'LEFTMETA', super_l: 'LEFTMETA', super_r: 'RIGHTMETA', meta: 'LEFTMETA', win: 'LEFTMETA',
  return: 'ENTER', enter: 'ENTER', kp_enter: 'ENTER', escape: 'ESC', esc: 'ESC', tab: 'TAB',
  backspace: 'BACKSPACE', delete: 'DELETE', insert: 'INSERT', home: 'HOME', end: 'END',
  page_up: 'PAGEUP', prior: 'PAGEUP', page_down: 'PAGEDOWN', next: 'PAGEDOWN',
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', space: 'SPACE',
  caps_lock: 'CAPSLOCK', print: 'SYSRQ', menu: 'COMPOSE',
  minus: 'MINUS', equal: 'EQUAL', bracketleft: 'LEFTBRACE', bracketright: 'RIGHTBRACE',
  semicolon: 'SEMICOLON', apostrophe: 'APOSTROPHE', grave: 'GRAVE', backslash: 'BACKSLASH',
  comma: 'COMMA', period: 'DOT', slash: 'SLASH',
  '-': 'MINUS', '=': 'EQUAL', '[': 'LEFTBRACE', ']': 'RIGHTBRACE', ';': 'SEMICOLON',
  "'": 'APOSTROPHE', '`': 'GRAVE', '\\': 'BACKSLASH', ',': 'COMMA', '.': 'DOT', '/': 'SLASH',
};
for (let i = 1; i <= 12; i++) KEYSYM_TO_KEY[`f${i}`] = `F${i}`;

// Active keyboard layout (e.g. "us", "be", "de"). CLAUDE_LINUX_MCP_KB_LAYOUT
// overrides; otherwise the most recently used GNOME input source.
let layoutCache;
function keyboardLayout() {
  if (layoutCache !== undefined) return layoutCache;
  layoutCache = (process.env.CLAUDE_LINUX_MCP_KB_LAYOUT || '').toLowerCase() || null;
  if (!layoutCache && BIN.gsettings) {
    for (const key of ['mru-sources', 'sources']) {
      const r = spawnSync(BIN.gsettings, ['get', 'org.gnome.desktop.input-sources', key], { encoding: 'utf8', timeout: 3000 });
      const m = /\('xkb',\s*'([a-z]+)/.exec(r.stdout || '');
      if (m) { layoutCache = m[1]; break; }
    }
  }
  return layoutCache;
}

const AZERTY = new Set(['fr', 'be']);
const QWERTZ = new Set(['de', 'at', 'ch', 'cz', 'sk', 'hu', 'si', 'hr', 'pl']);
// Layouts where ydotool's US-keymap typing produces the right characters.
const US_LIKE = new Set(['us', 'gb', 'ie', 'au', 'ca', 'nz', 'za', 'in', 'ph']);

// Letters sit on different physical keys on AZERTY/QWERTZ; return the key
// that produces `letter` on the active layout.
function physicalLetterKey(letter) {
  const layout = keyboardLayout();
  if (AZERTY.has(layout)) return { a: 'Q', q: 'A', z: 'W', w: 'Z', m: 'SEMICOLON' }[letter] || letter.toUpperCase();
  if (QWERTZ.has(layout)) return { y: 'Z', z: 'Y' }[letter] || letter.toUpperCase();
  return letter.toUpperCase();
}

// "ctrl+shift+t" -> ['LEFTCTRL', 'LEFTSHIFT', 'T']. Throws on unknown keys.
function comboToKeys(combo) {
  const keys = [];
  for (const raw of combo.split('+').filter(Boolean)) {
    if (/^[a-z]$/.test(raw)) { keys.push(physicalLetterKey(raw)); continue; }
    if (/^[A-Z]$/.test(raw)) { keys.push('LEFTSHIFT', physicalLetterKey(raw.toLowerCase())); continue; }
    if (/^[0-9]$/.test(raw)) { keys.push(raw); continue; }
    const k = KEYSYM_TO_KEY[raw.toLowerCase()];
    if (!k) throw new Error(`unsupported key "${raw}" on Wayland`);
    keys.push(k);
  }
  return keys;
}

const YDOTOOL_SETUP_HINT =
  'Wayland input needs ydotool with access to /dev/uinput (and, for ydotool >= 1.0, the ydotoold daemon running). ' +
  'Run the desktop_info tool for setup steps, or see https://github.com/LukeLamb/claude-linux-mcp#wayland-setup';

async function ydotool(args, opts = {}) {
  if (!BIN.ydotool) return { code: -1, stdout: '', stderr: `ydotool is not installed. Install with: sudo apt install ydotool. ${YDOTOOL_SETUP_HINT}` };
  const r = await run(BIN.ydotool, args, opts);
  if (r.code !== 0 && /uinput|ydotoold|socket/i.test(`${r.stdout}${r.stderr}`)) {
    r.stderr = `${(r.stderr || r.stdout).trim()}. ${YDOTOOL_SETUP_HINT}`;
  }
  return r;
}

async function waylandKey(combo) {
  const sequences = combo.trim().split(/\s+/).map(comboToKeys);
  if (ydotoolFlavor() === 'legacy') {
    return ydotool(['key', ...sequences.map(keys => keys.map(k => `KEY_${k}`).join('+'))]);
  }
  const events = [];
  for (const keys of sequences) {
    for (const k of keys) events.push(`${KEYCODES[k]}:1`);
    for (const k of [...keys].reverse()) events.push(`${KEYCODES[k]}:0`);
  }
  return ydotool(['key', ...events]);
}

// ydotool 1.x button codes: low nibble = button, 0x40 = down, 0x80 = up.
const MODERN_BUTTON = { left: 0x00, right: 0x01, middle: 0x02 };
const LEGACY_BUTTON = { left: '1', right: '2', middle: '3' };

async function waylandMoveAbs(x, y) {
  return ydotoolFlavor() === 'legacy'
    ? ydotool(['mousemove', String(x), String(y)])
    : ydotool(['mousemove', '--absolute', '-x', String(x), '-y', String(y)]);
}

function legacyUnsupported(what) {
  return errorResult(`${what} needs ydotool >= 1.0 on Wayland; this system has ydotool 0.1.x. ${YDOTOOL_SETUP_HINT}`);
}

// ─── Wayland windows (GNOME helper extension) ─────────────────────────────
// GNOME doesn't let outside programs list or move windows on Wayland, so a
// tiny bundled Shell extension exposes that over D-Bus.
const HELPER_UUID = 'claude-linux-mcp@lukelamb.github.io';
const HELPER_PATH = '/io/github/lukelamb/ClaudeLinuxMcp';
const HELPER_IFACE = 'io.github.lukelamb.ClaudeLinuxMcp';

async function helperCall(method, signature = '', args = []) {
  if (!BIN.busctl) return { ok: false, error: 'busctl (systemd) not found' };
  const argv = ['--user', '--json=short', 'call', '--', 'org.gnome.Shell', HELPER_PATH, HELPER_IFACE, method];
  if (signature) argv.push(signature, ...args.map(String));
  const r = await run(BIN.busctl, argv);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  try {
    const parsed = r.stdout.trim() ? JSON.parse(r.stdout) : { data: [] };
    return { ok: true, data: parsed.data };
  } catch (e) {
    return { ok: false, error: `unparseable busctl output: ${e.message}` };
  }
}

async function helperWindows() {
  const r = await helperCall('List');
  if (!r.ok) return r;
  try { return { ok: true, windows: JSON.parse(r.data[0]) }; }
  catch (e) { return { ok: false, error: `bad window list: ${e.message}` }; }
}

function helperMissingNote(error) {
  return `GNOME helper extension not reachable (${error}). Without it only XWayland windows are visible. ` +
    `Install it with the steps from the desktop_info tool, then log out and back in.`;
}

// Case-insensitive substring match on title, like wmctrl.
function matchWindow(windows, pattern) {
  const p = pattern.toLowerCase();
  return windows.find(w => (w.title || '').toLowerCase().includes(p)) || null;
}

// ─── Tool: screenshot ─────────────────────────────────────────────────────
// Preference: maim > scrot > gnome-screenshot.  maim and scrot are small,
// focused, reliable CLI tools with no dbus dependency. gnome-screenshot
// can fail in layered-sandbox environments (Snap/Flatpak env pollution)
// or when the GNOME Shell session bus isn't reachable. If the chosen tool
// fails at runtime, we fall through to the next one.
async function screenshot(args) {
  if (!haveScreenshotTool()) {
    return errorResult('No screenshot tool found. Install one: sudo apt install maim (preferred), or scrot, or gnome-screenshot.');
  }
  fs.mkdirSync(SHOTS_ROOT, { recursive: true });
  const out = args.path || path.join(SHOTS_ROOT, `shot-${Date.now()}.png`);
  const active = args.active_window === true;
  const env = cleanEnv();

  // Try each installed tool in order; fall through on runtime failure.
  const attempts = [];

  async function tryMaim() {
    if (!BIN.maim) return null;
    const args2 = active && BIN.xdotool
      ? ['-i', (await run(BIN.xdotool, ['getactivewindow'], { env })).stdout.trim(), out]
      : [out];
    return { tool: 'maim', ...(await run(BIN.maim, args2, { env })) };
  }
  async function tryScrot() {
    if (!BIN.scrot) return null;
    return { tool: 'scrot', ...(await run(BIN.scrot, active ? ['-u', out] : [out], { env })) };
  }
  async function tryGnome() {
    if (!BIN.gnomeShot) return null;
    return { tool: 'gnome-screenshot', ...(await run(BIN.gnomeShot, active ? ['-w', '-f', out] : ['-f', out], { env })) };
  }
  // wlroots compositors (Sway, Hyprland). grim can't capture "the active
  // window" by itself, so active_window falls back to the full screen.
  async function tryGrim() {
    if (!BIN.grim) return null;
    return { tool: 'grim', ...(await run(BIN.grim, [out], { env })) };
  }

  // maim/scrot only see XWayland windows on Wayland, so skip them there.
  const order = WAYLAND ? [tryGnome, tryGrim] : [tryMaim, tryScrot, tryGnome];
  for (const attempt of order) {
    // Clear any stale file before each attempt so size=0 check is meaningful.
    try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) {}
    const r = await attempt();
    if (!r) continue;
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    attempts.push({ tool: r.tool, code: r.code, size, stderr: (r.stderr || '').slice(0, 200) });
    if (r.code === 0 && size > 0) {
      return textResult({ path: out, size_bytes: size, active_window: active, tool: r.tool });
    }
  }

  return errorResult(
    `screenshot failed. Tried: ${attempts.map(a => `${a.tool}(code=${a.code}, size=${a.size})`).join('; ') || '<none installed>'}. ` +
    `DISPLAY=${process.env.DISPLAY || 'unset'}, XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || 'unset'}, backend=${SESSION}. ` +
    (WAYLAND
      ? 'On GNOME Wayland install gnome-screenshot (sudo apt install gnome-screenshot); on Sway/Hyprland install grim.'
      : "If you only have gnome-screenshot installed and it's failing, try: sudo apt install maim")
  );
}

// ─── Tool: list_windows ───────────────────────────────────────────────────
async function listWindows() {
  if (WAYLAND) {
    const r = await helperWindows();
    if (r.ok) {
      return textResult({
        windows: r.windows.map(w => ({
          id: String(w.id),
          desktop: w.workspace,
          pid: w.pid,
          x: w.x, y: w.y, width: w.width, height: w.height,
          title: w.title,
          wm_class: w.wm_class,
          focused: w.focus === true,
        })),
      });
    }
    if (!BIN.wmctrl) return errorResult(helperMissingNote(r.error));
    const x = await listWindowsWmctrl();
    if (x.isError) return x;
    const data = JSON.parse(x.content[0].text);
    return textResult({ ...data, xwayland_only: true, note: helperMissingNote(r.error) });
  }
  return listWindowsWmctrl();
}

async function listWindowsWmctrl() {
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  const r = await run(BIN.wmctrl, ['-l', '-G', '-p']);
  if (r.code !== 0) return errorResult(`wmctrl failed: ${r.stderr || r.stdout}`);
  const entries = r.stdout.split('\n').filter(Boolean).map((line) => {
    // Format: <id> <desktop> <pid> <x> <y> <width> <height> <host> <title...>
    const parts = line.split(/\s+/);
    if (parts.length < 9) return null;
    const [id, desktop, pid, x, y, w, h, host, ...titleParts] = parts;
    return {
      id,
      desktop: parseInt(desktop, 10),
      pid: parseInt(pid, 10),
      x: parseInt(x, 10),
      y: parseInt(y, 10),
      width: parseInt(w, 10),
      height: parseInt(h, 10),
      host,
      title: titleParts.join(' '),
    };
  }).filter(Boolean);
  return textResult({ windows: entries });
}

// ─── Tool: focus_window ───────────────────────────────────────────────────
// On Wayland, run `action(window)` against the helper extension's window
// list; returns null when the helper is unavailable so callers can fall
// back to wmctrl (XWayland windows only).
async function withHelperWindow(pattern, action) {
  if (!WAYLAND) return null;
  const r = await helperWindows();
  if (!r.ok) {
    if (BIN.wmctrl) return null;
    return errorResult(helperMissingNote(r.error));
  }
  const win = matchWindow(r.windows, pattern);
  if (!win) return errorResult(`no window matched "${pattern}"`);
  return action(win);
}

async function focusWindow(args) {
  if (!args.title_pattern) return errorResult('title_pattern is required');
  const viaHelper = await withHelperWindow(args.title_pattern, async (win) => {
    const r = await helperCall('Activate', 't', [win.id]);
    if (!r.ok) return errorResult(`focus_window failed: ${r.error}`);
    return textResult({ matched: args.title_pattern, title: win.title, focused: true });
  });
  if (viaHelper) return viaHelper;
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  const r = await run(BIN.wmctrl, ['-a', args.title_pattern]);
  if (r.code !== 0) return errorResult(`no window matched "${args.title_pattern}"`);
  return textResult({ matched: args.title_pattern, focused: true });
}

// ─── Tool: move_window ────────────────────────────────────────────────────
async function moveWindow(args) {
  if (!args.title_pattern) return errorResult('title_pattern is required');
  const viaHelper = await withHelperWindow(args.title_pattern, async (win) => {
    const g = {
      x: args.x ?? win.x, y: args.y ?? win.y,
      width: args.width ?? win.width, height: args.height ?? win.height,
    };
    const r = await helperCall('MoveResize', 'tiiii', [win.id, g.x, g.y, g.width, g.height]);
    if (!r.ok) return errorResult(`move_window failed: ${r.error}`);
    return textResult({ matched: args.title_pattern, title: win.title, geometry: g });
  });
  if (viaHelper) return viaHelper;
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  const x = args.x ?? -1;
  const y = args.y ?? -1;
  const w = args.width ?? -1;
  const h = args.height ?? -1;
  const r = await run(BIN.wmctrl, ['-r', args.title_pattern, '-e', `0,${x},${y},${w},${h}`]);
  if (r.code !== 0) return errorResult(`move_window failed: ${r.stderr || r.stdout || 'unknown'}`);
  return textResult({ matched: args.title_pattern, geometry: { x, y, width: w, height: h } });
}

// ─── Tool: close_window ───────────────────────────────────────────────────
async function closeWindow(args) {
  if (!args.title_pattern) return errorResult('title_pattern is required');
  const viaHelper = await withHelperWindow(args.title_pattern, async (win) => {
    const r = await helperCall('Close', 't', [win.id]);
    if (!r.ok) return errorResult(`close_window failed: ${r.error}`);
    return textResult({ matched: args.title_pattern, title: win.title, close_requested: true });
  });
  if (viaHelper) return viaHelper;
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  const r = await run(BIN.wmctrl, ['-c', args.title_pattern]);
  if (r.code !== 0) return errorResult(`close_window failed: ${r.stderr || r.stdout || 'unknown'}`);
  return textResult({ matched: args.title_pattern, close_requested: true });
}

// ─── Tool: mouse_move ─────────────────────────────────────────────────────
async function mouseMove(args) {
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    return errorResult('x and y are required numbers');
  }
  if (WAYLAND) {
    const r = await waylandMoveAbs(args.x, args.y);
    if (r.code !== 0) return errorResult(`mouse_move failed: ${r.stderr || r.stdout}`);
    return textResult({ x: args.x, y: args.y });
  }
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const r = await run(BIN.xdotool, ['mousemove', String(args.x), String(args.y)]);
  if (r.code !== 0) return errorResult(`mouse_move failed: ${r.stderr || r.stdout}`);
  return textResult({ x: args.x, y: args.y });
}

// ─── Tool: mouse_click ────────────────────────────────────────────────────
async function mouseClick(args) {
  if (WAYLAND) {
    const name = args.button || 'left';
    if (!(name in MODERN_BUTTON)) return errorResult(`unknown button "${args.button}" (expected left|middle|right)`);
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      const m = await waylandMoveAbs(args.x, args.y);
      if (m.code !== 0) return errorResult(`mouse_click failed: ${m.stderr || m.stdout}`);
    }
    const r = ydotoolFlavor() === 'legacy'
      ? await ydotool(['click', LEGACY_BUTTON[name]])
      : await ydotool(['click', `0x${(0xC0 | MODERN_BUTTON[name]).toString(16)}`]);
    if (r.code !== 0) return errorResult(`mouse_click failed: ${r.stderr || r.stdout}`);
    return textResult({ button: name, x: args.x ?? null, y: args.y ?? null });
  }
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const button = buttonCode(args.button || 'left');
  if (!button) return errorResult(`unknown button "${args.button}" (expected left|middle|right)`);
  const cmd = [];
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    cmd.push('mousemove', String(args.x), String(args.y));
  }
  cmd.push('click', button);
  const r = await run(BIN.xdotool, cmd);
  if (r.code !== 0) return errorResult(`mouse_click failed: ${r.stderr || r.stdout}`);
  return textResult({ button: args.button || 'left', x: args.x ?? null, y: args.y ?? null });
}

// ─── Tool: mouse_drag ─────────────────────────────────────────────────────
async function mouseDrag(args) {
  for (const k of ['x1', 'y1', 'x2', 'y2']) {
    if (typeof args[k] !== 'number') return errorResult(`${k} is required (number)`);
  }
  if (WAYLAND) {
    const name = args.button || 'left';
    if (!(name in MODERN_BUTTON)) return errorResult(`unknown button "${args.button}"`);
    if (ydotoolFlavor() === 'legacy') return legacyUnsupported('mouse_drag');
    const btn = MODERN_BUTTON[name];
    // The second move is relative: an absolute move would first slam the
    // pointer into the top-left corner with the button still held.
    const steps = [
      () => waylandMoveAbs(args.x1, args.y1),
      () => ydotool(['click', `0x${(0x40 | btn).toString(16)}`]),
      () => ydotool(['mousemove', '-x', String(args.x2 - args.x1), '-y', String(args.y2 - args.y1)]),
      () => ydotool(['click', `0x${(0x80 | btn).toString(16)}`]),
    ];
    for (const step of steps) {
      const r = await step();
      if (r.code !== 0) {
        await ydotool(['click', `0x${(0x80 | btn).toString(16)}`]);
        return errorResult(`mouse_drag failed: ${r.stderr || r.stdout}`);
      }
    }
    return textResult({ from: { x: args.x1, y: args.y1 }, to: { x: args.x2, y: args.y2 }, button: name });
  }
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const button = buttonCode(args.button || 'left');
  if (!button) return errorResult(`unknown button "${args.button}"`);
  const r = await run(BIN.xdotool, [
    'mousemove', String(args.x1), String(args.y1),
    'mousedown', button,
    'mousemove', String(args.x2), String(args.y2),
    'mouseup', button,
  ]);
  if (r.code !== 0) return errorResult(`mouse_drag failed: ${r.stderr || r.stdout}`);
  return textResult({ from: { x: args.x1, y: args.y1 }, to: { x: args.x2, y: args.y2 }, button: args.button || 'left' });
}

// ─── Tool: mouse_scroll ───────────────────────────────────────────────────
async function mouseScroll(args) {
  const amount = Math.max(1, Math.floor(args.amount ?? 3));
  if (WAYLAND) {
    // REL_WHEEL > 0 scrolls up, REL_HWHEEL > 0 scrolls right.
    const delta = { up: [0, amount], down: [0, -amount], left: [-amount, 0], right: [amount, 0] }[args.direction];
    if (!delta) return errorResult(`unknown direction "${args.direction}" (expected up|down|left|right)`);
    if (ydotoolFlavor() === 'legacy') return legacyUnsupported('mouse_scroll');
    const r = await ydotool(['mousemove', '--wheel', '-x', String(delta[0]), '-y', String(delta[1])]);
    if (r.code !== 0) return errorResult(`mouse_scroll failed: ${r.stderr || r.stdout}`);
    return textResult({ direction: args.direction, amount });
  }
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const button = buttonCode(args.direction, true);
  if (!button) return errorResult(`unknown direction "${args.direction}" (expected up|down|left|right)`);
  const r = await run(BIN.xdotool, ['click', '--repeat', String(amount), button]);
  if (r.code !== 0) return errorResult(`mouse_scroll failed: ${r.stderr || r.stdout}`);
  return textResult({ direction: args.direction, amount });
}

// ─── Tool: type_text ──────────────────────────────────────────────────────
async function typeText(args) {
  if (typeof args.text !== 'string') return errorResult('text is required (string)');
  const delay = Math.max(0, Math.floor(args.delay ?? 12));
  if (WAYLAND) return waylandTypeText(args.text, delay, args.method || 'auto');
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const r = await run(BIN.xdotool, ['type', '--delay', String(delay), '--', args.text]);
  if (r.code !== 0) return errorResult(`type_text failed: ${r.stderr || r.stdout}`);
  return textResult({ length: args.text.length, delay_ms: delay });
}

// ─── Tool: key_press ──────────────────────────────────────────────────────
async function keyPress(args) {
  if (typeof args.combo !== 'string' || !args.combo) return errorResult('combo is required (e.g. "ctrl+c")');
  if (WAYLAND) {
    let r;
    try { r = await waylandKey(args.combo); }
    catch (e) { return errorResult(`key_press failed: ${e.message}`); }
    if (r.code !== 0) return errorResult(`key_press failed: ${r.stderr || r.stdout}`);
    return textResult({ combo: args.combo });
  }
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const r = await run(BIN.xdotool, ['key', '--', args.combo]);
  if (r.code !== 0) return errorResult(`key_press failed: ${r.stderr || r.stdout}`);
  return textResult({ combo: args.combo });
}

// ─── Tool: clipboard_get ──────────────────────────────────────────────────
// On Wayland prefer wl-clipboard; xclip still works there through XWayland
// (GNOME syncs the two clipboards), so it is the fallback.
async function readClipboard() {
  if (WAYLAND && BIN.wlPaste) {
    const r = await run(BIN.wlPaste, ['--no-newline']);
    return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr.trim() || 'empty' };
  }
  if (!BIN.xclip) {
    return { ok: false, error: WAYLAND ? requireBin('wlPaste') : requireBin('xclip') };
  }
  const r = await run(BIN.xclip, ['-selection', 'clipboard', '-o']);
  return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: r.stderr.trim() || 'empty' };
}

async function clipboardGet() {
  const r = await readClipboard();
  if (!r.ok) return errorResult(`clipboard_get failed: ${r.error}`);
  return textResult({ text: r.text });
}

// ─── Tool: clipboard_set ──────────────────────────────────────────────────
// Special-cased because `xclip -i` refuses to fork into its background
// selection-owner daemon when stdout is piped to the parent — it stays
// foreground and the selection evaporates as soon as xclip exits. We
// spawn detached with stdout/stderr set to 'ignore' so xclip forks
// cleanly, hand it the text on stdin, and resolve after a short window.
// wl-copy forks the same way by default, so the same spawn pattern works.
function writeClipboard(text) {
  const useWl = WAYLAND && BIN.wlCopy;
  if (!useWl && !BIN.xclip) {
    return Promise.resolve({ ok: false, error: WAYLAND ? requireBin('wlCopy') : requireBin('xclip') });
  }
  const [cmd, argv] = useWl ? [BIN.wlCopy, []] : [BIN.xclip, ['-selection', 'clipboard', '-i']];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.unref();
    try { child.stdin.end(text); } catch (_) {}
    // The tool forks once it has stdin; give it ~150ms to become the selection owner.
    setTimeout(() => resolve({ ok: true }), 150);
  });
}

async function clipboardSet(args) {
  if (typeof args.text !== 'string') return errorResult('text is required (string)');
  const r = await writeClipboard(args.text);
  if (!r.ok) return errorResult(`clipboard_set failed: ${r.error}`);
  return textResult({ length: args.text.length });
}

// ydotool types with a US keymap, which garbles text on layouts such as
// AZERTY. "auto" types on US-like layouts and pastes via the clipboard
// otherwise (restoring the previous clipboard afterwards).
async function waylandTypeText(text, delay, method) {
  const layout = keyboardLayout();
  const chosen = method === 'auto' ? (!layout || US_LIKE.has(layout) ? 'type' : 'paste') : method;
  if (chosen === 'paste') {
    const previous = await readClipboard();
    const w = await writeClipboard(text);
    if (!w.ok) return errorResult(`type_text failed: ${w.error}`);
    let k;
    try { k = await waylandKey('ctrl+v'); }
    catch (e) { return errorResult(`type_text failed: ${e.message}`); }
    if (k.code !== 0) return errorResult(`type_text failed: ${k.stderr || k.stdout}`);
    // Let the target app read the clipboard before restoring it.
    await new Promise((res) => setTimeout(res, 300));
    if (previous.ok) await writeClipboard(previous.text);
    return textResult({ length: text.length, method: 'paste', layout });
  }
  if (chosen !== 'type') return errorResult(`unknown method "${method}" (expected auto|type|paste)`);
  const r = ydotoolFlavor() === 'legacy'
    ? await ydotool(['type', '--key-delay', String(delay), '--file', '-'], { stdin: text })
    : await ydotool(['type', '--key-delay', String(delay), '--escape', '0', '--', text]);
  if (r.code !== 0) return errorResult(`type_text failed: ${r.stderr || r.stdout}`);
  return textResult({ length: text.length, delay_ms: delay, method: 'type', layout });
}

// ─── Tool: desktop_info ───────────────────────────────────────────────────
// Reports which backend is active, what's installed, and what's missing,
// with the commands to fix it.
async function desktopInfo() {
  const helper = WAYLAND ? await helperCall('Version') : null;
  const helperOk = !!(helper && helper.ok);
  const helperSrc = path.join(__dirname, 'gnome-extension', HELPER_UUID);
  const tools = {};
  for (const [k, v] of Object.entries(BIN)) tools[k] = v || null;

  const missing = [];
  if (WAYLAND) {
    if (!BIN.ydotool) missing.push('ydotool (mouse/keyboard): sudo apt install ydotool');
    if (!BIN.wlCopy) missing.push('wl-clipboard (clipboard): sudo apt install wl-clipboard');
    if (!haveScreenshotTool()) missing.push('gnome-screenshot (screenshots): sudo apt install gnome-screenshot');
    if (!helperOk) missing.push('GNOME helper extension (window list/focus/move/close): see setup.helper_extension');
  } else {
    for (const k of ['xdotool', 'wmctrl', 'xclip']) if (!BIN[k]) missing.push(`${k}: sudo apt install ${APT_PKG[k]}`);
    if (!haveScreenshotTool()) missing.push('maim (screenshots): sudo apt install maim');
  }

  return textResult({
    session: SESSION,
    xdg_session_type: process.env.XDG_SESSION_TYPE || null,
    wayland_display: process.env.WAYLAND_DISPLAY || null,
    display: process.env.DISPLAY || null,
    keyboard_layout: keyboardLayout(),
    ydotool_flavor: WAYLAND ? ydotoolFlavor() : undefined,
    helper_extension: WAYLAND ? (helperOk ? 'running' : `not reachable: ${helper.error}`) : undefined,
    tools,
    missing,
    setup: WAYLAND ? {
      packages: 'sudo apt install ydotool wl-clipboard gnome-screenshot tesseract-ocr',
      uinput_access: [
        'sudo groupadd -f uinput',
        'sudo usermod -aG uinput "$USER"',
        `echo 'KERNEL=="uinput", GROUP="uinput", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/60-uinput.rules`,
        'sudo udevadm control --reload-rules && sudo udevadm trigger',
        'log out and back in so the new group applies',
      ],
      ydotoold: 'ydotool >= 1.0 only: systemctl --user enable --now ydotool',
      pointer_accuracy: "gsettings set org.gnome.desktop.peripherals.mouse accel-profile 'flat'  (absolute mouse moves are only exact without acceleration)",
      helper_extension: [
        'mkdir -p ~/.local/share/gnome-shell/extensions',
        `cp -r '${helperSrc}' ~/.local/share/gnome-shell/extensions/`,
        'log out and back in (GNOME on Wayland only loads new extensions at login)',
        `gnome-extensions enable ${HELPER_UUID}`,
      ],
    } : undefined,
  });
}

// ─── Tool: launch_app ─────────────────────────────────────────────────────
function launchApp(args) {
  if (typeof args.command !== 'string' || !args.command.trim()) {
    return errorResult('command is required (string)');
  }
  try {
    const child = spawn('sh', ['-c', args.command], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return textResult({ command: args.command, pid: child.pid });
  } catch (e) {
    return errorResult(`launch_app failed: ${e.message}`);
  }
}

// ─── Tool: screenshot_text ────────────────────────────────────────────────
// Take a screenshot, then OCR it with tesseract. Returns the recognized
// text plus the path to the underlying PNG. Useful when Claude needs to
// READ what's on screen (log windows, error dialogs, terminal output in
// non-focused windows) rather than just see the image.
async function screenshotText(args) {
  if (!BIN.tesseract) {
    return errorResult('tesseract is not installed. Install with: sudo apt install tesseract-ocr tesseract-ocr-eng (add tesseract-ocr-<lang> for other languages).');
  }
  // Reuse the screenshot tool to capture (and inherit its fallback chain).
  const shot = await screenshot({ active_window: args.active_window === true, path: args.path });
  if (shot.isError) return shot;
  // screenshot returns { content: [{ type: 'text', text: JSON.stringify({path, ...}) }] }
  const meta = JSON.parse(shot.content[0].text);
  const lang = (typeof args.lang === 'string' && args.lang.trim()) ? args.lang.trim() : 'eng';
  // tesseract <input> stdout -l <lang> writes plain text to stdout.
  const r = await run(BIN.tesseract, [meta.path, 'stdout', '-l', lang], {
    env: cleanEnv(),
  });
  if (r.code !== 0) {
    return errorResult(`tesseract failed (code ${r.code}): ${r.stderr || r.stdout || 'unknown'}. If lang=${lang} is missing, install tesseract-ocr-${lang}.`);
  }
  const text = (r.stdout || '').replace(/\f$/, '').trimEnd();
  return textResult({
    path: meta.path,
    size_bytes: meta.size_bytes,
    active_window: meta.active_window,
    tool: meta.tool,
    lang,
    text,
    text_length: text.length,
  });
}

// ─── Tool registry ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the full screen (or the active window if active_window=true). Saves a PNG under /tmp/claude-linux-mcp/shots/ and returns the path.',
    annotations: { title: 'Take screenshot', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional target path. Defaults to /tmp/claude-linux-mcp/shots/shot-<ts>.png.' },
        active_window: { type: 'boolean', description: 'If true, capture only the currently-focused window instead of the full screen.' },
      },
    },
  },
  {
    name: 'list_windows',
    description: 'List all visible windows with id, pid, desktop, geometry (x/y/width/height), hostname, and title.',
    annotations: { title: 'List windows', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'focus_window',
    description: 'Bring the first window whose title contains the given pattern (case-insensitive) to the foreground.',
    annotations: { title: 'Focus window', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { title_pattern: { type: 'string' } },
      required: ['title_pattern'],
    },
  },
  {
    name: 'move_window',
    description: 'Move and/or resize a window matching the given title pattern. Any of x, y, width, height omitted leaves that dimension unchanged.',
    annotations: { title: 'Move/resize window', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        title_pattern: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['title_pattern'],
    },
  },
  {
    name: 'close_window',
    description: 'Ask the first window whose title contains the given pattern (case-insensitive) to close gracefully.',
    annotations: { title: 'Close window', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { title_pattern: { type: 'string' } },
      required: ['title_pattern'],
    },
  },
  {
    name: 'mouse_move',
    description: 'Move the mouse pointer to absolute screen coordinates (x, y).',
    annotations: { title: 'Move mouse', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_click',
    description: 'Click a mouse button. If x and y are provided, the pointer moves there first; otherwise clicks at the current pointer location.',
    annotations: { title: 'Click mouse', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Default: left.' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
  },
  {
    name: 'mouse_drag',
    description: 'Drag from (x1, y1) to (x2, y2) while holding the given button (default left).',
    annotations: { title: 'Drag mouse', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number' }, y1: { type: 'number' },
        x2: { type: 'number' }, y2: { type: 'number' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Default: left.' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'mouse_scroll',
    description: 'Scroll in a direction (up/down/left/right) by N clicks (default 3).',
    annotations: { title: 'Scroll mouse', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Number of scroll clicks. Default 3.' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'type_text',
    description: 'Type a string into the currently-focused window (emits keystrokes). Use key_press for special/modifier combos.',
    annotations: { title: 'Type text', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        delay: { type: 'number', description: 'Milliseconds between keystrokes. Default 12.' },
        method: { type: 'string', enum: ['auto', 'type', 'paste'], description: 'Wayland only. "type" sends keystrokes (assumes a US keymap); "paste" puts the text on the clipboard, presses ctrl+v, then restores the clipboard. Default "auto": type on US-like layouts, paste otherwise.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'key_press',
    description: "Press a keyboard combination using xdotool's keysym notation. Examples: 'ctrl+c', 'alt+Tab', 'super', 'Return', 'Escape', 'Page_Down'. Separate several combos with spaces. On Wayland, letters, digits, F1-F12, modifiers, arrows/navigation keys and basic punctuation are supported.",
    annotations: { title: 'Press keys', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { combo: { type: 'string' } },
      required: ['combo'],
    },
  },
  {
    name: 'clipboard_get',
    description: 'Read the current clipboard as text.',
    annotations: { title: 'Read clipboard', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_set',
    description: 'Write a string to the clipboard.',
    annotations: { title: 'Write clipboard', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'launch_app',
    description: 'Launch an application via a shell command (e.g. "firefox", "gnome-terminal", "code /path/to/project"). The process is detached from this server.',
    annotations: { title: 'Launch application', destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'screenshot_text',
    description: 'Take a screenshot and OCR it with tesseract. Returns the recognized text plus the path to the underlying PNG. Use when Claude needs to READ what is on screen (log windows, error dialogs, terminal output in non-focused windows) rather than just see the image. Requires tesseract-ocr installed.',
    annotations: { title: 'Read text from screen (OCR)', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        active_window: { type: 'boolean', description: 'If true, capture only the currently-focused window. Default false (full screen).' },
        path: { type: 'string', description: 'Optional target path for the PNG. Defaults to /tmp/claude-linux-mcp/shots/shot-<ts>.png.' },
        lang: { type: 'string', description: 'Tesseract language code (e.g. "eng", "fra", "deu", "nld", or "eng+fra" for multi). Default "eng". Requires the matching tesseract-ocr-<lang> package.' },
      },
    },
  },
];

TOOLS.push({
  name: 'desktop_info',
  description: 'Report the active backend (X11 or Wayland), keyboard layout, which helper tools are installed, what is missing, and the exact setup commands. Run this first when another tool fails.',
  annotations: { title: 'Desktop backend info', readOnlyHint: true },
  inputSchema: { type: 'object', properties: {} },
});

const HANDLERS = {
  screenshot,
  list_windows: listWindows,
  focus_window: focusWindow,
  move_window: moveWindow,
  close_window: closeWindow,
  mouse_move: mouseMove,
  mouse_click: mouseClick,
  mouse_drag: mouseDrag,
  mouse_scroll: mouseScroll,
  type_text: typeText,
  key_press: keyPress,
  clipboard_get: clipboardGet,
  clipboard_set: clipboardSet,
  launch_app: launchApp,
  screenshot_text: screenshotText,
  desktop_info: desktopInfo,
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
// Newest first. Echo the client's requested version when we support it,
// otherwise offer our latest and let the client decide.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(msg.params && msg.params.protocolVersion)
        ? msg.params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'linux-desktop-mcp', version: '0.3.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'tools/list') { respond(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    const handler = HANDLERS[name];
    if (!handler) { error(id, -32601, `unknown tool: ${name}`); return; }
    try {
      const result = await Promise.resolve(handler(args));
      respond(id, result);
    } catch (e) {
      log('tool error:', name, e.message, e.stack);
      respond(id, errorResult(`tool ${name} threw: ${e.message}`));
    }
    return;
  }

  if (id !== undefined && id !== null) error(id, -32601, `method not found: ${method}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────
let inflight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inflight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { log('bad JSON on stdin:', e.message); return; }
  inflight++;
  handle(msg)
    .catch((e) => {
      log('handler crash:', e.message, e.stack);
      if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
    })
    .finally(() => { inflight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(
  'server started, pid', process.pid,
  'session=' + SESSION,
  ...(WAYLAND
    ? ['ydotool=' + (BIN.ydotool || 'MISSING'), 'wl-copy=' + (BIN.wlCopy || 'MISSING')]
    : ['xdotool=' + (BIN.xdotool || 'MISSING'), 'wmctrl=' + (BIN.wmctrl || 'MISSING'), 'xclip=' + (BIN.xclip || 'MISSING')]),
  'screenshot=' + ((WAYLAND ? (BIN.gnomeShot || BIN.grim) : (BIN.gnomeShot || BIN.maim || BIN.scrot)) || 'MISSING')
);
