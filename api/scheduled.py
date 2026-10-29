"""Scheduled (recurring) transactions: CRUD, plus the due-soon preference.

Auto-entry into the register happens in scheduled_engine.materialize_due(),
called from the transactions/budget GET endpoints — this module just manages
the schedule rules themselves and reports each one's current status.
"""

import re
from datetime import date

from flask import Blueprint, jsonify, request, abort, session

import db
import scheduled_engine
from api.auth import require_auth

scheduled_bp = Blueprint("scheduled", __name__)


@scheduled_bp.route("/api/scheduled")
@require_auth
def api_scheduled_list():
    conn = db.get_db()
    try:
        scheduled_engine.materialize_due(conn)
        threshold = scheduled_engine.due_soon_days(conn)
        rows = conn.execute(
            "SELECT s.*, c.name AS category_name, a.name AS account_name, "
            "ta.name AS transfer_account_name "
            "FROM scheduled_transactions s "
            "LEFT JOIN categories c ON c.id=s.category_id "
            "LEFT JOIN accounts a ON a.id=s.account_id "
            "LEFT JOIN accounts ta ON ta.id=s.transfer_account_id "
            "ORDER BY s.next_date").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["status"], d["next_date"] = scheduled_engine.schedule_status_and_date(
                conn, r["id"], r["next_date"], threshold, r["frequency"])
            out.append(d)
            # Payments already made on a repeating schedule get a row of their own (the Scheduled page lists them
            # first, in the order paid), until the occurrence's own due date comes up.
            if r["frequency"] != "Never":
                for p in scheduled_engine.paid_occurrences(conn, r["id"]):
                    out.append({**d, "status": "paid", "paid_txn_id": p["id"], "paid_date": p["date"],
                                "paid_amount": p["amount"], "paid_memo": p["memo"], "paid_at": p["paid_at"],
                                "due_date": p["sched_due"]})
        return jsonify(out)
    finally:
        conn.close()


@scheduled_bp.route("/api/scheduled/<int:sid>/occurrence", methods=["POST"])
@require_auth
def api_scheduled_occurrence(sid):
    """The register entry to pay for this schedule: its oldest unpaid one, or, if nothing is waiting yet, the next
    occurrence entered now so it can be paid ahead of time."""
    conn = db.get_db()
    try:
        if not conn.execute("SELECT 1 FROM scheduled_transactions WHERE id=?", (sid,)).fetchone():
            return jsonify({"error": "That scheduled transaction no longer exists."}), 404
        tid = scheduled_engine.oldest_unpaid_id(conn, sid) or scheduled_engine.enter_next_occurrence(conn, sid)
        if tid is None:
            return jsonify({"error": "There's nothing left to pay on this scheduled transaction."}), 409
        return jsonify({"transaction_id": tid})
    finally:
        conn.close()


@scheduled_bp.route("/api/scheduled/<int:sid>/history")
@require_auth
def api_scheduled_history(sid):
    """Every transaction ever materialized from this schedule (paid or not),
    newest first — the "previously paid" sub-page under Scheduled."""
    conn = db.get_db()
    try:
        sched = conn.execute(
            "SELECT s.*, a.name AS account_name FROM scheduled_transactions s "
            "LEFT JOIN accounts a ON a.id=s.account_id WHERE s.id=?", (sid,)).fetchone()
        if not sched:
            abort(404)
        rows = conn.execute(
            "SELECT t.*, c.name AS category_name, a.name AS account_name, "
            "ta.name AS transfer_account_name "
            "FROM transactions t "
            "LEFT JOIN categories c ON c.id=t.category_id "
            "LEFT JOIN accounts a ON a.id=t.account_id "
            "LEFT JOIN accounts ta ON ta.id=t.transfer_account_id "
            "WHERE t.scheduled_id=? ORDER BY t.date DESC, t.id DESC", (sid,)).fetchall()
        return jsonify({"schedule": dict(sched), "transactions": [dict(r) for r in rows]})
    finally:
        conn.close()


