"""Import helpers: generic bank CSV and Actual Budget exports.

Actual Budget exports a .zip containing `db.sqlite` (its SQLite database).
We read that database directly and translate its rows into our schema.
"""

import csv
import io
import json
import os
import re
import sqlite3
import tempfile
import zipfile
from collections import defaultdict
from datetime import datetime, date as _date, timedelta

import db
import scheduled_engine

# --------------------------------------------------------------------------- #
#  CSV import                                                                   #
# --------------------------------------------------------------------------- #

_DATE_FORMATS = [
    "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y", "%m/%d/%y", "%d/%m/%y",
    "%Y/%m/%d", "%m-%d-%Y", "%d-%m-%Y", "%b %d, %Y", "%d %b %Y",
    "%Y%m%d", "%m/%d/%Y %H:%M", "%Y-%m-%d %H:%M:%S",
]


def sniff_csv(text):
    """Return {headers, rows(sample)} for the mapping UI."""
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader if any(cell.strip() for cell in r)]
    if not all_rows:
        return {"headers": [], "rows": []}
    headers = all_rows[0]
    sample = all_rows[1:6]
    return {"headers": headers, "rows": sample, "total": len(all_rows) - 1}


def _parse_date(value):
    value = (value or "").strip()
    if not value:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Last resort: pull the first date-looking token.
    m = re.search(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", value)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


def _parse_amount(value):
    """Parse a currency string into signed integer cents."""
    if value is None:
        return 0
    s = str(value).strip()
    if not s:
        return 0
    neg = False
    if s.startswith("(") and s.endswith(")"):  # (12.34) accounting negative
        neg = True
        s = s[1:-1]
    s = s.replace("$", "").replace(",", "").replace(" ", "")
    if s.startswith("-"):
        neg = True
        s = s[1:]
    if s.startswith("+"):
        s = s[1:]
    if not s:
        return 0
    try:
        cents = round(float(s) * 100)
    except ValueError:
        return 0
    return -cents if neg else cents


def _csv_rows(text, mapping):
    """Parse CSV text with a UI column mapping into (account_id, rows). Each row
    is {index, date, amount, payee, memo, fitid}; `date` is None when the row's
    date couldn't be read. Indices count every non-blank data row, so the same
    row keeps the same index between a preview and the import that follows.

    mapping keys:
      account_id (int, required)
      date, payee, memo         -> header names (payee/memo optional)
      amount                    -> single signed column, OR
      outflow, inflow           -> two columns
      invert (bool)             -> flip the sign of `amount`
      skip_header (bool, default True)
    """
    account_id = int(mapping["account_id"])
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader if any(cell.strip() for cell in r)]
    if mapping.get("skip_header", True) and all_rows:
        header = all_rows[0]
        all_rows = all_rows[1:]
    else:
        header = mapping.get("headers", [])

    def idx(name):
        if not name:
            return None
        try:
            return header.index(name)
        except (ValueError, AttributeError):
            try:
                return int(name)
            except (TypeError, ValueError):
                return None

    di = idx(mapping.get("date"))
    pi = idx(mapping.get("payee"))
    mi = idx(mapping.get("memo"))
    ai = idx(mapping.get("amount"))
    oi = idx(mapping.get("outflow"))
    ii = idx(mapping.get("inflow"))
    invert = bool(mapping.get("invert"))

    def cell(row, i):
        return row[i] if (i is not None and i < len(row)) else ""

    rows = []
    for n, row in enumerate(all_rows):
        date = _parse_date(cell(row, di))
        if ai is not None:
            amount = _parse_amount(cell(row, ai))
            if invert:
                amount = -amount
        else:
            out = abs(_parse_amount(cell(row, oi)))
            inn = abs(_parse_amount(cell(row, ii)))
            amount = inn - out
        rows.append({"index": n, "date": date, "amount": amount,
                     "payee": cell(row, pi).strip(), "memo": cell(row, mi).strip(),
                     "fitid": None})
    return account_id, rows


# --------------------------------------------------------------------------- #
#  Remembering categories: a new row gets the category its payee had before     #
# --------------------------------------------------------------------------- #

def category_memory(conn):
    """What category each payee has been given before, learned from every categorized transaction (newest first).
    {"exact": {payee lower-cased: counts}, "keyed": {alias key: counts}, "info": {category id: (name, is income)}}
    where counts is {category id: [times used, rank of its newest use (0 = newest)]}."""
    db.ensure_import_memory(conn)
    exact, keyed, info = {}, {}, {}
    rules = {}                     # alias key -> category id to use, or None for "don't suggest"
    for r in conn.execute("SELECT key, value, forgotten FROM import_memory WHERE kind='category'"):
        rules[r["key"]] = None if r["forgotten"] or not r["value"] else int(r["value"])
    for r in conn.execute("SELECT id, name, is_income FROM categories WHERE hidden=0"):
        info[r["id"]] = (r["name"], bool(r["is_income"]))
    rows = conn.execute(
        "SELECT t.payee, t.category_id, c.name, c.is_income FROM transactions t "
        "JOIN categories c ON c.id=t.category_id "
        "WHERE c.hidden=0 AND TRIM(COALESCE(t.payee,''))<>'' ORDER BY t.date DESC, t.id DESC LIMIT 30000")
    for rank, r in enumerate(rows):
        info[r["category_id"]] = (r["name"], bool(r["is_income"]))
        for table, key in ((exact, r["payee"].strip().lower()), (keyed, _alias_key(r["payee"]))):
            if key:
                hit = table.setdefault(key, {}).setdefault(r["category_id"], [0, rank])
                hit[0] += 1
    return {"exact": exact, "keyed": keyed, "info": info, "rules": rules}


def _rule_hit(rules, key):
    """(found, category id or None) for the setting you made in Settings that covers this payee fingerprint."""
    if key in rules:
        return True, rules[key]
    if len(key) >= 5:
        for k, v in rules.items():
            if len(k) >= 5 and (key.startswith(k) or k.startswith(key)):
                return True, v
    return False, None


def list_memory_categories(conn, q="", limit=300):
    """Everything the importer would do for a payee: what it learned (the most used category), and any change you made
    to it in Settings. One row per payee fingerprint, most used first."""
    mem = category_memory(conn)
    groups = {}
    for r in conn.execute(
            "SELECT t.payee, t.category_id FROM transactions t JOIN categories c ON c.id=t.category_id "
            "WHERE c.hidden=0 AND TRIM(COALESCE(t.payee,''))<>'' ORDER BY t.date DESC, t.id DESC LIMIT 30000"):
        k = _alias_key(r["payee"])
        if not k:
            continue
        g = groups.setdefault(k, {"labels": {}, "counts": {}})
        g["labels"][r["payee"].strip()] = g["labels"].get(r["payee"].strip(), 0) + 1
        g["counts"][r["category_id"]] = g["counts"].get(r["category_id"], 0) + 1
    labels = {r["key"]: r["label"] for r in conn.execute("SELECT key, label FROM import_memory WHERE kind='category'")}
    keys = set(k for k in groups if k) | set(mem["rules"])
    out = []
    needle = (q or "").strip().lower()
    for k in keys:
        g = groups.get(k)
        label = (max(g["labels"], key=g["labels"].get) if g else labels.get(k)) or labels.get(k) or k
        if needle and needle not in label.lower():
            continue
        learned = None
        if g:
            cid = max(g["counts"], key=g["counts"].get)
            learned = {"category_id": cid, "category_name": mem["info"].get(cid, ("(removed)", False))[0],
                       "seen": g["counts"][cid], "of": sum(g["counts"].values())}
        if k in mem["rules"]:
            cid = mem["rules"][k]
            out.append({"key": k, "label": label, "learned": learned,
                        "source": "forgotten" if cid is None else "rule",
                        "category_id": cid, "category_name": mem["info"][cid][0] if cid in mem["info"] else None})
        elif learned:
            out.append({"key": k, "label": label, "learned": learned, "source": "learned",
                        "category_id": learned["category_id"], "category_name": learned["category_name"]})
    out.sort(key=lambda r: (r["source"] == "learned", -(r["learned"]["of"] if r["learned"] else 0), r["label"].lower()))
    return out[:limit]


