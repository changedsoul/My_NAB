"""Create/rename/delete/open/close budgets — the picker screen's API.
Distinct from api/budget.py, which handles monthly budgeted amounts *within*
whichever budget is currently open.

None of these routes require an open session (require_auth): you're not
logged into anything yet while picking or opening a budget. Each budget's
own contents stay protected by its own password, checked here directly
against that budget's `settings` table via db.get_db_for(bid)."""

from flask import Blueprint, jsonify, request, session, abort
import time

from werkzeug.security import generate_password_hash, check_password_hash

import db
import secure

budgets_bp = Blueprint("budgets", __name__)


@budgets_bp.route("/api/budgets")
def api_budgets_list():
    return jsonify(db.list_budgets())


# Wrong-password throttle (per budget, in memory): after 5 misses in a row each further
# attempt must wait twice as long as the last (up to 5 minutes). A correct password resets it.
# Per budget rather than per address, because behind a reverse proxy every visitor looks alike.
_FAILS = {}


def _throttle_check(bid):
    n, last = _FAILS.get(bid, (0, 0.0))
    if n >= 5:
        wait = min(2 ** (n - 4), 300) - (time.time() - last)
        if wait > 0:
            abort(429, f"Too many wrong passwords. Try again in {int(wait) + 1} seconds.")


def _miss(bid):
    n, _ = _FAILS.get(bid, (0, 0.0))
    _FAILS[bid] = (n + 1, time.time())


def _unlock(bid, attempt):
    """Run attempt() (which returns a budget's data key, or None if the secret was wrong), with the wrong-guess
    throttle around it. Returns the key."""
    _throttle_check(bid)
    key = attempt()
    if key is None:
        _miss(bid)
        return None
    _FAILS.pop(bid, None)
    return key


def _check_password(bid, pw):
    """True if pw opens budget bid. Records misses, and refuses while throttled."""
    path = db.budget_path(bid)
    if secure.is_encrypted_file(path):
        return _unlock(bid, lambda: secure.unlock_with_password(path, pw)) is not None
    _throttle_check(bid)
    conn = db.get_db_for(bid)
    try:
        h = db.get_setting(conn, "password_hash")
    finally:
        conn.close()
    if h and check_password_hash(h, pw):
        _FAILS.pop(bid, None)
        return True
    _miss(bid)
    return False


def _start_session(bid, path, key=None):
    """Make this browser the one signed in to budget bid (an encrypted one keeps its key in memory for it)."""
    _end_session()
    session.clear()
    session["open_budget_id"] = bid
    if key is not None:
        session["sid"] = secure.new_session(path, key)
    session.permanent = True


def _end_session():
    """Sign this browser out of whatever budget it has open (an encrypted one forgets its key if it was the last)."""
    bid, sid = session.get("open_budget_id"), session.get("sid")
    if bid and sid:
        try:
            secure.drop_session(db.budget_path(bid), sid)
        except ValueError:
            pass


MAX_PENDING_BUDGETS = 3   # budgets created but never given a password


@budgets_bp.route("/api/budgets", methods=["POST"])
def api_budgets_create():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        abort(400, "Name is required")
    # Creating a budget needs no login (the picker runs before one is open), so don't let
    # anyone fill the disk with empty ones: finish setting up the ones you have first.
    if sum(1 for b in db.list_budgets() if b["needs_setup"]) >= MAX_PENDING_BUDGETS:
        abort(429, "Finish setting up your new budget first (set its password), or delete it.")
    bid = db.create_budget(name)
    return jsonify({"ok": True, "id": bid})


@budgets_bp.route("/api/budgets/<int:bid>", methods=["PUT"])
def api_budgets_rename(bid):
    # These routes are pre-auth (the picker runs before any budget is open),
    # so a rename of a password-protected budget requires that budget's own
    # password — otherwise anyone able to reach the server could rename it.
    # A not-yet-set-up budget has no password to check, same as delete.
    name = (request.json or {}).get("name", "").strip()
    if not name:
        abort(400, "Name is required")
    target = next((b for b in db.list_budgets() if b["id"] == bid), None)
    if not target:
        abort(404)
    if not target["needs_setup"]:
        if not _check_password(bid, (request.json or {}).get("password", "")):
            abort(401, "Wrong password")
    try:
        db.rename_budget(bid, name)
    except ValueError as e:
        abort(404, str(e))
    return jsonify({"ok": True})


@budgets_bp.route("/api/budgets/<int:bid>/setup", methods=["POST"])
def api_budgets_setup(bid):
    """First-time password set for a budget that doesn't have one yet."""
    pw = (request.json or {}).get("password", "")
    if len(pw) < 4:
        abort(400, "Password too short")
    if secure.is_encrypted_file(db.budget_path(bid)):
        abort(409, "This budget already has a password")
    conn = db.get_db_for(bid)
    try:
        if db.get_setting(conn, "password_hash") is not None:
            abort(409, "This budget already has a password")
        db.set_setting(conn, "password_hash", generate_password_hash(pw))
        conn.commit()
    finally:
        conn.close()
    _start_session(bid, db.budget_path(bid))
    return jsonify({"ok": True})


