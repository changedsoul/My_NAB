"""What the importer has learned, and what you've changed about it (Settings, Auto-fill).

Two kinds of memory, both worked out from your own transactions:
  categories: a payee's usual category, used to fill in new transactions when you import
  aliases:    bank wording you've matched to one of your payees ("FRESH MARKET #4412" -> "Fresh Market")
You can change either (your choice then wins over what was learned), switch one off ("forget"), or put it back.
"""
import re

from flask import Blueprint, abort, jsonify, request

import db
import importers
from api.auth import require_auth

memory_bp = Blueprint("memory", __name__)

_KEY = re.compile(r"^[a-z]{1,40}$")
_KINDS = ("category", "alias")


def _check_key(key):
    if not _KEY.match(key or ""):
        abort(400, "bad key")
    return key


@memory_bp.route("/api/memory/categories")
@require_auth
def api_memory_categories():
    conn = db.get_db()
    try:
        return jsonify(importers.list_memory_categories(conn, request.args.get("q", ""), 500))
    finally:
        conn.close()


@memory_bp.route("/api/memory/aliases")
@require_auth
def api_memory_aliases():
    conn = db.get_db()
    try:
        return jsonify(importers.list_memory_aliases(conn, request.args.get("q", ""), 500))
    finally:
        conn.close()


@memory_bp.route("/api/memory/<kind>/<key>", methods=["PUT"])
@require_auth
def api_memory_set(kind, key):
    """Choose what a payee's category (kind 'category': {category_id, label}) or a bank wording's payee
    (kind 'alias': {payee, label}) should be."""
    if kind not in _KINDS:
        abort(404)
    _check_key(key)
    p = request.json or {}
    label = str(p.get("label") or "")[:120]
    conn = db.get_db()
    try:
        db.ensure_import_memory(conn)
        if kind == "category":
            cid = p.get("category_id")
            if not cid or not conn.execute("SELECT 1 FROM categories WHERE id=?", (int(cid),)).fetchone():
                abort(400, "Choose a category")
            value = str(int(cid))
        else:
            value = str(p.get("payee") or "").strip()
            if not value:
                abort(400, "Enter a payee")
        conn.execute("INSERT INTO import_memory (kind, key, value, label, forgotten) VALUES (?,?,?,?,0) "
                     "ON CONFLICT(kind, key) DO UPDATE SET value=excluded.value, forgotten=0, "
                     "label=CASE WHEN excluded.label<>'' THEN excluded.label ELSE label END",
                     (kind, key, value, label))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@memory_bp.route("/api/memory/<kind>/<key>", methods=["DELETE"])
@require_auth
def api_memory_forget(kind, key):
    """mode=forget: stop using what was learned for this one. mode=reset (default): drop your change and go back
    to what is learned."""
    if kind not in _KINDS:
        abort(404)
    _check_key(key)
    forget = request.args.get("mode") == "forget"
    label = str((request.json or {}).get("label") or "")[:120] if request.is_json else ""
    conn = db.get_db()
    try:
        db.ensure_import_memory(conn)
        if forget:
            conn.execute("INSERT INTO import_memory (kind, key, value, label, forgotten) VALUES (?,?,NULL,?,1) "
                         "ON CONFLICT(kind, key) DO UPDATE SET value=NULL, forgotten=1, "
                         "label=CASE WHEN excluded.label<>'' THEN excluded.label ELSE label END", (kind, key, label))
        else:
            conn.execute("DELETE FROM import_memory WHERE kind=? AND key=?", (kind, key))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
