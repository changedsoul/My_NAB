"""Per-device view settings, remembered on the server by the User-Agent the device
identifies itself with. A browser whose cache was cleared asks for its profile back
on its next visit. Profiles not seen for STALE_DAYS are dropped (checked whenever any
device connects, so no scheduler is needed). The page decides which settings go in
the blob; the server only stores it."""

import json
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, abort

import db
from api.auth import require_auth

devices_bp = Blueprint("devices", __name__)

STALE_DAYS = 30
MAX_BYTES = 64 * 1024


def _ua():
    return (request.headers.get("User-Agent") or "").strip()[:500]


def _now():
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def _purge(conn):
    cutoff = (datetime.utcnow() - timedelta(days=STALE_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("DELETE FROM device_profiles WHERE last_seen < ?", (cutoff,))


@devices_bp.route("/api/device-profile")
@require_auth
def api_device_profile_get():
    ua = _ua()
    conn = db.get_db()
    try:
        _purge(conn)
        row = conn.execute("SELECT data FROM device_profiles WHERE ua=?", (ua,)).fetchone() if ua else None
        if row:
            conn.execute("UPDATE device_profiles SET last_seen=? WHERE ua=?", (_now(), ua))
        conn.commit()
        return jsonify({"data": json.loads(row["data"]) if row else None})
    finally:
        conn.close()


@devices_bp.route("/api/device-profile", methods=["PUT"])
@require_auth
def api_device_profile_put():
    ua = _ua()
    data = (request.json or {}).get("data")
    if not ua or not isinstance(data, dict) or not all(isinstance(v, str) for v in data.values()):
        abort(400, "Expected {data: {key: string}}")
    blob = json.dumps(data)
    if len(blob) > MAX_BYTES:
        abort(400, "Profile too large")
    conn = db.get_db()
    try:
        conn.execute("INSERT INTO device_profiles (ua, data, last_seen) VALUES (?,?,?) "
                     "ON CONFLICT(ua) DO UPDATE SET data=excluded.data, last_seen=excluded.last_seen",
                     (ua, blob, _now()))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
