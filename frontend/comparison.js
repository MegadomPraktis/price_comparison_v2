// comparison.js — tags like matching.js, strict headers, correct td highlights, spinners + toasts
import { API, loadSitesInto, loadTagsInto, escapeHtml, fmtPrice } from "./shared.js";

// ---------------- DOM ----------------
const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");

const loadLatestBtn = document.getElementById("loadLatest");
const scrapeNowBtn = document.getElementById("scrapeNow");
const compareLimit = document.getElementById("compareLimit"); // input the user already has

const tagSelect = document.getElementById("tagSelect");          // tags dropdown
const refreshTagsBtn = document.getElementById("refreshTags");   // ↻ Tags button

const table = document.getElementById("compareTable");
const thead = table.querySelector("thead") || table.createTHead();
let headRow = document.getElementById("compareHeadRow");
if (!headRow) {
  headRow = document.createElement("tr");
  headRow.id = "compareHeadRow";
  thead.appendChild(headRow);
}
const tbody = table.querySelector("tbody") || table.appendChild(document.createElement("tbody"));

// Optional pager controls (if present in your HTML)
const pageInfo = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");

// ---------------- Paging (client-side) ----------------
let page = 1;
const PER_PAGE = 50;  // UI paging size
let lastRows = [];    // last fetched raw rows (flat format from /api/compare)
let lastSite = "all";
let lastTag = "all";

// ---------------- Small UI helpers ----------------
function ensureAllSitesOption() {
  if (!siteSelect) return;
  if (!siteSelect.querySelector('option[value="all"]')) {
    const opt = document.createElement("option");
    opt.value = "all";
    opt.textContent = "All sites";
    siteSelect.insertBefore(opt, siteSelect.firstChild);
  }
}
function ensureAllTagsOption() {
  if (!tagSelect) return;
  if (!tagSelect.querySelector('option[value="all"]')) {
    const opt = document.createElement("option");
    opt.value = "all";
    opt.textContent = "All tags";
    tagSelect.insertBefore(opt, tagSelect.firstChild);
  }
}
function resetHead() {
  thead.innerHTML = "";
  const row = document.createElement("tr");
  row.id = "compareHeadRow";
  thead.appendChild(row);
  return row;
}

