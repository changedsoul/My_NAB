"""System-level operations that don't belong to one resource type."""

import io
import json
import os
import sqlite3
import tempfile
import zipfile
from datetime import date

from flask import Blueprint, jsonify, request, abort, send_file, session, after_this_request
from werkzeug.security import check_password_hash

import db
import secure
from api.auth import require_auth

system_bp = Blueprint("system", __name__)


@system_bp.route("/api/reset-budget", methods=["POST"])
@require_auth
def api_reset_budget():
    """Wipe every account, category, transaction, budget entry, and scheduled
    transaction so the user can start a new budget from scratch. The login
    password and app preferences are left untouched. This can't be undone, so
    it requires re-entering the password as confirmation."""
    pw = (request.json or {}).get("password", "")
    conn = db.get_db()
    try:
        h = db.get_setting(conn, "password_hash")
        if not h or not check_password_hash(h, pw):
            abort(401, "Wrong password")
        db.reset_all_data(conn)
        return jsonify({"ok": True})
    finally:
        conn.close()


@system_bp.route("/api/backup/export")
@require_auth
def api_backup_export():
    """Download the entire live database as a single file — a complete,
    byte-for-byte snapshot that's trivially re-importable later since it's
    exactly what the app itself reads. Uses sqlite's own backup API rather
    than a raw file copy so it's consistent even mid-write."""
    fd, tmp_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    path = db.current_budget_path()
    encrypted = secure.is_encrypted_file(path)
    src = db.connect_budget(path, session.get("sid") if encrypted else None)
    # An encrypted budget's backup stays encrypted (with the same key).
    dest = secure.connect(tmp_path, secure.key_any(path)) if encrypted else sqlite3.connect(tmp_path)
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    if encrypted:
        # The file alone can't be opened elsewhere: the key file (which only the password, recovery key or a
        # passkey can open) travels with it, in one zip.
        with open(tmp_path, "rb") as fh, open(secure.keys_path(path), "rb") as kh:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
                z.writestr("budget.db", fh.read())
                z.writestr("budget.db.keys", kh.read())
        os.remove(tmp_path)
        with open(tmp_path, "wb") as fh:
            fh.write(buf.getvalue())

    @after_this_request
    def _cleanup(response):
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return response

    return send_file(tmp_path, as_attachment=True,
                      download_name=f"my-nab-backup-{date.today().isoformat()}.{'nabbackup' if encrypted else 'db'}",
                      mimetype="application/octet-stream")


@system_bp.route("/api/backup/restore", methods=["POST"])
@require_auth
def api_backup_restore():
    """Replace the entire live database with a previously downloaded backup.
    This can't be undone, so it requires re-entering the CURRENT password as
    confirmation (the restored file's own password takes over from there)."""
    f = request.files.get("file")
    if not f:
        abort(400, "No file uploaded")
    pw = request.form.get("password", "")
    active_path = db.current_budget_path()
    conn = db.get_db()
    try:
        h = db.get_setting(conn, "password_hash")
        if not h or not check_password_hash(h, pw):
            abort(401, "Wrong password")
    finally:
        conn.close()

    # os.replace() only works atomically within a single filesystem — under
    # Docker, NAB_DB_PATH typically lives on a mounted volume (e.g. /data)
    # while the system temp dir (/tmp) is the container's own ephemeral
    # filesystem, so a plain tempfile.mkstemp() here fails at replace time
    # with "Invalid cross-device link". Creating the temp file in the same
    # directory as the real db sidesteps that entirely.
    data = f.read()
    live_encrypted = secure.is_encrypted_file(active_path)
    if data[:2] == b"PK":                       # an encrypted backup: the database plus its key file
        if not live_encrypted:
            abort(409, "That backup is from an encrypted budget. Encrypt this budget first (Settings, Security), "
                       "then restore it.")
        return _restore_encrypted(active_path, data)
    if live_encrypted:
        abort(409, "This budget is encrypted, so only an encrypted backup (.nabbackup) can be restored into it. "
                   "To restore a plain backup, remove this budget's encryption first.")
    fd, tmp_path = tempfile.mkstemp(suffix=".db", dir=os.path.dirname(active_path) or ".")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        check = sqlite3.connect(tmp_path)
        try:
            check.execute("SELECT 1 FROM accounts LIMIT 1")
        except sqlite3.Error:
            abort(400, "That doesn't look like a My NAB backup file")
        finally:
            check.close()
        os.replace(tmp_path, active_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    # The backup may predate a schema change (a new column/table added since
    # it was taken) — bring it up to date immediately so the app doesn't
    # start throwing "no such column" errors on the next request.
    db.upgrade_budget(active_path)   # an older backup gets copied aside, then upgraded
    db.init_schema(active_path)
    return jsonify({"ok": True})


def _restore_encrypted(active_path, data):
    """Put an encrypted backup (.nabbackup) in place of the live budget. Its own password takes over, so everyone is
    signed out and has to sign in again."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
        info = {i.filename: i for i in z.infolist()}
        if set(info) != {"budget.db", "budget.db.keys"} or any(i.file_size > 512 * 1024 * 1024 for i in info.values()):
            raise ValueError
        db_bytes, keys_bytes = z.read("budget.db"), z.read("budget.db.keys")
        kf = json.loads(keys_bytes)
        if "password" not in kf or db_bytes[:16] == secure.SQLITE_MAGIC:
            raise ValueError
    except (zipfile.BadZipFile, ValueError, KeyError):
        abort(400, "That doesn't look like a My NAB encrypted backup")
    fd, tmp_path = tempfile.mkstemp(suffix=".db", dir=os.path.dirname(active_path) or ".")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(db_bytes)
        secure.lock_now(active_path)
        with open(secure.keys_path(active_path), "wb") as kh:
            kh.write(keys_bytes)
        os.replace(tmp_path, active_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    db._CHECKED_SCHEMA.discard(active_path)
    session.pop("open_budget_id", None)
    session.pop("sid", None)
    return jsonify({"ok": True, "signed_out": True})


@system_bp.route("/api/schema-version")
@require_auth
def api_schema_version():
    path = db.current_budget_path()
    return jsonify({"version": db.schema_version(path), "latest": db.SCHEMA_VERSION,
                    "backups": db.list_upgrade_backups(path)})
