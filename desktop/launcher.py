"""My NAB Server: starts My NAB in the background (this is what "My NAB Server.exe" runs on Windows).

    My NAB Server.exe --stop     stops a server that is already running.
    My NAB Server.exe            starts the server. Your budgets are kept in the "data" folder next to the program;
                                 the first time, it comes with a ready-made demo budget (made-up data).

It does exactly one thing: it runs the server. A small icon near the clock shows that it is running; right-click
it to open My NAB or Quit. Closing your browser does NOT stop it. It keeps running until you
choose Quit (or log off / shut down). To open My NAB in your browser, use "Open My NAB.exe".

Everything stays on this computer: it only listens on 127.0.0.1, so nothing else on the network can reach it.

It also works unpacked, for testing:  python desktop/launcher.py --home /some/folder --no-tray
"""
import argparse
import os
import shutil
import signal
import sys
import threading
import webbrowser

import nab_common as nc

FROZEN = nc.FROZEN
RESOURCES = nc.RESOURCES
HOME = nc.data_home()

DEMO_PASSWORD = "demo1234"


def send_output_to_log():
    """Without a console (the Windows and Mac programs), stdout/stderr don't exist; keep them in a log file."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    for folder in (HOME, os.environ.get("TEMP") or os.path.expanduser("~")):
        try:
            os.makedirs(folder, exist_ok=True)
            sys.stdout = sys.stderr = open(os.path.join(folder, "My NAB.log"), "a", buffering=1, encoding="utf-8")
            return
        except OSError:
            continue
    sys.stdout = sys.stderr = open(os.devnull, "w")


def make_server(app, port):
    """(run, stop): waitress if it's installed, otherwise Werkzeug's own server (plain Python test runs)."""
    try:
        from waitress.server import create_server
        server = create_server(app, host="127.0.0.1", port=port, threads=8, ident="My NAB")
        return server.run, server.close
    except ImportError:
        from werkzeug.serving import make_server as werkzeug_server
        server = werkzeug_server("127.0.0.1", port, app, threaded=True)
        return server.serve_forever, server.shutdown


def main():
    ap = argparse.ArgumentParser(description="My NAB Server")
    ap.add_argument("--port", type=int, default=8000, help="first port to try (default 8000)")
    ap.add_argument("--home", default=HOME, help="folder that holds the data (default: next to the program)")
    ap.add_argument("--no-tray", action="store_true", help="no icon near the clock (runs until stopped)")
    ap.add_argument("--stop", action="store_true", help="stop a My NAB Server that is already running, then exit")
    args = ap.parse_args()

    if args.stop:
        stopped = nc.stop_server(args.home)
        if stopped:
            print("My NAB Server is stopping.")
        elif stopped is None:
            print("My NAB Server is running but can't be stopped from here; press Ctrl+C in the window it runs in.")
        else:
            print("My NAB Server isn't running.")
        return

    # One server is enough: if it's already running, there is nothing to start.
    port = None
    for candidate in range(args.port, args.port + 50):
        found = nc.probe(candidate)
        if found is None:
            port = candidate
            break
        if isinstance(found, dict):
            nc.message("My NAB Server", "My NAB Server is already running.\n\n"
                         "Use \"Open My NAB\" to open it in your browser, or look for its icon near the clock.")
            return
    if port is None:
        raise SystemExit("Couldn't find a free port to run on. Close other programs and try again.")

    folder = os.path.join(args.home, "data")
    if not os.path.exists(os.path.join(folder, "registry.db")):   # first run: start with the demo budget in the list
        try:
            shutil.copytree(os.path.join(RESOURCES, "demo"), folder, dirs_exist_ok=True)
        except OSError as e:
            raise SystemExit(f"Couldn't create the data folder:\n{folder}\n\n{e}\n\n"
                             "If you opened the program from inside a zip file, extract it first "
                             "(right-click the zip, then Extract All).")

    # Must be set before the app is imported.
    os.environ["NAB_DB_PATH"] = os.path.join(folder, "nab.db")
    os.environ["NAB_DEMO_PASSWORD"] = DEMO_PASSWORD     # shown next to the demo budget on the login screen
    sys.path.insert(0, RESOURCES)
    from app import app

    for candidate in range(port, port + 50):     # (the port was free a moment ago; if not, try the next)
        try:
            run_server, stop_server = make_server(app, candidate)
            port = candidate
            break
        except OSError:
            continue
    else:
        raise SystemExit("Couldn't find a free port to run on. Close other programs and try again.")
    url = f"http://localhost:{port}/"
    print(f"My NAB Server is running at {url}  (data in {folder})", flush=True)
    threading.Thread(target=run_server, daemon=True).start()
    nc.write_server_note(args.home, port)
    quit_now = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: quit_now.set())    # "my-nab-server --stop" and a normal kill

    try:
        tray = None if args.no_tray else start_tray(url, quit_now, folder)
        if tray:
            threading.Thread(target=lambda: (quit_now.wait(), tray.stop()), daemon=True).start()
            try:
                tray.run(setup=lambda icon: (setattr(icon, "visible", True), notify_started(icon)))
            except Exception as e:     # no usable tray after all: carry on without it
                print(f"Tray icon failed ({e}); running without it.")
                quit_now.wait()
        else:
            print("Open it in your browser at the address above. Press Ctrl+C (or close this window) to stop the server.", flush=True)
            quit_now.wait()
    except KeyboardInterrupt:
        pass
    try:
        stop_server()
    finally:
        nc.remove_server_note(args.home)
        os._exit(0)     # the server threads are daemons; leave right away


def start_tray(url, quit_now, folder):
    """The small icon near the clock. Returns None if there's no tray here (e.g. a plain test run)."""
    try:
        import pystray
        from PIL import Image
        image = Image.open(os.path.join(RESOURCES, "static", "icon-192.png"))
        menu = pystray.Menu(
            pystray.MenuItem("Open My NAB in the browser", lambda icon, item: webbrowser.open(url), default=True),
            pystray.MenuItem("Open the data folder", lambda icon, item: nc.open_folder(folder)),
            pystray.MenuItem("Quit My NAB Server", lambda icon, item: quit_now.set()))
        return pystray.Icon("My NAB", image, "My NAB Server (running)", menu)
    except Exception as e:
        print(f"No tray icon ({e}); running without one.")
        return None


def notify_started(icon):
    try:
        icon.notify("The server is running in the background. Use \"Open My NAB\" to open it in your browser. "
                    "Closing the browser does not stop it; right-click this icon and choose Quit when you're done.",
                    "My NAB Server")
    except Exception:
        pass


if __name__ == "__main__":
    if FROZEN:
        send_output_to_log()
    try:
        main()
    except KeyboardInterrupt:
        pass
    except SystemExit as e:
        if e.code not in (None, 0):
            nc.message("My NAB Server", e.code if isinstance(e.code, str) else f"Exited with code {e.code}")
        raise
    except Exception:
        import traceback
        text = traceback.format_exc()
        print(text)
        nc.message("My NAB Server couldn't start",
                     "Something went wrong starting My NAB Server. A details file called 'My NAB.log' is next to "
                     "the program; please include it if you ask for help.\n\n" + text[-600:])
        sys.exit(1)
