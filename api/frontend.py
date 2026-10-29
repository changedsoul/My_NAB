"""Serves the static single-page frontend (index.html + assets)."""

import os

from flask import Blueprint, send_from_directory

STATIC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

frontend_bp = Blueprint("frontend", __name__)


@frontend_bp.route("/")
def index():
    resp = send_from_directory(STATIC_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@frontend_bp.route("/<path:path>")
def static_files(path):
    full = os.path.join(STATIC_DIR, path)
    if os.path.isfile(full):
        resp = send_from_directory(STATIC_DIR, path)
        # "no-cache" = check with the server every time (a cheap 304 when nothing changed). Without it a browser
        # may keep running an old copy of the app's scripts for hours after an update. This matters most for
        # sw.js: browsers must always re-check the worker script itself.
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    return send_from_directory(STATIC_DIR, "index.html")
