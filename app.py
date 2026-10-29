"""My NAB — a self-hosted zero-based budgeting app (classic envelope style).

Run locally for testing:   python3 app.py
Run in production/Docker:   gunicorn -b 0.0.0.0:8000 app:app

The HTTP API is split by domain under the `api/` package; this module is just
the application factory: configure Flask, pick a stable secret, and register
the blueprints.
"""

import gzip
import os
import secrets
from datetime import timedelta

from flask import Flask, Response, g, jsonify, request, session
from werkzeug.exceptions import HTTPException

import db
import secure
from api import register_blueprints


def _env_flag(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


# Serving TLS straight from the app (dev server via these vars, gunicorn via its
# --certfile/--keyfile). Either way the browser is on HTTPS, so the session
# cookie can be marked Secure.
TLS_CERT = os.environ.get("NAB_TLS_CERT", "").strip()
TLS_KEY = os.environ.get("NAB_TLS_KEY", "").strip()

app = Flask(__name__, static_folder=None)
app.config.update(
    MAX_CONTENT_LENGTH=64 * 1024 * 1024,          # 64 MB uploads
    # Session cookie hardening. HttpOnly keeps it out of JS; SameSite=Lax
    # blocks it on cross-site POST/PUT/DELETE (the practical CSRF defense
    # here, since there are no CSRF tokens). Secure is opt-in via env because
    # the app is commonly run over plain HTTP on a home LAN, where a forced
    # Secure cookie would simply never be sent; set NAB_HTTPS=1 behind TLS.
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=_env_flag("NAB_HTTPS") or bool(TLS_CERT),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# Below ~1KB, gzip's own CPU time roughly cancels out the bytes it saves even
# on a slow connection — not worth the cycle. Above it, compression is a
# near-free win on any realistic network (crossover bandwidth for a typical
# JSON response here is in the gigabit range). Scoped to text/JSON bodies —
# file downloads (e.g. the sqlite backup) stream via direct_passthrough and
# are skipped so their Content-Range/Accept-Ranges headers stay meaningful.
_COMPRESS_MIN_SIZE = 1024


# When the app is reached over HTTPS (behind a TLS reverse proxy, or serving TLS
# itself), tell the browser to load any page subresource that was requested with
# a plain http:// URL over https:// instead. Otherwise a single stray http://
# request makes Chrome mark the whole page "not secure", which also blocks
# installing the app.
@app.after_request
def _upgrade_insecure(response):
    # frame-ancestors/object-src/base-uri: nobody can embed the app in a page of theirs
    # (clickjacking), load plugins, or re-point relative URLs.
    csp = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    if _env_flag("NAB_HTTPS") or TLS_CERT:
        csp = "upgrade-insecure-requests; " + csp
    response.headers.setdefault("Content-Security-Policy", csp)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@app.after_request
def _compress_response(response):
    if "gzip" not in request.headers.get("Accept-Encoding", "").lower():
        return response
    if response.direct_passthrough or response.content_encoding:
        return response
    if not (response.content_type or "").startswith(("application/json", "text/")):
        return response
    data = response.get_data()
    if len(data) < _COMPRESS_MIN_SIZE:
        return response
    response.set_data(gzip.compress(data, compresslevel=6))
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = response.content_length
    response.headers["Vary"] = "Accept-Encoding"
    return response


# Offline-queued writes carry an X-Op-Id header. The first 2xx response for an
# id is remembered, and any replay of the same id gets that response back
# without running the handler again — so a retry after a lost response can't
# double-insert a transaction.
_MUTATING = ("POST", "PUT", "DELETE")


def _op_log_conn():
    # Created on demand as well as in db.init_schema: a session that stayed
    # open across an upgrade never re-opens its budget, so never ran the
    # migration.
    conn = db.get_db()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS op_log ("
        "op_id TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, "
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))")
    return conn


@app.before_request
def _replay_dedupe():
    op_id = request.headers.get("X-Op-Id")
    if not op_id or request.method not in _MUTATING or not session.get("open_budget_id"):
        return None
    conn = _op_log_conn()
    try:
        row = conn.execute("SELECT status, body FROM op_log WHERE op_id=?",
                           (op_id,)).fetchone()
    finally:
        conn.close()
    if row:
        return Response(row["body"], status=row["status"], mimetype="application/json")
    g.op_id = op_id
    return None


@app.after_request
def _record_op(response):
    op_id = g.pop("op_id", None)
    if not op_id or not 200 <= response.status_code < 300:
        return response
    if not (response.content_type or "").startswith("application/json"):
        return response
    conn = _op_log_conn()
    try:
        conn.execute("INSERT OR IGNORE INTO op_log (op_id, status, body) VALUES (?,?,?)",
                     (op_id, response.status_code, response.get_data(as_text=True)))
        conn.execute("DELETE FROM op_log WHERE created_at < datetime('now','-30 days')")
        conn.commit()
    finally:
        conn.close()
    return response


def _secret_key():
    """Stable secret so sessions survive restarts; generated once, stored.
    Global (registry-level) — needed to sign the session cookie even before
    any budget has been opened, so it can't live inside a budget file."""
    env = os.environ.get("NAB_SECRET_KEY")
    if env:
        return env
    key = db.get_app_setting("secret_key")
    if not key:
        key = secrets.token_hex(32)
        db.set_app_setting("secret_key", key)
    return key


db.ensure_ready()
db.upgrade_all_budgets()   # back up + upgrade any budget file older than this release
app.secret_key = _secret_key()
register_blueprints(app)


# The page reads {"error": "..."} from failed API calls. Flask's default error
# pages are HTML, so the app only ever saw the bare status text — which is empty
# over HTTPS/2, giving a red box with nothing in it.
@app.errorhandler(HTTPException)
def _api_http_error(e):
    if not request.path.startswith("/api/"):
        return e
    return jsonify({"error": e.description or e.name}), e.code


@app.errorhandler(secure.Locked)
def _api_locked(e):
    # An encrypted budget whose key is gone (idle too long, signed out elsewhere, server restarted).
    session.pop("open_budget_id", None)
    session.pop("sid", None)
    mins = secure.LOCK_SECONDS // 60
    return jsonify({"error": f"Locked after {mins} minutes without activity. Sign in again.", "locked": True}), 401


@app.errorhandler(Exception)
def _api_server_error(e):
    if not request.path.startswith("/api/"):
        raise e
    app.logger.exception("Unhandled error on %s", request.path)
    # The details are in the server log; don't hand file paths / SQL text to the browser.
    return jsonify({"error": f"Server error ({type(e).__name__}). Details are in the server log."}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # Debug (and with it Werkzeug's interactive, code-executing debugger) is
    # OFF unless explicitly opted into — leaving it on by default exposed an
    # RCE console on the network. When debug IS enabled, bind loopback-only
    # unless a host is forced, so the debugger isn't reachable from the LAN.
    debug = _env_flag("NAB_DEBUG")
    host = os.environ.get("NAB_HOST") or ("127.0.0.1" if debug else "0.0.0.0")
    ssl_context = (TLS_CERT, TLS_KEY) if TLS_CERT and TLS_KEY else None
    if bool(TLS_CERT) != bool(TLS_KEY):
        raise SystemExit("Set both NAB_TLS_CERT and NAB_TLS_KEY (or neither).")
    app.run(host=host, port=port, debug=debug, ssl_context=ssl_context)
