/* My NAB — single-page app (no build step, plain ES). */
"use strict";

// --------------------------------------------------------------------------
//  Utilities
// --------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
};

const fmt = (cents, {plus = false} = {}) => {
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString(undefined,
    {minimumFractionDigits: 2, maximumFractionDigits: 2});
  return (neg ? "-$" : (plus && cents > 0 ? "+$" : "$")) + s;
};
// A small hand-rolled recursive-descent parser (no eval/Function — the
// input is a live text field, not trusted data) for +, -, *, /, parens, and
// unary sign, e.g. "50+25", "100/4", "12.50*3 + 6". Returns null (not a
// valid expression) rather than throwing, so callers can fall back to
// treating the text as a plain number.
function evalMathExpr(s) {
  s = s.trim();
  if (!s || !/^[-+*/().\d\s]+$/.test(s)) return null;
  let i = 0;
  const parseNum = () => {
    const start = i;
    let seenDigit = false, seenDot = false;
    while (i < s.length && (/\d/.test(s[i]) || (s[i] === "." && !seenDot))) {
      if (s[i] === ".") seenDot = true; else seenDigit = true;
      i++;
    }
    if (!seenDigit) throw new Error("bad expr");
    return parseFloat(s.slice(start, i));
  };
  const parseFactor = () => {
    while (s[i] === " ") i++;
    if (s[i] === "(") {
      i++;
      const v = parseExpr();
      while (s[i] === " ") i++;
      if (s[i] !== ")") throw new Error("bad expr");
      i++;
      return v;
    }
    if (s[i] === "-") { i++; return -parseFactor(); }
    if (s[i] === "+") { i++; return parseFactor(); }
    return parseNum();
  };
  const parseTerm = () => {
    let v = parseFactor();
    for (;;) {
      while (s[i] === " ") i++;
      if (s[i] === "*") { i++; v *= parseFactor(); }
      else if (s[i] === "/") { i++; v /= parseFactor(); }
      else break;
    }
    return v;
  };
  const parseExpr = () => {
    let v = parseTerm();
    for (;;) {
      while (s[i] === " ") i++;
      if (s[i] === "+") { i++; v += parseTerm(); }
      else if (s[i] === "-") { i++; v -= parseTerm(); }
      else break;
    }
    return v;
  };
  try {
    const v = parseExpr();
    while (s[i] === " ") i++;
    if (i !== s.length || !isFinite(v)) return null;
    return v;
  } catch { return null; }
}
const toCents = (v) => {
  if (v === "" || v == null) return 0;
  const s = String(v);
  const evaluated = evalMathExpr(s);
  const n = evaluated !== null ? evaluated : parseFloat(s.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100);
};
const dollars = (cents) => (cents / 100).toFixed(2);

// Wires a text input for cash-register-style money entry: plain digits shift
// the decimal point in from the right as you type — no need to hit "." —
// so "1" -> 0.01, "150" -> 1.50, "123576" -> 1235.76. The moment the user
// types an explicit "." or a math operator (+ - * /, matching evalMathExpr
// above), that field reverts to today's free-form parsing for the rest of
// the edit, carrying forward whatever dollar amount is already on screen —
// so "12345" (shifted to "123.45") followed by "+10" continues as
// "123.45+10" (evaluating to $133.45), not "12345+10" — digit-shifting only
// ever kicks in for a plain run of digits, before the first operator.
// onCents(magnitude) fires on every change with the (always non-negative in
// digit mode, possibly signed in fallback mode) parsed amount; callers that
// track their own sign separately (e.g. amountField's +/- toggle) combine it
// themselves, callers with no separate sign concept use it as-is.
function wireSmartMoneyInput(inp, onCents = () => {}) {
  // Reset whenever a fresh edit starts (a field can be focused/blurred
  // several times over its life, e.g. inside a modal) so an expression typed
  // last time doesn't stick around for this time. Also select the whole
  // value so tapping/clicking into a filled-in amount and immediately typing
  // a digit replaces it outright, instead of inserting into the old number —
  // deferred a tick since iOS Safari can drop a select() made synchronously
  // in the same focus event while its keyboard is still animating in.
  let exprMode = false;
  inp.addEventListener("focus", () => { exprMode = false; setTimeout(() => inp.select(), 0); });
  inp.addEventListener("input", (e) => {
    const typedChar = e.data;
    // The browser has already applied this keystroke (insert, backspace, or
    // typing over a selection) to inp.value by the time "input" fires, so
    // stripping punctuation back out always recovers the right digit run
    // for each of those cases — no need to track it ourselves.
    const digits = inp.value.replace(/[^0-9]/g, "");
    const negative = inp.value[0] === "-";
    // A "-" that's simply the leading sign of an otherwise-plain digit run
    // (e.g. "-1235" meaning -$12.35) stays in digit-shift mode — only a "-"
    // used as subtraction (the value has other non-digit text around it)
    // should drop into free-form expression parsing.
    const leadingSignOnly = typedChar === "-" && /^-?\d*$/.test(inp.value);
    if (!exprMode && typedChar && /[.+\-*/()]/.test(typedChar) && !leadingSignOnly) {
      // Switch to free-form parsing, keeping the dollar amount already
      // shown on screen (decimal point and all) as the left-hand side of
      // the expression, rather than reverting to the raw digit run — so
      // "123.45" followed by "+" continues as "123.45+", not "12345+".
      exprMode = true;
      const mag = digits === "" ? 0 : parseInt(digits, 10);
      const base = mag === 0 ? "" : dollars(mag);
      inp.value = (negative ? "-" + base : base) + typedChar;
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
    let cents;
    if (exprMode) {
      cents = toCents(inp.value);
    } else {
      cents = digits === "" ? 0 : parseInt(digits, 10);
      // A run of all zeros ("0", "00", ...) is still worth zero, so it
      // collapses to the empty (or bare "-") display rather than a fixed
      // "0.00" that backspace could never actually clear (stripping "0.00"
      // always yields "00", which would just reformat right back to "0.00").
      const formatted = (cents === 0 ? "" : dollars(cents));
      const signed = negative ? "-" + formatted : formatted;
      if (inp.value !== signed) {
        inp.value = signed;
        inp.setSelectionRange(signed.length, signed.length);
      }
    }
    onCents(cents);
  });
}
const todayStr = () => new Date().toISOString().slice(0, 10);
const curMonth = () => todayStr().slice(0, 7);
const monthLabel = (m) => {
  const [y, mo] = m.split("-");
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined,
    {month: "long", year: "numeric"});
};
const monthShort = (m) => {
  const [y, mo] = m.split("-");
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined,
    {month: "short", year: "numeric"});
};
// Just the month name, no year — used in the budget card's inline breakdown
// lines ("Income for Sep"), where the card's own header already gives the year.
const monthAbbrev = (m) => {
  const [y, mo] = m.split("-");
  return new Date(y, mo - 1, 1).toLocaleDateString(undefined, {month: "short"});
};
const monthAdd = (m, d) => {
  const [y, mo] = m.split("-").map(Number);
  const idx = y * 12 + (mo - 1) + d;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String(idx % 12 + 1).padStart(2, "0")}`;
};
// Simple localStorage-backed user preferences.
const getPref = (key, def) => {
  try { const v = localStorage.getItem("pref_" + key); return v === null ? def : v; }
  catch { return def; }
};
const setPref = (key, val) => { try { localStorage.setItem("pref_" + key, val); } catch {} };

const monthRange = (m) => {
  const [y, mo] = m.split("-").map(Number);
  const last = new Date(y, mo, 0).getDate();
  return [`${m}-01`, `${m}-${String(last).padStart(2, "0")}`];
};

const dateHeaderLabel = (dateStr) => {
  const today = todayStr();
  if (dateStr === today) return "Today";
  const yd = new Date(); yd.setDate(yd.getDate() - 1);
  const ydStr = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;
  if (dateStr === ydStr) return "Yesterday";
  const opts = {weekday: "long", month: "short", day: "numeric"};
  if (dateStr.slice(0, 4) !== today.slice(0, 4)) opts.year = "numeric";
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, opts);
};

// --------------------------------------------------------------------------
//  API
// --------------------------------------------------------------------------
// Queueable writes (transactions, budget cells) go through the offline outbox
// when the server can't be reached; see offline.js. Everything else just
// fails with a clear "you're offline" error.
const isServerDown = (res) => res.status >= 502 && res.status <= 504;
// ---- Showing that something is happening --------------------------------------------------------------------
// A small "Working…" pill at the top of the page appears when a request takes longer than half a second, and
// right away for a known batch of work ("Updating 120 of 480…" via Busy.begin). It never blocks the page.
const Busy = {
  inflight: 0, job: null, node: null, timer: null, shownAt: 0,
  api(delta) { this.inflight = Math.max(0, this.inflight + delta); this.update(); },
  begin(label, total = 0) {
    this.job = {label, total, done: 0};
    this.update();
    return {tick: (k = 1) => { if (this.job) { this.job.done += k; this.paint(); } }, end: () => { this.job = null; this.update(); }};
  },
  update() {
    clearTimeout(this.timer);
    if (this.job) return this.show();
    if (this.inflight > 0) { if (this.node) this.paint(); else this.timer = setTimeout(() => { if (this.inflight > 0) this.show(); }, 500); return; }
    // Idle: remove it, but not so fast that it just flickers.
    const left = this.node ? 600 - (Date.now() - this.shownAt) : 0;
    this.timer = setTimeout(() => this.hide(), Math.max(0, left));
  },
  show() {
    if (!this.node) {
      this.node = el("div", {class: "busy-pill", role: "status"}, el("span", {class: "busy-spin"}), el("span", {class: "busy-text"}),
        el("div", {class: "busy-bar"}, el("div", {})));
      document.body.append(this.node);
      this.shownAt = Date.now();
    }
    this.paint();
  },
  paint() {
    if (!this.node) return;
    const j = this.job;
    this.node.querySelector(".busy-text").textContent = j ? `${j.label}${j.total ? ` ${j.done} of ${j.total}` : ""}…` : "Working…";
    const bar = this.node.querySelector(".busy-bar");
    bar.style.display = j && j.total ? "" : "none";
    bar.firstChild.style.width = j && j.total ? `${Math.min(100, j.done / j.total * 100)}%` : "0";
  },
  hide() { if (this.node) { this.node.remove(); this.node = null; } },
};

async function api(...args) {
  Busy.api(1);
  try { return await apiRequest(...args); }
  finally { Busy.api(-1); }
}

async function apiRequest(path, {method = "GET", body, form} = {}) {
  const splitsOf = method === "GET" && path.match(/^\/transactions\/(-\d+)\/splits$/);
  if (splitsOf) return Outbox.pendingSplits(Number(splitsOf[1]));

  const queueable = method !== "GET" && !form && Outbox.canQueue(method, path);
  const opId = queueable ? Outbox.newOpId() : null;
  // Writes made while offline — or behind ones already waiting — join the
  // queue so they replay in order.
  if (queueable && (Outbox.isOffline() || Outbox.hasPending())) {
    return Outbox.enqueue(method, path, body, opId);
  }

  const opts = {method, headers: {}};
  if (opId) opts.headers["X-Op-Id"] = opId;
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  // A write on a bad connection can hang instead of failing; cut it loose and
  // queue it. The op id makes a late success on the server harmless to replay.
  let timer = null;
  if (queueable) {
    const ctl = new AbortController();
    opts.signal = ctl.signal;
    timer = setTimeout(() => ctl.abort(), 8000);
  }
  let res;
  try {
    res = await fetch("/api" + path, opts);
    if (isServerDown(res)) throw new TypeError("server unavailable");
  } catch (netErr) {
    if (!(netErr instanceof TypeError) && netErr.name !== "AbortError") throw netErr;
    Outbox.setOffline(true);
    if (queueable) return Outbox.enqueue(method, path, body, opId);
    throw Outbox.offlineError(method === "GET"
      ? "Can't reach the server, and this hasn't been saved on this device yet."
      : undefined);
  } finally { if (timer) clearTimeout(timer); }
  Outbox.setOffline(res.headers.get("X-From-Cache") === "1");
  if (res.status === 401 && path !== "/session" && !/^\/budgets\/\d+\/(open|setup|open-passkey|recover)$/.test(path)) {
    State.authed = false; renderPicker();   // signed out, or an encrypted budget that locked itself while idle
    throw new Error("unauth");
  }
  if (!res.ok) {
    // Prefer the server's {"error": "..."}; HTTP/2 has no status text, so never
    // leave the message empty.
    let msg = res.statusText || `Server error (${res.status})`;
    try {
      const text = await res.text();
      try { msg = JSON.parse(text).error || msg; }
      catch { if (text && !text.trim().startsWith("<")) msg = text; }
    } catch {}
    const err = new Error(msg);
    if (res.status === 409) err.conflict = true;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) return res.text();
  const data = await res.json();
  return method === "GET" ? Outbox.observe(path, data) : data;
}

// --------------------------------------------------------------------------
//  Toast + modal
// --------------------------------------------------------------------------
// action: optional {label, onClick, sticky} — renders a button inside the
// toast (e.g. "Undo") and gives the user longer to click it before it
// dismisses. sticky: true skips the auto-dismiss entirely — the toast then
// stays until that button is clicked (or the page is reloaded), for cases
// like a save conflict where silently disappearing could lose the warning.
function toast(msg, isErr = false, action = null) {
  // An error stays until it is closed (so there's time to read it); an identical one already showing isn't repeated.
  if (isErr) for (const old of $("#toast-root").querySelectorAll(".toast.err")) if (old.dataset.msg === String(msg)) return;
  const t = el("div", {class: "toast" + (isErr ? " err" : ""), "data-msg": isErr ? String(msg) : null}, el("span", {}, msg));
  if (isErr) t.append(el("button", {class: "toast-close", title: "Close", "aria-label": "Close", onclick: () => t.remove()}, "✕"));
  if (action) {
    t.append(el("button", {class: "toast-action", onclick: async () => {
      t.remove();
      await action.onClick();
    }}, action.label));
  }
  $("#toast-root").append(t);
  if (!isErr && (!action || !action.sticky)) setTimeout(() => t.remove(), action ? 6000 : 3200);
}
function closeModal() { $("#modal-root").innerHTML = ""; }

// A memo that is too long for its cell (cut off with "…") shows all of it in a tooltip while the mouse is over it.
// Works for the register, the search results and the import review, using the shared tooltip from reports.js.
(function memoTooltips() {
  const MEMO = ".c-memo, .reg-memo, .register td.memo";
  let over = null, timer = null;
  const hide = () => { clearTimeout(timer); over = null; if (typeof rpHideTip === "function") rpHideTip(); };
  document.addEventListener("mouseover", (e) => {
    const cell = e.target.closest ? e.target.closest(MEMO) : null;
    if (cell === over) return;
    hide();
    if (!cell || cell.querySelector("input, textarea")) return;                    // being edited: nothing to explain
    if (cell.scrollWidth <= cell.clientWidth + 1 && cell.scrollHeight <= cell.clientHeight + 1) return;   // it all fits
    const text = (cell.textContent || "").trim();
    if (!text || typeof rpShowTip !== "function") return;
    over = cell;
    const x = e.clientX, y = e.clientY;
    timer = setTimeout(() => rpShowTip(rpEsc(text), x, y), 250);
  });
  document.addEventListener("mousemove", (e) => {
    if (over && rpTip && rpTip.style.display === "block") rpShowTip(rpTip.innerHTML, e.clientX, e.clientY);
  });
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) hide(); });
  document.addEventListener("scroll", hide, true);
  document.addEventListener("mousedown", hide, true);
})();
// onSubmit: the dialog's primary action (if any). Enter in a text/password
// field advances to the next field, same as Tab — only Enter on the LAST
// field actually submits, so a one-field form can still just be typed into
// and hit Enter, while a multi-field one chains through the whole thing
// first. (A mobile keyboard's Enter/Return key varies by browser: some show
// "Next"/"Done" instead, but Firefox Android sends a literal Enter, which
// used to submit the whole dialog from the very first field.) Left textarea
// alone as the trigger — Enter has its own native meaning there (a newline)
// — though it still counts as a stop when advancing through the fields.
function modal({title, bodyNode, footNode, wide = false, onSubmit = null}) {
  const bg = el("div", {class: "modal-bg", onclick: (e) => { if (e.target === bg) closeModal(); }});
  const m = el("div", {class: "modal" + (wide ? " wide" : "")},
    el("h2", {}, title),
    el("div", {class: "body"}, bodyNode),
    footNode ? el("div", {class: "foot"}, footNode) : null);
  if (onSubmit) {
    m.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || !["INPUT", "SELECT"].includes(e.target.tagName)) return;
      e.preventDefault();
      const fields = [...m.querySelectorAll("input, select, textarea")]
        .filter((f) => !f.disabled && f.offsetParent !== null);
      const i = fields.indexOf(e.target);
      const next = i >= 0 ? fields[i + 1] : null;
      if (next) next.focus(); else onSubmit();
    });
  }
  bg.append(m);
  $("#modal-root").innerHTML = "";
  $("#modal-root").append(bg);
  // Focus the first fillable field so the dialog can just be typed into.
  const first = m.querySelector("input, textarea, select");
  if (first) first.focus();
  return bg;
}

function isMobile() {
  return window.matchMedia && window.matchMedia("(max-width: 820px)").matches;
}

// A dollar-amount field: a plain text input (native decimal keypad on mobile,
// no popup) plus a +/- toggle button. Stores a SIGNED cents value.
// `defaultSign` sets the starting sign before the user has typed anything.
// Returns { el, getCents }.
function amountField({initialCents = 0, placeholder = "0.00", defaultSign = 1, onChange = null} = {}) {
  let cents = initialCents || 0;
  let sgn = cents < 0 ? -1 : cents > 0 ? 1 : defaultSign;
  const signBtn = el("button", {type: "button", class: "amt-sign", title: "Toggle inflow / outflow"});
  const inp = el("input", {type: "text", inputmode: "decimal", class: "amt-input", placeholder});
  const paintSign = () => {
    signBtn.textContent = sgn > 0 ? "+" : "−";
    signBtn.className = "amt-sign " + (sgn > 0 ? "in" : "out");
  };
  const paintVal = () => {
    inp.value = cents ? dollars(Math.abs(cents)) : "";
    inp.classList.toggle("neg", cents < 0);
    inp.classList.toggle("pos", cents > 0);
  };
  const emit = () => { if (onChange) onChange(cents); };
  signBtn.addEventListener("click", () => { sgn = -sgn; cents = -cents; paintSign(); paintVal(); emit(); });
  wireSmartMoneyInput(inp, (mag) => {
    cents = mag === 0 ? 0 : sgn * mag;
    inp.classList.toggle("neg", cents < 0);
    inp.classList.toggle("pos", cents > 0);
    emit();
  });
  inp.addEventListener("blur", paintVal);
  paintSign(); paintVal();
  const wrap = el("div", {class: "amount-field"}, signBtn, inp);
  return {el: wrap, getCents: () => cents};
}

// --------------------------------------------------------------------------
//  State
// --------------------------------------------------------------------------
const State = {
  authed: false,
  view: "budget",          // budget | account | reports | import | settings | scheduled
  month: curMonth(),
  accountId: null,
  accounts: [],
  budgetId: null,
  budgetName: null,
  catTxn: null,            // {id, name, budgeted, activity, available, month} for the Outflows list page
  budgetScrollY: 0,        // where the budget was scrolled to when a sub-page was opened from it
  regSelection: null,      // {accountId, ids:Set} the register's ticked rows, kept across re-renders
  searchReturn: null,      // {view, accountId} the Search page's Back button returns to
  regReturn: null,         // {accountId, label, back()} set when the register was opened from another page (e.g. a schedule's history)
  searchQuery: "",         // the all-accounts search page remembers its last query/account
  searchAccount: "",
  sidebarOpen: false,                                          // mobile drawer
  sidebarCollapsed: getPref("sidebarCollapsed", "0") === "1",  // desktop pin/hide
};

function toggleSidebarCollapsed() {
  State.sidebarCollapsed = !State.sidebarCollapsed;
  setPref("sidebarCollapsed", State.sidebarCollapsed ? "1" : "0");
  renderShell();
}
function sidebarToggle() {
  if (isMobile()) { State.sidebarOpen = !State.sidebarOpen; renderShell(); }
  else { toggleSidebarCollapsed(); }
}

async function refreshAccounts() {
  State.accounts = await api("/accounts");
}

// Re-fetch balances and repaint just the sidebar in place — used after an
// edit made from inside the register (inline cell edit, cleared toggle,
// bulk edit, reconcile) so the account balance shown on the left stays in
// sync without tearing down and re-rendering the whole register underneath
// the user (which a full renderShell()/navGo() would do).
async function updateSidebarBalances() {
  await refreshAccounts();
  const old = $(".sidebar, .sidebar-mini");
  if (old) old.replaceWith(sidebar());
}

// Put account `movedId` just before (or after) account `targetId`, and remember the new order.
async function moveAccount(movedId, targetId, after) {
  const ids = State.accounts.map((a) => a.id).filter((id) => id !== movedId);
  ids.splice(ids.indexOf(targetId) + (after ? 1 : 0), 0, movedId);
  const byId = new Map(State.accounts.map((a) => [a.id, a]));
  State.accounts = ids.map((id) => byId.get(id));            // show it right away
  const repaint = () => { const old = $(".sidebar, .sidebar-mini"); if (old) old.replaceWith(sidebar()); };
  repaint();
  try { await api("/reorder", {method: "POST", body: {type: "account", ids}}); }
  catch (e) { toast(e.message, true); await refreshAccounts(); repaint(); }
}

function closeBudget() {
  saveLastSession(null);
  try { sessionStorage.removeItem("nab_view"); } catch { /* nothing saved */ }
  api("/close-budget", {method: "POST"}).finally(() => location.reload());
}

// --------------------------------------------------------------------------
//  Budget picker — shown whenever no budget is open in this session. Each
//  budget has its own password, checked only when opening it; the list
//  itself (names + whether a budget still needs a password set) is public.
// --------------------------------------------------------------------------
async function renderPicker() {
  const app = $("#app");
  app.innerHTML = "";
  app.append(el("div", {class: "auth-wrap"}, el("div", {class: "auth-card wide"}, "Loading…")));
  let budgets;
  try { budgets = await api("/budgets"); }
  catch (e) {
    app.innerHTML = "";
    app.append(el("div", {class: "auth-wrap"}, el("div", {class: "auth-card wide"},
      el("p", {}, e.offline ? "Can't reach the server right now." : "Error: " + e.message),
      el("button", {class: "btn", onclick: renderPicker}, "Retry"))));
    return;
  }
  app.innerHTML = "";
  app.append(pickerCard(budgets));
}

function pickerCard(budgets) {
  const list = el("div", {class: "picker-list"});
  for (const b of budgets) {
    list.append(el("div", {class: "picker-row"},
      el("div", {class: "picker-row-name"}, b.name,
        b.encrypted ? el("span", {class: "picker-lock", title: "Encrypted on the server"}, "🔒") : null,
        b.needs_setup ? el("span", {class: "help", style: "margin-left:8px"}, "not set up") : null,
        // The demo that ships with the Windows program: say what its password is.
        State.demoPassword && b.name === "Demo Budget"
          ? el("div", {class: "help"}, "Made-up data. Password: ", el("strong", {}, State.demoPassword)) : null),
      el("div", {class: "picker-row-actions"},
        el("button", {class: "btn sm", onclick: () => openBudgetPrompt(b)},
          b.needs_setup ? "Set Up" : "Open"),
        el("button", {class: "set-menu-btn", title: "Rename",
          onclick: () => renameBudgetPrompt(b)}, "✎"),
        el("button", {class: "set-menu-btn", title: "Delete",
          onclick: () => deleteBudgetPrompt(b)}, "🗑"))));
  }
  list.append(el("div", {class: "picker-row picker-add", onclick: newBudgetPrompt}, "+ New Budget"));
  return el("div", {class: "auth-wrap"}, el("div", {class: "auth-card wide"},
    el("h1", {}, "My NAB"),
    el("p", {}, "Choose a budget to open"),
    list));
}

function openBudgetPrompt(b) {
  if (b.needs_setup) {
    const pw = el("input", {type: "password", name: "password", autocomplete: "new-password", placeholder: "Choose a password"});
    const pw2 = el("input", {type: "password", name: "password-confirm", autocomplete: "new-password", placeholder: "Confirm password"});
    const submit = async () => {
      if (pw.value.length < 4) return toast("Use at least 4 characters", true);
      if (pw.value !== pw2.value) return toast("Passwords don't match", true);
      try {
        await api(`/budgets/${b.id}/setup`, {method: "POST", body: {password: pw.value}});
        closeModal();
        boot();
      } catch (e) { toast(e.message, true); }
    };
    modal({title: `Set Up "${b.name}"`, onSubmit: submit, bodyNode: el("div", {},
        el("div", {class: "help", style: "margin-bottom:12px"},
          "Choose a password to protect this budget. You'll enter it every time you open it."),
        el("label", {class: "field"}, pw),
        el("label", {class: "field"}, pw2)),
      footNode: [
        el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
        el("button", {class: "btn", onclick: submit}, "Set Password & Open")]});
  } else {
    const pw = el("input", {type: "password", name: "password", id: "nab-password", autocomplete: "current-password", placeholder: "Password"});
    const submit = async () => {
      try {
        await api(`/budgets/${b.id}/open`, {method: "POST", body: {password: pw.value}});
        closeModal();
        boot();
      } catch (e) { toast(e.message || "Wrong password", true); }
    };
    const problem = el("div", {class: "modal-err", hidden: true});
    const showError = (msg) => { problem.textContent = msg; problem.hidden = false; };
    modal({title: `Open "${b.name}"`, onSubmit: submit, bodyNode: el("div", {},
        b.passkeys ? el("button", {class: "btn secondary", style: "width:100%;margin-bottom:12px",
          onclick: () => openWithPasskey(b, showError)}, "🔑 Use a passkey") : null,
        problem,
        // A real login form (budget name as the "username"), so a password manager such as Bitwarden can
        // offer to save and fill this budget's password.
        el("form", {onsubmit: (e) => e.preventDefault(), autocomplete: "on"},
          el("input", {type: "text", name: "username", id: "nab-username", autocomplete: "username", value: b.name, class: "pm-username",
            "aria-label": "Budget"}),   // not readonly: many password managers (phones especially) skip read-only fields
          el("label", {class: "field"}, pw)),
        b.encrypted ? el("a", {href: "#", class: "help", onclick: (e) => { e.preventDefault(); recoveryPrompt(b); }},
          "Forgot the password? Use the recovery key") : null),
      footNode: [
        el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
        el("button", {class: "btn", onclick: submit}, "Open")]});
  }
}

// ---- Passkeys: unlock an encrypted budget with a fingerprint / face / security key -----------------------
// The passkey's own secret (WebAuthn "PRF" extension) locks and unlocks the budget's key on the server, so a
// browser or device without PRF support can't use one.
const bufB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const bufB64u = (buf) => bufB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64Buf = (str) => {
  const t = str.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), (c) => c.charCodeAt(0));
};
const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
const PASSKEY_UNSUPPORTED = "The passkey was made, but the app holding it (your browser or a password manager such as " +
  "Bitwarden) didn't hand back the extra secret My NAB needs to unlock a budget (the WebAuthn \"PRF\" extension). " +
  "Not every passkey app supports that yet. iCloud Keychain on iPhone/Mac, recent Google Password Manager on " +
  "Android/Chrome and hardware security keys (YubiKey) usually do. Otherwise use your password; Bitwarden can fill it. " +
  "If a passkey for My NAB was just saved in Bitwarden, you can delete that entry: it isn't connected to this budget."; 

// What the passkey app answered to the PRF request, so a failure can be pinned on the right part.
const prfDetail = (got) => `  [The passkey app's answer to the PRF request: ${JSON.stringify(got, (k, v) => v instanceof ArrayBuffer ? "(bytes)" : v)}]`;

// Ask for one of these passkeys; returns {id, prf} for the server. `salt` is the budget's fixed salt.
async function passkeyDerive(ids, salt) {
  const a = await navigator.credentials.get({publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), timeout: 60000, userVerification: "required",
    allowCredentials: ids.map((id) => ({type: "public-key", id: b64Buf(id)})),
    extensions: {prf: {eval: {first: b64Buf(salt)}}}}});
  const got = a.getClientExtensionResults();
  const r = got.prf;
  if (!r || !r.results || !r.results.first) throw new Error(PASSKEY_UNSUPPORTED + prfDetail(got));
  return {id: bufB64u(a.rawId), prf: bufB64(r.results.first)};
}