def _id_list(p):
    """The `transaction_ids` list from a link/unlink payload, as sorted unique
    ints. Returns None if it's missing, empty, absurdly long, or not integers."""
    try:
        ids = sorted({int(i) for i in (p.get("transaction_ids") or [])})
    except (TypeError, ValueError):
        return None
    return ids if 0 < len(ids) <= 1000 else None


def _with_mirrors(conn, ids):
    """`ids` plus the other half of any transfer pair among them — a scheduled
    transfer is entered as two linked transactions, so linking one side links both."""
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT id, transfer_txn_id FROM transactions WHERE id IN ({marks})", ids).fetchall()
    out = set(ids)
    out.update(r["transfer_txn_id"] for r in rows if r["transfer_txn_id"])
    return out


@scheduled_bp.route("/api/scheduled/<int:sid>/link", methods=["POST"])
@require_auth
def api_scheduled_link(sid):
    """Attach existing transactions to a schedule so they show up in its
    history. Only transactions dated today or earlier: a future-dated one
    would be treated as an unpaid upcoming occurrence (and could be pulled out
    of the register if the due-soon window later shrinks)."""
    p = request.json or {}
    ids = _id_list(p)
    if ids is None:
        return jsonify({"error": "Pick at least one transaction."}), 400
    conn = db.get_db()
    try:
        if not conn.execute("SELECT 1 FROM scheduled_transactions WHERE id=?", (sid,)).fetchone():
            return jsonify({"error": "That scheduled transaction no longer exists."}), 404
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT id, date FROM transactions WHERE id IN ({marks})", ids).fetchall()
        if len(rows) != len(ids):
            return jsonify({"error": "Some of those transactions no longer exist."}), 404
        today = date.today().isoformat()
        if any(r["date"] > today for r in rows):
            return jsonify({"error": "Only transactions dated today or earlier can be linked as history."}), 400
        every = sorted(_with_mirrors(conn, ids))
        emarks = ",".join("?" * len(every))
        conn.execute(f"UPDATE transactions SET scheduled_id=?, sched_auto=0 WHERE id IN ({emarks})", [sid, *every])
        if p.get("mark_cleared"):
            # An uncleared linked transaction reads as an unpaid occurrence
            # (Past Due). Reconciled ones (2) are left alone.
            conn.execute(f"UPDATE transactions SET cleared=1 WHERE id IN ({emarks}) AND cleared=0", every)
        conn.commit()
        return jsonify({"ok": True, "linked": len(ids)})
    finally:
        conn.close()


@scheduled_bp.route("/api/scheduled/<int:sid>/unlink", methods=["POST"])
@require_auth
def api_scheduled_unlink(sid):
    """Detach transactions from this schedule's history. The transactions
    themselves stay in the register untouched."""
    ids = _id_list(request.json or {})
    if ids is None:
        return jsonify({"error": "Pick at least one transaction."}), 400
    conn = db.get_db()
    try:
        every = sorted(_with_mirrors(conn, ids))
        emarks = ",".join("?" * len(every))
        conn.execute(
            f"UPDATE transactions SET scheduled_id=NULL WHERE scheduled_id=? AND id IN ({emarks})",
            [sid, *every])
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


_SCHED_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _sched_fields(p):
    """Coerce/validate an incoming schedule payload. Raises ValueError on bad
    input so callers can turn it into a clean 400 instead of a 500."""
    try:
        account_id = int(p["account_id"])
        amount = int(round(float(p.get("amount", 0))))
    except (KeyError, TypeError, ValueError):
        raise ValueError("account_id and a numeric amount are required")
    next_date = p.get("next_date")
    if not next_date or not _SCHED_DATE_RE.match(str(next_date)):
        raise ValueError("next_date (YYYY-MM-DD) is required")
    if p.get("transfer_account_id") and int(p["transfer_account_id"]) == account_id:
        raise ValueError("Can't transfer to the same account")
    cal_time = (p.get("cal_time") or "").strip()
    if cal_time and not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", cal_time):
        raise ValueError("calendar time must be HH:MM")
    return {
        "cal_alert": 0 if p.get("cal_alert") in (0, False, "0") else 1,
        "cal_time": cal_time,
        "account_id": account_id,
        "payee": (p.get("payee") or "").strip(),
        "category_id": p.get("category_id") or None,
        "transfer_account_id": p.get("transfer_account_id") or None,
        "memo": (p.get("memo") or "").strip(),
        "amount": amount,
        "next_date": next_date,
        "frequency": p.get("frequency") or "Never",
    }


