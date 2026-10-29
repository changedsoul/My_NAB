/* Reports view: one date range at the top drives an overview, a spending donut, top payees, cash flow,
   net worth, category trends and budget vs. actual. Charts are small hand-made SVGs (no libraries, so they
   work offline), redrawn to fit their box whenever it changes size. */
"use strict";

// ---- dates (local time) ------------------------------------------------------------------------------
const rpPad = (n) => String(n).padStart(2, "0");
const rpISO = (d) => `${d.getFullYear()}-${rpPad(d.getMonth() + 1)}-${rpPad(d.getDate())}`;
const rpToday = () => rpISO(new Date());
const rpLastDay = (m) => { const [y, mo] = m.split("-").map(Number); return new Date(y, mo, 0).getDate(); };
const rpMonthEnd = (m) => `${m}-${rpPad(rpLastDay(m))}`;
const rpShift = (ds, k) => {                       // the same day k months away (clamped to the month's length)
  const mm = monthAdd(ds.slice(0, 7), k);
  return `${mm}-${rpPad(Math.min(Number(ds.slice(8, 10)), rpLastDay(mm)))}`;
};
const rpAddDays = (ds, n) => { const d = new Date(ds + "T00:00:00"); d.setDate(d.getDate() + n); return rpISO(d); };
const rpDays = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000) + 1;
const rpMonthShort = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
  .toLocaleDateString(undefined, {month: "short"});
const rpMonthLong = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
  .toLocaleDateString(undefined, {month: "long", year: "numeric"});
const rpDateShort = (ds) => new Date(ds + "T00:00:00").toLocaleDateString(undefined, {month: "short", day: "numeric"});
const rpEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

const RP_PRESETS = [
  {id: "this", label: "This month"}, {id: "last", label: "Last month"}, {id: "3", label: "Last 3 months"},
  {id: "6", label: "Last 6 months"}, {id: "ytd", label: "Year to date"}, {id: "12", label: "Last 12 months"},
  {id: "custom", label: "Custom"}];

// {from, to, prevFrom, prevTo}: the chosen range, and the same-sized stretch just before it (for "vs. before").
function rpRange(preset, custom) {
  const t = rpToday(), cur = t.slice(0, 7);
  let from, to, shift = null;
  switch (preset) {
    case "last": { const pm = monthAdd(cur, -1); from = pm + "-01"; to = rpMonthEnd(pm); shift = 1; break; }
    case "3": from = monthAdd(cur, -2) + "-01"; to = t; shift = 3; break;
    case "6": from = monthAdd(cur, -5) + "-01"; to = t; shift = 6; break;
    case "ytd": from = cur.slice(0, 4) + "-01-01"; to = t; shift = 12; break;
    case "12": from = monthAdd(cur, -11) + "-01"; to = t; shift = 12; break;
    case "custom": from = custom.from; to = custom.to; break;
    default: from = cur + "-01"; to = t; shift = 1;
  }
  if (from > to) [from, to] = [to, from];
  let prevFrom, prevTo;
  if (shift) {
    prevFrom = rpShift(from, -shift);
    prevTo = to === rpMonthEnd(to.slice(0, 7)) ? rpMonthEnd(monthAdd(to.slice(0, 7), -shift)) : rpShift(to, -shift);
  } else {
    prevTo = rpAddDays(from, -1);
    prevFrom = rpAddDays(prevTo, -(rpDays(from, to) - 1));
  }
  return {from, to, prevFrom, prevTo};
}

// ---- number helpers ----------------------------------------------------------------------------------
const rpCompact = (cents) => {
  const d = Math.abs(cents) / 100, sign = cents < 0 ? "-" : "";
  if (d >= 1e6) return `${sign}$${+(d / 1e6).toFixed(1)}M`;
  if (d >= 1e4) return `${sign}$${Math.round(d / 1e3)}k`;
  if (d >= 1e3) return `${sign}$${+(d / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(d)}`;
};

// Round-number gridlines from lo to hi: {ticks, lo, hi}, all in cents.
function rpTicks(lo, hi, want = 4) {
  if (hi <= lo) hi = lo + 100;
  const raw = (hi - lo) / want, pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step, ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v));
  return {ticks, lo: start, hi: end};
}

