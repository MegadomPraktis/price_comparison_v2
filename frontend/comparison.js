// comparison.js — stacked price with consistent alignment; Praktiker label inline
import { API, loadSitesInto, loadTagsInto, escapeHtml, fmtPrice } from "./shared.js";

// ---------------- DOM ----------------
const siteSelect      = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
const loadLatestBtn   = document.getElementById("loadLatest");
const scrapeNowBtn    = document.getElementById("scrapeNow");
const compareLimit    = document.getElementById("compareLimit");

// IMPORTANT: same id as in matching.html
const tagFilter       = document.getElementById("tagFilter");

const table  = document.getElementById("compareTable");
const thead  = table.querySelector("thead") || table.createTHead();
const tbody  = table.querySelector("tbody") || table.appendChild(document.createElement("tbody"));

const pageInfo   = document.getElementById("pageInfo");
const prevPageBtn= document.getElementById("prevPage");
const nextPageBtn= document.getElementById("nextPage");

// ---------------- Toolbar (inject if missing) ----------------
const toolbar = document.querySelector(".toolbar");

// Search input (SKU/Name/Barcode)
let searchInput = document.getElementById("searchInput");
if (!searchInput) {
  searchInput = document.createElement("input");
  searchInput.id = "searchInput";
  searchInput.placeholder = "Search SKU/Name/Barcode…";
  toolbar?.appendChild(searchInput);
}

// Brand free text — same id as Matching
let brandInput = document.getElementById("brandInput");
if (!brandInput) {
  brandInput = document.createElement("input");
  brandInput.id = "brandInput";
  brandInput.placeholder = "Brand…";
  toolbar?.appendChild(brandInput);
}

// Brand dropdown — same id as Matching
let brandSelect = document.getElementById("brandSelect");
if (!brandSelect) {
  brandSelect = document.createElement("select");
  brandSelect.id = "brandSelect";
  toolbar?.appendChild(brandSelect);
}
function ensureBrandPlaceholder() {
  let opt = brandSelect.querySelector("option[value='']");
  if (!opt) {
    opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— Brands —";
    brandSelect.insertBefore(opt, brandSelect.firstChild);
  } else {
    opt.textContent = "— Brands —";
  }
}

// Price status dropdown (All / Ours lower / Ours higher)
let priceSelect = document.getElementById("priceStatus");
if (!priceSelect) {
  priceSelect = document.createElement("select");
  priceSelect.id = "priceStatus";
  [["", "All"], ["better", "Ours lower"], ["worse", "Ours higher"]].forEach(([v,l]) => {
    const o = document.createElement("option"); o.value=v; o.textContent=l; priceSelect.appendChild(o);
  });
  toolbar?.appendChild(priceSelect);
}

// --- Praktis presence dropdown (All / On site / Not on site)
let praktisPresence = document.getElementById("praktisPresence");
if (!praktisPresence) {
  praktisPresence = document.createElement("select");
  praktisPresence.id = "praktisPresence";
  praktisPresence.innerHTML = `
    <option value="">All products</option>
    <option value="present">Products on Praktis website</option>
    <option value="missing">Products NOT on Praktis website</option>
  `;
  toolbar?.appendChild(praktisPresence);
}

/* ────────────────────────────────────────────────────────────────────────────
   ALL-SITES COLUMNS PICKER (UI popover) — Praktis fixed; competitors toggle/reorder
   ──────────────────────────────────────────────────────────────────────────── */
const COLS_KEY = "compare_cols_v1";
const ALL_COLS = ["praktiker","mrbricolage","mashinibg"];
const COL_LABELS = {
  praktiker:   "Praktiker",
  mrbricolage: "MrBricolage",
  mashinibg:   "OnlineMashini",
};
const COL_META = {
  praktiker:   { promo: "praktiker_promo",   regular: "praktiker_regular",   url: "praktiker_url",   label: "praktiker_label" },
  mrbricolage: { promo: "mrbricolage_promo", regular: "mrbricolage_regular", url: "mrbricolage_url", label: "mrbricolage_label" },
  mashinibg:   { promo: "mashinibg_promo",   regular: "mashinibg_regular",   url: "mashinibg_url",   label: "mashinibg_label" },
};
function loadCols() {
  try {
    const raw = localStorage.getItem(COLS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) {
      const valid = arr.filter(k => ALL_COLS.includes(k));
      if (valid.length) return valid;
    }
  } catch {}
  return [...ALL_COLS]; // default all on
}
function saveCols(order) {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(order)); } catch {}
}
let colOrder = loadCols();

