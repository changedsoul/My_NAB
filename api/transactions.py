"""Transactions: list (with running balance), create, update, delete, splits.

Also owns transfer bookkeeping (mirrored transactions) and split lines.
"""

import re

from flask import Blueprint, jsonify, request, abort

import db
import importers
import scheduled_engine
from api.auth import require_auth
from api.common import account_balance

transactions_bp = Blueprint("transactions", __name__)

# Every list of transactions (an account, a search, a category) carries the same fields, so the one register
# screen can draw and edit any of them.
_ROW_COLUMNS = (
    "t.*, c.name AS category_name, a.name AS account_name, ta.name AS transfer_account_name, "
    f"(t.import_batch_id IN {importers.BANK_BATCHES_SQL}) AS bank_imported, "
    "(SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id=t.id) AS split_count")
_ROW_JOINS = ("FROM transactions t "
              "LEFT JOIN categories c ON c.id=t.category_id "
              "LEFT JOIN accounts a ON a.id=t.account_id "
              "LEFT JOIN accounts ta ON ta.id=t.transfer_account_id ")


@transactions_bp.route("/api/transactions")
@require_auth
def api_transactions():
    conn = db.get_db()
    try:
        scheduled_engine.materialize_due(conn)

        # A category's transactions: ones filed straight under it, plus split transactions with a line in it.
        # A split's own category_id is NULL, so a plain WHERE t.category_id=? would miss those. `scope_amount`
        # is what counted toward this category (the split line's share, not the whole transaction).
        if request.args.get("category_id"):
            cid = int(request.args["category_id"])
            month = request.args.get("month")      # optional YYYY-MM
            mclause = " AND substr(t.date, 1, 7)=?" if month else ""
            mparams = [month] if month else []
            rows = conn.execute(
                f"SELECT {_ROW_COLUMNS}, "
                f"CASE WHEN t.category_id=? THEN t.amount ELSE "
                f"(SELECT COALESCE(SUM(s.amount),0) FROM transaction_splits s "
                f"WHERE s.transaction_id=t.id AND s.category_id=?) END AS scope_amount "
                f"{_ROW_JOINS}"
                f"WHERE (t.category_id=? OR EXISTS (SELECT 1 FROM transaction_splits s "
                f"WHERE s.transaction_id=t.id AND s.category_id=?)){mclause} "
                f"ORDER BY t.date DESC, t.id DESC",
                (cid, cid, cid, cid, *mparams)).fetchall()
            return jsonify([dict(r) for r in rows])

        where, params = [], []
        if request.args.get("account_id"):
            where.append("t.account_id=?")
            params.append(int(request.args["account_id"]))
        if request.args.get("search"):
            where.append("(t.payee LIKE ? OR t.memo LIKE ?)")
            s = f"%{request.args['search']}%"
            params += [s, s]
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        # High enough that no realistic personal-finance account (even one
        # with 15+ years of daily activity) gets silently truncated, while
        # still bounding a pathological/unscoped request.
        rows = conn.execute(
            f"SELECT {_ROW_COLUMNS} {_ROW_JOINS}"
            f"{clause} ORDER BY t.date DESC, t.id DESC LIMIT 50000",
            params).fetchall()

        # Running balance (only meaningful for a single-account view).
        out = [dict(r) for r in rows]
        if request.args.get("account_id"):
            bal, _ = account_balance(conn, int(request.args["account_id"]))
            running = bal
            for r in out:  # rows are newest-first; running balance walks down
                r["running_balance"] = running
                running -= r["amount"]
        return jsonify(out)
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/reconcile", methods=["POST"])
@require_auth
def api_reconcile_lock():
    """Finish reconciling an account in one step: lock (cleared -> reconciled) every cleared transaction in it, and
    optionally add the adjustment entry for a gap first. All or nothing."""
    p = request.json or {}
    try:
        account_id = int(p["account_id"])
    except (KeyError, TypeError, ValueError):
        abort(400, "account_id required")
    adj = p.get("adjustment")
    conn = db.get_db()
    try:
        if adj:
            conn.execute(
                "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared) VALUES (?,?,?,?,?,2)",
                (account_id, str(adj["date"]), str(adj.get("payee") or "Reconciliation Balance Adjustment"),
                 str(adj.get("memo") or ""), int(adj["amount"])))
        cur = conn.execute("UPDATE transactions SET cleared=2, version=version+1 WHERE account_id=? AND cleared=1",
                           (account_id,))
        conn.commit()
        return jsonify({"locked": cur.rowcount})
    except (KeyError, TypeError, ValueError):
        conn.rollback()
        abort(400, "adjustment needs a date and an amount")
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/<int:tid>")
@require_auth
def api_transaction_one(tid):
    """One transaction, in the same shape as the register's list rows (so it can be opened for editing from a
    search result or any other list)."""
    conn = db.get_db()
    try:
        row = conn.execute(
            "SELECT t.*, c.name AS category_name, a.name AS account_name, ta.name AS transfer_account_name, "
            "(SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id=t.id) AS split_count "
            "FROM transactions t LEFT JOIN categories c ON c.id=t.category_id "
            "LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN accounts ta ON ta.id=t.transfer_account_id "
            "WHERE t.id=?", (tid,)).fetchone()
        if not row:
            abort(404, "That transaction no longer exists")
        return jsonify(dict(row))
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/review")
@require_auth
def api_review_list():
    """Every transaction that came in through an import and hasn't been checked yet, newest first."""
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT t.*, c.name AS category_name, a.name AS account_name, "
            "(SELECT COUNT(*) FROM transaction_splits s WHERE s.transaction_id=t.id) AS split_count "
            "FROM transactions t LEFT JOIN categories c ON c.id=t.category_id "
            "LEFT JOIN accounts a ON a.id=t.account_id "
            "WHERE t.import_review=1 ORDER BY t.date DESC, t.id DESC LIMIT 5000").fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/review/clear", methods=["POST"])