// Make a new passkey for this budget; returns {id, prf}.
async function passkeyCreate(ids, salt, who) {
  const cred = await navigator.credentials.create({publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), timeout: 60000,
    rp: {name: "My NAB"},
    user: {id: crypto.getRandomValues(new Uint8Array(16)), name: who, displayName: who},
    pubKeyCredParams: [{type: "public-key", alg: -7}, {type: "public-key", alg: -257}],
    authenticatorSelection: {residentKey: "preferred", userVerification: "required"},
    excludeCredentials: ids.map((id) => ({type: "public-key", id: b64Buf(id)})),
    extensions: {prf: {eval: {first: b64Buf(salt)}}}}});
  const id = bufB64u(cred.rawId);
  const got = cred.getClientExtensionResults();
  const r = got.prf;
  if (r && r.results && r.results.first) return {id, prf: bufB64(r.results.first)};
  if (!r || !r.enabled) throw new Error(PASSKEY_UNSUPPORTED + prfDetail(got));
  return passkeyDerive([id], salt);        // some browsers only hand the secret over on the next use
}

// Plain-language reason a passkey step failed, followed by the browser's own error for reference.
function passkeyProblem(e) {
  const host = location.hostname, name = (e && e.name) || "Error", raw = (e && e.message) || String(e);
  let why;
  if (!window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential)
    why = `Passkeys only work on a secure connection. This page is ${location.protocol}//${host}, which this browser doesn't allow them on. ` +
      "Use the https address (the one with the lock), not plain http.";
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":"))
    why = `Passkeys can't be used when you reach the server by an IP address (${host}). Use a name instead, such as ` +
      "https://nas.example.com, with a valid certificate.";
  else if (name === "SecurityError")
    why = "The browser refused a passkey for this web address, usually because the https certificate isn't trusted " +
      "(a self-signed certificate won't do) or the address doesn't match.";
  else if (name === "NotAllowedError")
    why = "The passkey prompt was cancelled or timed out, or no passkey is available for this budget on this device. " +
      "If your password manager (for example Bitwarden) or another provider popped up and was dismissed, try again " +
      "and choose a different one.";
  else if (name === "NotSupportedError")
    why = "This device or passkey provider doesn't support the kind of passkey needed.";
  else if (name === "InvalidStateError")
    why = "This device already has a passkey for this budget.";
  else why = raw;
  return why;
}

async function openWithPasskey(b, showError) {
  try {
    const o = await api(`/budgets/${b.id}/passkey-options`);
    const k = await passkeyDerive(o.ids, o.salt);
    await api(`/budgets/${b.id}/open-passkey`, {method: "POST", body: k});
    closeModal();
    boot();
  } catch (e) { const msg = passkeyProblem(e); showError(msg); toast(msg, true); }
}

function recoveryPrompt(b) {
  const key = el("input", {type: "text", placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", autocomplete: "off"});
  const pw = el("input", {type: "password", name: "password", autocomplete: "new-password", placeholder: "New password"});
  const pw2 = el("input", {type: "password", name: "password-confirm", autocomplete: "new-password", placeholder: "Confirm new password"});
  const submit = async () => {
    if (pw.value.length < 12) return toast("An encrypted budget needs a password of at least 12 characters", true);
    if (pw.value !== pw2.value) return toast("Passwords don't match", true);
    try {
      await api(`/budgets/${b.id}/recover`, {method: "POST", body: {recovery_key: key.value, password: pw.value}});
      closeModal();
      boot();
    } catch (e) { toast(e.message, true); }
  };
  modal({title: `Recover "${b.name}"`, onSubmit: submit, bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:12px"},
        "Type the recovery key you saved when this budget was encrypted, and choose a new password of at least 12 characters."),
      el("label", {class: "field"}, el("span", {}, "Recovery key"), key),
      el("label", {class: "field"}, pw), el("label", {class: "field"}, pw2)),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: submit}, "Recover & Open")]});
}

function newBudgetPrompt() {
  const name = el("input", {type: "text", placeholder: "e.g. 2026 Budget"});
  const submit = async () => {
    if (!name.value.trim()) return toast("Enter a name", true);
    try {
      await api("/budgets", {method: "POST", body: {name: name.value.trim()}});
      closeModal();
      renderPicker();
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "New Budget", onSubmit: submit, bodyNode: el("div", {},
      el("label", {class: "field"}, el("span", {}, "Name"), name)),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: submit}, "Create")]});
}

function renameBudgetPrompt(b) {
  const name = el("input", {type: "text", value: b.name});
  // A password-protected budget requires its password to rename (the picker
  // runs pre-auth); a not-yet-set-up one has none to ask for.
  const pw = b.needs_setup ? null : el("input", {type: "password", placeholder: "Password"});
  const submit = async () => {
    if (!name.value.trim()) return toast("Enter a name", true);
    try {
      await api(`/budgets/${b.id}`, {method: "PUT",
        body: {name: name.value.trim(), password: pw ? pw.value : ""}});
      closeModal();
      renderPicker();
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Rename Budget", onSubmit: submit, bodyNode: el("div", {},
      el("label", {class: "field"}, el("span", {}, "Name"), name),
      pw ? el("label", {class: "field"}, el("span", {}, "Password"), pw) : null),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: submit}, "Save")]});
}

function deleteBudgetPrompt(b) {
  const bodyKids = [el("div", {class: "help", style: "margin-bottom:12px"},
    `This permanently deletes "${b.name}" and everything in it — accounts, categories, transactions, budget entries, scheduled transactions. This cannot be undone.`)];
  const pw = b.needs_setup ? null : el("input", {type: "password", placeholder: "Password"});
  if (pw) bodyKids.push(el("label", {class: "field"}, el("span", {}, "Password"), pw));
  const submit = async () => {
    try {
      await api(`/budgets/${b.id}`, {method: "DELETE", body: {password: pw ? pw.value : ""}});
      closeModal();
      renderPicker();
      toast("Budget deleted");
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Delete Budget", onSubmit: submit, bodyNode: el("div", {}, ...bodyKids),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn danger", onclick: submit}, "Delete Budget")]});
}

// --------------------------------------------------------------------------
//  Shell (sidebar + main)
// --------------------------------------------------------------------------
function renderShell() {
  const app = $("#app");
  app.innerHTML = "";
  app.append(el("div", {class: "layout" + (State.sidebarCollapsed ? " collapsed" : "")},
    sidebar(),
    State.sidebarOpen ? el("div", {class: "sidebar-backdrop",
      onclick: () => { State.sidebarOpen = false; renderShell(); }}) : null,
    mainPanel()));
  app.append(bottomTabs());
  applyPrefs();
  requestAnimationFrame(updateBarOffsets);
}

// Apply visual preferences (register text size) via a CSS variable.
function applyPrefs() {
  const size = getPref("fontSize", "medium");
  const px = size === "small" ? 12.5 : size === "large" ? 16 : 14;
  document.documentElement.style.setProperty("--reg-font", px + "px");
  const dens = getPref("density", "cozy");
  const pad = dens === "compact" ? 1 : dens === "comfortable" ? 6 : 3;
  document.documentElement.style.setProperty("--reg-pad", pad + "px");
  document.documentElement.style.setProperty("--bud-font", budgetFontPx() + "px");
}
// Budget screen text size (Settings → Appearance), 9–18px; 13 by default.
const BUD_FONT_MIN = 9, BUD_FONT_MAX = 18, BUD_FONT_DEFAULT = 13;
function budgetFontPx() {
  const n = parseInt(getPref("budFont", String(BUD_FONT_DEFAULT)), 10);
  return Number.isFinite(n) ? Math.max(BUD_FONT_MIN, Math.min(BUD_FONT_MAX, n)) : BUD_FONT_DEFAULT;
}

// Keep the sticky day-divider offsets in sync with the real top/bottom bars,
// which differ in height between phone and laptop.
function updateBarOffsets() {
  const tb = document.querySelector(".topbar");
  const bt = document.querySelector(".bottom-tabs");
  const rt = document.querySelector(".reg-toolbar");
  const bh = document.querySelector(".budget-stickyhead");
  const r = document.documentElement.style;
  r.setProperty("--topbar-h", (tb ? tb.offsetHeight : 52) + "px");
  r.setProperty("--bottombar-h", (bt ? bt.offsetHeight : 0) + "px");
  r.setProperty("--reg-toolbar-h", (rt ? rt.offsetHeight : 0) + "px");
  r.setProperty("--budget-head-h", (bh ? bh.offsetHeight : 0) + "px");
}
window.addEventListener("resize", updateBarOffsets);

const TAB_ICONS = {
  budget: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.2 15.9A9 9 0 118.1 2.8"/><path d="M22 12A10 10 0 0012 2v10z"/></svg>',
  accounts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-6 9 6"/><path d="M5 10v9M19 10v9M9.5 10v9M14.5 10v9"/><path d="M3 21h18"/></svg>',
  reports: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M7 21v-6M12 21V8M17 21v-9"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
};

function bottomTabs() {
  const tab = (label, icon, active, onClick) => el("a", {
    href: "#", class: "tab" + (active ? " active" : ""),
    onclick: (e) => { e.preventDefault(); onClick(); },
  }, el("span", {class: "tabicon", html: TAB_ICONS[icon]}), el("span", {}, label));

  const v = State.view;
  return el("nav", {class: "bottom-tabs"},
    tab("Budget", "budget", v === "budget" && !State.sidebarOpen,
      () => navGo("budget", {accountId: null})),
    tab("Accounts", "accounts", (v === "accounts" || v === "account") && !State.sidebarOpen,
      () => navGo("accounts", {accountId: null})),
    tab("Reports", "reports", v === "reports" && !State.sidebarOpen,
      () => navGo("reports", {accountId: null})),
    tab("More", "more", State.sidebarOpen,
      () => { revealHidden = false; State.sidebarOpen = !State.sidebarOpen; renderShell(); }));
}
// Set here (before renderShell() wipes the DOM) whenever we're re-entering
// the SAME view — e.g. a budget edit re-navigates to "budget" to refresh —
// so the view's async render can restore scroll once its real content is
// back, instead of leaving the page snapped to the top while data reloads.
let pendingScrollY = null;

// ---- Hidden accounts (phone only, per device) ----------------------------------------------
// A privacy screen against prying eyes: hidden accounts (and their balances) drop out of the
// Accounts tab, the net worth shown there, and the menu drawer's account list. They are still
// fully active — in the budget, in searches, and one tap away via "Show hidden accounts".
const hiddenAccountIds = () => {
  try { return new Set(JSON.parse(getPref("hiddenAccounts", "[]"))); } catch { return new Set(); }
};
const saveHiddenAccounts = (set) => setPref("hiddenAccounts", JSON.stringify([...set]));
let revealHidden = false;   // lasts until you leave the Accounts tab, open the menu, or switch away from the app
document.addEventListener("visibilitychange", () => { if (document.hidden) revealHidden = false; });
const isAcctHidden = (a) => isMobile() && !revealHidden && hiddenAccountIds().has(a.id);

function openHideAccountsModal() {
  const hidden = hiddenAccountIds();
  const boxes = State.accounts.filter((a) => !a.closed).map((a) => {
    const cb = el("input", {type: "checkbox"});
    cb.checked = hidden.has(a.id);
    return {a, cb, row: el("label", {class: "carry-toggle"}, cb, el("span", {}, a.name))};
  });
  const save = () => {
    const next = new Set(boxes.filter((b) => b.cb.checked).map((b) => b.a.id));
    saveHiddenAccounts(next);
    revealHidden = false;
    closeModal();
    navGo("accounts");
  };
  modal({title: "Hide accounts", onSubmit: save,
    bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:8px"},
        "Ticked accounts are hidden from the Accounts tab and the menu on this phone. They still work everywhere else."),
      ...boxes.map((b) => b.row)),
    footNode: [el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: save}, "Save")]});
}

// A refresh should land on the page you were on, not the budget. Kept per browser tab (so it survives a reload but
// a fresh visit starts at the budget). Pages that need something set up beforehand (a category's list, a month's
// income) fall back to the budget.
const RESTORABLE_VIEWS = ["budget", "accounts", "account", "reports", "scheduled", "import", "settings", "search"];
function rememberView() {
  try {
    if (!RESTORABLE_VIEWS.includes(State.view)) { sessionStorage.removeItem("nab_view"); return; }
    sessionStorage.setItem("nab_view", JSON.stringify({budget: State.budgetId, view: State.view,
      accountId: State.view === "account" ? State.accountId : null, q: State.view === "search" ? (State.searchQuery || "") : ""}));
  } catch { /* storage unavailable: just start at the budget */ }
}
function restoreView() {
  try {
    const v = JSON.parse(sessionStorage.getItem("nab_view") || "null");
    if (!v || v.budget !== State.budgetId || !RESTORABLE_VIEWS.includes(v.view)) return;
    if (v.view === "account") {
      if (!State.accounts.some((a) => a.id === v.accountId)) return;
      State.accountId = v.accountId;
    }
    if (v.view === "search") State.searchQuery = v.q || "";
    State.view = v.view;
  } catch { /* nothing to restore */ }
}

function navGo(view, opts = {}) {
  if (view !== "accounts") revealHidden = false;
  // Leaving the register drops its selection / "back to" link. Search and category pages are registers too.
  if (!["account", "search", "categoryTransactions"].includes(view)) { State.regSelection = null; State.regReturn = null; }
  // Search is reached from anywhere (a register's "Search all", the sidebar);
  // remember where, so its Back button can return there.
  if (view === "search" && State.view !== "search" && !opts.keepReturn) State.searchReturn = {view: State.view, accountId: State.accountId};
  if (view === State.view) pendingScrollY = window.scrollY;
  State.view = view;
  if (opts.accountId !== undefined) State.accountId = opts.accountId;
  rememberView();
  State.sidebarOpen = false;
  renderShell();
}
// How many imported transactions are still waiting to be checked, across every account.
const reviewTotal = () => State.accounts.reduce((n, a) => n + (a.review_count || 0), 0);

function sidebar() {
  // Collapsed on desktop: don't disappear entirely — leave a thin strip with
  // an arrow to reopen (mobile ignores this; its drawer uses sidebarOpen).
  if (!isMobile() && State.sidebarCollapsed) {
    return el("div", {class: "sidebar-mini"},
      el("button", {class: "side-expand", title: "Expand sidebar", onclick: toggleSidebarCollapsed}, "»"));
  }
  const link = (view, label, icon) => el("a", {
    href: "#", class: State.view === view ? "active" : "",
    onclick: (e) => { e.preventDefault(); navGo(view, {accountId: null}); },
  }, `${icon}  ${label}`);

  const onBudget = State.accounts.filter((a) => a.on_budget && !a.closed && !isAcctHidden(a));
  const offBudget = State.accounts.filter((a) => !a.on_budget && !a.closed && !isAcctHidden(a));
  // Accounts can be dragged into a new order (within On-Budget or within Off-Budget). On a touch screen, use the
  // up/down arrows in Settings, Accounts.
  const acctLink = (a) => {
    const link = el("a", {
      href: "#", class: State.view === "account" && State.accountId === a.id ? "active" : "", draggable: "true",
      title: "Drag to reorder",
      onclick: (e) => { e.preventDefault(); navGo("account", {accountId: a.id}); },
    }, el("span", {}, a.name),
       el("span", {class: "bal " + (a.balance < 0 ? "neg" : "pos")}, fmt(a.balance)));
    const clearMarks = () => document.querySelectorAll(".acct-list a").forEach((x) => x.classList.remove("drop-before", "drop-after", "dragging"));
    const droppable = () => {
      const dragged = State.dragAcct && State.accounts.find((x) => x.id === State.dragAcct);
      return dragged && dragged.id !== a.id && !!dragged.on_budget === !!a.on_budget ? dragged : null;
    };
    link.addEventListener("dragstart", (e) => {
      State.dragAcct = a.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(a.id));
      setTimeout(() => link.classList.add("dragging"), 0);
    });
    link.addEventListener("dragend", () => { State.dragAcct = null; clearMarks(); });
    link.addEventListener("dragover", (e) => {
      if (!droppable()) return;
      e.preventDefault();
      const r = link.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      link.classList.toggle("drop-after", after);
      link.classList.toggle("drop-before", !after);
    });
    link.addEventListener("dragleave", () => link.classList.remove("drop-before", "drop-after"));
    link.addEventListener("drop", (e) => {
      const dragged = droppable();
      if (!dragged) return;
      e.preventDefault();
      const r = link.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearMarks();
      moveAccount(dragged.id, a.id, after);
    });
    return link;
  };

  const acctSection = (title, list) => list.length ? [
    el("div", {class: "side-section"}, title),
    el("div", {class: "acct-list"}, ...list.map(acctLink)),
  ] : [];

  return el("div", {class: "sidebar" + (State.sidebarOpen ? " open" : "")},
    el("div", {class: "brand"},
      el("div", {}, "My NAB", el("small", {}, State.budgetName || "Zero-based budget")),
      el("button", {class: "side-collapse", title: "Collapse sidebar", onclick: sidebarToggle}, "«")),
    el("div", {class: "nav"},
      reviewTotal() ? el("a", {href: "#", class: "nav-verify" + (State.view === "verify" ? " active" : ""),
        onclick: (e) => { e.preventDefault(); navGo("verify", {accountId: null}); }},
        `●  ${reviewTotal()} imported, verify`) : null,
      link("budget", "Budget", "▦"),
      link("scheduled", "Scheduled", "⟳"),
      link("search", "Search", "⌕"),
      link("reports", "Reports", "◑"),
      link("import", "Import", "⤓"),
      link("settings", "Settings", "⚙")),
    ...acctSection("On-Budget Accounts", onBudget),
    ...acctSection("Off-Budget / Tracking", offBudget),
    el("div", {class: "side-section"},
      el("span", {}, "Accounts"),
      el("button", {title: "Add account", onclick: openAccountModal}, "+")),
    el("div", {class: "side-foot"},
      el("button", {title: "Close this budget and pick another", onclick: closeBudget}, "Close Budget")));
}
function mainPanel() {
  // Kept as an empty, always-hidden element (not removed outright) so
  // updateBarOffsets()'s "--topbar-h" measurement keeps working unchanged —
  // an empty display:none bar correctly measures as 0 height. The hamburger
  // that used to live here opened the same sidebar drawer the bottom tab
  // bar's "More" button already does, so it was pure redundant chrome.
  const bar = el("div", {class: "topbar"});
  const content = el("div", {class: "content", id: "content"});
  const panel = el("div", {class: "main"}, bar, content);
  renderView(content);
  return panel;
}
function renderView(content) {
  content.innerHTML = "";
  if (State.view === "budget") renderBudget(content);
  else if (State.view === "accounts") {
    renderAccountsOverview(content);
    // Balances can have changed since they were last loaded (e.g. a schedule edited elsewhere).
    refreshAccounts().then(() => {
      if (State.view === "accounts" && content.isConnected) { content.innerHTML = ""; renderAccountsOverview(content); }
    }).catch(() => {});
  }
  else if (State.view === "account") renderRegister(content);
  else if (State.view === "reports") renderReports(content);
  else if (State.view === "import") renderImport(content);
  else if (State.view === "verify") renderVerify(content);
  else if (State.view === "settings") renderSettings(content);
  else if (State.view === "scheduled") renderScheduled(content);
  else if (State.view === "search") renderSearch(content);
  else if (State.view === "categoryTransactions") renderCategoryTransactions(content);
  else if (State.view === "scheduledHistory") renderScheduledHistory(content, State.scheduledHistoryId);
  else if (State.view === "incomeTransactions") renderIncomeTransactions(content, State.incomeTxnMonth, State.incomeTxnKind);
}

// --------------------------------------------------------------------------
//  Budget view
// --------------------------------------------------------------------------
// How many months to show side by side (1 on phones; adjustable 1–6 on web,
// matching the classic multi-month spreadsheet view).
function budgetMonthCount() {
  if (isMobile()) return 1;
  return budgetLayout().count;
}
// Width of one month's three money columns (Budgeted / Outflows / Balance), and the
// category column's roomy and snug widths. The month count shown is the number the person
// asked for, cut down (never below 1) to however many fit in the window without overflowing.
// Column widths are designed at the default 13px text and scale with the chosen size.
const budScale = () => budgetFontPx() / BUD_FONT_DEFAULT;
const BUD_MONTH_W_BASE = 324, BUD_CAT_W_BASE = [220, 180];
const BUD_GAP = 6;   // clear space between the category names and the amounts
function budgetAvailWidth() {
  const c = document.querySelector(".content");
  if (!c) return window.innerWidth - (State.sidebarCollapsed ? 22 : 240) - 44;
  const cs = getComputedStyle(c);
  return c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}
