"""Database schema, connection handling, and initialization.

All money is stored as INTEGER cents (e.g. $12.34 -> 1234).
Amounts are signed from the perspective of the account they belong to:
negative = outflow, positive = inflow.
Dates are 'YYYY-MM-DD' strings. Budget months are 'YYYY-MM' strings.
"""

import os
import contextlib
import logging
import re
import shutil
import sqlite3
from datetime import datetime

try:
    import fcntl
except ImportError:   # not available on Windows; upgrades just aren't cross-process locked
    fcntl = None

import secure

log = logging.getLogger("my-nab.db")

# Root data directory. Overridable via env so Docker can point it at a
# mounted volume. Derived from the legacy single-file NAB_DB_PATH (if set)
# so existing installs keep using the same volume without reconfiguring.
_LEGACY_DB_PATH = os.environ.get(
    "NAB_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "nab.db"),
)
DATA_DIR = os.path.dirname(_LEGACY_DB_PATH)
BUDGETS_DIR = os.path.join(DATA_DIR, "budgets")
REGISTRY_PATH = os.path.join(DATA_DIR, "registry.db")

# Multiple budgets live side by side as separate files under BUDGETS_DIR; this
# tiny registry db (outside of any one budget) tracks which ones exist and
# their display names — nothing sensitive. Each budget has its OWN password
# (stored in its own file's `settings` table, checked via get_setting), so
# opening one budget never grants access to another. The only thing that's
# still global is `secret_key`, since Flask needs it to sign the session
# cookie before any budget has even been chosen.
REGISTRY_SCHEMA = """
CREATE TABLE IF NOT EXISTS budgets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    filename   TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Per-device view settings (text size, favorites, ...), keyed by the User-Agent the
-- device identifies itself with, so a browser that lost its cache gets them back.
CREATE TABLE IF NOT EXISTS device_profiles (
    ua        TEXT PRIMARY KEY,
    data      TEXT NOT NULL DEFAULT '{}',
    last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'checking',   -- checking|savings|cash|credit|asset|liability
    on_budget  INTEGER NOT NULL DEFAULT 1,
    closed     INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    note       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS category_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_income  INTEGER NOT NULL DEFAULT 0,  -- the special Inflow group
    is_credit  INTEGER NOT NULL DEFAULT 0,  -- unused; the old auto Credit Card
                                             -- Payments group was this. Column
                                             -- kept (never written again) so a
                                             -- leftover group from an older
                                             -- version is still recognizable
                                             -- to the one-time cleanup migration.
    hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id          INTEGER NOT NULL,
    name              TEXT NOT NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    hidden            INTEGER NOT NULL DEFAULT 0,
    is_income         INTEGER NOT NULL DEFAULT 0,
    income_next_month INTEGER NOT NULL DEFAULT 0,  -- income held for next month's budget
    linked_account_id INTEGER,               -- unused; see is_credit above
    FOREIGN KEY (group_id) REFERENCES category_groups(id)
);

CREATE TABLE IF NOT EXISTS transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id          INTEGER NOT NULL,
    date                TEXT NOT NULL,           -- YYYY-MM-DD
    payee               TEXT DEFAULT '',
    category_id         INTEGER,                 -- NULL for transfers / uncategorized
    memo                TEXT DEFAULT '',
    amount              INTEGER NOT NULL DEFAULT 0,  -- cents, signed
    cleared             INTEGER NOT NULL DEFAULT 0,  -- 0 uncleared, 1 cleared, 2 reconciled
    transfer_account_id INTEGER,                 -- other side of a transfer
    transfer_txn_id     INTEGER,                 -- linked mirror transaction id
    import_id           TEXT,                    -- bank FITID (OFX/QFX) for exact dedupe
    import_batch_id     INTEGER,                 -- groups an import so it can be undone
    scheduled_id        INTEGER,                 -- auto-entered from this scheduled transaction, if any
    import_review       INTEGER NOT NULL DEFAULT 0,  -- 1 = came in through an import and hasn't been checked yet
    sched_due           TEXT,                    -- the due date of the scheduled occurrence this entry is (its own date can move when paid)
    paid_at             TEXT,                    -- when a scheduled entry was marked paid (orders the Paid rows on the Scheduled page)
    created_at          TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

-- A recurring (or one-time "Never" repeat) transaction template. Occurrences
-- are auto-entered into `transactions` (with scheduled_id set) once within
-- `due_soon_days` of next_date, which is then advanced to the following
-- occurrence per `frequency`.
CREATE TABLE IF NOT EXISTS scheduled_transactions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id          INTEGER NOT NULL,
    payee               TEXT DEFAULT '',
    category_id         INTEGER,                 -- NULL for transfers / uncategorized
    transfer_account_id INTEGER,
    memo                TEXT DEFAULT '',
    amount              INTEGER NOT NULL DEFAULT 0,  -- cents, signed
    next_date           TEXT NOT NULL,           -- YYYY-MM-DD, the next due date
    frequency           TEXT NOT NULL DEFAULT 'Every Month',
    cal_alert           INTEGER NOT NULL DEFAULT 1,  -- show in the calendar feed
    cal_time            TEXT NOT NULL DEFAULT '',    -- 'HH:MM', or '' for an all-day event
    created_at          TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS import_batches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now')),
    source     TEXT,                             -- ofx | csv | actual
    account_id INTEGER,
    note       TEXT DEFAULT '',
    txn_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
    month       TEXT NOT NULL,       -- YYYY-MM
    category_id INTEGER NOT NULL,
    budgeted    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, category_id)
);

-- Carry-forward toggle EVENTS for a category, not a per-month flag: a row
-- means "starting this month, carry (1) or stop carrying (0)" — whichever
-- state was last set stays in effect for every following month until the
-- next event. So turning it on in March keeps carrying March, April, May...
-- forward indefinitely until the user turns it off in some later month.
CREATE TABLE IF NOT EXISTS carryover (
    month       TEXT NOT NULL,       -- YYYY-MM this toggle takes effect from
    category_id INTEGER NOT NULL,
    carry       INTEGER NOT NULL DEFAULT 1,   -- 1 = start carrying, 0 = stop
    PRIMARY KEY (month, category_id)
);

-- A transaction can be split across several categories. When it has splits,
-- the transaction's own category_id is NULL and these rows carry the detail.
CREATE TABLE IF NOT EXISTS transaction_splits (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    category_id    INTEGER,
    amount         INTEGER NOT NULL DEFAULT 0,   -- cents, signed
    memo           TEXT DEFAULT '',
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);
CREATE INDEX IF NOT EXISTS idx_split_txn ON transaction_splits(transaction_id);

CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
"""


