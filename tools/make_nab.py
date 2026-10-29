#!/usr/bin/env python3
"""Build docker/My_NAB (and docker/My_NAB.tar.gz): a self-contained folder to copy onto the NAS.

Run after any change:   python3 tools/make_nab.py

Only the files the container needs are copied (an allow-list), and files that
no longer exist in the source are removed from My_NAB. It never contains your
data/ folder, so copying it over an existing install can't touch your budget.
"""
import os
import shutil
import tarfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the project folder
DOCKER = os.path.join(HERE, "docker")      # everything made here lands in docker/
OUT = os.path.join(DOCKER, "My_NAB")

DIRS = ["api", "static"]
FILES = ["app.py", "budget_engine.py", "db.py", "importers.py", "scheduled_engine.py", "secure.py",
         "requirements.txt", "requirements-secure.txt", "LICENSE", "Dockerfile", "docker-compose.yml", ".dockerignore", "deploy.sh"]

DEPLOY_NOTES = """My_NAB: copy this whole folder to the NAS (e.g. /volume1/docker/My_NAB).

First time AND every update (works with the older Synology "Docker" package):
  ssh -t <user>@<nas> 'cd /volume1/docker/My_NAB && sudo ./deploy.sh'

  deploy.sh builds the image and (re)starts the container. It never touches the
  data folder, so it's safe to run after every copy.

With Container Manager / Docker Compose instead:
  Project > Create > point at this folder > start; update with Action > Build.
  (Or:  sudo docker compose up -d --build)

Your budget lives in the "data" folder next to docker-compose.yml. It is created
on first start and is NOT part of My_NAB, so copying over it never touches it.
To bring an existing local budget along, copy your local data/ folder into the
NAS folder once (before first start). See README.md in the source project for
HTTPS / offline setup.
"""

FOLDER_README = """What is in this folder?

  My_NAB/         The Docker version of My NAB, ready to copy to a NAS or server.
  My_NAB.tar.gz   The very same My_NAB folder, zipped up into one file (easier to copy or upload).
                  Unzip it and you get the My_NAB folder above. Nothing else is inside.

You only need ONE of them: copy the My_NAB folder, or the tar.gz and unzip it on the NAS.
Then follow DEPLOY.txt inside My_NAB (or the NAS steps in the main README).

Neither one contains your budget data, so copying over an existing install never touches it.
These files are made by:  python3 tools/make_nab.py   (run it again after any change)
"""


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)      # (also creates docker/)
    for d in DIRS:
        shutil.copytree(os.path.join(HERE, d), os.path.join(OUT, d),
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
    for f in FILES:
        shutil.copy2(os.path.join(HERE, f), os.path.join(OUT, f))
    with open(os.path.join(OUT, "DEPLOY.txt"), "w") as fh:
        fh.write(DEPLOY_NOTES)
    with open(os.path.join(DOCKER, "README.txt"), "w") as fh:
        fh.write(FOLDER_README)
    tar_path = os.path.join(DOCKER, "My_NAB.tar.gz")
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(OUT, arcname="My_NAB")
    n = sum(len(fs) for _, _, fs in os.walk(OUT))
    print(f"My_NAB rebuilt: {n} files -> {OUT}\n                and {tar_path}")


if __name__ == "__main__":
    main()
