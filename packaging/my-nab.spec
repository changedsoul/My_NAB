# PyInstaller recipe for the desktop programs (run from the project folder: pyinstaller packaging/my-nab.spec)
#   Windows:  "My NAB Server.exe" + "Open My NAB.exe"          (single files, no black window, tray icon)
#   Mac:      "My NAB Server.app" + "Open My NAB.app"          (menu-bar icon, no Dock icon)
#   Linux:    "my-nab-server" + "open-my-nab"                  (terminal programs)
import os
import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, ".."))
ICON = os.path.join(ROOT, "static", "icon-512.png")
WIN, MAC = sys.platform == "win32", sys.platform == "darwin"
LINUX = not WIN and not MAC

SERVER_NAME = "my-nab-server" if LINUX else "My NAB Server"
OPENER_NAME = "open-my-nab" if LINUX else "Open My NAB"

# --- the server ---
server_hidden = ["api", "waitress"] + (["pystray._win32"] if WIN else ["pystray._darwin"] if MAC else [])
server = Analysis(
    [os.path.join(ROOT, "desktop", "launcher.py")],
    pathex=[ROOT, os.path.join(ROOT, "desktop")],
    # Flask blueprints are imported inside a function, so name the packages explicitly.
    hiddenimports=server_hidden,
    datas=[
        (os.path.join(ROOT, "static"), "static"),   # the web pages
        (os.path.join(ROOT, "demo"), "demo"),        # the ready-made demo budget
    ],
    excludes=["tkinter"] + (["pystray", "PIL"] if LINUX else []),
)
server_pyz = PYZ(server.pure)

# --- the opener ---
opener = Analysis(
    [os.path.join(ROOT, "desktop", "open_nab.py")],
    pathex=[ROOT, os.path.join(ROOT, "desktop")],
    excludes=["tkinter", "flask", "PIL", "pystray"],
)
opener_pyz = PYZ(opener.pure)

if MAC:
    # Mac apps are folders ("one-dir") wrapped in a .app bundle; LSUIElement keeps them out of the Dock.
    def mac_app(analysis, pyz, name, identifier):
        exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name=name, console=False, icon=ICON)
        coll = COLLECT(exe, analysis.binaries, analysis.datas, name=name)
        return BUNDLE(coll, name=name + ".app", icon=ICON, bundle_identifier=identifier,
                      info_plist={"LSUIElement": True, "CFBundleName": name, "CFBundleDisplayName": name})
    mac_app(server, server_pyz, SERVER_NAME, "org.mynab.server")
    mac_app(opener, opener_pyz, OPENER_NAME, "org.mynab.opener")
else:
    # Windows: no black window, a tray icon shows it is running. Linux: a normal terminal program.
    EXE(server_pyz, server.scripts, server.binaries, server.datas, [],
        name=SERVER_NAME, console=LINUX, icon=ICON)
    EXE(opener_pyz, opener.scripts, opener.binaries, opener.datas, [],
        name=OPENER_NAME, console=False, icon=ICON)
