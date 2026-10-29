/* Scheduled Transactions — recurring bills/income, auto-entered into the
 * register once within the "due soon" window (Settings). Status reflects the
 * oldest unresolved occurrence: Paid (green), Past Due (red), Due Soon
 * (yellow), or Scheduled (nothing due yet). */
"use strict";

const SCHED_FREQUENCIES = [
  "Never", "Daily", "Weekly", "Every 2 Weeks", "Every Month",
  "Every 2 Months", "Every 3 Months", "Every 4 Months", "Twice a Year", "Yearly",
];

const SCHED_STATUS_LABEL = {
  paid: "Paid", past_due: "Past Due", due_soon: "Due Soon", scheduled: "Scheduled",
};

const SCHED_FREQ_SHORT = {
  "Never": "One-time", "Daily": "Daily", "Weekly": "Weekly", "Every 2 Weeks": "Biweekly",
  "Every Month": "Monthly", "Every 2 Months": "Every 2 mo", "Every 3 Months": "Quarterly",
  "Every 4 Months": "Every 4 mo", "Twice a Year": "Twice a year", "Yearly": "Yearly",
};

// Occurrences per month, for the "bills per month" estimate.
const SCHED_PER_MONTH = {
  "Never": 0, "Daily": 30.44, "Weekly": 4.345, "Every 2 Weeks": 2.1725, "Every Month": 1,
  "Every 2 Months": 1 / 2, "Every 3 Months": 1 / 3, "Every 4 Months": 1 / 4,
  "Twice a Year": 1 / 6, "Yearly": 1 / 12,
};

function schedStatusBadge(status) {
  return el("span", {class: "sched-status " + status}, SCHED_STATUS_LABEL[status] || status);
}

const schedDaysUntil = (dateStr) => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(dateStr + "T00:00:00") - t) / 864e5);
};
const schedShortDate = (dateStr, withYear = false) =>
  new Date(dateStr + "T00:00:00").toLocaleDateString(undefined,
    withYear ? {month: "short", day: "numeric", year: "numeric"} : {month: "short", day: "numeric"});
const fmtWhole = (cents) => (cents < 0 ? "-" : "") + "$" + Math.round(Math.abs(cents) / 100).toLocaleString();

