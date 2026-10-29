"""Reports: the numbers behind the Reports page.

Everything here is read-only and works from dates ("from"/"to", inclusive, YYYY-MM-DD). Spending is counted one
way everywhere (see _SPEND_LINES) so the cards, the donut, the trend and the payee list always agree.
"""

from collections import deque
from datetime import date as _date

from flask import Blueprint, abort, jsonify, request

import db
from api.auth import require_auth

reports_bp = Blueprint("reports", __name__)

# One row per place money was spent, on-budget accounts only. `spent` is positive for an outflow and negative for a
# refund, so refunds net against spending. Ordinary categorized transactions, split lines, and outflows with no
# category at all (shown as "Uncategorized") are all included; transfers and income are not.
_SPEND_LINES = (
    "SELECT t.id AS tid, t.date AS date, substr(t.date,1,7) AS month, t.payee AS payee, t.memo AS memo, "
    "       a.name AS account, c.id AS cid, c.name AS category, cg.name AS grp, cg.sort_order AS grp_order, "
    "       -t.amount AS spent "
    "FROM transactions t JOIN categories c ON c.id=t.category_id "
    "JOIN category_groups cg ON cg.id=c.group_id JOIN accounts a ON a.id=t.account_id "
    "WHERE a.on_budget=1 AND c.is_income=0 "
    "UNION ALL "
    "SELECT t.id, t.date, substr(t.date,1,7), t.payee, COALESCE(NULLIF(ts.memo,''), t.memo), a.name, "
    "       c.id, c.name, cg.name, cg.sort_order, -ts.amount "
    "FROM transaction_splits ts JOIN transactions t ON t.id=ts.transaction_id "
    "JOIN categories c ON c.id=ts.category_id "
    "JOIN category_groups cg ON cg.id=c.group_id JOIN accounts a ON a.id=t.account_id "
    "WHERE a.on_budget=1 AND c.is_income=0 "
    "UNION ALL "
    "SELECT t.id, t.date, substr(t.date,1,7), t.payee, t.memo, a.name, 0, 'Uncategorized', 'Uncategorized', 9999, "
    "       -t.amount "
    "FROM transactions t JOIN accounts a ON a.id=t.account_id "
    "WHERE a.on_budget=1 AND t.category_id IS NULL AND t.transfer_account_id IS NULL AND t.amount<0 "
    "AND NOT EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id=t.id)")

_INCOME_LINES = (
    "SELECT substr(t.date,1,7) AS month, t.date AS date, t.amount AS amount "
    "FROM transactions t JOIN categories c ON c.id=t.category_id JOIN accounts a ON a.id=t.account_id "
    "WHERE a.on_budget=1 AND c.is_income=1")


def _dates():
    frm = request.args.get("from", "0000-00-00")
    to = request.args.get("to", "9999-99-99")
    return frm, to


def _months_between(frm, to):
    """['YYYY-MM', ...] from the month of `frm` to the month of `to`, inclusive (at most 120)."""
    try:
        y, m = int(frm[:4]), int(frm[5:7])
        ey, em = int(to[:4]), int(to[5:7])
    except ValueError:
        abort(400, "valid from/to dates required")
    out = []
    while (y, m) <= (ey, em) and len(out) < 120:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


@reports_bp.route("/api/reports/summary")
@require_auth
def api_report_summary():
    """Income and spending over a date range (the overview cards)."""
    frm, to = _dates()
    conn = db.get_db()
    try:
        spending = conn.execute(
            "SELECT COALESCE(SUM(spent),0) FROM (" + _SPEND_LINES + ") WHERE date>=? AND date<=?",
            (frm, to)).fetchone()[0]
        income = conn.execute(
            "SELECT COALESCE(SUM(amount),0) FROM (" + _INCOME_LINES + ") WHERE date>=? AND date<=?",
            (frm, to)).fetchone()[0]
        return jsonify({"income": income, "spending": spending})
    finally:
        conn.close()


@reports_bp.route("/api/reports/spending")
@require_auth
def api_report_spending():
    """Spending per category, biggest first (the donut)."""
    frm, to = _dates()
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT cid, category AS name, grp AS group_name, SUM(spent) AS spent FROM (" + _SPEND_LINES + ") "
            "WHERE date>=? AND date<=? GROUP BY cid HAVING SUM(spent) > 0 ORDER BY spent DESC",
            (frm, to)).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@reports_bp.route("/api/reports/category_transactions")
@require_auth
def api_report_category_transactions():
    """The individual purchases behind one slice of the donut (cid 0 = uncategorized)."""
    frm, to = _dates()
    try:
        cid = int(request.args.get("category_id", ""))
    except ValueError:
        abort(400, "category_id required")
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT tid, date, payee, memo, account, spent FROM (" + _SPEND_LINES + ") "
            "WHERE cid=? AND date>=? AND date<=? ORDER BY date DESC, tid DESC LIMIT 500",
            (cid, frm, to)).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@reports_bp.route("/api/reports/payees")