def list_memory_aliases(conn, q="", limit=300):
    """Bank wording you have matched to one of your own payees (so it is recognised next time), plus any change you
    made to it in Settings."""
    db.ensure_import_signatures(conn)
    db.ensure_import_memory(conn)
    groups = {}
    for r in conn.execute(
            "SELECT s.payee AS bank, t.payee AS mine FROM import_signatures s JOIN transactions t ON t.id = s.txn_id "
            "WHERE TRIM(COALESCE(t.payee,''))<>'' ORDER BY s.id DESC"):
        k = _alias_key(r["bank"])
        if len(k) < 4:
            continue
        g = groups.setdefault(k, {"bank": r["bank"].strip(), "mine": {}})
        g["mine"][r["mine"].strip()] = g["mine"].get(r["mine"].strip(), 0) + 1
    rules = {r["key"]: r for r in conn.execute("SELECT * FROM import_memory WHERE kind='alias'")}
    needle = (q or "").strip().lower()
    out = []
    for k in set(groups) | set(rules):
        g = groups.get(k)
        bank = g["bank"] if g else (rules[k]["label"] or k)
        learned = max(g["mine"], key=g["mine"].get) if g else None
        rule = rules.get(k)
        payee = (rule["value"] if rule and not rule["forgotten"] else None) or learned
        if rule and rule["forgotten"]:
            payee = learned
        if needle and needle not in bank.lower() and needle not in (payee or "").lower():
            continue
        out.append({"key": k, "bank": bank, "learned": learned, "payee": payee,
                    "count": sum(g["mine"].values()) if g else 0,
                    "source": ("forgotten" if rule["forgotten"] else "rule") if rule else "learned"})
    out.sort(key=lambda r: (r["source"] == "learned", -r["count"], r["bank"].lower()))
    return out[:limit]


def _best_category(counts):
    """(category id, times used, times this payee was seen at all) for the most used category (ties: newest)."""
    cid, (n, _) = min(counts.items(), key=lambda kv: (-kv[1][0], kv[1][1]))
    return cid, n, sum(v[0] for v in counts.values())


def suggest_category(mem, payee, amount, aliases=None):
    """The category this payee had before, or None. Tries the exact payee, then bank wording that starts the same
    way ("FRESH MARKET #123 SEATTLE" ~ "Fresh Market"), then payees you've matched this wording to by hand."""
    name = (payee or "").strip().lower()
    if not name:
        return None
    key = _alias_key(payee)
    found, ruled = _rule_hit(mem.get("rules") or {}, key)      # what you set in Settings wins over what was learned
    if found:
        if ruled is None or ruled not in mem["info"]:
            return None
        cname, is_income = mem["info"][ruled]
        if is_income and amount is not None and amount < 0:
            return None
        return {"id": ruled, "name": cname, "seen": 0, "of": 0, "rule": True}
    counts = mem["exact"].get(name)
    if not counts and len(key) >= 4:
        counts = mem["keyed"].get(key)
        if not counts:                                        # wording that begins the same way, either side
            merged = {}
            for k, c in mem["keyed"].items():
                if len(k) >= 5 and (key.startswith(k) or (len(key) >= 5 and k.startswith(key))):
                    for cid, (n, rank) in c.items():
                        hit = merged.setdefault(cid, [0, rank])
                        hit[0] += n
                        hit[1] = min(hit[1], rank)
            counts = merged or None
        if not counts and aliases:
            merged = {}
            for mine in aliases.get(key, ()):
                for cid, (n, rank) in (mem["exact"].get(mine) or {}).items():
                    hit = merged.setdefault(cid, [0, rank])
                    hit[0] += n
                    hit[1] = min(hit[1], rank)
            counts = merged or None
    if not counts:
        return None
    cid, n, total = _best_category(counts)
    cname, is_income = mem["info"][cid]
    if is_income and amount is not None and amount < 0:     # money going out doesn't belong in an income category
        return None
    return {"id": cid, "name": cname, "seen": n, "of": total}


def _review_flags(conn, account_id, rows, dedup_days, dedupe=True, auto_cat=True):
    """Annotate parsed rows for the review screen. Exact duplicates keep the
    old behaviour; anything else with a hand-entered look-alike (same amount,
    nearby date, same first three letters of payee) is a *possible match*."""
    used, taken = {}, set()
    aliases = alias_map(conn, account_id)
    out, dup, pm_count = [], 0, 0
    for t in rows:
        if not t["date"]:
            out.append({**t, "duplicate": False, "reason": "Unreadable date",
                        "matched": None, "possible_match": None})
            continue
        info = (duplicate_info(conn, account_id, t["amount"], t["payee"],
                               t["date"], t["fitid"], dedup_days, used)
                if dedupe else {"duplicate": False, "reason": "", "matched": None})
        pm = None
        if info["duplicate"]:
            dup += 1
        elif dedupe:
            pm = find_possible_match(conn, account_id, t["amount"], t["payee"],
                                     t["date"], dedup_days, taken, aliases)
            if pm:
                taken.add(pm["id"])
                pm_count += 1
        out.append({**t, "duplicate": info["duplicate"], "reason": info["reason"],
                    "matched": info["matched"], "possible_match": pm})
    # Second pass, review screen only: any row still without a match gets the closest entry with
    # exactly its amount near its date as an UNTICKED guess ("weak"), whatever the payee says, so
    # the person can just tick the right ones. These are made after every confident match above
    # has claimed its entry, and quick import ignores them (it must not hold rows back for a guess).
    if auto_cat:                     # a category for every row that would be added: what its payee had before
        mem = category_memory(conn)
        for row in out:
            if not row["duplicate"] and row["date"]:
                row["suggested_category"] = suggest_category(mem, row["payee"], row["amount"],
                                                             aliases)
    weak = 0
    if dedupe:
        for row in out:
            if row["duplicate"] or row["possible_match"] or not row["date"]:
                continue
            free = [c for c in match_candidates(conn, account_id, row["amount"], row["date"], dedup_days)
                    if c["id"] not in taken]
            if free:
                taken.add(free[0]["id"])
                row["possible_match"] = {**free[0], "how": "amount", "weak": True, "prefix": ""}
                weak += 1
    return {"total": len(out), "duplicate_count": dup, "match_count": pm_count, "weak_count": weak,
            "new_count": len(out) - dup - pm_count, "transactions": out}


