import { API, loadSitesInto, loadTagsInto, escapeHtml, fmtPrice } from "./shared.js";

const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
const loadLatestBtn = document.getElementById("loadLatest");
const scrapeNowBtn = document.getElementById("scrapeNow");
const compareLimit = document.getElementById("compareLimit");
const tbodyCompare = document.querySelector("#compareTable tbody");
const tagFilter = document.getElementById("tagFilter");

const ALL_VALUE = "__ALL__";

let sitesCache = [];               // [{code, name}]
let lastRows = [];                 // single-site cached rows
let lastAllRows = [];              // all-sites merged rows
let lastAllSiteOrder = [];         // order of competitor columns

// ---------- bootstrap ----------
init().catch(err => {
  console.error("Comparison init failed:", err);
  alert("Failed to initialize Comparison tab. See console for details.");
});

async function init() {
  // Populate sites and insert "All" as default
  refreshSitesBtn.onclick = async () => {
    await loadSitesList();
    await loadLatest();
  };
  await loadSitesList();

  // Tags
  await loadTagsInto(tagFilter, true);

  // Auto reload on changes
  siteSelect.onchange = () => loadLatest();
  tagFilter.onchange = () => loadLatest();

  // Buttons
  loadLatestBtn.onclick = () => loadLatest();
  scrapeNowBtn.onclick  = () => scrapeNow();

  // First load
  await loadLatest();
}

// ---------- sites ----------
async function loadSitesList() {
  await loadSitesInto(siteSelect);

  // Build cache from current options (display text is like "Praktiker (praktiker)")
  sitesCache = [...siteSelect.querySelectorAll("option")]
    .filter(o => o.value && o.value.trim().length > 0)
    .map(o => ({ code: o.value, name: (o.textContent || "").replace(/\s*\(.*\)\s*$/, "") }));

  // Ensure "All" exists and is default
  if (![...siteSelect.options].some(o => o.value === ALL_VALUE)) {
    const allOpt = document.createElement("option");
    allOpt.value = ALL_VALUE;
    allOpt.textContent = "All sites (all)";
    siteSelect.insertBefore(allOpt, siteSelect.firstChild);
  }
  siteSelect.value = ALL_VALUE;
}

function getSiteName(code) {
  return (sitesCache.find(s => s.code === code)?.name) || code;
}

function getSelectedSites() {
  const val = siteSelect.value;
  if (val === ALL_VALUE) {
    return sitesCache.map(s => s.code); // every competitor
  }
  return [val];
}

// ---------- loading ----------
async function loadLatest() {
  try {
    const codes = getSelectedSites();
    const limit = compareLimit.value || "200";
    const tagId = tagFilter.value || "";

    if (!codes.length) {
      clearBody();
      setHeadersSingle("Praktiker"); // harmless placeholder
      return;
    }

    if (siteSelect.value !== ALL_VALUE) {
      // Single-site: keep original table shape
      const code = codes[0];
      const url = new URL(`${API}/api/compare`);
      url.searchParams.set("site_code", code);
      url.searchParams.set("limit", limit);
      url.searchParams.set("source", "snapshots");
      if (tagId) url.searchParams.set("tag_id", tagId);

      const r = await fetch(url);
      if (!r.ok) {
        console.error("Load Latest failed:", r.status, await r.text());
        alert("Load failed. See console for details.");
        return;
      }
      const rows = await r.json();
      lastRows = rows;
      renderSingleSite(rows, getSiteName(code));
      scrapeNowBtn.textContent = "Scrape Now";
      return;
    }

    // All-sites: fetch each site in parallel and merge
    const reqs = codes.map(code => {
      const uri = new URL(`${API}/api/compare`);
      uri.searchParams.set("site_code", code);
      uri.searchParams.set("limit", limit);
      uri.searchParams.set("source", "snapshots");
      if (tagId) uri.searchParams.set("tag_id", tagId);
      return { code, url: uri.toString() };
    });

    const results = await Promise.all(reqs.map(async ({ code, url }) => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(await r.text());
        return { code, rows: await r.json() };
      } catch (e) {
        console.warn("Load failed for", code, e);
        return { code, rows: [] };
      }
    }));

    const { rows: mergedRows, siteOrder } = mergeAllSites(results);
    lastAllRows = mergedRows;
    lastAllSiteOrder = siteOrder;
    renderAllSites(mergedRows, siteOrder);
    scrapeNowBtn.textContent = "Scrape Now (All)";
  } catch (e) {
    console.error("loadLatest error:", e);
    alert("Load failed. See console for details.");
  }
}

