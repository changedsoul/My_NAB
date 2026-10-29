/* Transaction list pages: "Search all accounts" (one box over every register, matching payee, memo, category,
 * account, date and amounts) and the per-category Outflows list opened from the budget.
 *
 * Neither draws its own table. Both hand a "scope" to renderRegister (app.js), the same screen an account uses,
 * so they have the same checkboxes, inline editing, bulk menu, filters, sorting and columns. A scope says what to
 * load, what the header shows, and where Back goes. */
"use strict";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const totalSpan = (total) => el("span", {class: "reg-sum-total " + (total < 0 ? "out" : "in")}, "Total " + fmt(total, {plus: true}));

// Clicking a category's Outflows figure in the budget: this month's transactions for that category.
function openCategoryDetail(c, month) {
  State.catTxn = {id: c.id, name: c.name, budgeted: c.budgeted, activity: c.activity,
    available: c.available, month};
  State.budgetScrollY = window.scrollY;   // so Back lands where the budget was scrolled to
  navGo("categoryTransactions");
}

async function renderCategoryTransactions(root) {
  const c = State.catTxn;
  if (!c) { navGo("budget"); return; }

  // Step to the previous/next month (the budget's figures for that month come along, and Back then lands on it).
  const gotoCatMonth = (m) => {
    State.catTxn = {...c, month: m};
    State.month = m;
    navGo("categoryTransactions");
  };
  const loadFigures = async () => {
    try {
      const [d] = await api(`/budget/range?months=${c.month}`);
      let found = null;
      for (const g of d.groups || []) for (const k of g.categories) if (k.id === c.id) found = k;
      Object.assign(State.catTxn, {budgeted: found ? found.budgeted : 0, activity: found ? found.activity : 0,
        available: found ? found.available : 0});
    } catch { /* keep the old figures */ }
  };

  const monthNav = el("div", {class: "cat-month-nav"},
    el("button", {class: "nav-arrow", "aria-label": "Previous month", onclick: () => gotoCatMonth(monthAdd(c.month, -1))}, "‹"),
    el("div", {class: "cat-month-label" + (c.month === curMonth() ? " today" : "")}, monthLabel(c.month)),
    el("button", {class: "nav-arrow", "aria-label": "Next month", onclick: () => gotoCatMonth(monthAdd(c.month, 1))}, "›"));

  await renderRegister(root, {
    key: `cat:${c.id}:${c.month}`,
    title: c.name,
    back: {label: "Budget", go: () => { pendingScrollY = State.budgetScrollY; navGo("budget"); }},
    reopen: () => navGo("categoryTransactions"),
    extra: monthNav,
    canAdd: true,
    // Add one already filed under this category (and in the default account), inside the month being viewed.
    add: () => openAddTransaction({
      categoryId: c.id,
      date: c.month === curMonth() ? undefined : `${c.month}-01`,
      onSaved: () => navGo("categoryTransactions")}),
    async load() {
      const [rows] = await Promise.all([api(`/transactions?category_id=${c.id}&month=${c.month}`), loadFigures()]);
      return rows;
    },
    summary: (shown, all, total) => {
      const cur = State.catTxn;
      return [el("span", {}, `Budgeted ${fmt(cur.budgeted)}`), el("span", {}, `Activity ${fmt(cur.activity)}`),
        el("span", {}, `Available ${fmt(cur.available)}`),
        ...(shown.length ? [el("span", {}, plural(shown.length, "transaction")), totalSpan(total)] : [])];
    },
    empty: `No transactions in ${monthLabel(c.month)}.`,
  });
}

async function renderSearch(root) {
  // Back goes to wherever Search was opened from, usually the register you were in.
  const VIEW_NAMES = {budget: "Budget", accounts: "Accounts", reports: "Reports", scheduled: "Scheduled",
    import: "Import", settings: "Settings"};
  const ret = State.searchReturn && State.searchReturn.view !== "search" ? State.searchReturn : null;
  const retAccount = ret && ret.view === "account" ? State.accounts.find((a) => a.id === ret.accountId) : null;
  const meta = {count: 0, truncated: false};

  await renderRegister(root, {
    key: "search",
    title: "Search",
    extra: el("div", {class: "help search-tip"},
      "Words must all match. Amounts match by their leading digits (45.67 exact, 45 finds 45.xx); put - or + in front to limit to outflows or inflows."),
    reopen: () => navGo("search", {keepReturn: true}),   // back from a register we visited: Back still returns to where Search began
    serverSearch: true, accountPicker: true, flat: true,
    back: {label: retAccount ? retAccount.name : (ret && VIEW_NAMES[ret.view]) || "Back",
      go: () => {
        if (ret && (ret.view !== "account" || retAccount)) navGo(ret.view, {accountId: ret.accountId});
        else navGo("budget", {accountId: null});
      }},
    canAdd: false,
    async load() {
      const q = (State.searchQuery || "").trim();
      if (!q) { Object.assign(meta, {count: 0, truncated: false}); return []; }
      const data = await api(`/search?q=${encodeURIComponent(q)}` + (State.searchAccount ? `&account_id=${State.searchAccount}` : ""));
      Object.assign(meta, {count: data.count, truncated: data.truncated});
      return data.transactions;
    },
    summary: (shown, all, total, localFilter) => !(State.searchQuery || "").trim() ? [] : [
      el("span", {}, localFilter ? `Showing ${shown.length} of ${all.length}` : `${meta.count} match${meta.count === 1 ? "" : "es"}`),
      totalSpan(total),
      ...(meta.truncated ? [el("span", {}, `showing the newest ${all.length}`)] : [])],
    get empty() { return (State.searchQuery || "").trim() ? "No matching transactions." : "Type something to search every account."; },
  });
}
