/* Settings: preferences, categories, accounts, calendar reminders, and data tools —
   organised into tabs, with touch-friendly tap lists. */
"use strict";

async function renderSettings(root) {
  root.append(el("div", {class: "empty"}, "Loading…"));
  let groups, prefs;
  try { [groups, prefs] = await Promise.all([api("/categories"), api("/preferences")]); }
  catch (e) { root.innerHTML = ""; root.append(el("div", {class: "empty"}, "Error: " + e.message)); return; }
  root.innerHTML = "";

  // ---- Page scaffold: title, tab bar, one pane per tab ----
  const TABS = [
    ["general", "General", "⚙"], ["categories", "Categories", "▤"], ["accounts", "Accounts", "🏦"],
    ["autofill", "Auto-fill", "✨"], ["calendar", "Calendar", "📅"], ["data", "Data & Backup", "💾"]];
  const pane = {};
  for (const [key] of TABS) pane[key] = el("div", {class: "set-pane"});
  const secTitle = (text, sub, extra = "") => el("div", {class: "set-sec " + extra},
    el("div", {class: "set-sec-title"}, text), sub ? el("div", {class: "help"}, sub) : null);
  const tabBtns = {};
  const showTab = (key) => {
    if (!pane[key]) key = "general";
    setPref("settingsTab", key);
    for (const [k] of TABS) {
      pane[k].style.display = k === key ? "" : "none";
      tabBtns[k].classList.toggle("active", k === key);
    }
  };
  const tabBar = el("div", {class: "set-tabs", role: "tablist"});
  for (const [key, label, icon] of TABS) {
    tabBtns[key] = el("button", {class: "set-tab", role: "tab", onclick: () => showTab(key)},
      el("span", {class: "set-tab-ico"}, icon), el("span", {}, label));
    tabBar.append(tabBtns[key]);
  }
  root.append(el("div", {class: "set-wrap"},
    el("div", {class: "set-page-head"}, el("h2", {}, "Settings"),
      el("div", {class: "help"}, State.budgetName || "")),
    tabBar, ...TABS.map(([k]) => pane[k])));
  showTab(getPref("settingsTab", "general"));
  renderAutofill(pane.autofill, groups);

  // ---- General: three cards instead of one long list ----
  const appearanceCard = el("div", {class: "card set-group"});
  const registerCard = el("div", {class: "card set-group"});
  const schedCard = el("div", {class: "card set-group"});
  const dayPos = getPref("dayHeaderPos", "below");
  const seg = el("div", {class: "seg"});
  const segBtn = (val, label) => {
    const btn = el("button", {class: "seg-btn" + (dayPos === val ? " active" : "")}, label);
    btn.addEventListener("click", () => { setPref("dayHeaderPos", val); navGo("settings"); });
    return btn;
  };
  seg.append(segBtn("above", "Above"), segBtn("below", "Below"));
  registerCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Day divider position"),
      el("div", {class: "help"}, "Show each day's date above or below its transactions")),
    seg));

  const dueSoonInput = el("input", {type: "number", min: "0", max: "60",
    value: prefs.due_soon_days, style: "width:70px; text-align:center"});
  dueSoonInput.addEventListener("change", async () => {
    const days = Math.max(0, Math.min(60, parseInt(dueSoonInput.value, 10) || 0));
    dueSoonInput.value = days;
    try { await api("/preferences", {method: "POST", body: {due_soon_days: days}}); toast("Saved"); }
    catch (e) { toast(e.message, true); }
  });
  schedCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Due soon within (days)"),
      el("div", {class: "help"}, "Scheduled transactions turn “Due Soon” and get entered into the register this many days before they're due")),
    dueSoonInput));

  // Account new transactions are added to by default (mobile "Add Transaction").
  const defAcct = el("select", {style: "max-width:200px"},
    el("option", {value: ""}, "None (use last used)"),
    ...State.accounts.filter((a) => !a.closed).map((a) => el("option", {value: a.id}, a.name)));
  defAcct.value = getPref("defaultAccount", "");
  if (defAcct.value !== getPref("defaultAccount", "")) defAcct.value = "";   // that account was closed/removed
  defAcct.addEventListener("change", () => { setPref("defaultAccount", defAcct.value); toast("Saved on this device"); });
  registerCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Default account"),
      el("div", {class: "help"}, "New transactions start in this account (this device only)")),
    defAcct));

  const fontPos = getPref("fontSize", "medium");
  const fseg = el("div", {class: "seg"});
  const fBtn = (val, label) => {
    const btn = el("button", {class: "seg-btn" + (fontPos === val ? " active" : "")}, label);
    btn.addEventListener("click", () => { setPref("fontSize", val); applyPrefs(); navGo("settings"); });
    return btn;
  };
  fseg.append(fBtn("small", "Small"), fBtn("medium", "Medium"), fBtn("large", "Large"));
  appearanceCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Register text size"),
      el("div", {class: "help"}, "Font size of transaction rows")),
    fseg));

  const bf = budgetFontPx();
  const bfVal = el("strong", {}, bf + " px");
  const bfSlider = el("input", {type: "range", min: BUD_FONT_MIN, max: BUD_FONT_MAX, step: 1, value: bf,
    style: "width:160px; accent-color: var(--accent)"});
  bfSlider.addEventListener("input", () => {
    setPref("budFont", bfSlider.value); applyPrefs();
    bfVal.textContent = bfSlider.value + " px";
  });
  appearanceCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Budget text size"),
      el("div", {class: "help"}, "All the text on the Budget screen (this device only)")),
    el("div", {style: "display:flex; align-items:center; gap:10px"}, bfSlider, bfVal,
      el("button", {class: "btn secondary sm", style: "width:auto", onclick: () => {
        setPref("budFont", String(BUD_FONT_DEFAULT)); applyPrefs(); navGo("settings"); }}, "Reset"))));

  const densPos = getPref("density", "cozy");
  const dseg = el("div", {class: "seg"});
  const dBtn = (val, label) => {
    const btn = el("button", {class: "seg-btn" + (densPos === val ? " active" : "")}, label);
    btn.addEventListener("click", () => { setPref("density", val); applyPrefs(); navGo("settings"); });
    return btn;
  };
  dseg.append(dBtn("compact", "Compact"), dBtn("cozy", "Cozy"), dBtn("comfortable", "Comfortable"));
  appearanceCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Row density"),
      el("div", {class: "help"}, "Vertical spacing of transaction rows")),
    dseg));
  pane.general.append(
    secTitle("Appearance", "How the registers look"), appearanceCard,
    secTitle("Registers", "Where new transactions go and how days are grouped"), registerCard,
    secTitle("Scheduled transactions", "When a bill counts as “due soon”"), schedCard);

  // ---- Calendar reminders: a private feed your phone's calendar subscribes to ----
  pane.calendar.append(secTitle("Calendar reminders", "Put your scheduled transactions on your phone's calendar, with alerts"));
  const calCard = el("div", {class: "card set-group"});
  const calBody = el("div", {class: "pref-row", style: "flex-direction:column; align-items:stretch; gap:10px"});
  calCard.append(calBody);
  pane.calendar.append(calCard);
  // Has a calendar app actually fetched the feed? (the first thing to check when
  // events don't show up)
  const fetchStatus = (last) => {
    if (!last || !last.last_fetch)
      return el("div", {class: "help", style: "color:var(--red)"},
        "Not fetched yet — no calendar has reached this link. If you've subscribed, the phone can't reach this address.");
    const mins = Math.max(0, Math.round((Date.now() - new Date(last.last_fetch).getTime()) / 60000));
    const ago = mins < 1 ? "just now" : mins < 90 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
    return el("div", {class: "help"}, `Last fetched ${ago}` + (last.last_count ? ` · ${last.last_count} entries` : "") +
      (last.last_agent ? ` · by ${last.last_agent}` : ""));
  };
  const paintCalendar = (path, alertDays, headsup = true, last = {}, daily = false) => {
    const https = location.origin + path;
    const webcal = https.replace(/^https?:/, "webcal:");
    const linkBox = el("input", {type: "text", readonly: "readonly", value: https, style: "font-size:12px",
      onfocus: (e) => e.target.select()});
    const copy = async () => {
      try { await navigator.clipboard.writeText(https); toast("Link copied"); }
      catch { linkBox.focus(); linkBox.select(); toast("Press and hold the link to copy it"); }
    };
    const reset = async () => {
      if (!confirm("Make a new link? The current one stops working, and any calendar using it must subscribe again.")) return;
      try { const r = await api("/calendar-feed/reset", {method: "POST"}); paintCalendar(r.path, alertDays, headsup, {}, daily); toast("New link created"); }
      catch (e) { toast(e.message, true); }
    };
    // What "subscribe" means differs by device, so detect it and show matching steps.
    const ua = navigator.userAgent || "";
    const platform = /android/i.test(ua) ? "android"
      : (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) ? "ios" : "other";
    const standalone = navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    const steps = (...items) => el("ol", {style: "padding-left:20px; line-height:1.7"}, ...items.map((t) => el("li", {}, t)));
    const help = (title, body, extraBtn = null) => modal({title, bodyNode: el("div", {}, ...body),
      footNode: [extraBtn, el("div", {style: "flex:1"}), el("button", {class: "btn", onclick: closeModal}, "Got it")]});
    // One-off file (works without subscribing); show how to import it afterwards.
    const downloadBtn = el("a", {class: "btn secondary", href: "/api/calendar-feed/file",
      download: "my-nab-bills.ics", style: "text-decoration:none"}, "Download calendar file");
    downloadBtn.addEventListener("click", () => setTimeout(() => {
      const body = platform === "ios"
        ? [el("p", {style: "margin-top:0"}, "The file is downloading. Then:"),
           steps("Open the downloaded file (Safari's download button, or the Files app)", "Tap “Add All” and pick a calendar")]
        : [el("p", {style: "margin-top:0"}, "The file is downloading. To import it into Google Calendar:"),
           el("strong", {}, "On a computer, or Chrome's “Desktop site” on the phone"),
           steps("Open calendar.google.com", "Settings (gear) → Import & export", "Select the file, choose the calendar, then Import"),
           el("strong", {}, "Or on the phone"),
           steps("Open the downloaded file from the Downloads notification or the Files app, and choose Calendar"),
           el("div", {class: "help"}, "The phone route can add only one entry at a time depending on your phone; the website imports them all.")];
      help("Import the calendar file", [...body,
        el("div", {class: "help", style: "margin-top:10px"}, "To refresh later (e.g. after paying a bill), download and import again.")]);
    }, 400));
    const subscribeBtn = el("a", {class: "btn", href: webcal, style: "text-decoration:none"}, "Subscribe on this device");
    subscribeBtn.addEventListener("click", async (e) => {
      if (platform === "ios" && !standalone) return;   // Safari opens the subscribe prompt itself
      e.preventDefault();
      await copy();
      if (platform === "ios") {
        // The home-screen app can't open calendar links, so go through Settings.
        help("Subscribe in Calendar", [el("p", {style: "margin-top:0"}, "The link is copied. To finish on this iPhone:"),
          steps("Open the iPhone Settings app", "iOS 18 or newer: Apps → Calendar → Calendar Accounts. Older iOS: Calendar → Accounts",
            "Add Account → Other → Add Subscribed Calendar", "Paste the link into Server, tap Next, then Save"),
          el("div", {class: "help"}, "Or in the Calendar app: Calendars → Add Calendar → Add Subscription Calendar."),
          el("div", {class: "help"}, "Or open My NAB in Safari instead of the home-screen icon and tap Subscribe again.")]);
      } else if (platform === "android") {
        // The Google Calendar app can't add a calendar by link; a free helper app can.
        help("Calendar on Android", [el("p", {style: "margin-top:0"}, "The link is copied. Easiest with only Google apps: download the file and import it (below). Google Calendar can't subscribe from the phone, and subscribing from its website only works if Google can reach this app over the internet."),
          el("strong", {}, "Option 1 — download and import (no subscribing)"),
          steps("Tap “Download calendar file” in this card", "Import it into Google Calendar (steps shown after the download)"),
          el("div", {class: "help", style: "margin-bottom:12px"}, "A snapshot: download and import again later to update. Importing again overwrites the same entries (paid bills turn into “✓ Paid”) but can't delete ones you removed."),
          el("strong", {}, "Option 2 — on this phone (free app)"),
          steps("Install “ICSx⁵” from the Play Store or F-Droid", "Open it, tap +, paste the link, and tap Subscribe",
            "Allow calendar access when asked; tick the calendar to show it"),
          el("div", {class: "help", style: "margin-bottom:12px"}, "Alerts come through to Google Calendar as event reminders."),
          el("strong", {}, "Option 3 — Google Calendar website (needs this app reachable from the internet)"),
          steps("On a computer (or “Desktop site” in Chrome), open calendar.google.com",
            "Other calendars → + → From URL, paste the link, Add calendar",
            "It then appears on your phone. Google ignores alerts inside feeds, so set that calendar's notifications in Google Calendar")],
          el("a", {class: "btn secondary", href: webcal, style: "text-decoration:none"}, "Open in ICSx⁵"));
      } else {
        help("Subscribe in your calendar", [el("p", {style: "margin-top:0"}, "The link is copied. In your calendar app, add a calendar “from URL” / “subscribe” and paste it."),
          el("div", {class: "help"}, "Google Calendar: Other calendars → + → From URL. Outlook: Add calendar → Subscribe from web. Apple Calendar: File → New Calendar Subscription.")]);
      }
    });
    calBody.replaceChildren(
      el("div", {}, el("div", {}, "Get a calendar alert for every scheduled transaction"),
        el("div", {class: "help"}, `Each unpaid scheduled transaction appears on your calendar` +
          (alertDays > 0 ? ` with an alert ${alertDays} day${alertDays === 1 ? "" : "s"} before it's due (your “Due soon” setting) and another on the due day` : ` with an alert on the due day`) +
          `, at 9 AM. Paying it removes it. Your calendar refreshes the feed every few hours, so changes aren't instant.`)),
      el("div", {class: "btn-row", style: "display:flex; gap:8px; flex-wrap:wrap"},
        subscribeBtn,
        downloadBtn,
        el("button", {class: "btn secondary", onclick: copy}, "Copy link"),
        el("button", {class: "btn secondary", onclick: reset}, "Make new link")),
      linkBox,
      fetchStatus(last),
      alertDays > 0 ? el("label", {class: "cal-opt", style: "display:flex; gap:10px; align-items:flex-start"},
        el("input", {type: "checkbox", checked: headsup ? "checked" : undefined, style: "margin-top:3px",
          onchange: async (e) => {
            try { await api("/calendar-feed/options", {method: "POST", body: {headsup: e.target.checked}}); toast("Saved"); }
            catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
          }}),
        el("span", {}, "Add a “Coming up” entry ", el("strong", {}, `${alertDays} day${alertDays === 1 ? "" : "s"} before`),
          " each due date, with its own 9 AM alert (recommended)")) : null,
      el("label", {class: "cal-opt", style: "display:flex; gap:10px; align-items:flex-start"},
        el("input", {type: "checkbox", checked: daily ? "checked" : undefined, style: "margin-top:3px",
          onchange: async (e) => {
            try { await api("/calendar-feed/options", {method: "POST", body: {daily: e.target.checked}}); toast("Saved"); }
            catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
          }}),
        el("span", {}, "Remind me every day until it's paid", el("div", {class: "help"},
          "An alert each morning from the “Due soon” window up to the due day, and every morning while a bill is Past Due. " +
          "Bills you pay stop alerting the next time your calendar refreshes."))),
      el("div", {class: "help"}, "Tap Subscribe and follow the steps shown for your device. " +
        "(Google Calendar ignores alerts inside the feed; set that calendar's notifications in Google Calendar instead.) " +
        "Anyone with this link can see your upcoming bills, payees and amounts, so don't share it. " +
        "Your phone must be able to reach this app's address."));
  };
  api("/calendar-feed").then((r) => paintCalendar(r.path, r.alert_days, r.headsup, r, r.daily))
    .catch((e) => calBody.replaceChildren(el("div", {class: "help"}, "Couldn't load the calendar link: " + e.message)));

  // ---- Categories ----
  pane.categories.append(el("div", {class: "set-sec set-sec-row"},
    el("div", {}, el("div", {class: "set-sec-title"}, "Categories"),
      el("div", {class: "help"}, "Tap a category to rename or move it")),
    el("button", {class: "btn sm", onclick: addGroup}, "+ New Group")));

  for (const g of groups) {
    if (g.is_income) continue;
    const section = el("div", {class: "card set-group"});
    section.append(el("div", {class: "set-group-head"},
      el("div", {class: "set-group-name"}, g.name),
      el("button", {class: "set-menu-btn", title: "Group options",
        onclick: () => openGroupEditor(g)}, "⋯")));

    for (const c of g.categories.filter((c) => !c.hidden)) {
      const row = el("div", {class: "set-cat-row",
        onclick: () => openCategoryEditor(c, groups)},
        el("span", {}, c.name), el("span", {class: "chev-right"}, "›"));
      section.append(row);
    }
    section.append(el("div", {class: "set-cat-row set-add", onclick: () => addCategory(g.id)}, "+ Add category"));
    pane.categories.append(section);
  }

  // ---- Accounts ----
  pane.accounts.append(el("div", {class: "set-sec set-sec-row"},
    el("div", {}, el("div", {class: "set-sec-title"}, "Accounts"),
      el("div", {class: "help"}, "Tap an account to edit, close or reopen it. Use ▲ ▼ to change the order (or drag accounts in the left menu).")),
    el("button", {class: "btn sm", onclick: () => openAccountModal()}, "+ New Account")));

  // Two separate lists: the accounts in use, and the closed ones (kept for their history).
  const acctList = el("div", {});
  // Move an account up or down among the accounts of its own kind (on-budget / off-budget, open / closed).
  const nudge = async (a, dir) => {
    const peers = State.accounts.filter((x) => !!x.on_budget === !!a.on_budget && !!x.closed === !!a.closed);
    const target = peers[peers.indexOf(a) + dir];
    if (!target) return;
    await moveAccount(a.id, target.id, dir > 0);
    drawAccounts();
  };
  const drawAccounts = () => {
    acctList.replaceChildren();
    const row = (a) => {
      const meta = (ACCT_TYPE_LABEL[a.type] || a.type) + (a.on_budget ? "" : " · off-budget");
      const peers = State.accounts.filter((x) => !!x.on_budget === !!a.on_budget && !!x.closed === !!a.closed);
      const arrow = (label, title, dir, disabled) => el("button", {type: "button", class: "set-menu-btn", title, disabled,
        onclick: (e) => { e.stopPropagation(); nudge(a, dir); }}, label);
      return el("div", {class: "set-cat-row" + (a.closed ? " set-closed" : ""), onclick: () => openAccountModal(a)},
        el("div", {}, el("div", {}, a.name), el("div", {class: "help"}, meta)),
        el("div", {style: "display:flex;align-items:center;gap:8px"},
          el("strong", {class: a.balance < 0 ? "num neg" : ""}, fmt(a.balance)),
          arrow("▲", "Move up", -1, peers.indexOf(a) === 0), arrow("▼", "Move down", +1, peers.indexOf(a) === peers.length - 1),
          el("span", {class: "chev-right"}, "›")));
    };
    const open = State.accounts.filter((a) => !a.closed), closed = State.accounts.filter((a) => a.closed);
    if (!State.accounts.length) {
      acctList.append(el("div", {class: "card set-group"}, el("div", {class: "help set-note"}, "No accounts yet.")));
      return;
    }
    acctList.append(secTitle(`Open accounts (${open.length})`, "Accounts you're using"),
      el("div", {class: "card set-group"}, ...(open.length ? open.map(row)
        : [el("div", {class: "help set-note"}, "No open accounts.")])));
    if (closed.length) acctList.append(
      secTitle(`Closed accounts (${closed.length})`, "Out of use, but their history is kept. Tap one to reopen it.", "set-sec-closed"),
      el("div", {class: "card set-group"}, ...closed.map(row)));
  };
  drawAccounts();
  pane.accounts.append(acctList);

  // ---- Budget ----
  pane.data.append(secTitle("This budget"));
  const budgetCard = el("div", {class: "card set-group"});
  budgetCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, State.budgetName || ""),
      el("div", {class: "help"}, "Each budget has its own password. Closing returns to the budget picker; other budgets aren't affected.")),
    el("button", {class: "btn secondary sm", onclick: closeBudget}, "Close Budget")));
  pane.data.append(budgetCard);

  // ---- Security ----
  pane.data.append(secTitle("Security", "Password, encryption and passkeys"));
  const secCard = el("div", {class: "card set-group"}, el("div", {class: "pref-row"}, el("div", {class: "help"}, "Loading…")));
  pane.data.append(secCard);
  renderSecurityCard(secCard);

  // ---- Offline support ----
  pane.data.append(secTitle("Offline support", "Use the app without a connection"));
  const offCard = el("div", {class: "card set-group"});
  const offStatus = el("div", {class: "help"}, "Checking…");
  offCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Status"), offStatus),
    el("button", {class: "btn secondary sm",
      title: "Forget the saved offline copy and set it up again",
      onclick: () => { if (confirm("Reset offline support and reload? Changes still waiting to sync are kept.")) Outbox.resetOffline(); }},
      "Reset")));
  offCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Page security check"),
      el("div", {class: "help"}, "If your browser says this page is “not secure”, this lists anything it loaded without https.")),
    el("button", {class: "btn secondary sm", onclick: async () => {
      const report = await Outbox.securityReport();
      modal({title: "Page security check",
        bodyNode: el("pre", {style: "white-space:pre-wrap;word-break:break-all;font-size:12px;margin:0;max-height:60vh;overflow:auto"}, report),
        footNode: [el("div", {style: "flex:1"}), el("button", {class: "btn", onclick: closeModal}, "Close")]});
    }}, "Check")));
  pane.data.append(offCard);
  Outbox.diagnostics().then((d) => {
    const lines = [];
    if (!d.secure) lines.push("Not a secure (HTTPS) connection, so offline support is unavailable here.");
    else if (!d.supported) lines.push("This browser doesn't support offline mode.");
    else if (d.error) lines.push("Offline setup failed: " + d.error);
    else if (d.worker !== "active") lines.push(`Offline worker is ${d.worker}. Reload the page once.`);
    else if (!d.controlled) lines.push("Offline worker is installed but isn't running this page yet. Reload once.");
    else if (!d.hasRoot) lines.push("App is not saved for offline use yet. Stay online a few seconds, then reload.");
    else lines.push(`Ready: app saved (${d.shellFiles} files), ${d.apiEntries} screens of data saved.`);
    offStatus.textContent = lines.join(" ");
    offStatus.classList.toggle("sync-err", !d.ok);
  });

  // ---- Backup & Restore ----
  pane.data.append(secTitle("Backup & restore", "Keep a copy of everything, or go back to one"));
  const backupCard = el("div", {class: "card set-group"});
  backupCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Download Backup"),
      el("div", {class: "help"}, "Downloads everything — accounts, categories, transactions, budgets, and scheduled transactions — as a single file you can restore from later.")),
    el("a", {class: "btn secondary sm", href: "/api/backup/export"}, "Download Backup")));
  backupCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Restore from Backup"),
      el("div", {class: "help"}, "Replaces everything with a previously downloaded backup file. This cannot be undone.")),
    el("button", {class: "btn danger sm", onclick: openRestoreBackup}, "Restore from Backup…")));
  // Database version + the automatic backups made before upgrades.
  const verRow = el("div", {class: "pref-row"}, el("div", {}, el("div", {}, "Database version"),
    el("div", {class: "help"}, "Loading…")));
  backupCard.append(verRow);
  pane.data.append(backupCard);
  api("/schema-version").then((v) => {
    const names = v.backups.map((b) => b.name);
    verRow.replaceChildren(el("div", {}, el("div", {}, `Database version ${v.version}` +
        (v.version >= v.latest ? " (up to date)" : " (older than this release)")),
      el("div", {class: "help"}, "Whenever an update needs to change the database, a copy is saved first in the " +
        "server's data folder under backups/ (the newest 10 are kept). " +
        (names.length ? `Latest: ${names[0]}` : "None have been needed yet."))));
  }).catch(() => verRow.remove());

  // ---- Danger Zone ----
  pane.data.append(secTitle("Danger zone", "These can't be undone", "set-sec-danger"));
  const dangerCard = el("div", {class: "card set-group"});
  dangerCard.append(el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, "Start New Budget"),
      el("div", {class: "help"}, "Permanently deletes every account, category, transaction, budget entry, and scheduled transaction in this budget — a completely fresh, empty budget. This budget's password is not affected, and other budgets aren't touched.")),
    el("button", {class: "btn danger sm", onclick: openStartNewBudget}, "Start New Budget…")));
  pane.data.append(dangerCard);
}