const RP_COLORS = ["#4c6ef5", "#12b886", "#fab005", "#fa5252", "#7950f2", "#15aabf", "#e64980", "#82c91e", "#fd7e14"];
const RP_OTHER = "#adb5bd";

// ---- tooltip + self-sizing chart box -----------------------------------------------------------------
let rpTip = null;
function rpShowTip(html, x, y) {
  if (!rpTip) { rpTip = el("div", {class: "rp-tip"}); document.body.append(rpTip); }
  rpTip.innerHTML = html;
  rpTip.style.display = "block";
  const w = rpTip.offsetWidth, h = rpTip.offsetHeight;
  rpTip.style.left = Math.max(6, Math.min(x + 14, window.innerWidth - w - 6)) + "px";
  rpTip.style.top = Math.max(6, Math.min(y + 14, window.innerHeight - h - 6)) + "px";
}
const rpHideTip = () => { if (rpTip) rpTip.style.display = "none"; };

// A box that calls draw(width) to get its SVG/HTML and again whenever its width changes. Anything inside with a
// data-tip attribute shows that (already-escaped) HTML as a tooltip on hover or tap.
function rpChart(draw) {
  const box = el("div", {class: "rp-chart"});
  let last = 0;
  const paint = () => {
    const w = Math.floor(box.clientWidth);
    if (!w || w === last) return;
    last = w;
    box.innerHTML = draw(w);
  };
  const tipAt = (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t && box.contains(t)) rpShowTip(t.getAttribute("data-tip"), e.clientX, e.clientY); else rpHideTip();
  };
  box.addEventListener("mousemove", tipAt);
  box.addEventListener("click", tipAt);
  box.addEventListener("mouseleave", rpHideTip);
  if (window.ResizeObserver) new ResizeObserver(paint).observe(box);
  requestAnimationFrame(paint);
  setTimeout(paint, 60);
  return box;
}

// ---- the page ----------------------------------------------------------------------------------------
async function renderReports(root) {
  let preset = getPref("reportRange", "this");
  if (!RP_PRESETS.some((p) => p.id === preset)) preset = "this";
  const custom = {from: getPref("reportFrom", monthAdd(rpToday().slice(0, 7), -2) + "-01"), to: getPref("reportTo", rpToday())};

  const cards = el("div", {class: "rp-cards"});
  const sections = {
    spending: rpSection("Spending by Category"), payees: rpSection("Top Payees"),
    cashflow: rpSection("Income vs. Spending"), networth: rpSection("Net Worth"),
    trend: rpSection("Spending Trends", "rp-wide"), bva: rpSection("Budget vs. Actual", "rp-wide")};

  const buttons = el("div", {class: "rp-presets", role: "tablist"});
  const fromIn = el("input", {type: "date", value: custom.from});
  const toIn = el("input", {type: "date", value: custom.to});
  const customRow = el("div", {class: "rp-custom"}, el("span", {class: "help"}, "From"), fromIn,
    el("span", {class: "help"}, "To"), toIn);
  const rangeNote = el("div", {class: "help rp-note"});

  let token = 0;
  const load = async () => {
    const mine = ++token;
    customRow.hidden = preset !== "custom";
    for (const b of buttons.children) b.classList.toggle("active", b.dataset.id === preset);
    const r = rpRange(preset, custom);
    rangeNote.textContent = `${rpDateShort(r.from)}${r.from.slice(0, 4) !== r.to.slice(0, 4) ? ", " + r.from.slice(0, 4) : ""}`
      + ` – ${rpDateShort(r.to)}, ${r.to.slice(0, 4)}`;
    rpHideTip();
    try {
      const [nw, aom] = await Promise.all([api("/reports/net_worth"), api("/reports/age_of_money")]);
      if (mine !== token) return;
      await Promise.all([
        rpCards(cards, r, nw, aom), rpSpending(sections.spending, r), rpPayees(sections.payees, r),
        rpCashflow(sections.cashflow, r), rpNetWorth(sections.networth, r, nw),
        rpTrend(sections.trend, r), rpBudgetVsActual(sections.bva, r)]);
    } catch (e) {
      if (mine === token) { root.append(el("div", {class: "empty"}, "Couldn't load the reports: " + e.message)); }
    }
  };

  for (const p of RP_PRESETS) {
    buttons.append(el("button", {type: "button", "data-id": p.id, onclick: () => {
      preset = p.id; setPref("reportRange", preset); load(); }}, p.label));
  }
  const changeCustom = () => {
    if (!fromIn.value || !toIn.value) return;
    custom.from = fromIn.value; custom.to = toIn.value;
    setPref("reportFrom", custom.from); setPref("reportTo", custom.to);
    load();
  };
  fromIn.addEventListener("change", changeCustom);
  toIn.addEventListener("change", changeCustom);

  root.append(el("div", {class: "rp-page"}, el("div", {class: "rp-top"}, buttons, rangeNote), customRow, cards,
    el("div", {class: "rp-grid"}, sections.spending, sections.payees, sections.cashflow, sections.networth,
      sections.trend, sections.bva)));
  await load();
}