@require_auth
def api_review_clear():
    """Mark imported transactions as checked: the ones listed in `ids`, else every one in `account_id`, else all."""
    p = request.json or {}
    conn = db.get_db()
    try:
        if p.get("ids"):
            ids = [int(i) for i in p["ids"]]
            cur = conn.execute("UPDATE transactions SET import_review=0 WHERE import_review=1 AND id IN (%s)"
                               % ",".join("?" * len(ids)), ids)
        elif p.get("account_id"):
            cur = conn.execute("UPDATE transactions SET import_review=0 WHERE import_review=1 AND account_id=?",
                               (int(p["account_id"]),))
        else:
            cur = conn.execute("UPDATE transactions SET import_review=0 WHERE import_review=1")
        conn.commit()
        return jsonify({"cleared": cur.rowcount})
    finally:
        conn.close()


_SEARCH_LIMIT = 500
_NUMERIC = re.compile(r"([+-]?)(\d+(?:\.\d{0,2})?)")


@transactions_bp.route("/api/search")
@require_auth
def api_search():
    """Search transactions across every account (or one, with account_id).

    `q` is split into words that must ALL match. A word matches a payee, memo,
    category (including a split line's category), account, transfer account or
    date by substring, and — when it looks like a number — an amount by its
    leading digits: "45.67" or "$1,200" find those amounts in either direction
    ("45" also finds 45.10 and 450.00, but not 145.00), "-45" only outflows,
    "+45" only inflows. Returns the newest matches plus the true count and net
    total across *all* matches, even past the row cap."""
    tokens = (request.args.get("q") or "").split()[:8]
    if not tokens:
        return jsonify({"count": 0, "total": 0, "truncated": False, "transactions": []})
    where, params = [], []
    if request.args.get("account_id"):
        try:
            where.append("t.account_id=?")
            params.append(int(request.args["account_id"]))
        except ValueError:
            abort(400, "account_id must be a number")
    for tok in tokens:
        like = "%" + tok.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        parts = [f"{col} LIKE ? ESCAPE '\\'" for col in
                 ("t.payee", "t.memo", "c.name", "a.name", "ta.name", "t.date")]
        parts.append("EXISTS (SELECT 1 FROM transaction_splits s JOIN categories sc "
                     "ON sc.id=s.category_id WHERE s.transaction_id=t.id "
                     "AND sc.name LIKE ? ESCAPE '\\')")
        ps = [like] * 7
        m = _NUMERIC.fullmatch(tok.replace("$", "").replace(",", ""))
        if m:
            sign, digits = m.groups()
            clause = "printf('%.2f', ABS(t.amount) / 100.0) LIKE ?"
            if sign == "-":
                clause = f"(t.amount < 0 AND {clause})"
            elif sign == "+":
                clause = f"(t.amount > 0 AND {clause})"
            parts.append(clause)
            ps.append(f"{digits}%")      # prefix: "45.67" is exact, "45" finds 45.xx and 450.xx
        where.append("(" + " OR ".join(parts) + ")")
        params += ps
    base = ("FROM transactions t "
            "LEFT JOIN categories c ON c.id=t.category_id "
            "LEFT JOIN accounts a ON a.id=t.account_id "
            "LEFT JOIN accounts ta ON ta.id=t.transfer_account_id "
            "WHERE " + " AND ".join(where))
    conn = db.get_db()
    try:
        scheduled_engine.materialize_due(conn)
        count, total = conn.execute(
            f"SELECT COUNT(*), COALESCE(SUM(t.amount), 0) {base}", params).fetchone()
        rows = conn.execute(
            f"SELECT {_ROW_COLUMNS} "
            f"{base} ORDER BY t.date DESC, t.id DESC LIMIT {_SEARCH_LIMIT}", params).fetchall()
        return jsonify({"count": count, "total": total,
                        "truncated": count > len(rows),
                        "transactions": [dict(r) for r in rows]})
    finally:
        conn.close()