def connect_budget(path, sid=None):
    """Open a budget file: plain SQLite, or SQLCipher with the budget's key when the file is encrypted.
    A request passes its session id (which counts as activity and must still be signed in); server-side work
    with no session of its own (schema upgrades, the calendar feed) borrows the key while someone is signed in.
    Raises secure.Locked when the file is encrypted and there is no key for it."""
    if secure.is_encrypted_file(path):
        key = secure.key_for(path, sid) if sid else secure.key_any(path)
        if key is None:
            raise secure.Locked()
        return secure.connect(path, key)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def get_registry_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(REGISTRY_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate_legacy_single_file(reg):
    """First-boot only: if the registry has no budgets yet, adopt whatever's
    at the legacy single-file path (an existing pre-multi-budget install,
    with the user's real data and its own password already set) as
    'Budget 1', or create an empty one if there's nothing there yet (fresh
    install). Uses shutil.move rather than os.rename/os.replace since
    BUDGETS_DIR may be on a different filesystem than the legacy path (same
    class of bug as the backup-restore fix)."""
    if reg.execute("SELECT 1 FROM budgets LIMIT 1").fetchone():
        return
    os.makedirs(BUDGETS_DIR, exist_ok=True)
    dest = os.path.join(BUDGETS_DIR, "budget-1.db")
    if os.path.exists(_LEGACY_DB_PATH) and not os.path.exists(dest):
        shutil.move(_LEGACY_DB_PATH, dest)
    reg.execute(
        "INSERT INTO budgets (name, filename) VALUES ('Budget 1', 'budget-1.db')")
    reg.commit()
    if os.path.exists(dest):
        upgrade_budget(dest)   # an adopted older file: backs it up first
    else:
        init_schema(dest)      # fresh install: an empty but complete budget to set a password on


def _reclaim_password_from_registry(reg):
    """Idempotent cleanup for installs that briefly went through an earlier
    version of multi-budget support where login was global (password_hash
    lived in the registry's app_settings, not in any budget file). If found,
    move it back down into whichever budget was 'active' back then (or the
    first budget, if that's unset) so it keeps working as that budget's
    password under the current per-budget-password model. No-op once the
    leftover key is gone, which it is after the first run."""
    row = reg.execute("SELECT value FROM app_settings WHERE key='password_hash'").fetchone()
    if row:
        active = reg.execute(
            "SELECT value FROM app_settings WHERE key='active_budget_id'").fetchone()
        target_id = int(active["value"]) if active else None
        if target_id is None:
            first = reg.execute("SELECT id FROM budgets ORDER BY id LIMIT 1").fetchone()
            target_id = first["id"] if first else None
        brow = reg.execute(
            "SELECT filename FROM budgets WHERE id=?", (target_id,)).fetchone() \
            if target_id is not None else None
        if brow:
            bpath = os.path.join(BUDGETS_DIR, brow["filename"])
            if os.path.exists(bpath):
                bconn = sqlite3.connect(bpath)
                bconn.row_factory = sqlite3.Row
                try:
                    if get_setting(bconn, "password_hash") is None:
                        set_setting(bconn, "password_hash", row["value"])
                        bconn.commit()
                finally:
                    bconn.close()
    reg.execute("DELETE FROM app_settings WHERE key IN ('password_hash', 'active_budget_id')")
    reg.commit()


def ensure_ready():
    """App-startup entry point: make sure the registry exists, migrate a
    pre-multi-budget single-file install into 'Budget 1' on first boot, and
    clean up any leftover global password from an earlier multi-budget
    design. Does not touch any other budget's schema — that happens lazily
    (via init_schema) whenever a budget is created or opened."""
    reg = get_registry_db()
    try:
        reg.executescript(REGISTRY_SCHEMA)
        reg.commit()
        _migrate_legacy_single_file(reg)
        _reclaim_password_from_registry(reg)
    finally:
        reg.close()


def get_app_setting(key, default=None):
    reg = get_registry_db()
    try:
        row = reg.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        reg.close()


def set_app_setting(key, value):
    reg = get_registry_db()
    try:
        reg.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)))
        reg.commit()
    finally:
        reg.close()


