"""Optional encryption of a budget file on disk (the Docker / NAS version).

A budget can be switched to an encrypted file (SQLCipher, AES-256). Then:

* The file itself is unreadable noise to anyone who copies it: a stolen drive, a copied folder, a cloud
  backup of the data folder, another app on the NAS.
* The file's random "data key" is never stored in the clear. Next to the file sits `<file>.keys`, which holds
  that key locked several ways: by the budget password, by a one-time recovery key, and by each passkey.
  Any one of them unlocks it.
* The server only holds the data key in memory while someone is signed in. It is dropped when the last
  device signs out or stays idle for LOCK_SECONDS (10 minutes by default), and it is never written to disk,
  so a restart always leaves the budget locked.

Needs the `sqlcipher3` package (requirements-secure.txt, installed in the Docker image only). Without it
AVAILABLE is False, encrypted files can't be opened, and the desktop programs behave exactly as before.

The key store lives in this process's memory, so an encrypted install must run ONE server process
(the Docker image does: one gunicorn worker with several threads).
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone

try:
    from sqlcipher3 import dbapi2 as _sqlcipher
except Exception:      # not installed (desktop programs, plain test runs)
    _sqlcipher = None

AVAILABLE = _sqlcipher is not None
LOCK_SECONDS = max(60, int(float(os.environ.get("NAB_LOCK_MINUTES", "10") or 10) * 60))
SQLITE_MAGIC = b"SQLite format 3\x00"
MIN_PASSWORD = 12      # an encrypted budget's password is all that stands between a copied data folder and your data
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}      # ~32 MB and a fraction of a second per password try


class Locked(Exception):
    """The budget is encrypted and this session doesn't (or no longer) hold its key."""


def is_encrypted_file(path):
    """True if the file is not a plain SQLite database (an empty or missing file is not encrypted)."""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
    except OSError:
        return False
    return len(head) == 16 and head != SQLITE_MAGIC


# ---- keys held in memory ----------------------------------------------------------------------------------
_lock = threading.RLock()
_KEYS = {}       # file path -> {"key": bytearray, "sessions": {session id: last activity (monotonic)}}


def _wipe(entry):
    for i in range(len(entry["key"])):
        entry["key"][i] = 0


def _sweep():
    """Forget idle sessions, and the key of any budget nobody is signed in to. Call with _lock held."""
    now = time.monotonic()
    for path, e in list(_KEYS.items()):
        for sid, seen in list(e["sessions"].items()):
            if now - seen > LOCK_SECONDS:
                del e["sessions"][sid]
        if not e["sessions"]:
            _wipe(e)
            del _KEYS[path]


def _sweeper():
    while True:
        time.sleep(15)
        with _lock:
            _sweep()


if AVAILABLE:      # nothing to forget without encryption support
    threading.Thread(target=_sweeper, daemon=True, name="nab-lock-sweeper").start()


def new_session(path, key):
    """Register a signed-in device for this budget (keeping its key in memory); returns its session id."""
    sid = secrets.token_urlsafe(24)
    with _lock:
        _sweep()
        e = _KEYS.get(path)
        if e and bytes(e["key"]) != key:       # a different key (e.g. a restored backup): the old one is stale
            _wipe(e)
            e = None
        if not e:
            e = _KEYS[path] = {"key": bytearray(key), "sessions": {}}
        e["sessions"][sid] = time.monotonic()
    return sid


def key_for(path, sid):
    """The key for a signed-in session (counts as activity). Raises Locked if there is none."""
    with _lock:
        _sweep()
        e = _KEYS.get(path)
        if not e or not sid or sid not in e["sessions"]:
            raise Locked()
        e["sessions"][sid] = time.monotonic()
        return bytes(e["key"])


def key_any(path):
    """The key if anyone is signed in to this budget (doesn't count as activity), else None. For work the server
    does by itself while someone is signed in: schema upgrades, the calendar feed."""
    with _lock:
        _sweep()
        e = _KEYS.get(path)
        return bytes(e["key"]) if e else None


