// Phone-only screens: a simplified one-month budget list, and a two-step
// "Add Transaction" flow (big keypad for the amount, then the details).
// Shares the app's globals (el, api, fmt, State, navGo, ...) loaded before it.
"use strict";

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// --------------------------------------------------------------------------
//  Simplified budget
// --------------------------------------------------------------------------
async function renderMobileBudget(root) {
  const month = State.month;
  root.append(el("div", {class: "empty"}, "Loading budget…"));
  let all;
  try { all = await api(`/budget/range?months=${budgetFetchMonths().join(",")}`); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  const data = all[1] || {};
  root.innerHTML = "";

  const [yy, mm] = month.split("-");
  const title = new Date(yy, mm - 1, 1).toLocaleDateString(undefined, {month: "long", year: "numeric"});
  const tbb = data.to_be_budgeted || 0;
  const search = el("input", {type: "search", class: "mb-search", placeholder: "Search categories"});
  const list = el("div", {class: "mb-list"});
  const collapsed = getCollapsedGroups();
  // Starred categories live on this device; "favorites only" hides the rest.
  const favs = new Set((() => { try { return JSON.parse(localStorage.getItem("favCategories") || "[]"); } catch { return []; } })());
  let favOnly = getPref("favOnly", "") === "1";
  const favBtn = el("button", {class: "mb-favfilter", "aria-label": "Show favorites only", onclick: () => {
    favOnly = !favOnly; setPref("favOnly", favOnly ? "1" : ""); paint();
  }}, "★");

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = "";
    favBtn.classList.toggle("on", favOnly);
    for (const g of data.groups || []) {
      const cats = g.categories.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!favOnly || favs.has(c.id)));
      if (!cats.length) continue;
      const shut = !q && !favOnly && collapsed.has(String(g.id));
      list.append(el("div", {class: "mb-group", onclick: () => {
          const k = String(g.id);
          collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
          try { localStorage.setItem("collapsedGroups", JSON.stringify([...collapsed])); } catch {}
          paint();
        }},
        el("span", {class: "chev" + (shut ? " collapsed" : "")}, "▾"),
        el("span", {class: "mb-gname"}, g.name),
        el("span", {class: "mb-gamt"}, fmt(g.available))));
      if (shut) continue;
      for (const c of cats) {
        const av = c.available || 0;
        list.append(el("div", {class: "mb-row", onclick: () => openMobileCategory(c, month)},
          el("button", {class: "mb-star" + (favs.has(c.id) ? " on" : ""), "aria-label": "Favorite",
            onclick: (e) => {
              e.stopPropagation();
              favs.has(c.id) ? favs.delete(c.id) : favs.add(c.id);
              try { localStorage.setItem("favCategories", JSON.stringify([...favs])); } catch {}
              paint();
            }}, favs.has(c.id) ? "★" : "☆"),
          el("span", {class: "mb-cname"}, c.name),
          el("span", {class: "mb-bal " + (av < 0 ? "neg" : av > 0 ? "pos" : "zero")}, fmt(av)),
          el("span", {class: "mb-chev"}, "›")));
      }
    }
    if (!list.children.length) list.append(el("div", {class: "empty"},
      q ? "No matching categories." : favOnly ? "No favorites yet. Turn off the ★ filter and tap a ☆ to add some." : "No categories yet. Add some under Settings → Categories."));
  };
  search.addEventListener("input", paint);
  paint();

  root.append(
    el("div", {class: "mb-head"},
      el("button", {class: "mb-nav", "aria-label": "Previous month",
        onclick: () => gotoBudgetMonth(monthAdd(month, -1))}, "‹"),
      el("div", {class: "mb-title"}, title + " Budget"),
      el("button", {class: "mb-nav", "aria-label": "Next month",
        onclick: () => gotoBudgetMonth(monthAdd(month, 1))}, "›")),
    el("div", {class: "mb-searchbar"}, search, favBtn),
    el("div", {class: "mb-tbb " + (tbb > 0 ? "pos" : tbb < 0 ? "neg" : "zero")},
      el("span", {}, "Available to Budget"), el("strong", {}, fmt(tbb))),
    list,
    el("button", {class: "mb-add", onclick: () => openAddTransaction()},
      el("span", {class: "mb-add-plus"}, "+"), "Add Transaction"));
  if (budgetSlideDir) { list.classList.add("bud-slide-" + budgetSlideDir); budgetSlideDir = null; }
  if (pendingScrollY != null) {
    const y = pendingScrollY; pendingScrollY = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
}