def budget_path(bid):
    reg = get_registry_db()
    try:
        row = reg.execute("SELECT filename FROM budgets WHERE id=?", (bid,)).fetchone()
        if not row:
            raise ValueError("No such budget")
        return os.path.join(BUDGETS_DIR, row["filename"])
    finally:
        reg.close()


def list_budgets():
    """Public picker data: name + whether it has a password set yet. Never
    includes anything from inside a budget file besides that one flag."""
    reg = get_registry_db()
    try:
        rows = reg.execute(
            "SELECT id, name, filename, created_at FROM budgets ORDER BY id").fetchall()
    finally:
        reg.close()
    out = []
    for r in rows:
        path = os.path.join(BUDGETS_DIR, r["filename"])
        needs_setup = True
        encrypted = secure.is_encrypted_file(path)
        if encrypted:
            needs_setup = False          # (it can't be opened without its key; it was set up before it was encrypted)
        elif os.path.exists(path):
            bconn = sqlite3.connect(path)
            bconn.row_factory = sqlite3.Row
            try:
                needs_setup = get_setting(bconn, "password_hash") is None
            except sqlite3.Error:
                needs_setup = True
            finally:
                bconn.close()
        out.append({"id": r["id"], "name": r["name"], "created_at": r["created_at"],
                     "needs_setup": needs_setup, "encrypted": encrypted,
                     "passkeys": bool(encrypted and secure.passkeys(path))})
    return out