def _txn_fields(p):
    return {
        "account_id": int(p["account_id"]),
        "date": p["date"],
        "payee": (p.get("payee") or "").strip(),
        "category_id": p.get("category_id") or None,
        "memo": (p.get("memo") or "").strip(),
        "amount": int(round(float(p.get("amount", 0)))),
        "cleared": int(p.get("cleared", 0)),
    }


def _save_splits(conn, txn_id, splits):
    """Replace a transaction's split lines. Non-empty splits force its own
    category_id to NULL (the split lines carry the categories)."""
    conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (txn_id,))
    for s in (splits or []):
        conn.execute(
            "INSERT INTO transaction_splits (transaction_id, category_id, amount, memo) "
            "VALUES (?, ?, ?, ?)",
            (txn_id, s.get("category_id") or None,
             int(round(float(s.get("amount", 0)))), (s.get("memo") or "").strip()))
    if splits:
        conn.execute("UPDATE transactions SET category_id=NULL WHERE id=?", (txn_id,))


@transactions_bp.route("/api/transactions", methods=["POST"])
@require_auth
def api_create_transaction():
    p = request.json or {}
    f = _txn_fields(p)
    transfer_to = p.get("transfer_account_id")
    conn = db.get_db()
    try:
        new_id = None
        if transfer_to:
            _create_transfer(conn, f, int(transfer_to))
        else:
            splits = p.get("splits") or []
            cur = conn.execute(
                "INSERT INTO transactions (account_id, date, payee, category_id, "
                "memo, amount, cleared) VALUES (?,?,?,?,?,?,?)",
                (f["account_id"], f["date"], f["payee"],
                 None if splits else f["category_id"],
                 f["memo"], f["amount"], f["cleared"]))
            new_id = cur.lastrowid
            if splits:
                _save_splits(conn, new_id, splits)
        conn.commit()
        return jsonify({"ok": True, "id": new_id})
    finally:
        conn.close()


def _create_transfer(conn, f, transfer_to):
    other = conn.execute("SELECT name FROM accounts WHERE id=?",
                         (transfer_to,)).fetchone()
    this = conn.execute("SELECT name FROM accounts WHERE id=?",
                        (f["account_id"],)).fetchone()
    if not other or not this:
        abort(400, "No such account")
    if transfer_to == f["account_id"]:
        abort(400, "Can't transfer to the same account.")
    cur1 = conn.execute(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
        "transfer_account_id) VALUES (?,?,?,?,?,?,?)",
        (f["account_id"], f["date"], "", f["memo"],      # a transfer has no payee: the other account IS the payee
         f["amount"], f["cleared"], transfer_to))
    id1 = cur1.lastrowid
    cur2 = conn.execute(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
        "transfer_account_id, transfer_txn_id) VALUES (?,?,?,?,?,?,?,?)",
        (transfer_to, f["date"], "", f["memo"],
         -f["amount"], 0, f["account_id"], id1))   # each side is cleared/reconciled on its own account's statement
    conn.execute("UPDATE transactions SET transfer_txn_id=? WHERE id=?",
                 (cur2.lastrowid, id1))


