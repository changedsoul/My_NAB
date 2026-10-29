"""Imports: CSV, OFX/QFX (with dedup + preview), Actual Budget, and undo."""

from flask import Blueprint, jsonify, request, abort

import db
import importers
from api.auth import require_auth

imports_bp = Blueprint("imports", __name__)


@imports_bp.route("/api/import/csv/sniff", methods=["POST"])
@require_auth
def api_csv_sniff():
    text = (request.json or {}).get("text", "")
    return jsonify(importers.sniff_csv(text))


@imports_bp.route("/api/import/detect", methods=["POST"])
@require_auth
def api_import_detect():
    """What kind of file is this (QFX/OFX or CSV) and, for QFX/OFX, which of your accounts it belongs to."""
    text = (request.json or {}).get("text", "")
    conn = db.get_db()
    try:
        return jsonify(importers.detect_file(conn, text))
    finally:
        conn.close()


def _category_map(p):
    """{row index: category id or None} from a review-screen payload, or None if the screen didn't send one."""
    raw = p.get("categories")
    if raw is None:
        return None
    try:
        return {int(k): (int(v) if v else None) for k, v in raw.items()}
    except (TypeError, ValueError, AttributeError):
        abort(400, "categories must map row numbers to category ids")


def _auto_cat(p):
    return p.get("auto_categorize", True) is not False


def _match_map(p):
    """{row index: transaction id} from a review-screen payload (JSON keys are strings)."""
    try:
        return {int(k): int(v) for k, v in (p.get("matches") or {}).items()}
    except (TypeError, ValueError, AttributeError):
        abort(400, "matches must map row numbers to transaction ids")


@imports_bp.route("/api/import/match-candidates", methods=["POST"])
@require_auth
def api_match_candidates():
    """Entries with exactly this amount near this date, for matching a bank row by hand."""
    p = request.json or {}
    try:
        account_id, amount, days = int(p["account_id"]), int(p["amount"]), int(p.get("days", 3))
        day = str(p["date"])
        if len(day) != 10:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        abort(400, "account_id, amount (cents) and date (YYYY-MM-DD) are required")
    conn = db.get_db()
    try:
        return jsonify(importers.match_candidates(conn, account_id, amount, day, days))
    finally:
        conn.close()


@imports_bp.route("/api/import/csv/preview", methods=["POST"])
@require_auth
def api_csv_preview():
    p = request.json or {}
    conn = db.get_db()
    try:
        return jsonify(importers.preview_csv(conn, p.get("text", ""), p.get("mapping", {}), auto_cat=_auto_cat(p)))
    except (KeyError, ValueError) as e:
        abort(400, f"Could not read that CSV with those column settings: {e}")
    finally:
        conn.close()


@imports_bp.route("/api/import/csv", methods=["POST"])
@require_auth
def api_csv_import():
    p = request.json or {}
    indices = p.get("indices")
    if indices is not None:
        indices = [int(i) for i in indices]
    conn = db.get_db()
    try:
        result = importers.import_csv(conn, p.get("text", ""), p.get("mapping", {}),
                                      indices=indices, matches=_match_map(p),
                                      categories=_category_map(p), auto_cat=_auto_cat(p))
        return jsonify(result)
    finally:
        conn.close()


@imports_bp.route("/api/import/ofx/preview", methods=["POST"])
@require_auth
def api_ofx_preview():
    p = request.json or {}
    if not p.get("account_id"):
        abort(400, "account_id required")
    conn = db.get_db()
    try:
        return jsonify(importers.preview_ofx(
            conn, p.get("text", ""), int(p["account_id"]),
            int(p.get("dedup_days", 2)), stmt=p.get("stmt"), auto_cat=_auto_cat(p)))
    except Exception as e:
        abort(400, f"Could not read OFX/QFX file: {e}")
    finally:
        conn.close()


@imports_bp.route("/api/import/ofx", methods=["POST"])
@require_auth
def api_ofx_import():
    p = request.json or {}
    if not p.get("account_id"):
        abort(400, "account_id required")
    indices = p.get("indices")
    if indices is not None:
        indices = [int(i) for i in indices]
    conn = db.get_db()
    try:
        result = importers.import_ofx(
            conn, p.get("text", ""), int(p["account_id"]),
            int(p.get("dedup_days", 2)), bool(p.get("include_duplicates")),
            indices=indices, matches=_match_map(p), stmt=p.get("stmt"),
            categories=_category_map(p), auto_cat=_auto_cat(p))
        importers.remember_account(conn, p.get("text", ""), p.get("stmt"), int(p["account_id"]))
        return jsonify(result)
    except Exception as e:
        conn.rollback()
        abort(400, f"Import failed: {e}")
    finally:
        conn.close()


@imports_bp.route("/api/import/batches")
@require_auth
def api_import_batches():
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT b.*, a.name AS account_name, "
            "(SELECT COUNT(*) FROM transactions t WHERE t.import_batch_id=b.id) "
            "AS current_count "
            "FROM import_batches b LEFT JOIN accounts a ON a.id=b.account_id "
            "ORDER BY b.id DESC LIMIT 25").fetchall()
        # Only show batches that still have transactions to undo.
        return jsonify([dict(r) for r in rows if r["current_count"] > 0])
    finally:
        conn.close()


@imports_bp.route("/api/import/batches/<int:bid>/undo", methods=["POST"])
@require_auth
def api_undo_import(bid):
    conn = db.get_db()
    try:
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM transactions WHERE import_batch_id=?",
            (bid,)).fetchone()["n"]
        # Clear split lines first — foreign_keys is ON, so deleting a split
        # parent while its lines still reference it fails (an Actual import
        # can contain split transactions, so this path really does hit it).
        conn.execute(
            "DELETE FROM transaction_splits WHERE transaction_id IN "
            "(SELECT id FROM transactions WHERE import_batch_id=?)", (bid,))
        conn.execute("DELETE FROM transactions WHERE import_batch_id=?", (bid,))
        conn.execute("DELETE FROM import_batches WHERE id=?", (bid,))
        conn.commit()
        return jsonify({"removed": n})
    finally:
        conn.close()


def _forget_batches(conn, where, args):
    """Take imports off the Recent imports list. The transactions stay exactly as they are; they just can't be
    undone as a group any more."""
    ids = [r["id"] for r in conn.execute(f"SELECT id FROM import_batches {where}", args)]
    for i in ids:
        conn.execute("UPDATE transactions SET import_batch_id=NULL WHERE import_batch_id=?", (i,))
        conn.execute("DELETE FROM import_batches WHERE id=?", (i,))
    conn.commit()
    return len(ids)


@imports_bp.route("/api/import/batches/<int:bid>", methods=["DELETE"])
@require_auth
def api_dismiss_import(bid):
    conn = db.get_db()
    try:
        return jsonify({"removed": _forget_batches(conn, "WHERE id=?", (bid,))})
    finally:
        conn.close()


@imports_bp.route("/api/import/batches/clear", methods=["POST"])
@require_auth
def api_clear_imports():
    conn = db.get_db()
    try:
        return jsonify({"removed": _forget_batches(conn, "", ())})
    finally:
        conn.close()


@imports_bp.route("/api/import/actual", methods=["POST"])
@require_auth
def api_actual_import():
    f = request.files.get("file")
    if not f:
        abort(400, "No file uploaded")
    data = f.read()
    conn = db.get_db()
    try:
        stats = importers.import_actual(
            conn, data, db.income_category_id(conn))
        return jsonify(stats)
    except Exception as e:  # surface import errors to the UI
        conn.rollback()
        abort(400, f"Import failed: {e}")
    finally:
        conn.close()
