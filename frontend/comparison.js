// comparison.js — stacked old/new price; Praktiker label inline next to arrow in same cell
// Keeps Email + Export buttons and all existing filters/controls intact.
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

// ---------------- State ----------------
let page = 1;
const PER_PAGE = 50;
let lastRows = [];    // raw rows from /api/compare
let lastSite = "all";
let lastTag  = "";

// ---------------- CSS (spinner, highlights, stacked price with inline badge) ----------------
(function injectCSS(){
  if (document.getElementById("compare-extra-css")) return;
  const s = document.createElement("style");
  s.id = "compare-extra-css";
  s.textContent = `
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    .spin { animation: spin .9s linear infinite }
    .compare-img{max-height:48px;max-width:80px;border-radius:6px}
    td.green{ background:rgba(22,163,74,.15) !important }
    td.red{ background:rgba(220,38,38,.12) !important }

    /* Stacked price: old (top, crossed) + new (bottom, bold) */
    .price-wrap{
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      line-height:1.15; text-align:center; white-space:nowrap;
      font-family: Inter, "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, "Noto Sans", "Liberation Sans", "Apple Color Emoji", "Segoe UI Emoji";
      font-variant-numeric: tabular-nums;
    }
    .price-old{font-size:12px;color:#93a1c6;text-decoration:line-through;opacity:.9}
    .price-line{display:inline-flex; align-items:center; gap:6px;}
    .price-new{font-weight:800}
    .price-link{ text-decoration:none }

    /* Tiny inline badge (label) */
    .price-badge{
      font-size:11px; font-weight:700; letter-spacing:.3px;
      border:1px solid var(--border); border-radius:999px;
      padding:2px 6px;
      background:#fff1e2; color:#8d4a12;
    }
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

// ---------------- Utils (effective price + unified cell) ----------------
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
  // default: initial letters
  return s.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 3);
}

// ---- Read label ONLY from competitor_label to match your DB/API ----
function getRowLabel(row) {
  const v = row && row.competitor_label;
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}

// unified price block (stacked old/new; label inline with arrow on the new-price line)
function priceCellHTML(promo, regular, url=null, labelText=null) {
  const eff = effective(promo, regular);
  const showOld = (toNum(regular) !== null && toNum(promo) !== null && toNum(promo) < toNum(regular));
  const oldStr  = showOld ? fmtPlain(regular) : "";
  const newStr  = fmtPlain(eff);
  const link = url ? `<a class="price-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">↗</a>` : "";
  const badge = labelText ? `<span class="price-badge" title="${escapeHtml(labelText)}">${escapeHtml(abbrLabel(labelText))}</span>` : "";
  return `
    <div class="price-wrap">
      ${showOld ? `<span class="price-old">${oldStr}</span>` : ``}
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

// ---- Matching-style brand helpers (exact same normalization) ----
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

// ---------------- Pivot (All sites) — keep promo+regular and praktiker label ----------------
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
        mrbricolage_regular: null, mrbricolage_promo: null, mrbricolage_url: null,
        mashinibg_regular: null, mashinibg_promo: null, mashinibg_url: null,
      });
    }
    const agg = map.get(sku);
    const site = (r.competitor_site || "").toLowerCase();
    const compReg = toNum(r.competitor_price_regular);
    const compPro = toNum(r.competitor_price_promo);
    const url = r.competitor_url || null;

    if (site.includes("praktiker")) {
      agg.praktiker_regular = compReg; agg.praktiker_promo = compPro; agg.praktiker_url = url;
      agg.praktiker_label = getRowLabel(r); // ONLY competitor_label
    } else if (site.includes("bricol")) {
      agg.mrbricolage_regular = compReg; agg.mrbricolage_promo = compPro; agg.mrbricolage_url = url;
    } else if (site.includes("mashin") || site === "mashinibg") {
      agg.mashinibg_regular = compReg; agg.mashinibg_promo = compPro; agg.mashinibg_url = url;
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

// ---------------- Renderers (stacked price + Praktiker inline label) ----------------
function renderSingle(rows, site, assetsBySku) {
  const headers = site === "praktiker" ? [
      "Praktis Code","Image","Praktis Name","Praktiker Code","Praktiker Name",
      "Praktis Price","Praktiker Price",
    ] : site === "mrbricolage" ? [
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

    // Praktiker label from exact competitor_label field
    const competitorLabel = (site === "praktiker") ? getRowLabel(r) : null;

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
  resetHead([
    "Praktis Code","Image","Praktis Name",
    "Praktis Price","Praktiker Price","MrBricolage Price","OnlineMashini Price",
  ]);

  const html = pivotPage.map(p => {
    const effP   = effective(p.praktis_promo, p.praktis_regular);
    const effK   = effective(p.praktiker_promo, p.praktiker_regular);
    const effM   = effective(p.mrbricolage_promo, p.mrbricolage_regular);
    const effMash= effective(p.mashinibg_promo, p.mashinibg_regular);

    const allEff = [effP, effK, effM, effMash];

    const clsP   = classForEffective(effP, allEff);
    const clsK   = classForEffective(effK, allEff);
    const clsM   = classForEffective(effM, allEff);
    const clsMash= classForEffective(effMash, allEff);

    const asset = assetsBySku[p.code] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const cell = (promo, regular, url, cls, label=null) =>
      `<td class="${cls}">${priceCellHTML(promo, regular, url, label)}</td>`;

    return `
      <tr>
        <td>${escapeHtml(p.code)}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
        ${cell(p.praktis_promo,      p.praktis_regular,      null,            clsP)}
        ${cell(p.praktiker_promo,    p.praktiker_regular,    p.praktiker_url, clsK, p.praktiker_label || null)}
        ${cell(p.mrbricolage_promo,  p.mrbricolage_regular,  p.mrbricolage_url, clsM)}
        ${cell(p.mashinibg_promo,    p.mashinibg_regular,    p.mashinibg_url, clsMash)}
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
    const price_status = price === "better" ? "ours_lower" : price === "worse" ? "ours_higher" : "";

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

    window.location = `${API}/api/export/compare.xlsx?${params.toString()}`;
  }
  (document.getElementById("exportExcel") || document.querySelector("[data-export], .export"))
    ?.addEventListener("click", exportViaBackend);

  // First render
  await loadCore(true);
}

init().catch(e => { console.error("Comparison init failed:", e); toast("Init failed", "error"); });
