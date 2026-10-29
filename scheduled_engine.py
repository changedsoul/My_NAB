"""Scheduled (recurring) transactions: due-date math and auto-entry.

An occurrence is materialized into `transactions` (tagged with scheduled_id)
once it's within `due_soon_days` of its due date, dated as that due date, and
left uncleared so the register can show it as Due Soon / Past Due until the
user reconciles it. `next_date` on the schedule then advances to the
following occurrence per its frequency ("Never" means a one-time schedule
that materializes exactly once and is left alone after that).
"""

from datetime import date, timedelta
from calendar import monthrange

# SQL: "t is still unpaid". A transfer is paid once EITHER side is cleared (the two sides each
# keep their own cleared/reconciled status, so one may be cleared while the other isn't yet).
UNPAID_SQL = ("{t}.cleared=0 AND NOT EXISTS (SELECT 1 FROM transactions m "
              "WHERE m.id={t}.transfer_txn_id AND m.cleared<>0)")

FREQUENCIES = [
    "Never", "Daily", "Weekly", "Every 2 Weeks", "Every Month",
    "Every 2 Months", "Every 3 Months", "Every 4 Months", "Twice a Year", "Yearly",
]

_MONTH_STEPS = {
    "Every Month": 1, "Every 2 Months": 2, "Every 3 Months": 3,
    "Every 4 Months": 4, "Twice a Year": 6, "Yearly": 12,
}


def _parse(d):
    y, m, day = (int(x) for x in d.split("-"))
    return date(y, m, day)


def _add_months(d, n):
    idx = (d.year * 12 + (d.month - 1)) + n
    y, m = idx // 12, idx % 12 + 1
    day = min(d.day, monthrange(y, m)[1])   # clamp e.g. Jan 31 + 1mo -> Feb 28/29
    return date(y, m, day)


def advance_date(d, frequency):
    """The next occurrence after date `d` (a date object) for `frequency`, or
    None if it doesn't repeat ("Never")."""
    if frequency == "Never":
        return None
    if frequency == "Daily":
        return d + timedelta(days=1)
    if frequency == "Weekly":
        return d + timedelta(days=7)
    if frequency == "Every 2 Weeks":
        return d + timedelta(days=14)
    step = _MONTH_STEPS.get(frequency)
    if step:
        return _add_months(d, step)
    return None   # unrecognized frequency: treat like "Never" rather than looping forever


def due_soon_days(conn):
    import db
    try:
        return int(db.get_setting(conn, "due_soon_days", "5"))
    except (TypeError, ValueError):
        return 5


def _create_transfer_pair(conn, f, transfer_to, scheduled_id):
    cur1 = conn.execute(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
        "transfer_account_id, scheduled_id, sched_auto, sched_due) VALUES (?,?,?,?,?,0,?,?,1,?)",
        (f["account_id"], f["date"], "", f["memo"],      # no payee on a transfer
         f["amount"], transfer_to, scheduled_id, f["date"]))
    id1 = cur1.lastrowid
    cur2 = conn.execute(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, cleared, "
        "transfer_account_id, transfer_txn_id, scheduled_id, sched_auto, sched_due) VALUES (?,?,?,?,?,0,?,?,?,1,?)",
        (transfer_to, f["date"], "", f["memo"],
         -f["amount"], f["account_id"], id1, scheduled_id, f["date"]))
    conn.execute("UPDATE transactions SET transfer_txn_id=? WHERE id=?", (cur2.lastrowid, id1))
    return id1


def _enter_occurrence(conn, s, due):
    """Put one occurrence of schedule row `s` in the register, due on date `due`. Returns its id (a transfer's
    first side). It carries its due date separately (sched_due), since paying it moves its own date."""
    f = {"account_id": s["account_id"], "date": due.isoformat(),
         "payee": s["payee"], "memo": s["memo"], "amount": s["amount"]}
    if s["transfer_account_id"]:
        return _create_transfer_pair(conn, f, s["transfer_account_id"], s["id"])
    cur = conn.execute(
        "INSERT INTO transactions (account_id, date, payee, category_id, "
        "memo, amount, cleared, scheduled_id, sched_auto, sched_due) VALUES (?,?,?,?,?,?,0,?,1,?)",
        (f["account_id"], f["date"], f["payee"], s["category_id"],
         f["memo"], f["amount"], s["id"], f["date"]))
    return cur.lastrowid