@scheduled_bp.route("/api/scheduled", methods=["POST"])
@require_auth
def api_scheduled_create():
    p = request.json or {}
    if p.get("frequency") not in scheduled_engine.FREQUENCIES:
        abort(400, "invalid frequency")
    try:
        f = _sched_fields(p)
    except ValueError as e:
        abort(400, str(e))
    conn = db.get_db()
    try:
        cur = conn.execute(
            "INSERT INTO scheduled_transactions (account_id, payee, category_id, "
            "transfer_account_id, memo, amount, next_date, frequency, cal_alert, cal_time) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (f["account_id"], f["payee"], f["category_id"], f["transfer_account_id"],
             f["memo"], f["amount"], f["next_date"], f["frequency"],
             f["cal_alert"], f["cal_time"]))
        conn.commit()
        return jsonify({"ok": True, "id": cur.lastrowid})
    finally:
        conn.close()


def _sync_unpaid_occurrences(conn, sid, old, f):
    """Carry an edit of a schedule through to the entries it already put in the register.

    Only unpaid ones (cleared=0) follow along; payments already made are history and are left
    exactly as they were. Handles account, payee, memo, amount and category, and turning an
    entry into a transfer (the other side is created), back into a plain entry (the other side
    is removed), or pointing it at a different account (the other side moves). Dates are
    handled by the caller."""
    rows = conn.execute(
        "SELECT * FROM transactions WHERE scheduled_id=? AND " + scheduled_engine.UNPAID_SQL.format(t="transactions")
        + " AND sched_auto=1 AND account_id=?", (sid, old["account_id"])).fetchall()
    dest = f["transfer_account_id"]
    for r in rows:
        mirror_id = r["transfer_txn_id"]
        if dest:
            conn.execute(
                "UPDATE transactions SET account_id=?, payee=?, memo=?, amount=?, category_id=NULL, "
                "transfer_account_id=?, version=version+1 WHERE id=?",
                (f["account_id"], "", f["memo"], f["amount"], dest, r["id"]))
            conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (r["id"],))
            if mirror_id:
                conn.execute(
                    "UPDATE transactions SET account_id=?, payee=?, memo=?, amount=?, "
                    "transfer_account_id=?, version=version+1 WHERE id=?",
                    (dest, "", f["memo"], -f["amount"], f["account_id"], mirror_id))
            else:
                cur2 = conn.execute(
                    "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
                    "transfer_account_id, transfer_txn_id, scheduled_id, sched_auto, sched_due) VALUES (?,?,?,?,?,0,?,?,?,1,?)",
                    (dest, r["date"], "", f["memo"], -f["amount"], f["account_id"], r["id"], sid, r["sched_due"] or r["date"]))
                conn.execute("UPDATE transactions SET transfer_txn_id=? WHERE id=?",
                             (cur2.lastrowid, r["id"]))
        else:
            if mirror_id:    # it was a transfer and no longer is: its other side goes away
                conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (mirror_id,))
                conn.execute("DELETE FROM transactions WHERE id=?", (mirror_id,))
            conn.execute(
                "UPDATE transactions SET account_id=?, payee=?, memo=?, amount=?, category_id=?, "
                "transfer_account_id=NULL, transfer_txn_id=NULL, version=version+1 WHERE id=?",
                (f["account_id"], f["payee"], f["memo"], f["amount"], f["category_id"], r["id"]))


