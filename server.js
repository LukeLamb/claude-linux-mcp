#!/usr/bin/env node
// Linux Desktop MCP server for Claude Desktop (X11 sessions).
// Pure Node, no npm deps. Shells out to xdotool, wmctrl, xclip, gnome-screenshot.
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
};

function haveScreenshotTool() {
  return BIN.gnomeShot || BIN.scrot || BIN.maim;
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
    return `Required system tool "${name}" is not installed. Install with: sudo apt install ${name === 'gnomeShot' ? 'gnome-screenshot' : name === 'xclip' ? 'xclip' : name === 'xdotool' ? 'xdotool' : 'wmctrl'}`;
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

  for (const attempt of [tryMaim, tryScrot, tryGnome]) {
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
    `DISPLAY=${process.env.DISPLAY || 'unset'}, XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE || 'unset'}. ` +
    `If XDG_SESSION_TYPE is "wayland", log out and pick an X11 session; this extension does not support Wayland in v0.1. ` +
    `If you only have gnome-screenshot installed and it's failing, try: sudo apt install maim`
  );
}

// ─── Tool: list_windows ───────────────────────────────────────────────────
async function listWindows() {
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
async function focusWindow(args) {
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  if (!args.title_pattern) return errorResult('title_pattern is required');
  const r = await run(BIN.wmctrl, ['-a', args.title_pattern]);
  if (r.code !== 0) return errorResult(`no window matched "${args.title_pattern}"`);
  return textResult({ matched: args.title_pattern, focused: true });
}

// ─── Tool: move_window ────────────────────────────────────────────────────
async function moveWindow(args) {
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  if (!args.title_pattern) return errorResult('title_pattern is required');
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
  const missing = requireBin('wmctrl');
  if (missing) return errorResult(missing);
  if (!args.title_pattern) return errorResult('title_pattern is required');
  const r = await run(BIN.wmctrl, ['-c', args.title_pattern]);
  if (r.code !== 0) return errorResult(`close_window failed: ${r.stderr || r.stdout || 'unknown'}`);
  return textResult({ matched: args.title_pattern, close_requested: true });
}

// ─── Tool: mouse_move ─────────────────────────────────────────────────────
async function mouseMove(args) {
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  if (typeof args.x !== 'number' || typeof args.y !== 'number') {
    return errorResult('x and y are required numbers');
  }
  const r = await run(BIN.xdotool, ['mousemove', String(args.x), String(args.y)]);
  if (r.code !== 0) return errorResult(`mouse_move failed: ${r.stderr || r.stdout}`);
  return textResult({ x: args.x, y: args.y });
}

// ─── Tool: mouse_click ────────────────────────────────────────────────────
async function mouseClick(args) {
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
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const button = buttonCode(args.button || 'left');
  if (!button) return errorResult(`unknown button "${args.button}"`);
  for (const k of ['x1', 'y1', 'x2', 'y2']) {
    if (typeof args[k] !== 'number') return errorResult(`${k} is required (number)`);
  }
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
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  const button = buttonCode(args.direction, true);
  if (!button) return errorResult(`unknown direction "${args.direction}" (expected up|down|left|right)`);
  const amount = Math.max(1, Math.floor(args.amount ?? 3));
  const r = await run(BIN.xdotool, ['click', '--repeat', String(amount), button]);
  if (r.code !== 0) return errorResult(`mouse_scroll failed: ${r.stderr || r.stdout}`);
  return textResult({ direction: args.direction, amount });
}

// ─── Tool: type_text ──────────────────────────────────────────────────────
async function typeText(args) {
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  if (typeof args.text !== 'string') return errorResult('text is required (string)');
  const delay = Math.max(0, Math.floor(args.delay ?? 12));
  const r = await run(BIN.xdotool, ['type', '--delay', String(delay), '--', args.text]);
  if (r.code !== 0) return errorResult(`type_text failed: ${r.stderr || r.stdout}`);
  return textResult({ length: args.text.length, delay_ms: delay });
}

// ─── Tool: key_press ──────────────────────────────────────────────────────
async function keyPress(args) {
  const missing = requireBin('xdotool');
  if (missing) return errorResult(missing);
  if (typeof args.combo !== 'string' || !args.combo) return errorResult('combo is required (e.g. "ctrl+c")');
  const r = await run(BIN.xdotool, ['key', '--', args.combo]);
  if (r.code !== 0) return errorResult(`key_press failed: ${r.stderr || r.stdout}`);
  return textResult({ combo: args.combo });
}

// ─── Tool: clipboard_get ──────────────────────────────────────────────────
async function clipboardGet() {
  const missing = requireBin('xclip');
  if (missing) return errorResult(missing);
  const r = await run(BIN.xclip, ['-selection', 'clipboard', '-o']);
  if (r.code !== 0) return errorResult(`clipboard_get failed: ${r.stderr || 'empty'}`);
  return textResult({ text: r.stdout });
}

// ─── Tool: clipboard_set ──────────────────────────────────────────────────
async function clipboardSet(args) {
  const missing = requireBin('xclip');
  if (missing) return errorResult(missing);
  if (typeof args.text !== 'string') return errorResult('text is required (string)');
  const r = await run(BIN.xclip, ['-selection', 'clipboard', '-i'], { stdin: args.text });
  if (r.code !== 0) return errorResult(`clipboard_set failed: ${r.stderr || r.stdout}`);
  return textResult({ length: args.text.length });
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
    description: 'Bring a window matching the given title pattern (substring, case-insensitive per wmctrl) to the foreground.',
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
    description: 'Request a window matching the given title pattern to close (gracefully, via the WM close hint).',
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
      },
      required: ['text'],
    },
  },
  {
    name: 'key_press',
    description: "Press a keyboard combination using xdotool's keysym notation. Examples: 'ctrl+c', 'alt+Tab', 'super', 'Return', 'Escape', 'Page_Down'.",
    annotations: { title: 'Press keys', destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { combo: { type: 'string' } },
      required: ['combo'],
    },
  },
  {
    name: 'clipboard_get',
    description: 'Read the current X11 CLIPBOARD selection as text.',
    annotations: { title: 'Read clipboard', readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clipboard_set',
    description: 'Write a string to the X11 CLIPBOARD selection.',
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
];

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
};

// ─── JSON-RPC dispatch ────────────────────────────────────────────────────
async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'linux-desktop-mcp', version: '0.1.1' },
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
  'xdotool=' + (BIN.xdotool || 'MISSING'),
  'wmctrl=' + (BIN.wmctrl || 'MISSING'),
  'xclip=' + (BIN.xclip || 'MISSING'),
  'screenshot=' + (BIN.gnomeShot || BIN.maim || BIN.scrot || 'MISSING')
);
