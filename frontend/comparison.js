// comparison.js — tags like matching.js, strict headers, correct td highlights, spinners + toasts
import { API, loadSitesInto, loadTagsInto, escapeHtml, fmtPrice } from "./shared.js";

// ---------------- DOM ----------------
const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");

const loadLatestBtn = document.getElementById("loadLatest");
const scrapeNowBtn = document.getElementById("scrapeNow");
const compareLimit = document.getElementById("compareLimit");

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

// ---------------- Headers (exact per spec) ----------------
function setHeadersAll() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
    "Praktis Name",
    "Praktis Price",
    "Praktiker Price",
    "MrBricolage Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}
function setHeadersPraktiker() {
  headRow = resetHead();
  headRow.innerHTML = [
    "Praktis Code",
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
    "MrBricolage Code",
    "Praktis Name",
    "MrBricolage Name",
    "Praktis Regular Price",
    "MrBricolage Regular Price",
    "Praktis Promo Price",
    "MrBricolage Promo Price",
  ].map(h => `<th>${escapeHtml(h)}</th>`).join("");
}

// ---------------- Data fetch ----------------
async function fetchCompare({ site_code, limit, source = "snapshots", tag = null }) {
  const params = new URLSearchParams();
  params.set("site_code", site_code);
  params.set("limit", String(limit || 200));
  params.set("source", source);
  if (tag && tag !== "all" && tag !== "") params.set("tag", tag); // same idea as matching
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

// ---------------- Highlight helpers ----------------
const toNum = v => (Number.isFinite(Number(v)) ? Number(v) : null);
/** Lowest numeric => "green"; higher numeric => "red"; null/NaN => "" (no highlight). */
function classForLowest(value, candidates) {
  if (value == null || !Number.isFinite(value)) return ""; // don't color N/A
  const nums = candidates.filter(v => v != null && Number.isFinite(v));
  if (nums.length === 0) return "";
  const min = Math.min(...nums);
  return value === min ? "green" : "red"; // ties -> all green
}

// ---------------- Renderers ----------------
function renderSingle(rows, site) {
  if (site === "praktiker") setHeadersPraktiker();
  else if (site === "mrbricolage") setHeadersMrBricolage();
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

    return `
      <tr>
        <td>${escapeHtml(r.product_sku ?? "")}</td>
        <td>${escapeHtml(r.competitor_sku ?? "")}</td>
        <td>${escapeHtml(r.product_name ?? "N/A")}</td>
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

function renderAll(flatRows) {
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
    }
  }

  const html = Array.from(map.values()).map(p => {
    const values = [p.praktis_price, p.praktiker_price, p.mrbricolage_price];
    const clsP = classForLowest(p.praktis_price, values);
    const clsK = classForLowest(p.praktiker_price, values);
    const clsM = classForLowest(p.mrbricolage_price, values);

    const praktikerCell = p.praktiker_url
      ? `${fmtPrice(p.praktiker_price)} <a href="${escapeHtml(p.praktiker_url)}" target="_blank" rel="noopener">↗</a>`
      : fmtPrice(p.praktiker_price);

    const mrbricolageCell = p.mrbricolage_url
      ? `${fmtPrice(p.mrbricolage_price)} <a href="${escapeHtml(p.mrbricolage_url)}" target="_blank" rel="noopener">↗</a>`
      : fmtPrice(p.mrbricolage_price);

    return `
      <tr>
        <td>${escapeHtml(p.code)}</td>
        <td>${escapeHtml(p.name)}</td>
        <td class="${clsP}">${fmtPrice(p.praktis_price)}</td>
        <td class="${clsK}">${praktikerCell}</td>
        <td class="${clsM}">${mrbricolageCell}</td>
      </tr>
    `;
  }).join("");

  tbody.innerHTML = html;
}

// ---------------- Actions ----------------
async function loadLatestCore() {
  const site_code = siteSelect?.value || "all";
  const limit = Number(compareLimit?.value || 200);
  const tag = tagSelect?.value || null;  // identical handling to matching.js approach
  const data = await fetchCompare({ site_code, limit, source: "snapshots", tag });
  if (site_code === "all") renderAll(data);
  else renderSingle(data, site_code);
}
const loadLatest = withSpinner(loadLatestBtn, "Loading…", async () => {
  await loadLatestCore();
  toast("Loaded latest data from DB");
});
const scrapeNow = withSpinner(scrapeNowBtn, "Scraping…", async () => {
  const site_code = siteSelect?.value || "all";
  const limit = Number(compareLimit?.value || 200);
  await postScrapeNow(site_code, limit);
  await loadLatestCore();
  toast("Scrape finished");
});

// ---------------- Tags: mirror Matching behavior ----------------
async function reloadTags() {
  if (!tagSelect) return;
  // keep "All tags" at the top
  tagSelect.innerHTML = "";
  ensureAllTagsOption();
  try {
    // Matching fills tags for the selected site; do the same.
    // If your helper only takes (selectEl), the second arg will be ignored.
    await loadTagsInto(tagSelect, siteSelect?.value);
  } catch (e) {
    // Fallback: try the one-arg variant if the above fails
    try { await loadTagsInto(tagSelect); } catch {}
  } finally {
    // ensure "All tags" option remains and is the default
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
  siteSelect.value = "all"; // default

  // Tags (exactly like matching: load once, reload on site change, refresh button)
  await reloadTags();
  refreshTagsBtn?.addEventListener("click", reloadTags);
  siteSelect?.addEventListener("change", async () => {
    await reloadTags();        // reload tags for the new site
    await loadLatestCore();    // then reload data
  });
  tagSelect?.addEventListener("change", loadLatestCore);

  // First load
  await loadLatestCore();

  // Buttons
  loadLatestBtn?.addEventListener("click", loadLatest);
  scrapeNowBtn?.addEventListener("click", scrapeNow);
}

init().catch(err => {
  console.error("Comparison init failed:", err);
  toast("Init failed", "error");
});
