"""Security settings for the open budget: encrypt it on disk, change its password, make a recovery key, add passkeys.

Every change asks for the budget password again. Encryption itself lives in secure.py.
"""
import os
import re

from flask import Blueprint, abort, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash

import db
import secure
from api.auth import require_auth

security_bp = Blueprint("security", __name__)

_CRED_RE = re.compile(r"^[A-Za-z0-9_-]{8,1400}$")


def _need_password(pw):
    conn = db.get_db()
    try:
        h = db.get_setting(conn, "password_hash")
    finally:
        conn.close()
    if not h or not check_password_hash(h, pw or ""):
        abort(401, "Wrong password")


def _need_long_password(pw):
    if len(pw or "") < secure.MIN_PASSWORD:
        abort(400, f"An encrypted budget needs a password of at least {secure.MIN_PASSWORD} characters "
                   "(a long random one from a password manager is best).")


def _encrypted_ctx():
    """(path, data key) of the open budget, which must be encrypted."""
    path = db.current_budget_path()
    if not secure.is_encrypted_file(path):
        abort(409, "This budget isn't encrypted")
    return path, secure.key_for(path, session.get("sid"))


@security_bp.route("/api/security")
@require_auth
def api_security():
    path = db.current_budget_path()
    enc = secure.is_encrypted_file(path)
    return jsonify({
        "available": secure.AVAILABLE, "encrypted": enc, "lock_minutes": secure.LOCK_SECONDS // 60,
        "has_recovery": bool(enc and secure.has_recovery(path)),
        "passkeys": secure.passkeys(path) if enc else []})


@security_bp.route("/api/security/encrypt", methods=["POST"])
@require_auth
def api_security_encrypt():
    p = request.json or {}
    if not secure.AVAILABLE:
        abort(503, "This server can't encrypt budgets (the sqlcipher3 package isn't installed). "
                   "Encryption is part of the Docker / NAS version.")
    _need_password(p.get("password"))
    path = db.current_budget_path()
    if secure.is_encrypted_file(path):
        abort(409, "This budget is already encrypted")
    # The password that will lock the budget: a new one if given, else the current one. It must be long enough.
    new_pw = p.get("new_password") or ""
    final_pw = new_pw or p["password"]
    _need_long_password(final_pw)
    old = db.list_upgrade_backups(path) if p.get("delete_old_backups", True) else []
    try:
        key, recovery = secure.encrypt_file(path, final_pw)
    except (RuntimeError, ValueError) as e:
        abort(409, str(e))
    session["sid"] = secure.new_session(path, key)
    if new_pw:                          # keep the in-budget copy of the password check in step with the new one
        conn = db.get_db()
        try:
            db.set_setting(conn, "password_hash", generate_password_hash(new_pw))
            conn.commit()
        finally:
            conn.close()
    for b in old:                       # the automatic pre-upgrade copies are plain files of the same data
        secure.shred_and_remove(os.path.join(db.BACKUPS_DIR, b["name"]))
    return jsonify({"ok": True, "recovery_key": recovery, "removed_backups": len(old)})


@security_bp.route("/api/security/decrypt", methods=["POST"])
@require_auth
def api_security_decrypt():
    _need_password((request.json or {}).get("password"))
    path, key = _encrypted_ctx()
    try:
        secure.decrypt_file(path, key)
    except (RuntimeError, ValueError) as e:
        abort(409, str(e))
    session.pop("sid", None)
    return jsonify({"ok": True})


@security_bp.route("/api/security/password", methods=["POST"])
@require_auth
def api_security_password():
    p = request.json or {}
    _need_password(p.get("password"))
    new_pw = p.get("new_password", "")
    if len(new_pw) < 4:
        abort(400, "Password too short")
    path = db.current_budget_path()
    if secure.is_encrypted_file(path):
        _need_long_password(new_pw)
        _, key = _encrypted_ctx()
        secure.set_password(path, key, new_pw)
    conn = db.get_db()
    try:
        db.set_setting(conn, "password_hash", generate_password_hash(new_pw))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@security_bp.route("/api/security/recovery-key", methods=["POST"])
@require_auth
def api_security_recovery_key():
    _need_password((request.json or {}).get("password"))
    path, key = _encrypted_ctx()
    return jsonify({"recovery_key": secure.new_recovery_key(path, key)})


@security_bp.route("/api/security/passkey-options")
@require_auth
def api_security_passkey_options():
    path, _ = _encrypted_ctx()
    return jsonify({"ids": [k["id"] for k in secure.passkeys(path)], "salt": secure.prf_salt(path)})


@security_bp.route("/api/security/passkeys", methods=["POST"])
@require_auth
def api_security_passkey_add():
    p = request.json or {}
    _need_password(p.get("password"))
    path, key = _encrypted_ctx()
    cred = str(p.get("id", ""))
    if not _CRED_RE.match(cred):
        abort(400, "Bad passkey id")
    try:
        secure.add_passkey(path, key, cred, str(p.get("prf", "")), str(p.get("label", "")))
    except ValueError as e:
        abort(400, str(e))
    return jsonify({"ok": True})


@security_bp.route("/api/security/passkeys/<cred>", methods=["DELETE"])
@require_auth
def api_security_passkey_remove(cred):
    _need_password((request.json or {}).get("password"))
    path, _ = _encrypted_ctx()
    secure.remove_passkey(path, cred)
    return jsonify({"ok": True})