def preview_csv(conn, text, mapping, auto_cat=True):
    account_id, rows = _csv_rows(text, mapping)
    dedup_days = int(mapping.get("dedup_days", 0) or 0)
    return _review_flags(conn, account_id, rows, dedup_days, dedupe=dedup_days > 0, auto_cat=auto_cat)


def import_csv(conn, text, mapping, indices=None, matches=None, categories=None, auto_cat=True):
    """Import rows using a column mapping produced by the UI.

    With `indices`, exactly those rows are imported (picked in the review
    screen) with no duplicate checking; `matches` ({index: transaction id})
    merges the chosen rows into existing hand-entered transactions instead of
    adding them. Without `indices` (quick import) exact duplicates are skipped
    and possible matches are held back for review.
    """
    account_id, rows = _csv_rows(text, mapping)
    dedup_days = int(mapping.get("dedup_days", 0) or 0)
    batch_id = start_batch(conn, "csv", account_id, "CSV import")
    counts = {"imported": 0, "skipped": 0, "skipped_duplicates": 0, "matched": 0, "held": 0}
    # A window of 0 is the CSV screen's "don't skip duplicates" choice: no
    # duplicate checking and no matching at all.
    _ingest(conn, account_id, rows, batch_id, dedup_days, counts,
            indices=indices, matches=matches, include_duplicates=dedup_days <= 0,
            categories=categories, auto_cat=auto_cat)
    finish_batch(conn, batch_id, counts["imported"])
    conn.commit()
    return {"imported": counts["imported"], "skipped": counts["skipped"],
            "skipped_duplicates": counts["skipped_duplicates"],
            "matched": counts["matched"], "held_for_review": counts["held"],
            "batch_id": batch_id}


def _insert_row(conn, account_id, t, batch_id, category_id=None):
    # A row that came from the bank has, by definition, cleared the bank.
    conn.execute(
        "INSERT INTO transactions (account_id, date, payee, memo, amount, category_id, cleared, "
        "import_id, import_batch_id, import_review) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1)",
        (account_id, t["date"], t["payee"], t["memo"], t["amount"], category_id,
         t.get("fitid") or None, batch_id))


def _ingest(conn, account_id, rows, batch_id, dedup_days, counts, indices=None,
            matches=None, include_duplicates=False, categories=None, auto_cat=True):
    """Shared by the CSV and OFX importers; see import_csv for the semantics.

    A row that is added gets a category: the one chosen for it on the review screen (`categories`,
    {row index: category id or None}), else, with auto_cat, the category its payee had before."""
    used, taken, claimed = {}, set(), set()
    aliases = alias_map(conn, account_id)
    mem = category_memory(conn) if auto_cat else None
    valid = {r["id"] for r in conn.execute("SELECT id FROM categories")} if categories else set()

    def category_for(t):
        if categories is not None and t["index"] in categories:
            cid = categories[t["index"]]
            return cid if cid in valid else None
        if mem:
            s = suggest_category(mem, t["payee"], t["amount"], aliases)
            return s["id"] if s else None
        return None
    chosen = set(indices) if indices is not None else None
    for t in rows:
        if chosen is not None and t["index"] not in chosen:
            continue
        if not t["date"]:
            counts["skipped"] += 1
            continue
        if chosen is not None:
            keep = None
            want = (matches or {}).get(t["index"])
            if want is not None and int(want) not in claimed:
                keep = _match_target(conn, account_id, int(want), t["amount"])
            if keep:
                claimed.add(keep["id"])
                merge_bank_row(conn, keep, t)
                counts["matched"] += 1
            else:
                _insert_row(conn, account_id, t, batch_id, category_for(t))
                counts["imported"] += 1
            continue
        if not include_duplicates and is_duplicate(
                conn, account_id, t["amount"], t["payee"], t["date"],
                t.get("fitid"), dedup_days, used):
            counts["skipped_duplicates"] += 1
            continue
        if not include_duplicates:
            pm = find_possible_match(conn, account_id, t["amount"], t["payee"],
                                     t["date"], dedup_days, taken, aliases)
            if pm:
                taken.add(pm["id"])
                counts["held"] += 1
                continue
        _insert_row(conn, account_id, t, batch_id, category_for(t))
        counts["imported"] += 1


# --------------------------------------------------------------------------- #
#  Duplicate detection (shared by CSV and OFX/QFX imports)                      #
# --------------------------------------------------------------------------- #

def _date_window(date_str, days):
    y, m, d = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
    base = _date(y, m, d)
    return ((base - timedelta(days=days)).isoformat(),
            (base + timedelta(days=days)).isoformat())


def _matched_signature(conn, account_id, amount, name, date, used):
    """Has this exact bank row (date + amount + payee) already been matched into
    a register entry by hand? `used` counts, per bank row identity, how many
    such matches this import run has already consumed — so two genuinely
    separate identical bank rows (two $5 coffees the same day) aren't both
    swallowed by a single manual match."""
    db.ensure_import_signatures(conn)
    key = (account_id, date, amount, (name or "").strip().lower())
    rows = conn.execute(
        "SELECT t.id, t.date, t.payee, t.amount FROM import_signatures s "
        "JOIN transactions t ON t.id = s.txn_id "
        "WHERE s.account_id=? AND s.date=? AND s.amount=? "
        "AND lower(trim(s.payee))=? ORDER BY s.id", key).fetchall()
    taken = used.get(key, 0) if used is not None else 0
    if len(rows) > taken:
        if used is not None:
            used[key] = taken + 1
        return dict(rows[taken])
    return None


def duplicate_info(conn, account_id, amount, name, date, fitid, dedup_days, used=None):
    """Decide whether an incoming transaction duplicates an existing one, and
    explain why. Returns {duplicate, reason, matched} where `matched` is the
    existing transaction (date/payee/amount) that triggered the match.

    Precedence follows the user's rule: exact bank id first, then a bank row
    the user already matched by hand, then dollar amount + payee name within
    +/- N days. `used` is a per-import-run dict (see _matched_signature).
    """
    # 1) Exact bank transaction id (FITID).
    if fitid:
        row = conn.execute(
            "SELECT id, date, payee, amount FROM transactions "
            "WHERE account_id=? AND import_id=? LIMIT 1",
            (account_id, fitid)).fetchone()
        if row:
            return {"duplicate": True,
                    "reason": f"Same bank ID (FITID {fitid})",
                    "matched": dict(row)}

    # 2) A bank row the user already matched into one of their own entries.
    hit = _matched_signature(conn, account_id, amount, name, date, used)
    if hit:
        return {"duplicate": True,
                "reason": f"Already matched to your entry on {hit['date']}",
                "matched": hit}

    # 3) Heuristic: same amount + same payee name, within the date window.
    #    Requires a non-empty name so blank-name rows don't collide by amount.
    name_l = (name or "").strip().lower()
    if name_l:
        lo, hi = _date_window(date, dedup_days)
        rows = conn.execute(
            "SELECT id, date, payee, amount FROM transactions "
            "WHERE account_id=? AND amount=? AND date BETWEEN ? AND ?",
            (account_id, amount, lo, hi)).fetchall()
        for r in rows:
            if (r["payee"] or "").strip().lower() == name_l:
                return {"duplicate": True,
                        "reason": f"Same amount & payee within {dedup_days} "
                                  f"day(s) (matches txn on {r['date']})",
                        "matched": dict(r)}
    return {"duplicate": False, "reason": "", "matched": None}