function budgetLayout() {
  const BUD_MONTH_W = Math.round(BUD_MONTH_W_BASE * budScale());
  const BUD_CAT_W = BUD_CAT_W_BASE.map((w) => Math.round(w * budScale()));
  const want = parseInt(getPref("budgetMonths", "3"), 10);
  const wanted = (want >= 1 && want <= 3) ? want : 3;
  const avail = budgetAvailWidth() - BUD_GAP;
  const months = (n) => n * BUD_MONTH_W + (n - 1) * BUD_GAP / 2;   // n months plus the narrow gaps between
  let max = 1;
  for (let n = 3; n > 1; n--) if (avail >= months(n) + BUD_CAT_W[1]) { max = n; break; }
  const count = Math.min(wanted, max);
  // The category column takes whatever room is left (between its snug and roomy widths); with a
  // single month it may shrink further, so a big font on a small window still fits the screen.
  const left = avail - months(count);
  const floor = count === 1 ? Math.round(110 * budScale()) : BUD_CAT_W[1];
  const catW = Math.min(BUD_CAT_W[0], Math.max(floor, Math.floor(left / 8) * 8));
  return {count, catW, max, wanted};
}
// Resizing the window (or collapsing the sidebar) can change how many months fit.
let budgetShown = null;
window.addEventListener("resize", () => {
  clearTimeout(budgetShown && budgetShown.timer);
  if (!budgetShown) return;
  budgetShown.timer = setTimeout(() => {
    if (State.view !== "budget" || isMobile()) return;
    const l = budgetLayout();
    if (l.count !== budgetShown.count || l.catW !== budgetShown.catW) navGo("budget");
  }, 200);
});
// The window of months to show. ≥3 months keeps exactly one past month before
// the current one; fewer months put the current month first with the rest ahead.
function budgetMonthList(center, count) {
  const back = count >= 3 ? 1 : 0;
  const start = monthAdd(center, -back);
  return Array.from({length: count}, (_, i) => monthAdd(start, i));
}

// Set when a month-navigation action (arrow, timeline click, Today) changes
// State.month, so the next renderBudget() knows to slide the new content in.
let budgetSlideDir = null;
// Set when the mobile Budgeted-column toggle («/») changes, so the next
// renderBudget() knows to give the table a one-off "slide open" animation.
let budgetColToggled = false;
function gotoBudgetMonth(newMonth) {
  const old = State.month;
  State.month = newMonth;
  budgetSlideDir = newMonth > old ? "next" : newMonth < old ? "prev" : null;
  navGo("budget");
}

// Plain (no "$") signed number for the card's breakdown lines, e.g. "5,000.00",
// "-1,000.00". force="+"/"-" always shows that sign (used for lines that are
// conceptually always an addition or always a deduction, even at exactly $0).
function fmtPlain(cents, force) {
  const v = (cents || 0) / 100;
  const abs = Math.abs(v).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  if (force === "+") return "+" + abs;
  if (force === "-") return "-" + abs;
  return (v < 0 ? "-" : "") + abs;
}
// Classic budgeting apps hide exact-zero amounts in category rows (blank cell) instead
// of cluttering the grid with "$0.00" everywhere; group/total rows still show it.
const fmtOrBlank = (cents) => cents ? fmt(cents) : "";

// Months the budget view requests: the visible window plus one before it.
function budgetFetchMonths() {
  const months = budgetMonthList(State.month, budgetMonthCount());
  return [monthAdd(months[0], -1), ...months];
}

async function renderBudget(root) {
  if (isMobile()) return renderMobileBudget(root);   // simplified phone layout (mobile.js)
  const layout = budgetLayout();
  const count = layout.count;
  budgetShown = {count, catW: layout.catW};
  const months = budgetMonthList(State.month, count);
  root.append(el("div", {class: "empty"}, "Loading budget…"));
  // Fetch one extra month before the visible window too, so the leftmost
  // card can show "Not Budgeted in"/"Overspent in" for ITS previous month.
  const fetchMonths = budgetFetchMonths();
  let all;
  try { all = await api(`/budget/range?months=${fetchMonths.join(",")}`); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  const datas = all.slice(1);   // aligned with `months`
  root.innerHTML = "";

  // Desktop always shows all three money columns. Mobile defaults to just
  // Outflows + Balance (classic style — Budgeted is an editable field
  // you dip into occasionally, not something you need to see at a glance)
  // and reveals Budgeted only when the user explicitly opens it with the
  // toolbar's «/» toggle, since a phone screen can't fit all three without
  // either wrapping or shrinking everything unreadably.
  const mobWide = isMobile() && getPref("mobBudgetedOpen", "0") === "1";
  const cols = (!isMobile() || mobWide) ? ["budgeted", "outflow", "balance"] : ["outflow", "balance"];
  // Wide enough for a signed 6-figure amount ("-$300,071.51") without wrapping.
  const sc = budScale();
  const COL_W = {budgeted: Math.round(104 * sc) + "px", outflow: Math.round(104 * sc) + "px", balance: Math.round(116 * sc) + "px"};
  const moneyCols = cols.map((k) => COL_W[k]);
  // Desktop: a fixed, snug category column so the whole thing can shrink-wrap
  // and center (lots of spare width to play with). Mobile default (2 money
  // columns): the category column flexes to fill whatever's left so the grid
  // fits the screen exactly with no horizontal scroll. Mobile with Budgeted
  // open: a fixed (narrower) category column instead, since the three money
  // columns together are wider than the screen on purpose — the table is
  // meant to spill off the right edge and be reached by scrolling, not to
  // squeeze the category column down to nothing.
  const catW = isMobile() ? (mobWide ? "130px" : "1fr") : layout.catW + "px";
  // One shared grid used by BOTH the cards row and the table (no gutter
  // tracks — months are separated by a thin border, not a gap), so a month's
  // card sits exactly above its table box regardless of month count.
  const grid = `${catW} ${BUD_GAP}px ` + months.map((_, i) => (i ? `${BUD_GAP / 2}px ` : "") + moneyCols.join(" ")).join(" ");

  // --- controls: the month-count picker, stacked, in the empty space above the category names,
  // to the left of the cards. (Today lives in the month strip, beside its « arrow.)
  const controls = el("div", {class: "bc-controls", style: "grid-column: span 2"});
  const seg = el("div", {class: "seg months-seg vert"});
  for (const n of [1, 2, 3]) {
    const tooMany = n > layout.max;
    const b = el("button", {class: "seg-btn" + (count === n ? " active" : "") + (tooMany ? " disabled" : ""),
      title: tooMany ? "Doesn't fit this window" : `Show ${n} month${n > 1 ? "s" : ""}`}, String(n));
    if (tooMany) b.disabled = true;
    b.addEventListener("click", () => { setPref("budgetMonths", n); navGo("budget"); });
    seg.append(b);
  }
  controls.append(el("div", {class: "months-ctl"}, el("span", {class: "help"}, "Months"), seg));

  // The month strip, then the cards, form one sticky header pinned below the topbar; only the
  // category table underneath scrolls, so To-Budget stays visible.
  const stickyHead = el("div", {class: "budget-stickyhead"}, budgetTimeline(months));

  const cardsRow = el("div", {class: "budget-cards"});
  cardsRow.style.setProperty("--bud-grid", grid);
  // The cards sit over the amount columns only; the category column (and the gap after it) stays empty.
  cardsRow.append(controls);
  months.forEach((m, i) => {
    if (i > 0) cardsRow.append(el("span"));   // the narrow gap between months
    cardsRow.append(budgetCard(all[i] || {}, datas[i] || {}, m, moneyCols.length));
  });
  stickyHead.append(cardsRow);
  root.append(stickyHead);
  alignTimeline();
  requestAnimationFrame(alignTimeline);   // once fonts and widths have settled

  // --- scrollable region: the category table only ---------------------------
  const scroll = el("div", {class: "budget-scroll"});

  // Per-month lookup maps keyed by category / group id.
  const catMap = datas.map((d) => {
    const o = {}; (d.groups || []).forEach((g) => g.categories.forEach((c) => o[c.id] = c)); return o;
  });
  const grpMap = datas.map((d) => {
    const o = {}; (d.groups || []).forEach((g) => o[g.id] = g); return o; });
  const centerIdx = Math.max(0, months.indexOf(State.month));
  const skeleton = (datas[centerIdx] || datas[0] || {}).groups || [];
  // Grand totals per month (sum of group totals).
  const grand = datas.map((d) => (d.groups || []).reduce(
    (a, g) => ({b: a.b + g.budgeted, s: a.s + g.activity, a: a.a + g.available}), {b: 0, s: 0, a: 0}));

  const table = el("div", {class: "budget-table" + (mobWide ? " bud-wide" : "")});
  table.style.setProperty("--bud-grid", grid);
  // The first money column of each month (after the first) gets a divider
  // border, so months read as distinct blocks in an otherwise flat grid.
  const mdiv = (i) => i > 0 ? "m-div" : "";
  const COL_LABEL = {budgeted: "Budgeted", outflow: "Outflows", balance: "Balance"};

  // Column header: labels + grand totals per month.
  const groupIds = skeleton.map((g) => g.id);
  const mobToggleBtn = isMobile() ? el("button", {class: "bt-iconbtn",
    title: mobWide ? "Hide the Budgeted column" : "Show the Budgeted column",
    onclick: () => { setPref("mobBudgetedOpen", mobWide ? "0" : "1"); budgetColToggled = true; navGo("budget"); }},
    mobWide ? "»" : "«") : null;
  const head = el("div", {class: "bt-head" + (mobWide ? " bud-wide" : "")}, el("div", {class: "bt-corner"},
    el("span", {}, "Categories"),
    el("div", {class: "bt-corner-btns"},
      mobToggleBtn,
      el("button", {class: "bt-iconbtn", title: "Collapse all groups",
        onclick: () => setAllGroupsCollapsed(groupIds, true)}, "▸"),
      el("button", {class: "bt-iconbtn", title: "Expand all groups",
        onclick: () => setAllGroupsCollapsed(groupIds, false)}, "▾"))),
    el("span", {class: "bt-gap"}));
  const grandKey = {budgeted: "b", outflow: "s", balance: "a"};
  months.forEach((m, i) => {
    if (i > 0) head.append(el("span", {class: "bt-gap"}));
    cols.forEach((k, ci) => head.append(
      colHead(COL_LABEL[k], grand[i][grandKey[k]], ci === 0 ? mdiv(i) : "")));
  });
  head.style.setProperty("--bud-grid", grid);
  // Normally lives in the already-sticky cards block (not inside
  // .budget-scroll, whose overflow-x:auto quietly turns off position:sticky
  // for descendants) so the column header stays pinned for free, right below
  // the cards. Mobile with Budgeted open is the exception: the table is
  // deliberately wider than the screen there, and syncing two independently
  // -scrolling elements (head here, body in .budget-scroll) via JS turned
  // out to be unreliable on real devices — backgrounds and column alignment
  // could drift out of sync mid-scroll. Simpler and fully robust: put the
  // head INSIDE .budget-scroll, right above the table, so they're one single
  // native-scrolling region that can never desync. The one trade-off is the
  // header stops being sticky-while-scrolling-down in that state, which is
  // an acceptable price for a view you're only dipping into occasionally.
  if (mobWide) scroll.append(head);
  else stickyHead.append(head);

  const collapsed = getCollapsedGroups();
  for (const sg of skeleton) {
    const isCollapsed = collapsed.has(String(sg.id));
    const grow = el("div", {class: "bt-grouprow"},
      el("span", {class: "gname", onclick: () => toggleGroup(sg.id)},
        el("span", {class: "chev" + (isCollapsed ? " collapsed" : "")}, "▾"),
        sg.name),
      el("span", {class: "bt-gap"}));
    const grpVal = {budgeted: (g) => fmt(g.budgeted), outflow: (g) => fmt(g.activity),
      balance: (g) => fmt(g.available)};
    months.forEach((m, i) => {
      if (i > 0) grow.append(el("span", {class: "bt-gap"}));
      const g = grpMap[i][sg.id] || {budgeted: 0, activity: 0, available: 0};
      cols.forEach((k, ci) => grow.append(el("span", {class: "num "
        + (ci === 0 ? mdiv(i) : "") + (k === "balance" && g.available < 0 ? " neg" : "")},
        grpVal[k](g))));
    });
    table.append(grow);
    if (isCollapsed) continue;
    for (const sc of sg.categories) {
      const rrow = el("div", {class: "bt-row"},
        el("span", {class: "cname"}, sc.name), el("span", {class: "bt-gap"}));
      months.forEach((m, i) => {
        if (i > 0) rrow.append(el("span", {class: "bt-gap"}));
        const c = catMap[i][sc.id] || {id: sc.id, name: sc.name, budgeted: 0,
          activity: 0, available: 0};
        rrow.append(...budgetMonthCells(c, m, i, cols));
      });
      table.append(rrow);
    }
  }
  if (table.lastElementChild) table.lastElementChild.classList.add("bt-last");   // its corners get rounded
  scroll.append(table);
  root.append(scroll);

  if (budgetColToggled) {
    budgetColToggled = false;
    head.classList.add("bud-col-slide");
    table.classList.add("bud-col-slide");
  }

  if (!skeleton.length)
    root.append(el("div", {class: "empty"}, "No categories yet. Add some under Settings → Categories."));

  // A month-navigation action just changed the window: slide the new cards +
  // table in from the direction we moved, instead of an abrupt jump-cut.
  if (budgetSlideDir) {
    const dir = budgetSlideDir; budgetSlideDir = null;
    cardsRow.classList.add("bud-slide-" + dir);
    table.classList.add("bud-slide-" + dir);
  }
  // .budget-stickyhead's real height (cards can wrap) only exists now that
  // it's in the DOM — recompute so the table header sticks right below it.
  requestAnimationFrame(updateBarOffsets);
  // An edit (e.g. saveBudget) re-navigated here while the page was scrolled
  // down; the DOM wipe in between briefly shrank the page and the browser
  // clamped scroll to 0. Now that the real (tall) content is back, put it
  // back where it was instead of leaving the user stranded at the top.
  if (pendingScrollY != null) {
    const y = pendingScrollY; pendingScrollY = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
}

// A column header cell: small label with its grand total beneath.
function colHead(label, total, extraClass) {
  return el("span", {class: "num bt-colhead " + (extraClass || "")},
    el("span", {class: "bt-collabel"}, label),
    el("span", {class: "bt-coltotal"}, fmt(total)));
}

// Mobile's single-month nav: no room for a scrolling timeline strip, so just
// the one month being viewed with its own prev/next arrows either side.
function mobileMonthNav(month) {
  const [y, mo] = month.split("-");
  const label = new Date(y, mo - 1, 1).toLocaleDateString(undefined, {month: "long", year: "numeric"});
  return el("div", {class: "mob-month-nav"},
    el("button", {class: "nav-arrow", onclick: () => gotoBudgetMonth(monthAdd(month, -1))}, "‹"),
    el("div", {class: "mob-month-label" + (month === curMonth() ? " today" : "")}, label),
    el("button", {class: "nav-arrow", onclick: () => gotoBudgetMonth(monthAdd(month, 1))}, "›"));
}

// Timeline strip of months around the visible window; the visible ones are
// highlighted and any month can be clicked to jump to it.
// The strip of months above the cards: the months being shown (one blue block) plus 4 either side,
// with an arrow at each end that jumps 4 months to reach further, and Today to the left of them. Tabs keep their natural width; the
// whole strip is slid sideways (alignTimeline) so the selected month's tab sits centred over its card.
const TL_REACH = 4;
function budgetTimeline(visibleMonths) {
  const vis = new Set(visibleMonths);
  const from = monthAdd(visibleMonths[0], -TL_REACH);
  const to = monthAdd(visibleMonths[visibleMonths.length - 1], TL_REACH);
  const track = el("div", {class: "tl-track"});
  let lastYear = null;
  for (let m = from; m <= to; m = monthAdd(m, 1)) {
    const [y, mo] = m.split("-");
    const shortMo = new Date(y, mo - 1, 1).toLocaleDateString(undefined, {month: "long"});
    track.append(el("button", {class: "tl-month" + (vis.has(m) ? " active" : "") + (m === curMonth() ? " today" : ""),
      "data-month": m, onclick: (mm => () => gotoBudgetMonth(mm))(m)},
      y !== lastYear ? el("span", {class: "tl-year"}, y) : null,
      el("span", {class: "tl-mo"}, shortMo)));
    lastYear = y;
  }
  const arrow = (label, text, step) => el("button", {class: "tl-arrow", title: label, "aria-label": label,
    onclick: () => gotoBudgetMonth(monthAdd(State.month, step))}, text);
  return el("div", {class: "budget-timeline"},
    el("button", {class: "tl-today", title: "Go to this month", onclick: () => gotoBudgetMonth(curMonth())}, "Today"),
    arrow(`Back ${TL_REACH} months`, "«", -TL_REACH), track, arrow(`Forward ${TL_REACH} months`, "»", TL_REACH));
}
// Slide the strip so the selected month's tab is centred over its card (kept inside the header).
function alignTimeline() {
  const strip = document.querySelector(".budget-timeline");
  const head = document.querySelector(".budget-stickyhead");
  const tab = strip && strip.querySelector(`.tl-month[data-month="${State.month}"]`);
  const card = document.querySelector(`.budget-card[data-month="${State.month}"]`);
  if (!tab || !card || !head) return;
  // Layout positions (offsetLeft), not on-screen rects, so the cards' slide-in animation can't skew it.
  // Summed up to the sticky header, since an animating or transformed parent becomes the offset parent.
  const leftIn = (e) => { let x = 0; for (; e && e !== head; e = e.offsetParent) x += e.offsetLeft; return x; };
  const tabs = [...strip.querySelectorAll(".tl-month")];
  tabs.forEach((t) => { t.hidden = false; });
  const stripLeft = leftIn(strip);
  const want = () => (leftIn(card) + card.offsetWidth / 2) - (leftIn(tab) + tab.offsetWidth / 2);
  // If the strip is too wide to slide into place inside the header, trim its far months (the ones
  // beyond the visible block) from the side that is short of room, rather than letting it sit off-centre.
  let delta = want();
  for (let i = 0, lo = 0, hi = tabs.length - 1; i < tabs.length; i++) {
    const room = head.clientWidth - strip.offsetWidth;
    if (delta < -stripLeft && lo < tabs.indexOf(tab) && !tabs[lo].classList.contains("active")) tabs[lo++].hidden = true;
    else if (delta > room - stripLeft && hi > tabs.indexOf(tab) && !tabs[hi].classList.contains("active")) tabs[hi--].hidden = true;
    else break;
    delta = want();
  }
  const room = head.clientWidth - strip.offsetWidth;   // how far the strip can move without leaving the header
  if (room >= 0) delta = Math.max(-stripLeft, Math.min(room - stripLeft, delta));
  strip.style.transform = `translateX(${Math.round(delta)}px)`;
}
window.addEventListener("resize", () => { if (State.view === "budget" && !isMobile()) alignTimeline(); });

// A month summary card: classic breakdown of what makes up this month's
// Available-to-Budget, then the big total itself.
// prevD/thisD are the shaped /budget/range entries for the previous and
// current month (prevD supplies "Not Budgeted in"/"Overspent in" for the
// month before, thisD supplies "Income for"/"Budgeted in" for this month).
function budgetCard(prevD, thisD, month, span) {
  const prevMonth = monthAdd(month, -1), nextMonth = monthAdd(month, 1);
  // One term of the sum: an operator chip, the label, and the amount. `value` is what the term
  // contributes to the total (signed); the chip shows its sign (`natural` when it is exactly zero)
  // and the amount is always shown unsigned, like a column of figures on paper.
  const term = (label, value, natural, onClick, hint) => {
    const sign = value < 0 ? "-" : value > 0 ? "+" : natural;
    return el("div", {class: "bc-eq" + (onClick ? " bc-line-link" : "") + (hint ? " bc-line-hint" : ""),
        onclick: onClick, title: hint || (onClick ? "View these transactions" : undefined)},
      el("span", {class: "bc-op " + (sign === "-" ? "minus" : "plus")}, sign === "-" ? "−" : "+"),
      el("span", {class: "bc-label"}, label),
      el("span", {class: "bc-amt" + (value === 0 ? " zero" : "")}, fmtPlain(Math.abs(value))));
  };
  const OVERSPENT_HINT = "Spent more than budgeted with nothing set to carry forward — this money has already come out of Available to Budget. Budgeting more into those categories now won't move Available to Budget again; it only fills the category itself.";
  // "Not Budgeted in {prev}" = prev month's TBB before ITS OWN overspend hit —
  // i.e. what would have carried in if nothing had gone over.
  const notBudgetedPrev = (prevD.carried_in || 0) + (prevD.income || 0) - (prevD.budgeted || 0);
  // The terms add up exactly to the total: not-budgeted + last month's overspend (together, what
  // carried in) + income - budgeted - this month's own overspend.
  // Everything normally added comes first (income, then what carried in as not-budgeted), then
  // everything normally taken away. The order is fixed so the rows line up from card to card;
  // a chip flips to match the term's actual sign when it goes the other way.
  const body = el("div", {class: "bc-body"},
    term(`Income for ${monthAbbrev(month)}`, thisD.income || 0, "+", () => goToIncomeTransactions(month, "for")),
    term(`Not Budgeted in ${monthAbbrev(prevMonth)}`, notBudgetedPrev, "+"),
    term(`Overspent in ${monthAbbrev(prevMonth)}`, prevD.overspent || 0, "-", null, OVERSPENT_HINT),
    term(`Budgeted in ${monthAbbrev(month)}`, -(thisD.budgeted || 0), "-"));
  body.children[2].classList.add("bc-eq-split");   // where the subtractions begin
  if (thisD.overspent) body.append(term(`Overspent in ${monthAbbrev(month)}`, thisD.overspent, "-", null, OVERSPENT_HINT));
  // Income received this month but set aside for next month is already left out of "Income for", so
  // it isn't part of the sum. Shown under the total, always (even at $0) so every card is the same height.
  const held = el("div", {class: "bc-note bc-line-link", title: "Income received this month that you've set aside for next month. Not counted in this month's total.",
      onclick: () => goToIncomeTransactions(month, "held")},
    el("span", {}, `Set aside for ${monthAbbrev(nextMonth)}`), el("span", {class: "bc-amt"}, fmtPlain(thisD.for_next_month || 0)));
  const tbb = thisD.to_be_budgeted || 0;
  const cls = tbb > 0 ? "pos" : tbb < 0 ? "neg" : "zero";
  const [y, mo] = month.split("-");
  const moAbbr = new Date(y, mo - 1, 1).toLocaleDateString(undefined, {month: "short"}).toUpperCase();
  // Mobile only: the breakdown lines above "Available to Budget" (Not
  // Budgeted in, Overspent in, Income for, Budgeted in, Income held for) can
  // be collapsed to just the total, since on a phone they're the biggest
  // thing pushing the actual category table below the fold.
  const collapsible = isMobile();
  const collapsed = collapsible && getPref("bcCollapsed", "1") === "1";
  const toggleBtn = collapsible ? el("button", {class: "bc-menu-btn",
    title: collapsed ? "Show breakdown" : "Hide breakdown",
    onclick: () => { setPref("bcCollapsed", collapsed ? "0" : "1"); navGo("budget"); }},
    el("span", {class: "chev" + (collapsed ? " collapsed" : "")}, "▾")) : null;
  // Mobile only ever shows one card, and the month it's for is already shown
  // up in mobileMonthNav right above — repeating "SEP 2026" here would just
  // be wasted vertical space. Desktop still needs it: several cards sit side
  // by side there with no other way to tell which month is which.
  const card = el("div", {"data-month": month, class: "budget-card" + (month === curMonth() ? " current" : "")
      + (collapsed ? " bc-collapsed" : ""),
    style: `grid-column: span ${span}`},
    el("div", {class: "bc-head"},
      isMobile() ? null : el("div", {class: "bc-mo"}, moAbbr),
      isMobile() ? null : el("div", {class: "bc-yr"}, y),
      el("div", {class: "grow"}),
      toggleBtn,
      el("button", {class: "bc-menu-btn", title: "Fill this month's budget",
        onclick: (e) => openFillMenu(e.currentTarget, month)}, "⋮")),
    collapsed ? null : body,
    el("div", {class: "bc-foot " + cls},
      el("span", {class: "bc-op equals"}, "="),
      el("span", {class: "bc-label"}, "Available to Budget"),
      el("span", {class: "bc-tbb"}, fmt(tbb))),
    collapsed ? null : held);
  return card;
}

// Set ONE category's Budgeted for `month` from its past months: the average of what was budgeted
// (avgN) or of what was actually spent (spentN) over the last N months. Only that category changes.
const FILL_LABEL = {avg3: "average budgeted, last 3 months", avg6: "average budgeted, last 6 months",
  avg12: "average budgeted, last 12 months", spent3: "average spent, last 3 months",
  spent6: "average spent, last 6 months", spent12: "average spent, last 12 months"};
async function fillCategory(c, month, mode) {
  try {
    const r = await api("/budget/fill", {method: "POST", body: {month, mode, category_id: c.id}});
    let v = 0;
    for (const g of r.groups || []) for (const k of g.categories) if (k.id === c.id) v = k.budgeted;
    navGo("budget");
    toast(`${c.name}: Budgeted set to ${fmt(v)} (${FILL_LABEL[mode]})`);
  } catch (e) { toast(e.message, true); }
}
function openCategoryFillMenu(anchor, c, month) {
  floatMenu(anchor, [
    {heading: `${c.name} — set Budgeted to the average of…`},
    ...[3, 6, 12].map((n) => ({label: `What I budgeted, last ${n} months`, onClick: () => fillCategory(c, month, "avg" + n)})),
    "sep",
    ...[3, 6, 12].map((n) => ({label: `What I spent, last ${n} months`, onClick: () => fillCategory(c, month, "spent" + n)})),
  ]);
}

// Bulk-populate every category's Budgeted amount for one month at once.
function openFillMenu(anchor, month) {
  const doFill = async (mode) => {
    try {
      await api("/budget/fill", {method: "POST", body: {month, mode}});
      navGo("budget");
      toast(FILL_LABEL[mode] ? `Every category set to the ${FILL_LABEL[mode]}` : "Budget updated");
    } catch (e) { toast(e.message, true); }
  };
  floatMenu(anchor, [
    {label: "Copy Last Month's Budget", onClick: () => doFill("copy_last")},
    {label: "Zero Month's Budget", onClick: () => doFill("zero")},
    "sep",
    {heading: "Set every category to what I budgeted…"},
    ...[3, 6, 12].map((n) => ({label: `Average of the last ${n} months`, onClick: () => doFill("avg" + n)})),
    "sep",
    {heading: "Set every category to what I spent…"},
    ...[3, 6, 12].map((n) => ({label: `Average of the last ${n} months`, onClick: () => doFill("spent" + n)})),
  ]);
}

// The per-month cells: editable Budgeted, read-only Outflows, colored Balance.
// `i` is this month's position in the visible window (0 = leftmost), used to
// place the divider border marking a new month's block. `cols` (a subset of
// ["budgeted","outflow","balance"], in order) picks which ones are actually
// rendered — mobile hides "budgeted" unless the user has opened it.
function budgetMonthCells(c, month, i, cols) {
  const cents = c.budgeted || 0;
  const amountCell = el("input", {type: "text", inputmode: "decimal",
    class: "budget-input budget-tap", value: cents ? dollars(cents) : "",
    title: "You can type a math expression, e.g. 50+25"});
  wireSmartMoneyInput(amountCell);
  // Enter calls commit() and then blurs the field to close out the edit —
  // but that blur() itself re-fires the "blur" listener below, which would
  // otherwise call commit() a SECOND time. Two concurrent saveBudget() calls
  // each trigger their own full navGo("budget") re-render, and whichever
  // resolves last wins — sometimes clobbering the correct one with a stale
  // re-render mid-flight. `done` makes commit() fire at most once per focus.
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = toCents(amountCell.value);
    if (v !== (c.budgeted || 0)) saveBudget(c, v, month);
    else amountCell.value = cents ? dollars(cents) : "";
  };
  amountCell.addEventListener("focus", () => { done = false; });
  amountCell.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); amountCell.blur(); }
    else if (e.key === "Escape") { done = true; amountCell.value = cents ? dollars(cents) : ""; amountCell.blur(); }
  });
  amountCell.addEventListener("blur", commit);
  const av = c.available;
  // A negative balance not set to carry has already been deducted from this
  // month's Available to Budget (see the "Overspent" line's tooltip) — flag
  // it here too, right where someone would try to "fix" it by budgeting more.
  const overspentMark = (av < 0 && !c.carry) ? el("span", {class: "carry-mark overspent-mark",
    title: "Already deducted from Available to Budget — budgeting more into this category won't move that number again, it'll just fill this category's own balance."}, "ⓘ") : null;
  const balance = el("span", {class: "num bal" + (av < 0 ? " neg" : "") + " bal-click",
    title: "Click to set whether this carries into next month",
    onclick: () => openCarryToggle(c, month)},
    c.carry ? el("span", {class: "carry-mark", title: "Carries into next month"}, "↪") : overspentMark,
    fmtOrBlank(av));
  const outflow = el("span", {class: "num outflow", title: "Click to view this month's spending",
    onclick: () => openCategoryDetail(c, month)}, fmtOrBlank(c.activity));
  // A "⋯" at the left of the Budgeted cell (visible on row hover) sets just this category from its averages.
  const moreBtn = el("button", {type: "button", class: "bud-more", "aria-label": `Set ${c.name} from past months`,
    title: "Set this category's Budgeted to an average of past months…",
    onclick: (e) => { e.stopPropagation(); openCategoryFillMenu(e.currentTarget, c, month); }}, "⋯");
  const parts = {budgeted: el("span", {class: "num bud-cell"}, moreBtn, amountCell), outflow, balance};
  const out = cols.map((k) => parts[k]);
  if (i > 0 && out.length) out[0].classList.add("m-div");
  return out;
}

