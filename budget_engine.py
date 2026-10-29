"""Zero-based envelope budgeting engine (classic envelope style).

Core rules implemented:
  1. Give every dollar a job -> "To be Budgeted" (TBB) shows unassigned money.
  2. Rollover -> a category's positive Available balance carries into next month.
  3. Roll with the punches -> a category overspent with cash resets to 0 at
     month end and the shortfall is subtracted from next month's TBB.

Credit card accounts are budgeted exactly like any other on-budget account:
a charge is categorized like any purchase and counts as that category's
activity; paying the card is an ordinary transfer between accounts, which
(like any transfer) doesn't touch any category. There's no separate
"payment" tracking — the card's own account balance is the record of what's
owed, same as the user already treats every other account.

Everything is computed on the fly by walking months in order from the first
month that has any data up to the requested month. Personal-scale data makes
this plenty fast and keeps stored state minimal (only budgeted amounts).
"""

from collections import defaultdict


def _month_add(month, delta):
    y, m = int(month[:4]), int(month[5:7])
    idx = (y * 12 + (m - 1)) + delta
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def _all_months(start, end):
    months = []
    cur = start
    while cur <= end:
        months.append(cur)
        cur = _month_add(cur, 1)
    return months


def _load(conn):
    """Load the static structures the engine needs, once per computation."""
    groups = {g["id"]: dict(g) for g in conn.execute(
        "SELECT * FROM category_groups").fetchall()}
    cats = {c["id"]: dict(c) for c in conn.execute(
        "SELECT * FROM categories").fetchall()}
    accounts = {a["id"]: dict(a) for a in conn.execute(
        "SELECT * FROM accounts").fetchall()}
    return groups, cats, accounts


def _income_cat_ids(cats):
    return {cid for cid, c in cats.items() if c["is_income"]}


def _income_next_ids(cats):
    """Income categories whose money is held for *next* month's budget."""
    return {cid for cid, c in cats.items()
            if c["is_income"] and c["income_next_month"]}


def _earliest_month(conn):
    row = conn.execute(
        "SELECT MIN(substr(date,1,7)) AS m FROM transactions").fetchone()
    txn_min = row["m"] if row and row["m"] else None
    row = conn.execute("SELECT MIN(month) AS m FROM budgets").fetchone()
    bud_min = row["m"] if row and row["m"] else None
    candidates = [x for x in (txn_min, bud_min) if x]
    return min(candidates) if candidates else None


def compute(conn, target_month):
    """Return the full budget picture for a single month (see compute_range)."""
    return compute_range(conn, [target_month])[target_month]


FILL_MODES = {"zero", "copy_last", "avg3", "avg6", "avg12",
              "spent3", "spent6", "spent12"}


def fill_month(conn, month, mode, category_id=None):
    """Bulk-populate every category's Budgeted amount for `month` (or just one
    category's, when `category_id` is given): zero it out, copy the prior month's
    budgeted amount, average the BUDGETED amount over the preceding 3/6/12 months
    ("avgN"; a month with no budgets row counts as 0, same as "Copy Last Month"),
    or set it to the average amount actually SPENT over the preceding 3/6/12 months
    ("spentN"; refunds net against spending, and a month in net credit counts as 0)."""
    if mode not in FILL_MODES:
        raise ValueError(f"unknown fill mode: {mode}")
    cat_ids = [r["id"] for r in conn.execute(
        "SELECT id FROM categories WHERE hidden=0 AND is_income=0").fetchall()]
    if category_id is not None:
        if int(category_id) not in cat_ids:
            raise ValueError("that category can't be budgeted")
        cat_ids = [int(category_id)]

    if mode.startswith("spent"):
        lookback = [_month_add(month, -i) for i in range(1, int(mode[5:]) + 1)]
        spent = defaultdict(int)             # category -> total net spending over the window
        for m, shaped in compute_range(conn, lookback).items():
            for g in shaped["groups"]:
                for c in g["categories"]:
                    spent[c["id"]] += -c["activity"]
        for cid in cat_ids:
            # a month in net credit would pull the average below zero: floor each category at 0
            budgeted = max(0, round(spent.get(cid, 0) / len(lookback)))
            conn.execute(
                "INSERT INTO budgets (month, category_id, budgeted) VALUES (?, ?, ?) "
                "ON CONFLICT(month, category_id) DO UPDATE SET budgeted=excluded.budgeted",
                (month, cid, budgeted))
    elif mode == "zero":
        for cid in cat_ids:
            conn.execute(
                "INSERT INTO budgets (month, category_id, budgeted) VALUES (?, ?, 0) "
                "ON CONFLICT(month, category_id) DO UPDATE SET budgeted=0",
                (month, cid))
    else:
        lookback = [_month_add(month, -1)] if mode == "copy_last" \
            else [_month_add(month, -i) for i in range(1, int(mode[3:]) + 1)]
        placeholders = ",".join("?" * len(lookback))
        by_cat = defaultdict(dict)
        for r in conn.execute(
                f"SELECT category_id, month, budgeted FROM budgets "
                f"WHERE month IN ({placeholders})", lookback).fetchall():
            by_cat[r["category_id"]][r["month"]] = r["budgeted"]
        for cid in cat_ids:
            vals = [by_cat.get(cid, {}).get(m, 0) for m in lookback]
            budgeted = round(sum(vals) / len(lookback))
            conn.execute(
                "INSERT INTO budgets (month, category_id, budgeted) VALUES (?, ?, ?) "
                "ON CONFLICT(month, category_id) DO UPDATE SET budgeted=excluded.budgeted",
                (month, cid, budgeted))
    conn.commit()