// Spinner inside a button
function withSpinner(btn, runningText, fn) {
  return async (...args) => {
    if (!btn) return fn(...args);
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:.5rem">
        <svg class="spin" width="16" height="16" viewBox="0 0 24 24" style="animation:spin 0.9s linear infinite">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25"></circle>
          <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" stroke-width="3" fill="none"></path>
        </svg>
        ${runningText}
      </span>
    `;
    try {
      const out = await fn(...args);
      btn.innerHTML = original;
      btn.disabled = false;
      return out;
    } catch (e) {
      btn.innerHTML = original;
      btn.disabled = false;
      throw e;
    }
  };
}
// inject minimal spinner + highlight CSS once
(function injectSpinCSS(){
  if (document.getElementById("spin-css")) return;
  const s = document.createElement("style");
  s.id = "spin-css";
  s.textContent = `
    @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
    .green{background:rgba(0,128,96,.35)}
    .red{background:rgba(128,0,32,.35)}
    .compare-img{max-height:48px;max-width:80px;border-radius:6px}
  `;
  document.head.appendChild(s);
})();

// Toasts
function toast(msg, type="info") {
  let wrap = document.getElementById("toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toast-wrap";
    wrap.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
    document.body.appendChild(wrap);
  }
  const box = document.createElement("div");
  box.textContent = msg;
  box.style.cssText =
    "padding:10px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);font-weight:600;min-width:200px;" +
    (type === "error"
      ? "background:#4f1e27;color:#ffd7df;border:1px solid #9c2b3b;"
      : "background:#12322b;color:#d9fff3;border:1px solid #2f8f7b;");
  wrap.appendChild(box);
  setTimeout(() => box.remove(), 2600);
}

// ---------------- Headers (now with Image after Praktis Code) ----------------
function setHeadersAll() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
    "Image",                      // NEW
    "Praktis Name",
    "Praktis Price",
    "Praktiker Price",
    "MrBricolage Price",
    "OnlineMashini Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}
function setHeadersPraktiker() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
    "Image",                      // NEW
    "Praktiker Code",
    "Praktis Name",
    "Praktiker Name",
    "Praktis Regular Price",
    "Praktiker Regular Price",
    "Praktis Promo Price",
    "Praktiker Promo Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}
function setHeadersMrBricolage() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
    "Image",                      // NEW
    "MrBricolage Code",
    "Praktis Name",
    "MrBricolage Name",
    "Praktis Regular Price",
    "MrBricolage Regular Price",
    "Praktis Promo Price",
    "MrBricolage Promo Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}
function setHeadersMashiniBg() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
    "Image",                      // NEW
    "OnlineMashini Code",
    "Praktis Name",
    "OnlineMashini Name",
    "Praktis Regular Price",
    "OnlineMashini Regular Price",
    "Praktis Promo Price",
    "OnlineMashini Promo Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}

// ---------------- Data fetch ----------------
async function fetchCompare({ site_code, limit, source = "snapshots", tag = null }) {
  const params = new URLSearchParams();
  params.set("site_code", site_code);
  // IMPORTANT: use the user's compareLimit (backend validates)
  params.set("limit", String(limit));
  params.set("source", source);
  if (tag && tag !== "all" && tag !== "") params.set("tag", tag);
  const r = await fetch(`${API}/api/compare?${params.toString()}`);
  if (!r.ok) throw new Error(`compare HTTP ${r.status}`);
  return r.json();
}
async function postScrapeNow(site_code, limit) {
  const r = await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(site_code)}&limit=${encodeURIComponent(limit)}`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(`scrape HTTP ${r.status}`);
  return r.json();
}

// ---------------- Assets (Praktis image + URL) ----------------
function imgTd(url) {
  if (!url) return `<td>—</td>`;
  return `<td><img class="compare-img" src="${escapeHtml(url)}" alt="" loading="lazy"></td>`;
}
async function fetchAssetsForSkus(skus) {
  if (!skus?.length) return {};
  const qs = encodeURIComponent(skus.join(","));
  const r = await fetch(`${API}/api/products/assets?skus=${qs}`);
  if (!r.ok) {
    console.warn("assets fetch failed", await r.text());
    return {};
  }
  return r.json();
}

// ---------------- Highlight helpers ----------------
const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : null);
function classForLowest(value, candidates) {
  if (value == null || !Number.isFinite(value)) return ""; // don't color N/A
  const nums = candidates.filter(v => v != null && Number.isFinite(v));
  if (nums.length === 0) return "";
  const min = Math.min(...nums);
  return value === min ? "green" : "red"; // ties -> all green
}