// Pretty popover UI
let colWrap = document.getElementById("colWrap"); // NEW
let colBtn  = document.getElementById("colBtn");
let colMenu = document.getElementById("colMenu");
(function ensureColMenu(){
  if (!toolbar) return;
  // Add a relative container so the popover positions nicely
  toolbar.style.position = toolbar.style.position || "relative";

  // NEW: wrapper to anchor menu below the button
  if (!colWrap) {
    colWrap = document.createElement("div");
    colWrap.id = "colWrap";
    colWrap.className = "col-wrap";
    toolbar.appendChild(colWrap);
  }

  if (!colBtn) {
    colBtn = document.createElement("button");
    colBtn.id = "colBtn";
    colBtn.className = "col-btn";
    colBtn.type = "button";
    colBtn.innerHTML = `Columns ▾`;
    colWrap.appendChild(colBtn); // was toolbar.appendChild
  } else {
    // ensure inside wrapper
    colWrap.appendChild(colBtn);
  }

  if (!colMenu) {
    colMenu = document.createElement("div");
    colMenu.id = "colMenu";
    colMenu.className = "col-menu";
    colMenu.style.display = "none";
    colWrap.appendChild(colMenu); // was toolbar.appendChild
  } else {
    colWrap.appendChild(colMenu);
  }
  renderColMenu();
})();
function renderColMenu(){
  if (!colMenu) return;
  const enabled = new Set(colOrder);
  // Menu order: enabled (in saved order) first, then disabled alphabetically
  const keys = [...colOrder, ...ALL_COLS.filter(k => !enabled.has(k)).sort((a,b)=>COL_LABELS[a].localeCompare(COL_LABELS[b]))];

  const rows = keys.map(k => {
    const checked = enabled.has(k) ? "checked" : "";
    const upDisabled   = enabled.has(k) && colOrder.indexOf(k) <= 0;
    const downDisabled = enabled.has(k) && colOrder.indexOf(k) >= colOrder.length - 1;
    return `
      <div class="col-row" data-key="${k}">
        <label class="col-left">
          <input type="checkbox" ${checked} />
          <span>${COL_LABELS[k]}</span>
        </label>
        <span class="col-actions">
          <button class="col-up" ${(!enabled.has(k) || upDisabled) ? "disabled" : ""} title="Move up">↑</button>
          <button class="col-dn" ${(!enabled.has(k) || downDisabled) ? "disabled" : ""} title="Move down">↓</button>
        </span>
      </div>`;
  }).join("");

  colMenu.innerHTML = `
    <div class="col-title">Competitor columns</div>
    ${rows || `<div class="muted">No columns selected</div>`}
    <div class="col-footer">
      <button class="col-all" type="button">Select all</button>
      <button class="col-reset" type="button">Reset</button>
    </div>
  `;

  // Wire events (keep popover open -> stopPropagation)
  colMenu.querySelectorAll(".col-row input[type=checkbox]").forEach(inp=>{
    inp.addEventListener("change", (e)=>{
      e.stopPropagation(); // keep open
      const key = e.target.closest(".col-row").dataset.key;
      if (e.target.checked) {
        if (!colOrder.includes(key)) colOrder.push(key);
      } else {
        colOrder = colOrder.filter(k => k !== key);
      }
      saveCols(colOrder);
      renderColMenu();
      page = 1; loadCore(false);
    });
  });
  colMenu.querySelectorAll(".col-up").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation(); // keep open
      const key = btn.closest(".col-row").dataset.key;
      const i = colOrder.indexOf(key);
      if (i > 0) {
        const [m] = colOrder.splice(i,1);
        colOrder.splice(i-1,0,m);
        saveCols(colOrder);
        renderColMenu();
        page = 1; loadCore(false);
      }
    });
  });
  colMenu.querySelectorAll(".col-dn").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation(); // keep open
      const key = btn.closest(".col-row").dataset.key;
      const i = colOrder.indexOf(key);
      if (i >= 0 && i < colOrder.length-1) {
        const [m] = colOrder.splice(i,1);
        colOrder.splice(i+1,0,m);
        saveCols(colOrder);
        renderColMenu();
        page = 1; loadCore(false);
      }
    });
  });
  colMenu.querySelector(".col-all")?.addEventListener("click", (e)=>{
    e.stopPropagation(); // keep open
    colOrder = [...ALL_COLS];
    saveCols(colOrder);
    renderColMenu();
    page = 1; loadCore(false);
  });
  colMenu.querySelector(".col-reset")?.addEventListener("click", (e)=>{
    e.stopPropagation(); // keep open
    colOrder = [...ALL_COLS];
    saveCols(colOrder);
    renderColMenu();
    page = 1; loadCore(false);
  });
}
// open/close popover
colBtn?.addEventListener("click", (e)=>{
  e.stopPropagation();
  if (!colMenu) return;
  colMenu.style.display = (colMenu.style.display === "none") ? "block" : "none";
});
// close on outside click
document.addEventListener("click", (e)=>{
  if (!colMenu || !colBtn) return;
  if (colMenu.style.display === "none") return;
  if (colMenu.contains(e.target) || colBtn.contains(e.target)) return;
  colMenu.style.display = "none";
});

