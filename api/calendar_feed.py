"""Calendar reminders: a private iCalendar (.ics) feed of upcoming scheduled
transactions that a phone/computer calendar can subscribe to.

Every unpaid scheduled occurrence becomes an all-day event with two alerts —
`due_soon_days` before it's due and again on the day itself (both at 9:00) —
so the device's own calendar does the notifying, even with this app closed.

Calendar apps can't log in, so the feed lives at an unguessable per-budget
URL (/calendar/<token>.ics). Anyone holding the link can read the feed, so it
can be reset from Settings, which kills the old link.
"""

import hmac
import re
import secrets
import sqlite3
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

from flask import Blueprint, Response, abort, jsonify, request

import db
import secure
import scheduled_engine
from api.auth import require_auth

calendar_bp = Blueprint("calendar_feed", __name__)

ALERT_HOUR = 9          # alerts fire at 9:00 a.m. local calendar time
HORIZON_DAYS = 400      # how far ahead the feed looks
MAX_PER_SCHEDULE = 60   # cap for very frequent schedules (daily / weekly)


# ---------------------------------------------------------------- token ----

def _token(conn, create=False, rotate=False):
    tok = db.get_setting(conn, "calendar_token")
    if rotate or (create and not tok):
        tok = secrets.token_urlsafe(32)
        db.set_setting(conn, "calendar_token", tok)
        conn.commit()
    return tok or None


@calendar_bp.route("/api/calendar-feed")
@require_auth
def api_calendar_feed_info():
    conn = db.get_db()
    try:
        return jsonify({"path": f"/calendar/{_token(conn, create=True)}.ics",
                        "alert_days": scheduled_engine.due_soon_days(conn),
                        "headsup": _headsup(conn),
                        "daily": _daily(conn),
                        "last_fetch": db.get_setting(conn, "calendar_last_fetch") or None,
                        "last_agent": db.get_setting(conn, "calendar_last_agent") or None,
                        "last_count": db.get_setting(conn, "calendar_last_count") or None})
    finally:
        conn.close()


def _daily(conn):
    """Whether to alert every day from N days out until paid (and each morning
    once it is past due), instead of just once ahead and once on the day."""
    return db.get_setting(conn, "calendar_daily", "0") == "1"


def _headsup(conn):
    """Whether to add a separate heads-up entry N days before each due date."""
    return db.get_setting(conn, "calendar_headsup", "1") != "0"


@calendar_bp.route("/api/calendar-feed/options", methods=["POST"])
@require_auth
def api_calendar_feed_options():
    p = request.json or {}
    conn = db.get_db()
    try:
        if "headsup" in p:
            db.set_setting(conn, "calendar_headsup", "1" if p["headsup"] else "0")
        if "daily" in p:
            db.set_setting(conn, "calendar_daily", "1" if p["daily"] else "0")
        conn.commit()
        return jsonify({"ok": True, "headsup": _headsup(conn), "daily": _daily(conn)})
    finally:
        conn.close()


@calendar_bp.route("/api/calendar-feed/file")
@require_auth
def api_calendar_file():
    """The same bills as a one-off .ics download, for importing into a calendar
    that can't subscribe to the link (e.g. Google Calendar when this app isn't
    reachable from the internet)."""
    bid = db.current_budget_id()
    name = next((b["name"] for b in db.list_budgets() if b["id"] == bid), "Budget")
    conn = db.get_db()
    try:
        body = build_feed(conn, name, bid, for_import=True)
    finally:
        conn.close()
    return Response(body, mimetype="text/calendar", headers={
        "Content-Disposition": 'attachment; filename="my-nab-bills.ics"',
        "Cache-Control": "no-store"})


@calendar_bp.route("/api/calendar-feed/reset", methods=["POST"])
@require_auth
def api_calendar_feed_reset():
    conn = db.get_db()
    try:
        return jsonify({"path": f"/calendar/{_token(conn, rotate=True)}.ics"})
    finally:
        conn.close()


