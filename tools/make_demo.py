#!/usr/bin/env python3
"""Build a demo budget to try My NAB with (no real data).

    python3 tools/make_demo.py                 # writes ./demo-data  (password: demo1234)
    python3 tools/make_demo.py --out /tmp/demo --force

Then run the app on it:

    NAB_DB_PATH=./demo-data/nab.db .venv/bin/python app.py     # http://localhost:8000

What you get: four accounts (Checking, Savings, a Visa credit card and a Cash wallet), six months of
dated transactions in each, transfers between them (savings contributions, ATM withdrawals, monthly
card payments), a generic zero-based budget, paychecks deposited into checking and *held for next
month* (so each month is budgeted from last month's pay), a month that is overspent, and a few
scheduled bills. Everything is generated through the app's own API, so it behaves like real data,
and dates are relative to today so the demo always looks current.
"""
import argparse
import os
import random
import shutil
import sys
from datetime import date

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the project folder


def month_add(y, m, d):
    i = y * 12 + (m - 1) + d
    return i // 12, i % 12 + 1


def main():
    ap = argparse.ArgumentParser(description="Create a demo My NAB budget.")
    ap.add_argument("--out", default=os.path.join(HERE, "demo-data"), help="folder to create (default ./demo-data)")
    ap.add_argument("--password", default="demo1234", help="password for the demo budget")
    ap.add_argument("--force", action="store_true", help="replace the folder if it already exists")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    if os.path.isdir(out) and os.listdir(out):
        if not args.force:
            sys.exit(f"{out} is not empty. Use --force to replace what is in it.")
        for name in os.listdir(out):      # empty it rather than delete it (it may be a Docker volume mount)
            path = os.path.join(out, name)
            shutil.rmtree(path) if os.path.isdir(path) and not os.path.islink(path) else os.remove(path)
    os.makedirs(out, exist_ok=True)
    os.environ["NAB_DB_PATH"] = os.path.join(out, "nab.db")
    sys.path.insert(0, HERE)
    import app as nab   # noqa: E402  (must come after NAB_DB_PATH is set)

    c = nab.app.test_client()

    def call(method, path, data=None):
        r = getattr(c, method)(path, json=data)
        if r.status_code >= 300:
            sys.exit(f"{method.upper()} {path} failed: {r.status_code} {r.get_data(as_text=True)[:200]}")
        return r.get_json()

    rng = random.Random(2024)   # same demo every time (apart from the dates)
    today = date.today()

    # --- the budget itself ----------------------------------------------------------------
    # A fresh install already has one empty, password-less budget; use it (renamed) instead of adding a second.
    fresh = [b for b in call("get", "/api/budgets") if b["needs_setup"]]
    bid = fresh[0]["id"] if fresh else call("post", "/api/budgets", {"name": "Demo Budget"})["id"]
    call("put", f"/api/budgets/{bid}", {"name": "Demo Budget"})
    call("post", f"/api/budgets/{bid}/setup", {"password": args.password})

    # --- accounts -------------------------------------------------------------------------
    def account(name, kind):
        return call("post", "/api/accounts", {"name": name, "type": kind, "on_budget": 1})["id"]
    chk = account("Checking", "checking")
    sav = account("Savings", "savings")
    visa = account("Visa Card", "credit")
    cash = account("Cash", "cash")

    # --- categories -----------------------------------------------------------------------
    # (group, [(category, usual monthly budget in dollars)])
    PLAN = [
        ("Fixed Bills", [("Rent", 1450), ("Electric", 135), ("Water & Sewer", 55), ("Internet", 70),
                         ("Phone", 85), ("Car Insurance", 120)]),
        ("Everyday", [("Groceries", 560), ("Fuel", 180), ("Dining Out", 180), ("Household", 75),
                      ("Personal Care", 70)]),
        ("Fun & Extras", [("Entertainment", 110), ("Subscriptions", 30), ("Clothing", 80)]),
        ("Savings Goals", [("Emergency Fund", 600), ("Vacation", 250), ("Car Repairs", 100)]),
    ]
    cat = {}
    budget_plan = {}
    for gname, items in PLAN:
        gid = call("post", "/api/groups", {"name": gname})["id"]
        for name, dollars in items:
            cat[name] = call("post", "/api/categories", {"name": name, "group_id": gid})["id"]
            budget_plan[name] = dollars * 100
    for g in call("get", "/api/categories"):
        for ic in g.get("categories", []):
            if g.get("is_income"):
                cat["Income for Next Month" if ic.get("income_next_month") else "Income for This Month"] = ic["id"]

    # --- transactions ---------------------------------------------------------------------
    months = [month_add(today.year, today.month, -k) for k in range(5, -1, -1)]   # oldest .. this month
    visa_total = {}      # month index -> charges that month (the next month's card payment)
    n_txn = 0

    def txn(i, day, account_id, payee, category, cents, memo="", transfer_to=None):
        """One transaction in month index i (skipped if that day hasn't happened yet)."""
        nonlocal n_txn
        y, m = months[i]
        when = date(y, m, min(day, 28))
        if when > today:
            return False
        body = {"account_id": account_id, "date": when.isoformat(), "payee": payee, "memo": memo,
                "amount": int(cents), "cleared": 1 if (today - when).days > 3 else 0}
        if transfer_to:
            body["transfer_account_id"] = transfer_to
        else:
            body["category_id"] = cat[category]
        call("post", "/api/transactions", body)
        n_txn += 1
        return True

    def j(base, pct=0.15):
        return int(round(base * (1 + rng.uniform(-pct, pct))))

    # opening balances, all counted as income "for this month" in the first month
    for acct, cents in ((chk, 320000), (sav, 450000), (cash, 15000)):
        txn(0, 1, acct, "Starting Balance", "Income for This Month", cents)

    for i in range(len(months)):
        charges = 0

        def charge(day, payee, category, cents):
            nonlocal charges
            if txn(i, day, visa, payee, category, -cents):
                charges += cents

        # pay: two paychecks a month into checking, held for NEXT month's budget
        for day in (1, 15):
            txn(i, day, chk, "Acme Corp Payroll", "Income for Next Month", 205000, "Direct deposit")
        # fixed bills from checking
        txn(i, 1, chk, "Maple Property Management", "Rent", -145000, "Monthly rent")
        txn(i, 3, chk, "City Power & Light", "Electric", -j(11000, 0.2))
        txn(i, 5, chk, "Riverside Utilities", "Water & Sewer", -5500)
        txn(i, 6, chk, "FiberNet", "Internet", -7000)
        txn(i, 8, chk, "Mobile One", "Phone", -8500)
        txn(i, 10, chk, "SafeDrive Insurance", "Car Insurance", -12000)
        txn(i, 7, chk, "Fresh Market", "Groceries", -j(12500))
        txn(i, 21, chk, "Fresh Market", "Groceries", -j(11000))
        # transfers
        txn(i, 2, chk, "", None, -60000, "Emergency fund", transfer_to=sav)
        txn(i, 12, chk, "", None, -10000, "ATM withdrawal", transfer_to=cash)
        if i > 0:
            txn(i, 20, chk, "", None, -visa_total[i - 1], "Visa payment", transfer_to=visa)
        # savings interest
        txn(i, 28, sav, "Credit Union Interest", "Income for This Month", j(600, 0.2))
        # credit card spending
        charge(9, "Corner Grocer", "Groceries", j(12000))
        charge(23, "Corner Grocer", "Groceries", j(14500))
        for day in (4, 14, 26):
            charge(day, "Speedy Gas", "Fuel", j(5000, 0.15))
        for day, place in ((6, "Taco Town"), (13, "Pizza Palace"), (22, "Cafe Luna")):
            charge(day, place, "Dining Out", j(3800, 0.25))
        if i == 3:   # one month goes over on dining out, to show overspending
            charge(25, "Steakhouse 44", "Dining Out", 26000)   # a big night out
            charge(27, "Pizza Palace", "Dining Out", 4200)
        charge(11, "StreamFlix", "Subscriptions", 1599)
        charge(11, "Music Plus", "Subscriptions", 1099)
        charge(17, "Cinema 8" if i != 2 else "Bowling Lanes", "Entertainment", j(3000))
        charge(13, "HomeGoods Depot", "Household", j(4000, 0.3))
        charge(19, "Shear Style", "Personal Care", 4500)
        if i in (1, 4):
            charge(16, "Threadworks", "Clothing", j(7500))
        if i == 2:
            charge(8, "Quick Lube & Tire", "Car Repairs", 18000)
        if i == 4:
            charge(18, "Lakeview Resort", "Vacation", 35000)
        visa_total[i] = charges
        # cash wallet
        txn(i, 14, cash, "Food Truck Friday", "Dining Out", -1200)
        txn(i, 17, cash, "Farmers Market", "Groceries", -j(2200))
        txn(i, 24, cash, "Corner Barber", "Personal Care", -2000)

    # --- budget amounts -------------------------------------------------------------------
    # Each month gets the usual amounts; whatever is left of that month's money goes to (or comes
    # back out of) Emergency Fund so every past month balances to zero. This month keeps a little
    # unbudgeted so "Available to Budget" shows a real figure.
    def tbb(month):
        r = call("get", f"/api/budget/range?months={month}")
        return (r[0] if isinstance(r, list) else r)["to_be_budgeted"]

    for i, (y, m) in enumerate(months):
        month = f"{y:04d}-{m:02d}"
        for name, cents in budget_plan.items():
            call("post", "/api/budget", {"category_id": cat[name], "month": month, "budgeted": cents})
        left = tbb(month) - (21500 if i == len(months) - 1 else 0)
        if left:
            call("post", "/api/budget", {"category_id": cat["Emergency Fund"], "month": month,
                                         "budgeted": max(0, budget_plan["Emergency Fund"] + left)})

    # --- scheduled bills & paychecks ------------------------------------------------------
    ny, nm = month_add(today.year, today.month, 1)

    def sched(account_id, payee, category, cents, day, freq="Every Month", transfer_to=None):
        body = {"account_id": account_id, "payee": payee, "amount": cents, "frequency": freq,
                "next_date": date(ny, nm, day).isoformat()}
        if transfer_to:
            body["transfer_account_id"] = transfer_to
        else:
            body["category_id"] = cat[category]
        call("post", "/api/scheduled", body)

    sched(chk, "Maple Property Management", "Rent", -145000, 1)
    sched(chk, "Acme Corp Payroll", "Income for Next Month", 205000, 1)
    sched(chk, "Acme Corp Payroll", "Income for Next Month", 205000, 15)
    sched(chk, "SafeDrive Insurance", "Car Insurance", -12000, 10)
    sched(visa, "StreamFlix", "Subscriptions", -1599, 11)
    sched(chk, "", None, -60000, 2, transfer_to=sav)

    conn = nab.db.get_db_for(bid)
    nab.db.set_setting(conn, "demo_anchor", f"{today.year:04d}-{today.month:02d}")   # lets the app roll its dates forward later
    conn.commit()
    conn.close()
    # Don't ship this machine's session-signing key: whoever runs the demo gets their own on first start.
    reg = nab.db.get_registry_db()
    reg.execute("DELETE FROM app_settings WHERE key='secret_key'")
    reg.commit()
    reg.close()

    print(f"Demo budget written to {out}")
    print(f"  4 accounts, {n_txn} transactions, {len(budget_plan)} budgeted categories over {len(months)} months")
    print(f"  password: {args.password}")
    print("Run it with:")
    print(f"  NAB_DB_PATH={os.path.join(out, 'nab.db')} python3 app.py     # then open http://localhost:8000")


if __name__ == "__main__":
    main()
