"""Accounts: CRUD. A credit account is just an on-budget account like any
other — its charges are categorized directly and a payment is a transfer,
same as paying any other bill. No special linked category or budget-engine
handling."""

from flask import Blueprint, jsonify, request, abort

import db
from api.auth import require_auth
from api.common import next_sort, account_balance

accounts_bp = Blueprint("accounts", __name__)


@accounts_bp.route("/api/accounts")
@require_auth
def api_accounts():
    conn = db.get_db()
    try:
        out = []
        for a in conn.execute(
                "SELECT * FROM accounts ORDER BY closed, sort_order, name"):
            bal, cleared = account_balance(conn, a["id"])
            d = dict(a)
            d["balance"] = bal
            d["cleared_balance"] = cleared
            d["review_count"] = conn.execute(
                "SELECT COUNT(*) FROM transactions WHERE account_id=? AND import_review=1", (a["id"],)).fetchone()[0]
            out.append(d)
        return jsonify(out)
    finally:
        conn.close()


@accounts_bp.route("/api/accounts", methods=["POST"])
@require_auth
def api_create_account():
    p = request.json or {}
    name = (p.get("name") or "").strip()
    if not name:
        abort(400, "Name required")
    acct_type = p.get("type", "checking")
    on_budget = 0 if acct_type in ("asset", "liability") else int(p.get("on_budget", 1))
    conn = db.get_db()
    try:
        so = next_sort(conn, "accounts")
        cur = conn.execute(
            "INSERT INTO accounts (name, type, on_budget, sort_order) "
            "VALUES (?, ?, ?, ?)", (name, acct_type, on_budget, so))
        acct_id = cur.lastrowid
        # Optional opening balance as a starting transaction.
        ob = int(p.get("opening_balance", 0) or 0)
        if ob:
            inc = db.income_category_id(conn) if ob > 0 and on_budget else None
            conn.execute(
                "INSERT INTO transactions (account_id, date, payee, category_id, "
                "amount, cleared) VALUES (?, date('now'), 'Starting Balance', ?, ?, 1)",
                (acct_id, inc, ob))
        conn.commit()
        return jsonify({"id": acct_id})
    finally:
        conn.close()


@accounts_bp.route("/api/accounts/<int:aid>", methods=["PUT"])
@require_auth
def api_update_account(aid):
    p = request.json or {}
    conn = db.get_db()
    try:
        cur = conn.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        if not cur:
            abort(404)
        name = (p.get("name") or cur["name"]).strip()
        acct_type = p.get("type", cur["type"])
        # Tracking types (asset/liability) are always off-budget — they
        # represent net-worth items, not budgetable money.
        on_budget = 0 if acct_type in ("asset", "liability") \
            else int(p.get("on_budget", cur["on_budget"]))
        closed = int(p.get("closed", cur["closed"]))
        conn.execute(
            "UPDATE accounts SET name=?, type=?, on_budget=?, closed=? WHERE id=?",
            (name, acct_type, on_budget, closed, aid))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@accounts_bp.route("/api/accounts/<int:aid>", methods=["DELETE"])
@require_auth
def api_delete_account(aid):
    conn = db.get_db()
    try:
        # Order matters: foreign_keys is ON, so a transaction can't be deleted
        # while a transaction_splits row still references it, and an account
        # can't be deleted while a scheduled_transactions row still points at
        # it. Clear the dependents first, innermost-out.
        conn.execute(
            "DELETE FROM transaction_splits WHERE transaction_id IN "
            "(SELECT id FROM transactions WHERE account_id=?)", (aid,))
        conn.execute("DELETE FROM transactions WHERE account_id=?", (aid,))
        # Transfers whose *other* side lived here: detach them (they stay as
        # ordinary transactions in their own account) rather than deleting them.
        conn.execute("UPDATE transactions SET transfer_account_id=NULL, "
                     "transfer_txn_id=NULL WHERE transfer_account_id=?", (aid,))
        # Scheduled transactions reference accounts via a real FK — drop the
        # ones tied to this account outright, and detach any transfer schedule
        # whose target was this account (so it doesn't FK-fail the delete).
        conn.execute("DELETE FROM scheduled_transactions WHERE account_id=?", (aid,))
        conn.execute("UPDATE scheduled_transactions SET transfer_account_id=NULL "
                     "WHERE transfer_account_id=?", (aid,))
        db.ensure_account_links(conn)
        conn.execute("DELETE FROM account_links WHERE account_id=?", (aid,))
        conn.execute("DELETE FROM accounts WHERE id=?", (aid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
