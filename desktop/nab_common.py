"""Pieces shared by the desktop programs ("My NAB Server" and "Open My NAB") on Windows, macOS and Linux.
Standard library only, so the small "Open My NAB" program stays small."""
import json
import os
import shutil
import socket
import signal
import subprocess
import sys
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor

FROZEN = getattr(sys, "frozen", False)
IS_WIN = os.name == "nt"
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

# Bundled resources (web files, demo) live inside the program; the user's files live outside it.
SOURCE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the project folder (when not packaged)
RESOURCES = getattr(sys, "_MEIPASS", SOURCE_ROOT)
FIRST_PORT, PORTS = 8000, 50


def program_dir():
    """The folder the programs sit in (on a Mac, the folder that holds the .app, not the app's insides)."""
    if not FROZEN:
        return SOURCE_ROOT
    here = os.path.dirname(sys.executable)
    if IS_MAC and here.endswith(os.path.join(".app", "Contents", "MacOS")):
        here = os.path.dirname(os.path.dirname(os.path.dirname(here)))
    return here


def data_home():
    """Where the budgets ("data" folder) and the server note live. Next to the programs on Windows and
    Linux; in the user's Library on a Mac (an app's own folder shouldn't be written to)."""
    if FROZEN and IS_MAC:
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "My NAB")
    return program_dir()


# ---- messages -------------------------------------------------------------------------------------------
def _applescript(text):
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _has_display():
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def message(title, text):
    """Tell the user something in a normal window for their system (there may be no console to print to)."""
    try:
        if IS_WIN:
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)
            return
        if IS_MAC:
            subprocess.run(["osascript", "-e", f'display dialog "{_applescript(text)}" with title '
                            f'"{_applescript(title)}" buttons {{"OK"}} default button "OK"'], capture_output=True)
            return
        if shutil.which("zenity") and _has_display():
            subprocess.run(["zenity", "--info", "--title", title, "--text", text, "--no-markup"])
            return
    except Exception:
        pass
    print(f"{title}: {text}")


def ask_yes_no(title, text):
    try:
        if IS_WIN:
            import ctypes
            return ctypes.windll.user32.MessageBoxW(0, text, title, 0x24) == 6   # Yes/No + question mark; 6 = Yes
        if IS_MAC:
            r = subprocess.run(["osascript", "-e", f'display dialog "{_applescript(text)}" with title '
                                f'"{_applescript(title)}" buttons {{"No", "Yes"}} default button "Yes"'],
                               capture_output=True, text=True)
            return r.returncode == 0 and "Yes" in r.stdout
        if shutil.which("zenity") and _has_display():
            return subprocess.run(["zenity", "--question", "--title", title, "--text", text,
                                   "--no-markup"]).returncode == 0
    except Exception:
        pass
    if sys.stdin and sys.stdin.isatty():
        return input(f"{text} [y/N] ").strip().lower().startswith("y")
    return False


def open_folder(folder):
    try:
        if IS_WIN:
            os.startfile(folder)    # noqa: S606 (Windows only)
        elif IS_MAC:
            subprocess.Popen(["open", folder])
        else:
            subprocess.Popen(["xdg-open", folder])
    except Exception:
        pass


# ---- finding a running server ------------------------------------------------------------------------------
def probe(port):
    """What's on this port? Returns the ping info of a running My NAB, "other" if something else answers
    there, or None if nothing does. (One short connect first: on Windows a closed port can take a long time to
    refuse, so never wait on it more than a moment.)"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as r:
            info = json.load(r)
            return info if info.get("app") == "my-nab" else "other"
    except Exception:
        return "other"


def write_server_note(home, port):
    """Leave a note saying where the server is, so "Open My NAB" can find it at once."""
    try:
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(home, "server.json"), "w") as f:
            json.dump({"port": port, "pid": os.getpid()}, f)
    except OSError:
        pass


def stop_server(home):
    """Stop a running My NAB Server. Returns True if one was running and was told to stop."""
    try:
        with open(os.path.join(home, "server.json")) as f:
            note = json.load(f)
        port, pid = int(note["port"]), int(note["pid"])
    except Exception:
        port = find_server(home)         # no usable note: at least say whether one is running
        return False if port is None else None
    if not isinstance(probe(port), dict):    # nothing answers there any more: the note is left over
        remove_server_note(home)
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def remove_server_note(home):
    try:
        os.remove(os.path.join(home, "server.json"))
    except OSError:
        pass


def find_server(home):
    """Port of a running My NAB Server, or None.

    First the note the server leaves (instant). Failing that, look at every likely port AT THE SAME TIME: on
    Windows a closed port can take a long while to refuse a connection, so checking them one after another
    could take many seconds."""
    try:
        with open(os.path.join(home, "server.json")) as f:
            port = int(json.load(f)["port"])
        if isinstance(probe(port), dict):
            return port
    except Exception:
        pass
    ports = list(range(FIRST_PORT, FIRST_PORT + PORTS))
    with ThreadPoolExecutor(max_workers=len(ports)) as pool:
        results = list(pool.map(probe, ports))
    return next((port for port, info in zip(ports, results) if isinstance(info, dict)), None)


def open_in_browser(port):
    webbrowser.open(f"http://localhost:{port}/")
