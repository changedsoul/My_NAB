/* Import view: one place to drop bank files. It works out what each file is (QFX/OFX, CSV or an Actual Budget
   export), and for QFX/OFX which of your accounts it belongs to, then shows a card for each with the review step.
   Also: duplicate detection, matching, and undo. */
"use strict";

function renderImport(root) {
  const recent = el("div", {class: "card", style: "margin-top:20px"});
  const ctx = {dedupDays: () => Number(dedupDays.value) || 0, autoCat: () => autoCat.checked,
    refreshRecent: () => { loadRecentImports(recent); updateSidebarBalances(); }};
  const dedupDays = el("input", {type: "number", min: "0", max: "10", value: "2", style: "width:70px"});
  const autoCat = el("input", {type: "checkbox", checked: getPref("importAutoCat", "1") === "1"});
  autoCat.addEventListener("change", () => setPref("importAutoCat", autoCat.checked ? "1" : "0"));
  const results = el("div", {class: "imp-results"});
  const picker = el("input", {type: "file", multiple: true, hidden: true, accept: ".qfx,.ofx,.csv,.zip,.txt"});

  const take = async (files) => {      // newest drop on top, files within it in the order they were chosen
    const sections = [];
    for (const f of files) sections.push(await fileSection(f, ctx));
    results.prepend(...sections);
  };
  const zone = el("div", {class: "imp-drop", tabindex: "0", role: "button"},
    el("div", {class: "imp-drop-big"}, "Drop bank files here, or click to choose"),
    el("div", {class: "help"}, "QFX, OFX, CSV, or an Actual Budget export (.zip). I'll work out what each one is."));
  zone.addEventListener("click", () => picker.click());
  zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); take([...e.dataTransfer.files]); });
  picker.addEventListener("change", () => { take([...picker.files]); picker.value = ""; });

  root.append(el("div", {class: "card"},
    el("h3", {style: "margin-top:0"}, "Import transactions"),
    zone, picker,
    el("details", {class: "imp-options"}, el("summary", {}, "Options"),
      el("label", {style: "display:flex;gap:8px;align-items:flex-start;margin-top:10px"}, autoCat,
        el("span", {}, "Fill in categories for new transactions from what their payee was given before")),
      el("label", {class: "field", style: "margin-top:10px"},
        el("span", {}, "Flag as a duplicate if it's within this many days of a matching transaction"), dedupDays)),
    results), recent);
  loadRecentImports(recent);
}

// An account dropdown. With no account chosen yet it shows "Choose an account…" so nothing is imported by accident.
function accountSelect(selectedId) {
  const sel = el("select", {});
  const open = State.accounts.filter((a) => !a.closed);
  sel.append(el("option", {value: ""}, open.length ? "Choose an account…" : "Create an account first"));
  for (const a of open) sel.append(el("option", {value: a.id}, a.name));
  if (selectedId && open.some((a) => a.id === selectedId)) sel.value = String(selectedId);
  return sel;
}

// -------------------- Recent imports / Undo --------------------
async function loadRecentImports(container) {
  container.innerHTML = "";
  container.append(el("h3", {style: "margin-top:0"}, "Recent imports"));
  let batches = [];
  try { batches = await api("/import/batches"); } catch { /* ignore */ }
  if (!batches.length) {
    container.append(el("div", {class: "help"}, "No imports yet. Imports show up here so you can undo them."));
    return;
  }
  container.append(el("div", {style: "display:flex;justify-content:space-between;align-items:flex-start;gap:12px"},
    el("p", {class: "help", style: "margin-top:0"}, "Undo removes every transaction that came in with that import. Your manually-entered transactions are never touched. " +
      "Remove just takes it off this list: the transactions stay, but you can no longer undo that import."),
    el("button", {class: "btn secondary sm", style: "flex-shrink:0", onclick: () => clearImports(batches.length, container)}, "Clear list")));
  for (const b of batches) {
    const when = (b.created_at || "").replace("T", " ").slice(0, 16);
    container.append(el("div", {style: "display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)"},
      el("div", {},
        el("strong", {}, `${b.current_count} transaction${b.current_count === 1 ? "" : "s"}`),
        el("span", {class: "tag", style: "margin-left:8px"}, (b.source || "").toUpperCase()),
        el("div", {class: "help"}, `${b.account_name || b.note || ""} · ${when}`)),
      el("div", {style: "display:flex;gap:6px;flex-shrink:0"},
        el("button", {class: "btn secondary sm", title: "Take this off the list. The transactions stay.", onclick: () => dismissImport(b, container)}, "Remove"),
        el("button", {class: "btn danger sm", onclick: () => undoImport(b, container)}, "Undo"))));
  }
}