def compute_range(conn, month_list):
    """Compute the budget picture for several months in one pass.

    Returns {month: shaped_output}. The engine walks every month from the first
    with data up to the latest requested month, carrying balances forward, and
    snapshots each requested month along the way.

    Returns a dict with per-category rows (budgeted / activity / available),
    grouped output, and the month summary (to_be_budgeted, income, etc.).
    """
    groups, cats, accounts = _load(conn)
    income_ids = _income_cat_ids(cats)
    income_next = _income_next_ids(cats)

    requested = set(month_list)
    target_month = max(month_list)
    start = _earliest_month(conn)
    lo = min(month_list)
    if start is None or lo < start:
        start = lo
    months = _all_months(start, target_month)

    def income_month(month, cid):
        # Income tagged "for next month" is available one month later.
        return _month_add(month, 1) if cid in income_next else month

    # --- Pre-aggregate transaction activity per (month, category) --------------
    # Normal category activity: sum(amount) for on-budget accounts.
    normal_activity = defaultdict(int)          # (month, cat_id) -> cents
    income_by_month = defaultdict(int)          # month -> cents (available to budget)
    for_next_by_month = defaultdict(int)        # source month -> income set aside

    def add_income(source_month, cid, amt):
        income_by_month[income_month(source_month, cid)] += amt
        if cid in income_next:
            for_next_by_month[source_month] += amt

    rows = conn.execute(
        "SELECT t.date, t.amount, t.category_id, t.account_id, a.on_budget "
        "FROM transactions t JOIN accounts a ON a.id = t.account_id"
    ).fetchall()

    for t in rows:
        month = t["date"][:7]
        acct = accounts.get(t["account_id"])
        if acct is None or not acct["on_budget"]:
            continue
        cid = t["category_id"]

        # Every on-budget account type (checking, savings, cash, credit,
        # ...) is treated the same: a categorized transaction counts as that
        # category's activity. Transfers (category_id NULL) never touch the
        # budget, whichever accounts they move money between.
        if cid in income_ids:
            add_income(month, cid, t["amount"])
        elif cid is not None:
            normal_activity[(month, cid)] += t["amount"]

    # --- Split transactions: distribute each split line to its category --------
    # A split parent has category_id NULL, so it added nothing above. Here we
    # credit each split line to its own spending/income category.
    split_rows = conn.execute(
        "SELECT ts.category_id, ts.amount, t.date, t.account_id "
        "FROM transaction_splits ts JOIN transactions t ON t.id = ts.transaction_id"
    ).fetchall()
    for s in split_rows:
        acct = accounts.get(s["account_id"])
        if acct is None or not acct["on_budget"]:
            continue
        month = s["date"][:7]
        cid = s["category_id"]
        if cid in income_ids:
            add_income(month, cid, s["amount"])
        elif cid is not None:
            normal_activity[(month, cid)] += s["amount"]

    # --- Walk months, carrying category Available balances forward ------------
    normal_cat_ids = [cid for cid, c in cats.items() if not c["is_income"]]

    # Categories the user has opted to carry forward: each stored row is a
    # toggle EVENT ("starting this month, carry (1) or stop (0)"), not a
    # per-month flag — whichever state was last set stays in effect for every
    # following month until the next event, so turning it on in March keeps
    # carrying March, April, May... until turned off in some later month.
    carry_events = defaultdict(dict)   # cat_id -> {month: bool}
    for r in conn.execute(
            "SELECT month, category_id, carry FROM carryover").fetchall():
        carry_events[r["category_id"]][r["month"]] = bool(r["carry"])

    # Prime each category's running state from the latest event strictly
    # before the walk's starting month; events at/after `start` are applied
    # as the walk reaches them below.
    carry_state = defaultdict(bool)   # cat_id -> current on/off state
    for cid, events in carry_events.items():
        prior = [m for m in events if m < start]
        if prior:
            carry_state[cid] = events[max(prior)]

    avail = defaultdict(int)      # cat_id -> carried Available balance
    tbb = 0                       # carried "to be budgeted"
    snapshots = {}                # month -> raw month_result for requested months

    for month in months:
        budget_rows = {r["category_id"]: r["budgeted"] for r in conn.execute(
            "SELECT category_id, budgeted FROM budgets WHERE month = ?",
            (month,)).fetchall()}

        income = income_by_month.get(month, 0)
        budgeted_total = 0
        result_cats = {}
        for cid, events in carry_events.items():
            if month in events:
                carry_state[cid] = events[month]
        carry_now = {cid for cid, on in carry_state.items() if on}

        # Normal categories: budgeted + activity + carried available.
        for cid in normal_cat_ids:
            budgeted = budget_rows.get(cid, 0)
            activity = normal_activity.get((month, cid), 0)
            available = avail[cid] + budgeted + activity
            budgeted_total += budgeted
            result_cats[cid] = {
                "budgeted": budgeted, "activity": activity, "available": available,
                "carry": cid in carry_now,
            }

        # Overspending on normal categories (cash) reduces next month's TBB and
        # the category resets to 0 — unless the user opted to carry that category
        # forward, in which case its negative rides into next month instead.
        overspent = 0
        for cid in normal_cat_ids:
            a = result_cats[cid]["available"]
            if a < 0 and cid not in carry_now:
                overspent += a  # negative

        # This month's To be Budgeted. `carried_in` is what rolled over from the
        # previous month before this month's income/budgeting is applied.
        carried_in = tbb
        tbb = tbb + income - budgeted_total + overspent
        # (overspent from *this* month is applied here as the classic rule folds
        #  it into the running figure; it then resets below for next month.)

        if month in requested:
            snapshots[month] = {
                "month": month,
                "income": income,
                "carried_in": carried_in,
                "overspent": overspent,
                "for_next_month": for_next_by_month.get(month, 0),
                "budgeted": budgeted_total,
                "activity": sum(c["activity"] for c in result_cats.values()),
                "to_be_budgeted": tbb,
                "categories": result_cats,
            }

        # Carry forward for next month: positive available always rolls over; a
        # negative rolls over only if the category is marked to carry (otherwise
        # it resets to 0, its overspend already counted in TBB).
        for cid in normal_cat_ids:
            a = result_cats[cid]["available"]
            avail[cid] = a if (a > 0 or cid in carry_now) else 0

    return {m: _shape_output(conn, groups, cats, accounts, snapshots[m])
            for m in month_list if m in snapshots}


