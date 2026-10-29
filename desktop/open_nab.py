"""Open My NAB: opens your browser on the running My NAB Server ("Open My NAB" on Windows and Mac, `open-my-nab`
on Linux).

It does not run the budget itself. If the server isn't running it says so, and offers to start it.
Uses only the standard library, so the program stays small.
"""
import os
import subprocess
import sys
import time

import nab_common as nc


def start_server():
    """Start My NAB Server (it keeps running on its own) and wait for it to answer. Returns its port or None."""
    here = nc.program_dir()
    # The server program sits next to this one; unpacked (testing) we run the script instead.
    if nc.IS_WIN:
        cmd = [os.path.join(here, "My NAB Server.exe")]
    elif nc.IS_MAC:
        cmd = ["open", os.path.join(here, "My NAB Server.app")]
    else:
        cmd = [os.path.join(here, "my-nab-server")]
    if not nc.FROZEN or not os.path.exists(cmd[-1]):
        cmd = [sys.executable, os.path.join(nc.SOURCE_ROOT, "desktop", "launcher.py"), "--no-tray"]
    # A program made with PyInstaller passes hints about its own unpacked files to anything it starts, which
    # can make the new program fail once this one exits; tell the new one to start from scratch.
    env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT="1")
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(cmd, cwd=here, env=env, creationflags=flags, start_new_session=not nc.IS_WIN,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):                            # wait up to ~15 s for it to come up
        time.sleep(0.15)
        port = nc.find_server(nc.data_home())
        if port:
            return port
    return None


def main():
    port = nc.find_server(nc.data_home())
    if port is None:
        if not nc.ask_yes_no("Open My NAB",
                             "My NAB Server isn't running yet.\n\nStart it now? It will keep running in the "
                             "background until you stop it."
                             + ("\n\nTo stop it later, run:  my-nab-server --stop" if nc.IS_LINUX else
                                "\n\nTo stop it, right-click its icon and choose Quit.")):
            return
        port = start_server()
        if port is None:
            nc.message("Open My NAB", "The server didn't start. Try starting \"My NAB Server\" yourself.")
            return
    nc.open_in_browser(port)


if __name__ == "__main__":
    main()