async function scrapeNow() {
  const codes = getSelectedSites();
  const limit = compareLimit.value || "200";

  if (siteSelect.value !== ALL_VALUE) {
    const code = codes[0];
    const r = await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(code)}&limit=${encodeURIComponent(limit)}`, {
      method: "POST"
    });
    if (!r.ok) {
      console.error("Scrape failed:", r.status, await r.text());
      alert("Scrape failed. See console for details.");
      return;
    }
    const { written } = await r.json();
    alert(`Scraped and saved ${written} snapshot(s) for ${getSiteName(code)}.`);
    await loadLatest();
    return;
  }

  // All-sites: do sequentially (gentler)
  let total = 0;
  for (const code of codes) {
    try {
      const r = await fetch(`${API}/api/compare/scrape?site_code=${encodeURIComponent(code)}&limit=${encodeURIComponent(limit)}`, {
        method: "POST"
      });
      if (!r.ok) {
        console.warn("Scrape failed for", code, await r.text());
        continue;
      }
      const { written } = await r.json();
      total += Number(written || 0);
    } catch (e) {
      console.warn("Scrape error for", code, e);
    }
  }
  alert(`Scrape completed across all sites. Total snapshots saved: ${total}.`);
  await loadLatest();
}

// ---------- single-site render (original 8 columns) ----------
function renderSingleSite(rows, competitorName) {
  setHeadersSingle(competitorName);
  clearBody();

  const tbody = tbodyCompare;
  for (const row of rows) {
    const tr = document.createElement("tr");
    const hl = decideHighlight(row.product_price_regular, row.competitor_price_regular);

    tr.innerHTML = `
      <td>${row.product_sku ?? ""}</td>
      <td>${row.competitor_sku ?? ""}</td>
      <td>${escapeHtml(row.product_name ?? "")}</td>
      <td>${
        row.competitor_url
          ? `<a href="${row.competitor_url}" target="_blank">${escapeHtml(row.competitor_name ?? "")}</a>`
          : escapeHtml(row.competitor_name ?? "")
      }</td>
      <td class="${hl.oursLower ? 'green' : (hl.theirsLower ? 'red' : '')}" style="text-align:right;">${fmtPrice(row.product_price_regular)}</td>
      <td class="${hl.theirsLower ? 'green' : (hl.oursLower ? 'red' : '')}" style="text-align:right;">${fmtPrice(row.competitor_price_regular)}</td>
      <td style="text-align:right;">${fmtPrice(row.product_price_promo)}</td>
      <td style="text-align:right;">${fmtPrice(row.competitor_price_promo)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Defensive: (re)query the header row each time and guard against null
function setHeadersSingle(competitorName) {
  const headRow = document.getElementById("compareHeadRow");
  if (!headRow) {
    console.warn("#compareHeadRow not found in DOM.");
    return;
  }
  headRow.innerHTML = `
    <th>Praktis Code</th>
    <th>${competitorName} Code</th>
    <th>Praktis Name</th>
    <th>${competitorName} Name</th>
    <th>Praktis Regular Price</th>
    <th>${competitorName} Regular Price</th>
    <th>Praktis Promo Price</th>
    <th>${competitorName} Promo Price</th>
  `;
}

// ---------- all-sites render ----------
function mergeAllSites(results) {
  const bySku = new Map();
  const siteOrder = results.map(r => r.code); // keep dropdown order

  for (const { code, rows } of results) {
    for (const row of rows) {
      const sku = row.product_sku;
      if (!sku) continue;

      let rec = bySku.get(sku);
      if (!rec) {
        rec = {
          product_sku: sku,
          product_name: row.product_name ?? "",
          praktis_price: normNum(row.product_price_regular),
          competitors: {} // code -> { price, url }
        };
        bySku.set(sku, rec);
      } else {
        if (row.product_price_regular != null) {
          rec.praktis_price = normNum(row.product_price_regular);
        }
        if (!rec.product_name && row.product_name) rec.product_name = row.product_name;
      }

      rec.competitors[code] = {
        price: normNum(row.competitor_price_regular),
        url: row.competitor_url || null
      };
    }
  }

  const mergedRows = [...bySku.values()].sort((a, b) => {
    const A = String(a.product_sku), B = String(b.product_sku);
    return A < B ? -1 : A > B ? 1 : 0;
  });
  return { rows: mergedRows, siteOrder };
}

function renderAllSites(rows, siteOrder) {
  const headRow = document.getElementById("compareHeadRow");
  if (!headRow) {
    console.warn("#compareHeadRow not found in DOM.");
    return;
  }

  // headers
  headRow.innerHTML = "";
  addTh(headRow, "Praktis Code");
  addTh(headRow, "Praktis Name");
  addTh(headRow, "Praktis Price");
  for (const code of siteOrder) addTh(headRow, `${getSiteName(code)} Price`);

  clearBody();
  const tbody = tbodyCompare;

  for (const r of rows) {
    const tr = document.createElement("tr");

    // find minimum among ours + competitors
    const prices = [];
    if (isFiniteNum(r.praktis_price)) prices.push(r.praktis_price);
    for (const code of siteOrder) {
      const p = r.competitors[code]?.price ?? null;
      if (isFiniteNum(p)) prices.push(p);
    }
    const minPrice = prices.length ? Math.min(...prices) : null;

    // Praktis Code
    const tdSku = document.createElement("td");
    tdSku.textContent = r.product_sku ?? "";
    tr.appendChild(tdSku);

    // Praktis Name
    const tdName = document.createElement("td");
    tdName.innerHTML = escapeHtml(r.product_name ?? "");
    tr.appendChild(tdName);

    // Praktis Price
    const tdOur = document.createElement("td");
    tdOur.style.textAlign = "right";
    if (minPrice != null && r.praktis_price === minPrice) tdOur.className = "green";
    tdOur.textContent = fmtPrice(r.praktis_price);
    tr.appendChild(tdOur);

    // Competitor columns
    for (const code of siteOrder) {
      const cell = document.createElement("td");
      cell.style.textAlign = "right";
      const entry = r.competitors[code] || null;
      const price = entry?.price ?? null;
      const url = entry?.url ?? null;

      if (minPrice != null && price === minPrice) cell.className = "green";

      const priceTxt = fmtPrice(price);
      cell.innerHTML = url
        ? `${priceTxt} <a href="${url}" target="_blank" class="link-btn" style="width:auto;padding:2px 6px;text-decoration:none;" title="Open product">🔗</a>`
        : priceTxt;

      tr.appendChild(cell);
    }

    tbody.appendChild(tr);
  }
}

// ---------- small helpers ----------
function addTh(headRow, label) {
  const th = document.createElement("th");
  th.textContent = label;
  headRow.appendChild(th);
}

function clearBody() {
  if (tbodyCompare) tbodyCompare.innerHTML = "";
}

function decideHighlight(our, their) {
  const o = Number(our ?? NaN), t = Number(their ?? NaN);
  if (Number.isFinite(o) && Number.isFinite(t)) {
    return { oursLower: o < t, theirsLower: t < o };
    }
  return { oursLower: false, theirsLower: false };
}

function normNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isFiniteNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}