async function saveCarryover(c, month, carry) {
  try {
    await api("/budget/carryover", {method: "POST",
      body: {month, category_id: c.id, carry}});
    closeModal(); navGo("budget");
  } catch (e) { toast(e.message, true); }
}

function getCollapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem("collapsedGroups") || "[]")); }
  catch { return new Set(); }
}
function toggleGroup(id) {
  const s = getCollapsedGroups();
  const k = String(id);
  s.has(k) ? s.delete(k) : s.add(k);
  localStorage.setItem("collapsedGroups", JSON.stringify([...s]));
  navGo("budget");
}
function setAllGroupsCollapsed(groupIds, collapsed) {
  localStorage.setItem("collapsedGroups", JSON.stringify(collapsed ? groupIds.map(String) : []));
  navGo("budget");
}

async function saveBudget(c, cents, month) {
  if (cents === c.budgeted) return;
  try {
    await api("/budget", {method: "POST",
      body: {month, category_id: c.id, budgeted: cents}});
    navGo("budget");
  } catch (e) { toast(e.message, true); }
}

// The Outflows cell opens a page listing the transactions behind that number
// (openCategoryDetail, in search.js). The carry-into-next-month option lives
// on the Balance cell instead — see openCarryToggle — since it's about the
// balance, not the activity.

// Balance click: the carry-into-next-month toggle (not meaningful for
// payment categories, which always carry — budgetMonthCells doesn't wire
// this up for those). Shared by desktop and mobile since both render
// category rows through the same budgetMonthCells().
function openCarryToggle(c, month) {
  const cb = el("input", {type: "checkbox"});
  cb.checked = !!c.carry;
  cb.addEventListener("change", () => saveCarryover(c, month, cb.checked));
  const body = el("div", {},
    el("div", {style: "display:flex;justify-content:space-between;margin-bottom:14px"},
      el("div", {}, el("div", {class: "help"}, "Available"), el("strong", {}, fmt(c.available)))),
    el("label", {class: "carry-toggle"}, cb,
      el("div", {},
        el("div", {}, "Carry balance into next month"),
        el("div", {class: "help"},
          `Roll this category's ending balance (even if overspent) into next month instead of resetting to $0 and reducing To-be-Budgeted. Stays on for every month after ${monthShort(month)} until you turn it off again in some later month.`))));
  modal({title: `${c.name} · ${monthShort(month)}`, bodyNode: body,
    footNode: el("button", {class: "btn secondary", onclick: closeModal}, "Close")});
}

// --------------------------------------------------------------------------
//  Accounts overview (the "Accounts" tab)
// --------------------------------------------------------------------------
const ACCT_TYPE_LABEL = {checking: "Checking", savings: "Savings", cash: "Cash",
  credit: "Credit Card", asset: "Asset", liability: "Liability"};

function renderAccountsOverview(root) {
  const open = State.accounts.filter((a) => !a.closed);
  const active = open.filter((a) => !isAcctHidden(a));
  const hiddenCount = open.filter((a) => hiddenAccountIds().has(a.id)).length;
  const onB = active.filter((a) => a.on_budget);
  const offB = active.filter((a) => !a.on_budget);
  const net = active.reduce((s, a) => s + a.balance, 0);

  root.append(el("div", {class: "nw-banner"},
    el("small", {}, "Net Worth"),
    el("div", {class: "amt"}, fmt(net))));

  const section = (title, list) => {
    if (!list.length) return null;
    const total = list.reduce((s, a) => s + a.balance, 0);
    const listEl = el("div", {class: "reg-list"});
    for (const a of list) {
      const row = el("div", {class: "reg-item"},
        el("div", {class: "reg-body"},
          el("div", {class: "reg-top"},
            el("span", {class: "reg-payee"}, a.name),
            el("span", {class: "reg-amt " + (a.balance < 0 ? "out" : "in")}, fmt(a.balance))),
          el("div", {class: "reg-sub"},
            el("span", {}, (ACCT_TYPE_LABEL[a.type] || a.type) + (revealHidden && hiddenAccountIds().has(a.id) ? " · hidden" : "")),
            el("span", {}, `Cleared ${fmt(a.cleared_balance)}`))));
      row.addEventListener("click", () => navGo("account", {accountId: a.id}));
      listEl.append(row);
    }
    return el("div", {class: "acct-ov-section"},
      el("div", {class: "acct-ov-head"},
        el("span", {}, title),
        el("strong", {class: total < 0 ? "num neg" : ""}, fmt(total))),
      listEl);
  };

  const budgetSection = section("Budget Accounts", onB);
  const trackingSection = section("Tracking Accounts", offB);
  if (budgetSection) root.append(budgetSection);
  if (trackingSection) root.append(trackingSection);
  root.append(el("button", {class: "btn", style: "margin-top:16px",
    onclick: () => openAccountModal()}, "+ Add Account"));
  if (isMobile() && open.length) {
    root.append(el("div", {style: "display:flex; gap:10px; margin-top:10px; flex-wrap:wrap"},
      el("button", {class: "btn secondary", onclick: openHideAccountsModal}, "Hide accounts…"),
      hiddenCount ? el("button", {class: "btn secondary", onclick: () => { revealHidden = !revealHidden; navGo("accounts"); }},
        revealHidden ? "Hide them again" : `Show hidden accounts (${hiddenCount})`) : null));
  }
  if (!active.length && !hiddenCount)
    root.append(el("div", {class: "empty"}, "No accounts yet. Add one to get started."));
}

// --------------------------------------------------------------------------
//  Account register
// --------------------------------------------------------------------------
// Set by goToTransaction() before navigating to a register from elsewhere
// (e.g. the budget's spending-detail popup), so the freshly-rendered register
// knows which row to scroll to and briefly highlight.
let pendingFocusTxnId = null;
function goToTransaction(accountId, txnId) {
  pendingFocusTxnId = txnId;
  closeModal();
  navGo("account", {accountId});
}

// Open the Scheduled page and flash the given schedule (see renderScheduled).
function goToSchedule(id) {
  State.focusScheduledId = id;
  navGo("scheduled");
}

function goToIncomeTransactions(month, kind) {
  State.incomeTxnMonth = month;
  State.incomeTxnKind = kind;
  navGo("incomeTransactions");
}

// Sub-page reached from the budget card's "Income for {month}" / "Income
// held for {month}" lines — a read-only, cross-account list of exactly the
// transactions behind that number (money can land in any on-budget account).
async function renderIncomeTransactions(root, month, kind) {
  root.append(el("div", {class: "empty"}, "Loading…"));
  let data;
  try { data = await api(`/budget/income-transactions?month=${month}&kind=${kind}`); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  root.innerHTML = "";

  const title = kind === "held"
    ? `Income held for ${monthShort(monthAdd(month, 1))}`
    : `Income for ${monthShort(month)}`;
  root.append(el("div", {class: "toolbar"},
    el("button", {class: "btn secondary sm", onclick: () => navGo("budget")}, "‹ Back to Budget"),
    el("div", {class: "grow"}),
    el("div", {class: "help"}, title)));

  const rows = data.transactions;
  if (!rows.length) {
    root.append(el("div", {class: "empty"}, "No transactions."));
    return;
  }
  const total = rows.reduce((s, t) => s + t.amount, 0);
  root.append(el("table", {class: "register"},
    el("thead", {}, el("tr", {},
      el("th", {}, "Date"), el("th", {}, "Payee"), el("th", {}, "Account"),
      el("th", {}, "Category"), el("th", {}, "Memo"), el("th", {class: "num"}, "Amount"))),
    el("tbody", {}, ...rows.map((t) => el("tr", {class: "sched-row", title: "Go to this transaction",
        onclick: () => goToTransaction(t.account_id, t.id)},
      el("td", {}, t.date),
      el("td", {}, t.payee || "(no payee)"),
      el("td", {}, t.account_name),
      el("td", {}, t.category_name || "Uncategorized"),
      el("td", {class: "memo"}, t.memo || ""),
      el("td", {class: "num " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount, {plus: true})))))));
  root.append(el("div", {class: "help", style: "margin-top:10px"}, `Total: ${fmt(total, {plus: true})}`));
}

// The register's checkbox cell: a click anywhere in it toggles the checkbox, not
// just on the 13px box itself (the cell is a wide strip down the left edge of
// the row). The click is kept from reaching the row, which would otherwise start
// an edit. `onPress(event)` sees every real click first — box or empty space —
// so the caller can read shiftKey for range selection; synthetic clicks (the
// one we fire at the box ourselves) are ignored, since they never carry shift.
function selectCell(input, onPress) {
  const cell = el("div", {class: "c-select"}, input);
  cell.addEventListener("click", (e) => { if (onPress && e.isTrusted) onPress(e); }, true);
  cell.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target !== input) input.click();
  });
  // Shift-click would otherwise highlight all the text between the two rows.
  cell.addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });
  return cell;
}

// "Make Payment": record the amount actually paid, the date, and a confirmation number / memo, and mark the entries
// paid (cleared). Used from the register and from the Scheduled page. `txns` are the register entries to pay.
function openPaymentDialog(txns, {onDone = null, onError = null, title = null} = {}) {
  if (!txns.length) return;
  const only = txns.length === 1 ? txns[0] : null;
  const amt = amountField({
    defaultSign: only && only.amount < 0 ? -1 : 1,
    initialCents: only ? only.amount : 0});
  const date = el("input", {type: "date", value: todayStr()});
  const memo = el("input", {type: "text", placeholder: "Confirmation number / memo",
    value: only ? (only.memo || "") : ""});
  const body = el("div", {},
    el("div", {class: "field"}, el("span", {}, "Amount Paid"), amt.el),
    el("label", {class: "field"}, el("span", {}, "Date Paid"), date),
    el("label", {class: "field"}, el("span", {}, "Memo / Confirmation #"), memo));
  const save = async () => {
    const fields = {amount: amt.getCents(), memo: memo.value.trim(), cleared: 1, date: date.value, clear_mirror: true};
    closeModal();
    const job = Busy.begin("Updating", txns.length);
    try {
      for (const t of txns) {
        // clear_mirror: for a transfer, the payment also marks the other account's side paid.
        await api(`/transactions/${t.id}`, {method: "PUT", body: {...fields, version: t.version}});
        job.tick();
      }
    } catch (e) { (onError || ((err) => toast(err.message, true)))(e); }
    finally { job.end(); }
    if (onDone) await onDone();   // the register keeps its selection so further changes can follow
  };
  modal({title: title || `Make Payment${txns.length > 1 ? ` (${txns.length} selected)` : ""}`, onSubmit: save, bodyNode: body, footNode: [
    el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
    el("button", {class: "btn", onclick: save}, "Save")]});
}