// ---------------- State ----------------
let page = 1;
const PER_PAGE = 50;
let lastRows = [];    // raw rows from /api/compare
let lastSite = "all";
let lastTag  = "";

// ---------------- CSS (spinner, highlights, price grid, badge, alignment) ----------------
(function injectCSS(){
  if (document.getElementById("compare-extra-css")) return;
  const s = document.createElement("style");
  s.id = "compare-extra-css";
  s.textContent = `
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    .spin { animation: spin .9s linear infinite }
    .compare-img{max-height:48px;max-width:80px;border-radius:6px}
    td.green{ background:rgba(22,163,74,.14) !important }
    td.red{ background:rgba(220,38,38,.12) !important }

    /* Two-row grid ensures perfect alignment across all cells */
    .price-wrap{
      display:grid;
      grid-template-rows: 14px 22px;   /* top: old, bottom: current+icons */
      align-items:center;
      justify-items:center;
      row-gap:2px;
      min-height: 44px;                /* consistent cell height */
      line-height:1.1;
      text-align:center;
      white-space:nowrap;
      font-variant-numeric: tabular-nums;
      font-family: Inter, "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, "Noto Sans", "Liberation Sans", "Apple Color Emoji", "Segoe UI Emoji";
    }
    /* Old price row (always occupies a row; may be hidden to keep height) */
    .price-old{ font-size:11px; color:#9aa3b2; text-decoration:line-through; }
    .price-old.hidden{ visibility:hidden; } /* keeps row height without showing */
    /* Current price line (price + arrow + badge) */
    .price-line{ display:inline-flex; align-items:center; gap:6px; }
    .price-new{ font-weight:800; font-size:15px; letter-spacing:.2px; }
    .price-link{ text-decoration:none; font-size:12px; line-height:1; }
    .price-badge{
      font-size:10px; font-weight:700; letter-spacing:.3px;
      border:1px solid var(--border); border-radius:999px;
      padding:1px 6px;
      background:#fff1e2; color:#8d4a12;
    }

    /* --- Columns popover --- */
    .col-wrap{ position:relative; display:inline-block; } /* NEW */
    .col-btn{
      display:inline-flex; align-items:center; gap:.25rem;
      padding:6px 10px; border-radius:10px; border:1px solid var(--border);
      background:#fff; cursor:pointer; margin-left:.5rem;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .col-btn:hover{ background:#f9fafb; }
    .col-menu{
      position:absolute;
      top: calc(100% + 8px); /* sit right under the button */
      left: 0;
      background:#fff; border:1px solid var(--border); border-radius:12px;
      box-shadow: 0 12px 24px rgba(0,0,0,.15);
      padding:8px; width:240px; z-index:30;
    }
    .col-title{ font-weight:700; font-size:12px; color:#374151; padding:6px 6px 4px; }
    .col-row{
      display:flex; align-items:center; justify-content:space-between;
      gap:8px; padding:6px 6px; border-radius:8px;
    }
    .col-row:hover{ background:#f5f7fb; }
    .col-left{ display:flex; align-items:center; gap:.5rem; cursor:pointer; }
    .col-left input{ width:16px; height:16px; }
    .col-actions button{
      border:1px solid var(--border); background:#fff; border-radius:8px;
      padding:2px 8px; cursor:pointer;
    }
    .col-actions button:disabled{ opacity:.35; cursor:default; }
    .col-footer{
      display:flex; justify-content:space-between; gap:8px; padding:6px;
    }
    .col-footer button{
      border:1px solid var(--border); background:#fff; border-radius:10px;
      padding:6px 10px; cursor:pointer;
    }
    .muted{ font-size:12px; color:#6b7280; padding:6px; }
  `;
  document.head.appendChild(s);
})();

