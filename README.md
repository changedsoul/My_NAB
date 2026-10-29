# My NAB

A self-hosted **zero-based envelope budgeting** app. Runs on your own computer or a home server/NAS, works on
your phone, one password, no subscription, no cloud.

![The budget screen](docs/screenshots/budget.png)

| Scheduled | Register | Phone |
| --- | --- | --- |
| ![Scheduled](docs/screenshots/scheduled.png) | ![Register](docs/screenshots/register.png) | <img src="docs/screenshots/mobile.png" width="150" alt="Phone"> |

A made-up **Demo Budget** (password `demo1234`) is included so you can look around first.

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
