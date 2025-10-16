// comparison.js — Matching-style filters + comparison rendering with true per-page control
// - Search (SKU/Name/Barcode)
// - Tag filter (id="tagFilter" + tag_id param)
// - Brand free text + Brand dropdown (same as Matching)
// - Price status dropdown (All / Ours lower / Ours higher)
// - All-sites default; N/A ignored for highlighting; spinner + green-text toasts
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
let lastRows = [];    // raw rows from /api/compare
let lastSite = "all";
let lastTag  = "";

// Per-page comes from the input, default to 50 if empty/invalid.
function perPage() {
  const n = Number(compareLimit?.value || 50);
  return Number.isFinite(n) && n > 0 ? Math.floor(Math.min(n, 2000)) : 50;
}

// ---------------- CSS (spinner, highlights) ----------------
(function injectCSS(){
  if (document.getElementById("compare-extra-css")) return;
  const s = document.createElement("style");
  s.id = "compare-extra-css";
  s.textContent = `
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    .spin { animation: spin .9s linear infinite }
    .compare-img{max-height:48px;max-width:80px;border-radius:6px}
    td.green{ background:rgba(22,163,74,.15) }
    td.red{ background:rgba(220,38,38,.12) }
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
    // centered top; stacked
    wrap.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none";
    document.body.appendChild(wrap);
  }
  const box = document.createElement("div");
  box.textContent = msg;
  // green TEXT (not background) for normal; red text for error
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
// Highlight: green = equal to min of available; red = above min; N/A ignored
function classForValue(value, candidates) {
  const v = toNum(value);
  const nums = candidates.map(toNum).filter(n => n !== null);
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
  if (!rowNorm) return false;            // only exclude if we actively filter
  return rowNorm.includes(filtNorm);     // substring like in Matching
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
        brand: r.product_brand || r.brand || null,   // ensure brand travels in payload
        tags:  r.product_tags || r.tags || null,     // allow client tag fallback like Matching
        praktis_price: toNum(r.product_price_regular),
        praktiker_price: null, praktiker_url: null,
        mrbricolage_price: null, mrbricolage_url: null,
        mashinibg_price: null, mashinibg_url: null,
      });
    }
    const agg = map.get(sku);
    const site = (r.competitor_site || "").toLowerCase();
    const compPrice = toNum(r.competitor_price_regular);
    if (site.includes("praktiker")) {
      agg.praktiker_price = compPrice;
      agg.praktiker_url   = r.competitor_url || null;
    } else if (site.includes("bricol")) {
      agg.mrbricolage_price = compPrice;
      agg.mrbricolage_url   = r.competitor_url || null;
    } else if (site.includes("mashin") || site === "mashinibg") {
      agg.mashinibg_price = compPrice;
      agg.mashinibg_url   = r.competitor_url || null;
    }
  }
  return Array.from(map.values());
}

// ---------------- Price status (for filters) ----------------
function statusSingle(row) {
  const our = toNum(row.product_price_regular);
  const comp = toNum(row.competitor_price_regular);
  if (our === null || comp === null) return "na";
  if (our < comp) return "better";
  if (our > comp) return "worse";
  return "equal";
}
function statusAll(p) {
  const our = toNum(p.praktis_price);
  const comps = [p.praktiker_price, p.mrbricolage_price, p.mashinibg_price].map(toNum).filter(v => v !== null);
  if (our === null || comps.length === 0) return "na";
  const minComp = Math.min(...comps);
  if (our < minComp) return "better";
  if (our > minComp) return "worse";
  return "equal";
}

// ---------------- Renderers ----------------
function renderSingle(rows, site, assetsBySku) {
  const headers = site === "praktiker" ? [
      "Praktis Code","Image","Praktis Name","Praktiker Code","Praktiker Name",
      "Praktis Regular Price","Praktiker Regular Price","Praktis Promo Price","Praktiker Promo Price",
    ] : site === "mrbricolage" ? [
      "Praktis Code","Image","Praktis Name","MrBricolage Code","MrBricolage Name",
      "Praktis Regular Price","MrBricolage Regular Price","Praktis Promo Price","MrBricolage Promo Price",
    ] : [
      "Praktis Code","Image","Praktis Name","OnlineMashini Code","OnlineMashini Name",
      "Praktis Regular Price","OnlineMashini Regular Price","Praktis Promo Price","OnlineMashini Promo Price",
    ];
  resetHead(headers);

  const html = rows.map(r => {
    const ourReg   = toNum(r.product_price_regular);
    const theirReg = toNum(r.competitor_price_regular);

    const compName = r.competitor_name || "N/A";
    const compLink = r.competitor_url
      ? `<a href="${escapeHtml(r.competitor_url)}" target="_blank" rel="noopener">${escapeHtml(compName)}</a>`
      : escapeHtml(compName);

    const asset = assetsBySku[r.product_sku] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const clsOur  = classForValue(ourReg,   [ourReg, theirReg]);
    const clsComp = classForValue(theirReg, [ourReg, theirReg]);

    return `
      <tr>
        <td>${escapeHtml(r.product_sku ?? "")}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(r.product_name ?? "N/A")}</a>` : escapeHtml(r.product_name ?? "N/A")}</td>
        <td>${escapeHtml(r.competitor_sku ?? "")}</td>
        <td>${compLink}</td>
        <td class="${clsOur}">${fmtPrice(ourReg)}</td>
        <td class="${clsComp}">${fmtPrice(theirReg)}</td>
        <td>${fmtPrice(r.product_price_promo)}</td>
        <td>${fmtPrice(r.competitor_price_promo)}</td>
      </tr>`;
  }).join("");
  tbody.innerHTML = html;
}