async function dismissImport(b, container) {
  if (!confirm("Take this import off the list? Its transactions stay in your accounts, but you won't be able to undo this import afterwards.")) return;
  try { await api(`/import/batches/${b.id}`, {method: "DELETE"}); loadRecentImports(container); }
  catch (e) { toast(e.message, true); }
}

async function clearImports(n, container) {
  if (!confirm(`Clear all ${n} import${n === 1 ? "" : "s"} from this list? Their transactions stay in your accounts, but you won't be able to undo these imports afterwards.`)) return;
  try { await api("/import/batches/clear", {method: "POST"}); loadRecentImports(container); }
  catch (e) { toast(e.message, true); }
}

async function undoImport(b, container) {
  if (!confirm(`Undo this import and delete ${b.current_count} transaction${b.current_count === 1 ? "" : "s"}? This cannot be reversed.`)) return;
  try {
    const r = await api(`/import/batches/${b.id}/undo`, {method: "POST"});
    toast(`Removed ${r.removed} transactions`);
    await refreshAccounts();
    loadRecentImports(container);
  } catch (e) { toast(e.message, true); }
}

function afterImport(r, onDone) {
  const bits = [`Imported ${r.imported}`];
  if (r.matched) bits.push(`matched ${r.matched}`);
  if (r.skipped_duplicates) bits.push(`skipped ${r.skipped_duplicates} duplicate${r.skipped_duplicates === 1 ? "" : "s"}`);
  if (r.held_for_review) bits.push(`${r.held_for_review} possible match${r.held_for_review === 1 ? "" : "es"} held for review`);
  toast(bits.join(", "));
  closeModal();
  refreshAccounts().then(() => {
    if (onDone) return onDone(r);
    const content = document.getElementById("content");
    if (State.view === "import") renderView(content);
  });
}