def has_session(path, sid):
    with _lock:
        _sweep()
        e = _KEYS.get(path)
        return bool(e and sid and sid in e["sessions"])


def drop_session(path, sid):
    """This device signed out. The key goes too if it was the last one signed in."""
    with _lock:
        e = _KEYS.get(path)
        if e:
            e["sessions"].pop(sid, None)
            if not e["sessions"]:
                _wipe(e)
                del _KEYS[path]


def lock_now(path):
    """Forget the key and every signed-in device of this budget."""
    with _lock:
        e = _KEYS.pop(path, None)
        if e:
            _wipe(e)


# ---- connections --------------------------------------------------------------------------------------------
def _hexkey(key):
    return key.hex()


def connect(path, key):
    """A connection to an encrypted budget file. Raises Locked if the key doesn't open it."""
    if not AVAILABLE:
        raise RuntimeError("This server can't open encrypted budgets (the sqlcipher3 package isn't installed).")
    conn = _sqlcipher.connect(path)
    try:
        conn.execute(f"PRAGMA key = \"x'{_hexkey(key)}'\"")
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except _sqlcipher.DatabaseError:
        conn.close()
        raise Locked()
    conn.row_factory = _sqlcipher.Row
    return conn


# ---- the key file: the data key locked several ways ---------------------------------------------------------
def keys_path(path):
    return path + ".keys"


def _b64(b):
    return base64.b64encode(b).decode()


def _unb64(s):
    return base64.b64decode(s.encode())


def _b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _wrap(kek, key):
    """Lock a 32-byte key under kek: XOR with a keyed pseudo-random pad (a fresh nonce each time), then authenticate."""
    nonce = os.urandom(16)
    pad = hmac.new(kek, b"nab-wrap" + nonce, "sha256").digest()
    wrapped = bytes(a ^ b for a, b in zip(key, pad))
    tag = hmac.new(kek, b"nab-tag" + nonce + wrapped, "sha256").digest()
    return {"nonce": _b64(nonce), "wrapped": _b64(wrapped), "tag": _b64(tag)}


def _unwrap(kek, slot):
    try:
        nonce, wrapped, tag = _unb64(slot["nonce"]), _unb64(slot["wrapped"]), _unb64(slot["tag"])
    except Exception:
        return None
    good = hmac.new(kek, b"nab-tag" + nonce + wrapped, "sha256").digest()
    if not hmac.compare_digest(good, tag):
        return None
    pad = hmac.new(kek, b"nab-wrap" + nonce, "sha256").digest()
    return bytes(a ^ b for a, b in zip(wrapped, pad))


def _kek_password(password, params):
    return hashlib.scrypt(password.encode("utf-8"), salt=_unb64(params["salt"]), n=params["n"], r=params["r"],
                          p=params["p"], dklen=32, maxmem=128 * 1024 * 1024)


def _password_slot(password, key):
    params = {"salt": _b64(os.urandom(16)), **SCRYPT}
    return {**params, **_wrap(_kek_password(password, params), key)}


def _kek_secret(secret, label):
    return hmac.new(secret, b"nab-kek-" + label, "sha256").digest()


def _recovery_text(secret):
    s = base64.b32encode(secret).decode().rstrip("=")
    return "-".join(s[i:i + 4] for i in range(0, len(s), 4))


def _recovery_secret(text):
    s = "".join(ch for ch in (text or "").upper() if ch.isalnum())
    try:
        return base64.b32decode(s + "=" * (-len(s) % 8))
    except Exception:
        return None