// ---------------- Spinner & Toasts ----------------
function withSpinner(btn, runningText, fn) {
  return async (...args) => {
    if (!btn) return fn(...args);
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:.5rem">
        <svg class="spin" width="16" height="16" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"></circle>
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" stroke-width="3" fill="none"></path>
        </svg>
        ${runningText}
      </span>`;
    try { return await fn(...args); }
    finally { btn.innerHTML = original; btn.disabled = false; }
  };
}
function toast(msg, type="ok") {
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toast-wrap";
    wrap.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none";
    document.body.appendChild(wrap);
  }
  const box = document.createElement("div");
  box.textContent = msg;
  box.style.cssText = "padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:#0f1730;color:#22c55e;min-width:220px;text-align:center;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.35)";
  if (type === "error") { box.style.color="#ef4444"; }
  wrap.appendChild(box);
  setTimeout(() => { try{wrap.removeChild(box);}catch{} }, 2200);
}

// ---------------- Utils ----------------
function resetHead(cols) {
  thead.innerHTML = "";
  const tr = document.createElement("tr");
  tr.innerHTML = cols.map(h => `<th>${escapeHtml(h)}</th>`).join("");
  thead.appendChild(tr);
}
function imgTd(url) {
  if (!url) return `<td>—</td>`;
  return `<td><img src="${escapeHtml(url)}" alt="" loading="lazy" class="compare-img"></td>`;
}
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "n/a" || s.toLowerCase() === "none") return null;
  const n = Number(s.replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
// NO currency suffix in UI cells
function fmtPlain(n) {
  const v = toNum(n);
  if (v === null) return "N/A";
  return v.toFixed(2);
}

function isOnPraktis(url) {
  if (!url) return false;
  const u = String(url).trim();
  return u.startsWith("https://praktis.bg/") && u !== "https://praktis.bg/";
}

// effective price = promo if present else regular
const effective = (promo, regular) => {
  const p = toNum(promo);
  const r = toNum(regular);
  return p !== null ? p : r;
};

// Label shortener (BG)
function abbrLabel(lbl) {
  if (!lbl) return "";
  const s = lbl.trim();
  const map = {
    "Оферта на седмицата": "ОС",
    "Оферта на деня": "ОД",
    "Топ оферта": "ТО",
    "В брошура": "БР",
  };
  if (map[s]) return map[s];
  return s.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 3);
}

// Read label from competitor_label
function getRowLabel(row) {
  const v = row && row.competitor_label;
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

// unified price block (stacked; consistent height; label inline with arrow)
function priceCellHTML(promo, regular, url=null, labelText=null) {
  const eff = effective(promo, regular);
  const showOld = (toNum(regular) !== null && toNum(promo) !== null && toNum(promo) < toNum(regular));
  const oldStr  = showOld ? fmtPlain(regular) : "";
  const newStr  = fmtPlain(eff);
  const link = url ? `<a class="price-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">↗</a>` : "";
  const badge = labelText ? `<span class="price-badge" title="${escapeHtml(labelText)}">${escapeHtml(abbrLabel(labelText))}</span>` : "";
  // Always render an "old" line; hide it when not used to keep row height the same
  const oldEl = `<span class="price-old${showOld ? "" : " hidden"}">${oldStr || "&nbsp;"}</span>`;
  return `
    <div class="price-wrap">
      ${oldEl}
      <span class="price-line">
        <span class="price-new">${newStr}</span>
        ${link}
        ${badge}
      </span>
    </div>
  `;
}

// Highlight using EFFECTIVE prices; N/A ignored
function classForEffective(valEff, allEff) {
  const v = toNum(valEff);
  const nums = allEff.map(toNum).filter(n => n !== null);
  if (v === null || nums.length === 0) return "";
  const min = Math.min(...nums);
  if (v === min) return "green";
  if (v > min) return "red";
  return "";
}

// ---- Matching-style brand helpers ----
const normBrand = (s) => (s || "").toLowerCase().replace(/[.\s]/g, "");
function currentBrandFilter() {
  const raw = (brandSelect.value || brandInput.value || "").trim();
  return raw;
}
function brandMatches(rowBrandRaw, filterRaw) {
  const rowNorm = normBrand(rowBrandRaw);
  const filtNorm = normBrand(filterRaw);
  if (!filtNorm) return true;
  if (!rowNorm) return false;
  return rowNorm.includes(filtNorm);
}

// ---------------- Data fetch ----------------
async function fetchBrands() {
  try {
    const r = await fetch(`${API}/api/products/brands`);
    const brands = r.ok ? await r.json() : [];
    brandSelect.innerHTML = "";
    ensureBrandPlaceholder();
    for (const b of brands) {
      const o = document.createElement("option");
      o.value = b; o.textContent = b;
      brandSelect.appendChild(o);
    }
  } catch {
    ensureBrandPlaceholder();
  }
}

async function fetchAssetsForSkus(skus) {
  if (!skus?.length) return {};
  const qs = encodeURIComponent(skus.join(","));
  const r = await fetch(`${API}/api/products/assets?skus=${qs}`);
  if (!r.ok) { console.warn("assets fetch failed", await r.text()); return {}; }
  return r.json();
}

// IMPORTANT: follow Matching’s query param names: q, tag_id, brand
async function fetchCompare({ site_code, limit, source="snapshots", tag_id=null, brand=null, q=null }) {
  const params = new URLSearchParams();
  params.set("site_code", site_code);
  params.set("limit", String(limit));
  params.set("source", source);
  if (tag_id && tag_id !== "all" && tag_id !== "") params.set("tag_id", tag_id);
  if (brand && brand.trim()) params.set("brand", brand);
  if (q && q.trim()) params.set("q", q.trim());
  const r = await fetch(`${API}/api/compare?${params.toString()}`);
  if (!r.ok) throw new Error(`compare HTTP ${r.status}`);
  return r.json();
}

// ---------------- Pivot (All sites) ----------------
function pivotAll(flatRows) {
  const map = new Map();
  for (const r of flatRows) {
    const sku = r.product_sku ?? "";
    if (!sku) continue;
    if (!map.has(sku)) {
      map.set(sku, {
        code: sku,
        name: r.product_name ?? "N/A",
        brand: r.product_brand || r.brand || null,
        tags:  r.product_tags || r.tags || null,

        praktis_regular: toNum(r.product_price_regular),
        praktis_promo:   toNum(r.product_price_promo),

        praktiker_regular: null, praktiker_promo: null, praktiker_url: null, praktiker_label: null,
        mrbricolage_regular: null, mrbricolage_promo: null, mrbricolage_url: null, mrbricolage_label: null,
        mashinibg_regular: null, mashinibg_promo: null, mashinibg_url: null, mashinibg_label: null,
      });
    }
    const agg = map.get(sku);
    const site = (r.competitor_site || "").toLowerCase();
    const compReg = toNum(r.competitor_price_regular);
    const compPro = toNum(r.competitor_price_promo);
    const url = r.competitor_url || null;

    if (site.includes("praktiker")) {
      agg.praktiker_regular = compReg; agg.praktiker_promo = compPro; agg.praktiker_url = url;
      agg.praktiker_label = getRowLabel(r);
    } else if (site.includes("bricol")) {
      agg.mrbricolage_regular = compReg; agg.mrbricolage_promo = compPro; agg.mrbricolage_url = url;
      agg.mrbricolage_label   = getRowLabel(r);
    } else if (site.includes("mashin") || site === "mashinibg") {
      agg.mashinibg_regular = compReg; agg.mashinibg_promo = compPro; agg.mashinibg_url = url;
      agg.mashinibg_label   = getRowLabel(r);
    }
  }
  return Array.from(map.values());
}

// ---------------- Price status filters use EFFECTIVE prices ----------------
function statusSingle(row) {
  const our = effective(row.product_price_promo, row.product_price_regular);
  const comp = effective(row.competitor_price_promo, row.competitor_price_regular);
  if (our === null || comp === null) return "na";
  if (our < comp) return "better";
  if (our > comp) return "worse";
  return "equal";
}
function statusAll(p) {
  const our = effective(p.praktis_promo, p.praktis_regular);
  const comps = [
    effective(p.praktiker_promo, p.praktiker_regular),
    effective(p.mrbricolage_promo, p.mrbricolage_regular),
    effective(p.mashinibg_promo, p.mashinibg_regular),
  ].filter(v => v !== null);
  if (our === null || comps.length === 0) return "na";
  const minComp = Math.min(...comps);
  if (our < minComp) return "better";
  if (our > minComp) return "worse";
  return "equal";
}

function renderSingle(rows, site, assetsBySku) {
  const presenceMode = (document.getElementById("praktisPresence")?.value || "");
    if (presenceMode) {
      rows = rows.filter(r => {
        const a = assetsBySku[r.product_sku] || {};
        const onSite = isOnPraktis(a.product_url || "");
        return presenceMode === "present" ? onSite : !onSite;
      });
    }
  const siteKey = (site || "").toLowerCase();
  const isPrak  = siteKey.includes("praktiker");
  const isMash  = siteKey.includes("mashin");
  const isBric  = siteKey.includes("bricol");

  const headers = isPrak ? [
      "Praktis Code","Image","Praktis Name","Praktiker Code","Praktiker Name",
      "Praktis Price","Praktiker Price",
    ] : siteKey.includes("bricol") ? [
      "Praktis Code","Image","Praktis Name","MrBricolage Code","MrBricolage Name",
      "Praktis Price","MrBricolage Price",
    ] : [
      "Praktis Code","Image","Praktis Name","OnlineMashini Code","OnlineMashini Name",
      "Praktis Price","OnlineMashini Price",
    ];
  resetHead(headers);

  const html = rows.map(r => {
    const ourEff   = effective(r.product_price_promo, r.product_price_regular);
    const theirEff = effective(r.competitor_price_promo, r.competitor_price_regular);

    const compName = r.competitor_name || "N/A";
    const compLink = r.competitor_url
      ? `<a href="${escapeHtml(r.competitor_url)}" target="_blank" rel="noopener">${escapeHtml(compName)}</a>`
      : escapeHtml(compName);

    const asset = assetsBySku[r.product_sku] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const clsOur  = classForEffective(ourEff,   [ourEff, theirEff]);
    const clsComp = classForEffective(theirEff, [ourEff, theirEff]);

    // show label for Praktiker and Mashini (any code containing "mashin")
    const competitorLabel = (isPrak || isMash || isBric) ? getRowLabel(r) : null;

    return `
      <tr>
        <td>${escapeHtml(r.product_sku ?? "")}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(r.product_name ?? "N/A")}</a>` : escapeHtml(r.product_name ?? "N/A")}</td>
        <td>${escapeHtml(r.competitor_sku ?? "")}</td>
        <td>${compLink}</td>
        <td class="${clsOur}">${priceCellHTML(r.product_price_promo, r.product_price_regular, null)}</td>
        <td class="${clsComp}">${priceCellHTML(
            r.competitor_price_promo,
            r.competitor_price_regular,
            r.competitor_url || null,
            competitorLabel
        )}</td>
      </tr>`;
  }).join("");
  tbody.innerHTML = html;
}