// ---- Auto-fill: what the importer has learned (categories for payees, bank wording matched to your payees) ----
function renderAutofill(host, groups) {
  const section = (title, sub) => el("div", {class: "set-sec"}, el("div", {class: "set-sec-title"}, title), el("div", {class: "help"}, sub));
  const SHOW = 100;

  // One searchable list. `load(q)` returns the rows, `row(r, refresh)` draws one.
  const makeList = (load, row, emptyText) => {
    const search = el("input", {type: "text", placeholder: "Search…", class: "reg-search", style: "max-width:320px;margin-bottom:10px"});
    const body = el("div", {class: "card set-group"});
    let rows = [], limit = SHOW, timer = null;
    const draw = () => {
      body.replaceChildren();
      if (!rows.length) { body.append(el("div", {class: "help set-note"}, search.value.trim() ? "Nothing matches." : emptyText)); return; }
      for (const r of rows.slice(0, limit)) body.append(row(r, refresh));
      if (rows.length > limit) body.append(el("div", {class: "set-cat-row set-add", onclick: () => { limit += SHOW; draw(); }},
        `Show more (${rows.length - limit} left)`));
    };
    const refresh = async () => {
      try { rows = await load(search.value.trim()); } catch (e) { toast(e.message, true); rows = []; }
      draw();
    };
    search.addEventListener("input", () => { clearTimeout(timer); limit = SHOW; timer = setTimeout(refresh, 200); });
    refresh();
    return el("div", {}, search, body);
  };
  const act = (label, title, fn) => el("button", {type: "button", class: "btn secondary sm", title, onclick: (e) => { e.stopPropagation(); fn(); }}, label);
  const tag = (text, cls = "") => el("span", {class: "tag " + cls, style: "margin-left:6px"}, text);
  const send = async (fn, refresh) => { try { await fn(); await refresh(); } catch (e) { toast(e.message, true); } };

  // ---- payee -> category ----
  const catRow = (r, refresh) => {
    const forgotten = r.source === "forgotten";
    const pill = el("button", {type: "button", class: "imp-cat" + (r.category_name ? "" : " imp-cat-empty"), disabled: forgotten,
      title: "Choose a different category",
      onclick: () => openCategoryPicker(groups, r.category_id, (id) => {
        if (id) send(() => api(`/memory/category/${r.key}`, {method: "PUT", body: {category_id: id, label: r.label}}), refresh);
      })}, forgotten ? "not used" : (r.category_name || "Uncategorized"));
    const note = r.source === "rule" ? "set by you" : forgotten ? "forgotten"
      : r.learned ? `used for ${r.learned.seen} of ${r.learned.of}` : "";
    return el("div", {class: "set-cat-row mem-row" + (forgotten ? " set-closed" : "")},
      el("div", {}, el("div", {}, r.label), el("div", {class: "help"}, note)),
      el("div", {style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end"}, pill,
        forgotten ? act("Restore", "Use what was learned again", () => send(() => api(`/memory/category/${r.key}`, {method: "DELETE"}), refresh))
          : act("Forget", "Don't fill in a category for this payee", () => send(() => api(`/memory/category/${r.key}?mode=forget`, {method: "DELETE", body: {label: r.label}}), refresh)),
        r.source === "rule" ? act("Reset", "Go back to what was learned", () => send(() => api(`/memory/category/${r.key}`, {method: "DELETE"}), refresh)) : null));
  };

  // ---- bank wording -> your payee ----
  const editPayee = (r, refresh) => {
    const input = el("input", {type: "text", value: r.payee || ""});
    const save = async () => {
      if (!input.value.trim()) return toast("Enter a payee", true);
      closeModal();
      send(() => api(`/memory/alias/${r.key}`, {method: "PUT", body: {payee: input.value.trim(), label: r.bank}}), refresh);
    };
    modal({title: "Match this bank wording to", onSubmit: save,
      bodyNode: el("div", {}, el("div", {class: "help", style: "margin-bottom:10px"}, `When a bank row says “${r.bank}”, treat it as this payee.`),
        el("label", {class: "field"}, el("span", {}, "Your payee"), input)),
      footNode: [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"), el("button", {class: "btn", onclick: save}, "Save")]});
  };
  const aliasRow = (r, refresh) => {
    const forgotten = r.source === "forgotten";
    return el("div", {class: "set-cat-row mem-row" + (forgotten ? " set-closed" : "")},
      el("div", {}, el("div", {}, r.bank, tag(forgotten ? "forgotten" : r.source === "rule" ? "set by you" : "learned", forgotten ? "" : "")),
        el("div", {class: "help"}, forgotten ? "Not used" : `→ ${r.payee}${r.count ? ` · matched ${r.count} time${r.count === 1 ? "" : "s"}` : ""}`)),
      el("div", {style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end"},
        forgotten ? null : act("Change…", "Match it to a different payee", () => editPayee(r, refresh)),
        forgotten ? act("Restore", "Use what was learned again", () => send(() => api(`/memory/alias/${r.key}`, {method: "DELETE"}), refresh))
          : act("Forget", "Stop recognising this wording", () => send(() => api(`/memory/alias/${r.key}?mode=forget`, {method: "DELETE", body: {label: r.bank}}), refresh)),
        r.source === "rule" ? act("Reset", "Go back to what was learned", () => send(() => api(`/memory/alias/${r.key}`, {method: "DELETE"}), refresh)) : null));
  };

  host.append(
    section("Categories for payees",
      "When you import, a new transaction gets the category its payee usually has. This is what it has learned from your transactions. Change a category, or forget one you don't want filled in."),
    makeList((q) => api(`/memory/categories?q=${encodeURIComponent(q)}`), catRow,
      "Nothing learned yet. Categorize some transactions and it will start filling them in on import."),
    section("Bank wording matched to your payees",
      "When you match a bank row to a transaction you entered yourself, the bank's wording is remembered so it is matched automatically next time. Change what it matches to, or forget one."),
    makeList((q) => api(`/memory/aliases?q=${encodeURIComponent(q)}`), aliasRow,
      "None yet. They appear when you match a bank row to a transaction on the import review screen."));
}

// ---- Security: encrypt the budget file, passwords, recovery key, passkeys --------------------------------
async function renderSecurityCard(card) {
  let st;
  try { st = await api("/security"); } catch { card.remove(); return; }
  const again = () => renderSecurityCard(card);
  const row = (title, help, ...actions) => el("div", {class: "pref-row"},
    el("div", {}, el("div", {}, title), help ? el("div", {class: "help"}, help) : null),
    el("div", {class: "row-actions"}, ...actions));
  const btn = (label, fn, cls = "secondary") => el("button", {class: `btn ${cls} sm`, onclick: fn}, label);
  const kids = [];

  kids.push(row("Change password", "The password you type to open this budget.",
    btn("Change…", () => openChangePassword(again, st.encrypted ? 12 : 4))));

  if (!st.available) {
    kids.push(row("Encrypt this budget", "Encrypting the budget file on the server is part of the Docker / NAS version. " +
      "This server can't do it."));
  } else if (!st.encrypted) {
    kids.push(row("Encrypt this budget",
      "Turns the budget file on the server into scrambled data that is useless without your password, so a copied " +
      "data folder, a stolen drive or a leaked backup reveals nothing. You'll get a recovery key to keep somewhere safe.",
      btn("Encrypt…", () => openEncrypt(again), "")));
  } else {
    kids.push(row("Encrypted 🔒",
      `The budget file on the server is encrypted. It stays unlocked while you use it and locks itself after ` +
      `${st.lock_minutes} minute${st.lock_minutes === 1 ? "" : "s"} with no activity from any device, or when the last device closes it.`));
    kids.push(row("Recovery key",
      "Opens this budget if you forget the password. Making a new one stops the old one working.",
      btn("Make a new recovery key…", () => openNewRecoveryKey())));
    const list = el("div", {class: "help"}, st.passkeys.length ? "" : "No passkeys yet.");
    for (const k of st.passkeys) {
      list.append(el("div", {style: "margin-top:4px"}, `🔑 ${k.label || "Passkey"} · added ${k.created} `,
        el("a", {href: "#", onclick: (e) => { e.preventDefault(); openRemovePasskey(k, again); }}, "Remove")));
    }
    kids.push(el("div", {class: "pref-row"},
      el("div", {}, el("div", {}, "Passkeys"),
        el("div", {class: "help"}, "Open this budget with a fingerprint, face or security key instead of typing the password. " +
          "A passkey only works on the web address you add it from."), list),
      el("div", {class: "row-actions"}, btn("Add a passkey…", () => openAddPasskey(st, again)))));
    kids.push(row("Remove encryption", "Turns the file back into an ordinary, readable one.",
      btn("Remove…", () => openDecrypt(again), "danger")));
  }
  card.replaceChildren(...kids);
}

// A small "type your password to confirm" dialog. run(password) does the work (and may throw).
function askPassword({title, intro, button, extra = null, danger = false, run}) {
  const pw = el("input", {type: "password", name: "password", autocomplete: "current-password", placeholder: "Your password"});
  const problem = el("div", {class: "modal-err", hidden: true});     // stays in the dialog until it is fixed or closed
  const go = async () => {
    problem.hidden = true;
    if (!pw.value) return toast("Enter your password", true);
    try { await run(pw.value); }
    catch (e) { const msg = e.passkey ? passkeyProblem(e) : e.message; problem.textContent = msg; problem.hidden = false; toast(msg, true); }
  };
  modal({title, onSubmit: go, bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:12px"}, intro), extra, problem,
      el("label", {class: "field"}, el("span", {}, "Password"), pw)),
    footNode: [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn" + (danger ? " danger" : ""), onclick: go}, button)]});
}

function openChangePassword(done, min = 4) {
  const pw = el("input", {type: "password", name: "password", autocomplete: "current-password", placeholder: "Current password"});
  const n1 = el("input", {type: "password", name: "new-password", autocomplete: "new-password", placeholder: "New password"});
  const n2 = el("input", {type: "password", name: "new-password-confirm", autocomplete: "new-password", placeholder: "Confirm new password"});
  const go = async () => {
    if (!pw.value) return toast("Enter your current password", true);
    if (n1.value.length < min) return toast(`Use at least ${min} characters`, true);
    if (n1.value !== n2.value) return toast("The new passwords don't match", true);
    try {
      await api("/security/password", {method: "POST", body: {password: pw.value, new_password: n1.value}});
      closeModal(); toast("Password changed"); done();
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Change password", onSubmit: go, bodyNode: el("div", {},
      min > 4 ? el("div", {class: "help", style: "margin-bottom:12px"},
        `An encrypted budget needs a password of at least ${min} characters. A long random one from your password manager is best.`) : null,
      el("label", {class: "field"}, pw), el("label", {class: "field"}, n1), el("label", {class: "field"}, n2)),
    footNode: [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: go}, "Change password")]});
}

function openEncrypt(done) {
  const wipe = el("input", {type: "checkbox", checked: true});
  const n1 = el("input", {type: "password", name: "new-password", autocomplete: "new-password", placeholder: "New password (12+ characters)"});
  const n2 = el("input", {type: "password", name: "new-password-confirm", autocomplete: "new-password", placeholder: "Confirm new password"});
  askPassword({
    title: "Encrypt this budget",
    intro: "The budget file on the server is converted to an encrypted one. This takes a moment and nothing is " +
      "replaced until the encrypted copy has been checked. Afterwards the server forgets your key whenever " +
      "nobody is using the budget, so a restart leaves it locked until you sign in.",
    extra: el("div", {},
      el("div", {class: "help", style: "margin-bottom:8px"},
        "An encrypted budget needs a password of at least 12 characters, because that password is all that protects the " +
        "file if someone copies it. If your current password is shorter, choose a new one here (a long random one from " +
        "your password manager is best); otherwise leave these blank."),
      el("label", {class: "field"}, n1), el("label", {class: "field"}, n2),
      el("label", {class: "field", style: "display:flex;gap:8px;align-items:flex-start"}, wipe,
        el("span", {class: "help", style: "margin:0"},
          "Also delete this budget's older automatic backups from the server's backups/ folder. They are plain " +
          "copies of the same data. (Copies kept elsewhere, such as NAS snapshots, aren't touched.)"))),
    button: "Encrypt",
    run: async (password) => {
      if (n1.value !== n2.value) throw new Error("The new passwords don't match");
      const r = await api("/security/encrypt", {method: "POST", body: {password, new_password: n1.value, delete_old_backups: wipe.checked}});
      showRecoveryKey(r.recovery_key, done);
    }});
}

// The recovery key is shown once. The dialog can't be closed until the person says they saved it.
function showRecoveryKey(key, done) {
  const saved = el("input", {type: "checkbox"});
  const finish = el("button", {class: "btn", disabled: true, onclick: () => { closeModal(); done(); }}, "Done");
  saved.addEventListener("change", () => { finish.disabled = !saved.checked; });
  const download = () => {
    const a = el("a", {href: URL.createObjectURL(new Blob([
      `My NAB recovery key for "${State.budgetName || "budget"}"\n\n${key}\n\n` +
      "Keep this somewhere safe and private. It opens the budget if you forget the password.\n"], {type: "text/plain"})),
      download: "My NAB recovery key.txt"});
    a.click();
  };
  const bg = modal({title: "Save your recovery key", bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:12px"},
        "The budget is encrypted. If you forget the password, this key is the only way back in. We can't show it " +
        "again, so save it now in a password manager or print it, and keep it somewhere safe."),
      el("div", {class: "recovery-key"}, key),
      el("div", {style: "display:flex;gap:8px;margin:12px 0"},
        el("button", {class: "btn secondary sm", onclick: () => navigator.clipboard.writeText(key).then(() => toast("Copied"))}, "Copy"),
        el("button", {class: "btn secondary sm", onclick: download}, "Download")),
      el("label", {style: "display:flex;gap:8px;align-items:center"}, saved, "I've saved my recovery key")),
    footNode: [finish]});
  bg.addEventListener("click", (e) => { if (e.target === bg) e.stopImmediatePropagation(); }, true);   // clicking outside doesn't dismiss it
}

function openNewRecoveryKey() {
  askPassword({title: "Make a new recovery key",
    intro: "The old recovery key stops working as soon as you make a new one.", button: "Make new key",
    run: async (password) => {
      const r = await api("/security/recovery-key", {method: "POST", body: {password}});
      showRecoveryKey(r.recovery_key, () => {});
    }});
}

function openDecrypt(done) {
  askPassword({title: "Remove encryption", danger: true, button: "Remove encryption",
    intro: "The budget file on the server becomes an ordinary readable file again. Passkeys and the recovery key stop " +
      "being used. You can encrypt it again later.",
    run: async (password) => {
      await api("/security/decrypt", {method: "POST", body: {password}});
      closeModal(); toast("Encryption removed"); done();
    }});
}

function openAddPasskey(st, done) {
  if (!passkeysSupported()) return toast(passkeyProblem(new Error("Passkeys aren't available here")), true);
  const label = el("input", {type: "text", placeholder: "e.g. My iPhone", value: ""});
  askPassword({title: "Add a passkey", button: "Add passkey",
    intro: "You'll be asked to confirm with your fingerprint, face, PIN or security key. This passkey will then be " +
      "able to open this budget.",
    extra: el("label", {class: "field"}, el("span", {}, "Name"), label),
    run: async (password) => {
      const o = await api("/security/passkey-options");
      let k;
      try { k = await passkeyCreate(o.ids, o.salt, State.budgetName || "My NAB"); }
      catch (e) { e.passkey = true; throw e; }
      await api("/security/passkeys", {method: "POST", body: {password, id: k.id, prf: k.prf, label: label.value.trim() || "Passkey"}});
      closeModal(); toast("Passkey added"); done();
    }});
}

function openRemovePasskey(k, done) {
  askPassword({title: "Remove passkey", danger: true, button: "Remove",
    intro: `"${k.label || "Passkey"}" will no longer open this budget. (Delete it from your device's passkey list too.)`,
    run: async (password) => {
      await api(`/security/passkeys/${encodeURIComponent(k.id)}`, {method: "DELETE", body: {password}});
      closeModal(); toast("Passkey removed"); done();
    }});
}

function openRestoreBackup() {
  const fileInput = el("input", {type: "file", accept: ".db,.nabbackup"});
  const pw = el("input", {type: "password", placeholder: "Confirm your password"});
  const save = async () => {
    if (!fileInput.files[0]) return toast("Choose a backup file first", true);
    if (!pw.value) return toast("Enter your password to confirm", true);
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    fd.append("password", pw.value);
    try {
      const r = await api("/backup/restore", {method: "POST", form: fd});
      closeModal();
      if (r && r.signed_out) {            // an encrypted backup brings its own password: sign in again
        toast("Backup restored. Sign in again with the backup's password.");
        setTimeout(() => location.reload(), 1200);
        return;
      }
      await refreshAccounts();
      navGo("budget");
      toast("Backup restored");
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Restore from Backup", onSubmit: save, bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:12px"},
        "This permanently replaces every account, category, transaction, budget entry, and scheduled transaction with what's in the backup file. This cannot be undone."),
      el("label", {class: "field"}, el("span", {}, "Backup file"), fileInput),
      el("label", {class: "field"}, el("span", {}, "Password"), pw)),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn danger", onclick: save}, "Restore & overwrite everything")]});
}

function openStartNewBudget() {
  const pw = el("input", {type: "password", placeholder: "Confirm your password"});
  const save = async () => {
    if (!pw.value) return toast("Enter your password to confirm", true);
    try {
      await api("/reset-budget", {method: "POST", body: {password: pw.value}});
      closeModal();
      await refreshAccounts();
      navGo("budget");
      toast("Started a new budget");
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Start New Budget", onSubmit: save, bodyNode: el("div", {},
      el("div", {class: "help", style: "margin-bottom:12px"},
        "This permanently deletes every account, category, transaction, budget entry, and scheduled transaction. This cannot be undone."),
      el("label", {class: "field"}, el("span", {}, "Password"), pw)),
    footNode: [
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn danger", onclick: save}, "Delete everything & start fresh")]});
}

// -------- editors (full dialogs, big tap targets) --------
function openCategoryEditor(c, groups) {
  const name = el("input", {type: "text", value: c.name});
  const groupSel = el("select", {});
  for (const g of groups) {
    if (g.is_income) continue;
    const o = el("option", {value: g.id}, g.name);
    if (g.id === c.group_id) o.selected = true;
    groupSel.append(o);
  }
  const save = async () => {
    if (!name.value.trim()) return toast("Name required", true);
    try {
      await api(`/categories/${c.id}`, {method: "PUT",
        body: {name: name.value.trim(), group_id: Number(groupSel.value)}});
      closeModal(); navGo("settings");
    } catch (e) { toast(e.message, true); }
  };
  modal({title: "Edit Category", onSubmit: save, bodyNode: el("div", {},
    el("label", {class: "field"}, el("span", {}, "Name"), name),
    el("label", {class: "field"}, el("span", {}, "Group"), groupSel)),
    footNode: [
      el("button", {class: "btn danger", onclick: () => delCategory(c)}, "Delete"),
      el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: save}, "Save")]});
}

function openGroupEditor(g) {
  const name = el("input", {type: "text", value: g.name});
  const save = async () => {
    if (!name.value.trim()) return toast("Name required", true);
    try { await api(`/groups/${g.id}`, {method: "PUT", body: {name: name.value.trim()}}); closeModal(); navGo("settings"); }
    catch (e) { toast(e.message, true); }
  };
  modal({title: "Edit Group", onSubmit: save, bodyNode:
    el("label", {class: "field"}, el("span", {}, "Group name"), name),
    footNode: [
      el("button", {class: "btn danger", onclick: () => delGroup(g)}, "Delete"),
      el("div", {style: "flex:1"}),
      el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: save}, "Save")]});
}

