// analytics.js — adds 📈 buttons, analytics modal with deltas, labels, markers & tooltips
import { API, escapeHtml } from "./shared.js";

const modal    = document.getElementById("analyticsModal");
const anTitle  = document.getElementById("anTitle");
const anChart  = document.getElementById("anChart");
const anHist   = document.getElementById("anHistory");
const btnClose = document.getElementById("anClose");
const siteSelect = document.getElementById("siteSelect");
const table    = document.getElementById("compareTable");
const tbody    = table?.querySelector("tbody");

// lightweight styles (kept here so styles.css is untouched)
(function injectCss(){
  if (document.getElementById("analytics-css")) return;
  const s = document.createElement("style");
  s.id = "analytics-css";
  s.textContent = `
    .analytics-btn{ margin-left:.5rem; border:0; background:transparent; cursor:pointer; opacity:.9; }
    .analytics-btn:hover{ opacity:1 }
    .analytics-legend{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:6px; }
    .analytics-tag{ display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid var(--border); border-radius:999px; }
    .analytics-dot{ width:10px; height:10px; border-radius:50% }
    .analytics-table{ width:100%; border-collapse:collapse; }
    .analytics-table th, .analytics-table td{ padding:6px 8px; border-bottom:1px solid var(--border); }
    .analytics-table th{ text-align:left; }
    .chart-wrap{ width:100%; overflow:auto; }
    .chart svg{ width:100%; height:320px; display:block; }
    .chart .marker{ pointer-events:all; }
    .tooltip {
      position:absolute; z-index:10001; pointer-events:none;
      background:rgba(11,16,28,.92); color:#dfe7ff; padding:8px 10px;
      border:1px solid var(--border); border-radius:8px; font-size:12px; white-space:nowrap;
      transform:translate(-50%, -120%); box-shadow:0 8px 24px rgba(0,0,0,.35);
    }
    /* NEW: colored deltas */
    .delta-green { color: var(--green); font-weight:600; }
    .delta-red   { color: var(--red);   font-weight:600; }
  `;
  document.head.appendChild(s);
})();

function showModal(){ modal.style.display="flex"; modal.setAttribute("aria-hidden","false"); }
function hideModal(){ modal.style.display="none";  modal.setAttribute("aria-hidden","true"); }
btnClose?.addEventListener("click", hideModal);
modal?.addEventListener("click", (e)=>{ if (e.target === modal) hideModal(); });

function parsePriceText(el){
  if (!el) return null;
  const txt = el.textContent.trim();
  if (!txt || txt.toLowerCase() === "n/a") return null;
  const n = Number(txt.replace(/\s+/g,"").replace(",","."));
  return Number.isFinite(n) ? n : null;
}

// Add 📈 next to arrow+label inside price cell, only when price is not N/A
function addButtonsForRow(tr, mode){
  // mode: "single" (one competitor) or "all"
  const tds = Array.from(tr.children);
  if (!tds.length) return;

  let sku = null;
  let cells = [];
  if (mode === "single") {
    // [0]=sku, [5]=our, [6]=their (as in current comparison.js)
    sku = (tds[0]?.textContent || "").trim();
    if (tds[5]) cells.push({cell: tds[5], site:"praktis"});
    if (tds[6]) cells.push({cell: tds[6], site: (siteSelect?.value || "").trim()});
  } else {
    // all-sites layout:
    // [0]=sku, [3]=praktis, [4]=praktiker, [5]=mrbricolage, [6]=mashinibg
    sku = (tds[0]?.textContent || "").trim();
    if (tds[3]) cells.push({cell: tds[3], site:"praktis"});
    if (tds[4]) cells.push({cell: tds[4], site:"praktiker"});
    if (tds[5]) cells.push({cell: tds[5], site:"mrbricolage"});
    if (tds[6]) cells.push({cell: tds[6], site:"mashinibg"});
  }

  for (const {cell, site} of cells) {
    const wrap = cell.querySelector(".price-wrap .price-line");
    if (!wrap) continue;
    // only add if price != N/A
    const newEl = cell.querySelector(".price-new");
    const eff = parsePriceText(newEl);
    if (eff === null) continue;

    if (!wrap.querySelector(".analytics-btn")) {
      const btn = document.createElement("button");
      btn.className = "analytics-btn";
      btn.type = "button";
      btn.title = "Analytics";
      btn.textContent = "📈";
      btn.dataset.sku = sku;
      btn.dataset.site = site;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        await openAnalytics(sku);
      });
      wrap.appendChild(btn);
    }
  }
}

function detectModeFromHead(){
  const ths = Array.from(table.querySelectorAll("thead th")).map(th => (th.textContent||"").toLowerCase());
  return ths.includes("onlinemashini price") ? "all" : "single";
}