// The review screen shared by the OFX and CSV imports. Every row has an
// "Add" tick. Rows with a hand-entered look-alike (same amount, nearby date,
// same first three letters of payee) also show that entry beside the bank row
// with a "Match" tick, on by default: ticked merges the bank row into your
// entry (yours wins), unticked adds it as a new transaction.
function openImportDetail(data, ctx) {
  const rowsData = data.transactions;
  const inc = [], mat = [], nodes = [], tags = [], statusCells = [];
  const catBtns = [], catId = [], catName = [];       // the category each row will get when it is added
  let catGroups = null;
  const getCats = async () => catGroups || (catGroups = await api("/categories"));
  const mobile = isMobile();
  const shortDate = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"});

  const counts = () => {
    let add = 0, match = 0;
    rowsData.forEach((t, i) => {
      if (!inc[i].checked) return;
      if (mat[i] && mat[i].checked) match++; else add++;
    });
    return {add, match};
  };
  const importBtn = el("button", {class: "btn"}, "");
  const updateLabel = () => {
    const {add, match} = counts();
    importBtn.textContent = match ? (add ? `Import ${add} new · match ${match}` : `Match ${match}`) : `Import ${add} selected`;
  };
  const refreshRow = (i) => {
    const t = rowsData[i];
    nodes[i].classList.toggle("imp-off", !inc[i].checked);
    if (catBtns[i]) catBtns[i].disabled = !inc[i].checked || !!(mat[i] && mat[i].checked);   // a matched row keeps its own entry's category
    if (t.possible_match && tags[i]) {
      const matched = mat[i].checked;
      tags[i].textContent = matched ? "will match" : "will add as new";
      tags[i].className = "tag imp-tag " + (matched ? "match" : "newrow");
      nodes[i].classList.toggle("imp-matched", matched);
    }
    updateLabel();
  };

  const statusNode = (t, i) => {
    if (t.duplicate) {
      return el("div", {},
        el("div", {style: "color:var(--red)"}, t.reason),
        t.matched ? el("div", {class: "help"},
          `↳ existing: ${t.matched.date} · ${t.matched.payee || "(no payee)"} · ${fmt(t.matched.amount)}`) : null);
    }
    const pm = t.possible_match;
    if (!pm) {
      return el("span", {class: "tag", style: "background:var(--green-bg);color:var(--green)"},
        t.reason === "Unreadable date" ? "unreadable date" : "new");
    }
    const apart = pm.days_apart === 0 ? "same day" : `${pm.days_apart} day${pm.days_apart === 1 ? "" : "s"} apart`;
    const cb = el("input", {type: "checkbox"});
    cb.checked = !pm.weak;   // a confident match starts ticked; a same-amount guess starts unticked
    cb.addEventListener("change", () => refreshRow(i));
    mat[i] = cb;
    const tag = el("span", {class: "tag imp-tag match"}, pm.weak ? "will add as new" : "will match");
    tags[i] = tag;
    return el("div", {class: "imp-match"},
      el("div", {class: "imp-match-head"}, tag,
        el("label", {class: "imp-match-tick"}, cb, " Match to your entry")),
      el("div", {class: "imp-yours"},
        el("div", {}, el("strong", {}, pm.transfer ? `Transfer : ${pm.transfer_account_name}` : (pm.payee || "(no payee)")), "  ", fmt(pm.amount)),
        el("div", {class: "help"}, `${shortDate(pm.date)}${pm.category_name ? " · " + pm.category_name : ""}${pm.memo ? " · " + pm.memo : ""}${pm.cleared === 2 ? " · Reconciled" : pm.cleared ? " · Cleared" : ""}`)),
      el("div", {class: "help"}, `${apart} · same amount · ` + ({
        transfer: "a transfer between your accounts",
        scheduled: "your unpaid scheduled bill — matching it marks it paid",
        alias: "you've matched this bank wording to this payee before",
        chosen: "you picked this entry",
        amount: "just a guess: same amount, nearby date — tick it if it's the same transaction",
      }[pm.how] || `both start “${pm.prefix}”`)));
  };

  // ---- matching by hand: list entries with exactly this amount near the bank row's date ----
  // Redraw a row's status after its match changed (picked, replaced or cleared).
  const renderStatus = (i) => {
    const t = rowsData[i];
    mat[i] = undefined; tags[i] = undefined;   // statusNode makes them again if there is a match
    statusCells[i].replaceChildren(...[statusNode(t, i), findLink(i)].filter(Boolean));
    nodes[i].classList.toggle("imp-matched", !!t.possible_match);
    refreshRow(i);
  };
  const findLink = (i) => {
    const t = rowsData[i];
    if (t.duplicate || t.reason === "Unreadable date") return null;
    const b = el("button", {type: "button", class: "imp-find"},
      t.possible_match ? "Choose a different entry…" : "Find a match…");
    b.addEventListener("click", () => openCandidates(i));
    return b;
  };
  const openCandidates = (i) => {
    const t = rowsData[i];
    const overlay = el("div", {class: "np-overlay"});
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    const daysInp = el("input", {type: "number", min: "0", max: "60", style: "width:64px; display:inline-block",
      value: String(ctx.dedupDays > 0 ? ctx.dedupDays : 3)});
    const list = el("div", {class: "imp-cands"});
    const label = (c) => c.transfer ? `Transfer : ${c.transfer_account_name}` : (c.payee || "(no payee)");
    const pick = (c) => {
      t.possible_match = {...c, how: "chosen", prefix: ""};
      close(); renderStatus(i);
    };
    const load = async () => {
      list.replaceChildren(el("div", {class: "help"}, "Looking…"));
      let found;
      try {
        found = await api("/import/match-candidates", {method: "POST", body: {
          account_id: ctx.accountId, amount: t.amount, date: t.date, days: Number(daysInp.value) || 0}});
      } catch (e) { list.replaceChildren(el("div", {class: "help"}, "Error: " + e.message)); return; }
      if (!found.length) {
        list.replaceChildren(el("div", {class: "empty"},
          `No entry with exactly ${fmt(t.amount)} within ${Number(daysInp.value) || 0} day(s) of ${shortDate(t.date)}. ` +
          "Try more days, or add this row as a new transaction."));
        return;
      }
      list.replaceChildren(...found.map((c) => {
        const user = rowsData.findIndex((r, k) => k !== i && r.possible_match && r.possible_match.id === c.id);
        const current = t.possible_match && t.possible_match.id === c.id;
        const badges = [
          c.cleared === 2 ? "Reconciled" : c.cleared ? "Cleared" : null,
          c.scheduled ? "Scheduled bill" : null].filter(Boolean);
        const btn = el("button", {type: "button", class: "btn sm" + (current ? " secondary" : ""),
          disabled: user >= 0 || current ? "disabled" : undefined}, current ? "Chosen" : user >= 0 ? "In use" : "Match");
        btn.addEventListener("click", () => pick(c));
        return el("div", {class: "imp-cand"},
          el("div", {class: "imp-cand-main"},
            el("div", {}, el("strong", {}, label(c)), "  ", fmt(c.amount),
              ...badges.map((b) => el("span", {class: "tag imp-tag", style: "margin-left:6px"}, b))),
            el("div", {class: "help"}, [shortDate(c.date),
              c.days_apart === 0 ? "same day" : `${c.days_apart} day${c.days_apart === 1 ? "" : "s"} apart`,
              c.category_name, c.memo].filter(Boolean).join(" · ")),
            user >= 0 ? el("div", {class: "help"}, `Already matched to the bank row on ${rowsData[user].date} (${rowsData[user].payee || "no payee"}).`) : null),
          btn);
      }));
    };
    daysInp.addEventListener("change", load);
    overlay.append(el("div", {class: "np-sheet imp-cand-sheet"},
      el("div", {class: "np-title"}, "Match to one of your entries"),
      el("div", {class: "help", style: "margin:6px 0 8px"},
        `Bank row: ${t.payee || "(no payee)"} · ${fmt(t.amount)} · ${shortDate(t.date)}`),
      el("div", {style: "margin-bottom:8px"}, "Entries with exactly this amount within ±", daysInp, " days"),
      list,
      el("div", {class: "np-foot"},
        t.possible_match ? el("button", {class: "btn ghost", onclick: () => { t.possible_match = null; close(); renderStatus(i); }},
          "Don't match this row") : null,
        el("div", {style: "flex:1"}),
        el("button", {class: "btn secondary", onclick: close}, "Cancel"))));
    document.body.append(overlay);
    load();
  };

  const paintCat = (i) => {
    catBtns[i].textContent = catName[i] || "Uncategorized";
    catBtns[i].classList.toggle("imp-cat-empty", !catName[i]);
  };
  const catButton = (t, i) => {
    const s = t.suggested_category;
    catId[i] = s ? s.id : null;
    catName[i] = s ? s.name : null;
    const b = el("button", {type: "button", class: "imp-cat",
      title: s ? `Used for ${s.seen} of ${s.of} earlier transactions with this payee` : "Choose a category"});
    b.addEventListener("click", async () => {
      openCategoryPicker(await getCats(), catId[i], (id, name) => { catId[i] = id || null; catName[i] = id ? name : null; paintCat(i); });
    });
    catBtns[i] = b;
    paintCat(i);
    return b;
  };
  const buildRow = (t, i) => {
    const cb = el("input", {type: "checkbox"});
    cb.checked = !t.duplicate && t.reason !== "Unreadable date";   // new + possible-match rows default in
    cb.addEventListener("change", () => refreshRow(i));
    inc[i] = cb;
    const statusEl = el(mobile ? "div" : "td", mobile ? {class: "imp-card-status"} : {});
    statusCells[i] = statusEl;
    statusEl.replaceChildren(...[statusNode(t, i), findLink(i)].filter(Boolean));
    const cls = t.duplicate ? "imp-dup" : (t.possible_match && !t.possible_match.weak) ? "imp-matched" : "";
    if (mobile) {
      return el("div", {class: "imp-card " + cls},
        el("div", {class: "imp-card-top"}, cb,
          el("div", {class: "imp-card-main"},
            el("div", {class: "imp-card-line"}, el("span", {class: "imp-payee"}, t.payee || "(no payee)"),
              el("span", {class: "num " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount))),
            el("div", {class: "help"}, `${t.date ? shortDate(t.date) : "—"}${t.memo ? " · " + t.memo : ""}`),
            t.duplicate ? null : el("div", {style: "margin-top:4px"}, catButton(t, i)))),
        statusEl);
    }
    return el("tr", {class: cls},
      el("td", {}, cb),
      el("td", {style: "white-space:nowrap"}, t.date || "—"),
      el("td", {}, t.payee || ""),
      el("td", {class: "memo"}, t.memo || ""),
      el("td", {}, t.duplicate ? "" : catButton(t, i)),
      el("td", {class: "num " + (t.amount < 0 ? "out" : "in"), style: "white-space:nowrap"}, fmt(t.amount)),
      statusEl);
  };
  rowsData.forEach((t, i) => { nodes[i] = buildRow(t, i); });

  const setInc = (fn) => { rowsData.forEach((t, i) => { inc[i].checked = fn(t, i); refreshRow(i); }); };
  const setMatches = (on, weak = false) => { rowsData.forEach((t, i) => {
    if (mat[i] && !!t.possible_match.weak === weak) { mat[i].checked = on; refreshRow(i); } }); };

  const list = mobile
    ? el("div", {class: "imp-cards"}, ...nodes)
    : el("table", {class: "register"},
        el("thead", {}, el("tr", {},
          el("th", {}, "Add"), el("th", {}, "Date"), el("th", {}, "Payee"),
          el("th", {}, "Memo"), el("th", {}, "Category"), el("th", {class: "num"}, "Amount"), el("th", {}, "Status / match"))),
        el("tbody", {}, ...nodes));

  const summary = [`${data.new_count} new`];
  if (data.match_count) summary.push(`${data.match_count} possible match${data.match_count === 1 ? "" : "es"}`);
  if (data.weak_count) summary.push(`${data.weak_count} with a same-amount entry nearby (unticked — tick to match)`);
  summary.push(`${data.duplicate_count} flagged duplicate`);
  const body = el("div", {},
    el("div", {class: "toolbar", style: "margin-bottom:10px"},
      el("span", {class: "help"}, summary.join(" · ") + ". " +
        (data.match_count ? "Check each possible match below; untick “Match” to add it as a new transaction instead. " : "") +
        "Rows that have an entry with the same amount nearby show it unticked: tick “Match to your entry” to merge them. " +
        "“Find a match…” lists more candidates. " +
        "Tick any flagged duplicate to import it anyway."),
      el("div", {class: "grow"}),
      el("button", {class: "btn secondary sm", onclick: () => setInc(() => true)}, "Select all"),
      el("button", {class: "btn secondary sm", onclick: () => setInc(() => false)}, "Select none"),
      el("button", {class: "btn secondary sm", onclick: () => setInc((t) => !t.duplicate && !t.possible_match && t.reason !== "Unreadable date")}, "New only"),
      data.match_count ? el("button", {class: "btn secondary sm", onclick: () => setMatches(true)}, "Matches on") : null,
      data.match_count ? el("button", {class: "btn secondary sm", onclick: () => setMatches(false)}, "Matches off") : null,
      data.weak_count ? el("button", {class: "btn secondary sm", title: "Tick every same-amount guess", onclick: () => setMatches(true, true)}, "Guesses on") : null,
      data.weak_count ? el("button", {class: "btn secondary sm", onclick: () => setMatches(false, true)}, "Guesses off") : null),
    el("div", {class: "imp-scroll"}, list));

  importBtn.addEventListener("click", async () => {
    const indices = [], matches = {}, categories = {};
    rowsData.forEach((t, i) => {
      if (!inc[i].checked) return;
      indices.push(t.index);
      if (mat[i] && mat[i].checked) matches[t.index] = t.possible_match.id;
      else categories[t.index] = catId[i] || null;          // what the review screen shows is what gets saved
    });
    if (!indices.length) return toast("Nothing selected", true);
    try { afterImport(await ctx.submit(indices, matches, categories), ctx.onDone); }
    catch (e) { toast(e.message, true); }
  });

  const bg = modal({title: "Review import", bodyNode: body, wide: true,
    footNode: [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"), importBtn]});
  const m = bg.querySelector(".modal");
  m.style.maxWidth = "1040px";
  rowsData.forEach((t, i) => refreshRow(i));
}

// -------------------- one dropped file --------------------
// Works out what the file is and builds the card(s) for it.
async function fileSection(file, ctx) {
  const body = el("div", {});
  const box = el("div", {class: "imp-file"},
    el("div", {class: "imp-file-head"}, el("strong", {}, file.name),
      el("button", {class: "set-menu-btn", title: "Remove from this list", onclick: () => box.remove()}, "✕")), body);
  try {
    const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (magic[0] === 0x50 && magic[1] === 0x4b) { body.append(actualCard(file, ctx)); return box; }   // "PK": a zip
    const text = await file.text();
    const det = await api("/import/detect", {method: "POST", body: {text}});
    if (det.kind === "ofx") {
      if (!det.statements.length) body.append(el("div", {class: "empty"}, "That QFX/OFX file doesn't contain any account statements."));
      det.statements.forEach((st) => body.append(ofxCard(text, st, det.statements.length > 1, ctx)));
    } else if (det.kind === "csv") {
      body.append(csvCard(text, det, ctx));
    } else {
      body.append(el("div", {class: "empty"}, "I couldn't tell what kind of file this is. It should be a QFX, OFX or CSV file from your bank."));
    }
  } catch (e) { body.append(el("div", {class: "help"}, "Error: " + e.message)); }
  return box;
}

// Shown on a card once it has been imported.
function importedNote(r) {
  const bits = [`Imported ${r.imported}`];
  if (r.matched) bits.push(`matched ${r.matched}`);
  if (r.skipped_duplicates) bits.push(`skipped ${r.skipped_duplicates} duplicate${r.skipped_duplicates === 1 ? "" : "s"}`);
  if (r.skipped) bits.push(`${r.skipped} unreadable`);
  if (r.held_for_review) bits.push(`${r.held_for_review} possible match${r.held_for_review === 1 ? "" : "es"} held back`);
  return el("div", {class: "imp-done"}, "✓ " + bits.join(", "),
    r.imported ? el("button", {class: "btn secondary sm", style: "margin-left:12px",
      onclick: () => navGo("verify", {accountId: null})}, "Verify categories →") : null);
}

// -------------------- Verify: the imported transactions that haven't been checked yet --------------------
async function renderVerify(root) {
  root.append(el("h2", {style: "margin:0 0 4px"}, "Verify imported transactions"),
    el("p", {class: "help", style: "margin-top:0"},
      "These came in through an import. Check each category (click it to change it), then tick it off. " +
      "Changing a category counts as checking it."));
  const bar = el("div", {class: "toolbar"});
  const list = el("div", {class: "verify-list"});
  root.append(bar, list);
  let groups = null, rows = [];
  try { [rows, groups] = await Promise.all([api("/transactions/review"), api("/categories")]); }
  catch (e) { list.append(el("div", {class: "empty"}, "Couldn't load: " + e.message)); return; }

  const repaint = () => {
    bar.replaceChildren(el("strong", {}, `${rows.length} to verify`), el("div", {class: "grow"}),
      rows.length ? el("button", {class: "btn", onclick: async () => {
        try { await api("/transactions/review/clear", {method: "POST", body: {}}); rows = []; repaint(); updateSidebarBalances(); }
        catch (e) { toast(e.message, true); }
      }}, "Mark all verified") : null);
    if (!rows.length) { list.replaceChildren(el("div", {class: "empty"}, "Nothing to verify. 🎉")); return; }
    list.replaceChildren(...rows.map((t) => {
      const cat = el("button", {type: "button", class: "imp-cat" + (t.category_name ? "" : " imp-cat-empty")},
        t.category_name || "Uncategorized");
      cat.addEventListener("click", () => openCategoryPicker(groups, t.category_id, async (id) => {
        try {
          await api(`/transactions/${t.id}`, {method: "PUT", body: {category_id: id || null, version: t.version}});
          rows = rows.filter((x) => x.id !== t.id);       // changing the category counts as checking it
          repaint(); updateSidebarBalances();
        } catch (e) { toast(e.message, true); }
      }));
      const ok = el("button", {type: "button", class: "btn secondary sm", title: "The category is right",
        onclick: async () => {
          try { await api("/transactions/review/clear", {method: "POST", body: {ids: [t.id]}});
            rows = rows.filter((x) => x.id !== t.id); repaint(); updateSidebarBalances(); }
          catch (e) { toast(e.message, true); }
        }}, "✓ Verified");
      return el("div", {class: "verify-row"},
        el("div", {class: "verify-main"},
          el("div", {class: "verify-top"}, el("span", {class: "verify-payee"}, t.payee || "(no payee)"),
            el("span", {class: "num " + (t.amount < 0 ? "out" : "in")}, fmt(t.amount, {plus: true}))),
          el("div", {class: "help"}, `${t.date} · ${t.account_name || ""}${t.memo ? " · " + t.memo : ""}`)),
        el("div", {class: "verify-actions"}, cat, ok));
    }));
  };
  repaint();
}

// -------------------- QFX / OFX: one card per account statement in the file --------------------
function ofxCard(text, st, several, ctx) {
  const kind = st.kind === "card" ? "credit card" : st.kind === "investment" ? "investment account"
    : (st.acct_type ? st.acct_type.toLowerCase() : "account");
  const dates = st.first ? ` · ${st.first}${st.last !== st.first ? " to " + st.last : ""}` : "";
  const sel = accountSelect(st.account_id || st.suggested_id);
  const note = el("div", {class: "help"});
  const preview = el("div", {});
  const card = el("div", {class: "imp-card-block"});
  const paintNote = () => {
    const changed = st.account_id && sel.value && Number(sel.value) !== st.account_id;
    if (changed) { note.className = "help"; note.textContent = "This changes which account this bank account is linked to."; }
    else if (st.account_id) { note.className = "help imp-ok"; note.textContent = "✓ Recognized from the file's bank details."; }
    else if (st.suggested_id) { note.className = "help"; note.textContent = `I think this is the account selected, because ${st.suggested_why}. Please check, then it's remembered for next time.`; }
    else { note.className = "help"; note.textContent = "New to me: choose which of your accounts this is, and I'll recognize it next time."; }
  };
  const done = (r) => {
    preview.replaceChildren(importedNote(r));
    sel.disabled = true;
    ctx.refreshRecent();
  };
  const run = async () => {
    preview.replaceChildren();
    paintNote();
    if (!sel.value) { preview.append(el("div", {class: "help"}, "Choose an account to continue.")); return; }
    const base = {text, account_id: Number(sel.value), dedup_days: ctx.dedupDays(), stmt: st.stmt,
      auto_categorize: ctx.autoCat()};
    let data;
    try { data = await api("/import/ofx/preview", {method: "POST", body: base}); }
    catch (e) { preview.append(el("div", {class: "help"}, "Error: " + e.message)); return; }
    if (!data.total) { preview.append(el("div", {class: "empty"}, "No transactions in this part of the file.")); return; }
    const rctx = {text, accountId: base.account_id, dedupDays: base.dedup_days, onDone: done,
      submit: (indices, matches, categories) => api("/import/ofx", {method: "POST", body: {...base, indices, matches, categories}})};
    preview.append(...[
      el("div", {class: "help", style: "margin:10px 0"}, `${data.total} transactions: `,
        el("strong", {style: "color:var(--green)"}, `${data.new_count} new`), ", ",
        data.match_count ? [el("strong", {style: "color:var(--yellow)"}, `${data.match_count} possible match${data.match_count === 1 ? "" : "es"}`), ", "] : null,
        el("strong", {style: "color:var(--muted)"}, `${data.duplicate_count} flagged as duplicate`)),
      el("div", {class: "toolbar"},
        el("button", {class: "btn", onclick: () => openImportDetail(data, rctx)},
          data.match_count ? `Review ${data.match_count} possible match${data.match_count === 1 ? "" : "es"} & choose…` : "Review & choose transactions…"),
        data.new_count ? el("button", {class: "btn secondary", onclick: async () => {
          try { const r = await api("/import/ofx", {method: "POST", body: base}); await refreshAccounts(); toast(`Imported ${r.imported}`); done(r); }
          catch (e) { toast(e.message, true); }
        }}, `Quick import ${data.new_count} new`) : null),
      data.match_count ? el("div", {class: "help"}, "Quick import leaves possible matches out so nothing is duplicated or merged without you looking.") : null].filter(Boolean));
  };
  sel.addEventListener("change", run);
  card.append(...[
    el("div", {class: "imp-card-title"}, el("span", {class: "tag"}, "QFX / OFX"), " ",
      `${st.org ? st.org + " · " : ""}${kind}${st.hint ? " ending " + st.hint : ""} · ${st.count} transaction${st.count === 1 ? "" : "s"}${dates}`),
    st.kind === "investment" ? el("div", {class: "help"}, "Only the cash transactions in an investment file are imported; buys, sells and holdings aren't.") : null,
    el("label", {class: "field"}, el("span", {}, "Import into account"), sel), note, preview].filter(Boolean));
  run();
  return card;
}

// -------------------- CSV: you choose the account, then map the columns --------------------
function csvCard(csvText, info, ctx) {
  const card = el("div", {class: "imp-card-block"});
  const sel = accountSelect(null);          // a CSV doesn't say which account it is for: the person must choose
  const mapArea = el("div", {});
  const colSelect = (includeBlank) => {
    const s = el("select", {});
    if (includeBlank) s.append(el("option", {value: ""}, "— none —"));
    info.headers.forEach((h, i) => s.append(el("option", {value: h}, h || `Column ${i + 1}`)));
    return s;
  };
  const guess = (s, needles) => {
    const i = info.headers.findIndex((h) => needles.some((n) => (h || "").toLowerCase().includes(n)));
    if (i >= 0) s.value = info.headers[i];
  };
  const dateSel = colSelect(false); guess(dateSel, ["date"]);
  const payeeSel = colSelect(true); guess(payeeSel, ["payee", "description", "name", "merchant"]);
  const memoSel = colSelect(true); guess(memoSel, ["memo", "note"]);
  const amountSel = colSelect(true); guess(amountSel, ["amount"]);
  const outSel = colSelect(true); guess(outSel, ["debit", "withdrawal", "outflow"]);
  const inSel = colSelect(true); guess(inSel, ["credit", "deposit", "inflow"]);
  const invert = el("input", {type: "checkbox"});
  const single = el("div", {}, el("label", {class: "field"}, el("span", {}, "Amount (single signed column)"), amountSel),
    el("label", {}, invert, " Negative numbers are inflows (invert sign)"));
  const split = el("div", {style: "display:none"},
    el("label", {class: "field"}, el("span", {}, "Outflow / Debit column"), outSel),
    el("label", {class: "field"}, el("span", {}, "Inflow / Credit column"), inSel));
  const modeSel = el("select", {},
    el("option", {value: "single"}, "One signed Amount column"),
    el("option", {value: "split"}, "Separate Outflow / Inflow columns"));
  modeSel.addEventListener("change", () => {
    single.style.display = modeSel.value === "single" ? "block" : "none";
    split.style.display = modeSel.value === "split" ? "block" : "none";
  });
  // A header-less guess for the common case where debit and credit are separate columns.
  if (!amountSel.value && (outSel.value || inSel.value)) { modeSel.value = "split"; modeSel.dispatchEvent(new Event("change")); }

  const result = el("div", {class: "help", style: "margin-top:8px"});
  const mapping = () => {
    const m = {account_id: Number(sel.value), headers: info.headers, skip_header: true,
      date: dateSel.value, payee: payeeSel.value, memo: memoSel.value, dedup_days: ctx.dedupDays()};
    if (modeSel.value === "single") { m.amount = amountSel.value; m.invert = invert.checked; }
    else { m.outflow = outSel.value; m.inflow = inSel.value; }
    return m;
  };
  const done = (r) => {
    result.replaceChildren(importedNote(r));
    for (const b of buttons) b.hidden = true;
    sel.disabled = true;
    ctx.refreshRecent();
  };
  const review = el("button", {class: "btn", disabled: true, onclick: async () => {
    const m = mapping();
    let data;
    try { data = await api("/import/csv/preview", {method: "POST", body: {text: csvText, mapping: m, auto_categorize: ctx.autoCat()}}); }
    catch (e) { return toast(e.message, true); }
    if (!data.total) return toast("No rows found in that file", true);
    openImportDetail(data, {accountId: m.account_id, dedupDays: m.dedup_days, onDone: done,
      submit: (indices, matches, categories) => api("/import/csv", {method: "POST", body: {text: csvText, mapping: m, indices, matches, categories, auto_categorize: ctx.autoCat()}})});
  }}, "Review & choose…");
  const quick = el("button", {class: "btn secondary", disabled: true, onclick: async () => {
    try {
      const r = await api("/import/csv", {method: "POST", body: {text: csvText, mapping: mapping(), auto_categorize: ctx.autoCat()}});
      await refreshAccounts(); toast(`Imported ${r.imported} transactions`); done(r);
    } catch (e) { toast(e.message, true); }
  }}, "Import without review");
  const buttons = [review, quick];
  sel.addEventListener("change", () => { for (const b of buttons) b.disabled = !sel.value; });

  mapArea.append(
    el("div", {class: "help", style: "margin:6px 0"}, `${info.total} rows detected. Map the columns:`),
    el("label", {class: "field"}, el("span", {}, "Date column"), dateSel),
    el("label", {class: "field"}, el("span", {}, "Payee column"), payeeSel),
    el("label", {class: "field"}, el("span", {}, "Memo column"), memoSel),
    el("label", {class: "field"}, el("span", {}, "Amount format"), modeSel),
    single, split);
  card.append(
    el("div", {class: "imp-card-title"}, el("span", {class: "tag"}, "CSV"), ` ${info.total} rows`),
    el("div", {class: "help"}, "A CSV file doesn't say which account it's from, so choose one."),
    el("label", {class: "field"}, el("span", {}, "Import into account"), sel),
    mapArea,
    el("div", {class: "toolbar", style: "margin-top:8px"}, review, quick), result);
  return card;
}

// -------------------- Actual Budget export (.zip) --------------------
function actualCard(file, ctx) {
  const status = el("div", {class: "help", style: "margin-top:10px"});
  const btn = el("button", {class: "btn", onclick: async () => {
    status.textContent = "Importing… this can take a moment.";
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api("/import/actual", {method: "POST", form: fd});
      status.textContent = `Imported ${r.accounts} accounts, ${r.categories} categories, ${r.transactions} transactions, ${r.budgets} budget entries, ${r.carryover_events} carryover settings, ${r.scheduled} scheduled transactions` +
        (r.scheduled_skipped ? ` (${r.scheduled_skipped} schedules couldn't be represented and were skipped).` : ".");
      btn.hidden = true;
      toast("Actual Budget import complete");
      await refreshAccounts();
    } catch (e) { status.textContent = "Error: " + e.message; toast(e.message, true); }
  }}, "Import Actual export");
  return el("div", {class: "imp-card-block"},
    el("div", {class: "imp-card-title"}, el("span", {class: "tag"}, "Actual Budget export")),
    el("div", {class: "callout", style: "margin:10px 0 14px"},
      el("strong", {}, "This can't be undone. "),
      "A full budget import brings in whole accounts, categories and budgets; the Undo list below only removes imported transactions, not those. The clean way to try it: import into a separate budget (Close Budget, then “+ New Budget”), and if you don't like the result, delete that whole budget from the picker."),
    btn, status,
    el("div", {class: "help", style: "margin-top:12px"},
      "Tip: accounts whose name contains “credit”, “visa”, “card”, etc. are imported as credit cards."));
}