// "3 days overdue" / "Due today" / "Due in 5 days" / "Paid".
function schedDueText(s) {
  if (s.status === "paid") return "Paid";
  const d = schedDaysUntil(s.next_date);
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} overdue`;
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  return `Due in ${d} days`;
}

const schedLabel = (s) => s.payee || (s.transfer_account_name ? `Transfer : ${s.transfer_account_name}` : "(no payee)");
const schedCategory = (s) => s.transfer_account_name ? `Transfer : ${s.transfer_account_name}`
  : (s.category_name || "Uncategorized");

// A payment already made on a repeating schedule is listed as a row of its own (status Paid, dated the day it was paid)
// until its due date arrives; these rows carry paid_txn_id and the paid_* fields.
const schedIsPaidRow = (s) => s.paid_txn_id != null;
const schedShownDate = (s) => (schedIsPaidRow(s) ? s.paid_date : s.next_date);
const schedShownAmount = (s) => (schedIsPaidRow(s) ? s.paid_amount : s.amount);
const schedShownMemo = (s) => (schedIsPaidRow(s) ? s.paid_memo : s.memo);
// Paid rows first, in the order they were paid; then everything still to come, soonest first.
function schedOrder(rows) {
  const byPaidAt = (a, b) => (a.paid_at || "") < (b.paid_at || "") ? -1 : (a.paid_at || "") > (b.paid_at || "") ? 1 : a.paid_txn_id - b.paid_txn_id;
  const paid = rows.filter(schedIsPaidRow).sort(byPaidAt);
  const rest = rows.filter((s) => !schedIsPaidRow(s)).sort((a, b) => a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : 0);
  return [...paid, ...rest];
}
// Pay a schedule from here: its oldest unpaid entry (or, if nothing is waiting yet, the next one, entered now so it
// can be paid ahead of time), in the same Make Payment dialog the register uses.
async function payScheduled(s) {
  try {
    const {transaction_id} = await api(`/scheduled/${s.id}/occurrence`, {method: "POST"});
    const t = await api(`/transactions/${transaction_id}`);
    openPaymentDialog([t], {title: `Pay ${schedLabel(s)}`, onDone: () => navGo("scheduled")});
  } catch (e) { toast(e.message, true); }
}
const schedCanPay = (s) => !schedIsPaidRow(s) && s.status !== "paid";

async function renderScheduled(root) {
  root.append(el("div", {class: "empty"}, "Loading…"));
  let cats, rows;
  try { [cats, rows] = await Promise.all([api("/categories"), api("/scheduled")]); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  root.innerHTML = "";
  // Loading the schedules enters any that are now due, and editing one can create or move the
  // other side of a transfer — either changes account balances, so refresh the sidebar's.
  updateSidebarBalances();

  root.append(el("div", {class: "toolbar"},
    el("button", {class: "btn", onclick: () => openScheduledModal(cats)}, "+ Add Scheduled Transaction"),
    el("div", {class: "grow"})));

  if (!rows.length) {
    State.focusScheduledId = null;
    root.append(el("div", {class: "empty"}, "No scheduled transactions yet. Add one to get started."));
    return;
  }

  const sorted = schedOrder(rows);
  // Arrived from a register's recurring icon: scroll to that schedule and flash it.
  const flashFocused = () => {
    const id = State.focusScheduledId; State.focusScheduledId = null;
    if (id == null) return;
    requestAnimationFrame(() => {
      const target = root.querySelector(`[data-sched-id="${id}"]:not(.sched-paid-row)`) || root.querySelector(`[data-sched-id="${id}"]`);
      if (!target) return;
      target.scrollIntoView({block: "center", behavior: "smooth"});
      target.classList.add("sched-flash");
      setTimeout(() => target.classList.remove("sched-flash"), 1800);
    });
  };
  if (isMobile()) { renderScheduledCards(root, cats, sorted); flashFocused(); return; }

  root.append(el("table", {class: "register"},
    el("thead", {}, el("tr", {},
      el("th", {class: "sched-del-col"}),
      el("th", {}, "Next Date"), el("th", {}, "Payee"), el("th", {}, "Category"),
      el("th", {}, "Account"), el("th", {}, "Memo"), el("th", {class: "num"}, "Amount"),
      el("th", {}, "Frequency"), el("th", {}, "Status"), el("th", {}))),
    el("tbody", {}, ...sorted.map((s) => el("tr", {class: "sched-row" + (schedIsPaidRow(s) ? " sched-paid-row" : ""), "data-sched-id": s.id, onclick: () => openScheduledModal(cats, s)},
      // Delete sits at the left edge (shown on row hover); Pay and payment history are at the right.
      el("td", {class: "sched-del-col"}, schedIsPaidRow(s) ? null : el("div", {class: "rowbtns"},
        el("button", {title: "Delete",
          onclick: (e) => { e.stopPropagation(); deleteScheduled(s.id, schedLabel(s)); }}, "✕"))),
      el("td", {}, schedShownDate(s)),
      el("td", {}, schedLabel(s)),
      el("td", {}, schedCategory(s)),
      el("td", {}, s.account_name || "—"),
      el("td", {class: "memo"}, schedShownMemo(s) || ""),
      el("td", {class: "num " + (schedShownAmount(s) < 0 ? "out" : "in")}, fmt(schedShownAmount(s))),
      el("td", {}, s.frequency),
      el("td", {}, schedStatusBadge(s.status)),
      el("td", {}, el("div", {class: "rowbtns"},
        schedCanPay(s) ? el("button", {class: "sched-pay", title: "Make a payment on this",
          onclick: (e) => { e.stopPropagation(); payScheduled(s); }}, "Pay") : null,
        el("button", {title: "Payment history",
          onclick: (e) => { e.stopPropagation(); goToScheduledHistory(s.id); }}, "🕓"))))))));
  flashFocused();
}

// Phone layout: a three-tile summary strip, then cards grouped by urgency
// (Past Due → Due Soon → Upcoming → Paid) with a colored stripe per status.
// Tapping a card edits it; delete lives inside the edit dialog so a stray tap
// can't remove a bill.
function renderScheduledCards(root, cats, sorted) {
  const byStatus = (st) => sorted.filter((s) => s.status === st);   // `sorted` already has the paid rows first, in the order paid
  const sum = (list) => list.reduce((a, s) => a + s.amount, 0);
  const past = byStatus("past_due"), soon = byStatus("due_soon");

  let bills = 0, income = 0;
  for (const s of sorted) {
    if (s.transfer_account_id || schedIsPaidRow(s)) continue;
    const perMonth = (SCHED_PER_MONTH[s.frequency] || 0) * s.amount;
    if (perMonth < 0) bills += perMonth; else income += perMonth;
  }

  const tile = (cls, label, value, sub) => el("div", {class: "sched-tile " + cls},
    el("div", {class: "st-label"}, label),
    el("div", {class: "st-val"}, value),
    el("div", {class: "st-sub"}, sub));
  root.append(el("div", {class: "sched-summary"},
    tile(past.length ? "past_due" : "ok", "Past due", past.length ? fmtWhole(sum(past)) : "—",
      past.length ? `${past.length} bill${past.length === 1 ? "" : "s"}` : "All caught up"),
    tile(soon.length ? "due_soon" : "ok", "Due soon", soon.length ? fmtWhole(sum(soon)) : "—",
      soon.length ? `${soon.length} coming up` : "Nothing yet"),
    tile("", "Bills / mo", fmtWhole(bills), income ? `Income ${fmtWhole(income)}` : "estimate")));

  const card = (s) => el("div", {class: "sched-card " + s.status, "data-sched-id": s.id, onclick: () => openScheduledModal(cats, s)},
    el("div", {class: "sc-top"},
      el("div", {class: "sc-payee"}, schedLabel(s)),
      el("div", {class: "sc-amt " + (schedShownAmount(s) < 0 ? "out" : "in")}, fmt(schedShownAmount(s)))),
    el("div", {class: "sc-mid"},
      el("span", {class: "sc-due " + s.status}, schedDueText(s)),
      el("span", {class: "sc-sep"}, "·"),
      el("span", {}, schedShortDate(schedShownDate(s))),
      el("span", {class: "sc-freq"}, "↻ " + (SCHED_FREQ_SHORT[s.frequency] || s.frequency))),
    el("div", {class: "sc-bot"},
      el("span", {class: "sc-sub"}, `${s.account_name || "—"} · ${schedCategory(s)}`),
      schedCanPay(s) ? el("button", {class: "sc-pay", type: "button",
        onclick: (e) => { e.stopPropagation(); payScheduled(s); }}, "Pay") : null,
      el("button", {class: "sc-hist", type: "button",
        onclick: (e) => { e.stopPropagation(); goToScheduledHistory(s.id); }}, "History ›")));

  const GROUPS = [["paid", "Paid"], ["past_due", "Past Due"], ["due_soon", "Due Soon"], ["scheduled", "Upcoming"]];
  const list = el("div", {class: "sched-cards"});
  for (const [key, label] of GROUPS) {
    const items = byStatus(key);
    if (!items.length) continue;
    list.append(el("div", {class: "sched-group-head " + key}, el("span", {}, label),
      el("span", {class: "sg-count"}, String(items.length))));
    list.append(...items.map(card));
  }
  root.append(list);
}

async function deleteScheduled(id, name) {
  if (!confirm(`Delete the scheduled transaction${name ? ` “${name}”` : ""}?\n\n` +
      "Payments you've already made stay in your register. Any upcoming entry it already added " +
      "that hasn't been paid yet is removed, and it leaves your calendar. You can Undo right after.")) return;
  try {
    await api(`/scheduled/${id}`, {method: "DELETE"});
    navGo("scheduled");
    toast("Scheduled transaction deleted", false, {label: "Undo", onClick: undoDeleteScheduled});
  } catch (e) { toast(e.message, true); }
}

async function undoDeleteScheduled() {
  try { await api("/scheduled/undo-delete", {method: "POST"}); navGo("scheduled"); toast("Restored"); }
  catch (e) { toast(e.message, true); }
}

function goToScheduledHistory(id) {
  State.scheduledHistoryId = id;
  navGo("scheduledHistory");
}

async function unlinkFromSchedule(scheduleId, txnId) {
  if (!confirm("Remove this from the schedule's history? The transaction itself stays in your register.")) return;
  try {
    await api(`/scheduled/${scheduleId}/unlink`, {method: "POST", body: {transaction_ids: [txnId]}});
    navGo("scheduledHistory");
    toast("Removed from history");
  } catch (e) { toast(e.message, true); }
}

// Sub-page under Scheduled: every past occurrence (paid or not) for one
// schedule, newest first. Past transactions entered by hand can be linked in
// here so the history reaches back before the schedule existed.
async function renderScheduledHistory(root, id) {
  root.append(el("div", {class: "empty"}, "Loading…"));
  let data;
  try { data = await api(`/scheduled/${id}/history`); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  root.innerHTML = "";
  // Coming back from the register: put the list where it was.
  const restoreScroll = () => {
    if (State.histRestoreY == null) return;
    const y = State.histRestoreY; State.histRestoreY = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  };

  const s = data.schedule;
  const title = s.payee || (s.transfer_account_id ? `Transfer : ${s.account_name}` : "Scheduled Transaction");
  root.append(el("div", {class: "toolbar"},
    el("button", {class: "btn secondary sm", onclick: () => navGo("scheduled")}, "‹ Back to Scheduled"),
    el("div", {class: "grow"}),
    el("div", {class: "help"}, `${title} · ${s.account_name}`)));
  root.append(el("div", {class: "toolbar"},
    el("button", {class: "btn sm", onclick: () => openLinkTransactionsModal(s)}, "+ Link past transactions")));

  const rows = data.transactions;
  if (!rows.length) {
    root.append(el("div", {class: "empty"},
      "No history yet. Use “Link past transactions” to pull in earlier payments you've already entered."));
    return;
  }

  // Both halves of a linked transfer are in the list; count each payment once
  // by only totalling the schedule's own account.
  const own = rows.filter((t) => t.account_id === s.account_id);
  if (own.length) {
    const total = own.reduce((a, t) => a + t.amount, 0);
    root.append(el("div", {class: "hist-summary"},
      el("span", {}, `${own.length} payment${own.length === 1 ? "" : "s"}`),
      el("span", {}, `${fmt(total)} total`),
      el("span", {}, `${fmt(Math.round(total / own.length))} avg`),
      el("span", {}, `since ${schedShortDate(own[own.length - 1].date, true)}`)));
  }

  const historyStatusPill = (t) => {
    if (t.cleared === 2) return el("span", {class: "cs-pill reconciled"}, el("span", {html: LOCK_SVG_ICON}), "Reconciled");
    if (t.cleared === 1) return el("span", {class: "cs-pill cleared"}, "Cleared");
    return schedStatusBadge(t.date < todayStr() ? "past_due" : "due_soon");
  };
  const payeeOf = (t) => t.transfer_account_name ? `Transfer : ${t.transfer_account_name}` : (t.payee || "(no payee)");
  const catOf = (t) => t.transfer_account_name ? "Transfer" : (t.category_name || "Uncategorized");
  // Click a payment to jump to it in its register, with a way back to this page.
  const openInRegister = (t) => {
    const y = window.scrollY;
    State.regReturn = {accountId: t.account_id, label: `Back to ${title}`,
      back: () => { State.histRestoreY = y; navGo("scheduledHistory"); }};
    goToTransaction(t.account_id, t.id);
  };
  const unlinkBtn = (t) => el("button", {class: "hist-unlink", type: "button", title: "Remove from this history",
    onclick: (e) => { e.stopPropagation(); unlinkFromSchedule(s.id, t.id); }}, "✕");

  if (isMobile()) {
    root.append(el("div", {class: "hist-cards"}, ...rows.map((t) => el("div", {class: "hist-card", onclick: () => openInRegister(t)},
      el("div", {class: "hc-main"},
        el("div", {class: "hc-top"}, el("span", {class: "hc-payee"}, payeeOf(t)),
          el("span", {class: "hc-amt " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount))),
        el("div", {class: "hc-sub"}, el("span", {}, schedShortDate(t.date, true)),
          el("span", {class: "sc-sep"}, "·"), el("span", {class: "hc-cat"}, catOf(t)),
          el("span", {class: "hc-pill"}, historyStatusPill(t)))),
      unlinkBtn(t)))));
    restoreScroll();
    return;
  }

  root.append(el("table", {class: "register"},
    el("thead", {}, el("tr", {},
      el("th", {}, "Date"), el("th", {}, "Payee"), el("th", {}, "Category"),
      el("th", {}, "Memo"), el("th", {class: "num"}, "Amount"), el("th", {}, "Status"), el("th", {}))),
    el("tbody", {}, ...rows.map((t) => el("tr", {class: "sched-row", title: "Go to this transaction in the register",
        onclick: () => openInRegister(t)},
      el("td", {}, t.date),
      el("td", {}, payeeOf(t)),
      el("td", {}, catOf(t)),
      el("td", {class: "memo"}, t.memo || ""),
      el("td", {class: "num " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount)),
      el("td", {}, historyStatusPill(t)),
      el("td", {}, el("div", {class: "rowbtns"}, unlinkBtn(t))))))));
  restoreScroll();
}

// Pick earlier transactions (same account, dated today or earlier) to attach
// to a schedule's history. Likely matches — similar payee or the same amount —
// are listed first.
async function openLinkTransactionsModal(schedule) {
  let txns, scheds;
  try {
    [txns, scheds] = await Promise.all([
      api(`/transactions?account_id=${schedule.account_id}`), api("/scheduled")]);
  } catch (e) { return toast(e.message, true); }

  const schedName = new Map(scheds.map((x) => [x.id, x.payee || "another schedule"]));
  const today = todayStr();
  // Offline-created rows (negative ids) aren't on the server yet.
  const pool = txns.filter((t) => t.id > 0 && t.date <= today && t.scheduled_id !== schedule.id);
  const byId = new Map(pool.map((t) => [t.id, t]));

  const sp = (schedule.payee || "").trim().toLowerCase();
  const isMatch = (t) => {
    const p = (t.payee || "").toLowerCase();
    return t.amount === schedule.amount || (sp && p && (p.includes(sp) || sp.includes(p)));
  };
  const suggested = pool.filter(isMatch), others = pool.filter((t) => !isMatch(t));

  const selected = new Set();
  const LIMIT = 150;
  const search = el("input", {type: "text", inputmode: "search", enterkeyhint: "search", placeholder: "Search payee, memo, category, amount…"});
  const list = el("div", {class: "link-list"});
  const linkBtn = el("button", {class: "btn", disabled: true}, "Link");
  const countEl = el("div", {class: "help"});

  const refreshFoot = () => {
    linkBtn.disabled = selected.size === 0;
    linkBtn.textContent = selected.size ? `Link ${selected.size}` : "Link";
    countEl.textContent = selected.size ? `${selected.size} selected` : "";
  };
  const haystack = (t) => `${t.payee || ""} ${t.memo || ""} ${t.category_name || ""} ${t.date} ${fmt(t.amount)}`.toLowerCase();

  const row = (t) => {
    const cb = el("input", {type: "checkbox"});
    cb.checked = selected.has(t.id);
    cb.addEventListener("change", () => { cb.checked ? selected.add(t.id) : selected.delete(t.id); refreshFoot(); });
    const elsewhere = t.scheduled_id ? el("span", {class: "lr-tag"}, "in " + (schedName.get(t.scheduled_id) || "a schedule")) : null;
    return el("label", {class: "link-row"}, cb,
      el("div", {class: "lr-main"},
        el("div", {class: "lr-top"}, el("span", {class: "lr-payee"}, t.payee || "(no payee)"),
          el("span", {class: "lr-amt " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount))),
        el("div", {class: "lr-sub"}, schedShortDate(t.date, true), " · ",
          t.transfer_account_name ? `Transfer : ${t.transfer_account_name}` : (t.category_name || "Uncategorized"),
          t.cleared === 0 ? " · uncleared" : "", elsewhere ? " " : "", elsewhere)));
  };

  const section = (label, items, hint) => {
    if (!items.length) return;
    list.append(el("div", {class: "link-group-head"}, el("span", {}, label),
      hint ? el("button", {class: "btn ghost sm", type: "button", onclick: hint.onclick}, hint.label) : null));
    list.append(...items.slice(0, LIMIT).map(row));
    if (items.length > LIMIT) list.append(el("div", {class: "help", style: "padding:8px 20px"},
      `Showing ${LIMIT} of ${items.length} — search to narrow.`));
  };
  const paint = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const match = (t) => q.every((w) => haystack(t).includes(w));
    const sug = suggested.filter(match), oth = others.filter(match);
    if (!sug.length && !oth.length) {
      list.append(el("div", {class: "empty"}, pool.length ? "No transactions match." : "No earlier transactions in this account."));
      return;
    }
    section("Likely matches", sug, sug.length ? {label: "Select all", onclick: () => {
      sug.slice(0, LIMIT).forEach((t) => selected.add(t.id)); paint(); refreshFoot(); }} : null);
    section(sug.length ? "Other transactions" : "All transactions", oth, null);
  };
  search.addEventListener("input", paint);
  paint();

  const doLink = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    const uncleared = ids.filter((id) => byId.get(id).cleared === 0).length;
    let markCleared = false;
    if (uncleared) {
      if (!confirm(`${uncleared} of these ${ids.length} aren't cleared yet, which would make this schedule show as "Past Due". Mark them cleared and link?`)) return;
      markCleared = true;
    }
    try {
      await api(`/scheduled/${schedule.id}/link`, {method: "POST", body: {transaction_ids: ids, mark_cleared: markCleared}});
      closeModal();
      toast(`Linked ${ids.length} transaction${ids.length === 1 ? "" : "s"}`);
      navGo("scheduledHistory");
    } catch (e) { toast(e.message, true); }
  };
  linkBtn.addEventListener("click", doLink);

  modal({title: "Link past transactions", wide: true,
    bodyNode: el("div", {class: "link-body"},
      el("div", {class: "help", style: "margin-bottom:10px"},
        `Pick earlier payments for ${schedule.payee || "this schedule"} in ${schedule.account_name} to add to its history.`),
      el("div", {class: "field"}, search), list),
    footNode: [countEl, el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"), linkBtn]});
  // modal() focuses the first field; on a phone that would pop the keyboard
  // up over the list before the user has had a chance to look at it.
  if (isMobile()) search.blur();
}

// existing: the scheduled-txn row being edited (from /api/scheduled), or
// null/undefined to add a new one.
function openScheduledModal(cats, existing) {
  const accounts = State.accounts.filter((a) => !a.closed);
  const acctSel = el("select", {});
  for (const a of accounts) {
    const o = el("option", {value: a.id}, a.name);
    if (existing && existing.account_id === a.id) o.selected = true;
    acctSel.append(o);
  }

  const payee = el("input", {type: "text", placeholder: "Payee", value: existing ? existing.payee : ""});
  const memo = el("input", {type: "text", placeholder: "Memo", value: existing ? existing.memo : ""});
  const date = el("input", {type: "date", value: existing ? existing.next_date : todayStr()});

  const freqSel = el("select", {});
  for (const f of SCHED_FREQUENCIES) {
    const o = el("option", {value: f}, f);
    if (existing ? existing.frequency === f : f === "Every Month") o.selected = true;
    freqSel.append(o);
  }

  const amt = amountField({defaultSign: -1,
    initialCents: existing ? existing.amount : 0});

  let categoryId = existing ? existing.category_id || null : null;
  const catValue = el("div", {class: "picker-field", tabindex: "0"});
  const paintCat = () => {
    catValue.textContent = categoryId ? catNameById(cats, categoryId) : "Uncategorized";
    catValue.classList.toggle("placeholder", !categoryId);
  };
  catValue.addEventListener("click", () =>
    openCategoryPicker(cats, categoryId, (id) => { categoryId = id; paintCat(); }));
  paintCat();
  const catField = el("div", {class: "field"}, el("span", {}, "Category"), catValue);

  // Transfer to/from another account — mutually exclusive with Category
  // (paying a credit card, moving savings, etc. don't have a spending category).
  const transferSel = el("select", {});
  const buildTransferOptions = () => {
    // Prefer whatever the user already has selected; only fall back to the
    // saved value on the very first build (before the user's touched it).
    const wanted = transferSel.value || (existing && existing.transfer_account_id ? String(existing.transfer_account_id) : "");
    transferSel.innerHTML = "";
    transferSel.append(el("option", {value: ""}, "— Not a transfer —"));
    for (const a of accounts) {
      if (String(a.id) === acctSel.value) continue;   // can't transfer to itself
      const o = el("option", {value: a.id}, a.name);
      if (String(a.id) === wanted) o.selected = true;
      transferSel.append(o);
    }
  };
  buildTransferOptions();
  const syncTransfer = () => { catField.style.display = transferSel.value ? "none" : "block"; };
  acctSel.addEventListener("change", () => { buildTransferOptions(); syncTransfer(); });
  transferSel.addEventListener("change", syncTransfer);
  syncTransfer();

  // Calendar reminder for this schedule (see Settings → Calendar Reminders):
  // on/off, and an optional time — blank means an all-day entry.
  const calOn = el("input", {type: "checkbox"});
  calOn.checked = existing ? !!existing.cal_alert : true;
  const calTime = el("input", {type: "time", value: existing ? existing.cal_time || "" : ""});
  const calTimeField = el("label", {class: "field"}, el("span", {}, "Time (optional)"), calTime,
    el("div", {class: "help"}, "Leave blank for an all-day entry. With a time, the calendar event and its alert are at that time."));
  const syncCal = () => { calTimeField.style.display = calOn.checked ? "" : "none"; };
  calOn.addEventListener("change", syncCal);
  syncCal();

  const body = el("div", {},
    el("label", {class: "field"}, el("span", {}, "Account"), acctSel),
    el("label", {class: "field"}, el("span", {}, "Payee"), payee),
    el("div", {class: "field"}, el("span", {}, "Amount"), amt.el),
    catField,
    el("label", {class: "field"}, el("span", {}, "Transfer to"), transferSel),
    el("label", {class: "field"}, el("span", {}, "Memo"), memo),
    el("label", {class: "field"}, el("span", {}, "Next date"), date),
    el("label", {class: "field"}, el("span", {}, "Frequency"), freqSel),
    el("label", {class: "field"}, el("label", {style: "display:flex; gap:10px; align-items:center"},
      calOn, el("span", {}, "Calendar alerts"))),
    calTimeField);

  const save = async () => {
    if (!accounts.length) return toast("Add an account first", true);
    const isTransfer = !!transferSel.value;
    const body = {
      account_id: Number(acctSel.value),
      payee: payee.value.trim(),
      memo: memo.value.trim(),
      next_date: date.value,
      frequency: freqSel.value,
      cal_alert: calOn.checked ? 1 : 0,
      cal_time: calOn.checked ? calTime.value : "",
      amount: amt.getCents(),
      category_id: isTransfer ? null : categoryId,
      transfer_account_id: isTransfer ? Number(transferSel.value) : null,
    };
    try {
      if (existing) await api(`/scheduled/${existing.id}`, {method: "PUT", body});
      else await api("/scheduled", {method: "POST", body});
      closeModal(); navGo("scheduled");
    } catch (e) { toast(e.message, true); }
  };

  const foot = [];
  if (existing) {
    foot.push(el("button", {class: "btn danger",
      onclick: () => { closeModal(); deleteScheduled(existing.id, schedLabel(existing)); }}, "Delete"));
    foot.push(el("button", {class: "btn ghost",
      onclick: () => { closeModal(); goToScheduledHistory(existing.id); }}, "History"));
  }
  foot.push(el("div", {style: "flex:1"}));
  foot.push(el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"));
  foot.push(el("button", {class: "btn", onclick: save}, existing ? "Save" : "Add"));

  modal({title: existing ? "Edit Scheduled Transaction" : "Add Scheduled Transaction",
    onSubmit: save, bodyNode: body, footNode: foot});
}