@scheduled_bp.route("/api/scheduled/<int:sid>", methods=["PUT"])
@require_auth
def api_scheduled_update(sid):
    p = request.json or {}
    if p.get("frequency") not in scheduled_engine.FREQUENCIES:
        abort(400, "invalid frequency")
    try:
        f = _sched_fields(p)
    except ValueError as e:
        abort(400, str(e))
    conn = db.get_db()
    try:
        cur = conn.execute("SELECT * FROM scheduled_transactions WHERE id=?", (sid,)).fetchone()
        if not cur:
            abort(404)
        # The date shown for a schedule is that of its oldest UNPAID occurrence
        # already entered in the register (see schedule_status_and_date), not the
        # stored next_date, which has moved on past it. So a changed date has to
        # move that register entry too — saving only the stored column was
        # silently undone by the entry that was already there.
        next_date = f["next_date"]
        oldest = conn.execute(
            "SELECT * FROM transactions WHERE scheduled_id=? AND account_id=? AND "
            + scheduled_engine.UNPAID_SQL.format(t="transactions") + " AND sched_auto=1 "
            "ORDER BY date ASC LIMIT 1", (sid, cur["account_id"])).fetchone()
        if oldest is None:
            pass   # nothing entered yet / all paid: the stored date IS the shown date
        elif next_date == oldest["date"]:
            next_date = cur["next_date"]   # date untouched: keep the stored one as is
        else:
            others = conn.execute(
                "SELECT COUNT(*) AS n FROM transactions WHERE scheduled_id=? AND account_id=? AND "
                + scheduled_engine.UNPAID_SQL.format(t="transactions") + " AND sched_auto=1 AND id<>?",
                (sid, cur["account_id"], oldest["id"])).fetchone()["n"]
            ids = [oldest["id"]] + ([oldest["transfer_txn_id"]] if oldest["transfer_txn_id"] else [])
            days_out = (scheduled_engine._parse(next_date) - date.today()).days
            if days_out > scheduled_engine.due_soon_days(conn):
                # Pushed beyond the due-soon window: take it back out of the register;
                # it's entered again once it's genuinely due.
                for tid in ids:
                    conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (tid,))
                    conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
            else:
                for tid in ids:
                    conn.execute("UPDATE transactions SET date=?, sched_due=?, version=version+1 WHERE id=?",
                                 (next_date, next_date, tid))
                # The following occurrence now comes one period after the new date.
                if not others:
                    nxt = scheduled_engine.advance_date(
                        scheduled_engine._parse(next_date), f["frequency"])
                    next_date = nxt.isoformat() if nxt else next_date
                else:
                    next_date = cur["next_date"]
        _sync_unpaid_occurrences(conn, sid, cur, f)
        conn.execute(
            "UPDATE scheduled_transactions SET account_id=?, payee=?, category_id=?, "
            "transfer_account_id=?, memo=?, amount=?, next_date=?, frequency=?, "
            "cal_alert=?, cal_time=? WHERE id=?",
            (f["account_id"], f["payee"], f["category_id"], f["transfer_account_id"],
             f["memo"], f["amount"], next_date, f["frequency"],
             f["cal_alert"], f["cal_time"], sid))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@scheduled_bp.route("/api/scheduled/<int:sid>", methods=["DELETE"])
@require_auth
def api_scheduled_delete(sid):
    conn = db.get_db()
    try:
        row = conn.execute(
            "SELECT * FROM scheduled_transactions WHERE id=?", (sid,)).fetchone()
        if not row:
            abort(404)
        # Occurrences that were auto-entered but never paid belong to the
        # schedule, so they go with it (a transfer's other side too). Paid ones
        # are real history: detach (not delete) them — they stay in the register
        # as ordinary transactions, just no longer schedule-linked. Their ids are
        # stashed below so Undo can re-link them.
        unpaid = conn.execute(
            "SELECT id, date, transfer_txn_id FROM transactions "
            "WHERE scheduled_id=? AND " + scheduled_engine.UNPAID_SQL.format(t="transactions") + " AND sched_auto=1",
            (sid,)).fetchall()
        gone = {r["id"] for r in unpaid} | {r["transfer_txn_id"] for r in unpaid if r["transfer_txn_id"]}
        for tid in gone:
            conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (tid,))
            conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
        detached = [r["id"] for r in conn.execute(
            "SELECT id FROM transactions WHERE scheduled_id=?", (sid,)).fetchall()]
        conn.execute("UPDATE transactions SET scheduled_id=NULL WHERE scheduled_id=?", (sid,))
        # Undo must bring the removed occurrence back: rewind the schedule to the
        # earliest one removed so it is entered again.
        restore_date = min([r["date"] for r in unpaid] + [row["next_date"]])
        conn.execute("DELETE FROM scheduled_transactions WHERE id=?", (sid,))
        conn.commit()
        # One-slot undo buffer, scoped to this browser session — a later
        # delete just overwrites it, so only the most recent one is ever
        # recoverable.
        session["undo_scheduled_delete"] = {
            "account_id": row["account_id"], "payee": row["payee"],
            "category_id": row["category_id"],
            "transfer_account_id": row["transfer_account_id"],
            "memo": row["memo"], "amount": row["amount"],
            "next_date": restore_date, "frequency": row["frequency"],
            "cal_alert": row["cal_alert"], "cal_time": row["cal_time"],
            "transaction_ids": detached,
        }
        return jsonify({"ok": True})
    finally:
        conn.close()