function renderAllPage(pivotPage, assetsBySku) {
    const presenceMode = (document.getElementById("praktisPresence")?.value || "");
    if (presenceMode) {
      pivotPage = pivotPage.filter(p => {
        const a = assetsBySku[p.code] || {};
        const onSite = isOnPraktis(a.product_url || "");
        return presenceMode === "present" ? onSite : !onSite;
      });
    }

  // ----- Dynamic headers (Praktis fixed + selected competitor columns in order)
  const activeCols = colOrder.slice(); // already filtered by selection
  const headers = [
    "Praktis Code","Image","Praktis Name","Praktis Price",
    ...activeCols.map(k => `${COL_LABELS[k]} Price`)
  ];
  resetHead(headers);

  const html = pivotPage.map(p => {
    const effP   = effective(p.praktis_promo, p.praktis_regular);

    // Build competitor entries in selected order
    const compEntries = activeCols.map(key => {
      const meta = COL_META[key];
      return {
        key,
        eff:   effective(p[meta.promo], p[meta.regular]),
        promo: p[meta.promo],
        reg:   p[meta.regular],
        url:   p[meta.url],
        label: p[meta.label] || null,
      };
    });

    // Highlight scope: only consider Praktis + INCLUDED competitor columns
    const compEff = compEntries.map(e => e.eff).filter(v => v !== null);
    const allEff  = [effP, ...compEff];
    const clsP    = compEff.length ? classForEffective(effP, allEff) : "";

    const asset = assetsBySku[p.code] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const cell = (promo, regular, url, cls, label=null) =>
      `<td class="${cls}">${priceCellHTML(promo, regular, url, label)}</td>`;

    const compCells = compEntries.map(e => {
      const cls = classForEffective(e.eff, allEff);
      return cell(e.promo, e.reg, e.url, cls, e.label);
    }).join("");

    return `
      <tr>
        <td>${escapeHtml(p.code)}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
        ${cell(p.praktis_promo, p.praktis_regular, null, clsP)}
        ${compCells}
      </tr>`;
  }).join("");
  tbody.innerHTML = html;
}

