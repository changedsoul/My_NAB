"""Budget: read a month's computed envelope state and set budgeted amounts."""

import re

from flask import Blueprint, jsonify, request, abort

import db
import budget_engine
import scheduled_engine
from api.auth import require_auth

budget_bp = Blueprint("budget", __name__)

_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def _month_or_400(month):
    """Reject anything that isn't a 'YYYY-MM' string before it reaches the
    engine's date math (which would otherwise raise and 500 on junk input)."""
    if not month or not _MONTH_RE.match(month):
        abort(400, "valid month (YYYY-MM) required")
    return month


@budget_bp.route("/api/budget")
@require_auth
def api_budget():
    month = _month_or_400(request.args.get("month"))
    conn = db.get_db()
    try:
        scheduled_engine.materialize_due(conn)
        return jsonify(budget_engine.compute(conn, month))
    finally:
        conn.close()


@budget_bp.route("/api/budget/range")
@require_auth
def api_budget_range():
    """Several months at once for the side-by-side web view.

    Query: ?months=YYYY-MM,YYYY-MM,...  ->  list of per-month budget pictures,
    in the same order as requested.
    """
    months = [m.strip() for m in request.args.get("months", "").split(",") if m.strip()]
    if not months:
        abort(400, "months required")
    for m in months:
        _month_or_400(m)
    conn = db.get_db()
    try:
        scheduled_engine.materialize_due(conn)
        res = budget_engine.compute_range(conn, months)
        return jsonify([res[m] for m in months if m in res])
    finally:
        conn.close()


def _income_txn_query(conn, pairs):
    """Fetch transactions for a list of (category_id, month) pairs, each
    expanded to that whole calendar month, deduped and newest first."""
    rows, seen = [], set()
    for cid, month in pairs:
        if not cid or not month:
            continue
        for r in conn.execute(
                "SELECT t.*, c.name AS category_name, a.name AS account_name "
                "FROM transactions t JOIN accounts a ON a.id=t.account_id "
                "LEFT JOIN categories c ON c.id=t.category_id "
                "WHERE t.category_id=? AND substr(t.date,1,7)=? AND a.on_budget=1",
                (cid, month)).fetchall():
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            rows.append(dict(r))
    rows.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    return rows


@budget_bp.route("/api/budget/income-transactions")
@require_auth
def api_income_transactions():
    """The transactions behind the budget card's "Income for {month}" /
    "Income held for {month}" lines — spans whichever accounts they're
    actually in. "for" straddles two calendar months because money tagged
    "hold for next month" shifts forward a month in the engine (see
    budget_engine.income_month); "held" is this month's hold-for-next-month
    transactions themselves, not yet shifted.
    """
    month = _month_or_400(request.args.get("month"))
    kind = request.args.get("kind")
    if kind not in ("for", "held"):
        abort(400, "kind (for|held) required")
    conn = db.get_db()
    try:
        this_id = db.income_category_id(conn)
        next_row = conn.execute(
            "SELECT id FROM categories WHERE is_income=1 AND income_next_month=1"
        ).fetchone()
        next_id = next_row["id"] if next_row else None
        if kind == "held":
            pairs = [(next_id, month)]
        else:
            prev_month = budget_engine._month_add(month, -1)
            pairs = [(this_id, month), (next_id, prev_month)]
        rows = _income_txn_query(conn, pairs)
        return jsonify({"month": month, "kind": kind, "transactions": rows})
    finally:
        conn.close()


@budget_bp.route("/api/budget/carryover", methods=["POST"])
@require_auth
def api_set_carryover():
    """Toggle whether a category carries its month-end balance forward.

    This records a toggle EVENT, not a one-month flag: turning it on in
    March carries March, April, May... forward indefinitely until the user
    turns it off in some later month (see budget_engine.compute_range).

    Body: {month, category_id, carry: bool}
    """
    p = request.json or {}
    cid = p.get("category_id")
    if not cid:
        abort(400, "category_id required")
    month = _month_or_400(p.get("month"))
    conn = db.get_db()
    try:
        conn.execute(
            "INSERT INTO carryover (month, category_id, carry) VALUES (?, ?, ?) "
            "ON CONFLICT(month, category_id) DO UPDATE SET carry=excluded.carry",
            (month, cid, 1 if p.get("carry") else 0))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@budget_bp.route("/api/budget/fill", methods=["POST"])
@require_auth
def api_budget_fill():
    """Bulk-populate every category's Budgeted amount for a month.

    Body: {month, mode, category_id?} — mode is one of budget_engine.FILL_MODES
    ("zero", "copy_last", "avg3"/"avg6"/"avg12" = average budgeted,
    "spent3"/"spent6"/"spent12" = average spent). With category_id only that
    category is set; otherwise every category is.
    """
    p = request.json or {}
    mode = p.get("mode")
    if mode not in budget_engine.FILL_MODES:
        abort(400, "a valid mode required")
    month = _month_or_400(p.get("month"))
    conn = db.get_db()
    try:
        try:
            budget_engine.fill_month(conn, month, mode, p.get("category_id"))
        except (ValueError, TypeError) as e:
            abort(400, str(e))
        return jsonify(budget_engine.compute(conn, month))
    finally:
        conn.close()


@budget_bp.route("/api/budget", methods=["POST"])
@require_auth
def api_set_budget():
    p = request.json or {}
    cid = p.get("category_id")
    if not cid:
        abort(400, "category_id required")
    month = _month_or_400(p.get("month"))
    try:
        budgeted = int(round(float(p.get("budgeted", 0))))
    except (TypeError, ValueError):
        abort(400, "budgeted must be a number")
    conn = db.get_db()
    try:
        conn.execute(
            "INSERT INTO budgets (month, category_id, budgeted) VALUES (?, ?, ?) "
            "ON CONFLICT(month, category_id) DO UPDATE SET budgeted=excluded.budgeted",
            (month, cid, budgeted))
        conn.commit()
        return jsonify(budget_engine.compute(conn, month))
    finally:
        conn.close()