@scheduled_bp.route("/api/scheduled/undo-delete", methods=["POST"])
@require_auth
def api_scheduled_undo_delete():
    snap = session.pop("undo_scheduled_delete", None)
    if not snap:
        abort(400, "Nothing to undo")
    conn = db.get_db()
    try:
        cur = conn.execute(
            "INSERT INTO scheduled_transactions (account_id, payee, category_id, "
            "transfer_account_id, memo, amount, next_date, frequency, cal_alert, cal_time) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (snap["account_id"], snap["payee"], snap["category_id"],
             snap["transfer_account_id"], snap["memo"], snap["amount"],
             snap["next_date"], snap["frequency"],
             snap.get("cal_alert", 1), snap.get("cal_time", "")))
        new_id = cur.lastrowid
        ids = snap.get("transaction_ids") or []
        if ids:
            conn.execute(
                f"UPDATE transactions SET scheduled_id=? WHERE id IN "
                f"({','.join('?' * len(ids))})", [new_id, *ids])
        conn.commit()
        return jsonify({"ok": True, "id": new_id})
    finally:
        conn.close()


@scheduled_bp.route("/api/preferences")
@require_auth
def api_preferences_get():
    conn = db.get_db()
    try:
        # Only report a default account that still exists and is open.
        acct = db.get_setting(conn, "default_account_id")
        ok = acct and conn.execute(
            "SELECT 1 FROM accounts WHERE id=? AND closed=0", (acct,)).fetchone()
        return jsonify({"due_soon_days": scheduled_engine.due_soon_days(conn),
                        "default_account_id": int(acct) if ok else None})
    finally:
        conn.close()


@scheduled_bp.route("/api/preferences", methods=["POST"])
@require_auth
def api_preferences_set():
    p = request.json or {}
    if "default_account_id" in p:
        conn = db.get_db()
        try:
            val = p["default_account_id"]
            if val in (None, ""):
                db.set_setting(conn, "default_account_id", "")
            else:
                try:
                    val = int(val)
                except (TypeError, ValueError):
                    abort(400, "default_account_id must be an account id")
                if not conn.execute("SELECT 1 FROM accounts WHERE id=?", (val,)).fetchone():
                    abort(400, "No such account")
                db.set_setting(conn, "default_account_id", val)
            conn.commit()
        finally:
            conn.close()
    if "due_soon_days" in p:
        try:
            days = int(p["due_soon_days"])
        except (TypeError, ValueError):
            abort(400, "due_soon_days must be an integer")
        if days < 0 or days > 60:
            abort(400, "due_soon_days must be between 0 and 60")
        conn = db.get_db()
        try:
            old_days = scheduled_engine.due_soon_days(conn)
            db.set_setting(conn, "due_soon_days", days)
            conn.commit()
            # A smaller window means some not-yet-due, still-unpaid entries no
            # longer belong in the register — pull them back out.
            if days < old_days:
                scheduled_engine.retract_not_yet_due(conn, days)
        finally:
            conn.close()
    return jsonify({"ok": True})