// A titled card whose body is refilled each time the range changes.
function rpSection(title, extra = "") {
  const body = el("div", {class: "rp-body"});
  const card = el("section", {class: "rp-card " + extra}, el("h3", {}, title), body);
  card.body = body;
  return card;
}
const rpFill = (section, ...nodes) => { section.body.replaceChildren(...nodes.flat()); };
const rpEmpty = (text) => el("div", {class: "empty"}, text);

// ---- overview cards ----------------------------------------------------------------------------------
async function rpCards(host, r, nw, aom) {
  const [cur, prev] = await Promise.all([
    api(`/reports/summary?from=${r.from}&to=${r.to}`), api(`/reports/summary?from=${r.prevFrom}&to=${r.prevTo}`)]);
  const left = cur.income - cur.spending, prevLeft = prev.income - prev.spending;
  const rate = cur.income > 0 ? Math.round(left / cur.income * 100) : null;
  const prevRate = prev.income > 0 ? Math.round(prevLeft / prev.income * 100) : null;
  const pctChange = (a, b, upIsGood) => {
    if (!b) return el("div", {class: "rp-delta"}, " ");
    const pct = Math.round((a - b) / Math.abs(b) * 100);
    if (pct === 0) return el("div", {class: "rp-delta"}, "no change vs. before");
    const good = (pct > 0) === upIsGood;
    return el("div", {class: "rp-delta " + (good ? "good" : "bad")}, `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs. before`);
  };
  const lastNW = nw.length ? nw[nw.length - 1].net : 0;
  const before = nw.filter((p) => p.month < r.from.slice(0, 7)).pop();
  const nwChange = before ? lastNW - before.net : null;
  const stat = (label, value, sub, tone = "") => el("div", {class: "rp-card rp-stat"},
    el("div", {class: "label"}, label), el("div", {class: "value " + tone}, value), sub);
  host.replaceChildren(
    stat("Income", fmt(cur.income), pctChange(cur.income, prev.income, true)),
    stat("Spending", fmt(cur.spending), pctChange(cur.spending, prev.spending, false)),
    stat("Left over", fmt(left, {plus: true}), pctChange(left, prevLeft, true), left < 0 ? "neg" : ""),
    stat("Savings rate", rate === null ? "–" : `${rate}%`,
      el("div", {class: "rp-delta " + (rate !== null && prevRate !== null && rate !== prevRate ? (rate > prevRate ? "good" : "bad") : "")},
        rate !== null && prevRate !== null && rate !== prevRate ? `${rate > prevRate ? "▲" : "▼"} ${Math.abs(rate - prevRate)} pts vs. before` : " ")),
    stat("Net worth", fmt(lastNW),
      el("div", {class: "rp-delta " + (nwChange === null ? "" : nwChange >= 0 ? "good" : "bad")},
        nwChange === null ? " " : `${nwChange >= 0 ? "▲" : "▼"} ${fmt(Math.abs(nwChange))} in this period`)),
    stat("Age of money", `${aom.age_of_money} days`, el("div", {class: "rp-delta"}, " ")));
}