// -------- add flows (simple single-field dialog) --------
function textModal(title, initial, onSave) {
  const input = el("input", {type: "text", value: initial || ""});
  const save = async () => {
    if (!input.value.trim()) return toast("Name required", true);
    try { await onSave(input.value.trim()); closeModal(); navGo("settings"); }
    catch (e) { toast(e.message, true); }
  };
  modal({title, onSubmit: save, bodyNode: el("label", {class: "field"}, el("span", {}, "Name"), input),
    footNode: [el("button", {class: "btn secondary", onclick: closeModal}, "Cancel"),
      el("button", {class: "btn", onclick: save}, "Save")]});
}

const addGroup = () => textModal("New Category Group", "", (name) =>
  api("/groups", {method: "POST", body: {name}}));
const addCategory = (gid) => textModal("New Category", "", (name) =>
  api("/categories", {method: "POST", body: {name, group_id: gid}}));

async function delGroup(g) {
  if (!confirm(`Delete "${g.name}" and all its categories? Transactions in them become uncategorized.`)) return;
  try { await api(`/groups/${g.id}`, {method: "DELETE"}); closeModal(); navGo("settings"); }
  catch (e) { toast(e.message, true); }
}
async function delCategory(c) {
  if (!confirm(`Delete "${c.name}"? Its transactions become uncategorized.`)) return;
  try { await api(`/categories/${c.id}`, {method: "DELETE"}); closeModal(); navGo("settings"); }
  catch (e) { toast(e.message, true); }
}