def materialize_due(conn):
    """Auto-enter any scheduled occurrence now within the due-soon window,
    advancing each schedule to its following occurrence. Idempotent — safe to
    call on every read; already-materialized occurrences are skipped."""
    threshold = due_soon_days(conn)
    today = date.today()
    schedules = conn.execute("SELECT * FROM scheduled_transactions").fetchall()
    changed = False   # this runs on every read — only commit if we actually wrote
    for s in schedules:
        next_date = _parse(s["next_date"])
        # Materialize every occurrence that's overdue or within the window —
        # covers the app having been closed through more than one due date.
        while (next_date - today).days <= threshold:
            if s["frequency"] == "Never":
                # A one-time schedule's next_date never advances, so an occurrence
                # that was paid on a different day (its register date edited) must
                # still count as entered, or it would be added again on the old date.
                exists = conn.execute(
                    "SELECT id FROM transactions WHERE scheduled_id=? "
                    "AND ABS(julianday(date) - julianday(?)) <= 7",
                    (s["id"], next_date.isoformat())).fetchone()
            else:
                # By its due date too: a payment made early or late moved the entry's own date.
                exists = conn.execute(
                    "SELECT id FROM transactions WHERE scheduled_id=? AND (date=? OR sched_due=?)",
                    (s["id"], next_date.isoformat(), next_date.isoformat())).fetchone()
            if not exists:
                _enter_occurrence(conn, s, next_date)
                changed = True
            nxt = advance_date(next_date, s["frequency"])
            if nxt is None:
                break   # one-time ("Never") schedule: materialized once, leave next_date as-is
            next_date = nxt
            conn.execute("UPDATE scheduled_transactions SET next_date=? WHERE id=?",
                         (next_date.isoformat(), s["id"]))
            changed = True
    if changed:
        conn.commit()


def oldest_unpaid_id(conn, schedule_id):
    """The register entry of this schedule that most needs paying (the oldest unpaid one), or None."""
    r = conn.execute(
        "SELECT id FROM transactions WHERE scheduled_id=? AND " + UNPAID_SQL.format(t="transactions") +
        " ORDER BY date ASC, id ASC LIMIT 1", (schedule_id,)).fetchone()
    return r["id"] if r else None


def enter_next_occurrence(conn, schedule_id):
    """Enter the schedule's next occurrence now, ahead of the due-soon window (so it can be paid early), and move the
    schedule on to the one after. Returns the new entry's id, or None for a one-time schedule that's already entered."""
    s = conn.execute("SELECT * FROM scheduled_transactions WHERE id=?", (schedule_id,)).fetchone()
    if not s:
        return None
    due = _parse(s["next_date"])
    if s["frequency"] == "Never":
        if conn.execute("SELECT 1 FROM transactions WHERE scheduled_id=?", (schedule_id,)).fetchone():
            return None
        tid = _enter_occurrence(conn, s, due)
    else:
        tid = _enter_occurrence(conn, s, due)
        nxt = advance_date(due, s["frequency"])
        if nxt:
            conn.execute("UPDATE scheduled_transactions SET next_date=? WHERE id=?", (nxt.isoformat(), schedule_id))
    conn.commit()
    return tid


def paid_occurrences(conn, schedule_id):
    """Paid occurrences of a repeating schedule that still belong at the top of the Scheduled page, oldest payment
    first: until their due date arrives (they then simply drop off), and for the rest of the day they were paid on
    (so a bill paid late doesn't vanish the instant it's paid). Each has its own date and amount as paid."""
    today = date.today().isoformat()
    return conn.execute(
        "SELECT t.id, t.date, t.amount, t.memo, t.sched_due, "
        "COALESCE(t.paid_at, (SELECT m.paid_at FROM transactions m WHERE m.id=t.transfer_txn_id), t.created_at) AS paid_at "
        "FROM transactions t WHERE t.scheduled_id=? AND t.sched_auto=1 AND t.sched_due IS NOT NULL "
        "AND (t.transfer_txn_id IS NULL OR t.id < t.transfer_txn_id) "
        "AND NOT (" + UNPAID_SQL.format(t="t") + ") AND (t.sched_due > ? OR t.date >= ?) "
        "ORDER BY paid_at ASC, t.id ASC", (schedule_id, today, today)).fetchall()