// ---- spending donut ----------------------------------------------------------------------------------
async function rpSpending(section, r) {
  const rows = await api(`/reports/spending?from=${r.from}&to=${r.to}`);
  if (!rows.length) { rpFill(section, rpEmpty("No spending in this range.")); return; }
  const total = rows.reduce((t, x) => t + x.spent, 0);
  let slices = rows.slice(0, 9).map((x, i) => ({id: x.cid, name: x.name, group: x.group_name, value: x.spent, color: RP_COLORS[i]}));
  const rest = rows.slice(9);
  if (rest.length) slices.push({id: null, name: `Other (${rest.length})`, value: rest.reduce((t, x) => t + x.spent, 0), color: RP_OTHER});
  const open = (s) => { if (s.id !== null) rpDrill(s, r); };

  const donut = rpChart((w) => {
    const size = Math.min(w, 230), R = size / 2, thick = size * 0.17, rm = R - thick / 2;
    let angle = -Math.PI / 2, paths = "";
    for (const s of slices) {
      const sweep = Math.min(s.value / total, 0.99999) * Math.PI * 2;
      const x1 = R + rm * Math.cos(angle), y1 = R + rm * Math.sin(angle);
      const x2 = R + rm * Math.cos(angle + sweep), y2 = R + rm * Math.sin(angle + sweep);
      paths += `<path d="M${x1},${y1} A${rm},${rm} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2},${y2}" fill="none" stroke="${s.color}" `
        + `stroke-width="${thick}" data-id="${s.id}" data-tip="${rpEsc(`<b>${rpEsc(s.name)}</b><br>${fmt(s.value)} · ${(s.value / total * 100).toFixed(1)}%`)}" `
        + `class="rp-slice${s.id === null ? "" : " click"}"/>`;
      angle += sweep;
    }
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="rp-donut">${paths}`
      + `<text x="${R}" y="${R - 2}" text-anchor="middle" class="rp-donut-total">${rpEsc(fmt(total))}</text>`
      + `<text x="${R}" y="${R + 16}" text-anchor="middle" class="ch-axis">spent</text></svg>`;
  });
  donut.addEventListener("click", (e) => {
    const p = e.target.closest("[data-id]");
    const s = p && slices.find((x) => String(x.id) === p.getAttribute("data-id"));
    if (s) open(s);
  });
  const list = el("div", {class: "rp-legend"}, ...slices.map((s) => el("div",
    {class: "rp-leg-row" + (s.id === null ? "" : " click"), onclick: () => open(s)},
    el("i", {style: `background:${s.color}`}), el("span", {class: "rp-leg-name", title: s.group || ""}, s.name),
    el("span", {class: "num"}, fmt(s.value)), el("span", {class: "rp-leg-pct"}, `${Math.round(s.value / total * 100)}%`))));
  rpFill(section, el("div", {class: "rp-donut-wrap"}, donut, list));
}

// The purchases behind one slice of the donut.
async function rpDrill(slice, r) {
  const rows = await api(`/reports/category_transactions?category_id=${slice.id}&from=${r.from}&to=${r.to}`);
  const total = rows.reduce((t, x) => t + x.spent, 0);
  const table = el("table", {class: "register rp-table"},
    el("thead", {}, el("tr", {}, ...["Date", "Payee", "Memo", "Account", "Amount"].map((h, i) =>
      el("th", {class: i === 4 ? "num" : ""}, h)))),
    el("tbody", {}, ...rows.map((x) => el("tr", {},
      el("td", {}, x.date), el("td", {}, x.payee || ""), el("td", {class: "muted"}, x.memo || ""),
      el("td", {class: "muted"}, x.account), el("td", {class: "num"}, fmt(-x.spent))))));
  modal({
    title: `${slice.name}: ${fmt(total)}`,
    bodyNode: el("div", {class: "rp-drill"}, rows.length ? table : rpEmpty("Nothing here.")),
    footNode: el("button", {class: "btn", onclick: closeModal}, "Close"), wide: true});
}

// ---- top payees --------------------------------------------------------------------------------------
async function rpPayees(section, r) {
  const rows = (await api(`/reports/payees?from=${r.from}&to=${r.to}`)).slice(0, 10);
  if (!rows.length) { rpFill(section, rpEmpty("No payees in this range.")); return; }
  const max = rows[0].spent;
  rpFill(section, el("div", {class: "rp-rank"}, ...rows.map((x, i) => el("div", {class: "rp-rank-row"},
    el("span", {class: "rp-rank-n"}, i + 1),
    el("div", {class: "rp-rank-main"},
      el("div", {class: "rp-rank-top"}, el("span", {class: "rp-rank-name", title: x.payee}, x.payee),
        el("span", {class: "num"}, fmt(x.spent))),
      el("div", {class: "rp-rank-track", title: `${x.count} transaction${x.count === 1 ? "" : "s"}`},
        el("div", {style: `width:${(x.spent / max * 100).toFixed(1)}%;background:${RP_COLORS[0]}`})))))));
}

// ---- income vs. spending -----------------------------------------------------------------------------
// At least six months are shown, so a one-month range still has something to compare with.
function rpChartMonths(r, minMonths) {
  const to = r.to.slice(0, 7);
  const from = r.from.slice(0, 7) < monthAdd(to, -(minMonths - 1)) ? r.from.slice(0, 7) : monthAdd(to, -(minMonths - 1));
  return {from: from + "-01", to: r.to};
}

async function rpCashflow(section, r) {
  const span = rpChartMonths(r, 6);
  const data = await api(`/reports/cashflow?from=${span.from}&to=${span.to}`);
  if (!data.some((d) => d.income || d.spending)) { rpFill(section, rpEmpty("No income or spending yet.")); return; }
  const chart = rpChart((w) => {
    const H = 250, L = 46, B = 26, T = 10, Rt = 8, n = data.length;
    const nets = data.map((d) => d.income - d.spending);
    const t = rpTicks(Math.min(0, ...nets), Math.max(...data.map((d) => Math.max(d.income, d.spending))));
    const y = (v) => T + (t.hi - v) / (t.hi - t.lo) * (H - T - B);
    const slot = (w - L - Rt) / n, bw = Math.max(3, Math.min(22, slot * 0.34));
    let s = `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">`;
    for (const v of t.ticks) s += `<line x1="${L}" x2="${w - Rt}" y1="${y(v)}" y2="${y(v)}" class="ch-grid${v === 0 ? " zero" : ""}"/>`
      + `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ch-axis">${rpCompact(v)}</text>`;
    let line = "", dots = "";
    data.forEach((d, i) => {
      const cx = L + slot * (i + 0.5);
      s += `<rect x="${cx - bw - 1}" y="${y(d.income)}" width="${bw}" height="${Math.max(0, y(0) - y(d.income))}" rx="3" fill="var(--green)"/>`
        + `<rect x="${cx + 1}" y="${y(d.spending)}" width="${bw}" height="${Math.max(0, y(0) - y(d.spending))}" rx="3" fill="var(--red)"/>`;
      const net = nets[i];
      line += `${i ? "L" : "M"}${cx},${y(net)}`;
      dots += `<circle cx="${cx}" cy="${y(net)}" r="3.5" fill="var(--panel)" stroke="var(--accent)" stroke-width="2"/>`;
      s += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="ch-axis">${rpMonthShort(d.month)}</text>`;
    });
    s += `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"/>${dots}`;
    data.forEach((d, i) => {
      const tip = `<b>${rpEsc(rpMonthLong(d.month))}</b><br>Income ${fmt(d.income)}<br>Spending ${fmt(d.spending)}<br>`
        + `Left over <b>${fmt(nets[i], {plus: true})}</b>`;
      s += `<rect x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-tip="${rpEsc(tip)}"/>`;
    });
    return s + "</svg>";
  });
  rpFill(section, rpLegend([["var(--green)", "Income"], ["var(--red)", "Spending"], ["var(--accent)", "Left over"]]), chart);
}

const rpLegend = (items) => el("div", {class: "rp-keys"}, ...items.map(([c, t]) => el("span", {}, el("i", {style: `background:${c}`}), t)));

// ---- net worth ---------------------------------------------------------------------------------------
async function rpNetWorth(section, r, nw) {
  const span = rpChartMonths(r, 12);
  const data = nw.filter((p) => p.month >= span.from.slice(0, 7) && p.month <= r.to.slice(0, 7));
  if (data.length < 2) { rpFill(section, rpEmpty("Not enough history yet.")); return; }
  const chart = rpChart((w) => {
    const H = 250, L = 52, B = 26, T = 10, Rt = 10, n = data.length;
    const t = rpTicks(Math.min(0, ...data.map((d) => d.net)), Math.max(...data.map((d) => Math.max(d.assets, d.debts, d.net))));
    const x = (i) => L + i * (w - L - Rt) / (n - 1);
    const y = (v) => T + (t.hi - v) / (t.hi - t.lo) * (H - T - B);
    const path = (key) => data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d[key])}`).join("");
    let s = `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">`;
    for (const v of t.ticks) s += `<line x1="${L}" x2="${w - Rt}" y1="${y(v)}" y2="${y(v)}" class="ch-grid${v === 0 ? " zero" : ""}"/>`
      + `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ch-axis">${rpCompact(v)}</text>`;
    s += `<path d="${path("net")}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="var(--accent)" opacity=".12"/>`
      + `<path d="${path("assets")}" fill="none" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4 3"/>`
      + `<path d="${path("debts")}" fill="none" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="4 3"/>`
      + `<path d="${path("net")}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>`;
    const every = Math.ceil(n / Math.max(2, Math.floor((w - L) / 56)));
    data.forEach((d, i) => {
      if (i % every === 0 || i === n - 1) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}" class="ch-axis">${rpMonthShort(d.month)}${d.month.endsWith("-01") || i === 0 ? " " + d.month.slice(2, 4) : ""}</text>`;
      const tip = `<b>${rpEsc(rpMonthLong(d.month))}</b><br>You own ${fmt(d.assets)}<br>You owe ${fmt(d.debts)}<br>Net worth <b>${fmt(d.net)}</b>`;
      const slot = (w - L - Rt) / (n - 1);
      s += `<rect x="${x(i) - slot / 2}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-tip="${rpEsc(tip)}"/>`;
    });
    return s + "</svg>";
  });
  rpFill(section, rpLegend([["var(--accent)", "Net worth"], ["var(--green)", "You own"], ["var(--red)", "You owe"]]), chart);
}