@transactions_bp.route("/api/transactions/<int:tid>", methods=["PUT"])
@require_auth
def api_update_transaction(tid):
    p = request.json or {}
    conn = db.get_db()
    try:
        cur = conn.execute("SELECT * FROM transactions WHERE id=?", (tid,)).fetchone()
        if not cur:
            abort(404)
        f = _txn_fields({**dict(cur), **p})
        expected_version = p.get("version")

        # Moving the entry to another account (entered in the wrong one).
        moving = f["account_id"] != cur["account_id"]
        if moving and cur["scheduled_id"] and cur["sched_auto"] and cur["cleared"] == 0:
            abort(400, "This entry was added by a scheduled transaction and is still unpaid. "
                       "Change its account on the schedule itself (or mark it paid first).")
        if moving:
            dest = conn.execute("SELECT name FROM accounts WHERE id=?",
                                (f["account_id"],)).fetchone()
            if not dest:
                abort(400, "No such account")
            # A transfer between an account and itself makes no sense.
            if cur["transfer_account_id"] == f["account_id"]:
                abort(400, "A transfer's two sides can't be in the same account — "
                           "pick a different account.")

        # Turning a plain (or freshly-created, uncategorized) transaction into
        # a transfer — only when it isn't already one; repointing an existing
        # transfer's other side isn't supported here, same as before (delete
        # and re-add instead). This is what both the web register's category
        # picker and the mobile "Transfer to/from" field submit through — this
        # route never actually read transfer_account_id until now, so picking
        # a transfer target silently saved as a plain edit instead.
        new_transfer_to = p.get("transfer_account_id")

        # An EXISTING transfer: pointing it at another account moves its other side there,
        # and unlink_transfer turns it back into an ordinary transaction (removing the other
        # side). Both also save whatever else came in the same request. (A bare
        # transfer_account_id of null does NOT unlink: that has to be asked for explicitly.)
        if cur["transfer_txn_id"] and (p.get("unlink_transfer") or new_transfer_to):
            version_check, vparams = "", []
            if expected_version is not None:
                version_check, vparams = " AND version=?", [int(expected_version)]
            conflict = (jsonify({"error": "This transaction was changed elsewhere — reload and try again.",
                                 "conflict": True}), 409)
            if p.get("unlink_transfer"):
                result = conn.execute(
                    "UPDATE transactions SET account_id=?, transfer_account_id=NULL, transfer_txn_id=NULL, "
                    "payee=?, category_id=?, memo=?, amount=?, cleared=?, date=?, version=version+1 "
                    "WHERE id=?" + version_check,
                    [f["account_id"], "" if f["payee"].startswith("Transfer : ") else f["payee"],
                     f["category_id"], f["memo"], f["amount"],
                     f["cleared"], f["date"], tid, *vparams])
                if result.rowcount == 0:
                    conn.rollback()
                    return conflict
                conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?",
                             (cur["transfer_txn_id"],))
                conn.execute("DELETE FROM transactions WHERE id=?", (cur["transfer_txn_id"],))
                if "splits" in p:
                    _save_splits(conn, tid, p.get("splits") or [])
                conn.commit()
                new_version = conn.execute("SELECT version FROM transactions WHERE id=?",
                                           (tid,)).fetchone()["version"]
                return jsonify({"ok": True, "version": new_version})
            new_to = int(new_transfer_to)
            if new_to != cur["transfer_account_id"]:
                if not conn.execute("SELECT 1 FROM accounts WHERE id=?", (new_to,)).fetchone():
                    abort(400, "No such account")
                if new_to == f["account_id"]:
                    abort(400, "Can't transfer to the same account.")
                result = conn.execute(
                    "UPDATE transactions SET account_id=?, transfer_account_id=?, date=?, payee=?, memo=?, "
                    "amount=?, cleared=?, version=version+1 WHERE id=?" + version_check,
                    [f["account_id"], new_to, f["date"], "", f["memo"], f["amount"], f["cleared"],
                     tid, *vparams])
                if result.rowcount == 0:
                    conn.rollback()
                    return conflict
                conn.execute(
                    "UPDATE transactions SET account_id=?, transfer_account_id=?, date=?, payee=?, memo=?, "
                    "amount=?, cleared=0, version=version+1 WHERE id=?",   # new account: not on its statement yet
                    (new_to, f["account_id"], f["date"], "", f["memo"], -f["amount"],
                     cur["transfer_txn_id"]))
                conn.commit()
                new_version = conn.execute("SELECT version FROM transactions WHERE id=?",
                                           (tid,)).fetchone()["version"]
                return jsonify({"ok": True, "version": new_version})
            # same account picked again: nothing to move, carry on as a normal edit

        if new_transfer_to and not cur["transfer_txn_id"]:
            new_transfer_to = int(new_transfer_to)
            other = conn.execute("SELECT name FROM accounts WHERE id=?",
                                 (new_transfer_to,)).fetchone()
            if not other:
                abort(400, "No such account")
            if new_transfer_to == f["account_id"]:
                abort(400, "Can't transfer to the same account.")
            version_check = ""
            params = [f["account_id"], f["date"], "", f["memo"],
                      f["amount"], f["cleared"], new_transfer_to, tid]
            if expected_version is not None:
                version_check = " AND version=?"
                params.append(int(expected_version))
            result = conn.execute(
                "UPDATE transactions SET account_id=?, date=?, payee=?, category_id=NULL, memo=?, "
                "amount=?, cleared=?, transfer_account_id=?, version=version+1 "
                "WHERE id=?" + version_check, params)
            if result.rowcount == 0:
                conn.rollback()
                return jsonify({
                    "error": "This transaction was changed elsewhere — reload and try again.",
                    "conflict": True,
                }), 409
            new_version = conn.execute(
                "SELECT version FROM transactions WHERE id=?", (tid,)).fetchone()["version"]
            # A transfer can't also be a split parent.
            conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (tid,))
            cur2 = conn.execute(
                "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
                "transfer_account_id, transfer_txn_id) VALUES (?,?,?,?,?,?,?,?)",
                (new_transfer_to, f["date"], "", f["memo"],
                 -f["amount"], 0, f["account_id"], tid))
            conn.execute("UPDATE transactions SET transfer_txn_id=? WHERE id=?",
                         (cur2.lastrowid, tid))
            conn.commit()
            return jsonify({"ok": True, "version": new_version})

        # Optimistic concurrency: a client editing this row sends back the
        # version it last read. The WHERE clause below makes the write a
        # single atomic compare-and-swap — if someone else's edit already
        # bumped the version, this UPDATE matches zero rows instead of
        # silently clobbering their change, and we report a conflict.
        version_check = ""
        params = [f["account_id"], f["date"], "" if cur["transfer_txn_id"] else f["payee"],
                  f["category_id"] if not cur["transfer_account_id"] else None,
                  f["memo"], f["amount"], f["cleared"], tid]
        if expected_version is not None:
            version_check = " AND version=?"
            params.append(int(expected_version))
        result = conn.execute(
            "UPDATE transactions SET account_id=?, date=?, payee=?, category_id=?, memo=?, "
            "amount=?, cleared=?, version=version+1 WHERE id=?" + version_check,
            params)
        if result.rowcount == 0:
            conn.rollback()
            return jsonify({
                "error": "This transaction was changed elsewhere — reload and try again.",
                "conflict": True,
            }), 409
        new_version = conn.execute(
            "SELECT version FROM transactions WHERE id=?", (tid,)).fetchone()["version"]
        # Keep a transfer's mirror in sync (date, amount, memo, and which account it points at
        # if this side moved) — but NOT its cleared/reconciled status: that belongs to the other
        # account's own statement, so reconciling one side must never reconcile the other.
        if cur["transfer_txn_id"]:
            conn.execute(
                "UPDATE transactions SET date=?, amount=?, memo=?, payee=?, "
                "version=version+1 WHERE id=?",
                (f["date"], -f["amount"], f["memo"], "",
                 cur["transfer_txn_id"]))
            # Make Payment on a transfer pays BOTH sides, from whichever account it's made in: the
            # other side goes uncleared -> cleared. (Only that; an already-reconciled side stays put.)
            if p.get("clear_mirror") and f["cleared"] > 0:
                conn.execute("UPDATE transactions SET cleared=1, version=version+1 WHERE id=? AND cleared=0",
                             (cur["transfer_txn_id"],))
            if moving:
                conn.execute(
                    "UPDATE transactions SET transfer_account_id=? WHERE id=?",
                    (f["account_id"], cur["transfer_txn_id"]))
        # Splits: only touched when the payload includes a "splits" key.
        if "splits" in p and not cur["transfer_txn_id"]:
            _save_splits(conn, tid, p.get("splits") or [])
        conn.commit()
        return jsonify({"ok": True, "version": new_version})
    finally:
        conn.close()