# ----------------------------------------------------------- ics helpers ----

def _esc(text):
    # Payees and memos can come from imported bank files. A raw CR/LF (or any control
    # character) would end the calendar line early and let the text add its own fields,
    # so only a newline is kept (as the escaped \\n) and the other control characters go.
    text = "".join(ch for ch in str(text) if ch in "\r\n" or ord(ch) >= 32)
    return (text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
            .replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n"))


def _fold(line):
    """RFC 5545: lines are at most 75 octets; continuations start with a space."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    parts, limit = [], 75
    while len(raw) > limit:
        cut = limit
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:   # don't split a UTF-8 character
            cut -= 1
        parts.append(raw[:cut].decode("utf-8"))
        raw, limit = raw[cut:], 74
    parts.append(raw.decode("utf-8"))
    return "\r\n ".join(parts)


def _money(cents):
    return f"${abs(cents) / 100:,.2f}"


def _alarm(trigger, text):
    return ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{_esc(text)}",
            f"TRIGGER:{trigger}", "END:VALARM"]


PAID_KEEP_DAYS = 60     # paid occurrences stay on the calendar (marked Paid) this long


def _occurrences(conn, s, today):
    """[(due date, paid?, paid amount, paid date)] for this schedule, oldest first.

    An entry is identified by the date it was DUE (sched_due), not its own date: paying moves the entry's date to the
    day it was paid, and the calendar event (same UID) has to stay put on the due date so it turns into "Paid"
    instead of a second event appearing while the original keeps alerting."""
    has_due = any(r[1] == "sched_due" for r in conn.execute("PRAGMA table_info(transactions)"))
    rows = conn.execute(
        f"SELECT {'COALESCE(sched_due, date)' if has_due else 'date'} AS due, date, cleared, amount "
        "FROM transactions WHERE scheduled_id=? ORDER BY id", (s["id"],)).fetchall()
    found = {}                                   # iso due date -> (paid?, amount as paid, date paid)
    for r in rows:                               # already entered in the register
        was = found.get(r["due"], (False, 0, None))
        if r["cleared"] != 0 and not was[0]:
            found[r["due"]] = (True, abs(r["amount"]), r["date"])
        elif r["due"] not in found:
            found[r["due"]] = was
    out = {}
    cutoff = (today - timedelta(days=PAID_KEEP_DAYS)).isoformat()
    for iso, info in found.items():
        if not info[0] or iso >= cutoff:
            out[iso] = info
    # Not yet entered: walk forward from the schedule's next date.
    d, end, n = scheduled_engine._parse(s["next_date"]), today + timedelta(days=HORIZON_DAYS), 0
    while d is not None and d <= end and n < MAX_PER_SCHEDULE:
        iso = d.isoformat()
        # (a one-time bill paid on another day counts as already entered; see
        # scheduled_engine.materialize_due)
        near = s["frequency"] == "Never" and any(
            abs((scheduled_engine._parse(k) - d).days) <= 7 for k in found)
        if iso not in found and not near:
            out[iso] = (False, 0, None)
        n += 1
        d = scheduled_engine.advance_date(d, s["frequency"])
    return sorted((scheduled_engine._parse(k), *v) for k, v in out.items())


def _when(day, hhmm):
    """DTSTART/DTEND lines: all-day, or a 30-minute event at a local ("floating")
    time that the phone shows in whatever time zone it is in."""
    if not hhmm:
        return [f"DTSTART;VALUE=DATE:{day.strftime('%Y%m%d')}",
                f"DTEND;VALUE=DATE:{(day + timedelta(days=1)).strftime('%Y%m%d')}"]
    start = datetime.combine(day, datetime.strptime(hhmm, "%H:%M").time())
    return [f"DTSTART:{start.strftime('%Y%m%dT%H%M%S')}",
            f"DTEND:{(start + timedelta(minutes=30)).strftime('%Y%m%dT%H%M%S')}"]


def build_feed(conn, budget_name, budget_id, for_import=False):
    """for_import=True is the downloadable file: a calendar import can't delete
    events, so a paid bill's heads-up entry is rewritten as "Paid" (same UID)
    instead of simply being left out."""
    today = date.today()
    threshold = scheduled_engine.due_soon_days(conn)
    headsup = _headsup(conn) and threshold > 0
    daily = _daily(conn)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//My NAB//Scheduled bills//EN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
             f"X-WR-CALNAME:{_esc('My NAB — ' + budget_name)}",
             "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"]
    rows = conn.execute(
        "SELECT s.*, c.name AS category_name, a.name AS account_name, "
        "ta.name AS transfer_account_name FROM scheduled_transactions s "
        "LEFT JOIN categories c ON c.id=s.category_id "
        "LEFT JOIN accounts a ON a.id=s.account_id "
        "LEFT JOIN accounts ta ON ta.id=s.transfer_account_id "
        "WHERE s.cal_alert=1").fetchall()
    for s in rows:
        who = s["payee"] or (f"Transfer to {s['transfer_account_name']}" if s["transfer_account_name"] else "") \
            or s["memo"] or "Scheduled transaction"
        incoming = s["amount"] > 0
        hhmm = s["cal_time"] or ""
        for due, paid, paid_amount, paid_on in _occurrences(conn, s, today):
            money = _money(paid_amount if paid else s["amount"])   # a paid bill shows what was actually paid
            past_due = not paid and due < today
            on = f"{due.strftime('%b')} {due.day}"
            title = (f"✓ Paid: {who} {money}" if paid
                     else f"⚠ Past Due: {who} {money}" if past_due
                     else f"{'Expected' if incoming else 'Due'}: {who} {money}")
            desc = [f"Account: {s['account_name']}"]
            if s["category_name"]:
                desc.append(f"Category: {s['category_name']}")
            if s["memo"]:
                desc.append(f"Memo: {s['memo']}")
            desc.append(f"Repeats: {s['frequency']}")
            if paid:
                desc.insert(0, f"Paid {paid_on}" if paid_on else "Paid")
                if paid_amount != abs(s["amount"]):
                    desc.append(f"Scheduled amount: {_money(s['amount'])}")
            elif past_due:
                desc.insert(0, f"Past due since {on}")

            def event(uid, day, summary, alarms):
                return ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}",
                        *_when(day, hhmm), f"SUMMARY:{_esc(summary)}",
                        f"DESCRIPTION:{_esc(chr(10).join(desc))}",
                        "STATUS:CONFIRMED", f"SEQUENCE:{1 if paid else 0}",
                        "TRANSP:TRANSPARENT", *alarms, "END:VEVENT"]

            uid = f"nab-{budget_id}-{s['id']}-{due.isoformat()}@my-nab"
            if paid:
                # Same UID as the "Due" entry, so the calendar turns it into "Paid"
                # (and stops alerting). A subscription drops the heads-up entry
                # from the feed; an import can't delete, so it overwrites it.
                lines += event(uid, due, title, [])
                early_day = due - timedelta(days=threshold)
                if for_import and headsup and early_day >= today - timedelta(days=PAID_KEEP_DAYS):
                    lines += event(f"nab-{budget_id}-{s['id']}-{due.isoformat()}-heads@my-nab",
                                   early_day, title, [])
                continue
            if past_due:
                # Marked Past Due on its due date (any alert there is already in the
                # past). With daily reminders, a copy dated TODAY carries a fresh
                # alert every morning until it is paid — a downloaded file is a
                # snapshot, so it can't follow "today".
                lines += event(uid, due, title, [])
                if daily and not for_import:
                    lines += event(f"nab-{budget_id}-{s['id']}-{due.isoformat()}-pastdue@my-nab", today,
                                   f"{title} (was due {on})", _alarm("PT0S" if hhmm else f"PT{ALERT_HOUR}H", title))
                continue
            # All-day alert times are measured from midnight; timed ones from the start.
            before = lambda k: f"-P{k}D" if hhmm else f"-PT{k * 24 - ALERT_HOUR}H"
            at_due = _alarm("PT0S" if hhmm else f"PT{ALERT_HOUR}H", f"{title} — due today")
            early = []
            # Once-ahead alert lives on this entry unless a separate heads-up entry
            # carries it; daily mode adds one for every day in between as well.
            first = threshold if not headsup else threshold - 1
            days_ahead = range(first, 0, -1) if daily else ([threshold] if threshold > 0 and not headsup else [])
            for k in days_ahead:
                early += _alarm(before(k), f"{title} — due in {k} day{'s' if k != 1 else ''}")
            lines += event(uid, due, title, [*early, *at_due])
            if headsup and due - timedelta(days=threshold) >= today:
                day = due - timedelta(days=threshold)
                htitle = f"Coming up: {who} {money} due {due.strftime('%b')} {due.day}"
                lines += event(f"nab-{budget_id}-{s['id']}-{due.isoformat()}-heads@my-nab", day, htitle,
                               _alarm("PT0S" if hhmm else f"PT{ALERT_HOUR}H", htitle))
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"


# ------------------------------------------------------------ public feed ----

_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,80}$")
FETCH_STAMP_EVERY = 60   # seconds: how often a poll is allowed to write its "last fetched" note


def _budget_with_token(token):
    """((id, name) of the budget whose calendar token this is, or None), and whether any encrypted budget was locked
    (so couldn't be looked in). Reads each budget's settings with a plain read-only connection: this route needs
    no login, so a stranger must not be able to make it upgrade, back up or lock anything. An encrypted budget is
    only searched while someone is signed in to it (its key is in memory)."""
    locked = False
    for b in db.list_budgets():
        path = db.budget_path(b["id"])
        try:
            if secure.is_encrypted_file(path):
                key = secure.key_any(path)
                if key is None:
                    locked = True
                    continue
                conn = secure.connect(path, key)
            else:
                conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True)
        except (sqlite3.Error, ValueError, secure.Locked):
            continue
        try:
            row = conn.execute("SELECT value FROM settings WHERE key='calendar_token'").fetchone()
        except Exception:
            continue   # a budget that isn't set up yet has no settings
        finally:
            conn.close()
        if row and row[0] and hmac.compare_digest(row[0].encode(), token.encode()):
            return (b["id"], b["name"]), locked
    return None, locked


@calendar_bp.route("/calendar/<token>.ics")
def calendar_feed(token):
    if not _TOKEN_RE.match(token):
        abort(404)   # can't be a real token: don't even look
    found, locked = _budget_with_token(token)
    if not found:
        if locked:     # may be an encrypted budget that is locked right now: "try later", not "gone"
            return Response("Locked. Sign in to My NAB and this calendar comes back.", status=503,
                            headers={"Retry-After": "900"}, mimetype="text/plain")
        abort(404)
    bid, name = found
    conn = db.get_db_for(bid)
    try:
        body = build_feed(conn, name, bid)
        # Remember who last fetched it so Settings can show whether a phone's calendar is
        # actually reaching this link — but not on every poll (writes can contend on a NAS).
        now = datetime.now(timezone.utc)
        last = db.get_setting(conn, "calendar_last_fetch")
        try:
            fresh = last and (now - datetime.strptime(last, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)).total_seconds() < FETCH_STAMP_EVERY
        except ValueError:
            fresh = False
        if not fresh:
            db.set_setting(conn, "calendar_last_fetch", now.strftime("%Y-%m-%dT%H:%M:%SZ"))
            db.set_setting(conn, "calendar_last_agent", (request.headers.get("User-Agent") or "unknown")[:120])
            db.set_setting(conn, "calendar_last_count", body.count("BEGIN:VEVENT"))
            conn.commit()
        return Response(body, mimetype="text/calendar", headers={
            "Cache-Control": "private, max-age=900",
            "Content-Disposition": 'inline; filename="my-nab.ics"'})
    finally:
        conn.close()