// The one register screen. With no `scope` it shows a single account. With a scope it shows any other set of
// transactions (a search, a category's spending) with exactly the same abilities: ticking, inline editing, the bulk
// menu, filters, sorting, columns. A scope is {key, title, back:{label,go}, reopen(), load(), summary(), canAdd, add()}.
async function renderRegister(root, scope = null) {
  const acct = scope ? null : State.accounts.find((a) => a.id === State.accountId);
  if (!scope && !acct) { root.append(el("div", {class: "empty"}, "Account not found.")); return; }
  const scopeKey = scope ? scope.key : acct.id;
  const amountOf = (t) => (scope && t.scope_amount != null ? t.scope_amount : t.amount);   // a category page counts a split's share

  const filters = {search: "", category: "", status: "", type: "", from: "", to: "", review: ""};
  let allTxns = [];
  let filtered = [];
  let cats = null;
  // The selection survives this register being re-rendered for the same account
  // (saving from the edit dialog, the refresh after offline changes sync); it
  // resets when you switch accounts or leave the register (see navGo).
  const selected = (State.regSelection && State.regSelection.accountId === scopeKey) ? State.regSelection.ids : new Set();
  State.regSelection = {accountId: scopeKey, ids: selected};
  let anchorId = null;   // the row last ticked on its own; shift-click extends from it

  const scopeOpts = scope ? {onSaved: () => reload()} : {};   // after the edit dialog: redraw this list, not an account's register
  const search = el("input", scope && scope.serverSearch
    ? {type: "text", inputmode: "search", enterkeyhint: "search", class: "reg-search search-main", autocomplete: "off",
       placeholder: "Search payee, memo, category, account, date or amount…", value: State.searchQuery || ""}
    : {type: "text", placeholder: "Search payee, memo, amount…", class: "reg-search"});
  const filterBtn = el("button", {class: "btn secondary sm", onclick: () => openFilters()}, "Filters");
  const sortBtn = el("button", {class: "btn secondary sm", onclick: () => openSort()}, "Sort");
  const colsBtn = el("button", {class: "btn secondary sm", onclick: () => openColumns()}, "Columns");
  const reconcileBtn = el("button", {class: "btn secondary sm", onclick: () => openReconcile()}, "Reconcile");
  const bulkTrigger = el("button", {class: "btn bulk-trigger", style: "display:none",
    onclick: () => openBulkMenu(bulkTrigger)}, "");
  // Live total of whatever is ticked, right in the sticky toolbar.
  const selTotalEl = el("span", {class: "sel-total", style: "display:none", title: "Total of the selected transactions"});
  const searchAllBtn = el("button", {class: "btn secondary sm", title: "Search every account for this",
    onclick: () => { State.searchQuery = filters.search; State.searchAccount = ""; navGo("search", {accountId: null}); }},
    "Search all");
  const clearedEl = el("strong", {}, acct ? fmt(acct.cleared_balance) : "");
  const workingEl = el("strong", {}, acct ? fmt(acct.balance) : "");
  const uncatLink = el("span", {class: "uncat-link", style: "display:none",
    onclick: () => { filters.category = "__uncategorized__"; renderList(); }});
  // Arrived from another page (e.g. a scheduled transaction's history)? Offer the way back.
  const ret = scope ? scope.back : (State.regReturn && State.regReturn.accountId === acct.id ? State.regReturn : null);
  // A search page's own box and account picker. They ask the server (every account), unlike the in-register filter.
  const acctSel = scope && scope.accountPicker ? el("select", {class: "search-acct", title: "Limit to one account"},
    el("option", {value: ""}, "All accounts"),
    ...State.accounts.map((a) => el("option", {value: a.id}, a.name + (a.closed ? " (closed)" : "")))) : null;
  if (acctSel) acctSel.value = State.searchAccount || "";
  const toolbar = el("div", {class: "toolbar reg-toolbar"},
    ret ? el("button", {class: "btn secondary sm reg-back", title: ret.label,
      onclick: () => { if (!scope) State.regReturn = null; (scope ? ret.go : ret.back)(); }}, "‹ " + ret.label) : null,
    scope && !scope.serverSearch ? el("div", {class: "search-title"}, scope.title) : null,
    !scope || scope.canAdd ? el("button", {class: "btn", onclick: () => newTxn()}, "+ Add") : null,
    scope ? null : uncatLink,
    scope ? null : el("div", {class: "acct-balances"},
      el("span", {}, el("span", {class: "label"}, "Cleared "), clearedEl),
      el("span", {}, el("span", {class: "label"}, "Working "), workingEl)),
    scope ? null : el("button", {class: "btn secondary sm", onclick: () => openAccountModal(acct)}, "Edit"),
    scope ? null : reconcileBtn, search, acctSel, scope ? null : searchAllBtn, bulkTrigger, selTotalEl, sortBtn, colsBtn, filterBtn);
  root.append(toolbar);
  if (scope && scope.extra) root.append(scope.extra);   // e.g. the category page's month arrows

  // After an import: "12 transactions imported, verify categories", with a way to look at just those.
  const reviewText = el("span", {class: "review-text"});
  const reviewShow = el("button", {class: "btn sm", onclick: () => { filters.review = filters.review ? "" : "1"; renderList(); }});
  const reviewDone = el("button", {class: "btn secondary sm", onclick: async () => {
    try {
      await api("/transactions/review/clear", {method: "POST",
        body: acct ? {account_id: acct.id} : {ids: allTxns.filter((x) => x.import_review).map((x) => x.id)}});
      allTxns.forEach((x) => { x.import_review = 0; });
      filters.review = "";
      renderList();
      updateSidebarBalances();
    } catch (e) { toast(e.message, true); }
  }}, "Mark all verified");
  const reviewBar = el("div", {class: "review-bar", style: "display:none"}, reviewText, el("div", {style: "flex:1"}), reviewShow, reviewDone);
  root.append(reviewBar);
  const updateReviewBar = () => {
    const n = allTxns.filter((x) => x.import_review).length;
    reviewBar.style.display = n ? "flex" : "none";
    reviewText.textContent = `${n} transaction${n === 1 ? "" : "s"} imported, verify categories`;
    reviewShow.textContent = filters.review ? "Show all" : "Show only these";
  };
  const verifyOne = async (t) => {
    try {
      await api("/transactions/review/clear", {method: "POST", body: {ids: [t.id]}});
      t.import_review = 0;
      renderList();
      updateSidebarBalances();
    } catch (e) { toast(e.message, true); }
  };

  // Classic reconcile mode: a persistent bar (shown only while active)
  // with the live cleared total vs. the bank statement balance you entered.
  let reconcile = null;   // {target: cents} while reconciling; null otherwise
  const rTarget = el("strong", {});
  const rCleared = el("strong", {});
  const rDiff = el("strong", {class: "num"});
  const reconcileBar = el("div", {class: "reconcile-bar", style: "display:none"},
    el("span", {class: "reconcile-title"}, "Reconciling " + (acct ? acct.name : "")),
    el("span", {}, el("span", {class: "label"}, "Statement "), rTarget),
    el("span", {}, el("span", {class: "label"}, "Cleared "), rCleared),
    el("span", {}, el("span", {class: "label"}, "Difference "), rDiff),
    el("div", {style: "flex:1"}),
    el("button", {class: "btn secondary sm", onclick: () => cancelReconcile()}, "Cancel"),
    el("button", {class: "btn sm", onclick: () => finishReconcile()}, "Finish Reconciling"));
  root.append(reconcileBar);

  const summary = el("div", {class: "reg-summary"});
  const headWrap = el("div", {});
  const list = el("div", {class: "reg-list"});
  root.append(summary, headWrap, list);

  // After adding a new blank transaction, auto-focus its payee cell.
  let focusPayeeId = null;
  let openSplit = null;   // {id, save} for the currently open split panel
  let focusEdit = null;   // {id, field} to open after re-render (Tab navigation)
  // Payees from every account (loaded once), plus whatever is in this register right now.
  let knownPayees = [];
  api("/payees").then((p) => { knownPayees = p; }).catch(() => {});
  const payeeList = () => [...new Set([...allTxns.map((x) => x.payee), ...knownPayees].filter(Boolean))]
    .sort((x, y) => x.localeCompare(y, undefined, {sensitivity: "base"}));
  const EDIT_COLS = ["date", "payee", "category", "amount", "outflow", "inflow", "memo"];
  const orderedEditCols = () => cols(!isMobile()).filter((c) => EDIT_COLS.includes(c));   // the lifted row always has both amount columns
  // Whether a given field is actually editable inline for this transaction.
  // Category doesn't apply to transfers; amount is locked only for split
  // parents (a transfer's amount edits fine — the backend mirrors it to the
  // paired transaction).
  const canEditField = (t, field) =>
    field === "category" ? (!t.split_count && !t.transfer_account_name)
    : field === "amount" || field === "outflow" || field === "inflow" ? !t.split_count : true;
  // Move focus to the next/previous editable field, skipping locked ones.
  const tabMove = (t, curField, dir) => {
    const order = orderedEditCols();
    let i = order.indexOf(curField);
    if (i < 0) { focusEdit = null; return; }
    for (i += dir; i >= 0 && i < order.length; i += dir) {
      if (canEditField(t, order[i])) { focusEdit = {id: t.id, field: order[i]}; return; }
    }
    focusEdit = null;
  };
  const tabNext = (t, curField) => tabMove(t, curField, +1);
  const tabPrev = (t, curField) => tabMove(t, curField, -1);
  const tabKey = (e, t, field) => (e.shiftKey ? tabPrev : tabNext)(t, field);
  // Open the field Tab/Enter just moved to straight away, instead of waiting for the
  // save and reload to finish (on a slow connection that left a second or two where
  // typing went nowhere). If the redraw already consumed it, there's nothing left to do.
  const openPendingEdit = () => {
    if (!focusEdit) return;
    const {id, field} = focusEdit; focusEdit = null;
    const row = allTxns.find((x) => x.id === id);
    if (row) startEditByField(row, field);
  };

  const activeCount = () => {
    let n = 0;
    if (filters.category) n++;
    if (filters.status) n++;
    if (filters.type) n++;
    if (filters.from || filters.to) n++;   // a date range is one filter
    if (filters.review) n++;
    return n;
  };

  const matches = (t) => {
    const q = scope && scope.serverSearch ? "" : filters.search.trim().toLowerCase();   // a search page asks the server instead
    if (q) {
      const hay = (`${t.payee || ""} ${t.memo || ""} ${t.category_name || ""} ` +
        `${t.transfer_account_name || ""} ${dollars(t.amount)} ${dollars(Math.abs(t.amount))}`).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // The toolbar's small "X Uncategorized" link — genuinely needs a category
    // assigned, unlike the Filters dialog's "Uncategorized / transfers" option
    // (transfers and split parents are never meant to carry one).
    if (filters.category === "__uncategorized__") {
      if (t.category_id || t.transfer_account_name || t.split_count) return false;
    } else if (filters.category === "none") { if (t.category_id) return false; }
    else if (filters.category !== "" && String(t.category_id) !== filters.category) return false;
    if (filters.status === "cleared" && !t.cleared) return false;
    if (filters.status === "uncleared" && t.cleared) return false;
    if (filters.status === "reconciled" && t.cleared !== 2) return false;
    if (filters.type === "inflow" && t.amount <= 0) return false;
    if (filters.type === "outflow" && t.amount >= 0) return false;
    if (filters.from && t.date < filters.from) return false;
    if (filters.to && t.date > filters.to) return false;
    if (filters.review && !t.import_review) return false;
    return true;
  };

  const clearedTotal = () => allTxns.reduce((s, t) => s + (t.cleared ? t.amount : 0), 0);
  const refreshBalances = () => {
    if (!acct) return;   // a search / category page has no balances of its own
    workingEl.textContent = fmt(allTxns.reduce((s, t) => s + t.amount, 0));
    clearedEl.textContent = fmt(clearedTotal());
    const uncatCount = allTxns.filter((t) => !t.category_id && !t.transfer_account_name && !t.split_count).length;
    uncatLink.textContent = uncatCount ? `${uncatCount} Uncategorized` : "";
    uncatLink.style.display = uncatCount ? "" : "none";
    if (reconcile) {
      const cleared = clearedTotal();
      const diff = reconcile.target - cleared;
      rTarget.textContent = fmt(reconcile.target);
      rCleared.textContent = fmt(cleared);
      rDiff.textContent = fmt(diff);
      rDiff.classList.toggle("neg", diff !== 0);
      rDiff.classList.toggle("pos", diff === 0);
    }
  };
  const onCleared = () => { refreshBalances(); renderList(); };
  const clearAll = () => {
    const keep = scope && scope.serverSearch ? filters.search : "";   // a search page's own words aren't a filter to clear
    Object.keys(filters).forEach((k) => filters[k] = "");
    filters.search = keep;
    if (!(scope && scope.serverSearch)) search.value = "";
    renderList();
  };

  let colWidths = getColWidths();
  // The Account column is for lists that mix accounts; a single account's register doesn't need it.
  // Amounts can be one signed column, or two: Outflow and Inflow (no minus or plus to type). Either way they take
  // the Amount column's place. A brand-new entry always gets the two, so it's obvious which kind you're typing.
  // `force` is for the lifted row being edited, which always shows both.
  const splitAmounts = (force) => !isMobile() && (force || getPref("amountColumns", "single") === "split");
  const cols = (force = false) => {
    const h = getHiddenCols();
    return getColumns().filter((c) => !h.has(c) && (scope || c !== "account"))
      .flatMap((c) => (c === "amount" && splitAmounts(force) ? ["outflow", "inflow"] : [c]));
  };
  const gridTemplate = (force = false) => "56px " + cols(force).map((c) => colWidths[c] ? colWidths[c] + "px" : REG_COL_META[c].w).join(" ");
  // All rows + header share one CSS var, so a resize updates them all at once.
  const applyGrid = () => document.documentElement.style.setProperty("--reg-grid", gridTemplate());
  // The row being edited is "lifted" out of the register: a raised card, in the same place, with its own column
  // names above it and Save / Cancel. liftId says which row; liftDrawn remembers it was already drawn (so the
  // lift-in animation plays once, not again at every Tab).
  let liftId = null, liftDrawn = null, savesPending = 0;

  const buildHeader = () => {
    headWrap.innerHTML = "";
    const allChecked = filtered.length > 0 && filtered.every((t) => selected.has(t.id));
    const selAll = el("input", {type: "checkbox"});
    selAll.checked = allChecked;
    selAll.addEventListener("change", () => {
      if (selAll.checked) filtered.forEach((t) => selected.add(t.id));
      else filtered.forEach((t) => selected.delete(t.id));
      renderList();
    });
    const headCell = (c) => {
      const cellEl = el("div", {class: "c-cell c-head c-" + c, draggable: "true"}, REG_COL_META[c].label);
      // drag to reorder
      const slot = (x) => (x === "outflow" || x === "inflow" ? "amount" : x);   // the two amount columns move together
      cellEl.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", slot(c)); e.dataTransfer.effectAllowed = "move"; });
      cellEl.addEventListener("dragover", (e) => { e.preventDefault(); cellEl.classList.add("dragover"); });
      cellEl.addEventListener("dragleave", () => cellEl.classList.remove("dragover"));
      cellEl.addEventListener("drop", (e) => {
        e.preventDefault(); cellEl.classList.remove("dragover");
        const src = e.dataTransfer.getData("text/plain");
        if (!src || src === slot(c)) return;
        const order = getColumns().filter((x) => x !== src);
        order.splice(order.indexOf(slot(c)), 0, src);
        setColumns(order); renderList();
      });
      // drag the right edge to resize (disable the cell's native drag meanwhile)
      const handle = el("div", {class: "col-resize"});
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        cellEl.draggable = false;
        const startX = e.clientX, startW = cellEl.offsetWidth;
        const move = (ev) => { colWidths[c] = Math.max(48, Math.round(startW + (ev.clientX - startX))); applyGrid(); };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          cellEl.draggable = true;
          setColWidths(colWidths);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
      cellEl.append(handle);
      return cellEl;
    };
    headWrap.append(el("div", {class: "reg-head"},
      selectCell(selAll),
      ...cols().map(headCell)));
  };

  const setRowSelected = (id, on) => {
    if (on) selected.add(id); else selected.delete(id);
    const row = list.querySelector(`.reg-row[data-id="${id}"]`);
    if (!row) return;
    row.classList.toggle("selected", on);
    const box = row.querySelector(".c-select input");
    if (box) box.checked = on;
  };

  const updateBulk = () => {
    // Showing or hiding the "N selected" button and total can make the toolbar
    // wrap onto another line, which would shove every row down (or up) under
    // the pointer mid-selection. Scroll by the same amount so the rows stay put.
    const topBefore = list.getBoundingClientRect().top;
    if (!selected.size) {
      bulkTrigger.style.display = "none"; selTotalEl.style.display = "none";
    } else {
      bulkTrigger.style.display = "";
      bulkTrigger.textContent = `${selected.size} selected ▾`;
      const total = allTxns.reduce((sum, t) => sum + (selected.has(t.id) ? amountOf(t) : 0), 0);
      selTotalEl.replaceChildren(el("span", {class: "label"}, "Selected "),
        el("strong", {class: total < 0 ? "out" : total > 0 ? "in" : ""}, fmt(total, {plus: true})));
      selTotalEl.style.display = "";
    }
    const moved = list.getBoundingClientRect().top - topBefore;
    if (moved) window.scrollBy(0, moved);
  };

  // Small icons shown beside a row's date: a recurring (scheduled) transaction, and a transfer.
  // Clicking one jumps to the schedule, or to the other side of the transfer in its account.
  const ICON_SVG = {
    recurring: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 0 0-9.4-3.9L2.5 5.7"/><path d="M2.5 2.5v3.2h3.2"/><path d="M2.5 8a5.5 5.5 0 0 0 9.4 3.9l1.6-1.6"/><path d="M13.5 13.5v-3.2h-3.2"/></svg>',
    transfer: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h12M10.5 1.8 14 5"/><path d="M14 11H2M5.5 14.2 2 11"/></svg>',
  };
  const regIcon = (kind, title, onClick) => {
    const n = el("span", {class: "reg-ico reg-ico-" + kind, title, role: "button", "aria-label": title, html: ICON_SVG[kind]});
    n.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return n;
  };
  const rowIcons = (t) => {
    const icons = [];
    if (t.scheduled_id) icons.push(regIcon("recurring", "Recurring (scheduled) transaction — click to view the schedule",
      () => goToSchedule(t.scheduled_id)));
    if (t.transfer_account_id && t.transfer_txn_id) icons.push(regIcon("transfer",
      `Transfer ${t.amount < 0 ? "to" : "from"} ${t.transfer_account_name} — click to open it there`,
      () => {
        // Show the other account's side of it, with a way back to this one.
        State.regReturn = {accountId: t.transfer_account_id, label: `Back to ${scope ? scope.title : acct.name}`,
          back: () => (scope ? scope.reopen() : goToTransaction(acct.id, t.id))};
        goToTransaction(t.transfer_account_id, t.transfer_txn_id);
      }));
    if (t.import_review) icons.push(el("button", {type: "button", class: "reg-verify",
      title: "Imported: click to mark as checked", onclick: (e) => { e.stopPropagation(); verifyOne(t); }}, "✓"));
    return icons;
  };

  const buildRow = (t, lifted = false) => {
    const isTransfer = !!t.transfer_account_name;
    const isSplit = t.split_count > 0;
    // A transfer has no real payee and no category: the other account IS the payee (shown as
    // "Transfer : Savings"), and the category column just says Transfer, in muted italics, locked.
    const catName = isSplit ? `▸ Split (${t.split_count})`
      : isTransfer ? "Transfer" : (t.category_name || "Uncategorized");
    const catPlain = !isTransfer && (t.category_name || isSplit);
    const payeeText = isTransfer ? `Transfer : ${t.transfer_account_name}` : (t.payee || "(no payee)");

    // A click inside an editor that's already open (e.g. to place the cursor) bubbles up
    // to this cell; starting a new editor would tear the open one down and lose it.
    const editable = (node, fn, noLift = false) => {
      node.classList.add("editable");
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        if (node.classList.contains("editing")) return;
        fn(lifted || noLift || isMobile() ? node : liftRow(t, node) || node);   // editing happens in the lifted copy of the row
      });
      return node;
    };
    const catClick = (node) => {
      if (openSplit && openSplit.id === t.id) { openSplit.save(); return; }   // clicking Split again = Save
      if (isSplit) openSplitPanel(t);
      else startCategoryEdit(node, t);
    };

    const cell = (c) => {
      if (c === "date") return editable(el("div", {class: "c-cell c-date"},
        el("span", {class: "c-date-text"}, t.date), ...rowIcons(t)), (n) => startDateEdit(n, t));
      if (c === "payee") return editable(el("div", {class: "c-cell c-payee"}, payeeText), (n) => startPayeeEdit(n, t));
      if (c === "category") {
        const n = el("div", {class: "c-cell c-category" + (catPlain ? "" : " muted") + (!isTransfer && !isSplit && !t.category_id ? " uncat" : ""),
          title: !isTransfer && !isSplit && !t.category_id ? "No category yet: click to choose one" : null}, catName);
        if (!isTransfer) editable(n, catClick, isSplit);   // a split opens its own panel; a transfer's category is fixed (change the transfer from the Payee cell)
        return n;
      }
      if (c === "memo") return editable(el("div", {class: "c-cell c-memo"}, t.memo || ""), (n) => startMemoEdit(n, t));
      if (c === "amount") {
        const n = el("div", {class: "c-cell c-amount " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount, {plus: true}));
        if (amountOf(t) !== t.amount) n.title = `${fmt(amountOf(t), {plus: true})} of this is in ${scope.title}`;
        if (!isSplit) editable(n, (x) => {
          // On the raised card the Amount cell has become Outflow / Inflow: edit whichever one it landed on.
          if (x.classList.contains("c-outflow")) startSignedAmountEdit(x, t, -1);
          else if (x.classList.contains("c-inflow")) startSignedAmountEdit(x, t, 1);
          else startAmountEdit(x, t);
        });
        return n;
      }
      if (c === "outflow" || c === "inflow") {
        const isOut = c === "outflow", mine = isOut ? t.amount < 0 : t.amount > 0;
        const n = el("div", {class: `c-cell c-${c} ${isOut ? "out" : "in"}`}, mine ? fmt(Math.abs(t.amount)) : "");
        if (!isSplit) editable(n, (x) => startSignedAmountEdit(x, t, isOut ? -1 : 1));
        return n;
      }
      if (c === "account") return editable(el("div", {class: "c-cell c-account", title: "Open this account's register"}, t.account_name || ""), () => {
        State.regReturn = {accountId: t.account_id, label: `Back to ${scope.title}`, back: () => scope.reopen()};
        goToTransaction(t.account_id, t.id);
      });
      if (c === "cleared") return el("div", {class: "c-cell c-cleared"}, makeClearedFlag(t, onCleared, !!reconcile, reload));
    };
    const cb = el("input", {type: "checkbox"});
    cb.checked = selected.has(t.id);
    cb.addEventListener("click", (e) => e.stopPropagation());
    let shiftDown = false;
    cb.addEventListener("change", () => {
      const on = cb.checked;
      const ids = filtered.map((x) => x.id);
      const from = ids.indexOf(anchorId), to = ids.indexOf(t.id);
      if (shiftDown && from >= 0 && to >= 0 && anchorId !== t.id) {
        // Everything between the anchor and this row (in the order shown) follows this row's new state.
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) setRowSelected(ids[i], on);
      } else {
        setRowSelected(t.id, on);
      }
      shiftDown = false;
      anchorId = t.id;
      buildHeader(); updateBulk();
    });
    // Mobile stacked layout: inline per-cell editing is fiddly on a phone, so a
    // tap anywhere on the row opens the full edit dialog (same as adding one).
    // No per-row date here — the sticky .reg-day banner (above or below each
    // day's group, per the "Day divider position" preference) already covers
    // it, so repeating it on every row would just be noise.
    const pSpan = el("span", {class: "reg-payee"}, payeeText);
    const cSpan = el("span", {class: catPlain ? "" : "muted"}, catName);
    const mSpan = el("span", {class: "reg-memo"}, t.memo || "");
    const stack = el("div", {class: "reg-stack"},
      el("div", {class: "reg-top"}, ...rowIcons(t), pSpan),
      el("div", {class: "reg-sub"}, scope ? el("span", {class: "reg-acct"}, t.account_name) : null, cSpan, mSpan));
    stack.addEventListener("click", () => openTxnModal(t.account_id, t, payeeList(), scopeOpts));

    return el("div", {class: "reg-row" + (selected.has(t.id) ? " selected" : "") + (t.import_review ? " reg-new" : ""), "data-id": t.id},
      selectCell(cb, (e) => { shiftDown = e.shiftKey; }),
      ...(lifted ? cols(true) : cols()).map(cell), stack);
  };

  // The raised editing card. The row keeps exactly its place in the register (this wrapper is the row's height); the
  // card grows out from it: the column names above, drawn over the neighbouring rows. Enter saves, Esc cancels.
  let rowH = 0;   // height of an ordinary row, so the card can hold the row's place
  const buildLift = (t, height = rowH) => {
    const fresh = liftDrawn !== t.id;
    liftDrawn = t.id;
    const row = buildRow(t, true);
    row.classList.add("lifted");
    const names = el("div", {class: "reg-head reg-lift-head"}, el("div", {class: "c-cell c-select"}),
      ...cols(true).map((c) => el("div", {class: "c-cell c-head c-" + c}, REG_COL_META[c].label)));
    return el("div", {class: "reg-lift" + (fresh ? " fresh" : ""), "data-lift": t.id,
      style: `--reg-grid:${gridTemplate(true)};--slot:${height || 30}px;height:${height || 30}px`, onclick: (e) => e.stopPropagation()},
      el("div", {class: "reg-lift-shape"}), names, row);
  };
  // Pull the card's right edge in to just past the last thing on the row (the Cleared chip), leaving the same small
  // gap the fields have below them.
  const fitLifts = () => {
    list.querySelectorAll(".reg-lift").forEach((card) => {
      const cells = [...card.querySelectorAll(".reg-row > .c-cell")].filter((c) => c.offsetParent !== null);
      const last = cells[cells.length - 1];
      if (!last) return;
      const range = document.createRange();
      range.selectNodeContents(last);
      const right = range.getBoundingClientRect().right;
      if (!right) return;
      const box = card.getBoundingClientRect();
      card.style.setProperty("--lift-inset", Math.round(box.right - right - 6) + "px");
    });
  };
  // Swap a plain row for its lifted card without redrawing the whole register; returns the matching cell in it.
  const liftRow = (t, node) => {
    const rowEl = node.closest(".reg-row");
    if (!rowEl || rowEl.closest(".reg-lift")) return null;
    // Only one row is raised at a time: put any other one back in the register first.
    list.querySelectorAll(".reg-lift").forEach((old) => {
      if (old.dataset.lift === String(t.id)) return;
      const was = allTxns.find((x) => String(x.id) === old.dataset.lift);
      if (was) old.replaceWith(buildRow(was)); else old.remove();
    });
    [...list.querySelectorAll(".reg-row")].forEach((r, i) => r.classList.toggle("alt", i % 2 === 1));
    liftId = t.id;
    let field = [...node.classList].map((c) => /^c-(date|payee|category|memo|amount|outflow|inflow|account|cleared)$/.exec(c)).find(Boolean);
    field = field ? field[1] : null;
    if (field === "amount") field = t.amount > 0 ? "inflow" : "outflow";
    rowH = rowEl.offsetHeight || rowH;
    const card = buildLift(t, rowH);
    rowEl.replaceWith(card);
    fitLifts();
    return field ? card.querySelector(".reg-row .c-" + field) : null;
  };
  const rowFor = (t) => (t.id === liftId && !isMobile() ? buildLift(t) : buildRow(t));

  // A save that lost a race against someone else's edit to the same row:
  // offer one tap to pull their change in, rather than a dead-end error.
  const toastSaveError = (e) =>
    toast(e.message, true, e.conflict ? {label: "Reload", onClick: reload, sticky: true} : null);

  // ---- discarding a blank new entry ----
  // "+ Add" creates the row on the server straight away so its cells can be
  // edited inline. If Escape is hit while that row is still completely blank,
  // remove it instead of leaving an empty transaction behind.
  let newEntryId = null;
  // How many inline editors are open. A reload that lands while one is open must not
  // redraw the register (that would destroy the editor — and what's being typed — on a
  // slow connection); it just refreshes the data and the editor's own close redraws.
  let editing = 0;
  let redrawPending = false;   // a reload landed while an editor was open and hasn't been drawn yet
  const editorClosed = () => {
    editing = Math.max(0, editing - 1);
    // Closed by clicking elsewhere with nothing to save (so nothing redraws): put the row back in a moment, unless
    // another editor opens (Tab, a click on another cell) or a save is on its way (its reload redraws).
    if (liftId != null) setTimeout(() => {
      if (liftId != null && !editing && !savesPending && focusEdit == null) { liftId = null; renderList(); }
    }, 250);
    // Closed without saving anything (so nothing redraws): draw the data that arrived meanwhile.
    // Slightly later, not now, so a click that caused this blur still reaches the cell under it.
    if (!editing && redrawPending) setTimeout(() => { if (!editing && redrawPending) renderList(); }, 400);
  };
  const discardIfBlankNew = (t) => {
    if (!t || newEntryId !== t.id) return;
    // Wait for any save still in flight (e.g. the transfer the person just chose) and judge the
    // row by its LATEST data: an editor opened before that save finished still holds the old,
    // blank copy, and going by that would delete an entry that now has something in it.
    saveChain = saveChain.then(async () => {
      const cur = allTxns.find((x) => x.id === t.id);
      if (!cur) return;
      const blank = !cur.payee && !cur.amount && !cur.memo && !cur.category_id && !cur.transfer_account_id && !cur.split_count;
      if (!blank) return;
      newEntryId = null;
      try { await api(`/transactions/${t.id}`, {method: "DELETE"}); await reload(); }
      catch (e) { toastSaveError(e); }
    });
  };

  // ---- per-cell inline editing ----
  // Saves run one after another, each using the row's LATEST version: an editor opened
  // before an earlier save finished is holding a stale copy of the row, and sending its
  // old version would be rejected as if someone else had changed it.
  let saveChain = Promise.resolve();
  const commitField = (t, fields) => {
    savesPending++;
    saveChain = saveChain.then(async () => {
      const latest = allTxns.find((x) => x.id === t.id) || t;
      try { await api(`/transactions/${t.id}`, {method: "PUT", body: {...fields, version: latest.version}}); await reload(); }
      catch (e) { toastSaveError(e); }
      finally { savesPending--; }
    });
    return saveChain;
  };
  const textEditor = (cellEl, cur, onCommit, {money = false, field = null, t = null, shown = null} = {}) => {
    let done = false;
    const inp = el("input", {class: "cell-edit", type: "text", value: cur});
    if (money) { inp.style.textAlign = "right"; wireSmartMoneyInput(inp); }
    const prev = [...cellEl.childNodes];
    cellEl.classList.add("editing");
    cellEl.replaceChildren(inp); inp.focus(); inp.select();
    editing++;
    // quiet: closed by clicking elsewhere with nothing changed — put the cell back as it
    // was instead of redrawing the whole register, which could swallow that very click.
    const finish = (ok, quiet = false) => {
      if (done) return; done = true; editorClosed();
      if (ok && quiet && inp.value === cur) { cellEl.classList.remove("editing"); cellEl.replaceChildren(...prev); return; }
      if (ok) {
        // Show the new value right away; the reload after the save will redraw it for real.
        cellEl.classList.remove("editing");
        cellEl.replaceChildren(document.createTextNode(shown ? shown(inp.value) : money ? fmt(toCents(inp.value), {plus: true}) : inp.value));
        onCommit(inp.value);
      } else renderList();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") { finish(false); discardIfBlankNew(t); }
      else if (e.key === "Tab") { e.preventDefault(); if (t && field) tabKey(e, t, field); finish(true); openPendingEdit(); }
    });
    inp.addEventListener("blur", () => finish(true, true));
  };
  const startDateEdit = (cellEl, t) => {
    let done = false;
    const inp = el("input", {class: "cell-edit", type: "date", value: t.date});
    const prev = [...cellEl.childNodes];
    cellEl.classList.add("editing");
    cellEl.replaceChildren(inp); inp.focus();
    editing++;
    // Pop the calendar open right away instead of making the user hit the icon.
    try { inp.showPicker(); } catch { /* not user-activated / unsupported */ }
    const finish = (ok, quiet = false) => {
      if (done) return; done = true; editorClosed();
      if (ok && inp.value && inp.value !== t.date) { cellEl.classList.remove("editing"); cellEl.replaceChildren(document.createTextNode(inp.value)); commitField(t, {date: inp.value}); }
      else if (ok && quiet) { cellEl.classList.remove("editing"); cellEl.replaceChildren(...prev); }
      else renderList();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") { finish(false); discardIfBlankNew(t); }
      else if (e.key === "Tab") { e.preventDefault(); tabKey(e, t, "date"); finish(true); openPendingEdit(); }
    });
    // Picking a day from the native calendar fires change; commit immediately.
    inp.addEventListener("change", () => finish(true));
    inp.addEventListener("blur", () => finish(true, true));
  };
  const startMemoEdit = (cellEl, t) => textEditor(cellEl, t.memo || "", (v) => { if (v !== (t.memo || "")) commitField(t, {memo: v}); else renderList(); }, {field: "memo", t});
  const startAmountEdit = (cellEl, t) => textEditor(cellEl, t.amount ? dollars(t.amount) : "", (v) => { const c = toCents(v); if (c !== t.amount) commitField(t, {amount: c, splits: []}); else renderList(); }, {money: true, field: "amount", t});
  // An Outflow or Inflow cell: what you type is the amount, and the column says which way it goes.
  // Typing into the other column on a row moves it across.
  const startSignedAmountEdit = (cellEl, t, sign) => {
    const own = Math.sign(t.amount) === sign;
    textEditor(cellEl, own ? dollars(Math.abs(t.amount)) : "", (v) => {
      const c = Math.abs(toCents(v)) * sign;
      if (!c && !own) return renderList();      // left an empty cell empty
      if (c !== t.amount) commitField(t, {amount: c, splits: []}); else renderList();
    }, {money: true, field: sign < 0 ? "outflow" : "inflow", t, shown: (v) => fmt(Math.abs(toCents(v)))});
  };
  const startPayeeEdit = (cellEl, t) => {
    let done = false;
    const isXfer = !!t.transfer_account_name;
    // Other accounts you can transfer to; they head the dropdown's Transfer section.
    const accounts = State.accounts.filter((a) => !a.closed && a.id !== t.account_id);
    const ctl = inlinePayeeField(payeeList(), isXfer ? `Transfer : ${t.transfer_account_name}` : (t.payee || ""),
      {accounts, initialAccountId: isXfer ? t.transfer_account_id : null});
    const prev = [...cellEl.childNodes];
    cellEl.classList.add("editing");
    cellEl.replaceChildren(ctl.el);
    const inp = ctl.el.querySelector("input"); inp.focus(); inp.select();
    ctl.open();
    editing++;
    const unchanged = (quiet) => {
      if (quiet) { cellEl.classList.remove("editing"); cellEl.replaceChildren(...prev); } else renderList();
    };
    const show = (text) => { cellEl.classList.remove("editing"); cellEl.replaceChildren(document.createTextNode(text)); };
    // Until the save lands and the row is redrawn, make the Category cell agree: it's locked
    // "Transfer" for a transfer, or plain "Uncategorized" again once a transfer becomes normal.
    const markCategory = (isTransferNow) => {
      const c = cellEl.closest(".reg-row")?.querySelector(".c-category");
      if (!c) return;
      const n = c.cloneNode(false);   // a clone has no click handler: a transfer's category can't be edited
      n.className = "c-cell c-category muted";
      n.textContent = isTransferNow ? "Transfer" : "Uncategorized";
      c.replaceWith(n);
    };
    const finish = (ok, quiet = false) => {
      if (done) return; done = true; editorClosed();
      const v = ctl.getValue().trim(), aid = ctl.getAccountId();
      if (!ok) return renderList();
      if (aid) {   // an account was chosen: this becomes (or stays) a transfer to it
        if (isXfer && aid === t.transfer_account_id) return unchanged(quiet);
        show("Transfer : " + (accounts.find((a) => a.id === aid) || {}).name);
        markCategory(true);
        commitField(t, {transfer_account_id: aid, payee: ""});
      } else if (isXfer) {   // a normal payee on a transfer turns it into an ordinary transaction
        if (!v) return unchanged(quiet);
        if (!confirm(`Make this a regular transaction with payee “${v}”?\n\nThe matching transfer entry in ${t.transfer_account_name} will be removed.`)) return renderList();
        show(v);
        markCategory(false);
        commitField(t, {payee: v, category_id: null, splits: [], unlink_transfer: true});
      } else if (v !== (t.payee || "")) {
        show(v || "(no payee)");
        commitField(t, {payee: v});
      } else unchanged(quiet);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") { finish(false); discardIfBlankNew(t); }
      // After choosing a transfer account there's no category to fill in: go straight to the memo.
      else if (e.key === "Tab") { e.preventDefault(); tabKey(e, t, ctl.getAccountId() ? "category" : "payee"); finish(true); openPendingEdit(); }
    });
    inp.addEventListener("blur", () => setTimeout(() => finish(true, true), 150));
  };
  const startCategoryEdit = (cellEl, t) => {
    let done = false;
    const commit = (fn) => { if (done) return; done = true; editorClosed(); fn(); };
    const ctl = inlineCategoryField(cats, t.category_id || null,
      (id) => commit(() => commitField(t, {category_id: id || null, splits: []})),
      () => commit(() => {
        // Closed by a mouse click on another cell of the same raised row: put this cell back quietly. Redrawing now
        // would replace the cell under the pointer before the click lands, and that click (say, on Memo) would be lost.
        const ev = window.event, inside = ev && ev.type === "mousedown" && ev.target && ev.target.closest && ev.target.closest(".reg-lift");
        if (inside) { cellEl.classList.remove("editing"); cellEl.replaceChildren(...prev); return; }
        renderList(); discardIfBlankNew(t);
      }),
      () => commit(() => { cellEl.classList.remove("editing"); cellEl.replaceChildren(document.createTextNode("▸ Split")); openSplitPanel(t); }),
      // Picking a category with Enter should also advance to the next field so
      // the keyboard flow keeps going (the commit re-renders the row).
      () => { tabNext(t, "category"); openPendingEdit(); });
    const prev = [...cellEl.childNodes];
    cellEl.classList.add("editing");
    cellEl.replaceChildren(ctl.el);
    editing++;
    ctl.el.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      // A highlighted choice is applied (it saves like Enter does), then on to the next field.
      if (ctl.pickHighlighted()) { tabKey(e, t, "category"); openPendingEdit(); }
      else commit(() => { tabKey(e, t, "category"); renderList(); });
    }, true);
    ctl.open();
  };
  const startEditByField = (t, field) => {
    if (field === "amount" && !isMobile()) field = t.amount > 0 ? "inflow" : "outflow";   // the raised row splits Amount in two
    const cellEl = list.querySelector(`.reg-row[data-id="${t.id}"] .c-${field}`);
    if (!cellEl) return;
    if (field === "date") startDateEdit(cellEl, t);
    else if (field === "payee") startPayeeEdit(cellEl, t);
    else if (field === "memo") startMemoEdit(cellEl, t);
    else if (field === "category" && canEditField(t, "category")) startCategoryEdit(cellEl, t);
    else if (field === "amount" && canEditField(t, "amount")) startAmountEdit(cellEl, t);
    else if ((field === "outflow" || field === "inflow") && canEditField(t, field)) startSignedAmountEdit(cellEl, t, field === "outflow" ? -1 : 1);
  };

  // ---- inline split editor panel (opens under the row) ----
  const openSplitPanel = async (t) => {
    list.querySelectorAll(".split-panel").forEach((p) => p.remove());
    let splits = [];
    if (t.split_count) { try { const sp = await api(`/transactions/${t.id}/splits`); splits = sp.map((s) => ({categoryId: s.category_id, cents: s.amount, memo: s.memo || ""})); } catch { /* ignore */ } }
    if (!splits.length) splits = [{categoryId: t.category_id || null, cents: t.amount || 0, memo: ""}];
    const total = t.amount;
    const box = el("div", {class: "split-panel"});
    const splitTotal = () => splits.reduce((a, s) => a + s.cents, 0);
    let remEl, addBtn;
    const updateRem = () => {
      const remaining = total - splitTotal();
      if (remEl) { remEl.textContent = remaining === 0 ? "All " + fmt(total) + " assigned" : "Remaining " + fmt(remaining); remEl.className = "split-remaining " + (remaining === 0 ? "ok" : "off"); }
      if (addBtn) addBtn.textContent = remaining !== 0 ? `+ Add split (${fmt(remaining)})` : "+ Add split";
    };
    const render = () => {
      box.innerHTML = "";
      box.append(el("div", {class: "split-panel-head"}, `Split ${fmt(total)} — click “Split” again or Save to finish`));
      splits.forEach((s, i) => {
        const cf = inlineCategoryField(cats, s.categoryId, (id) => { s.categoryId = id; });
        const ai = el("input", {class: "cell-edit split-amt-inp", type: "text", inputmode: "decimal", value: s.cents ? dollars(s.cents) : ""});
        wireSmartMoneyInput(ai, (c) => { s.cents = c; updateRem(); });
        const mi = el("input", {class: "cell-edit split-memo-inp", type: "text", placeholder: "Memo", value: s.memo || ""});
        mi.addEventListener("input", () => { s.memo = mi.value; });
        const rm = el("button", {class: "btn ghost sm", type: "button", onclick: () => { splits.splice(i, 1); render(); }}, "✕");
        box.append(el("div", {class: "split-row"}, cf.el, ai, mi, rm));
      });
      const remaining = total - splitTotal();
      addBtn = el("button", {class: "btn ghost sm", type: "button", onclick: () => { splits.push({categoryId: null, cents: total - splitTotal(), memo: ""}); render(); }},
        remaining !== 0 ? `+ Add split (${fmt(remaining)})` : "+ Add split");
      remEl = el("div", {class: "split-remaining " + (remaining === 0 ? "ok" : "off")},
        remaining === 0 ? "All " + fmt(total) + " assigned" : "Remaining " + fmt(remaining));
      box.append(el("div", {class: "split-foot"}, addBtn, remEl, el("div", {style: "flex:1"}),
        el("button", {class: "btn secondary sm", type: "button", onclick: () => renderList()}, "Cancel"),
        el("button", {class: "btn sm", type: "button", onclick: save}, "Save")));
    };
    const save = async () => {
      const lines = splits.filter((s) => s.cents !== 0);
      const sum = lines.reduce((a, s) => a + s.cents, 0);
      if (sum !== total) return toast(`Splits must total ${fmt(total)} (off by ${fmt(total - sum)})`, true);
      try {
        await api(`/transactions/${t.id}`, {method: "PUT", body: {
          splits: lines.map((s) => ({category_id: s.categoryId, amount: s.cents, memo: s.memo || ""})),
          version: t.version}});
        await reload();
      } catch (e) { toastSaveError(e); }
    };
    openSplit = {id: t.id, save};
    render();
    const rowEl = list.querySelector(`.reg-row[data-id="${t.id}"]`);
    if (rowEl) {
      rowEl.after(box);
      // Indent the split rows to line up under the Category column.
      const catCell = rowEl.querySelector(".c-category");
      if (catCell) box.style.paddingLeft = Math.max(20, Math.round(catCell.getBoundingClientRect().left - list.getBoundingClientRect().left)) + "px";
    } else list.append(box);
  };

  const newTxn = async () => {
    if (scope) { scope.add(); return; }
    if (!cats) cats = await api("/categories");
    // On a phone, the same big-number entry as the Add button on the budget, set to this account.
    if (isMobile()) { openAddTransaction({accountId: acct.id, onSaved: () => reload()}); return; }
    try {
      const r = await api("/transactions", {method: "POST", body: {account_id: acct.id, date: todayStr(), payee: "", amount: 0, cleared: 0}});
      focusPayeeId = r.id || null;
      newEntryId = r.id || null;
      if (!isMobile()) liftId = r.id || null;   // the new entry is filled in on a raised card
      await reload();
    } catch (e) { toast(e.message, true); }
  };

  const reload = async () => {
    const [txns] = await Promise.all([
      scope ? scope.load() : api(`/transactions?account_id=${acct.id}`),
      updateSidebarBalances(),   // the edit may have changed this (or another) account's balance
    ]);
    allTxns = txns;
    refreshBalances();
    if (editing > 0) { redrawPending = true; return; }   // an editor is open: drawn when it closes
    renderList();
  };
  const bulkApply = async (fields) => {
    const ids = [...selected];
    const job = Busy.begin("Updating", ids.length);
    try {
      for (const id of ids) {
        const t = allTxns.find((x) => x.id === id);
        await api(`/transactions/${id}`, {method: "PUT", body: {...fields, version: t?.version}});
        job.tick();
      }
    } catch (e) { toastSaveError(e); }
    finally { job.end(); }
    await reload();   // the selection is kept so further changes can follow without re-selecting
  };
  // Move every selected entry to another account (entered in the wrong one).
  const openMoveToAccount = () => {
    const ids = [...selected];
    const targets = State.accounts.filter((a) => !a.closed && (!acct || a.id !== acct.id));
    if (!targets.length) return toast("There's no other account to move to", true);
    const sel = el("select", {}, ...targets.map((a) => el("option", {value: a.id}, a.name)));
    const save = async () => {
      const dest = Number(sel.value);
      // A transfer can't end up with both sides in one account: leave those out.
      const movable = ids.filter((id) => {
        const t = allTxns.find((x) => x.id === id);
        if (!t || t.transfer_account_id === dest) return false;
        // An unpaid entry a schedule created belongs to that schedule's account.
        return !(t.scheduled_id && t.sched_auto && !t.cleared);
      });
      const skipped = ids.length - movable.length;
      closeModal();
      const job = Busy.begin("Moving", movable.length);
      try {
        for (const id of movable) {
          const t = allTxns.find((x) => x.id === id);
          await api(`/transactions/${id}`, {method: "PUT", body: {account_id: dest, version: t.version}});
          job.tick();
        }
        const name = (targets.find((a) => a.id === dest) || {}).name;
        toast(`Moved ${movable.length} transaction${movable.length === 1 ? "" : "s"} to ${name}`
          + (skipped ? ` (${skipped} left where ${skipped === 1 ? "it was" : "they were"}: transfers with that account or unpaid scheduled entries)` : ""));
      } catch (e) { toastSaveError(e); }
      finally { job.end(); }
      await refreshAccounts();
      await reload();
    };
    modal({title: `Move ${ids.length} transaction${ids.length === 1 ? "" : "s"}`, onSubmit: save,
      bodyNode: el("label", {class: "field"}, el("span", {}, "Move to account"), sel),
      footNode: [el("div", {style: "flex:1"}),
        el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
        el("button", {class: "btn", onclick: save}, "Move")]});
  };
  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} transaction(s)?`)) return;
    const ids = [...selected];
    const job = Busy.begin("Deleting", ids.length);
    try { for (const id of ids) { await api(`/transactions/${id}`, {method: "DELETE"}); job.tick(); } }
    finally { job.end(); }
    selected.clear(); await reload();
  };
  // Record the actual amount paid + a confirmation-number/memo, and mark the
  // selected transaction(s) Paid (cleared=1) — turns Due Soon/Past Due badges
  // into Paid, same as toggling one during reconcile, but with real details.
  const openMakePayment = () => {
    const txns = [...selected].map((id) => allTxns.find((t) => t.id === id)).filter(Boolean);
    openPaymentDialog(txns, {onDone: reload, onError: toastSaveError});
  };
  // Merge an imported row into the manual entry it duplicates (auto-matching
  // misses when the payee text differs). The manual entry wins; the bank row's
  // identity is remembered server-side so re-importing won't add it back.
  const openMatchDialog = () => {
    const pair = [...selected].map((id) => allTxns.find((t) => t.id === id));
    if (pair.length !== 2 || pair.some((t) => !t)) return;
    if (pair.some((t) => t.id < 0)) return toast("Wait for offline changes to sync before matching.", true);
    const imported = pair.filter((t) => t.bank_imported);
    if (imported.length === 0) return toast("Neither of these was imported, so there's nothing to match. Select one imported transaction and the one you entered by hand.", true);
    if (imported.length === 2) return toast("Both of these were imported. Select one imported transaction and the one you entered by hand.", true);
    const imp = imported[0], keep = pair.find((t) => t !== imp);
    if (imp.amount !== keep.amount) return toast("The amounts differ, so these aren't the same transaction. Edit one so they match first.", true);

    const card = (t, tag, cls) => el("div", {class: "match-card " + cls},
      el("div", {class: "match-tag"}, tag),
      el("div", {class: "match-top"}, el("span", {class: "match-payee"}, t.payee || "(no payee)"),
        el("span", {class: "match-amt " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount))),
      el("div", {class: "match-sub"}, new Date(t.date + "T00:00:00").toLocaleDateString(undefined,
        {month: "short", day: "numeric", year: "numeric"}), " · ",
        t.transfer_account_name ? `Transfer : ${t.transfer_account_name}` : (t.category_name || "Uncategorized")),
      t.memo ? el("div", {class: "match-sub"}, t.memo) : null);
    const doMatch = async () => {
      try {
        await api("/transactions/match", {method: "POST", body: {ids: [keep.id, imp.id]}});
        closeModal(); selected.clear(); await reload(); toast("Matched — kept your entry");
      } catch (e) { toast(e.message, true); }
    };
    modal({title: "Match these two transactions?",
      bodyNode: el("div", {},
        card(keep, "Keep — your entry", "keep"),
        card(imp, "Merge in — imported (removed)", "merge"),
        el("div", {class: "help", style: "margin-top:10px"},
          "Your entry wins. A blank payee or memo is filled in from the imported row. The imported row is deleted, but its bank details are remembered, so importing again won't add it back.")),
      footNode: [el("div", {style: "flex:1"}),
        el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
        el("button", {class: "btn", onclick: doMatch}, "Match")]});
  };

  // Actual-style dropdown next to the search box for editing all selected rows.
  const openBulkMenu = (anchor) => {
    const n = selected.size;
    floatMenu(anchor, [
      ...(n === 2 ? [{label: "Match imported with manual…", onClick: openMatchDialog}, "sep"] : []),
      {label: "Make Payment…", onClick: openMakePayment},
      "sep",
      {label: "Set date…", onClick: () => openFieldEdit("Set date for " + n, "date", (v) => v && bulkApply({date: v}))},
      {label: "Set payee…", onClick: () => openFieldEdit("Set payee for " + n, "text", (v) => bulkApply({payee: v}))},
      {label: "Set category…", onClick: async () => { if (!cats) cats = await api("/categories"); openCategoryPicker(cats, null, (id) => bulkApply({category_id: id || null})); }},
      {label: "Set memo…", onClick: () => openFieldEdit("Set memo for " + n, "text", (v) => bulkApply({memo: v}))},
      {label: "Set amount…", onClick: () => openFieldEdit("Set amount for " + n, "money", (v) => bulkApply({amount: toCents(v)}))},
      {label: "Move to account…", onClick: openMoveToAccount},
      "sep",
      {label: "Mark cleared", onClick: () => bulkApply({cleared: 1})},
      {label: "Mark uncleared", onClick: () => bulkApply({cleared: 0})},
      {label: "Mark reconciled", onClick: () => bulkApply({cleared: 2})},
      "sep",
      {label: "Delete", danger: true, onClick: bulkDelete},
      {label: "Clear selection", onClick: () => { selected.clear(); renderList(); }},
    ]);
  };

  const renderList = () => {
    editing = 0;
    redrawPending = false;   // everything is rebuilt below, so no editor survives this
    const n = activeCount();
    filterBtn.textContent = "Filters" + (n ? ` (${n})` : "");
    updateReviewBar();
    filterBtn.classList.toggle("active", n > 0);
    const sort = getSort();
    sortBtn.classList.toggle("active", !isDefaultSort(sort));
    colWidths = getColWidths();   // pick up any saved/reset widths
    applyGrid();

    // Sorting by Cleared status alone (e.g. to keep uncleared transactions
    // up top) would otherwise leave same-status rows in arbitrary insertion
    // order and silently lose the day banners entirely, since those only
    // make sense once consecutive rows are actually date-ordered. Falling
    // back to date within each cleared bucket fixes both at once, without
    // changing what the Sort dialog itself shows as chosen.
    const effSort = (sort.some((s) => s.key === "cleared") && !sort.some((s) => s.key === "date"))
      ? [...sort, {key: "date", dir: "desc"}] : sort;

    openSplit = null;
    filtered = allTxns.filter(matches);
    sortTxns(filtered, effSort);
    const ids = new Set(filtered.map((t) => t.id));
    [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });

    const anyFilter = (!(scope && scope.serverSearch) && filters.search.trim() !== "") || n > 0 || !!(scope && scope.flat);
    summary.innerHTML = "";
    const localFilter = (!(scope && scope.serverSearch) && filters.search.trim() !== "") || n > 0;
    summary.style.display = anyFilter || scope ? "flex" : "none";
    if (scope) {
      const total = filtered.reduce((s, t) => s + amountOf(t), 0);
      summary.append(...scope.summary(filtered, allTxns, total, localFilter),
        ...(localFilter ? [el("button", {class: "btn ghost sm", onclick: clearAll}, "Clear filters")] : []));
    } else if (anyFilter) {
      const total = filtered.reduce((s, t) => s + t.amount, 0);
      summary.append(
        el("span", {}, `Showing ${filtered.length} of ${allTxns.length}`),
        el("span", {class: "reg-sum-total " + (total < 0 ? "out" : "in")}, "Total " + fmt(total, {plus: true})),
        el("button", {class: "btn ghost sm", onclick: clearAll}, "Clear filters"));
    }

    buildHeader();
    updateBulk();

    list.innerHTML = "";
    if (!filtered.length) {
      list.append(el("div", {class: "empty"}, allTxns.length ? "No matching transactions." : scope ? scope.empty : "No transactions yet."));
      requestAnimationFrame(updateBarOffsets);
      return;
    }
    // Day dividers whenever "date" is part of the active sort (at any level,
    // not just first) and we're not filtering (keeps a filtered list
    // uncluttered). appendDayGroups just bands up consecutive equal-date
    // rows, so this works unchanged even when date is a secondary key — e.g.
    // sorting by Cleared status first still sorts by date within each
    // cleared/uncleared bucket, so each bucket gets its own correct day
    // banners instead of losing them entirely just because date isn't first.
    if (effSort.some((s) => s.key === "date") && !anyFilter) appendDayGroups(list, filtered, rowFor);
    else for (const t of filtered) list.append(rowFor(t));
    // Zebra striping across all transaction rows for easier scanning.
    [...list.querySelectorAll(".reg-row")].forEach((r, i) => r.classList.toggle("alt", i % 2 === 1));
    requestAnimationFrame(updateBarOffsets);   // keep sticky offsets accurate

    if (focusPayeeId != null) {   // just added a new transaction — edit its payee
      const id = focusPayeeId; focusPayeeId = null;
      const t = filtered.find((x) => x.id === id);
      const cell = t && [...list.querySelectorAll(`.reg-row[data-id="${id}"] .c-payee, .reg-row[data-id="${id}"] .reg-stack .reg-payee`)].find((e) => e.offsetParent !== null);
      if (cell) startPayeeEdit(cell, t);
    }
    if (focusEdit) {   // Tab moved to the next field
      const {id, field} = focusEdit; focusEdit = null;
      const t = filtered.find((x) => x.id === id);
      if (t) startEditByField(t, field);
    }
    if (pendingFocusTxnId != null) {   // arrived here from elsewhere (e.g. budget) to view one transaction
      const id = pendingFocusTxnId; pendingFocusTxnId = null;
      const rowEl = list.querySelector(`.reg-row[data-id="${id}"]`);
      if (rowEl) {
        rowEl.scrollIntoView({block: "center", behavior: "smooth"});
        rowEl.classList.add("flash-highlight");
        setTimeout(() => rowEl.classList.remove("flash-highlight"), 1500);
      }
    }
    fitLifts();
    const plainRow = list.querySelector(".reg-row:not(.lifted)");
    if (plainRow && plainRow.offsetHeight) rowH = plainRow.offsetHeight;
    // Nothing is being edited now (no editor open, none queued by Tab): put the row back in the register.
    if (liftId != null && !editing && focusEdit == null && focusPayeeId == null) { liftId = null; liftDrawn = null; renderList(); }
    else if (liftId == null) liftDrawn = null;
  };

  const openFilters = async () => { if (!cats) cats = await api("/categories"); openFilterModal(filters, cats, renderList); };
  const openSort = () => openSortModal(getSort(), (s) => { setSort(s); renderList(); });
  const openColumns = () => openColumnsModal(getColumns(), getHiddenCols(),
    (order, hidden) => { setColumns(order); setHiddenCols(hidden); renderList(); });
  // Step 1: ask for the bank statement's ending balance, then enter reconcile
  // mode (classic desktop style) — the register itself becomes the workspace.
  const openReconcile = () => {
    const startingCleared = clearedTotal();
    const bank = amountField({
      initialCents: startingCleared, defaultSign: startingCleared < 0 ? -1 : 1});
    const body = el("div", {},
      el("div", {class: "help", style: "margin-bottom:10px"},
        "Enter the ending balance shown on your bank statement. You'll then be able to check off transactions as cleared until the two match."),
      el("label", {class: "field"}, el("span", {}, "Bank's ending balance"), bank.el));
    const begin = () => {
      reconcile = {target: bank.getCents()};
      closeModal();
      reconcileBtn.style.display = "none";
      reconcileBar.style.display = "flex";
      refreshBalances(); renderList();
    };
    modal({title: "Reconcile " + acct.name, onSubmit: begin, bodyNode: body, footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: begin}, "Begin Reconcile")]});
  };

  const exitReconcile = () => {
    reconcile = null;
    reconcileBtn.style.display = "";
    reconcileBar.style.display = "none";
    renderList();
  };
  const cancelReconcile = () => {
    if (confirm("Stop reconciling? Cleared/uncleared changes you made are kept, but nothing will be locked."))
      exitReconcile();
  };
  // Step 2 (Finish): if the cleared total now matches the statement balance,
  // lock every cleared transaction with a reconciled flag (green lock). If
  // not, offer to force a match with an adjustment transaction, or keep going.
  let finishing = false;       // a finish is already running: ignore a second click
  const finishReconcile = async () => {
    const cleared = clearedTotal();
    const diff = reconcile.target - cleared;
    const toLock = allTxns.filter((t) => t.cleared === 1);
    // One request locks them all (not one request per transaction), with a visible "Reconciling…" while it runs.
    const lockAll = async (adjustment) => {
      if (finishing) return;
      finishing = true;
      const job = Busy.begin(`Reconciling ${toLock.length} transaction${toLock.length === 1 ? "" : "s"}`);
      try {
        await api("/transactions/reconcile", {method: "POST", body: {account_id: acct.id, adjustment}});
        toast(adjustment ? `Reconciled with a ${fmt(diff)} adjustment` : `Reconciled — ${toLock.length} transaction(s) locked`);
      } catch (e) { toastSaveError(e); }
      try { exitReconcile(); await reload(); }        // still "Reconciling…" until the register has been redrawn
      finally { job.end(); finishing = false; }
    };
    if (diff === 0) return lockAll(null);
    const body = el("div", {},
      el("div", {}, `Your cleared balance (${fmt(cleared)}) doesn't match the statement balance you entered (${fmt(reconcile.target)}) — off by ${fmt(Math.abs(diff))}.`),
      el("div", {class: "help", style: "margin-top:8px"},
        "Keep checking transactions to find the difference, or add an adjustment transaction for the gap so this account matches your bank right now."));
    modal({title: "Doesn't match yet", bodyNode: body, footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Keep Reconciling"),
      el("button", {class: "btn", onclick: () => {
        closeModal();
        lockAll({date: todayStr(), payee: "Reconciliation Balance Adjustment", amount: diff});
      }}, "Add Adjustment & Finish")]});
  };

  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer); filters.search = search.value;
    if (scope && scope.serverSearch) {   // a search page asks the server again (every account) after a pause
      State.searchQuery = search.value;
      timer = setTimeout(async () => { try { await reload(); } catch (e) { toast(e.message, true); } }, 250);
    } else timer = setTimeout(renderList, 150);
  });
  if (acctSel) acctSel.addEventListener("change", async () => {
    State.searchAccount = acctSel.value;
    try { await reload(); } catch (e) { toast(e.message, true); }
  });

  list.append(el("div", {class: "empty"}, "Loading…"));
  try {
    [allTxns, cats] = await Promise.all([
      scope ? scope.load() : api(`/transactions?account_id=${acct.id}`),
      api("/categories"),
    ]);
  } catch (e) { list.replaceChildren(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  refreshBalances();
  renderList();
  if (scope && scope.serverSearch && !search.value) search.focus();   // an empty search page: ready to type
}

// ---- register sorting ----
const SORT_LABELS = {date: "Date", cleared: "Cleared status", amount: "Amount", payee: "Payee"};
const SORT_VALUE = {
  date: (t) => t.date,
  cleared: (t) => t.cleared || 0,
  amount: (t) => t.amount,
  payee: (t) => (t.payee || "").toLowerCase(),
};
const DEFAULT_SORT = [{key: "date", dir: "desc"}];
function getSort() {
  try { const v = JSON.parse(localStorage.getItem("pref_regSort")); return Array.isArray(v) && v.length ? v : DEFAULT_SORT; }
  catch { return DEFAULT_SORT; }
}
function setSort(arr) { try { localStorage.setItem("pref_regSort", JSON.stringify(arr)); } catch {} }
function isDefaultSort(s) { return s.length === 1 && s[0].key === "date" && s[0].dir === "desc"; }
function sortTxns(arr, sort) {
  arr.sort((a, b) => {
    for (const {key, dir} of sort) {
      const va = SORT_VALUE[key](a), vb = SORT_VALUE[key](b);
      if (va < vb) return dir === "asc" ? -1 : 1;
      if (va > vb) return dir === "asc" ? 1 : -1;
    }
    return b.id - a.id;   // stable-ish tiebreak: newest first
  });
}

function openSortModal(current, onApply) {
  const levels = [0, 1, 2].map((i) => current[i] || {key: i === 0 ? "date" : "", dir: "desc"});
  const rows = levels.map((lvl, i) => {
    const keySel = el("select", {},
      el("option", {value: ""}, i === 0 ? "Date" : "— none —"),
      ...Object.entries(SORT_LABELS).map(([k, label]) => {
        const o = el("option", {value: k}, label); if (lvl.key === k) o.selected = true; return o;
      }));
    if (i === 0 && !lvl.key) keySel.value = "date";
    const dirSel = el("select", {},
      el("option", {value: "desc"}, "Descending"),
      el("option", {value: "asc"}, "Ascending"));
    dirSel.value = lvl.dir || "desc";
    return {keySel, dirSel,
      node: el("div", {class: "sort-row"},
        el("span", {class: "sort-lbl"}, i === 0 ? "Sort by" : "then by"),
        keySel, dirSel)};
  });
  const apply = () => {
    const s = rows.map((r) => ({key: r.keySel.value, dir: r.dirSel.value})).filter((r) => r.key);
    onApply(s.length ? s : DEFAULT_SORT); closeModal();
  };
  modal({title: "Sort transactions", bodyNode: el("div", {}, ...rows.map((r) => r.node)),
    footNode: [
      el("button", {class: "btn danger", onclick: () => { onApply(DEFAULT_SORT); closeModal(); }}, "Reset"),
      el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: apply}, "Apply")]});
}