@require_auth
def api_report_payees():
    """Where the money went: total spent per payee, biggest first."""
    frm, to = _dates()
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT TRIM(payee) AS payee, SUM(spent) AS spent, COUNT(*) AS count FROM (" + _SPEND_LINES + ") "
            "WHERE date>=? AND date<=? AND TRIM(COALESCE(payee,''))<>'' "
            "GROUP BY TRIM(payee) HAVING SUM(spent) > 0 ORDER BY spent DESC LIMIT 15",
            (frm, to)).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@reports_bp.route("/api/reports/cashflow")
@require_auth
def api_report_cashflow():
    """Income and spending for every month in the range (zero where there was none)."""
    frm, to = _dates()
    months = _months_between(frm, to)
    conn = db.get_db()
    try:
        inc = {r["month"]: r["v"] for r in conn.execute(
            "SELECT month, SUM(amount) AS v FROM (" + _INCOME_LINES + ") WHERE month>=? AND month<=? GROUP BY month",
            (months[0], months[-1]))}
        spent = {r["month"]: r["v"] for r in conn.execute(
            "SELECT month, SUM(spent) AS v FROM (" + _SPEND_LINES + ") WHERE month>=? AND month<=? GROUP BY month",
            (months[0], months[-1]))}
        return jsonify([{"month": m, "income": inc.get(m, 0), "spending": spent.get(m, 0)} for m in months])
    finally:
        conn.close()


@reports_bp.route("/api/reports/spending_trend")
@require_auth
def api_report_spending_trend():
    """Spending per category for every month in the range, for the trend lines."""
    frm, to = _dates()
    months = _months_between(frm, to)
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT cid, category, grp, month, SUM(spent) AS spent FROM (" + _SPEND_LINES + ") "
            "WHERE month>=? AND month<=? GROUP BY cid, month", (months[0], months[-1])).fetchall()
        series = {}
        for r in rows:
            s = series.setdefault(r["cid"], {"id": r["cid"], "name": r["category"], "group": r["grp"],
                                             "values": [0] * len(months), "total": 0})
            s["values"][months.index(r["month"])] = max(0, r["spent"])
            s["total"] += r["spent"]
        ordered = sorted((s for s in series.values() if s["total"] > 0), key=lambda s: -s["total"])
        return jsonify({"months": months, "series": ordered})
    finally:
        conn.close()


@reports_bp.route("/api/reports/net_worth")
@require_auth
def api_report_net_worth():
    """Month-end balances from the first transaction until now: what you own, what you owe, and the difference.

    Each account is counted on its own, so a credit card with a balance owed adds to "owed" while a
    checking account adds to "own". Every account counts, on budget or not.
    """
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT account_id, substr(date,1,7) AS month, SUM(amount) AS delta "
            "FROM transactions GROUP BY account_id, month ORDER BY month").fetchall()
        if not rows:
            return jsonify([])
        by_month = {}
        for r in rows:
            by_month.setdefault(r["month"], {})[r["account_id"]] = r["delta"]
        last = _date.today().strftime("%Y-%m")
        months = _months_between(rows[0]["month"] + "-01", max(last, rows[-1]["month"]) + "-01")
        balances, out = {}, []
        for m in months:
            for acct, delta in by_month.get(m, {}).items():
                balances[acct] = balances.get(acct, 0) + delta
            assets = sum(b for b in balances.values() if b > 0)
            debts = -sum(b for b in balances.values() if b < 0)
            out.append({"month": m, "assets": assets, "debts": debts, "net": assets - debts})
        return jsonify(out)
    finally:
        conn.close()


@reports_bp.route("/api/reports/age_of_money")
@require_auth
def api_report_age_of_money():
    """FIFO estimate: how old (in days) is the money you're spending."""
    conn = db.get_db()
    try:
        rows = conn.execute(
            "SELECT t.date, t.amount FROM transactions t "
            "JOIN accounts a ON a.id=t.account_id "
            "WHERE a.on_budget=1 AND t.transfer_account_id IS NULL "
            "ORDER BY t.date, t.id").fetchall()

        def d(s):
            return _date(int(s[:4]), int(s[5:7]), int(s[8:10]))
        # deque, not a list: lots are consumed from the front (FIFO), and
        # list.pop(0) is O(n) — on a long history that turns this into O(n^2).
        queue = deque()  # [date, remaining_cents] lots, oldest first
        ages = []   # (spend_date, age_days) for outflows
        for r in rows:
            amt = r["amount"]
            if amt > 0:
                queue.append([d(r["date"]), amt])
            elif amt < 0:
                need = -amt
                spend_day = d(r["date"])
                weighted, consumed = 0, 0
                while need > 0 and queue:
                    lot = queue[0]
                    take = min(need, lot[1])
                    weighted += (spend_day - lot[0]).days * take
                    consumed += take
                    lot[1] -= take
                    need -= take
                    if lot[1] == 0:
                        queue.popleft()
                if consumed > 0:
                    ages.append(weighted / consumed)
        recent = ages[-10:]
        aom = round(sum(recent) / len(recent)) if recent else 0
        return jsonify({"age_of_money": aom})
    finally:
        conn.close()
