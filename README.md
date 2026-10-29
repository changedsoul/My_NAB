# My NAB

A self-hosted **zero-based envelope budgeting** app. Runs on your own computer or a home server/NAS, works on
your phone, one password, no subscription, no cloud.

![The budget screen](docs/screenshots/budget.png)

| Scheduled | Register | Phone |
| --- | --- | --- |
| ![Scheduled](docs/screenshots/scheduled.png) | ![Register](docs/screenshots/register.png) | <img src="docs/screenshots/mobile.png" width="150" alt="Phone"> |

A made-up **Demo Budget** (password `demo1234`) is included so you can look around first.

## Start here (new to GitHub?)

You don't need to install anything or type any commands.

1. Open the **[Releases page](https://github.com/changedsoul/My_NAB/releases)** and scroll to **Assets** under the newest release.
2. Click the file for your computer to download it:
   - **Windows:** `My-NAB-windows.zip`
   - **Mac:** click the Apple menu, then **About This Mac**. If it says *Chip: Apple M1* (or M2, M3, M4), get `My-NAB-mac-apple-silicon.zip`. If it says *Processor: Intel*, get `My-NAB-mac-intel.zip`.
   - **Linux:** `My-NAB-linux.tar.gz`
3. **Unzip it first.** Right-click the zip and choose **Extract All** (Windows) or double-click it (Mac). Don't run the programs from inside the zip.
4. Double-click **My NAB Server**. Nothing pops up. A small icon appears near the clock (Windows: click the little `^` if you don't see it) or in the menu bar (Mac). That means it's running.
5. Double-click **Open My NAB**. Your web browser opens on the app.
6. Click **Open** next to **Demo Budget** and type the password `demo1234`. It's made-up data, so click and change anything you like. When you're ready, click **+ New Budget**.

Your computer may warn you the first time ("Windows protected your PC", or a Mac saying it can't be opened). That happens for any program not from a big publisher. The steps to get past it are just below.

To stop it, right-click the icon and choose **Quit**. Closing the browser doesn't stop it. Your budgets are saved in a `data` folder next to the programs, so copy that folder to back them up.

## Run it on your computer

**Windows / Mac / Linux: download the program**

1. Get your zip from the [Releases page](https://github.com/changedsoul/My_NAB/releases) (under **Assets**) and unzip it.
2. Open **My NAB Server** (starts it in the background), then **Open My NAB** (opens your browser).
3. Done. To stop it, right-click its tray/menu-bar icon → **Quit**.

First launch on Windows says "protected your PC": click **More info → Run anyway**. On Mac, allow it in
**System Settings → Privacy & Security → Open Anyway**. On Linux: `tar -xzf My-NAB-linux.tar.gz`, then `./my-nab-server` (stop it with Ctrl+C, or `./my-nab-server --stop` from another terminal).

**Or run it from the source** (needs Python 3.10+):

```bash
git clone https://github.com/changedsoul/My_NAB.git
cd My_NAB
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py          # Windows: use .venv\Scripts\ instead of .venv/bin/ (and py instead of python3)
```

Open <http://localhost:8000>.

## Run it on a server or NAS (always on)

You need Docker. Then:

```bash
git clone https://github.com/changedsoul/My_NAB.git
cd My_NAB
docker compose up -d --build
```

Put an HTTPS reverse proxy (e.g. your NAS's built-in one) in front of `http://localhost:8080`.
Your budgets are saved in the `data` folder.

## More

Synology steps, HTTPS, phone install, importing bank files, backups and settings are in the
**[full guide](docs/GUIDE.md)**.

## License

Copyright (C) 2026 changedsoul. My NAB is free software under the
**[GNU Affero General Public License v3.0](LICENSE)**: you can use, study, share and change it. If you share a
modified version, or run one as a service for other people, you must make your changes available under the same license.
It comes with no warranty.