// ---------------- Main load ----------------
async function loadCore(refetch=true) {
  const site_code = siteSelect?.value || "all";
  const limit     = Number(compareLimit?.value || 50);

  if (refetch || site_code !== lastSite || (tagFilter?.value ?? "") !== lastTag) {
    const tagVal = tagFilter?.value ?? "";
    const q      = (searchInput?.value || "").trim();
    const brand  = currentBrandFilter();
    lastRows = await fetchCompare({ site_code, limit, source: "snapshots", tag_id: tagVal, brand, q }) || [];
    lastSite = site_code; lastTag = tagVal; page = 1;
  }

  const qText   = (searchInput?.value || "").trim().toLowerCase();
  const brandRaw= currentBrandFilter();
  const priceF  = (priceSelect?.value || "");
  const selectedTag = tagFilter?.value ?? "";

  if (site_code === "all") {
    let pivot = pivotAll(lastRows);

    if (selectedTag) {
      pivot = pivot.filter(p => {
        const tags = p.tags || [];
        return Array.isArray(tags) ? tags.some(t => String(t.id) === String(selectedTag)) : true;
      });
    }

    if (qText) {
      pivot = pivot.filter(p =>
        (p.code || "").toLowerCase().includes(qText) ||
        (p.name || "").toLowerCase().includes(qText)
      );
    }

    if (brandRaw) {
      pivot = pivot.filter(p => brandMatches(p.brand, brandRaw));
    }

    if (priceF) {
      pivot = pivot.filter(p => statusAll(p) === priceF);
    }

    const total = pivot.length;
    const start = (page - 1) * PER_PAGE, end = start + PER_PAGE;
    const slice = pivot.slice(start, end);
    const assets = await fetchAssetsForSkus(slice.map(p => p.code));
    renderAllPage(slice, assets);
    if (pageInfo) pageInfo.textContent = `Page ${page} / ${Math.max(1, Math.ceil(total / PER_PAGE))} (rows: ${slice.length} of ${total})`;
  } else {
    let rows = lastRows.slice();

    if (selectedTag) {
      rows = rows.filter(r => {
        const tags = r.product_tags || r.tags || [];
        return Array.isArray(tags) ? tags.some(t => String(t.id) === String(selectedTag)) : true;
      });
    }

    if (qText) {
      rows = rows.filter(r =>
        [r.product_sku, r.product_name, r.product_barcode, r.competitor_sku, r.competitor_name]
          .map(x => (x || "").toString().toLowerCase())
          .some(s => s.includes(qText))
      );
    }

    if (brandRaw) {
      rows = rows.filter(r => brandMatches(r.product_brand || r.brand, brandRaw));
    }

    if (priceF) {
      rows = rows.filter(r => statusSingle(r) === priceF);
    }

    const total = rows.length;
    const start = (page - 1) * PER_PAGE, end = start + PER_PAGE;
    const slice = rows.slice(start, end);
    const assets = await fetchAssetsForSkus(slice.map(r => r.product_sku).filter(Boolean));
    renderSingle(slice, site_code, assets);
    if (pageInfo) pageInfo.textContent = `Page ${page} / ${Math.max(1, Math.ceil(total / PER_PAGE))} (rows: ${slice.length} of ${total})`;
  }
}