def is_duplicate(conn, account_id, amount, name, date, fitid, dedup_days, used=None):
    return duplicate_info(conn, account_id, amount, name, date,
                          fitid, dedup_days, used)["duplicate"]


# Only CSV/OFX batches are bank data. The Actual Budget import tags every one of
# its transactions with a batch too, but that's the user's own register history
# (hand-entered, scheduled, ...), so it must never count as "imported from the
# bank" when matching.
BANK_BATCHES_SQL = "(SELECT id FROM import_batches WHERE source IN ('csv', 'ofx'))"
NOT_BANK_BATCH_SQL = f"(t.import_batch_id IS NULL OR t.import_batch_id NOT IN {BANK_BATCHES_SQL})"


def _prefix3(name):
    """First three letters/digits of a payee, lower-cased ("" if it has fewer)."""
    flat = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    return flat[:3] if len(flat) >= 3 else ""


def _days_between(a, b):
    return abs((_date(int(a[:4]), int(a[5:7]), int(a[8:10]))
                - _date(int(b[:4]), int(b[5:7]), int(b[8:10]))).days)


def _alias_key(name):
    """What stays the same about a bank's wording from one month to the next: its first 12
    letters, ignoring digits, dates, reference numbers and punctuation
    ("ACH PMT PROPERTY MGMT 4521" and "...MGMT 4533" are one source)."""
    return re.sub(r"[^a-z]", "", (name or "").lower())[:12]


def alias_map(conn, account_id):
    """Payees you've already matched bank wording to, learned from earlier matches:
    {alias_key(bank wording): {your payee, lower-cased}}. It lets "ACH PMT PROPERTY MGMT"
    be recognised as your "Rent" from the second time on."""
    db.ensure_import_signatures(conn)
    db.ensure_import_memory(conn)
    out = {}
    for r in conn.execute(
            "SELECT s.payee AS bank, t.payee AS mine FROM import_signatures s "
            "JOIN transactions t ON t.id = s.txn_id "
            "WHERE s.account_id=? AND trim(t.payee) <> ''", (account_id,)):
        key = _alias_key(r["bank"])
        if len(key) >= 4:
            out.setdefault(key, set()).add(r["mine"].strip().lower())
    for r in conn.execute("SELECT key, value, forgotten FROM import_memory WHERE kind='alias'"):
        if r["forgotten"] or not r["value"]:
            out.pop(r["key"], None)                       # you switched this one off
        else:
            out[r["key"]] = {r["value"].strip().lower()}   # you chose what it should match
    return out


def find_possible_match(conn, account_id, amount, name, date, days, taken, aliases=None):
    """A hand-entered transaction this incoming bank row probably duplicates: identical
    amount, within `days`, and one of —
      * the payees share their first three letters ("Amazon" ~ "AMAZON MKTP US"), or
      * you've matched this bank wording to that payee before (see alias_map), or
      * the entry is a TRANSFER (no payee: the other account is its payee), or
      * the entry is an unpaid bill a SCHEDULE put in the register — the bank's wording
        for a payment says nothing reliable about which bill it is, but the schedule's
        amount and due date do.
    Only transactions that aren't already bank-sourced or matched qualify, and `taken`
    (ids already claimed this run) keeps two bank rows from claiming one entry. Closest
    date wins; on a tie a payee match beats a transfer / scheduled entry."""
    if days <= 0:
        return None
    p3 = _prefix3(name)
    if aliases is None:
        aliases = alias_map(conn, account_id)
    mine_for_this_wording = aliases.get(_alias_key(name), set())
    db.ensure_import_signatures(conn)
    lo, hi = _date_window(date, days)
    rows = conn.execute(
        "SELECT t.id, t.date, t.payee, t.memo, t.amount, t.cleared, t.transfer_txn_id, "
        "t.scheduled_id, t.sched_auto, c.name AS category_name, ta.name AS transfer_account_name "
        "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id "
        "LEFT JOIN accounts ta ON ta.id = t.transfer_account_id "
        "WHERE t.account_id=? AND t.amount=? AND t.date BETWEEN ? AND ? "
        f"AND {NOT_BANK_BATCH_SQL} AND t.import_id IS NULL "
        "AND t.id NOT IN (SELECT txn_id FROM import_signatures)",
        (account_id, amount, lo, hi)).fetchall()
    best, best_key = None, None
    for r in rows:
        if r["id"] in taken:
            continue
        is_transfer = r["transfer_txn_id"] is not None
        is_scheduled = (r["scheduled_id"] is not None and r["sched_auto"] == 1 and r["cleared"] == 0)
        payee_l = (r["payee"] or "").strip().lower()
        how = None
        if p3 and _prefix3(r["payee"]) == p3:
            how = "prefix"
        elif payee_l and payee_l in mine_for_this_wording:
            how = "alias"
        elif is_transfer:
            how = "transfer"
        elif is_scheduled:
            how = "scheduled"
        if how is None:
            continue
        gap = _days_between(r["date"], date)
        key = (gap, 0 if how in ("prefix", "alias") else 1)
        if best is None or key < best_key:
            best_key = key
            best = {**dict(r), "days_apart": gap, "prefix": p3 if how == "prefix" else "",
                    "how": how, "transfer": is_transfer, "scheduled": is_scheduled}
    return best


def match_candidates(conn, account_id, amount, date, days, limit=25):
    """Every register entry a bank row could be matched to BY HAND: this account, exactly this
    amount, within `days` of the bank row's date. Unlike find_possible_match it ignores the payee
    entirely — the person is choosing — but it keeps the same eligibility rules (not already
    bank-sourced or matched), so whatever they pick is accepted at import time. Closest date first."""
    db.ensure_import_signatures(conn)
    days = max(0, min(int(days), 60))
    lo, hi = _date_window(date, days)
    rows = conn.execute(
        "SELECT t.id, t.date, t.payee, t.memo, t.amount, t.cleared, t.transfer_txn_id, "
        "t.scheduled_id, t.sched_auto, c.name AS category_name, ta.name AS transfer_account_name "
        "FROM transactions t LEFT JOIN categories c ON c.id = t.category_id "
        "LEFT JOIN accounts ta ON ta.id = t.transfer_account_id "
        "WHERE t.account_id=? AND t.amount=? AND t.date BETWEEN ? AND ? "
        f"AND {NOT_BANK_BATCH_SQL} AND t.import_id IS NULL "
        "AND t.id NOT IN (SELECT txn_id FROM import_signatures)",
        (account_id, amount, lo, hi)).fetchall()
    out = [{**dict(r), "days_apart": _days_between(r["date"], date),
            "transfer": r["transfer_txn_id"] is not None,
            "scheduled": r["scheduled_id"] is not None and r["sched_auto"] == 1 and r["cleared"] == 0}
           for r in rows]
    out.sort(key=lambda r: (r["days_apart"], r["id"]))
    return out[:limit]


