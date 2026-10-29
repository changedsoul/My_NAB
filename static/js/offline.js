/* Offline support: an outbox of queued writes (IndexedDB) that replays against
 * the server when it's reachable again, plus an overlay that shows queued
 * changes on top of cached reads so the UI reflects them immediately.
 *
 * Scope: transactions (add/edit/delete) and budget-cell assignments. Server-
 * computed budget numbers (To Be Budgeted, Available, ...) are NOT recomputed
 * locally — they stay as last seen until the queue syncs and the server
 * recomputes. budget_engine.py remains the single source of truth. */
"use strict";

const Outbox = (() => {
  const DB_NAME = "nab-offline", STORE = "ops";
  const SEND_TIMEOUT_MS = 20000;
  const RETRY_MS = 30000;
  const PROBE_MS = 20000;

  let idb = null;
  let available = false;
  let ops = [];                 // memory mirror of the store, ordered by seq
  const inflight = new Set();   // seqs currently being sent (memory only)
  let nextTemp = -1;            // temp ids for offline-created transactions are negative
  let draining = false;
  let offline = false;          // last server contact failed (or served from cache)
  let retryTimer = null;
  let swError = null;           // why service-worker registration failed, if it did
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const listeners = new Set();
  const txnIndex = new Map();   // id -> last server-seen txn facts, for account-balance deltas
  const catNames = new Map();   // category id -> name, for rows shown before sync

  const emit = () => listeners.forEach((f) => { try { f(); } catch {} });
  const offlineError = (msg) => {
    const e = new Error(msg || "You're offline — this change needs a connection.");
    e.offline = true;
    return e;
  };
  const newOpId = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---- IndexedDB plumbing -------------------------------------------------
  const openDb = () => new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error("no indexedDB"));
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, {keyPath: "seq", autoIncrement: true});
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const store = (mode, fn) => new Promise((res, rej) => {
    const t = idb.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req && req.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
  const plain = (op) => { const {...o} = op; return o; };
  const persist = (op) => store("readwrite", (s) => s.put(plain(op))).catch(() => {});
  const remove = async (op) => {
    ops = ops.filter((o) => o !== op);
    await store("readwrite", (s) => s.delete(op.seq)).catch(() => {});
  };
  const add = async (op) => {
    op.seq = await store("readwrite", (s) => s.add(plain(op)));
    ops.push(op);
    ops.sort((a, b) => a.seq - b.seq);
  };

  async function init() {
    try {
      idb = await openDb();
      ops = (await store("readonly", (s) => s.getAll())) || [];
      ops.sort((a, b) => a.seq - b.seq);
      const temps = ops.map((o) => o.tempId).filter((t) => t !== undefined);
      nextTemp = Math.min(-1, ...temps.map((t) => t - 1));
      available = true;
    } catch { available = false; }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((e) => { swError = e.message || String(e); });
    }
    window.addEventListener("online", () => drain());
    window.addEventListener("offline", () => setOffline(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") drain();
    });
    readyResolve();
    emit();
  }

  // ---- What can be queued -------------------------------------------------
  const TXN_ID = /^\/transactions\/(-?\d+)$/;
  function canQueue(method, path) {
    if (!available) return false;
    if (method === "POST") return path === "/transactions" || path === "/budget";
    if (method === "PUT" || method === "DELETE") return TXN_ID.test(path);
    return false;
  }

  const mine = () => ops.filter((o) => o.budgetId === State.budgetId);
  const pendingOps = () => mine().filter((o) => o.state === "pending");
  const hasPending = () => pendingOps().length > 0;

  // ---- Enqueue (with coalescing so the queue stays small) -----------------
  async function enqueue(method, path, body, opId) {
    if (!available) throw offlineError();
    const budgetId = State.budgetId;
    const live = (o) => o.budgetId === budgetId && o.state === "pending" && !inflight.has(o.seq);
    const append = async (extra = {}) => {
      const op = {opId, budgetId, method, path, body: body === undefined ? undefined : structuredClone(body),
        state: "pending", createdAt: Date.now(), ...extra};
      await add(op);
      emit();
      // While we already know the server is unreachable a send attempt just
      // fails — and would mark this op in-flight, blocking later edits from
      // merging into it. The retry timer / "online" event handle recovery.
      if (!offline) drain();
      return op;
    };

    if (method === "POST" && path === "/transactions") {
      const tempId = nextTemp--;
      await append({tempId});
      return {ok: true, id: tempId, pending: true};
    }

    if (method === "POST" && path === "/budget") {
      const p = ops.find((o) => live(o) && o.path === "/budget" &&
        o.body.month === body.month && o.body.category_id === body.category_id);
      if (p) { p.body = structuredClone(body); await persist(p); emit(); if (!offline) drain(); return {ok: true, pending: true}; }
      await append();
      return {ok: true, pending: true};
    }

    const m = path.match(TXN_ID);
    const id = Number(m[1]);

    if (method === "PUT") {
      if (id < 0) {
        const c = ops.find((o) => live(o) && o.tempId === id);
        if (c) {
          const {version, ...rest} = body || {};
          c.body = {...c.body, ...structuredClone(rest)};
          await persist(c); emit();
          return {ok: true, pending: true, version: 1};
        }
        if (!ops.some((o) => o.budgetId === budgetId && o.tempId === id)) {
          throw offlineError("This item hasn't synced yet — try again once you're back online.");
        }
      } else {
        const p = ops.find((o) => live(o) && o.method === "PUT" && o.path === path);
        if (p) {
          p.body = {...p.body, ...structuredClone(body), version: p.body.version};
          await persist(p); emit();
          return {ok: true, pending: true, version: (p.body.version || 0) + 1};
        }
      }
      await append();
      return {ok: true, pending: true, version: ((body && body.version) || 0) + 1};
    }

    // DELETE
    if (id < 0) {
      const c = ops.find((o) => live(o) && o.tempId === id);
      if (c) {
        for (const o of ops.filter((o) => live(o) && (o === c || o.path === path))) await remove(o);
        emit();
        return {ok: true, pending: true};
      }
      if (!ops.some((o) => o.budgetId === budgetId && o.tempId === id)) {
        throw offlineError("This item hasn't synced yet — try again once you're back online.");
      }
    } else {
      for (const o of ops.filter((o) => live(o) && o.method === "PUT" && o.path === path)) await remove(o);
    }
    await append();
    return {ok: true, pending: true};
  }

  // ---- Replay -------------------------------------------------------------
  async function sendOp(op) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), SEND_TIMEOUT_MS);
    try {
      const headers = {"X-Op-Id": op.opId};
      let payload;
      if (op.method !== "DELETE" && op.body !== undefined) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(op.body);
      }
      return await fetch("/api" + op.path, {method: op.method, headers, body: payload, signal: ctl.signal});
    } finally { clearTimeout(t); }
  }

  async function applyResult(op, data) {
    if (op.tempId !== undefined && data && data.id) {
      // Anything queued behind a create that referenced its temp id now
      // needs the real one.
      const from = `/transactions/${op.tempId}`;
      for (const o of ops) {
        if (o !== op && o.budgetId === op.budgetId && o.path === from) {
          o.path = `/transactions/${data.id}`;
          await persist(o);
        }
      }
    } else if (op.method === "PUT" && data && data.version) {
      // Our own edit bumped the row's version; later queued edits to the same
      // row must carry the new one or they'd conflict with ourselves.
      for (const o of ops) {
        if (o !== op && o.budgetId === op.budgetId && o.method === "PUT" &&
            o.path === op.path && o.state === "pending") {
          o.body = {...o.body, version: data.version};
          await persist(o);
        }
      }
    }
  }

  async function drain() {
    if (draining || !available || !State.authed) return;
    draining = true;
    let synced = 0, stalled = false, authLost = false;
    emit();
    try {
      for (;;) {
        const op = pendingOps().sort((a, b) => a.seq - b.seq)[0];
        if (!op) break;
        inflight.add(op.seq);
        try {
          let res;
          try { res = await sendOp(op); } catch { stalled = true; break; }
          if (res.status >= 502 && res.status <= 504) { stalled = true; break; }
          if (res.status === 401) { authLost = true; break; }
          const text = await res.text();
          let data = null;
          try { data = JSON.parse(text); } catch {}
          if (res.ok) {
            await applyResult(op, data);
            await remove(op);
            synced++;
          } else {
            op.state = res.status === 409 ? "conflict" : "error";
            op.error = (data && data.error) || text.slice(0, 160) || res.statusText;
            await persist(op);
          }
        } finally { inflight.delete(op.seq); }
      }
    } finally { draining = false; }

    if (synced || (!stalled && !authLost)) offline = false;
    if (stalled) { offline = true; scheduleRetry(); }
    emit();
    if (authLost) onAuthLost();
    if (synced) window.dispatchEvent(new Event("outbox:synced"));
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (hasPending()) drain(); }, RETRY_MS);
  }
  let onAuthLost = () => {};

  // ---- Reading: remember server facts, then lay queued changes on top ------
  function setOffline(v) {
    if (offline === v) return;
    offline = v;
    emit();
    clearInterval(probeTimer);
    if (v) {
      probeTimer = setInterval(probe, PROBE_MS);
    } else {
      window.dispatchEvent(new Event("outbox:online"));
      if (hasPending()) drain();
    }
  }

  // While offline, quietly check now and then whether the server is back, so
  // the app recovers on its own instead of waiting for the next user action.
  let probeTimer = null;
  async function probe() {
    try {
      const res = await fetch("/api/session", {cache: "no-store"});
      if (res.status < 502 && res.headers.get("X-From-Cache") !== "1") setOffline(false);
    } catch {}
  }

  // Fetch URLs through the service worker purely to fill its cache.
  let warmed = false;
  async function warm(urls) {
    if (warmed || !("serviceWorker" in navigator)) return;
    warmed = true;
    try {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => {
          navigator.serviceWorker.addEventListener("controllerchange", r, {once: true});
          setTimeout(r, 4000);
        });
      }
      if (!navigator.serviceWorker.controller) return;
    } catch { return; }
    await new Promise((r) => setTimeout(r, 1500));   // let the first render finish
    for (const u of urls) {
      if (offline) return;
      try { await fetch(u); } catch { return; }
    }
  }

  function observe(path, data) {
    const [pathname, qs] = path.split("?");
    const q = new URLSearchParams(qs || "");
    if (pathname === "/categories" && Array.isArray(data)) {
      for (const g of data) for (const c of g.categories || []) catNames.set(c.id, c.name);
    } else if ((pathname === "/budget/range" && Array.isArray(data)) || (pathname === "/budget" && data && data.groups)) {
      for (const m of Array.isArray(data) ? data : [data]) {
        for (const g of m.groups || []) for (const c of g.categories || []) catNames.set(c.id, c.name);
      }
    } else if (pathname === "/transactions" && q.get("account_id") && !q.get("search") && Array.isArray(data)) {
      for (const t of data) {
        txnIndex.set(t.id, {account_id: t.account_id, amount: t.amount, cleared: t.cleared,
          transfer_account_id: t.transfer_account_id, transfer_txn_id: t.transfer_txn_id});
      }
    }
    return overlay(pathname, q, data);
  }

  const acctName = (id) => ((State.accounts || []).find((a) => a.id === Number(id)) || {}).name || "";
  const catName = (id) => (id ? catNames.get(Number(id)) || "" : "");
  const num = (v) => Math.round(Number(v) || 0);
  const clearedPart = (amt, cl) => (cl > 0 ? amt : 0);

  function overlay(pathname, q, data) {
    const pend = pendingOps().sort((a, b) => a.seq - b.seq);
    if (!pend.length) return data;
    if (pathname === "/transactions" && q.get("account_id") && !q.get("search") && !q.get("category_id")) {
      return overlayTxns(data, Number(q.get("account_id")), pend);
    }
    if (pathname === "/accounts") return overlayAccounts(data, pend);
    if (pathname === "/budget/range" || pathname === "/budget") return overlayBudget(data, pend);
    return data;
  }

  function overlayTxns(rows, acctId, pend) {
    let out = rows.map((r) => ({...r}));
    let touched = false;
    const mirrorId = (tempId) => -(Math.abs(tempId) + 500000000);
    const fill = (r, b) => {
      if (b.date !== undefined) r.date = b.date;
      if (b.memo !== undefined) r.memo = (b.memo || "").trim();
      if (b.amount !== undefined) r.amount = num(b.amount);
      if (b.cleared !== undefined) r.cleared = Number(b.cleared) || 0;
    };
    for (const o of pend) {
      const b = o.body || {};
      if (o.method === "POST" && o.path === "/transactions") {
        const amt = num(b.amount);
        const splits = b.splits || [];
        const base = {date: b.date, memo: (b.memo || "").trim(), cleared: Number(b.cleared) || 0,
          import_id: null, import_batch_id: null, scheduled_id: null, created_at: null,
          version: 1, _pending: true};
        if (Number(b.account_id) === acctId) {
          const xfer = b.transfer_account_id ? Number(b.transfer_account_id) : null;
          out.push({...base, id: o.tempId, account_id: acctId, amount: amt,
            payee: xfer ? "" : (b.payee || "").trim(),
            category_id: xfer || splits.length ? null : (b.category_id || null),
            category_name: xfer || splits.length ? null : catName(b.category_id),
            account_name: acctName(acctId),
            transfer_account_id: xfer, transfer_txn_id: xfer ? mirrorId(o.tempId) : null,
            transfer_account_name: xfer ? acctName(xfer) : null,
            split_count: splits.length});
          touched = true;
        } else if (b.transfer_account_id && Number(b.transfer_account_id) === acctId) {
          out.push({...base, id: mirrorId(o.tempId), account_id: acctId, amount: -amt,
            payee: "", category_id: null, category_name: null,
            account_name: acctName(acctId), transfer_account_id: Number(b.account_id),
            transfer_txn_id: o.tempId, transfer_account_name: acctName(b.account_id), split_count: 0});
          touched = true;
        }
      } else if (o.method === "PUT") {
        const id = Number(o.path.split("/").pop());
        const r = out.find((x) => x.id === id);
        if (r) {
          fill(r, b);
          if (!r.transfer_txn_id && b.payee !== undefined) r.payee = (b.payee || "").trim();
          if (!r.transfer_account_id && b.category_id !== undefined) {
            r.category_id = b.category_id || null;
            r.category_name = catName(b.category_id) || null;
          }
          if (Array.isArray(b.splits)) {
            r.split_count = b.splits.length;
            if (b.splits.length) { r.category_id = null; r.category_name = null; }
          }
          r._pending = true; touched = true;
        }
        const mirror = out.find((x) => x.transfer_txn_id === id);
        if (mirror) {
          if (b.amount !== undefined) mirror.amount = -num(b.amount);
          if (b.date !== undefined) mirror.date = b.date;
          if (b.cleared !== undefined) mirror.cleared = Number(b.cleared) || 0;
          if (b.memo !== undefined) mirror.memo = (b.memo || "").trim();
          mirror._pending = true; touched = true;
        }
      } else if (o.method === "DELETE") {
        const id = Number(o.path.split("/").pop());
        const before = out.length;
        out = out.filter((x) => x.id !== id && x.transfer_txn_id !== id);
        if (out.length !== before) touched = true;
      }
    }
    if (!touched) return rows;
    const key = (r) => (r.id < 0 ? Infinity : r.id);
    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : key(b) - key(a)));
    let running = out.reduce((s, r) => s + r.amount, 0);
    for (const r of out) { r.running_balance = running; running -= r.amount; }
    return out;
  }

  function overlayAccounts(accts, pend) {
    const out = accts.map((a) => ({...a}));
    const adjust = (id, bal, cleared) => {
      const a = out.find((x) => x.id === Number(id));
      if (a) { a.balance += bal; a.cleared_balance += cleared; }
    };
    const work = new Map();
    const cur = (id) => work.get(id) || txnIndex.get(id);
    for (const o of pend) {
      const b = o.body || {};
      if (o.method === "POST" && o.path === "/transactions") {
        const amt = num(b.amount), cl = Number(b.cleared) || 0;
        adjust(b.account_id, amt, clearedPart(amt, cl));
        if (b.transfer_account_id) adjust(b.transfer_account_id, -amt, clearedPart(-amt, cl));
      } else if (o.method === "PUT") {
        const id = Number(o.path.split("/").pop());
        const old = cur(id);
        if (!old) continue;
        const amt = b.amount !== undefined ? num(b.amount) : old.amount;
        const cl = b.cleared !== undefined ? Number(b.cleared) || 0 : old.cleared;
        adjust(old.account_id, amt - old.amount,
          clearedPart(amt, cl) - clearedPart(old.amount, old.cleared));
        if (old.transfer_txn_id && old.transfer_account_id) {
          adjust(old.transfer_account_id, -(amt - old.amount),
            -(clearedPart(amt, cl) - clearedPart(old.amount, old.cleared)));
        } else if (b.transfer_account_id) {
          adjust(b.transfer_account_id, -amt, clearedPart(-amt, cl));
          old.transfer_account_id = Number(b.transfer_account_id);
          old.transfer_txn_id = -1;
        }
        work.set(id, {...old, amount: amt, cleared: cl});
      } else if (o.method === "DELETE") {
        const id = Number(o.path.split("/").pop());
        const old = cur(id);
        if (!old) continue;
        adjust(old.account_id, -old.amount, -clearedPart(old.amount, old.cleared));
        if (old.transfer_txn_id && old.transfer_account_id) {
          adjust(old.transfer_account_id, old.amount, clearedPart(old.amount, old.cleared));
        }
        work.set(id, {...old, amount: 0, cleared: 0});
      }
    }
    return out;
  }

  // Only the cell the user typed is patched; everything the server derives
  // from it (Available, To Be Budgeted, later months) stays as last seen.
  function overlayBudget(data, pend) {
    const edits = pend.filter((o) => o.method === "POST" && o.path === "/budget");
    if (!edits.length) return data;
    const out = structuredClone(data);
    for (const m of Array.isArray(out) ? out : [out]) {
      for (const o of edits) {
        if (o.body.month !== m.month) continue;
        for (const g of m.groups || []) {
          for (const c of g.categories || []) {
            if (c.id === Number(o.body.category_id)) { c.budgeted = num(o.body.budgeted); c._pending = true; }
          }
        }
      }
    }
    return out;
  }

  function pendingSplits(tempId) {
    const c = ops.find((o) => o.tempId === tempId && o.budgetId === State.budgetId);
    return ((c && c.body.splits) || []).map((s, i) => ({
      id: -(i + 1), category_id: s.category_id || null, amount: num(s.amount),
      memo: s.memo || "", category_name: catName(s.category_id) || null}));
  }

  // ---- Diagnostics (so a phone can report what its browser is doing) -------
  async function diagnostics() {
    const d = {secure: window.isSecureContext, supported: "serviceWorker" in navigator,
      error: swError, controlled: false, worker: "none", shellFiles: 0, hasRoot: false, apiEntries: 0};
    if (d.supported) {
      d.controlled = !!navigator.serviceWorker.controller;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) d.worker = reg.active ? "active" : reg.installing ? "installing" : reg.waiting ? "waiting" : "registered";
      } catch (e) { d.error = d.error || e.message; }
    }
    try {
      const sh = await (await caches.open("nab-shell-v1")).keys();
      d.shellFiles = sh.length;
      d.hasRoot = sh.some((r) => new URL(r.url).pathname === "/");
      d.apiEntries = (await (await caches.open("nab-api-v1")).keys()).length;
    } catch {}
    d.ok = d.secure && d.supported && d.worker === "active" && d.controlled && d.hasRoot;
    return d;
  }

  // Lists everything that could make Chrome call this page "not secure": any
  // resource the page loaded, any element pointing at, and any cached copy of,
  // an address that isn't https — plus what the offline worker is up to. Meant to
  // be read on a phone, where there's no developer console.
  async function securityReport() {
    const out = [];
    const notHttps = (u) => /^(http|ws):/i.test(u || "");
    out.push(`Address: ${location.href}`, `Secure context: ${window.isSecureContext}`, `Base URL: ${document.baseURI}`);
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) out.push(`Page protocol: ${nav.nextHopProtocol || "?"}`);

    const res = performance.getEntriesByType("resource");
    const badRes = res.filter((e) => notHttps(e.name));
    out.push("", `Resources this page loaded: ${res.length}`, `...not over https: ${badRes.length}`);
    badRes.forEach((e) => out.push(`  ! ${e.name}  (${e.initiatorType})`));

    const badDom = [];
    for (const node of document.querySelectorAll("[src], [href], [action], [data], [poster]")) {
      for (const attr of ["src", "href", "action", "data", "poster"]) {
        const v = node.getAttribute && node.getAttribute(attr);
        if (!v) continue;
        let abs = v;
        try { abs = new URL(v, document.baseURI).href; } catch {}
        if (notHttps(abs)) badDom.push(`${node.tagName.toLowerCase()} ${attr}=${abs}`);
      }
    }
    out.push("", `Elements pointing at a non-https address: ${badDom.length}`);
    badDom.slice(0, 20).forEach((d) => out.push(`  ! ${d}`));

    out.push("");
    if ("serviceWorker" in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        out.push(`Service workers registered: ${regs.length}`);
        regs.forEach((r) => out.push(`  script: ${(r.active || r.waiting || r.installing || {}).scriptURL || "?"}`, `  scope: ${r.scope}`));
        out.push(`Controlled by one: ${!!navigator.serviceWorker.controller}`);
      } catch (e) { out.push("Service workers: could not read (" + e.message + ")"); }
    } else out.push("Service workers: not supported here");

    try {
      const names = await caches.keys();
      let badCached = 0, total = 0;
      for (const n of names) {
        const keys = await (await caches.open(n)).keys();
        total += keys.length;
        keys.forEach((k) => { if (notHttps(k.url)) { badCached++; out.push(`  ! cached under ${n}: ${k.url}`); } });
      }
      out.push(`Saved copies: ${total} in ${names.length} stores; non-https: ${badCached}`);
    } catch (e) { out.push("Saved copies: could not read (" + e.message + ")"); }

    out.push("", "If everything above is clean, the warning isn't coming from this page's own requests.");
    return out.join("\n");
  }

  async function resetOffline() {
    try {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      for (const k of await caches.keys()) if (k.includes("nab-")) await caches.delete(k);
    } catch {}
    location.reload();
  }

  // ---- Status + review UI -------------------------------------------------
  const status = () => {
    const m = mine();
    return {
      offline,
      syncing: draining,
      pending: m.filter((o) => o.state === "pending").length,
      attention: m.filter((o) => o.state !== "pending").length,
    };
  };

  const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(num(c)) / 100).toFixed(2)}`;
  function describe(o) {
    const b = o.body || {};
    if (o.path === "/budget") {
      return `Budget ${b.month}: ${catName(b.category_id) || "category"} → ${money(b.budgeted)}`;
    }
    if (o.method === "POST") {
      return `Add ${money(b.amount)} ${b.payee ? "· " + b.payee + " " : ""}to ${acctName(b.account_id) || "account"}`;
    }
    if (o.method === "DELETE") return "Delete a transaction";
    const bits = [];
    if (b.amount !== undefined) bits.push(money(b.amount));
    if (b.payee) bits.push(b.payee);
    return "Edit a transaction" + (bits.length ? ` (${bits.join(" · ")})` : "");
  }

  function openReview() {
    const body = el("div", {});
    const paint = () => {
      body.replaceChildren();
      const list = mine().sort((a, b) => a.seq - b.seq);
      if (!list.length) {
        body.append(el("div", {class: "empty"}, offline
          ? "Nothing waiting to sync. You're offline, so you're seeing the last data this device loaded."
          : "Everything is synced."));
        return;
      }
      for (const o of list) {
        const btns = [];
        if (o.state === "conflict") {
          btns.push(el("button", {class: "btn sm secondary", title: "Apply my version over the other change",
            onclick: async () => { delete o.body.version; o.state = "pending"; delete o.error; await persist(o); emit(); drain(); }}, "Keep mine"));
        } else if (o.state === "error") {
          btns.push(el("button", {class: "btn sm secondary",
            onclick: async () => { o.state = "pending"; delete o.error; await persist(o); emit(); drain(); }}, "Retry"));
        }
        btns.push(el("button", {class: "btn sm danger",
          onclick: async () => { await remove(o); emit(); window.dispatchEvent(new Event("outbox:synced")); }}, "Discard"));
        body.append(el("div", {class: "sync-item"},
          el("div", {class: "sync-item-main"},
            el("div", {}, describe(o)),
            el("div", {class: "help" + (o.state === "pending" ? "" : " sync-err")},
              o.state === "pending" ? (inflight.has(o.seq) ? "Sending…" : "Waiting to sync")
                : o.state === "conflict" ? "Changed elsewhere first — " + (o.error || "")
                : o.error || "Failed")),
          el("div", {class: "sync-item-btns"}, ...btns)));
      }
    };
    paint();
    const unsub = subscribe(() => { if ($(".sync-item, .modal .empty")) paint(); });
    modal({title: "Sync status", bodyNode: body,
      footNode: [el("div", {style: "flex:1"}),
        el("button", {class: "btn", onclick: () => { unsub(); closeModal(); }}, "Close")]});
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function mountPill() {
    const pill = el("button", {class: "sync-pill", type: "button", hidden: true, onclick: openReview});
    document.body.append(pill);
    const paint = () => {
      const s = status();
      pill.classList.toggle("warn", s.attention > 0);
      pill.classList.toggle("off", s.offline && s.attention === 0);
      let text = "";
      if (s.attention) text = `${s.attention} need${s.attention === 1 ? "s" : ""} attention`;
      else if (s.offline) text = s.pending ? `Offline · ${s.pending} pending` : "Offline";
      else if (s.pending) text = s.syncing ? `Syncing ${s.pending}…` : `${s.pending} pending`;
      pill.textContent = text;
      pill.hidden = !text;
    };
    subscribe(paint);
    paint();
  }

  return {
    ready, init, mountPill, canQueue, enqueue, drain, hasPending, newOpId,
    observe, pendingSplits, setOffline, warm, diagnostics, securityReport, resetOffline,
    isOffline: () => offline,
    status, subscribe, offlineError,
    set onAuthLost(fn) { onAuthLost = fn; },
  };
})();