def create_budget(name):
    """Create a new, empty, password-less budget (needs_setup) alongside any
    existing ones. Does not open or otherwise touch any other budget."""
    reg = get_registry_db()
    try:
        cur = reg.execute("INSERT INTO budgets (name, filename) VALUES (?, '')", (name,))
        bid = cur.lastrowid
        filename = f"budget-{bid}.db"
        reg.execute("UPDATE budgets SET filename=? WHERE id=?", (filename, bid))
        reg.commit()
    finally:
        reg.close()
    init_schema(os.path.join(BUDGETS_DIR, filename))
    return bid


def rename_budget(bid, name):
    reg = get_registry_db()
    try:
        if not reg.execute("SELECT 1 FROM budgets WHERE id=?", (bid,)).fetchone():
            raise ValueError("No such budget")
        reg.execute("UPDATE budgets SET name=? WHERE id=?", (name, bid))
        reg.commit()
    finally:
        reg.close()


def delete_budget(bid):
    """Delete a budget's file entirely, even if it's the only one left — the
    picker falls back to "create a new budget" when none remain. Password
    verification (when the budget has one set) is the caller's job."""
    reg = get_registry_db()
    try:
        rows = reg.execute("SELECT id, filename FROM budgets ORDER BY id").fetchall()
        target = next((r for r in rows if r["id"] == bid), None)
        if not target:
            raise ValueError("No such budget")
        filename = target["filename"]
        reg.execute("DELETE FROM budgets WHERE id=?", (bid,))
        reg.commit()
    finally:
        reg.close()
    path = os.path.join(BUDGETS_DIR, filename)
    secure.lock_now(path)
    if os.path.exists(path):
        os.remove(path)
    secure.remove_key_file(path)


def get_db_for(bid):
    """A connection to a specific budget by id — used by the open/setup flow,
    which by definition runs before any budget is 'open' in the session."""
    path = budget_path(bid)
    if not os.path.exists(path):
        init_schema(path)            # e.g. a registry row whose file was never created
    elif path not in _CHECKED_SCHEMA:
        upgrade_budget(path)
    conn = connect_budget(path)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def current_budget_id():
    from flask import session
    bid = session.get("open_budget_id")
    if not bid:
        raise RuntimeError("No budget open")
    return bid


def current_budget_path():
    return budget_path(current_budget_id())


# ---- Schema versioning ----------------------------------------------------
# Each budget file stores the schema version it was last upgraded to in SQLite's
# `PRAGMA user_version`. When this release needs a newer one, the file is copied
# to <data>/backups/ first, then init_schema() (which holds every migration, all
# idempotent) brings it up to date. To add a migration: put it in init_schema()
# and bump SCHEMA_VERSION.
SCHEMA_VERSION = 8   # v2: transfers keep a real payee; v3: transactions.sched_auto; v4: device_profiles; v5: account_links; v6: transactions.import_review; v7: import_memory; v8: transactions.sched_due / paid_at
KEEP_BACKUPS = 10   # automatic pre-upgrade backups kept per budget file

BACKUPS_DIR = os.path.join(DATA_DIR, "backups")
_CHECKED_SCHEMA = set()   # files already confirmed current by this process


def schema_version(path):
    conn = connect_budget(path)
    try:
        return conn.execute("PRAGMA user_version").fetchone()[0]
    finally:
        conn.close()


def list_upgrade_backups(path):
    """Automatic pre-upgrade backups of one budget file, newest first."""
    stem = os.path.splitext(os.path.basename(path))[0]
    if not os.path.isdir(BACKUPS_DIR):
        return []
    def stamp(n):   # <stem>-v<version>-<YYYYmmdd-HHMMSS>.db
        m = re.search(r"-(\d{8}-\d{6})\.db$", n)
        return m.group(1) if m else ""
    names = sorted((n for n in os.listdir(BACKUPS_DIR)
                    if n.startswith(stem + "-v") and n.endswith(".db")), key=stamp, reverse=True)
    return [{"name": n, "size": os.path.getsize(os.path.join(BACKUPS_DIR, n))} for n in names]