// Build the register list with day-divider headers. Each day is wrapped in its
// own group so its banner is a sticky element confined to that day — it stays
// pinned (top or bottom) only while that day is on screen, then hands off to the
// next day instead of every banner piling up at the same edge.
function appendDayGroups(list, txns, rowFn) {
  const below = getPref("dayHeaderPos", "below") === "below";
  const dayHeader = (d) => el("div", {class: "reg-day" + (below ? " below" : "")}, dateHeaderLabel(d));
  let i = 0;
  while (i < txns.length) {
    const day = txns[i].date;
    const group = el("div", {class: "reg-day-group"});
    if (!below) group.append(dayHeader(day));
    while (i < txns.length && txns[i].date === day) { group.append(rowFn(txns[i])); i++; }
    if (below) group.append(dayHeader(day));
    list.append(group);
  }
}

// ---- register columns ----
const REG_COL_META = {
  date:     {label: "Date",     name: "Date",           w: "128px"},
  payee:    {label: "Payee",    name: "Payee",          w: "minmax(110px,1.6fr)"},
  category: {label: "Category", name: "Category",       w: "minmax(90px,1.2fr)"},
  memo:     {label: "Memo",     name: "Memo",           w: "minmax(70px,1.1fr)"},
  amount:   {label: "Amount",   name: "Amount",         w: "112px"},
  outflow:  {label: "Outflow",  name: "Outflow",        w: "104px"},
  inflow:   {label: "Inflow",   name: "Inflow",         w: "104px"},
  account:  {label: "Account",  name: "Account (search and category pages)", w: "minmax(80px,0.9fr)"},
  cleared:  {label: "Status",   name: "Cleared status", w: "112px"},
};
const REG_ALL_COLS = ["date", "account", "payee", "category", "memo", "amount", "cleared"];
function getColumns() {
  try {
    const v = JSON.parse(localStorage.getItem("pref_regCols"));
    if (Array.isArray(v)) {
      const s = v.filter((c) => REG_ALL_COLS.includes(c));
      for (const c of REG_ALL_COLS) if (!s.includes(c)) s.push(c);   // include any new cols
      return s;
    }
  } catch {}
  return [...REG_ALL_COLS];
}
function setColumns(a) { try { localStorage.setItem("pref_regCols", JSON.stringify(a)); } catch {} }
function getHiddenCols() {
  try { return new Set(JSON.parse(localStorage.getItem("pref_regHidden") || "[]")); } catch { return new Set(); }
}
function setHiddenCols(set) { try { localStorage.setItem("pref_regHidden", JSON.stringify([...set])); } catch {} }
function getColWidths() { try { return JSON.parse(localStorage.getItem("pref_regColWidths")) || {}; } catch { return {}; } }
function setColWidths(o) { try { localStorage.setItem("pref_regColWidths", JSON.stringify(o)); } catch {} }