function renderAllPage(pivotPage, assetsBySku) {
  resetHead([
    "Praktis Code","Image","Praktis Name",
    "Praktis Regular Price","Praktiker Regular Price","MrBricolage Regular Price","OnlineMashini Regular Price",
  ]);

  const html = pivotPage.map(p => {
    const allVals = [p.praktis_price, p.praktiker_price, p.mrbricolage_price, p.mashinibg_price];
    const clsP   = classForValue(p.praktis_price, allVals);
    const clsK   = classForValue(p.praktiker_price, allVals);
    const clsM   = classForValue(p.mrbricolage_price, allVals);
    const clsMash= classForValue(p.mashinibg_price, allVals);

    const asset = assetsBySku[p.code] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const cell = (price, url, cls) => {
      const text = fmtPrice(price);
      const inner = url ? `${text} <a href="${escapeHtml(url)}" target="_blank" rel="noopener">↗</a>` : text;
      return `<td class="${cls}">${inner}</td>`;
    };

    return `
      <tr>
        <td>${escapeHtml(p.code)}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
        ${cell(p.praktis_price,      null,            clsP)}
        ${cell(p.praktiker_price,    p.praktiker_url, clsK)}
        ${cell(p.mrbricolage_price,  p.mrbricolage_url, clsM)}
        ${cell(p.mashinibg_price,    p.mashinibg_url, clsMash)}
      </tr>`;
  }).join("");
  tbody.innerHTML = html;
}

function clampPage(totalItems) {
  const pages = Math.max(1, Math.ceil(totalItems / perPage()));
  if (page > pages) page = pages;
  if (page < 1) page = 1;
  return pages;
}

function setPageInfo(pageCount, sliceCount, total) {
  if (!pageInfo) return;
  pageInfo.textContent = `Page ${page} / ${pageCount} (rows: ${sliceCount} of ${total})`;
}

// ---------------- Main load ----------------
async function loadCore(refetch=true) {
  const site_code = siteSelect?.value || "all";

  // When we (re)fetch from the server, pull a large enough window (2000) to cover any client-side perPage.
  // The input controls only pagination on the client.
  if (refetch || site_code !== lastSite || (tagFilter?.value ?? "") !== lastTag) {
    const tagVal = tagFilter?.value ?? "";
    const q      = (searchInput?.value || "").trim();
    const brand  = currentBrandFilter();
    lastRows = await fetchCompare({ site_code, limit: 2000, source: "snapshots", tag_id: tagVal, brand, q }) || [];
    lastSite = site_code; lastTag = tagVal; page = 1;
  }

  const qText     = (searchInput?.value || "").trim().toLowerCase();
  const brandRaw  = currentBrandFilter();
  const priceF    = (priceSelect?.value || "");
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
    const pages = clampPage(total);
    const start = (page - 1) * perPage(), end = start + perPage();
    const slice = pivot.slice(start, end);
    const assets = await fetchAssetsForSkus(slice.map(p => p.code));
    renderAllPage(slice, assets);
    setPageInfo(pages, slice.length, total);
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
    const pages = clampPage(total);
    const start = (page - 1) * perPage(), end = start + perPage();
    const slice = rows.slice(start, end);
    const assets = await fetchAssetsForSkus(slice.map(r => r.product_sku).filter(Boolean));
    renderSingle(slice, site_code, assets);
    setPageInfo(pages, slice.length, total);
  }
}

// ---------------- Init & Events ----------------
async function init() {
  // Sites -> ensure "All sites" exists and is default
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

  // Tags — same as Matching
  await loadTagsInto(tagFilter, true);
  tagFilter.addEventListener("change", () => { page = 1; loadCore(true); });

  // Brands — same as Matching
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

  // IMPORTANT: do NOT override the input's value (don't force 50) — it comes from HTML. :contentReference[oaicite:1]{index=1}
  // When user changes the per-page input, re-render and clamp page.
  if (compareLimit) {
    compareLimit.addEventListener("change", () => { page = 1; loadCore(false); });
    compareLimit.addEventListener("input",  () => { /* live feel without refetch */ loadCore(false); });
  }

  // Buttons & pager — spinner + green-text toasts
  const onLoadLatest = withSpinner(loadLatestBtn, "Loading…", async () => { await loadCore(true); toast("Loaded latest data from DB"); });
  const onScrapeNow  = withSpinner(scrapeNowBtn,  "Scraping…", async () => {
    const site_code = siteSelect.value || "all";
    const limit = Number(compareLimit?.value || 50);
    await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(site_code)}&limit=${encodeURIComponent(limit)}`, { method: "POST" });
    await loadCore(true);
    toast("Scrape finished");
  });

  loadLatestBtn?.addEventListener("click", () => { page = 1; onLoadLatest(); });
  scrapeNowBtn?.addEventListener("click", () => { page = 1; onScrapeNow(); });
  prevPageBtn?.addEventListener("click", () => { page = Math.max(1, page - 1); loadCore(false); });
  nextPageBtn?.addEventListener("click", () => { page = page + 1; loadCore(false); });

  // First render
  await loadCore(true);
}

init().catch(e => { console.error("Comparison init failed:", e); toast("Init failed", "error"); });
