"""Authentication: each budget has its own password. A session holds at most
one open budget at a time (`open_budget_id`) — opening one is done via
api/budgets.py's /setup and /open routes; closing it here drops back to the
budget picker. There's no separate app-wide login on top of that."""

from functools import wraps

from flask import Blueprint, jsonify, session, abort

import db
import secure

auth_bp = Blueprint("auth", __name__)


def require_auth(fn):
    @wraps(fn)
    def wrapper(*a, **k):
        if not session.get("open_budget_id"):
            abort(401)
        return fn(*a, **k)
    return wrapper


@auth_bp.route("/api/session")
def api_session():
    bid = session.get("open_budget_id")
    if not bid:
        return jsonify({"open": False})
    match = next((b for b in db.list_budgets() if b["id"] == bid), None)
    if match and match["encrypted"] and not secure.has_session(db.budget_path(bid), session.get("sid")):
        # Locked (idle too long, or the server restarted): back to the picker. Not counted as activity.
        session.pop("open_budget_id", None)
        session.pop("sid", None)
        return jsonify({"open": False, "locked": True})
    if not match:
        # The open budget was deleted (e.g. from another session) — nothing
        # left to show, so drop back to the picker.
        session.pop("open_budget_id", None)
        return jsonify({"open": False})
    return jsonify({"open": True, "budget_id": bid, "budget_name": match["name"]})


@auth_bp.route("/api/close-budget", methods=["POST"])
def api_close_budget():
    bid, sid = session.pop("open_budget_id", None), session.pop("sid", None)
    if bid and sid:
        try:
            secure.drop_session(db.budget_path(bid), sid)    # the last one out takes the key with it
        except ValueError:
            pass
    return jsonify({"ok": True})