// ---------------- Init & Events ----------------
async function init() {
  await loadSitesInto(siteSelect);
  if (!siteSelect.querySelector('option[value="all"]')) {
    const opt = document.createElement("option");
    opt.value = "all"; opt.textContent = "All sites";
    siteSelect.insertBefore(opt, siteSelect.firstChild);
  }
  siteSelect.value = "all";
  siteSelect.addEventListener("change", () => { page = 1; loadCore(true); });
  refreshSitesBtn?.addEventListener("click", async () => {
    await loadSitesInto(siteSelect);
    if (!siteSelect.querySelector('option[value="all"]')) {
      const opt = document.createElement("option");
      opt.value = "all"; opt.textContent = "All sites";
      siteSelect.insertBefore(opt, siteSelect.firstChild);
    }
  });

  // Tags
  await loadTagsInto(tagFilter, true);
  tagFilter.addEventListener("change", () => { page = 1; loadCore(true); });

  // Brands
  await fetchBrands();
  brandInput.addEventListener("input", () => { if (brandInput.value) brandSelect.value = ""; page = 1; loadCore(true); });
  brandSelect.addEventListener("change", () => { if (brandSelect.value) brandInput.value = ""; page = 1; loadCore(true); });

  // Search
  let t; searchInput.addEventListener("input", () => {
    clearTimeout(t); t = setTimeout(() => { page = 1; loadCore(false); }, 300);
  });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); page = 1; loadCore(false); }});

  // Price status
  priceSelect.addEventListener("change", () => { page = 1; loadCore(false); });

  // Praktis presence filter
  (document.getElementById("praktisPresence"))?.addEventListener("change", () => {
    page = 1; loadCore(false);
  });

  // Limit default (50 per page)
  if (compareLimit) compareLimit.value = "50";

  // Buttons & pager — spinner + toasts
  const onLoadLatest = withSpinner(loadLatestBtn, "Loading…", async () => { await loadCore(true); toast("Loaded latest data from DB"); });
  const onScrapeNow  = withSpinner(scrapeNowBtn,  "Scraping…", async () => {
    const site_code = siteSelect.value || "all";
    const limit = Number(compareLimit?.value || 50);
    await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(site_code)}&limit=${encodeURIComponent(limit)}`, { method: "POST" });
    await loadCore(true);
    toast("Scrape finished");
  });

  loadLatestBtn?.addEventListener("click", () => { page = 1; onLoadLatest(); });
  scrapeNowBtn?.addEventListener("click",  () => { page = 1; onScrapeNow(); });
  prevPageBtn?.addEventListener("click",   () => { page = Math.max(1, page - 1); loadCore(false); });
  nextPageBtn?.addEventListener("click",   () => { page = page + 1; loadCore(false); });

  // Export current view (unchanged)
  function exportViaBackend() {
    const site_code = siteSelect?.value || "all";
    const tag_id    = (tagFilter?.value || "").trim();

    const q   = (document.getElementById("searchInput")?.value || "").trim();
    const bt  = (document.getElementById("brandInput")?.value || "").trim();
    const bs  = (document.getElementById("brandSelect")?.value || "").trim();
    const brand = bs || bt;

    const price = (document.getElementById("priceStatus")?.value || "").trim(); // "" | better | worse
    const price_status = price === "better" ? "ours_lower" : "ours_higher";

    const per_page = 50;
    const params = new URLSearchParams();
    params.set("site_code", site_code);
    params.set("limit", "2000");
    params.set("source", "snapshots");
    if (tag_id) params.set("tag_id", tag_id);
    if (q) params.set("q", q);
    if (brand) params.set("brand", brand);
    if (price_status) params.set("price_status", price_status);
    if (typeof page !== "undefined") params.set("page", String(page));
    params.set("per_page", String(per_page));

    // --- Praktis presence dropdown (All / On site / Not on site)
    let praktisPresence = document.getElementById("praktisPresence");
    if (!praktisPresence) {
      praktisPresence = document.createElement("select");
      praktisPresence.id = "praktisPresence";
      praktisPresence.innerHTML = `
        <option value="">All products</option>
        <option value="present">Products on Praktis website</option>
        <option value="missing">Products NOT on Praktis website</option>
      `;
      toolbar?.appendChild(praktisPresence);
    }
    praktisPresence.addEventListener("change", () => { page = 1; loadCore(false); });

    window.location = `${API}/api/export/compare.xlsx?${params.toString()}`;
  }
  (document.getElementById("exportExcel") || document.querySelector("[data-export], .export"))
    ?.addEventListener("click", exportViaBackend);

  // First render
  await loadCore(true);
}

init().catch(e => { console.error("Comparison init failed:", e); toast("Init failed", "error"); });
