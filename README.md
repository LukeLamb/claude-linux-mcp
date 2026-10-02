# Linux Desktop — Claude Desktop extension

A [Claude Desktop](https://claude.ai/download) extension that gives Claude full desktop control on Linux (X11 and Wayland): screenshot, mouse, keyboard, window management, clipboard, and app launch.

Fills the same niche as [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) but for Linux. Built to pair with [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) — Terminal handles the shell; this handles the GUI.

---

## ⚠️ Security — read this first

**Installing this extension gives Claude full control over your desktop.** Anything you can do with a keyboard and mouse, Claude can do through this tool:

- Move your mouse anywhere and click anything (including dialogs, "Yes" buttons, Send buttons in open chat windows)
- Type into whatever window currently has focus (including password fields)
- Read and write your clipboard (so anything you've copied recently is visible)
- Launch applications
- Close windows (including unsaved work)

Treat installing this like giving someone physical access to your keyboard and mouse while they sit at your desk. **Don't install it on machines with sensitive data you wouldn't want Claude to interact with, on shared systems, or if you're going to leave a chat unattended.**

The denylist-style protection used by [claude-terminal-mcp](https://github.com/LukeLamb/claude-terminal-mcp) doesn't really apply here — a mouse click is a mouse click; you can't pattern-match intent. The safety rails in v0.1 are: (1) honest framing in this README, (2) `destructiveHint: true` annotations on every tool that changes system state, so Claude's own reasoning layer is aware, (3) the install flow requires explicit Extension Developer mode (red "unverified" warning).

---

## What it does

Sixteen tools:

| Tool | Purpose |
|---|---|
| `screenshot` | Capture full screen (or active window if `active_window: true`) as PNG. Returns path. |
| `list_windows` | Enumerate visible windows with id/pid/geometry/title. |
| `focus_window(title_pattern)` | Bring a window to the foreground. |
| `move_window(title_pattern, x?, y?, width?, height?)` | Move/resize a window. |
| `close_window(title_pattern)` | Request a window to close gracefully. |
| `mouse_move(x, y)` | Move pointer to absolute screen coordinates. |
| `mouse_click(button?, x?, y?)` | Click left/middle/right; optional coords. |
| `mouse_drag(x1, y1, x2, y2, button?)` | Drag from → to. |
| `mouse_scroll(direction, amount?)` | Scroll up/down/left/right by N clicks. |
| `type_text(text, delay?, method?)` | Type a string into the focused window. On Wayland, `method` picks keystrokes or a clipboard paste (see below). |
| `key_press(combo)` | Press a combo like `ctrl+c`, `alt+Tab`, `super`, `Return`. |
| `clipboard_get()` | Read the CLIPBOARD selection as text. |
| `clipboard_set(text)` | Write a string to the CLIPBOARD. |
| `launch_app(command)` | Spawn an application detached (e.g. `firefox`, `gnome-terminal`, `code /path`). |
| `screenshot_text(active_window?, path?, lang?)` | Screenshot + OCR with tesseract; returns the recognized text. |
| `desktop_info()` | Shows the active backend (X11/Wayland), keyboard layout, what's installed, what's missing, and the exact setup commands. |

All shell out to small, well-known CLI tools — no npm dependencies. The backend is picked automatically from `$XDG_SESSION_TYPE` / `$WAYLAND_DISPLAY`; set `CLAUDE_LINUX_MCP_BACKEND=x11` or `wayland` to override.

---

## Requirements

**Display server:** X11 or Wayland. To check which session you're on:

```bash
echo $XDG_SESSION_TYPE
```

If it says `wayland`, follow [Wayland setup](#wayland-setup) below instead of this section.

**System tools for X11 (one-time install):**

```bash
sudo apt install xdotool wmctrl xclip
```

`gnome-screenshot` ships with Ubuntu GNOME; if you're on a different DE, install a screenshot tool:

```bash
# One of:
sudo apt install gnome-screenshot    # GNOME, works everywhere
sudo apt install scrot               # Minimal CLI
sudo apt install maim                # Modern replacement for scrot
```

**OCR (optional, for `screenshot_text` — added in v0.2):**

```bash
sudo apt install tesseract-ocr tesseract-ocr-eng
# Add tesseract-ocr-<lang> for other languages (fra, deu, nld, …).
```

If tesseract isn't installed, only `screenshot_text` is unavailable — the other tools work normally.

**Claude Desktop:** ≥ 0.10.0 on Linux (bundles a recent Node; no system Node required).

### Wayland setup

Wayland doesn't let one program read or drive another's windows, so each job uses a different tool:

| Job | Tool |
|---|---|
| Mouse and keyboard | `ydotool` (injects input through `/dev/uinput`) |
| Clipboard | `wl-clipboard` (`xclip` is used as a fallback) |
| Screenshots | `gnome-screenshot` on GNOME, `grim` on Sway/Hyprland |
| Window list/focus/move/close | the bundled GNOME Shell helper extension (without it, only XWayland windows are visible via `wmctrl`) |

Run the `desktop_info` tool at any point; it reports what's missing and prints these commands with the right paths filled in.

1. **Packages:**

   ```bash
   sudo apt install ydotool wl-clipboard gnome-screenshot
   ```

2. **Let your user drive `/dev/uinput`** (a dedicated group, rather than `input`, which could also read every keyboard). The rule is numbered `99-` so it runs after the one Debian's ydotool package installs:

   ```bash
   sudo groupadd -f uinput
   sudo usermod -aG uinput "$USER"
   echo 'KERNEL=="uinput", GROUP="uinput", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/99-uinput.rules
   sudo udevadm control --reload-rules && sudo udevadm trigger
   ```

   **Reboot** so the group applies. Logging out isn't always enough: the systemd user session that starts terminals and `ydotoold` can outlive it. Afterwards `id | grep uinput` should match and `ls -l /dev/uinput` should show group `uinput`.

3. **ydotool 1.0 or newer only: start the daemon.** Check with `ydotool` (no arguments). If its command list has no `recorder` entry, you have 1.x:

   ```bash
   systemctl --user enable --now ydotool
   ```

   ydotool 0.1.x (what Ubuntu 24.04 packages) needs no daemon, but it can't drag or scroll.

4. **Make absolute mouse moves exact.** ydotool positions the pointer by moving it relatively from the top-left corner, so pointer acceleration throws it off:

   ```bash
   gsettings set org.gnome.desktop.peripherals.mouse accel-profile 'flat'
   ```

5. **GNOME helper extension** (for `list_windows`, `focus_window`, `move_window`, `close_window`). It ships inside the `.mcpb` and in [`gnome-extension/`](gnome-extension/):

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   cp -r gnome-extension/claude-linux-mcp@lukelamb.github.io ~/.local/share/gnome-shell/extensions/
   # log out and back in (GNOME on Wayland only loads new extensions at login)
   gnome-extensions enable claude-linux-mcp@lukelamb.github.io
   ```

   It only exposes a small D-Bus interface (`io.github.lukelamb.ClaudeLinuxMcp` on the session bus) and does nothing on its own.

**Keyboard layouts.** ydotool sends physical keys and types with a US keymap. `key_press` remaps letters for AZERTY (`fr`, `be`) and QWERTZ (`de`, `ch`, …) layouts, read from GNOME's input-source settings (override with `CLAUDE_LINUX_MCP_KB_LAYOUT=be`). On non-US layouts `type_text` defaults to pasting through the clipboard (it presses `ctrl+v`, then restores your previous clipboard); pass `method: "type"` to force keystrokes. In terminals, paste with `key_press("ctrl+shift+v")` after `clipboard_set` instead.

**HiDPI.** With display scaling, screenshot pixels and pointer coordinates can differ by the scale factor.

---

## Install

1. Download `LinuxDesktop.mcpb` from the [latest release](https://github.com/LukeLamb/claude-linux-mcp/releases/latest).
2. Claude Desktop → **Settings** → **Extensions** → **Extension Developer** section → **Install Extension** → select the `.mcpb` file.
3. Review the red "developer info not verified by Anthropic" warning. If you trust the source, click **Install**.
4. Back on **All extensions**, make sure **Linux Desktop** is toggled on.
5. In a chat, open the connector/tools picker and enable **Linux Desktop** for that conversation.

On first tool call, the server detects missing utilities and returns a clear "install with: `sudo apt install …`" error — you don't have to read the full README to discover what's missing.

---

## Usage examples

Try asking Claude:

- *"Take a screenshot and tell me what's on my screen."*
- *"List my open windows."*
- *"Focus the Firefox window."*
- *"Open gnome-terminal and then type `nvtop` into it."*
- *"Copy 'hello world' to my clipboard."*
- *"Drag the Claude Desktop window to the top-left corner of the screen, resize it to 800×600."*
- *"Scroll down three times in the active window."*

---

## Known limitations

- **Wayland needs one-time setup** (see [Wayland setup](#wayland-setup)), and window management there needs GNOME plus the helper extension. On other Wayland compositors only XWayland windows can be listed or moved.
- **No AT-SPI UI inspection.** v0.1 works with coordinates + window titles. Semantic ("click the Send button") targeting requires AT-SPI inspection, which is messy on Electron/Chromium apps and deserves its own focused v0.2.
- **Yellow "Tool result could not be submitted" banner.** Cosmetic; fires on dynamic-tool-loading steps. Affects the stock Filesystem extension too. Not this extension's bug.

---

## Privacy policy

**No data leaves your machine.** This extension runs entirely locally:

- **Data collection:** None. The extension does not phone home, emit telemetry, or make any network requests of its own.
- **Data usage & storage:** Screenshots are saved to `/tmp/claude-linux-mcp/shots/` so Claude can reference them later in the same conversation. Nothing else is persisted by the extension itself.
- **Clipboard:** `clipboard_get()` reads whatever is currently on your clipboard and passes it back to Claude Desktop in the tool result. Treat this the same way you'd treat pasting into a chat — don't ask for it if sensitive data is on your clipboard.
- **Third-party sharing:** None. Nothing is transmitted to Anthropic, the extension author, or any third party by this extension. (Claude Desktop itself separately sends tool inputs/outputs to Anthropic as part of the normal chat flow — that's Anthropic's relationship with you, not this extension's.)
- **Retention:** `/tmp/claude-linux-mcp/` is cleared at every reboot. To clear manually: `rm -rf /tmp/claude-linux-mcp`.
- **Permissions scope:** All tools run with your own user's permissions — the same as anything you'd type into a terminal or do with a mouse.
- **Contact / questions:** Open an issue at <https://github.com/LukeLamb/claude-linux-mcp/issues>.

## License

[MIT](LICENSE). Use freely, attribution appreciated, no warranty.