function openColumnsModal(order, hidden, onApply) {
  const work = order.slice();
  const hid = new Set(hidden);
  const listEl = el("div", {class: "col-list"});
  const amountMode = el("select", {}, el("option", {value: "single"}, "One column (outflows shown with a minus)"),
    el("option", {value: "split"}, "Two columns: Outflow and Inflow"));
  amountMode.value = getPref("amountColumns", "single");
  const render = () => {
    listEl.innerHTML = "";
    work.forEach((c, i) => {
      const chk = el("input", {type: "checkbox"});
      chk.checked = !hid.has(c);
      chk.addEventListener("change", () => { if (chk.checked) hid.delete(c); else hid.add(c); });
      const move = (d) => {
        const j = i + d;
        if (j < 0 || j >= work.length) return;
        [work[i], work[j]] = [work[j], work[i]];
        render();
      };
      listEl.append(el("div", {class: "col-row"},
        el("label", {class: "col-name"}, chk, " ", REG_COL_META[c].name),
        el("button", {class: "btn ghost sm", disabled: i === 0 ? "" : null, onclick: () => move(-1)}, "▲"),
        el("button", {class: "btn ghost sm", disabled: i === work.length - 1 ? "" : null, onclick: () => move(1)}, "▼")));
    });
  };
  render();
  const reset = () => {
    ["pref_regCols", "pref_regHidden", "pref_regColWidths", "pref_amountColumns"].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    onApply([...REG_ALL_COLS], new Set()); closeModal();
  };
  modal({title: "Columns", bodyNode: el("div", {},
    el("div", {class: "help", style: "margin-bottom:10px"}, "Show/hide and reorder here, or drag the header cells to reorder and drag their right edge to resize. On a phone the left columns stack together; Amount and the cleared flag stay on the right."),
    el("label", {class: "field", style: "margin-bottom:12px"}, el("span", {}, "Amounts (this device)"), amountMode),
    listEl),
    footNode: [
      el("button", {class: "btn danger", onclick: reset}, "Reset"),
      el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: () => { setPref("amountColumns", amountMode.value); onApply(work, hid); closeModal(); }}, "Apply")]});
}

// A small floating dropdown anchored under an element. items: {label,onClick,danger} or "sep".
function floatMenu(anchor, items) {
  const r = anchor.getBoundingClientRect();
  const menu = el("div", {class: "float-menu", style: `top:${Math.round(r.bottom + 4)}px; left:${Math.round(r.left)}px`});
  const close = () => { menu.remove(); document.removeEventListener("mousedown", away, true); };
  const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
  for (const it of items) {
    if (it === "sep") { menu.append(el("div", {class: "fm-sep"})); continue; }
    if (it.heading) { menu.append(el("div", {class: "fm-head"}, it.heading)); continue; }
    menu.append(el("button", {class: "fm-item" + (it.danger ? " danger" : ""),
      onclick: () => { close(); it.onClick(); }}, it.label));
  }
  document.body.append(menu);
  // keep on-screen horizontally
  const mr = menu.getBoundingClientRect();
  if (mr.right > window.innerWidth - 8) menu.style.left = Math.round(window.innerWidth - mr.width - 8) + "px";
  setTimeout(() => document.addEventListener("mousedown", away, true), 0);
}

// Inline category field: shows the name; clicking opens a searchable, scrolling
// dropdown attached beneath it (no full-screen popup). Returns { el, getId }.
// transferAccounts: optional [{id, name}] of other accounts this transaction
// could be marked as a transfer to/from — omitted (e.g. for a split line,
// which can't itself be a transfer) means no Transfer section at all.
// onChange(categoryId, transferAccountId): exactly one of the two is set.
function inlineCategoryField(cats, initialId, onChange, onCancel, onSplit, onEnterAdvance, transferAccounts, initialLabel = null) {
  let id = initialId, picked = false;
  const wrap = el("div", {class: "inline-drop"});
  const field = el("div", {class: "picker-field" + (id || initialLabel ? "" : " placeholder"), tabindex: "0"},
    initialLabel || catNameById(cats, id) || "Category");
  const menu = el("div", {class: "inline-menu", style: "display:none"});
  const search = el("input", {type: "text", placeholder: "Search…", class: "inline-search"});
  const listWrap = el("div", {class: "inline-list"});
  const close = () => {
    menu.style.display = "none";
    document.removeEventListener("mousedown", away, true);
    if (!picked && onCancel) onCancel();
  };
  const away = (e) => { if (!wrap.contains(e.target)) close(); };
  const pick = (label, cid, transferId) => {
    picked = true; id = cid; field.textContent = label;
    field.classList.toggle("placeholder", !cid && !transferId);
    if (onChange) onChange(cid, transferId); close();
  };
  const build = () => {
    listWrap.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    if (onSplit && (!q || "split".includes(q))) {
      const r = el("div", {class: "inline-row split-opt"}, "＋ Split transaction");
      r.addEventListener("mousedown", (e) => { e.preventDefault(); picked = true; close(); onSplit(); });
      listWrap.append(r);
    }
    const addRow = (label, cid, transferId) => {
      const r = el("div", {class: "inline-row" + (String(cid) === String(id) ? " selected" : "")}, label);
      r.addEventListener("mousedown", (e) => { e.preventDefault(); pick(label, cid, transferId); });
      listWrap.append(r);
    };
    if (!q || "uncategorized".includes(q)) addRow("Uncategorized", null);
    if (transferAccounts && transferAccounts.length) {
      const ms = transferAccounts.filter((a) =>
        !q || "transfer".includes(q) || a.name.toLowerCase().includes(q));
      if (ms.length) {
        listWrap.append(el("div", {class: "inline-group"}, "Transfer"));
        for (const a of ms) addRow("Transfer : " + a.name, null, a.id);
      }
    }
    for (const g of cats) {
      const ms = g.categories.filter((c) => !c.hidden && (!q || c.name.toLowerCase().includes(q)));
      if (!ms.length) continue;
      listWrap.append(el("div", {class: "inline-group"}, g.name));
      for (const c of ms) addRow(c.name, c.id);
    }
    if (!listWrap.children.length) listWrap.append(el("div", {class: "inline-row muted"}, "No matches"));
  };
  const open = () => { picked = false; search.value = ""; build(); menu.style.display = "block"; setTimeout(() => search.focus(), 0); document.addEventListener("mousedown", away, true); };
  field.addEventListener("click", () => menu.style.display === "block" ? close() : open());
  let hi = -1;
  const navRows = () => [...listWrap.querySelectorAll(".inline-row")];
  const shownLabel = field.textContent;   // what the field said before any arrowing
  const wasPlaceholder = field.classList.contains("placeholder");
  const setHi = (n) => {
    const rs = navRows(); if (!rs.length) { hi = -1; return; }
    hi = (n + rs.length) % rs.length;
    rs.forEach((r, i) => r.classList.toggle("hi", i === hi));
    rs[hi].scrollIntoView({block: "nearest"});
    // Show the highlighted choice in the field itself (the search text isn't touched, so the list keeps its filter).
    const previewing = !rs[hi].classList.contains("split-opt");
    field.textContent = previewing ? rs[hi].textContent : shownLabel;
    field.classList.toggle("placeholder", previewing ? false : wasPlaceholder);   // a real choice isn't greyed-out placeholder text
  };
  // Choose whatever is highlighted (Tab uses this). False if nothing real is highlighted.
  const pickHighlighted = () => {
    const r = navRows()[hi];
    if (!r || r.classList.contains("split-opt") || r.classList.contains("muted")) return false;
    r.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
    return true;
  };
  const rebuild = () => { build(); hi = -1; field.textContent = shownLabel; field.classList.toggle("placeholder", wasPlaceholder); };
  search.addEventListener("input", rebuild);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(hi + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(hi - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const rs = navRows();
      if (rs[hi]) {
        const wasSplit = rs[hi].classList.contains("split-opt");
        rs[hi].dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));   // pick it
        if (!wasSplit && onEnterAdvance) onEnterAdvance();   // then move to next field
      }
    }
  });
  menu.append(search, listWrap);
  wrap.append(field, menu);
  return {el: wrap, getId: () => id, open, pickHighlighted};
}

// Inline payee field: a text input with a filtered dropdown of previous payees and, when `accounts`
// is given, a Transfer section listing the accounts a transfer can go to.
//  - With nothing typed the Transfer section comes first. Once you type, normal payees come first
//    (matches that start with your text first) and the Transfer section moves to the bottom,
//    holding only accounts that have a word starting with what you typed.
//  - ArrowDown/ArrowUp walk through the list AND put the highlighted entry in the field, but the
//    list stays filtered by what YOU typed — only typing again re-filters it.
//  - Tab / Enter keep whatever is in the field and move on / commit.
// getAccountId() is the chosen account's id when a Transfer entry is selected, else null.
function inlinePayeeField(payees, initialValue, {accounts = [], initialAccountId = null} = {}) {
  const wrap = el("div", {class: "inline-drop"});
  const inp = el("input", {type: "text", value: initialValue || "", placeholder: "Payee"});
  const menu = el("div", {class: "inline-menu", style: "display:none"});
  const listWrap = el("div", {class: "inline-list"});
  menu.append(listWrap);
  const acctLabel = (a) => `Transfer : ${a.name}`;
  let hi = -1;
  let typed = inp.value;               // what the person typed: the list is filtered by this, not by an arrowed-to entry
  let baseAcct = initialAccountId;     // the account the typed text stands for (null once it's been edited)
  let acctId = initialAccountId;       // the account currently in the field (changes as you arrow)
  const rows = () => [...listWrap.querySelectorAll(".inline-row")];
  const setHi = (n) => {
    const rs = rows(); if (!rs.length) { hi = -1; return; }
    hi = Math.max(-1, Math.min(n, rs.length - 1));
    rs.forEach((r, i) => r.classList.toggle("hi", i === hi));
    inp.value = hi >= 0 ? rs[hi].textContent : typed;   // preview in the field (no "input" event, so no re-filtering)
    acctId = hi >= 0 ? (rs[hi].dataset.account ? Number(rs[hi].dataset.account) : null) : baseAcct;
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* not supported */ }
    if (hi >= 0) rs[hi].scrollIntoView({block: "nearest"});
  };
  const choose = (text, accountId) => { inp.value = text; typed = text; baseAcct = acctId = accountId; menu.style.display = "none"; };
  const build = () => {
    // An existing transfer opens showing "Transfer : Savings"; that isn't a search, so list everything.
    const current = baseAcct != null && accounts.find((a) => a.id === baseAcct);
    const q = (current && typed === acctLabel(current)) ? "" : typed.trim().toLowerCase();
    const ps = payees.filter((p) => p && (!q || p.toLowerCase().includes(q)));
    if (q) ps.sort((a, b) => b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q));   // stable: A–Z within each group
    ps.length = Math.min(ps.length, 40);
    // An account matches when a word in its name starts with what was typed ("bank" finds "US Bank"),
    // or when you're spelling out the word "transfer".
    const as = accounts.filter((a) => !q || (q.length >= 3 && "transfer".startsWith(q)) || (" " + a.name.toLowerCase()).includes(" " + q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: "base"}));
    listWrap.innerHTML = ""; hi = -1;
    if (!ps.length && !as.length) { menu.style.display = "none"; return; }
    const payeeRows = ps.map((p) => {
      const r = el("div", {class: "inline-row"}, p);
      r.addEventListener("mousedown", (e) => { e.preventDefault(); choose(p, null); });
      return r;
    });
    const acctRows = as.map((a) => {
      const r = el("div", {class: "inline-row acct-row", "data-account": a.id}, acctLabel(a));
      r.addEventListener("mousedown", (e) => { e.preventDefault(); choose(acctLabel(a), a.id); });
      return r;
    });
    const both = payeeRows.length && acctRows.length;
    const payeeSection = [both ? el("div", {class: "inline-group"}, "Payees") : null, ...payeeRows];
    const acctSection = acctRows.length ? [el("div", {class: "inline-group"}, "Transfer to / from account"), ...acctRows] : [];
    // Nothing typed: the accounts lead. Typing: payees lead, matching accounts sit below them.
    listWrap.append(...(q ? [...payeeSection, ...acctSection] : [...acctSection, ...payeeSection]).filter(Boolean));
    menu.style.display = "block";
  };
  inp.addEventListener("focus", () => { typed = inp.value; build(); });
  inp.addEventListener("input", () => { typed = inp.value; baseAcct = acctId = null; build(); });
  inp.addEventListener("blur", () => setTimeout(() => { menu.style.display = "none"; }, 150));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (menu.style.display === "none") build(); setHi(hi + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(hi - 1); }
    // Enter and Tab need nothing special: the highlighted entry is already in the field.
  });
  wrap.append(inp, menu);
  // Show the list now (browsers don't reliably fire "focus" when the field is focused from code).
  const open = () => { typed = inp.value; build(); };
  const getAccountId = () => {
    if (acctId != null) return acctId;
    const exact = accounts.find((a) => acctLabel(a).toLowerCase() === inp.value.trim().toLowerCase());   // typed out in full
    return exact ? exact.id : null;
  };
  return {el: wrap, getValue: () => inp.value, getAccountId, open};
}

// One-field editor dialog (text or date), used by the bulk-edit menu.
function openFieldEdit(title, inputType, onApply) {
  const money = inputType === "money";
  const inp = el("input", {type: money ? "text" : inputType, inputmode: money ? "decimal" : undefined});
  if (money) wireSmartMoneyInput(inp);
  const save = () => { const v = inp.value; closeModal(); onApply(v); };
  modal({title, onSubmit: save, bodyNode: el("label", {class: "field"}, inp), footNode: [
    el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
    el("button", {class: "btn", onclick: save}, "Apply")]});
}

const LOCK_SVG_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 1a5 5 0 00-5 5v2H6a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V10a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm3 7H9V6a3 3 0 016 0v2z"/></svg>';
// A scheduled-and-not-yet-reconciled transaction shows a status badge (Due
// Soon/Past Due/Paid) instead of the plain cleared circle. Once reconciled
// (cleared===2) it's indistinguishable from any other reconciled transaction.
const schedFlagStatus = (t) => (!t.scheduled_id || t.cleared === 2) ? null
  : t.cleared === 1 ? "paid" : t.date < todayStr() ? "past_due" : "due_soon";

function makeClearedFlag(t, onChange, reconcileMode, reload) {
  const toastErr = (err) =>
    toast(err.message, true, err.conflict ? {label: "Reload", onClick: reload, sticky: true} : null);
  const sched = schedFlagStatus(t);
  if (sched) {
    const badge = schedStatusBadge(sched);
    if (!reconcileMode) {
      // Frozen outside reconcile mode — the whole point is you can't
      // accidentally mark a bill paid with a stray click.
      badge.title = SCHED_STATUS_LABEL[sched] + " — change only while reconciling";
      return badge;
    }
    badge.title = SCHED_STATUS_LABEL[sched] + " (tap to toggle paid/unpaid)";
    badge.style.cursor = "pointer";
    badge.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = t.cleared === 1 ? 0 : 1;
      try {
        const r = await api(`/transactions/${t.id}`, {method: "PUT", body: {cleared: next, version: t.version}});
        t.cleared = next; t.version = r.version;
        if (onChange) onChange();
      } catch (err) { toastErr(err); }
    });
    return badge;
  }

  const state = t.cleared || 0;   // 0 uncleared, 1 cleared, 2 reconciled
  const locked = reconcileMode && state === 2;   // reconciled in an earlier pass — frozen this round
  const flag = el("span", {
    class: "cs-pill " + (state === 2 ? "reconciled" : state === 1 ? "cleared" : "uncleared") + (locked ? " locked" : ""),
    title: locked ? "Reconciled — locked while reconciling"
      : state === 2 ? "Reconciled (tap to unlock)" : state === 1 ? "Cleared (tap to mark uncleared)" : "Uncleared (tap to mark cleared)",
  }, state === 2 ? el("span", {html: LOCK_SVG_ICON}) : null, state === 2 ? "Reconciled" : "Cleared");
  flag.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (locked) return;
    // While reconciling, a click only ever toggles cleared/uncleared — it
    // never cycles into "reconciled" (that only happens via Finish Reconciling).
    const next = reconcileMode ? (state === 1 ? 0 : 1) : (state + 1) % 3;
    try {
      const r = await api(`/transactions/${t.id}`, {method: "PUT", body: {cleared: next, version: t.version}});
      t.cleared = next; t.version = r.version;
      if (onChange) onChange();
    } catch (err) { toastErr(err); }
  });
  return flag;
}