def _match_target(conn, account_id, txn_id, amount):
    """The row a review-screen match points at, if it's still a valid target:
    same account and amount, and not already bank-sourced or matched."""
    db.ensure_import_signatures(conn)
    return conn.execute(
        "SELECT t.* FROM transactions t WHERE t.id=? AND t.account_id=? AND t.amount=? "
        f"AND {NOT_BANK_BATCH_SQL} AND t.import_id IS NULL "
        "AND t.id NOT IN (SELECT txn_id FROM import_signatures)",
        (txn_id, account_id, amount)).fetchone()


def merge_bank_row(conn, keep, bank, bank_cleared=1):
    """Fold a bank row into the register entry `keep` (a transactions row).

    The user's entry wins; a blank payee/memo is filled from the bank row and
    the higher cleared state is kept (a bank row is cleared, so the entry becomes
    cleared — for a scheduled occurrence that is what marks it Paid). The bank row's identity is remembered —
    its FITID on the entry, and its original date/payee/amount in
    import_signatures — so importing it again is recognised as a duplicate.
    The entry is detached from any import batch so "Undo import" never deletes
    it. `bank` needs date, payee, memo, amount and optionally fitid/import_id."""
    # A transfer has no payee of its own (the other account is its payee), so don't give it one.
    payee = "" if keep["transfer_txn_id"] else (keep["payee"] or bank.get("payee") or "")
    memo = keep["memo"] or bank.get("memo") or ""
    cleared = max(keep["cleared"], bank_cleared)
    bank_id = bank.get("fitid") or bank.get("import_id")
    conn.execute(
        "UPDATE transactions SET payee=?, memo=?, cleared=?, import_id=?, "
        "import_batch_id=CASE WHEN import_batch_id IN " + BANK_BATCHES_SQL +
        " THEN NULL ELSE import_batch_id END, "
        "scheduled_id=COALESCE(scheduled_id, ?), version=version+1 WHERE id=?",
        (payee, memo, cleared, bank_id or keep["import_id"],
         bank.get("scheduled_id"), keep["id"]))
    if keep["transfer_txn_id"]:
        # Keep a transfer's other half's memo in step. Not its cleared status: that belongs to
        # the other account's own statement, and this bank row only came from THIS account's.
        conn.execute(
            "UPDATE transactions SET memo=?, version=version+1 WHERE id=?",
            (memo, keep["transfer_txn_id"]))
    db.ensure_import_signatures(conn)
    conn.execute(
        "INSERT INTO import_signatures (account_id, txn_id, import_id, date, payee, amount) "
        "VALUES (?,?,?,?,?,?)",
        (keep["account_id"], keep["id"], bank_id, bank["date"],
         bank.get("payee") or "", bank["amount"]))


# --------------------------------------------------------------------------- #
#  Import batches (so an import can be undone)                                  #
# --------------------------------------------------------------------------- #

def start_batch(conn, source, account_id, note):
    cur = conn.execute(
        "INSERT INTO import_batches (source, account_id, note) VALUES (?, ?, ?)",
        (source, account_id, note))
    return cur.lastrowid


def finish_batch(conn, batch_id, count):
    conn.execute("UPDATE import_batches SET txn_count=? WHERE id=?",
                 (count, batch_id))


# --------------------------------------------------------------------------- #
#  OFX / QFX import                                                             #
# --------------------------------------------------------------------------- #