@transactions_bp.route("/api/payees")
@require_auth
def api_payees():
    """Every payee used in any account (most used first), for the register's payee
    dropdown — so a payee typed in one account is suggested in the others too."""
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT payee FROM transactions WHERE payee<>'' AND transfer_txn_id IS NULL "
            "GROUP BY payee ORDER BY COUNT(*) DESC, MAX(date) DESC LIMIT 800").fetchall()
        return jsonify([r["payee"] for r in rows])
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/<int:tid>/splits")
@require_auth
def api_txn_splits(tid):
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT s.id, s.category_id, s.amount, s.memo, c.name AS category_name "
            "FROM transaction_splits s LEFT JOIN categories c ON c.id=s.category_id "
            "WHERE s.transaction_id=? ORDER BY s.id", (tid,)).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/match", methods=["POST"])
@require_auth
def api_match_transactions():
    """Merge an imported transaction into the manually entered one it duplicates.

    The manual entry wins (date, payee, category, memo, amount) — blank payee or
    memo are filled from the bank row, and the higher cleared state is kept. The
    imported row is deleted, but its bank identity is remembered (FITID on the
    kept row, plus its original date/payee/amount in import_signatures) so a
    later import doesn't add it again. The kept row is detached from the import
    batch so "Undo import" can never delete the user's own entry."""
    p = request.json or {}
    try:
        ids = sorted({int(i) for i in (p.get("ids") or [])})
    except (TypeError, ValueError):
        ids = []
    if len(ids) != 2:
        return jsonify({"error": "Select exactly two transactions to match."}), 400

    def refuse(msg, code=400):
        return jsonify({"error": msg}), code

    conn = db.get_db()
    try:
        db.ensure_import_signatures(conn)
        rows = {r["id"]: r for r in conn.execute(
            "SELECT * FROM transactions WHERE id IN (?, ?)", ids)}
        if len(rows) != 2:
            return refuse("One of those transactions no longer exists — reload and try again.", 404)
        a, b = rows[ids[0]], rows[ids[1]]
        if a["account_id"] != b["account_id"]:
            return refuse("Both transactions must be in the same account.")
        bank = {r["id"] for r in conn.execute(
            "SELECT id FROM import_batches WHERE source IN ('csv', 'ofx')")}
        imported = [r for r in (a, b) if r["import_batch_id"] in bank]
        manual = [r for r in (a, b) if r["import_batch_id"] not in bank]
        if not imported:
            return refuse("Neither of these was imported, so there's nothing to match. "
                          "Select one imported transaction and the one you entered by hand.")
        if not manual:
            return refuse("Both of these were imported. Select one imported transaction "
                          "and the one you entered by hand.")
        imp, keep = imported[0], manual[0]
        if imp["amount"] != keep["amount"]:
            return refuse("The amounts differ, so these aren't the same transaction. "
                          "Edit one so they match first.")
        if imp["transfer_txn_id"]:
            return refuse("An imported transaction that's part of a transfer can't be matched.")

        importers.merge_bank_row(conn, keep, dict(imp))
        # Re-point any earlier signature that was attached to the row we're about to delete.
        conn.execute("UPDATE import_signatures SET txn_id=? WHERE txn_id=?", (keep["id"], imp["id"]))
        conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (imp["id"],))
        conn.execute("DELETE FROM transactions WHERE id=?", (imp["id"],))
        conn.commit()
        return jsonify({"ok": True, "id": keep["id"]})
    finally:
        conn.close()


@transactions_bp.route("/api/transactions/<int:tid>", methods=["DELETE"])
@require_auth
def api_delete_transaction(tid):
    conn = db.get_db()
    try:
        cur = conn.execute("SELECT transfer_txn_id FROM transactions WHERE id=?",
                           (tid,)).fetchone()
        if cur and cur["transfer_txn_id"]:
            conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?",
                         (cur["transfer_txn_id"],))
            conn.execute("DELETE FROM transactions WHERE id=?",
                         (cur["transfer_txn_id"],))
        conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (tid,))
        conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