// Tap a category: edit this month's Budgeted amount, or jump to its
// transactions / carry-over setting (all that the old wide table offered).
function openMobileCategory(c, month) {
  const inp = el("input", {type: "text", inputmode: "decimal", class: "budget-input",
    value: c.budgeted ? dollars(c.budgeted) : "", placeholder: "0.00"});
  wireSmartMoneyInput(inp);
  const save = () => { closeModal(); const v = toCents(inp.value); if (v !== (c.budgeted || 0)) saveBudget(c, v, month); };
  const body = el("div", {},
    el("div", {class: "mc-stats"},
      el("div", {}, el("div", {class: "help"}, "Spent"), el("strong", {}, fmt(c.activity || 0))),
      el("div", {}, el("div", {class: "help"}, "Available"),
        el("strong", {class: (c.available || 0) < 0 ? "neg" : ""}, fmt(c.available || 0)))),
    el("label", {class: "field"}, el("span", {}, "Budgeted"), inp),
    // Set just this category from its past months (what was budgeted, or what was spent).
    el("div", {class: "field"}, el("span", {}, "Or set it to an average of…"),
      ...[["avg", "Budgeted"], ["spent", "Spent"]].map(([kind, label]) =>
        el("div", {class: "mc-avg"}, el("span", {class: "help"}, label),
          ...[3, 6, 12].map((n) => el("button", {type: "button", class: "btn secondary sm",
            onclick: () => { closeModal(); fillCategory(c, month, kind + n); }}, `${n} mo`))))),
    el("div", {class: "mc-links"},
      el("button", {class: "btn secondary", onclick: () => { closeModal(); openCategoryDetail(c, month); }}, "View transactions"),
      el("button", {class: "btn secondary", onclick: () => { closeModal(); openCarryToggle(c, month); }}, "Carry-over setting")));
  modal({title: `${c.name} · ${monthShort(month)}`, bodyNode: body, onSubmit: save, footNode: [
    el("div", {style: "flex:1"}),
    el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
    el("button", {class: "btn", onclick: save}, "Save")]});
  // modal() focuses the first field, which would throw the keyboard up over
  // the buttons below it; let the person tap Budgeted when they want to type.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

// --------------------------------------------------------------------------
//  Add Transaction (step 1: amount, step 2: details)
// --------------------------------------------------------------------------
let mobilePayees = null;   // remembered across openings; filled lazily

async function loadMobilePayees() {
  if (mobilePayees) return mobilePayees;
  // One small call for every payee in every account (most used first), not every account's full history.
  try { mobilePayees = await api("/payees"); } catch { mobilePayees = []; }
  return mobilePayees;
}

// opts: {categoryId, date, accountId, onSaved} — preset a category / date / account, and say where to
// go after saving (default: back to the budget).
async function openAddTransaction(opts = {}) {
  const accounts = State.accounts.filter((a) => !a.closed);
  if (!accounts.length) { toast("Add an account first (More → Add account)", true); return; }
  const defaultAccount = Number(getPref("defaultAccount", "")) || null;   // per device

  const tx = {
    digits: "",                  // typed digits; value in cents
    sign: -1,                    // -1 expense (default), +1 income
    payee: "", memo: "", cleared: false,
    date: opts.date || localToday(),
    categoryId: opts.categoryId || null,
    transfer: false,
    // This device's default account (Settings), else the one used last time, else the first on-budget one.
    accountId: opts.accountId || defaultAccount || Number(getPref("lastTxnAccount", "")) || (accounts.find((a) => a.on_budget) || accounts[0]).id,
    transferId: null,
  };
  if (!accounts.some((a) => a.id === tx.accountId)) tx.accountId = accounts[0].id;
  const cents = () => parseInt(tx.digits || "0", 10);

  const overlay = el("div", {class: "mtx"});
  // Closing (Cancel or after saving) slides the whole entry off to the right.
  // iOS pans the page when the keyboard opens, dragging a fixed overlay with
  // it; pin the overlay to the visible viewport and freeze the page behind.
  const vv = window.visualViewport;
  const fit = () => {
    if (!vv) return;
    overlay.style.top = vv.offsetTop + "px";
    overlay.style.height = vv.height + "px";
    overlay.style.bottom = "auto";
  };
  const noScroll = (e) => { if (!e.target.closest(".mtx-form")) e.preventDefault(); };
  if (vv) { vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
  overlay.addEventListener("touchmove", noScroll, {passive: false});
  const unfit = () => {
    if (vv) { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); }
  };
  const savedY = window.scrollY;
  const close = (instant = false) => {
    unfit();
    document.body.classList.remove("mtx-open");
    document.body.style.top = "";
    window.scrollTo(0, savedY);
    if (instant === true) { overlay.remove(); return; }
    overlay.classList.add("leaving");
    setTimeout(() => overlay.remove(), 240);
  };
  // Show a step: it slides in from the right when moving forward and from the
  // left when going back, pushing the previous step out the opposite side.
  let current = null, amountTap = null;
  // Header + dollar amount are permanent; only the stage below them slides.
  const amtEl = el("div", {class: "mtx-amount"});
  amtEl.addEventListener("click", () => { if (amountTap) amountTap(); });
  const stage = el("div", {class: "mtx-stage"});
  const show = (screen, dir, onAmountTap = null) => {
    amountTap = onAmountTap;
    amtEl.classList.toggle("tappable", !!onAmountTap);
    const old = current;
    current = screen;
    screen.classList.add("mtx-screen");
    if (old) screen.classList.add("in-" + dir);   // the first step rides in with the overlay itself
    stage.append(screen);
    if (old) {
      old.classList.add("out-" + dir);
      setTimeout(() => old.remove(), 260);
    }
  };
  overlay.append(el("div", {class: "mtx-bar"},
    el("button", {class: "mtx-link", onclick: () => close()}, "Cancel"),   // aborts the whole entry
    el("div", {class: "mtx-bar-title"}, "Add Transaction")), amtEl, stage);
  document.body.append(overlay);
  document.body.style.top = -savedY + "px";
  document.body.classList.add("mtx-open");
  fit();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

  const amountText = () => {
    const c = cents();
    return (tx.sign < 0 && c ? "-" : "") + fmt(c).replace(/^-/, "");
  };
  // The big figure at the top (red expense, green income).
  const paintAmount = () => {
    amtEl.textContent = amountText();
    amtEl.classList.toggle("out", tx.sign < 0);
    amtEl.classList.toggle("in", tx.sign > 0);
  };
  paintAmount();

  // ---- step 1: keypad ------------------------------------------------------
  const stepAmount = (dir = "fwd") => {
    const refresh = paintAmount;
    const exp = el("button", {class: "mtx-kind exp" + (tx.sign < 0 ? " on" : "")}, "EXPENSE");
    const inc = el("button", {class: "mtx-kind inc" + (tx.sign > 0 ? " on" : "")}, "INCOME");
    const setKind = (s) => {
      tx.sign = s; exp.classList.toggle("on", s < 0); inc.classList.toggle("on", s > 0); refresh();
    };
    exp.addEventListener("click", () => setKind(-1));
    inc.addEventListener("click", () => setKind(1));
    const press = (d) => {
      const next = (tx.digits + d).replace(/^0+/, "");
      if (next.length > 10) return;
      tx.digits = next; refresh();
    };
    const key = (label, onTap, cls = "") => el("button", {class: "mtx-key " + cls, onclick: onTap}, label);
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => key(String(n), () => press(String(n))));
    keys.push(
      key(el("span", {class: "mtx-back-icon", "aria-label": "Delete", html:
        '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 5H9l-6 7 6 7h12a1 1 0 001-1V6a1 1 0 00-1-1z" fill="currentColor" fill-opacity=".14"/>' +
        '<path d="M16 9.5l-5 5M11 9.5l5 5"/></svg>'}),
        () => { tx.digits = tx.digits.slice(0, -1); refresh(); }, "back"),
      key("0", () => press("0")),
      key(el("span", {}, "NEXT ›"), () => {
        if (!cents()) { toast("Enter an amount first", true); return; }
        stepDetails();
      }, "next"));
    show(el("div", {}, el("div", {class: "mtx-kinds"}, exp, inc),
      el("div", {class: "mtx-pad"}, ...keys)), dir);
  };

  // ---- step 2: details -----------------------------------------------------
  const stepDetails = () => {
    let cats = [];
    // The category list loads in the background. Tapping Category before it arrives used to open an empty picker.
    const catsLoaded = api("/categories").then((c) => { cats = c; paintCat(); }).catch(() => { cats = null; });

    const row = (label, control, extra = "") =>
      el("label", {class: "mtx-row " + extra}, el("span", {class: "mtx-label"}, label), control);

    const payee = el("input", {type: "text", class: "mtx-input", placeholder: "Choose a payee",
      value: tx.payee, autocomplete: "off", enterkeyhint: "done"});
    // Suggestions sit in the page flow right under the Payee row (not a floating
    // popup, which on iPhone sinks under the keyboard and turns see-through).
    const suggest = el("div", {class: "mtx-suggest"});
    const paintSuggest = () => {
      const q = payee.value.trim().toLowerCase();
      suggest.replaceChildren();
      if (!q || tx.transfer) return;
      const hits = (mobilePayees || []).filter((p) => p.toLowerCase().includes(q) && p.toLowerCase() !== q)
        .sort((a, b) => (b.toLowerCase().startsWith(q)) - (a.toLowerCase().startsWith(q))).slice(0, 5);
      for (const p of hits) {
        const b = el("button", {type: "button", class: "mtx-sug"}, p);
        b.addEventListener("pointerdown", (e) => e.preventDefault());   // keep the field focused
        b.addEventListener("click", () => { payee.value = p; tx.payee = p; suggest.replaceChildren(); payee.blur(); });
        suggest.append(b);
      }
    };
    loadMobilePayees().then(paintSuggest);
    payee.addEventListener("input", () => { tx.payee = payee.value; paintSuggest(); });
    payee.addEventListener("blur", () => setTimeout(() => suggest.replaceChildren(), 150));

    const catVal = el("div", {class: "mtx-input pick"});
    const paintCat = () => {
      const name = cats ? catNameById(cats, tx.categoryId) : null;
      catVal.textContent = name || "Choose a category";
      catVal.classList.toggle("placeholder", !name);
    };
    catVal.addEventListener("click", async () => {
      await catsLoaded;
      if (!cats) { toast("Couldn't load your categories. Check your connection and try again.", true); return; }
      openCategoryPicker(cats, tx.categoryId, (id) => { tx.categoryId = id; paintCat(); });
    });
    paintCat();

    const acctSel = el("select", {class: "mtx-input"},
      ...accounts.map((a) => el("option", {value: a.id}, a.name)));
    acctSel.value = tx.accountId;

    const xferSel = el("select", {class: "mtx-input"});
    const fillXfer = () => {
      xferSel.innerHTML = "";
      for (const a of accounts) if (a.id !== tx.accountId) xferSel.append(el("option", {value: a.id}, a.name));
      if (tx.transferId && tx.transferId !== tx.accountId) xferSel.value = tx.transferId;
      tx.transferId = xferSel.value ? Number(xferSel.value) : null;
    };
    acctSel.addEventListener("change", () => { tx.accountId = Number(acctSel.value); fillXfer(); });
    xferSel.addEventListener("change", () => { tx.transferId = Number(xferSel.value); });

    const date = el("input", {type: "date", class: "mtx-input", value: tx.date});
    date.addEventListener("change", () => { if (date.value) tx.date = date.value; });

    const memo = el("textarea", {class: "mtx-memo", rows: "2", placeholder: "Enter a memo", enterkeyhint: "done"});
    memo.value = tx.memo;
    memo.addEventListener("input", () => { tx.memo = memo.value; });
    // The keyboard's Return key reads "Done" and just closes the keyboard
    // (no newline in a memo, no accidental submit).
    for (const f of [payee, memo]) f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); f.blur(); }
    });

    const switchEl = (get, set) => {
      const b = el("button", {type: "button", class: "mtx-switch", role: "switch"});
      const paint = () => { b.classList.toggle("on", get()); b.setAttribute("aria-checked", String(get())); };
      b.addEventListener("click", (e) => { e.preventDefault(); set(!get()); paint(); });
      paint();
      return b;
    };

    const payeeRow = row("Payee:", payee);
    const catRow = row("Category:", catVal);
    const xferRow = row("Transfer to:", xferSel);
    const syncTransfer = () => {
      payeeRow.style.display = catRow.style.display = tx.transfer ? "none" : "";   // a transfer has neither: the other account is its payee
      suggest.replaceChildren();
      xferRow.style.display = tx.transfer ? "" : "none";
      fillXfer();
    };
    const xferSwitch = switchEl(() => tx.transfer, (v) => {
      tx.transfer = v;
      if (v && accounts.length < 2) { tx.transfer = false; toast("You need a second account to transfer", true); }
      xferSwitch.classList.toggle("on", tx.transfer);
      syncTransfer();
    });
    const clearedSwitch = switchEl(() => tx.cleared, (v) => { tx.cleared = v; });

    // Empty fields: the first Save blinks them yellow and says what's missing; Save again goes ahead anyway.
    const warn = el("div", {class: "mtx-warn", hidden: true});
    let warnedFor = "";
    const missingFields = () => {
      const out = [];
      if (cents() === 0) out.push(["Amount", amtEl]);
      if (!tx.transfer && !tx.payee.trim()) out.push(["Payee", payeeRow]);
      if (!tx.transfer && !tx.categoryId) out.push(["Category", catRow]);
      return out;
    };
    const warnAbout = (missing) => {
      for (const [, node] of missing) {
        node.classList.remove("mtx-missing"); void node.offsetWidth;   // restart the blink if it's already showing
        node.classList.add("mtx-missing");
      }
      warn.textContent = `Missing ${missing.map(([name]) => name).join(" and ")}. Tap Save again to save anyway.`;
      warn.hidden = false;
      saveBtn.lastChild.textContent = "Save Anyway";
      missing[0][1].scrollIntoView({block: "center", behavior: "smooth"});
    };

    const save = async () => {
      if (tx.transfer && !tx.transferId) { toast("Pick the other account for the transfer", true); return; }
      const missing = missingFields(), key = missing.map(([n]) => n).join();
      if (missing.length && warnedFor !== key) { warnedFor = key; warnAbout(missing); return; }
      const payload = {account_id: tx.accountId, date: tx.date, payee: tx.transfer ? "" : tx.payee.trim(),
        memo: tx.memo, cleared: tx.cleared ? 1 : 0, amount: tx.sign * cents()};
      if (tx.transfer) payload.transfer_account_id = tx.transferId;
      else payload.category_id = tx.categoryId || null;
      saveBtn.disabled = true;
      try {
        await api("/transactions", {method: "POST", body: payload});
        setPref("lastTxnAccount", String(tx.accountId));
        mobilePayees = null;
        close(true);
        await refreshAccounts();
        toast("Transaction saved");
        if (opts.onSaved) await opts.onSaved(); else navGo("budget");
      } catch (e) { saveBtn.disabled = false; toast(e.message, true); }
    };
    const saveBtn = el("button", {class: "mtx-save", onclick: save},
      el("span", {class: "mtx-save-check"}, "✓"), "Save Transaction");

    const screen = el("div", {},
      el("div", {class: "mtx-form"},
        payeeRow, suggest, catRow, xferRow,
        row("Account:", acctSel),
        row("Date:", date),
        row("Transfer:", xferSwitch),
        el("div", {class: "mtx-section"}, "Optional"),
        memo,
        row("Cleared:", clearedSwitch)),
      el("div", {class: "mtx-savebar"}, warn, saveBtn));
    show(screen, "fwd", () => stepAmount("back"));
    syncTransfer();
  };

  stepAmount();
}