def _shape_output(conn, groups, cats, accounts, month_result):
    """Turn the raw computation into grouped, display-ready JSON."""
    grouped = []
    for g in sorted(groups.values(), key=lambda x: (x["sort_order"], x["name"])):
        if g["is_income"]:
            continue  # income group isn't shown as budget rows
        gcats = [c for c in cats.values()
                 if c["group_id"] == g["id"] and not c["hidden"]]
        gcats.sort(key=lambda x: (x["sort_order"], x["name"]))
        cat_rows = []
        gb = ga = gav = 0
        for c in gcats:
            m = month_result["categories"].get(
                c["id"], {"budgeted": 0, "activity": 0, "available": 0})
            gb += m["budgeted"]; ga += m["activity"]; gav += m["available"]
            cat_rows.append({
                "id": c["id"], "name": c["name"],
                "budgeted": m["budgeted"], "activity": m["activity"],
                "available": m["available"], "carry": m.get("carry", False),
            })
        if not cat_rows:
            continue
        grouped.append({
            "id": g["id"], "name": g["name"],
            "budgeted": gb, "activity": ga, "available": gav,
            "categories": cat_rows,
        })

    return {
        "month": month_result["month"],
        "to_be_budgeted": month_result["to_be_budgeted"],
        "income": month_result["income"],
        "carried_in": month_result.get("carried_in", 0),
        "overspent": month_result.get("overspent", 0),
        "for_next_month": month_result.get("for_next_month", 0),
        "budgeted": month_result["budgeted"],
        "activity": month_result["activity"],
        "groups": grouped,
    }