def _load(path):
    try:
        with open(keys_path(path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _save(path, data):
    tmp = keys_path(path) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, keys_path(path))


def key_file_exists(path):
    return _load(path) is not None


def unlock_with_password(path, password):
    kf = _load(path)
    if not kf or not password:
        return None
    return _unwrap(_kek_password(password, kf["password"]), kf["password"])


def unlock_with_recovery(path, text):
    kf, secret = _load(path), _recovery_secret(text)
    if not kf or not secret or "recovery" not in kf:
        return None
    return _unwrap(_kek_secret(secret, b"recovery"), kf["recovery"])


def unlock_with_passkey(path, cred_id, prf_b64):
    kf = _load(path)
    if not kf:
        return None
    slot = next((p for p in kf.get("passkeys", []) if p["id"] == cred_id), None)
    try:
        prf = _unb64(prf_b64)
    except Exception:
        return None
    if not slot or len(prf) < 16:
        return None
    return _unwrap(_kek_secret(prf, b"passkey-" + cred_id.encode()), slot)


def set_password(path, key, password):
    kf = _load(path)
    kf["password"] = _password_slot(password, key)
    _save(path, kf)


def new_recovery_key(path, key):
    """Make (and store the lock for) a fresh recovery key. Returns it as text, to show once; the old one stops working."""
    kf = _load(path)
    secret = os.urandom(20)
    kf["recovery"] = _wrap(_kek_secret(secret, b"recovery"), key)
    _save(path, kf)
    return _recovery_text(secret)


def prf_salt(path):
    kf = _load(path)
    return kf["prf_salt"] if kf else None


def passkeys(path):
    kf = _load(path) or {}
    return [{"id": p["id"], "label": p.get("label", ""), "created": p.get("created", "")}
            for p in kf.get("passkeys", [])]


def has_recovery(path):
    kf = _load(path)
    return bool(kf and "recovery" in kf)


def add_passkey(path, key, cred_id, prf_b64, label):
    kf = _load(path)
    prf = _unb64(prf_b64)
    if len(prf) < 16:
        raise ValueError("That passkey didn't provide a usable secret")
    slot = {"id": cred_id, "label": (label or "Passkey")[:60],
            "created": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            **_wrap(_kek_secret(prf, b"passkey-" + cred_id.encode()), key)}
    kf["passkeys"] = [p for p in kf.get("passkeys", []) if p["id"] != cred_id] + [slot]
    _save(path, kf)


def remove_passkey(path, cred_id):
    kf = _load(path)
    kf["passkeys"] = [p for p in kf.get("passkeys", []) if p["id"] != cred_id]
    _save(path, kf)


# ---- converting a file ---------------------------------------------------------------------------------------
def _shred(path):
    """Overwrite a file with zeros before it is removed. Best effort: it can't reach copies kept by snapshots,
    journaling or copy-on-write file systems."""
    try:
        size = os.path.getsize(path)
        with open(path, "r+b") as f:
            chunk = b"\0" * (1 << 20)
            left = size
            while left > 0:
                f.write(chunk[:min(left, len(chunk))])
                left -= len(chunk)
            f.flush()
            os.fsync(f.fileno())
    except OSError:
        pass


def shred_and_remove(path):
    if os.path.exists(path):
        _shred(path)
        try:
            os.remove(path)
        except OSError:
            pass


def _tables(conn, schema):
    return [r[0] for r in conn.execute(
        f"SELECT name FROM {schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def _same_contents(conn, a, b):
    """True if schemas `a` and `b` of one connection hold the same tables with the same row counts."""
    ta, tb = _tables(conn, a), _tables(conn, b)
    if ta != tb:
        return False
    return all(conn.execute(f'SELECT count(*) FROM {a}."{t}"').fetchone()[0]
               == conn.execute(f'SELECT count(*) FROM {b}."{t}"').fetchone()[0] for t in ta)


def _clean_sidefiles(path):
    for suffix in ("-wal", "-shm", "-journal"):
        shred_and_remove(path + suffix)


def _export(src_conn, dest_path, dest_key_sql, other, src_path):
    """Copy everything in src_conn's main database into a new file (schema name `other`) while no one else can
    write to the source, and check the copy. `dest_key_sql` is the KEY clause ("x'...'" quoted, or an empty string)."""
    src_conn.execute(f"ATTACH DATABASE ? AS {other} KEY {dest_key_sql}", (dest_path,))
    src_conn.execute("BEGIN EXCLUSIVE")
    try:
        version = src_conn.execute("PRAGMA main.user_version").fetchone()[0]
        before = os.stat(src_path)
        src_conn.execute(f"SELECT sqlcipher_export('{other}')")
        src_conn.execute(f"PRAGMA {other}.user_version = {int(version)}")
        if src_conn.execute(f"PRAGMA {other}.integrity_check").fetchone()[0] != "ok" \
                or not _same_contents(src_conn, "main", other):
            raise RuntimeError("The new copy didn't pass its checks; nothing was changed.")
        src_conn.execute("COMMIT")
    except BaseException:
        try:
            src_conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    src_conn.execute(f"DETACH DATABASE {other}")
    return version, before


def encrypt_file(path, password):
    """Convert a plain budget file into an encrypted one, in place. Returns (data key, recovery key text).

    The encrypted copy is built beside the old file and checked (same tables and row counts, integrity ok, opens
    on its own with the new key) before anything is replaced. The old plain file is then overwritten with
    zeros and removed.
    """
    if not AVAILABLE:
        raise RuntimeError("Encryption isn't available on this server.")
    if is_encrypted_file(path):
        raise ValueError("This budget is already encrypted.")
    key = os.urandom(32)
    tmp = path + ".encrypting"
    shred_and_remove(tmp)
    src = _sqlcipher.connect(path, isolation_level=None)
    try:
        version, before = _export(src, tmp, "\"x'" + _hexkey(key) + "'\"", "enc", path)
    except BaseException:
        shred_and_remove(tmp)
        raise
    finally:
        src.close()
    try:
        check = connect(tmp, key)                           # does the copy open on its own, with just the key?
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok" \
                    or check.execute("PRAGMA user_version").fetchone()[0] != version:
                raise RuntimeError("The encrypted copy didn't pass its checks; nothing was changed.")
        finally:
            check.close()
        now = os.stat(path)
        if (now.st_mtime_ns, now.st_size) != (before.st_mtime_ns, before.st_size):
            raise RuntimeError("The budget changed while it was being encrypted. Nothing was changed; try again.")
        kf = {"v": 1, "prf_salt": _b64(os.urandom(32)), "password": _password_slot(password, key), "passkeys": []}
        secret = os.urandom(20)
        kf["recovery"] = _wrap(_kek_secret(secret, b"recovery"), key)
        _save(path, kf)
    except BaseException:
        shred_and_remove(tmp)
        raise
    _clean_sidefiles(path)
    _shred(path)                                            # the plain contents are overwritten...
    os.replace(tmp, path)                                   # ...and the encrypted file takes the plain file's place
    return key, _recovery_text(secret)


def decrypt_file(path, key):
    """Convert an encrypted budget file back to a plain one, in place, and remove its key file."""
    tmp = path + ".decrypting"
    shred_and_remove(tmp)
    src = connect(path, key)
    try:
        src.isolation_level = None
        version, before = _export(src, tmp, "''", "plaintext", path)
    except BaseException:
        shred_and_remove(tmp)
        raise
    finally:
        src.close()
    try:
        check = _sqlcipher.connect(tmp)
        try:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("The plain copy didn't pass its checks; nothing was changed.")
        finally:
            check.close()
        now = os.stat(path)
        if (now.st_mtime_ns, now.st_size) != (before.st_mtime_ns, before.st_size):
            raise RuntimeError("The budget changed while it was being converted. Nothing was changed; try again.")
    except BaseException:
        shred_and_remove(tmp)
        raise
    lock_now(path)
    _clean_sidefiles(path)
    os.replace(tmp, path)
    remove_key_file(path)


def remove_key_file(path):
    try:
        os.remove(keys_path(path))
    except OSError:
        pass