// ---- spending trends ---------------------------------------------------------------------------------
const rpTrendPick = new Set();       // category ids chosen by the user; empty means "the top five"

async function rpTrend(section, r) {
  const span = rpChartMonths(r, 6);
  const data = await api(`/reports/spending_trend?from=${span.from}&to=${span.to}`);
  if (!data.series.length) { rpFill(section, rpEmpty("No spending in this range.")); return; }
  const colorOf = new Map(data.series.map((s, i) => [s.id, RP_COLORS[i % RP_COLORS.length]]));
  const known = new Set(data.series.map((s) => s.id));
  for (const id of [...rpTrendPick]) if (!known.has(id)) rpTrendPick.delete(id);
  const picked = () => data.series.filter((s) => rpTrendPick.size ? rpTrendPick.has(s.id) : data.series.indexOf(s) < 5);
  const chipsHost = el("div", {class: "rp-chips"});
  const chartHost = el("div");

  const draw = () => {
    const shown = picked();
    chartHost.replaceChildren(rpChart((w) => {
      const H = 250, L = 46, B = 26, T = 10, Rt = 10, n = data.months.length;
      const t = rpTicks(0, Math.max(100, ...shown.flatMap((s) => s.values)));
      const x = (i) => n === 1 ? (L + w - Rt) / 2 : L + i * (w - L - Rt) / (n - 1);
      const y = (v) => T + (t.hi - v) / (t.hi - t.lo) * (H - T - B);
      let s = `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">`;
      for (const v of t.ticks) s += `<line x1="${L}" x2="${w - Rt}" y1="${y(v)}" y2="${y(v)}" class="ch-grid${v === 0 ? " zero" : ""}"/>`
        + `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ch-axis">${rpCompact(v)}</text>`;
      for (const sr of shown) {
        const c = colorOf.get(sr.id);
        s += `<path d="${sr.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")}" fill="none" stroke="${c}" stroke-width="2.2"/>`
          + sr.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${c}"/>`).join("");
      }
      const every = Math.ceil(n / Math.max(2, Math.floor((w - L) / 52)));
      data.months.forEach((m, i) => {
        if (i % every === 0 || i === n - 1) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="ch-axis">${rpMonthShort(m)}</text>`;
        const rows = shown.map((sr) => [sr, sr.values[i]]).sort((a, b) => b[1] - a[1])
          .map(([sr, v]) => `<span style="color:${colorOf.get(sr.id)}">●</span> ${rpEsc(sr.name)} ${fmt(v)}`);
        const tip = `<b>${rpEsc(rpMonthLong(m))}</b><br>${rows.join("<br>")}`;
        const slot = n === 1 ? w : (w - L - Rt) / (n - 1);
        s += `<rect x="${x(i) - slot / 2}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent" data-tip="${rpEsc(tip)}"/>`;
      });
      return s + "</svg>";
    }));
  };
  const drawChips = () => {
    const on = new Set(picked().map((s) => s.id));
    chipsHost.replaceChildren(...data.series.map((s) => el("button", {type: "button",
      class: "rp-chip" + (on.has(s.id) ? " on" : ""), onclick: () => {
        const now = new Set(on);
        if (now.has(s.id)) { if (now.size > 1) now.delete(s.id); } else if (now.size < 8) now.add(s.id);
        rpTrendPick.clear(); now.forEach((id) => rpTrendPick.add(id));
        drawChips(); draw();
      }}, el("i", {style: `background:${on.has(s.id) ? colorOf.get(s.id) : "transparent"};border-color:${colorOf.get(s.id)}`}), s.name)));
  };
  drawChips(); draw();
  rpFill(section, chipsHost, chartHost);
}

// ---- budget vs. actual -------------------------------------------------------------------------------
async function rpBudgetVsActual(section, r) {
  let months = [];
  for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7) && months.length < 60; m = monthAdd(m, 1)) months.push(m);
  const trimmed = months.length > 12;
  months = months.slice(-12);
  const res = await api(`/budget/range?months=${months.join(",")}`);
  const groups = new Map();
  for (const mo of res) for (const g of mo.groups) for (const c of g.categories) {
    const grp = groups.get(g.name) || groups.set(g.name, new Map()).get(g.name);
    const row = grp.get(c.id) || grp.set(c.id, {name: c.name, budgeted: 0, spent: 0}).get(c.id);
    row.budgeted += c.budgeted;
    row.spent += -c.activity;
  }
  const list = [...groups].map(([name, cats]) => ({name, rows: [...cats.values()].filter((c) => c.budgeted || c.spent)}))
    .filter((g) => g.rows.length);
  if (!list.length) { rpFill(section, rpEmpty("Nothing budgeted or spent in this range.")); return; }
  let tb = 0, ts = 0;
  for (const g of list) for (const c of g.rows) { tb += c.budgeted; ts += c.spent; }
  const note = el("div", {class: "help rp-bva-note"},
    `Spent ${fmt(ts)} of ${fmt(tb)} budgeted (${tb ? Math.round(ts / tb * 100) : 0}%)`
    + (trimmed ? `, for the last 12 months of the range.` : "."));
  const body = [];
  for (const g of list) {
    const gb = g.rows.reduce((t, c) => t + c.budgeted, 0), gs = g.rows.reduce((t, c) => t + c.spent, 0);
    body.push(el("div", {class: "rp-bva-group"}, el("span", {}, g.name), el("span", {}, `${fmt(gs)} / ${fmt(gb)}`)));
    for (const c of g.rows) {
      const over = c.spent > c.budgeted;
      const pct = c.budgeted ? c.spent / c.budgeted * 100 : 100;
      body.push(el("div", {class: "rp-bva-row"},
        el("span", {class: "rp-bva-name"}, c.name),
        el("div", {class: "rp-bva-track", title: c.budgeted ? `${Math.round(pct)}% of budget` : "Not budgeted"},
          el("div", {class: over ? "over" : "", style: `width:${Math.min(100, pct).toFixed(1)}%`})),
        el("span", {class: "rp-bva-nums" + (over ? " over" : "")}, `${fmt(c.spent)} / ${fmt(c.budgeted)}`)));
    }
  }
  rpFill(section, note, el("div", {class: "rp-bva"}, ...body));
}
