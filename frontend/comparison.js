import { API, loadSitesInto, loadTagsInto, escapeHtml, fmtPrice } from "./shared.js";

const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
refreshSitesBtn.onclick = () => loadSitesInto(siteSelect);
await loadSitesInto(siteSelect);

const loadLatestBtn = document.getElementById("loadLatest");
const scrapeNowBtn = document.getElementById("scrapeNow");
const compareLimit = document.getElementById("compareLimit");
const tbodyCompare = document.querySelector("#compareTable tbody");

// NEW: tag filter
const tagFilter = document.getElementById("tagFilter");
await loadTagsInto(tagFilter, true);

async function loadLatest() {
  const code = siteSelect.value;
  const limit = compareLimit.value || "200";
  const tagId = tagFilter.value || "";
  const url = new URL(`${API}/api/compare`);
  url.searchParams.set("site_code", code);
  url.searchParams.set("limit", limit);
  url.searchParams.set("source", "snapshots");
  if (tagId) url.searchParams.set("tag_id", tagId);

  const r = await fetch(url);
  if (!r.ok) {
    const err = await r.text();
    alert("Load failed:\n" + err);
    return;
  }
  const rows = await r.json();
  renderCompare(rows);
}

async function scrapeNow() {
  const code = siteSelect.value;
  const limit = compareLimit.value || "200";
  const r = await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(code)}&limit=${encodeURIComponent(limit)}`, {
    method: "POST"
  });
  if (!r.ok) {
    const err = await r.text();
    alert("Scrape failed:\n" + err);
    return;
  }
  const { written } = await r.json();
  alert(`Scraped and saved ${written} snapshot(s).`);
  await loadLatest();
}

function renderCompare(rows) {
  tbodyCompare.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const hl = decideHighlight(row.product_price_regular, row.competitor_price_regular);
    tr.innerHTML = `
      <td>${row.product_sku}</td>
      <td>${row.competitor_sku ?? ""}</td>
      <td>${escapeHtml(row.product_name)}</td>
      <td>${row.competitor_url ? `<a href="${row.competitor_url}" target="_blank">${escapeHtml(row.competitor_name ?? "")}</a>` : (escapeHtml(row.competitor_name ?? ""))}</td>
      <td class="${hl.oursLower ? 'green' : (hl.theirsLower ? 'red' : '')}">${fmtPrice(row.product_price_regular)}</td>
      <td class="${hl.theirsLower ? 'green' : (hl.oursLower ? 'red' : '')}">${fmtPrice(row.competitor_price_regular)}</td>
      <td>${fmtPrice(row.product_price_promo)}</td>
      <td>${fmtPrice(row.competitor_price_promo)}</td>
    `;
    tbodyCompare.appendChild(tr);
  }
}

function decideHighlight(our, their) {
  const o = Number(our ?? NaN), t = Number(their ?? NaN);
  if (Number.isFinite(o) && Number.isFinite(t)) {
    return { oursLower: o < t, theirsLower: t < o };
  }
  return { oursLower: false, theirsLower: false };
}

loadLatestBtn.onclick = loadLatest;
scrapeNowBtn.onclick = scrapeNow;

// Update when tag filter changes
tagFilter.onchange = loadLatest;

await loadLatest();