// ---------------- Renderers ----------------
function renderSingle(rows, site, assetsBySku) {
  if (site === "praktiker") setHeadersPraktiker();
  else if (site === "mrbricolage") setHeadersMrBricolage();
  else if (site === "mashinibg") setHeadersMashiniBg();
  else setHeadersPraktiker();

  const html = rows.map(r => {
    const ourReg = toNum(r.product_price_regular);
    const theirReg = toNum(r.competitor_price_regular);
    const clsOur  = classForLowest(ourReg,  [ourReg, theirReg]);
    const clsComp = classForLowest(theirReg,[ourReg, theirReg]);

    const compName = r.competitor_name || "N/A";
    const compLink = r.competitor_url
      ? `<a href="${escapeHtml(r.competitor_url)}" target="_blank" rel="noopener">${escapeHtml(compName)}</a>`
      : escapeHtml(compName);

    const asset = assetsBySku[r.product_sku] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    return `
      <tr>
        <td>${escapeHtml(r.product_sku ?? "")}</td>
        ${imgTd(praktisImg)}                                                  <!-- NEW image cell -->
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(r.product_name ?? "N/A")}</a>` : escapeHtml(r.product_name ?? "N/A")}</td> <!-- NEW link -->
        <td>${escapeHtml(r.competitor_sku ?? "")}</td>
        <td>${compLink}</td>
        <td class="${clsOur}">${fmtPrice(r.product_price_regular)}</td>
        <td class="${clsComp}">${fmtPrice(r.competitor_price_regular)}</td>
        <td>${fmtPrice(r.product_price_promo)}</td>
        <td>${fmtPrice(r.competitor_price_promo)}</td>
      </tr>
    `;
  }).join("");
  tbody.innerHTML = html;
}

function renderAll(flatRows, assetsBySku) {
  setHeadersAll();

  // Pivot by Praktis Code
  const map = new Map();
  for (const r of flatRows) {
    const key = r.product_sku ?? "";
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        code: key,
        name: r.product_name ?? "N/A",
        praktis_price: toNum(r.product_price_regular),
        praktiker_price: null,
        praktiker_url: null,
        mrbricolage_price: null,
        mrbricolage_url: null,
        mashinibg_price: null,
        mashinibg_url: null,
      });
    }
    const agg = map.get(key);

    if (agg.praktis_price == null && r.product_price_regular != null) {
      agg.praktis_price = toNum(r.product_price_regular);
    }

    const site = (r.competitor_site || "").toLowerCase();
    if (site.includes("praktiker")) {
      if (r.competitor_price_regular != null) agg.praktiker_price = toNum(r.competitor_price_regular);
      if (r.competitor_url) agg.praktiker_url = r.competitor_url;
    } else if (site.includes("bricol")) {
      if (r.competitor_price_regular != null) agg.mrbricolage_price = toNum(r.competitor_price_regular);
      if (r.competitor_url) agg.mrbricolage_url = r.competitor_url;
    } else if (site.includes("mashin") || site === "mashinibg") {
      if (r.competitor_price_regular != null) agg.mashinibg_price = toNum(r.competitor_price_regular);
      if (r.competitor_url) agg.mashinibg_url = r.competitor_url;
    }
  }

  // Convert to array for paging
  const arr = Array.from(map.values());
  return arr; // caller paginates and renders
}

// ---------------- Actions ----------------
async function loadLatestCore(refetch = true) {
  const site_code = siteSelect?.value || "all";
  const tag = tagSelect?.value || "all";
  const limitForBackend = Number(compareLimit?.value || 50); // IMPORTANT: use UI input; avoids 422

  if (refetch || site_code !== lastSite || tag !== lastTag) {
    const data = await fetchCompare({ site_code, limit: limitForBackend, source: "snapshots", tag });
    lastRows = data || [];
    lastSite = site_code;
    lastTag = tag;
    page = 1; // reset to first page on any refetch
  }

  if (site_code === "all") {
    // Build pivot list, then page it
    const pivotArr = renderAll(lastRows, {}); // get array only; actual render happens below
    const total = pivotArr.length;
    const start = (page - 1) * PER_PAGE;
    const end = start + PER_PAGE;
    const pageSlice = pivotArr.slice(start, end);
    const skus = pageSlice.map(p => p.code);
    const assetsBySku = await fetchAssetsForSkus(skus);

    // Render this page
    setHeadersAll();
    const html = pageSlice.map(p => {
      const values = [p.praktis_price, p.praktiker_price, p.mrbricolage_price, p.mashinibg_price];
      const clsP = classForLowest(p.praktis_price, values);
      const clsK = classForLowest(p.praktiker_price, values);
      const clsM = classForLowest(p.mrbricolage_price, values);
      const clsMash = classForLowest(p.mashinibg_price, values);

      const praktikerCell = p.praktiker_url
        ? `${fmtPrice(p.praktiker_price)} <a href="${escapeHtml(p.praktiker_url)}" target="_blank" rel="noopener">↗</a>`
        : fmtPrice(p.praktiker_price);

      const mrbricolageCell = p.mrbricolage_url
        ? `${fmtPrice(p.mrbricolage_price)} <a href="${escapeHtml(p.mrbricolage_url)}" target="_blank" rel="noopener">↗</a>`
        : fmtPrice(p.mrbricolage_price);

      const mashiniCell = p.mashinibg_url
        ? `${fmtPrice(p.mashinibg_price)} <a href="${escapeHtml(p.mashinibg_url)}" target="_blank" rel="noopener">↗</a>`
        : fmtPrice(p.mashinibg_price);

      const asset = assetsBySku[p.code] || {};
      const praktisUrl = asset.product_url || null;
      const praktisImg = asset.image_url || null;

      return `
        <tr>
          <td>${escapeHtml(p.code)}</td>
          ${imgTd(praktisImg)}
          <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
          <td class="${clsP}">${fmtPrice(p.praktis_price)}</td>
          <td class="${clsK}">${praktikerCell}</td>
          <td class="${clsM}">${mrbricolageCell}</td>
          <td class="${clsMash}">${mashiniCell}</td>
        </tr>
      `;
    }).join("");
    tbody.innerHTML = html;

    if (pageInfo) pageInfo.textContent = `Page ${page} / ${Math.max(1, Math.ceil(total / PER_PAGE))} (rows: ${pageSlice.length} of ${total})`;
  } else {
    // Single site view: page raw rows directly
    const total = lastRows.length;
    const start = (page - 1) * PER_PAGE;
    const end = start + PER_PAGE;
    const pageSlice = lastRows.slice(start, end);
    const skus = pageSlice.map(r => r.product_sku).filter(Boolean);
    const assetsBySku = await fetchAssetsForSkus(skus);
    renderSingle(pageSlice, site_code, assetsBySku);
    if (pageInfo) pageInfo.textContent = `Page ${page} / ${Math.max(1, Math.ceil(total / PER_PAGE))} (rows: ${pageSlice.length} of ${total})`;
  }
}

const loadLatest = withSpinner(loadLatestBtn, "Loading…", async () => {
  await loadLatestCore(true);
  toast("Loaded latest data from DB");
});
const scrapeNow = withSpinner(scrapeNowBtn, "Scraping…", async () => {
  const site_code = siteSelect?.value || "all";
  const limit = Number(compareLimit?.value || 50); // keep using the field for scrapeNow too
  await postScrapeNow(site_code, limit);
  await loadLatestCore(true);
  toast("Scrape finished");
});

// ---------------- Tags: mirror Matching behavior ----------------
async function reloadTags() {
  if (!tagSelect) return;
  tagSelect.innerHTML = "";
  ensureAllTagsOption();
  try {
    await loadTagsInto(tagSelect, siteSelect?.value);  // pass site where supported
  } catch (e) {
    try { await loadTagsInto(tagSelect); } catch {}
  } finally {
    ensureAllTagsOption();
    if (!tagSelect.value) tagSelect.value = "all";
  }
}

// ---------------- Init ----------------
async function init() {
  // Sites
  refreshSitesBtn?.addEventListener("click", () => loadSitesInto(siteSelect));
  await loadSitesInto(siteSelect);
  ensureAllSitesOption();

  // Reload on site change (like your Matching page does)
  siteSelect?.addEventListener("change", async () => {
    await reloadTags();
    await loadLatestCore(true);
  });

  // Tags
  await reloadTags();
  tagSelect?.addEventListener("change", async () => {
    await loadLatestCore(true);
  });
  refreshTagsBtn?.addEventListener("click", reloadTags);

  // Force the field to show 50 (as you wanted pages of 50)
  if (compareLimit) compareLimit.value = "50";

  // First load
  await loadLatestCore(true);

  // Buttons
  loadLatestBtn?.addEventListener("click", async () => {
    await loadLatestCore(true);
  });
  scrapeNowBtn?.addEventListener("click", scrapeNow);

  // Pager buttons (if present)
  prevPageBtn?.addEventListener("click", async () => {
    page = Math.max(1, page - 1);
    await loadLatestCore(false); // don’t refetch, just page the cached data
  });
  nextPageBtn?.addEventListener("click", async () => {
    page = page + 1;
    await loadLatestCore(false); // don’t refetch, just page the cached data
  });
}

init().catch(err => {
  console.error("Comparison init failed:", err);
  toast("Init failed", "error");
});
