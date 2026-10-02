// D-Bus bridge used by the Claude Linux Desktop MCP server on Wayland.
// Object path /io/github/lukelamb/ClaudeLinuxMcp on org.gnome.Shell.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const VERSION = '1.0';

const IFACE = `
<node>
  <interface name="io.github.lukelamb.ClaudeLinuxMcp">
    <method name="Version">
      <arg type="s" direction="out" name="version"/>
    </method>
    <method name="List">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="Activate">
      <arg type="t" direction="in" name="id"/>
    </method>
    <method name="MoveResize">
      <arg type="t" direction="in" name="id"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
    </method>
    <method name="Close">
      <arg type="t" direction="in" name="id"/>
    </method>
  </interface>
</node>`;

const LISTED_TYPES = new Set([
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
]);

function windows() {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(w => w && !w.is_skip_taskbar() && LISTED_TYPES.has(w.get_window_type()));
}

function findWindow(id) {
    const win = windows().find(w => String(w.get_id()) === String(id));
    if (!win)
        throw new Error(`no window with id ${id}`);
    return win;
}

function isMaximized(win) {
    if (typeof win.is_maximized === 'function')
        return win.is_maximized();
    return Boolean(win.maximized_horizontally || win.maximized_vertically);
}

function unmaximize(win) {
    // GNOME 49 dropped the MaximizeFlags argument.
    if (Meta.MaximizeFlags)
        win.unmaximize(Meta.MaximizeFlags.BOTH);
    else
        win.unmaximize();
}

class Bridge {
    Version() {
        return VERSION;
    }

    List() {
        return JSON.stringify(windows().map(w => {
            const rect = w.get_frame_rect();
            const ws = w.get_workspace();
            return {
                id: String(w.get_id()),
                title: w.get_title() ?? '',
                wm_class: w.get_wm_class() ?? '',
                pid: w.get_pid(),
                workspace: ws ? ws.index() : -1,
                focus: w.has_focus(),
                minimized: Boolean(w.minimized),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            };
        }));
    }

    Activate(id) {
        const win = findWindow(id);
        const time = global.get_current_time();
        const ws = win.get_workspace();
        if (ws)
            ws.activate_with_focus(win, time);
        else
            win.activate(time);
    }

    MoveResize(id, x, y, width, height) {
        const win = findWindow(id);
        if (isMaximized(win))
            unmaximize(win);
        win.move_resize_frame(true, x, y, width, height);
    }

    Close(id) {
        findWindow(id).delete(global.get_current_time());
    }
}

export default class ClaudeLinuxMcpHelper extends Extension {
    enable() {
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, new Bridge());
        this._dbus.export(Gio.DBus.session, '/io/github/lukelamb/ClaudeLinuxMcp');
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
    }
}