function openFilterModal(filters, cats, onApply) {
  const catSel = el("select", {});
  catSel.append(el("option", {value: ""}, "All categories"),
    el("option", {value: "none"}, "Uncategorized / transfers"));
  for (const g of cats) {
    const og = el("optgroup", {label: g.name});
    for (const c of g.categories) {
      const o = el("option", {value: c.id}, c.name);
      if (String(filters.category) === String(c.id)) o.selected = true;
      og.append(o);
    }
    catSel.append(og);
  }
  if (filters.category === "none" || filters.category === "") catSel.value = filters.category;

  const statusSel = el("select", {},
    el("option", {value: ""}, "Any status"),
    el("option", {value: "cleared"}, "Cleared"),
    el("option", {value: "uncleared"}, "Uncleared"),
    el("option", {value: "reconciled"}, "Reconciled"));
  statusSel.value = filters.status;

  const typeSel = el("select", {},
    el("option", {value: ""}, "All"),
    el("option", {value: "inflow"}, "Inflow (+)"),
    el("option", {value: "outflow"}, "Outflow (−)"));
  typeSel.value = filters.type;

  const fromInp = el("input", {type: "date", value: filters.from});
  const toInp = el("input", {type: "date", value: filters.to});

  const apply = () => {
    filters.category = catSel.value;
    filters.status = statusSel.value;
    filters.type = typeSel.value;
    filters.from = fromInp.value;
    filters.to = toInp.value;
    closeModal(); onApply();
  };
  // One-tap date ranges — set the from/to fields and apply immediately.
  const yr = todayStr().slice(0, 4);
  const preset = (label, from, to) => el("button", {class: "chip", onclick: () => {
    fromInp.value = from; toInp.value = to; apply();
  }}, label);
  const thisM = monthRange(curMonth());
  const lastM = monthRange(monthAdd(curMonth(), -1));
  const presets = el("div", {class: "filter-presets"},
    preset("All dates", "", ""),
    preset("This month", thisM[0], thisM[1]),
    preset("Last month", lastM[0], lastM[1]),
    preset("Last 3 months", monthAdd(curMonth(), -2) + "-01", todayStr()),
    preset("This year", `${yr}-01-01`, `${yr}-12-31`));

  const body = el("div", {},
    el("label", {class: "field"}, el("span", {}, "Category"), catSel),
    el("label", {class: "field"}, el("span", {}, "Status"), statusSel),
    el("label", {class: "field"}, el("span", {}, "Type"), typeSel),
    el("div", {class: "field"}, el("span", {}, "Date range"), presets),
    el("div", {style: "display:grid;grid-template-columns:1fr 1fr;gap:12px"},
      el("label", {class: "field"}, el("span", {}, "From"), fromInp),
      el("label", {class: "field"}, el("span", {}, "To"), toInp)));
  const clear = () => {
    ["category", "status", "type", "from", "to"].forEach((k) => filters[k] = "");
    closeModal(); onApply();
  };
  modal({title: "Filter transactions", onSubmit: apply, bodyNode: body, footNode: [
    el("button", {class: "btn danger", onclick: clear}, "Clear"),
    el("div", {style: "flex:1"}),
    el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
    el("button", {class: "btn", onclick: apply}, "Apply")]});
}


// `opts.onSaved`: what to do after a save or delete (default: go to the account's register). Lets a list, such
// as the search results, edit a transaction in place and then redraw itself.
async function openTxnModal(accountId, txn, payees = [], opts = {}) {
  const cats = await api("/categories");
  const isTransfer = txn && txn.transfer_account_id;
  const date = el("input", {type: "date", value: txn ? txn.date : todayStr()});
  // Same filter-as-you-type, arrow-key-navigable payee dropdown as the
  // desktop register's inline editor — just as useful on mobile, where
  // this dialog is the only way to enter a transaction.
  const payeeCtl = inlinePayeeField(payees, txn ? txn.payee : "");
  const memo = el("input", {type: "text", value: txn ? txn.memo : "", placeholder: "Memo"});
  // Signed amount; the +/- toggle button sits next to the input. New
  // transactions default to a decrease (outflow).
  const amtField = amountField({defaultSign: -1,
    initialCents: txn ? txn.amount : 0, onChange: () => { if (splitMode) updateSplitRemaining(); }});

  // Category: single picker OR split across multiple categories.
  let categoryId = (txn && !txn.transfer_account_id && txn.category_id) ? txn.category_id : null;
  let splitMode = false;
  let splits = [];   // [{categoryId, cents}]
  if (txn && txn.split_count) {
    try {
      const rows = await api(`/transactions/${txn.id}/splits`);
      splits = rows.map((r) => ({categoryId: r.category_id, cents: r.amount}));
      splitMode = splits.length > 0;
    } catch { /* ignore */ }
  }

  const catValue = el("div", {class: "picker-field", tabindex: "0"});
  const paintCat = () => {
    const name = catNameById(cats, categoryId);
    catValue.textContent = name || "Uncategorized";
    catValue.classList.toggle("placeholder", !categoryId);
  };
  const pickCat = () => openCategoryPicker(cats, categoryId, (id) => { categoryId = id; paintCat(); });
  catValue.addEventListener("click", pickCat);
  catValue.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickCat(); } });
  paintCat();

  // Account the entry lives in — changeable, for entries made in the wrong one.
  const acctSelect = el("select", {});
  for (const a of State.accounts.filter((x) => !x.closed || x.id === accountId))
    acctSelect.append(el("option", {value: a.id}, a.name));
  acctSelect.value = accountId;
  // The two sides of a transfer can't share an account.
  const syncAcctChoices = () => {
    const cur = Number(acctSelect.value);
    for (const o of acctSelect.options)
      o.disabled = !!(isTransfer && txn.transfer_account_id === Number(o.value));
    for (const o of transferSelect.options)
      o.disabled = o.value !== "" && Number(o.value) === cur;
    if (transferSelect.selectedOptions[0]?.disabled) transferSelect.value = "";
  };

  const transferSelect = el("select", {});
  transferSelect.append(el("option", {value: ""}, "— Not a transfer —"));
  for (const a of State.accounts) {
    const o = el("option", {value: a.id}, a.name);
    if (txn && txn.transfer_account_id === a.id) o.selected = true;
    transferSelect.append(o);
  }

  const amountRow = el("div", {class: "field"}, el("span", {}, "Amount"), amtField.el);
  const payeeField = el("label", {class: "field"}, el("span", {}, "Payee"), payeeCtl.el);
  const splitsBox = el("div", {class: "splits-box"});
  const splitToggle = el("button", {type: "button", class: "btn ghost sm"});
  const catField = el("div", {class: "field"},
    el("div", {class: "field-head"}, el("span", {}, "Category"), splitToggle),
    catValue, splitsBox);
  const syncTransfer = () => {
    const xfer = !!transferSelect.value || isTransfer;   // a transfer has no payee or category of its own
    catField.style.display = transferSelect.value ? "none" : "block";
    payeeField.style.display = xfer ? "none" : "";
  };
  transferSelect.addEventListener("change", syncTransfer);
  acctSelect.addEventListener("change", () => { syncAcctChoices(); syncTransfer(); });

  const splitTotal = () => splits.reduce((s, x) => s + x.cents, 0);
  // Rebuilding every split row on each keystroke (the old behavior) replaced
  // the focused amount input with a brand-new element on every digit typed —
  // on mobile that drops focus and dismisses the keyboard, making the field
  // feel like it "kicks you out" the moment you try to edit or clear it. The
  // row DOM is now only rebuilt when the set of rows actually changes (split
  // on/off, add, remove, category pick); typing in an amount just updates
  // the remaining/footer text in place via updateSplitRemaining().
  let addBtn, remEl;
  const updateSplitRemaining = () => {
    if (!addBtn || !remEl) return;
    const total = amtField.getCents();
    const remaining = total - splitTotal();
    addBtn.textContent = remaining !== 0 ? `+ Add split (${fmt(remaining)})` : "+ Add split";
    remEl.textContent = remaining === 0 ? "All " + fmt(total) + " assigned" : "Remaining " + fmt(remaining);
    remEl.className = "split-remaining " + (remaining === 0 ? "ok" : "off");
  };
  const renderSplits = () => {
    splitToggle.textContent = splitMode ? "Use single category" : "Split";
    catValue.style.display = splitMode ? "none" : "";
    splitsBox.style.display = splitMode ? "block" : "none";
    if (!splitMode) { syncTransfer(); return; }
    splitsBox.innerHTML = "";
    splits.forEach((s, i) => {
      const catBtn = el("div", {class: "picker-field" + (s.categoryId ? "" : " placeholder")},
        catNameById(cats, s.categoryId) || "Category");
      catBtn.addEventListener("click", () => openCategoryPicker(cats, s.categoryId, (id) => { s.categoryId = id; renderSplits(); }));
      const amt = amountField({initialCents: s.cents, defaultSign: -1,
        onChange: (c) => { s.cents = c; updateSplitRemaining(); }});
      const rm = el("button", {type: "button", class: "btn ghost sm", onclick: () => { splits.splice(i, 1); renderSplits(); }}, "✕");
      splitsBox.append(el("div", {class: "split-row"}, catBtn, amt.el, rm));
    });
    addBtn = el("button", {type: "button", class: "btn ghost sm",
      onclick: () => { splits.push({categoryId: null, cents: amtField.getCents() - splitTotal()}); renderSplits(); }},
      "+ Add split");
    remEl = el("div", {class: "split-remaining"});
    splitsBox.append(el("div", {class: "split-foot"}, addBtn, remEl));
    updateSplitRemaining();
  };
  splitToggle.addEventListener("click", () => {
    splitMode = !splitMode;
    // Start with one line holding the full transaction amount; peel off portions.
    if (splitMode && !splits.length) splits = [{categoryId, cents: amtField.getCents()}];
    renderSplits();
  });

  // Amount first: it's the one thing every entry needs, and modal() focuses
  // the first input — so typing starts there, then Tab/Enter walks Payee → Date.
  const body = el("div", {},
    amountRow,
    el("label", {class: "field"}, el("span", {}, "Account"), acctSelect),
    payeeField,
    el("label", {class: "field"}, el("span", {}, "Date"), date),
    catField,
    isTransfer ? null : el("label", {class: "field"}, el("span", {}, "Transfer to"), transferSelect),
    el("label", {class: "field"}, el("span", {}, "Memo"), memo));
  renderSplits();
  syncAcctChoices();

  const save = async () => {
    const newAccountId = Number(acctSelect.value);
    const payload = {account_id: newAccountId, date: date.value, payee: payeeCtl.getValue(),
      memo: memo.value, cleared: txn ? txn.cleared : 0, version: txn ? txn.version : undefined};
    if (!isTransfer && transferSelect.value) {
      payload.transfer_account_id = Number(transferSelect.value);
      payload.amount = amtField.getCents();
    } else if (!isTransfer && splitMode) {
      const total = amtField.getCents();
      const lines = splits.filter((s) => s.cents !== 0);
      const sum = lines.reduce((a, s) => a + s.cents, 0);
      if (sum !== total) return toast(`Splits must total ${fmt(total)} (off by ${fmt(total - sum)})`, true);
      payload.splits = lines.map((s) => ({category_id: s.categoryId, amount: s.cents}));
      payload.amount = total;
    } else {
      payload.amount = amtField.getCents();
      if (!isTransfer) { payload.category_id = categoryId || null; if (txn) payload.splits = []; }
    }
    try {
      if (txn) await api(`/transactions/${txn.id}`, {method: "PUT", body: payload});
      else await api("/transactions", {method: "POST", body: payload});
      closeModal(); await refreshAccounts();
      if (txn && newAccountId !== accountId) {
        const dest = State.accounts.find((a) => a.id === newAccountId);
        toast(`Moved to ${dest ? dest.name : "the other account"}`);
      }
      if (opts.onSaved) await opts.onSaved(); else navGo("account");
    } catch (e) {
      if (e.conflict && txn) {
        // Someone else saved a change to this transaction first — reopen the
        // dialog on their latest version instead of silently losing this edit.
        toast(e.message, true, {sticky: true, label: "Reload", onClick: async () => {
          const list = await api(`/transactions?account_id=${accountId}`);
          const fresh = list.find((x) => x.id === txn.id);
          closeModal();
          if (fresh) openTxnModal(accountId, fresh, [...new Set(list.map((x) => x.payee).filter(Boolean))].sort(), opts);
        }});
      } else toast(e.message, true);
    }
  };
  const foot = [];
  if (txn) foot.push(el("button", {class: "btn danger", onclick: async () => {
    if (confirm("Delete this transaction?")) {
      try {
        await api(`/transactions/${txn.id}`, {method: "DELETE"});
        closeModal(); await refreshAccounts();
        if (opts.onSaved) await opts.onSaved(); else navGo("account");
      } catch (e) { toast(e.message, true); }
    }
  }}, "Delete"));
  foot.push(el("div", {style: "flex:1"}));
  foot.push(el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"));
  foot.push(el("button", {class: "btn", onclick: save}, "Save"));
  modal({title: txn ? "Edit Transaction" : "New Transaction", onSubmit: save, bodyNode: body, footNode: foot});
}

function catNameById(groups, id) {
  if (!id) return null;
  for (const g of groups) for (const c of g.categories) if (c.id === id) return c.name;
  return null;
}

// A searchable, scrollable category picker. Uses its own overlay so it can
// stack ON TOP of the transaction dialog rather than replacing it.
function openCategoryPicker(groups, selectedId, onPick) {
  const overlay = el("div", {class: "np-overlay"});
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const choose = (id, name) => { onPick(id, name); close(); };

  const search = el("input", {type: "text", placeholder: "Search categories…", class: "cat-search"});
  const listWrap = el("div", {class: "cat-picker-list"});
  const row = (label, isSel, onClick) => {
    const r = el("div", {class: "cat-pick-row" + (isSel ? " selected" : "")},
      el("span", {}, label), isSel ? el("span", {class: "cat-check"}, "✓") : null);
    r.addEventListener("click", onClick);
    return r;
  };
  const build = () => {
    listWrap.innerHTML = "";
    const q = search.value.trim().toLowerCase();
    if (!q || "uncategorized".includes(q))
      listWrap.append(row("Uncategorized", selectedId == null, () => choose(null)));
    for (const g of groups) {
      const matches = g.categories.filter((c) =>
        !c.hidden && (!q || c.name.toLowerCase().includes(q)));
      if (!matches.length) continue;
      listWrap.append(el("div", {class: "cat-pick-group"}, g.name));
      for (const c of matches)
        listWrap.append(row(c.name, String(selectedId) === String(c.id), () => choose(c.id, c.name)));
    }
    if (!listWrap.children.length) listWrap.append(el("div", {class: "empty"}, "No matching categories."));
  };
  search.addEventListener("input", build);
  build();

  // Keep the sheet inside the part of the screen the keyboard leaves free
  // (iOS doesn't shrink the page for it): track the visual viewport.
  const vv = window.visualViewport;
  const fit = () => {
    if (!vv) return;
    overlay.style.top = vv.offsetTop + "px";
    overlay.style.height = vv.height + "px";
    overlay.style.bottom = "auto";
  };
  if (vv) { vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
  overlay.append(el("div", {class: "np-sheet cat-sheet"},
    el("div", {class: "np-title"}, "Select Category"),
    search, listWrap,
    el("div", {class: "np-foot"},
      el("button", {class: "btn ghost", onclick: () => { close(); setPref("settingsTab", "categories"); navGo("settings"); }}, "Manage categories"),
      el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: close}, "Cancel"))));
  document.body.append(overlay);
  fit();
  // Start in the search box so the keyboard is up and typing filters straight away.
  search.focus();
  // Stop tracking the viewport once the picker is gone.
  new MutationObserver((_, obs) => {
    if (!overlay.isConnected) { obs.disconnect(); if (vv) { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); } }
  }).observe(document.body, {childList: true});
}

// --------------------------------------------------------------------------
//  Account modal
// --------------------------------------------------------------------------
function openAccountModal(acct) {
  acct = acct && acct.id ? acct : null;
  const name = el("input", {type: "text", value: acct ? acct.name : "", placeholder: "Account name"});
  const type = el("select", {},
    ...[["checking", "Checking"], ["savings", "Savings"], ["cash", "Cash"],
        ["credit", "Credit Card"], ["asset", "Asset (tracking)"], ["liability", "Liability (tracking)"]]
      .map(([v, l]) => { const o = el("option", {value: v}, l); if (acct && acct.type === v) o.selected = true; return o; }));
  const opening = amountField({});
  // Tracking types (asset/liability) are always off-budget — they represent
  // net-worth items like a house or a loan balance, not spendable/budgetable
  // money — so the toggle is locked off whenever one of those is selected.
  const onBudget = el("input", {type: "checkbox", id: "acct-onbudget",
    ...((acct ? acct.on_budget : true) ? {checked: "checked"} : {})});
  const onBudgetRow = el("label", {class: "field"},
    el("label", {}, onBudget, " On Budget (counts toward your budget categories)"));
  const syncOnBudget = () => {
    const isTracking = type.value === "asset" || type.value === "liability";
    onBudget.disabled = isTracking;
    if (isTracking) onBudget.checked = false;
  };
  type.addEventListener("change", syncOnBudget);
  syncOnBudget();
  const body = el("div", {},
    el("label", {class: "field"}, el("span", {}, "Name"), name),
    el("label", {class: "field"}, el("span", {}, "Type"), type),
    onBudgetRow,
    acct ? null : el("label", {class: "field"}, el("span", {}, "Opening balance (optional)"),
      opening.el, el("div", {class: "help"}, "For a credit card, tap the +/- toggle to − and enter what you owe.")),
    acct ? el("label", {class: "field"},
      el("label", {}, el("input", {type: "checkbox", id: "acct-closed", ...(acct.closed ? {checked: "checked"} : {})}),
        " Closed account")) : null);

  const save = async () => {
    if (!name.value.trim()) return toast("Name required", true);
    const payload = {name: name.value.trim(), type: type.value, on_budget: onBudget.checked ? 1 : 0};
    try {
      if (acct) {
        payload.closed = $("#acct-closed").checked ? 1 : 0;
        await api(`/accounts/${acct.id}`, {method: "PUT", body: payload});
      } else {
        payload.opening_balance = opening.getCents();
        await api("/accounts", {method: "POST", body: payload});
      }
      closeModal(); await refreshAccounts(); renderShell();
    } catch (e) { toast(e.message, true); }
  };
  const foot = [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel")];
  if (acct) foot.push(el("button", {class: "btn danger", onclick: async () => {
    if (confirm("Delete this account and all its transactions?")) {
      await api(`/accounts/${acct.id}`, {method: "DELETE"});
      closeModal(); State.accountId = null; State.view = "budget";
      await refreshAccounts(); renderShell();
    }
  }}, "Delete"));
  foot.push(el("button", {class: "btn", onclick: save}, "Save"));
  modal({title: acct ? "Edit Account" : "Add Account", onSubmit: save, bodyNode: body, footNode: foot});
}

// --------------------------------------------------------------------------
//  Reports, Import, Settings — loaded from separate files
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
//  Boot
// --------------------------------------------------------------------------
// After queued changes sync, repaint with the server's real numbers — but not
// out from under the user while they're mid-edit.
let syncRefreshTries = 0;
function refreshAfterSync() {
  const busy = $("#modal-root").children.length ||
    document.activeElement?.closest?.(".cell-edit, .budget-input, .amt-input");
  if (busy && syncRefreshTries++ < 20) return void setTimeout(refreshAfterSync, 3000);
  syncRefreshTries = 0;
  if (State.authed) refreshAccounts().then(() => navGo(State.view)).catch(() => {});
}
window.addEventListener("outbox:synced", refreshAfterSync);
// The server is reachable again: repaint with live data (no-op if still offline).
window.addEventListener("outbox:online", () => { if (State.authed) refreshAfterSync(); });
Outbox.onAuthLost = () => { State.authed = false; renderPicker(); };

const LAST_SESSION_KEY = "nab_last_session";
const lastSession = () => { try { return JSON.parse(localStorage.getItem(LAST_SESSION_KEY)); } catch { return null; } };
const saveLastSession = (v) => {
  try { v ? localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(v)) : localStorage.removeItem(LAST_SESSION_KEY); } catch {}
};

// Pull the screens you're likely to open next into the offline cache now, so
// a later refresh with the server down still has something to show — even for
// views not visited since the service worker took over.
function warmOfflineCache() {
  const urls = ["/api/accounts", "/api/categories", "/api/scheduled", "/api/preferences",
    `/api/budget/range?months=${budgetFetchMonths().join(",")}`,
    ...State.accounts.filter((a) => !a.closed).map((a) => `/api/transactions?account_id=${a.id}`)];
  Outbox.warm(urls);
}

// ---- Per-device settings, backed up on the server -------------------------------------
// The view settings kept in this browser (pref_*, favorites, collapsed groups) are mirrored
// to the server under this device's User-Agent. A browser that lost its storage gets them
// back; a changed User-Agent just starts a new profile, and the old one expires there.
const PROFILE_KEYS = (k) => k.startsWith("pref_") || k === "favCategories" || k === "collapsedGroups";
const profileSnapshot = () => {
  const o = {};
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (PROFILE_KEYS(k)) o[k] = localStorage.getItem(k); } }
  catch {}
  return o;
};
async function syncDeviceProfile() {
  let last = JSON.stringify(profileSnapshot());
  const push = async () => {
    const now = JSON.stringify(profileSnapshot());
    if (now === last) return;
    try { await api("/device-profile", {method: "PUT", body: {data: JSON.parse(now)}}); last = now; } catch {}
  };
  try {
    const marker = "profile_ua_" + State.budgetId;
    const seen = localStorage.getItem(marker);
    if (seen !== navigator.userAgent) {
      // First visit here, or storage was wiped: take the server's copy if it has one.
      const { data } = await api("/device-profile");
      if (data && !seen) {
        for (const [k, v] of Object.entries(data)) if (PROFILE_KEYS(k)) localStorage.setItem(k, v);
        localStorage.setItem(marker, navigator.userAgent);
        applyPrefs();
        navGo(State.view || "budget");
        last = JSON.stringify(profileSnapshot());
      } else {
        localStorage.setItem(marker, navigator.userAgent);   // keep what this browser has
        last = "";
      }
    } else {
      const { data } = await api("/device-profile");   // also checks in, so it isn't treated as stale
      if (!data) last = "";                            // expired meanwhile: store it again
    }
  } catch { return; }
  await push();
  setInterval(push, 15000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) push(); });
}

// When run by the Windows server program, the login screen shows the demo password. Inert elsewhere.
async function pingApp() {
  try { State.demoPassword = (await (await fetch("/api/ping")).json()).demo_password || null; }
  catch { /* a server without the endpoint, or offline: nothing to show */ }
}

async function boot() {
  await pingApp();
  await Outbox.init();
  Outbox.mountPill();
  let s;
  try { s = await api("/session"); }
  catch (e) {
    // Server unreachable and /session was never cached: if this device has
    // opened a budget before, carry on with it (views use whatever cached
    // data exists) instead of stranding the user on an error screen.
    const last = e.offline && lastSession();
    if (!last) return renderPicker();
    s = {open: true, budget_id: last.budget_id, budget_name: last.budget_name};
  }
  if (!s.open) {
    saveLastSession(null);
    renderPicker();
    return;
  }
  saveLastSession({budget_id: s.budget_id, budget_name: s.budget_name});
  State.budgetId = s.budget_id;
  State.budgetName = s.budget_name;
  try { await refreshAccounts(); }
  catch (e) { if (!e.offline) return renderPicker(); }
  State.authed = true;
  restoreView();
  renderShell();
  Outbox.drain();
  warmOfflineCache();
  syncDeviceProfile();
}
boot();
