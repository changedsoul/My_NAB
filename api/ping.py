"""A tiny "who are you?" endpoint, used by the Windows programs.

GET /api/ping   says which app this is (so "Open My NAB" can find a running server and a second start can
                reuse it) and passes on the demo password to show on the login screen. It returns no budget
                data and needs no login. On a server it is inert.
"""
import os

from flask import Blueprint, jsonify

ping_bp = Blueprint("ping", __name__)


@ping_bp.route("/api/ping")
def api_ping_get():
    return jsonify({
        "app": "my-nab",
        "demo_password": os.environ.get("NAB_DEMO_PASSWORD") or None,
    })