def retract_not_yet_due(conn, threshold):
    """Called right after due_soon_days shrinks: an unpaid occurrence that was
    only materialized because the OLD (larger) window covered it, but isn't
    within the due date yet under the new one, gets pulled back out of the
    register — and its schedule's next_date rewound so it materializes again
    once genuinely due. A past-due occurrence is never touched: the window
    only controls how far AHEAD of the due date something gets entered, not
    whether an overdue one stays visible."""
    today = date.today()
    rows = conn.execute(
        "SELECT id, scheduled_id, date, transfer_txn_id FROM transactions "
        "WHERE scheduled_id IS NOT NULL AND " + UNPAID_SQL.format(t="transactions") + " AND sched_auto=1 AND date > ?",
        (today.isoformat(),)).fetchall()
    to_delete = []
    earliest_by_schedule = {}
    for r in rows:
        if (_parse(r["date"]) - today).days <= threshold:
            continue   # still within the new window — leave it materialized
        to_delete.append(r["id"])
        if r["transfer_txn_id"]:
            to_delete.append(r["transfer_txn_id"])
        sid = r["scheduled_id"]
        if sid not in earliest_by_schedule or r["date"] < earliest_by_schedule[sid]:
            earliest_by_schedule[sid] = r["date"]
    for tid in to_delete:
        conn.execute("DELETE FROM transaction_splits WHERE transaction_id=?", (tid,))
        conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
    for sid, earliest in earliest_by_schedule.items():
        conn.execute(
            "UPDATE scheduled_transactions SET next_date=? WHERE id=? AND next_date>?",
            (earliest, sid, earliest))
    conn.commit()


def schedule_status_and_date(conn, schedule_id, stored_next_date, threshold=None, frequency="Never"):
    """(status, display_date) for a schedule's list-page row.

    materialize_due() advances `next_date` to the FOLLOWING occurrence the
    moment it materializes the current one — that's needed internally so it
    knows when to generate the occurrence after next, but it means the raw
    column no longer points at the transaction that's actually due. Both the
    status and the displayed date instead reflect the OLDEST unpaid
    materialized occurrence, so a schedule with several unresolved months
    shows Past Due (not masked by a newer due-soon one) and its Next Date
    stays put — pointing at what still needs to be paid — until the user
    resolves it. Once everything's paid, both fall back to the schedule's own
    stored next_date (the first occurrence not yet due). "paid" is only shown
    from `threshold` days before to `threshold` days after the most recent
    occurrence's date — past that window the next occurrence is still
    genuinely far out."""
    if threshold is None:
        threshold = due_soon_days(conn)
    today = date.today()
    unpaid = conn.execute(
        "SELECT date FROM transactions WHERE scheduled_id=? AND " + UNPAID_SQL.format(t="transactions") +
        " ORDER BY date ASC LIMIT 1", (schedule_id,)).fetchone()
    if unpaid:
        due = _parse(unpaid["date"])
        if due < today:
            status = "past_due"
        elif (due - today).days <= threshold:
            status = "due_soon"
        else:
            status = "scheduled"   # defensive fallback; materialize_due shouldn't leave one this far out
        return status, unpaid["date"]
    if frequency != "Never":
        # A repeating schedule's paid occurrences are listed as rows of their own (paid_occurrences); this row is
        # the next one still to come.
        return "scheduled", stored_next_date
    recent = conn.execute(
        "SELECT date FROM transactions WHERE scheduled_id=? ORDER BY date DESC LIMIT 1",
        (schedule_id,)).fetchone()
    if recent:
        days_since = (today - _parse(recent["date"])).days
        # Negative = paid ahead of its due date (e.g. matched to the bank's
        # payment a few days early); that still counts as Paid.
        if -threshold <= days_since <= threshold:
            return "paid", stored_next_date
    return "scheduled", stored_next_date