// Mutation observer: whenever rows re-render, inject buttons
if (tbody) {
  const obs = new MutationObserver(() => {
    const mode = detectModeFromHead();
    for (const tr of tbody.querySelectorAll("tr")) addButtonsForRow(tr, mode);
  });
  obs.observe(tbody, { childList: true, subtree: false });
}

// --------- Analytics modal content ---------
const COLORS = {
  "praktis":"#f58220",
  "praktiker":"#16a34a",
  "mashinibg":"#1461ff",
  "mrbricolage":"#dc2626",
};

async function openAnalytics(sku){
  anTitle.textContent = `Analytics — ${sku}`;
  anHist.innerHTML = "Loading…";
  anChart.innerHTML = "";

  const r = await fetch(`${API}/api/analytics/history?product_sku=${encodeURIComponent(sku)}`);
  if (!r.ok) {
    anHist.textContent = `Failed to load history (HTTP ${r.status})`;
    showModal();
    return;
  }
  const data = await r.json();
  renderHistory(data);
  renderChart(data);
  showModal();
}

function fmtPrice(v){
  if (v == null) return "—";
  return Number(v).toFixed(2);
}
function sign(v){
  if (v == null) return "";
  return (v > 0 ? "+" : (v < 0 ? "−" : "±")) + Math.abs(v).toFixed(2);
}

function renderHistory(data){
  const series = data.series || [];
  if (!series.length) {
    anHist.innerHTML = `<p>No snapshots in the last 6 months.</p>`;
    return;
  }
  const blocks = series.map(s => {
    const rows = [];
    let prev = null;
    for (const p of s.points) {
      const eff = p.effective_price ?? null;
      const prevEff = prev ? (prev.effective_price ?? null) : null;
      const changed = (prevEff !== null && eff !== null && Math.abs(eff - prevEff) > 1e-9);
      const delta = (changed ? (eff - prevEff) : null);
      const deltaCls = changed ? (delta > 0 ? "delta-red" : (delta < 0 ? "delta-green" : "")) : "";
      const deltaHtml = changed ? `<span class="${deltaCls}">${sign(delta)}</span>` : "";
      rows.push(`
        <tr>
          <td>${new Date(p.ts).toLocaleDateString()}</td>
          <td>${fmtPrice(p.regular_price)}</td>
          <td>${fmtPrice(p.promo_price)}</td>
          <td style="font-weight:600">${fmtPrice(p.effective_price)}</td>
          <td>${deltaHtml}</td>
          <td>${p.label ? escapeHtml(p.label) : ""}</td>
        </tr>
      `);
      prev = p;
    }
    return `
      <div>
        <div class="analytics-legend">
          <span class="analytics-tag">
            <span class="analytics-dot" style="background:${COLORS[s.site_code] || "#999"}"></span>
            ${escapeHtml(s.site_name)} (${escapeHtml(s.site_code)})
          </span>
        </div>
        <table class="analytics-table">
          <thead><tr><th>Date</th><th>Regular</th><th>Promo</th><th>Effective</th><th>Δ</th><th>Label</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    `;
  }).join("");
  anHist.innerHTML = blocks;
}