def _ofx_date(value):
    """OFX DTPOSTED looks like YYYYMMDDHHMMSS[.xxx][+tz]; we want YYYY-MM-DD."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) >= 8:
        return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
    return None


def is_ofx(text):
    """True if this text is an OFX or QFX file (they share a format; QFX adds Quicken's extras)."""
    head = (text or "")[:5000].upper()
    return "OFXHEADER" in head or "<OFX>" in head


def _leaf(block, tag):
    mm = re.search(rf"<{tag}>\s*([^<\r\n]*)", block, re.IGNORECASE)
    return mm.group(1).strip() if mm else ""


def _ofx_body(text):
    m = re.search(r"<OFX>", text, re.IGNORECASE)
    return text[m.start():] if m else text


# A bank file can hold several statements (one per account): bank, credit card or investment.
_STMT_RE = re.compile(r"<(STMTRS|CCSTMTRS|INVSTMTRS)>(.*?)</\1>", re.DOTALL | re.IGNORECASE)


def ofx_statements(text):
    """One entry per account statement in the file: who it is (bank id, account number hash, last four digits, bank
    name) and how many transactions and between which dates."""
    body = _ofx_body(text)
    org = _leaf(body, "ORG") or _leaf(body, "INTU.BID") or _leaf(body, "FID")
    out = []
    for i, m in enumerate(_STMT_RE.finditer(body)):
        kind, block = m.group(1).upper(), m.group(2)
        acct = _leaf(block, "ACCTID")
        bank = _leaf(block, "BANKID") or _leaf(block, "BROKERID")
        dates = sorted(d for d in (_ofx_date(_leaf(b, "DTPOSTED")) for b in
                                   re.findall(r"<STMTTRN>(.*?)</STMTTRN>", block, re.DOTALL | re.IGNORECASE)) if d)
        out.append({
            "stmt": i, "kind": {"STMTRS": "bank", "CCSTMTRS": "card", "INVSTMTRS": "investment"}[kind],
            "acct_type": _leaf(block, "ACCTTYPE").upper(),
            "key": account_key(bank, acct) if acct else "", "hint": acct[-4:] if acct else "", "org": org,
            "count": len(dates), "first": dates[0] if dates else None, "last": dates[-1] if dates else None})
    return out


def account_key(bank_id, acct_id):
    """A one-way fingerprint of a bank account (the number itself is never stored)."""
    import hashlib
    return hashlib.sha256(f"{bank_id.strip()}|{acct_id.strip()}".lower().encode()).hexdigest()


def linked_account(conn, key):
    """The account id this bank account was linked to before, if it still exists."""
    if not key:
        return None
    row = conn.execute("SELECT l.account_id FROM account_links l JOIN accounts a ON a.id=l.account_id "
                       "WHERE l.key=?", (key,)).fetchone()
    return row["account_id"] if row else None


def suggest_account(conn, hint, org, kind="bank"):
    """A guess, for the first import of a bank account: the one account whose name has these last four digits,
    else the one account whose name contains the bank's name. A credit card statement only suggests credit
    accounts, and a bank statement never does."""
    accts = [dict(a) for a in conn.execute("SELECT id, name, type FROM accounts WHERE closed=0")
             if kind == "investment" or (a["type"] == "credit") == (kind == "card")]
    if hint:
        hits = [a for a in accts if hint in re.sub(r"\D", "", a["name"]) or hint in a["name"]]
        if len(hits) == 1:
            return hits[0]["id"], "the last four digits match its name"
    words = [w for w in re.split(r"\W+", org or "") if len(w) >= 3]
    for w in words:
        hits = [a for a in accts if w.lower() in a["name"].lower()]
        if len(hits) == 1:
            return hits[0]["id"], f"its name contains “{w}”"
    return None, ""


def detect_file(conn, text):
    """What kind of file is this, and (for QFX/OFX) which of the user's accounts is it for?"""
    if is_ofx(text):
        import db
        db.ensure_account_links(conn)
        stmts = ofx_statements(text)
        for s in stmts:
            s["account_id"] = linked_account(conn, s["key"])
            s["suggested_id"], s["suggested_why"] = (None, "")
            if s["account_id"] is None:
                s["suggested_id"], s["suggested_why"] = suggest_account(conn, s["hint"], s["org"], s["kind"])
            del s["key"]
        return {"kind": "ofx", "statements": stmts}
    info = sniff_csv(text)
    if info.get("headers") and len(info["headers"]) >= 2:
        return {"kind": "csv", **info}
    return {"kind": "unknown"}


def remember_account(conn, text, stmt, account_id):
    """After an import: remember which of your accounts this statement is, so next time it is recognised."""
    import db
    db.ensure_account_links(conn)
    s = next((x for x in ofx_statements(text) if x["stmt"] == (stmt or 0)), None)
    if s and s["key"]:
        conn.execute("INSERT INTO account_links (key, account_id, hint, org) VALUES (?,?,?,?) "
                     "ON CONFLICT(key) DO UPDATE SET account_id=excluded.account_id",
                     (s["key"], account_id, s["hint"], s["org"]))
        conn.commit()


def parse_ofx(text, stmt=None):
    """Parse OFX/QFX (both SGML and XML variants) into transaction dicts. For a file with several account
    statements, `stmt` picks one (0, 1, ...); otherwise everything is read."""
    # Work only within the <OFX> body if a header precedes it.
    body = _ofx_body(text)
    if stmt is not None:
        blocks = list(_STMT_RE.finditer(body))
        if blocks:
            body = blocks[min(int(stmt), len(blocks) - 1)].group(2)

    def leaf(block, tag):
        mm = re.search(rf"<{tag}>\s*([^<\r\n]*)", block, re.IGNORECASE)
        return mm.group(1).strip() if mm else ""

    acct = ""
    am = re.search(r"<ACCTID>\s*([^<\r\n]*)", body, re.IGNORECASE)
    if am:
        raw = am.group(1).strip()
        acct = ("****" + raw[-4:]) if len(raw) > 4 else raw

    txns = []
    for block in re.findall(r"<STMTTRN>(.*?)</STMTTRN>", body,
                            re.DOTALL | re.IGNORECASE):
        date = _ofx_date(leaf(block, "DTPOSTED") or leaf(block, "DTUSER"))
        amount = _parse_amount(leaf(block, "TRNAMT"))
        name = leaf(block, "NAME")
        memo = leaf(block, "MEMO")
        fitid = leaf(block, "FITID")
        payee = name or memo
        txns.append({"date": date, "amount": amount, "payee": payee,
                     "memo": memo, "fitid": fitid,
                     "trntype": leaf(block, "TRNTYPE")})
    return {"account_hint": acct, "transactions": txns}


def _ofx_rows(parsed):
    return [{**t, "index": i} for i, t in enumerate(parsed["transactions"])]


def preview_ofx(conn, text, account_id, dedup_days, stmt=None, auto_cat=True):
    """Parse and flag which transactions would be treated as duplicates (with a
    reason and the matched existing transaction) or possible matches to
    something entered by hand."""
    parsed = parse_ofx(text, stmt)
    res = _review_flags(conn, account_id, _ofx_rows(parsed), dedup_days, auto_cat=auto_cat)
    return {"account_hint": parsed["account_hint"], **res}


def import_ofx(conn, text, account_id, dedup_days, include_duplicates=False,
               indices=None, matches=None, stmt=None, categories=None, auto_cat=True):
    """Import OFX/QFX transactions.

    If `indices` is given, exactly those parsed rows are imported (the user hand
    picked them in the detail view) and duplicate checking is bypassed;
    `matches` ({index: transaction id}) merges chosen rows into existing
    hand-entered transactions instead. Otherwise dedupe runs, unless
    `include_duplicates` is set, and possible matches are held for review.
    """
    parsed = parse_ofx(text, stmt)
    batch_id = start_batch(conn, "ofx", account_id,
                           parsed["account_hint"] or "QFX/OFX import")
    counts = {"imported": 0, "skipped": 0, "skipped_duplicates": 0, "matched": 0, "held": 0}
    _ingest(conn, account_id, _ofx_rows(parsed), batch_id, dedup_days, counts,
            indices=indices, matches=matches, include_duplicates=include_duplicates,
            categories=categories, auto_cat=auto_cat)
    finish_batch(conn, batch_id, counts["imported"])
    conn.commit()
    return {"imported": counts["imported"], "skipped": counts["skipped"],
            "skipped_duplicates": counts["skipped_duplicates"],
            "matched": counts["matched"], "held_for_review": counts["held"],
            "batch_id": batch_id}


# --------------------------------------------------------------------------- #
#  Actual Budget import                                                         #
# --------------------------------------------------------------------------- #

def _cols(src, table):
    try:
        return {r[1] for r in src.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _table_exists(src, table):
    row = src.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _actual_date(v):
    """Actual stores dates as int YYYYMMDD (sometimes as string)."""
    if v is None:
        return None
    s = str(int(v)) if isinstance(v, (int, float)) else str(v)
    s = s.replace("-", "")
    if len(s) == 8:
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return _parse_date(str(v))


_ACTUAL_MONTH_INTERVAL_MAP = {1: "Every Month", 2: "Every 2 Months", 3: "Every 3 Months",
                              4: "Every 4 Months", 6: "Twice a Year", 12: "Yearly"}


def _actual_schedule_start(date_value):
    """The schedule's first/only occurrence date. Actual stores this two
    ways: a plain "YYYY-MM-DD" string for a one-time (non-recurring)
    schedule, or a {start, frequency, ...} object for a recurring one."""
    if isinstance(date_value, str):
        return _actual_date(date_value)
    if isinstance(date_value, dict):
        return _actual_date(date_value.get("start"))
    return None


def _actual_schedule_frequency(date_value):
    """Translate an Actual schedule's date condition into one of our fixed
    FREQUENCIES. A plain date string (no recurrence object at all) means a
    one-time schedule -> "Never". A {frequency, interval, ...} object is
    translated (interval multiplier, e.g. frequency="monthly", interval=3
    -> quarterly). Returns None for patterns we can't represent at all
    (specific weekday-of-month rules like "2nd Friday")."""
    if isinstance(date_value, str):
        return "Never"
    if not isinstance(date_value, dict):
        return None
    if date_value.get("patterns"):
        return None
    freq = date_value.get("frequency")
    if freq is None:
        return "Never"
    interval = int(date_value.get("interval") or 1)
    if freq == "daily":
        return "Daily"
    if freq == "weekly":
        return "Every 2 Weeks" if interval >= 2 else "Weekly"
    if freq == "monthly":
        # Snap to the nearest month-count we actually support.
        best = min(_ACTUAL_MONTH_INTERVAL_MAP, key=lambda n: abs(n - interval))
        return _ACTUAL_MONTH_INTERVAL_MAP[best]
    if freq == "yearly":
        return "Yearly"
    return None


def _advance_to_today(start_iso, frequency):
    """A schedule imported from a year-old export starts on some date long
    past — advance it to the next occurrence at/after today so it's
    immediately useful instead of needing to be paid down one stale
    occurrence at a time."""
    d = scheduled_engine._parse(start_iso)
    today = _date.today()
    if frequency == "Never":
        return start_iso if d >= today else today.isoformat()
    while d < today:
        nxt = scheduled_engine.advance_date(d, frequency)
        if nxt is None:
            break
        d = nxt
    return d.isoformat()


def import_actual(conn, zip_bytes, our_income_cat_id):
    """Import an Actual Budget export (.zip containing db.sqlite)."""
    with tempfile.TemporaryDirectory() as tmp:
        db_file = None
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            for name in zf.namelist():
                if name.endswith("db.sqlite"):
                    zf.extract(name, tmp)
                    db_file = os.path.join(tmp, name)
                    break
            if db_file is None:  # maybe the .sqlite was uploaded directly
                for name in zf.namelist():
                    if name.endswith(".sqlite"):
                        zf.extract(name, tmp)
                        db_file = os.path.join(tmp, name)
                        break
        if db_file is None:
            raise ValueError("No db.sqlite found inside the Actual export zip.")

        src = sqlite3.connect(db_file)
        src.row_factory = sqlite3.Row
        try:
            return _translate_actual(conn, src, our_income_cat_id)
        finally:
            src.close()


def _translate_actual(conn, src, income_cat_id):
    stats = {"accounts": 0, "categories": 0, "transactions": 0, "budgets": 0}
    batch_id = start_batch(conn, "actual", None, "Actual Budget import")
    stats["batch_id"] = batch_id

    # --- category groups ---
    group_map = {}   # actual group id -> our group id
    gcols = _cols(src, "category_groups")
    for g in src.execute("SELECT * FROM category_groups").fetchall():
        if "tombstone" in gcols and g["tombstone"]:
            continue
        if g["is_income"]:
            continue  # our Inflow group already covers income
        cur = conn.execute(
            "INSERT INTO category_groups (name, sort_order, hidden) VALUES (?, ?, ?)",
            (g["name"], _sort(g, gcols), 1 if _hidden(g, gcols) else 0),
        )
        group_map[g["id"]] = cur.lastrowid

    # --- categories ---
    cat_map = {}     # actual category id -> our category id
    ccols = _cols(src, "categories")
    for c in src.execute("SELECT * FROM categories").fetchall():
        if "tombstone" in ccols and c["tombstone"]:
            continue
        if c["is_income"]:
            cat_map[c["id"]] = income_cat_id
            continue
        gid = group_map.get(c["cat_group"])
        if gid is None:
            continue
        cur = conn.execute(
            "INSERT INTO categories (group_id, name, sort_order, hidden) "
            "VALUES (?, ?, ?, ?)",
            (gid, c["name"], _sort(c, ccols), 1 if _hidden(c, ccols) else 0),
        )
        cat_map[c["id"]] = cur.lastrowid
        stats["categories"] += 1

    # --- accounts ---
    acct_map = {}
    acols = _cols(src, "accounts")
    for a in src.execute("SELECT * FROM accounts").fetchall():
        if "tombstone" in acols and a["tombstone"]:
            continue
        offbudget = a["offbudget"] if "offbudget" in acols else 0
        closed = a["closed"] if "closed" in acols else 0
        # Actual doesn't reliably type accounts; guess credit from the name.
        acct_type = "credit" if re.search(r"credit|visa|master|amex|card",
                                          a["name"], re.I) else "checking"
        cur = conn.execute(
            "INSERT INTO accounts (name, type, on_budget, closed) "
            "VALUES (?, ?, ?, ?)",
            (a["name"], acct_type, 0 if offbudget else 1, 1 if closed else 0),
        )
        acct_map[a["id"]] = cur.lastrowid
        stats["accounts"] += 1

    # --- payees (for names only) ---
    # Actual's `transactions` table stores the payee reference in a column
    # literally called `description` (a historical name) — there's no
    # `payee` column on the raw table at all; that name only exists on
    # Actual's own `v_transactions` SQL view, which we don't have access to
    # since we open its file directly as a plain sqlite3 db. That view (and
    # every payee/category id everywhere else in Actual) is also always
    # indirected through a *_mapping table — every payee/category gets a
    # self-referencing row when created, and merging just repoints it — so
    # a merged payee's id has to be resolved to its current target before
    # looking up a name.
    payee_map = {}
    if _table_exists(src, "payees"):
        pcols = _cols(src, "payees")
        for p in src.execute("SELECT * FROM payees").fetchall():
            if "tombstone" in pcols and p["tombstone"]:
                continue
            payee_map[p["id"]] = p["name"]
    payee_target = {}
    if _table_exists(src, "payee_mapping"):
        for m in src.execute("SELECT id, targetId FROM payee_mapping").fetchall():
            payee_target[m["id"]] = m["targetId"]
    cat_target = {}
    if _table_exists(src, "category_mapping"):
        for m in src.execute("SELECT id, transferId FROM category_mapping").fetchall():
            cat_target[m["id"]] = m["transferId"]

    # --- transactions ---
    # Column names below are the RAW `transactions` table's, not the friendly
    # names Actual's own `v_transactions` SQL view exposes (isParent/isChild
    # instead of is_parent/is_child, description instead of payee,
    # transferred_id instead of transfer_id) — we're reading the sqlite file
    # directly so that view doesn't exist here.
    tcols = _cols(src, "transactions")
    rows = src.execute("SELECT * FROM transactions").fetchall()
    is_parent = lambda r: "isParent" in tcols and r["isParent"]
    is_child = lambda r: "isChild" in tcols and r["isChild"]
    txn_id_map = {}

    def field(t, name, parent=None):
        v = t[name] if name in tcols else None
        if (v is None or v == "") and parent is not None and name in tcols:
            v = parent[name]
        return v

    def insert_txn_row(t, amount, category_id):
        acct = acct_map.get(field(t, "acct"))
        if acct is None:
            return None
        date = _actual_date(field(t, "date"))
        if not date:
            return None
        raw_payee = field(t, "description")
        payee_name = payee_map.get(payee_target.get(raw_payee, raw_payee), "") if raw_payee else ""
        memo = field(t, "notes") or ""
        cleared = 1 if ("cleared" in tcols and t["cleared"]) else 0
        cur = conn.execute(
            "INSERT INTO transactions "
            "(account_id, date, payee, category_id, memo, amount, cleared, "
            "import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (acct, date, payee_name, category_id, memo, amount, cleared, batch_id),
        )
        return cur.lastrowid

    # Parents and plain (non-split) transactions each become one real
    # transaction. A split parent holds the FULL amount and no category of
    # its own — its children (handled below) carry the per-line categories.
    for t in rows:
        if "tombstone" in tcols and t["tombstone"]:
            continue
        if is_child(t):
            continue  # becomes a split line below, never its own transaction
        amount = int(field(t, "amount") or 0)
        if is_parent(t):
            cat = None
        else:
            raw_cat = field(t, "category")
            cat = cat_map.get(cat_target.get(raw_cat, raw_cat)) if raw_cat else None
        new_id = insert_txn_row(t, amount, cat)
        if new_id is not None:
            txn_id_map[t["id"]] = new_id
            stats["transactions"] += 1

    # Children become split lines on their (already-inserted) parent, so a
    # split transaction stays one transaction with its category breakdown —
    # not several independent transactions.
    for t in rows:
        if "tombstone" in tcols and t["tombstone"]:
            continue
        if not is_child(t):
            continue
        our_parent_id = txn_id_map.get(t["parent_id"] if "parent_id" in tcols else None)
        if our_parent_id is None:
            continue  # parent was tombstoned/skipped — drop the orphaned split line
        raw_cat = field(t, "category")
        cat = cat_map.get(cat_target.get(raw_cat, raw_cat)) if raw_cat else None
        memo = field(t, "notes") or ""
        amount = int(field(t, "amount") or 0)
        conn.execute(
            "INSERT INTO transaction_splits (transaction_id, category_id, amount, memo) "
            "VALUES (?, ?, ?, ?)",
            (our_parent_id, cat, amount, memo),
        )

    # Second pass: link transfers so they behave like our native transfers.
    if "transferred_id" in tcols:
        for t in rows:
            if t["id"] not in txn_id_map:
                continue
            tid = t["transferred_id"]
            if not tid or tid not in txn_id_map:
                continue
            other = src.execute("SELECT acct FROM transactions WHERE id=?",
                                (tid,)).fetchone()
            if other is None:
                continue
            other_acct = acct_map.get(other["acct"])
            conn.execute(
                "UPDATE transactions SET transfer_account_id=?, transfer_txn_id=?, "
                "category_id=NULL WHERE id=?",
                (other_acct, txn_id_map[tid], txn_id_map[t["id"]]),
            )

    # --- scheduled transactions (recurring bills/income) ---
    # Actual stores a schedule's recurrence as a "rule": conditions describing
    # the fixed account/payee/category/amount/memo plus a date-recurrence
    # object (frequency + interval multiplier, e.g. monthly+3 -> quarterly).
    # A transfer schedule is just one whose payee is itself a transfer payee
    # (payees.transfer_acct set), same as a transfer transaction.
    stats["scheduled"] = 0
    stats["scheduled_skipped"] = 0
    if _table_exists(src, "schedules") and _table_exists(src, "rules"):
        scols = _cols(src, "schedules")
        for s in src.execute("SELECT * FROM schedules").fetchall():
            if "tombstone" in scols and s["tombstone"]:
                continue
            rule = src.execute("SELECT conditions, actions FROM rules WHERE id=?",
                               (s["rule"],)).fetchone()
            if not rule or not rule["conditions"]:
                stats["scheduled_skipped"] += 1
                continue
            try:
                conds = json.loads(rule["conditions"])
            except (TypeError, ValueError):
                stats["scheduled_skipped"] += 1
                continue
            by_field = {c.get("field"): c for c in conds if isinstance(c, dict)}
            # A schedule's category (and sometimes notes) can live as a rule
            # ACTION ({"field":"category","op":"set","value":...}) instead of
            # a condition — seen on schedules edited after creation rather
            # than defined all at once. Conditions win if both are present.
            try:
                acts = json.loads(rule["actions"] or "[]")
            except (TypeError, ValueError):
                acts = []
            by_action_field = {a.get("field"): a for a in acts if isinstance(a, dict) and a.get("field")}

            acct_cond, date_cond = by_field.get("acct"), by_field.get("date")
            our_acct = acct_map.get(acct_cond["value"]) if acct_cond else None
            date_value = date_cond.get("value") if date_cond else None
            frequency = _actual_schedule_frequency(date_value)
            start = _actual_schedule_start(date_value)
            if our_acct is None or frequency is None or not start:
                stats["scheduled_skipped"] += 1
                continue
            next_date = _advance_to_today(start, frequency)

            amount = 0
            amount_cond = by_field.get("amount")
            if amount_cond is not None:
                v = amount_cond.get("value")
                if isinstance(v, dict):
                    amount = int(round((v.get("num1", 0) + v.get("num2", 0)) / 2))
                elif v is not None:
                    amount = int(v)

            payee_id = (by_field.get("description") or {}).get("value")
            payee_row = None
            if payee_id:
                resolved = payee_target.get(payee_id, payee_id)
                payee_row = src.execute(
                    "SELECT name, transfer_acct FROM payees WHERE id=?",
                    (resolved,)).fetchone()
            payee_name = (payee_row["name"] if payee_row else "") or ""
            transfer_to = acct_map.get(payee_row["transfer_acct"]) \
                if payee_row and payee_row["transfer_acct"] else None

            raw_cat = (by_field.get("category") or by_action_field.get("category") or {}).get("value")
            cat = cat_map.get(cat_target.get(raw_cat, raw_cat)) if raw_cat else None
            memo = (by_field.get("notes") or by_action_field.get("notes") or {}).get("value") or ""
            name = (s["name"] if "name" in scols else None) or payee_name

            conn.execute(
                "INSERT INTO scheduled_transactions (account_id, payee, category_id, "
                "transfer_account_id, memo, amount, next_date, frequency) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (our_acct, name, None if transfer_to else cat, transfer_to,
                 memo, amount, next_date, frequency),
            )
            stats["scheduled"] += 1

    # --- budgets (envelope / zero budgets), plus each category's carryover
    # flag ("carry the ending balance, even if overspent, into next month
    # instead of resetting to $0") — same per-(month, category) concept as
    # our own carryover feature.
    stats["carryover_events"] = 0
    zcols = _cols(src, "zero_budgets")
    has_carryover = "carryover" in zcols
    if _table_exists(src, "zero_budgets"):
        carry_by_cat = defaultdict(dict)   # our cat id -> {month: bool}
        for b in src.execute(
                "SELECT * FROM zero_budgets ORDER BY category, month").fetchall():
            raw_cat = b["category"]
            cat = cat_map.get(cat_target.get(raw_cat, raw_cat))
            if cat is None or cat == income_cat_id:
                continue
            month = str(b["month"])
            if len(month) == 6:
                month = f"{month[:4]}-{month[4:6]}"
            amount = int(b["amount"] or 0)
            if amount != 0:
                conn.execute(
                    "INSERT INTO budgets (month, category_id, budgeted) VALUES (?, ?, ?) "
                    "ON CONFLICT(month, category_id) DO UPDATE SET budgeted=excluded.budgeted",
                    (month, cat, amount),
                )
                stats["budgets"] += 1
            if has_carryover:
                carry_by_cat[cat][month] = bool(b["carryover"])

        # Actual stores the flag on every single month's row; we only need to
        # record a toggle-event the months it actually CHANGES — our carryover
        # table is a sparse "start/stop carrying" event log, not a per-month flag.
        for cat, months in carry_by_cat.items():
            prev = False
            for month in sorted(months):
                cur = months[month]
                if cur != prev:
                    conn.execute(
                        "INSERT INTO carryover (month, category_id, carry) VALUES (?, ?, ?) "
                        "ON CONFLICT(month, category_id) DO UPDATE SET carry=excluded.carry",
                        (month, cat, 1 if cur else 0))
                    stats["carryover_events"] += 1
                prev = cur

    finish_batch(conn, batch_id, stats["transactions"])
    conn.commit()
    return stats


def _sort(row, cols):
    if "sort_order" in cols and row["sort_order"] is not None:
        try:
            return int(float(row["sort_order"]))
        except (TypeError, ValueError):
            return 0
    return 0


def _hidden(row, cols):
    return bool(row["hidden"]) if "hidden" in cols and row["hidden"] else False