def _finish_open(bid, path, key):
    """Common tail of every way of signing in."""
    _start_session(bid, path, key)
    # A budget file can sit untouched for a long time between opens, so a
    # schema change released since it was last opened (a new column/table)
    # won't be there yet. Bring it up to date now rather than let the first
    # request that touches the new column throw "no such column".
    db.upgrade_budget(path)   # backs up first if it needs upgrading
    db.init_schema(path)
    db.roll_demo_forward(path)   # demo budgets only: keep their dates current
    return jsonify({"ok": True})


def _need_encrypted(bid):
    path = db.budget_path(bid)
    if not secure.is_encrypted_file(path):
        abort(404, "This budget isn't encrypted")
    if not secure.AVAILABLE:
        abort(503, "This server can't open encrypted budgets (the sqlcipher3 package isn't installed).")
    return path


@budgets_bp.route("/api/budgets/<int:bid>/passkey-options")
def api_budgets_passkey_options(bid):
    """What the browser needs to ask for a passkey: which ones are registered, and the fixed salt it feeds them."""
    path = _need_encrypted(bid)
    keys = secure.passkeys(path)
    if not keys:
        abort(404, "No passkeys are set up for this budget")
    return jsonify({"ids": [k["id"] for k in keys], "salt": secure.prf_salt(path)})


@budgets_bp.route("/api/budgets/<int:bid>/open-passkey", methods=["POST"])
def api_budgets_open_passkey(bid):
    path = _need_encrypted(bid)
    p = request.json or {}
    key = _unlock(bid, lambda: secure.unlock_with_passkey(path, str(p.get("id", "")), str(p.get("prf", ""))))
    if key is None:
        abort(401, "That passkey didn't unlock this budget")
    return _finish_open(bid, path, key)


@budgets_bp.route("/api/budgets/<int:bid>/recover", methods=["POST"])
def api_budgets_recover(bid):
    """Forgot the password: the recovery key opens the budget and sets a new password."""
    path = _need_encrypted(bid)
    p = request.json or {}
    new_pw = p.get("password", "")
    if len(new_pw) < secure.MIN_PASSWORD:
        abort(400, f"An encrypted budget needs a password of at least {secure.MIN_PASSWORD} characters.")
    key = _unlock(bid, lambda: secure.unlock_with_recovery(path, p.get("recovery_key", "")))
    if key is None:
        abort(401, "That recovery key isn't right")
    secure.set_password(path, key, new_pw)
    conn = secure.connect(path, key)
    try:
        db.set_setting(conn, "password_hash", generate_password_hash(new_pw))
        conn.commit()
    finally:
        conn.close()
    return _finish_open(bid, path, key)


@budgets_bp.route("/api/budgets/<int:bid>/open", methods=["POST"])
def api_budgets_open(bid):
    pw = (request.json or {}).get("password", "")
    path = db.budget_path(bid)
    if secure.is_encrypted_file(path):
        _need_encrypted(bid)
        key = _unlock(bid, lambda: secure.unlock_with_password(path, pw))
        if key is None:
            abort(401, "Wrong password")
        return _finish_open(bid, path, key)
    if not _check_password(bid, pw):
        abort(401, "Wrong password")
    # A budget file can sit untouched for a long time between opens, so a
    # schema change released since it was last opened (a new column/table)
    # won't be there yet. Bring it up to date now rather than let the first
    # request that touches the new column throw "no such column".
    db.upgrade_budget(db.budget_path(bid))   # backs up first if it needs upgrading
    db.init_schema(db.budget_path(bid))
    db.roll_demo_forward(db.budget_path(bid))   # demo budgets only: keep their dates current
    _start_session(bid, db.budget_path(bid))
    return jsonify({"ok": True})


@budgets_bp.route("/api/budgets/<int:bid>", methods=["DELETE"])
def api_budgets_delete(bid):
    # High blast radius (permanently deletes the whole file). A budget with
    # a password set requires it; a freshly-created, never-opened budget
    # (needs_setup) has nothing to prove ownership of, so no password needed.
    budgets = db.list_budgets()
    target = next((b for b in budgets if b["id"] == bid), None)
    if not target:
        abort(404)
    if not target["needs_setup"]:
        pw = (request.json or {}).get("password", "")
        if not _check_password(bid, pw):
            abort(401, "Wrong password")
    try:
        db.delete_budget(bid)
    except ValueError as e:
        abort(400, str(e))
    if session.get("open_budget_id") == bid:
        session.pop("open_budget_id", None)
    return jsonify({"ok": True})