// ---- chart with nice Y ticks, date X ticks, change markers & hover tooltips ----
function niceNumber(range, round){
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let niceFrac;
  if (round) {
    if (frac < 1.5) niceFrac = 1;
    else if (frac < 3) niceFrac = 2;
    else if (frac < 7) niceFrac = 5;
    else niceFrac = 10;
  } else {
    if (frac <= 1) niceFrac = 1;
    else if (frac <= 2) niceFrac = 2;
    else if (frac <= 5) niceFrac = 5;
    else niceFrac = 10;
  }
  return niceFrac * Math.pow(10, exp);
}
function niceScale(min, max, ticks){
  const range = niceNumber(max - min, false);
  const step = niceNumber(range / (ticks - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return { niceMin, niceMax, step };
}

function renderChart(data){
  const series = (data.series || []).filter(s => (s.points||[]).length);
  if (!series.length) { anChart.innerHTML = ""; return; }

  // flatten for min/max
  const xs = series.flatMap(s => s.points.map(p => +new Date(p.ts)));
  const ys = series.flatMap(s => s.points.map(p => p.effective_price).filter(v => v != null));
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY0 = Math.min(...ys), maxY0 = Math.max(...ys);
  const padY = Math.max(1, (maxY0 - minY0) * 0.08);
  const minY = Math.max(0, minY0 - padY), maxY = maxY0 + padY;

  // nice ticks (rounded numbers)
  const yTicksTarget = 5;
  const yScale = niceScale(minY, maxY, yTicksTarget);
  const yVals = [];
  for (let v = yScale.niceMin; v <= yScale.niceMax + 1e-9; v += yScale.step) yVals.push(v);

  // time ticks (bottom axis)
  const xTickCount = 6;
  const xVals = [];
  for (let i=0;i<xTickCount;i++){
    const t = minX + (i*(maxX - minX)/(xTickCount-1));
    xVals.push(t);
  }

  // Dimensions
  const W = 940, H = 320, L=64, R=16, T=16, B=40;
  const w = W - L - R, h = H - T - B;

  function sx(x){ return L + (w * (x - minX) / Math.max(1, (maxX - minX))); }
  function sy(y){ return T + h - (h * (y - yScale.niceMin) / Math.max(1, (yScale.niceMax - yScale.niceMin))); }

  // build SVG
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`;

  // axes
  svg += `<line x1="${L}" y1="${T}" x2="${L}" y2="${T+h}" stroke="#445" stroke-width="1"/>`;
  svg += `<line x1="${L}" y1="${T+h}" x2="${L+w}" y2="${T+h}" stroke="#445" stroke-width="1"/>`;

  // Y grid + labels (rounded)
  for (const v of yVals) {
    const y = sy(v);
    svg += `<line x1="${L}" y1="${y}" x2="${L+w}" y2="${y}" stroke="#223" stroke-width="0.5" opacity="0.5"/>`;
    svg += `<text x="${L-8}" y="${y}" fill="#9fb3d9" font-size="11" text-anchor="end" dominant-baseline="middle">${v.toFixed(0)}</text>`;
  }

  // X ticks + labels (dates)
  for (const t of xVals) {
    const x = sx(t);
    const d = new Date(t);
    const label = d.toLocaleDateString(undefined, { month:"short", day:"2-digit" });
    svg += `<line x1="${x}" y1="${T+h}" x2="${x}" y2="${T+h+5}" stroke="#445" stroke-width="1"/>`;
    svg += `<text x="${x}" y="${T+h+18}" fill="#9fb3d9" font-size="11" text-anchor="middle">${label}</text>`;
  }

  // lines + change markers
  for (const s of series){
    const pts = s.points.filter(p => p.effective_price != null);
    if (!pts.length) continue;

    // path
    const path = pts.map((p,idx) => `${idx?"L":"M"}${sx(+new Date(p.ts))},${sy(p.effective_price)}`).join("");
    svg += `<path d="${path}" fill="none" stroke="${COLORS[s.site_code] || "#999"}" stroke-width="2.2"/>`;

    // markers only when price changed from previous point
    let prev = null;
    for (const p of pts){
      const prevEff = prev ? prev.effective_price : null;
      const changed = (prevEff !== null && Math.abs(p.effective_price - prevEff) > 1e-9);
      if (changed) {
        const cx = sx(+new Date(p.ts)), cy = sy(p.effective_price);
        const delta = p.effective_price - prevEff;
        svg += `<circle class="marker" cx="${cx}" cy="${cy}" r="3.2" fill="${COLORS[s.site_code] || "#999"}" data-site="${escapeHtml(s.site_name)}" data-color="${COLORS[s.site_code] || "#999"}" data-date="${new Date(p.ts).toLocaleString()}" data-price="${p.effective_price.toFixed(2)}" data-delta="${delta.toFixed(2)}" data-label="${p.label ? escapeHtml(p.label) : ""}"></circle>`;
      }
      prev = p;
    }
  }

  svg += `</svg>`;
  anChart.innerHTML = `<div class="chart-wrap"><div class="chart">${svg}</div></div>`;

  // Tooltips for markers (colored delta)
  const svgEl = anChart.querySelector("svg");
  if (!svgEl) return;

  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.style.display = "none";
  anChart.appendChild(tip);

  svgEl.addEventListener("pointerover", (e)=>{
    const target = e.target;
    if (target && target.classList.contains("marker")) {
      tip.style.display = "block";
      const site  = target.getAttribute("data-site") || "";
      const date  = target.getAttribute("data-date") || "";
      const price = target.getAttribute("data-price") || "";
      const delta = Number(target.getAttribute("data-delta") || "0");
      const dSign = (delta > 0 ? "+" : (delta < 0 ? "−" : "±"));
      const dClass = delta > 0 ? "delta-red" : (delta < 0 ? "delta-green" : "");
      const label = target.getAttribute("data-label") || "";
      tip.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="analytics-dot" style="background:${target.getAttribute("data-color")}"></span>
          <strong>${escapeHtml(site)}</strong>
        </div>
        <div>${escapeHtml(date)}</div>
        <div>Price: <strong>${price}</strong></div>
        <div>Change: <strong class="${dClass}">${dSign}${Math.abs(delta).toFixed(2)}</strong></div>
        ${label ? `<div>Label: <em>${escapeHtml(label)}</em></div>` : ``}
      `;
    }
  });
  svgEl.addEventListener("pointermove", (e)=>{
    if (tip.style.display === "block") {
      tip.style.left = `${e.clientX}px`;
      tip.style.top  = `${e.clientY}px`;
    }
  });
  svgEl.addEventListener("pointerout", (e)=>{
    if (e.target && e.target.classList.contains("marker")) {
      tip.style.display = "none";
    }
  });
}