def _backup_budget(path, old_version):
    """Consistent copy (SQLite's own backup API, safe mid-write) of a budget file."""
    os.makedirs(BACKUPS_DIR, exist_ok=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(BACKUPS_DIR, f"{stem}-v{old_version}-{stamp}.db")
    src = connect_budget(path)
    key = secure.key_any(path) if secure.is_encrypted_file(path) else None
    dst = secure.connect(dest, key) if key else sqlite3.connect(dest)   # an encrypted budget's backup is encrypted too
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    for old in list_upgrade_backups(path)[KEEP_BACKUPS:]:
        try:
            os.remove(os.path.join(BACKUPS_DIR, old["name"]))
        except OSError:
            pass
    return dest


@contextlib.contextmanager
def _upgrade_lock():
    """One upgrade at a time across gunicorn workers (a second one waits, then
    sees the file is already current)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    fh = open(os.path.join(DATA_DIR, ".upgrade.lock"), "w")
    try:
        if fcntl:
            fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fh.close()   # closing releases the lock


def upgrade_budget(path):
    """If this budget file is older than SCHEMA_VERSION: back it up, then upgrade
    its schema. Returns the backup path when it upgraded, else None. A file from
    a NEWER release is left alone."""
    if not os.path.exists(path):
        return None
    if schema_version(path) >= SCHEMA_VERSION:
        _CHECKED_SCHEMA.add(path)
        return None
    with _upgrade_lock():
        old = schema_version(path)        # may have been upgraded while we waited
        if old >= SCHEMA_VERSION:
            _CHECKED_SCHEMA.add(path)
            return None
        backup = _backup_budget(path, old)
        init_schema(path)
        _CHECKED_SCHEMA.add(path)
        log.warning("Upgraded %s from schema v%s to v%s (backup: %s)",
                    os.path.basename(path), old, SCHEMA_VERSION, backup)
        return backup


def upgrade_all_budgets():
    """At startup: bring every budget file up to date right away."""
    reg = get_registry_db()
    try:
        files = [r["filename"] for r in reg.execute("SELECT filename FROM budgets")]
    finally:
        reg.close()
    for name in files:
        if secure.is_encrypted_file(os.path.join(BUDGETS_DIR, name)):
            continue      # locked at startup; it is brought up to date when it is opened
        try:
            upgrade_budget(os.path.join(BUDGETS_DIR, name))
        except Exception:
            log.exception("Could not upgrade %s", name)   # don't stop the app starting


def get_db():
    from flask import session
    path = current_budget_path()
    conn = connect_budget(path, session.get("sid") if secure.is_encrypted_file(path) else None)   # Locked if signed out / idle
    if path not in _CHECKED_SCHEMA:
        conn.close()
        upgrade_budget(path)     # e.g. a login left open across an upgrade
        conn = connect_budget(path, session.get("sid") if secure.is_encrypted_file(path) else None)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Bank rows that were matched into an existing register entry (see
# api/transactions.py: match). The matched-into transaction keeps the user's
# own date/payee, so the bank's original identity is remembered here and checked
# by the importers — that's what stops a re-import from adding the row again.
IMPORT_SIGNATURES_DDL = """
CREATE TABLE IF NOT EXISTS import_signatures (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    txn_id     INTEGER NOT NULL,         -- the register transaction it was matched into
    import_id  TEXT,                     -- the bank's FITID, if it had one
    date       TEXT NOT NULL,            -- the bank's posting date
    payee      TEXT NOT NULL DEFAULT '',
    amount     INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sig_lookup ON import_signatures(account_id, amount, date);
"""


# Which of your accounts a bank file belongs to. A QFX/OFX file names its account (bank id + account number);
# the first time one is imported you say which account it is, and it is remembered. Only a one-way hash of the
# bank id + account number is kept (plus the last four digits to show), never the number itself.
ACCOUNT_LINKS_DDL = """
CREATE TABLE IF NOT EXISTS account_links (
    key        TEXT PRIMARY KEY,         -- sha256 of "bank id|account number"
    account_id INTEGER NOT NULL,
    hint       TEXT NOT NULL DEFAULT '', -- last four digits, for display
    org        TEXT NOT NULL DEFAULT '', -- the bank's name as the file gives it
    created_at TEXT DEFAULT (datetime('now'))
);
"""


# What the importer has learned is worked out from your transactions each time (which payee had which category, which
# bank wording you matched to which payee). This table only holds the changes you make to that in Settings:
#   kind 'category': key = the payee's fingerprint, value = the category id to use
#   kind 'alias':    key = the bank wording's fingerprint, value = the payee it should be matched to
# and a row with forgotten = 1 switches a learned entry off.
IMPORT_MEMORY_DDL = """
CREATE TABLE IF NOT EXISTS import_memory (
    kind      TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT,
    label     TEXT NOT NULL DEFAULT '',
    forgotten INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, key)
);
"""


def ensure_import_memory(conn):
    conn.executescript(IMPORT_MEMORY_DDL)


def ensure_account_links(conn):
    """Idempotent; also called lazily, like ensure_import_signatures."""
    conn.executescript(ACCOUNT_LINKS_DDL)


def ensure_import_signatures(conn):
    """Idempotent; also called lazily because a session that stayed open across
    an upgrade never re-opens its budget, so never ran init_schema's migration."""
    conn.executescript(IMPORT_SIGNATURES_DDL)


def init_schema(path):
    """Create/upgrade the schema for one budget db file and seed its system
    category groups if empty."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = connect_budget(path)
    try:
        conn.executescript(SCHEMA)
        conn.executescript(ACCOUNT_LINKS_DDL)
        conn.executescript(IMPORT_MEMORY_DDL)
        was = conn.execute("PRAGMA user_version").fetchone()[0]

        # Lightweight migrations for databases created before a column existed.
        # Must run after executescript() but before the import_id index below,
        # since older databases won't have that column yet.
        txn_cols = {r[1] for r in conn.execute("PRAGMA table_info(transactions)")}
        if "import_id" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN import_id TEXT")
        if "import_batch_id" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN import_batch_id INTEGER")
        if "scheduled_id" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN scheduled_id INTEGER")
        if "import_review" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN import_review INTEGER NOT NULL DEFAULT 0")
        # Fixing an imported transaction's category counts as having checked it.
        conn.execute("CREATE TRIGGER IF NOT EXISTS trg_import_review_cleared AFTER UPDATE OF category_id ON transactions "
                     "WHEN OLD.import_review = 1 AND OLD.category_id IS NOT NEW.category_id "
                     "BEGIN UPDATE transactions SET import_review = 0 WHERE id = NEW.id; END"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_review ON transactions(import_review) WHERE import_review = 1")
        if "sched_due" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN sched_due TEXT")
            # Entries a schedule already put in the register were due on the date they carry.
            conn.execute("UPDATE transactions SET sched_due=date WHERE scheduled_id IS NOT NULL AND sched_auto=1")
        if "paid_at" not in txn_cols:
            conn.execute("ALTER TABLE transactions ADD COLUMN paid_at TEXT")
        # When a scheduled entry becomes paid (cleared), note the moment, so the Scheduled page can list payments in the order made.
        conn.execute("CREATE TRIGGER IF NOT EXISTS trg_sched_paid AFTER UPDATE OF cleared ON transactions "
                     "WHEN OLD.cleared = 0 AND NEW.cleared <> 0 AND NEW.scheduled_id IS NOT NULL "
                     "BEGIN UPDATE transactions SET paid_at = datetime('now') WHERE id = NEW.id; END")
        conn.execute("CREATE TRIGGER IF NOT EXISTS trg_sched_unpaid AFTER UPDATE OF cleared ON transactions "
                     "WHEN OLD.cleared <> 0 AND NEW.cleared = 0 "
                     "BEGIN UPDATE transactions SET paid_at = NULL WHERE id = NEW.id; END")
        if "version" not in txn_cols:
            # Optimistic-concurrency counter: bumped on every edit so two
            # people editing the same row at once can be detected instead of
            # one silently clobbering the other's change.
            conn.execute(
                "ALTER TABLE transactions ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
        if "sched_auto" not in txn_cols:
            # 1 = this entry was put in the register BY a schedule (not a payment the user
            # attached to it as history), so deleting/editing the schedule may remove/rewrite it.
            conn.execute("ALTER TABLE transactions ADD COLUMN sched_auto INTEGER NOT NULL DEFAULT 0")
            if was < 3:   # entries already waiting on a schedule were entered by it
                conn.execute("UPDATE transactions SET sched_auto=1 "
                             "WHERE scheduled_id IS NOT NULL AND cleared=0")
        sched_cols = {r[1] for r in conn.execute("PRAGMA table_info(scheduled_transactions)")}
        if "cal_alert" not in sched_cols:
            conn.execute("ALTER TABLE scheduled_transactions "
                         "ADD COLUMN cal_alert INTEGER NOT NULL DEFAULT 1")
        if "cal_time" not in sched_cols:
            conn.execute("ALTER TABLE scheduled_transactions "
                         "ADD COLUMN cal_time TEXT NOT NULL DEFAULT ''")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_import "
                     "ON transactions(account_id, import_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_batch "
                     "ON transactions(import_batch_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_txn_scheduled "
                     "ON transactions(scheduled_id)")

        cat_cols = {r[1] for r in conn.execute("PRAGMA table_info(categories)")}
        if "income_next_month" not in cat_cols:
            conn.execute("ALTER TABLE categories ADD COLUMN "
                         "income_next_month INTEGER NOT NULL DEFAULT 0")

        carry_cols = {r[1] for r in conn.execute("PRAGMA table_info(carryover)")}
        if "carry" not in carry_cols:
            # Pre-existing rows only ever existed for "on" months, so they're
            # all "start carrying" events under the new toggle-event model.
            conn.execute("ALTER TABLE carryover ADD COLUMN carry INTEGER NOT NULL DEFAULT 1")

        # Replay dedupe for offline-queued writes: the client tags each write
        # with a unique op id, so a retry of one that already landed (response
        # lost on a flaky connection) returns the original result instead of
        # applying twice.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS op_log ("
            "op_id TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, "
            "created_at TEXT NOT NULL DEFAULT (datetime('now')))")

        ensure_import_signatures(conn)

        if was < 2:
            # Transfers used to be stored with an auto-generated payee ("Transfer : <account>"),
            # which just repeated the Category column. The payee is now a real payee (possibly
            # blank) and the other account shows only as the category; clear the old text.
            conn.execute("UPDATE transactions SET payee='' "
                         "WHERE transfer_txn_id IS NOT NULL AND payee LIKE 'Transfer : %'")

        _remove_credit_card_payments_feature(conn)
        _seed_system_groups(conn)
        if conn.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()
    finally:
        conn.close()


def _remove_credit_card_payments_feature(conn):
    """One-time cleanup, run on every open: earlier versions auto-created a
    'Credit Card Payments' group with one linked payment category per credit
    account, and auto-routed credit-card activity through it. That's gone —
    a credit account is now budgeted exactly like any other on-budget
    account — so strip out any leftover group/categories/budgeted amounts
    from before this version. No-op once already cleaned up (the group won't
    exist to find)."""
    row = conn.execute(
        "SELECT id FROM category_groups WHERE is_credit = 1").fetchone()
    if row is None:
        return
    gid = row["id"]
    members = "(SELECT id FROM categories WHERE group_id=?)"
    conn.execute(f"UPDATE transactions SET category_id=NULL WHERE category_id IN {members}", (gid,))
    conn.execute(f"UPDATE transaction_splits SET category_id=NULL WHERE category_id IN {members}", (gid,))
    conn.execute(f"DELETE FROM budgets WHERE category_id IN {members}", (gid,))
    conn.execute(f"DELETE FROM carryover WHERE category_id IN {members}", (gid,))
    conn.execute("DELETE FROM categories WHERE group_id=?", (gid,))
    conn.execute("DELETE FROM category_groups WHERE id=?", (gid,))


def _seed_system_groups(conn):
    """Ensure the special Inflow group + income categories exist. Shared by
    init_schema() (first run) and reset_all_data() (after wiping a budget
    back to empty)."""
    # Seed the special Inflow group + income categories.
    row = conn.execute(
        "SELECT id FROM category_groups WHERE is_income = 1"
    ).fetchone()
    if row is None:
        cur = conn.execute(
            "INSERT INTO category_groups (name, sort_order, is_income) "
            "VALUES ('Inflow', -100, 1)"
        )
        gid = cur.lastrowid
    else:
        gid = row["id"]

    # Classic income buckets: income earned this month can be budgeted
    # this month or held for next month's budget. Ensure both exist and give
    # the legacy "To be Budgeted" category its clearer this-month name.
    conn.execute(
        "UPDATE categories SET name='Income for This Month' "
        "WHERE group_id=? AND is_income=1 AND income_next_month=0 "
        "AND name='To be Budgeted'", (gid,))
    if not conn.execute(
            "SELECT id FROM categories WHERE group_id=? AND is_income=1 "
            "AND income_next_month=0", (gid,)).fetchone():
        conn.execute(
            "INSERT INTO categories (group_id, name, sort_order, is_income, "
            "income_next_month) VALUES (?, 'Income for This Month', 0, 1, 0)",
            (gid,))
    if not conn.execute(
            "SELECT id FROM categories WHERE group_id=? AND is_income=1 "
            "AND income_next_month=1", (gid,)).fetchone():
        conn.execute(
            "INSERT INTO categories (group_id, name, sort_order, is_income, "
            "income_next_month) VALUES (?, 'Income for Next Month', 1, 1, 1)",
            (gid,))


# Tables that hold budget *content* (accounts, categories, transactions, ...)
# as opposed to app-level `settings` (password, preferences) — wiped by
# reset_all_data() but never touched by it.
_CONTENT_TABLES = (
    "transaction_splits", "transactions", "scheduled_transactions",
    "import_batches", "import_signatures", "account_links", "import_memory", "budgets", "carryover", "categories",
    "category_groups", "accounts",
)


def reset_all_data(conn):
    """Wipe every account, category, transaction, budget entry, and scheduled
    transaction so the user can start a new budget from scratch, then re-seed
    the system category groups. The login password and app preferences (in
    `settings`) are left untouched."""
    ensure_import_signatures(conn)
    ensure_account_links(conn)
    ensure_import_memory(conn)
    for table in _CONTENT_TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.execute(
        "DELETE FROM sqlite_sequence WHERE name IN ({})".format(
            ",".join("?" * len(_CONTENT_TABLES))),
        _CONTENT_TABLES)
    _seed_system_groups(conn)
    conn.commit()


def roll_demo_forward(path):
    """A demo budget remembers the month its dates were generated for (the `demo_anchor` setting).
    Opening it in a later month slides every date forward by that many months, so the demo always
    looks current. Does nothing for a normal budget (it has no such setting)."""
    conn = connect_budget(path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key='demo_anchor'").fetchone()
        if not row or not row[0]:
            return
        today = datetime.now()
        ay, am = (int(x) for x in row[0].split("-"))
        delta = (today.year * 12 + today.month) - (ay * 12 + am)
        if delta <= 0:
            return

        def shift(value):
            y, m, rest = int(value[:4]), int(value[5:7]), value[7:]
            i = y * 12 + (m - 1) + delta
            return f"{i // 12:04d}-{i % 12 + 1:02d}{rest}"
        conn.create_function("shift_months", 1, shift)
        conn.execute("UPDATE transactions SET date = shift_months(date)")
        conn.execute("UPDATE scheduled_transactions SET next_date = shift_months(next_date)")
        # (month is part of these tables' keys, so shift in two steps to avoid a half-way collision)
        for table in ("budgets", "carryover"):
            conn.execute(f"UPDATE {table} SET month = 'x' || shift_months(month)")
            conn.execute(f"UPDATE {table} SET month = substr(month, 2)")
        conn.execute("UPDATE settings SET value=? WHERE key='demo_anchor'", (f"{today.year:04d}-{today.month:02d}",))
        conn.commit()
    finally:
        conn.close()


def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def income_category_id(conn):
    # The "this month" income bucket is the default target for imported income.
    row = conn.execute(
        "SELECT id FROM categories WHERE is_income = 1 "
        "ORDER BY income_next_month, id LIMIT 1"
    ).fetchone()
    return row["id"] if row else None
