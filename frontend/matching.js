// matching.js — Brand filters + Match status dropdown (no duplicates)
// It reuses existing controls if they already exist in the HTML.
import { API, loadSitesInto, loadTagsInto, escapeHtml, makeTagBadge } from "./shared.js";

/* ────────────────────────────────────────────────────────────────────────────
   TAG CACHE (5-min TTL) — avoids per-row GET /api/tags
   ──────────────────────────────────────────────────────────────────────────── */
const TAG_CACHE_KEY = "ALL_TAGS_CACHE_V1";
const TAG_TTL_MS = 5 * 60 * 1000;
let ALL_TAGS_MEM = null;
async function getAllTagsCached() {
  if (ALL_TAGS_MEM) return ALL_TAGS_MEM;
  try {
    const raw = localStorage.getItem(TAG_CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (ts && Array.isArray(data) && (Date.now() - ts) < TAG_TTL_MS) {
        ALL_TAGS_MEM = data;
        return ALL_TAGS_MEM;
      }
    }
  } catch {}
  const r = await fetch(`${API}/api/tags`);
  const data = r.ok ? await r.json() : [];
  ALL_TAGS_MEM = data;
  try { localStorage.setItem(TAG_CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch {}
  return ALL_TAGS_MEM;
}

// ---------------- DOM ----------------
const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
refreshSitesBtn.onclick = () => loadSitesInto(siteSelect);
await loadSitesInto(siteSelect);

// Auto reload on site change
siteSelect.onchange = () => { page = 1; loadProducts(); };

// Tag filter (kept)
const tagFilter = document.getElementById("tagFilter");
await loadTagsInto(tagFilter, true);            // keep existing helper (one request)
void getAllTagsCached();                        // warm up cache for per-row pickers

// Paging + search (kept)
let page = 1;
const pageInfo = document.getElementById("pageInfo");
const tbodyMatch = document.querySelector("#matchTable tbody");
const loadProductsBtn = document.getElementById("loadProducts");
const searchInput = document.getElementById("searchInput");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const autoMatchBtn = document.getElementById("autoMatch");
const refreshAssetsBtn = document.getElementById("refreshPraktisAssets");

// =========================
// Toolbar controls (REUSE if they exist; otherwise create)
// =========================
const toolbar = document.querySelector(".toolbar");

// Remove legacy match buttons if they exist in the HTML
["showMatched", "showUnmatched", "showAll"].forEach((id) => {
  const el = document.getElementById(id);
  if (el && el.parentNode) el.parentNode.removeChild(el);
});

// Brand free-text input
let brandInput = document.getElementById("brandInput");
if (!brandInput) {
  brandInput = document.createElement("input");
  brandInput.id = "brandInput";
  brandInput.placeholder = "Brand…";
  toolbar?.appendChild(brandInput);
}

// Brand dropdown
let brandSelect = document.getElementById("brandSelect");
if (!brandSelect) {
  brandSelect = document.createElement("select");
  brandSelect.id = "brandSelect";
  toolbar?.appendChild(brandSelect);
}
function ensureBrandPlaceholder() {
  if (!brandSelect.querySelector("option[value='']")) {
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— Brands —";
    brandSelect.insertBefore(opt0, brandSelect.firstChild);
  } else {
    brandSelect.querySelector("option[value='']").textContent = "— Brands —";
  }
}

// Match status dropdown (replaces three buttons)
let matchSelect = document.getElementById("matchSelect");
if (!matchSelect) {
  matchSelect = document.createElement("select");
  matchSelect.id = "matchSelect";
  toolbar?.appendChild(matchSelect);
}
function initMatchSelect() {
  matchSelect.innerHTML = "";
  const opts = [
    ["", "All"],
    ["matched", "Matched"],
    ["unmatched", "Unmatched"],
  ];
  for (const [val, label] of opts) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label;
    matchSelect.appendChild(o);
  }
}
initMatchSelect();

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
praktisPresence.addEventListener("change", () => { page = 1; loadProducts(); });

// state for matched/unmatched
let matchState = ""; // "", "matched", "unmatched"

// Load brands for dropdown (distinct from DB)
async function loadBrands() {
  try {
    const r = await fetch(`${API}/api/products/brands`);
    const brands = r.ok ? await r.json() : [];
    brandSelect.innerHTML = "";
    ensureBrandPlaceholder();
    for (const b of brands) {
      const o = document.createElement("option");
      o.value = b;
      o.textContent = b;
      brandSelect.appendChild(o);
    }
  } catch (e) {
    ensureBrandPlaceholder();
    console.warn("Failed to load brands", e);
  }
}
await loadBrands(); // populate on startup

// Which brand filter to send (dropdown takes precedence if set)
function currentBrandFilter() {
  const raw = (brandSelect.value || brandInput.value || "").trim();
  return raw;
}

// Wire filters
brandInput.addEventListener("input", () => {
  if (brandInput.value) brandSelect.value = ""; // prefer text over dropdown
  page = 1; loadProducts();
});
brandSelect.addEventListener("change", () => {
  if (brandSelect.value) brandInput.value = ""; // prefer dropdown over text
  page = 1; loadProducts();
});
matchSelect.addEventListener("change", () => {
  matchState = matchSelect.value || "";
  page = 1; loadProducts();
});

function isOnPraktis(url) {
  if (!url) return false;
  const u = String(url).trim();
  // On-site if it starts with the domain AND isn't the bare homepage
  return u.startsWith("https://praktis.bg/") && u !== "https://praktis.bg/";
}

// =========================
// Praktis assets (URL + Image) helpers (kept)
// =========================
function imgCell(url) {
  if (!url) return `<td>—</td>`;
  return `<td><img src="${escapeHtml(url)}" alt="" loading="lazy" style="max-height:48px;max-width:80px;border-radius:6px"/></td>`;
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

// =========================
// Search: live + Enter
// =========================
let _searchTimer;
if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { page = 1; loadProducts(); }, 300);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); page = 1; loadProducts(); }
  });
}

// =========================
async function loadProducts() {
  const q = searchInput?.value.trim();
  const url = new URL(`${API}/api/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", "50");
  if (q) url.searchParams.set("q", q);

  // Tag filter (kept)
  const tagId = tagFilter.value.trim();
  if (tagId) url.searchParams.set("tag_id", tagId);

  // Brand (server normalizes case/spaces/dots)
  const brand = currentBrandFilter();
  if (brand) url.searchParams.set("brand", brand);

  // Matched/Unmatched per site
  if (siteSelect.value) url.searchParams.set("site_code", siteSelect.value);
  if (matchState) url.searchParams.set("matched", matchState);

  // 1) Load products
  const r = await fetch(url);
  if (!r.ok) {
    alert("Failed to load products");
    return;
  }
  const products = await r.json();

  // 2) Lookup matches for selected site
  const productIds = products.map(p => p.id);
  let matchesByProductId = {};
  if (productIds.length) {
    const r2 = await fetch(`${API}/api/matches/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_code: siteSelect.value, product_ids: productIds })
    });
    if (r2.ok) {
      const matches = await r2.json();
      for (const m of matches) matchesByProductId[m.product_id] = m;
    } else {
      console.warn("Lookup matches failed", await r2.text());
    }
  }

  // 3) Tags per product (BULK once per page)
  let tagsByProductId = {};
  if (productIds.length) {
    const r3 = await fetch(`${API}/api/tags/by_products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: productIds })
    });
    if (r3.ok) tagsByProductId = await r3.json();
  }

  // 4) Praktis assets (image + PDP url) for visible SKUs
  const skus = products.map(p => p.sku);
  const assetsBySku = await fetchAssetsForSkus(skus);

  await renderMatchRows(products, matchesByProductId, tagsByProductId, assetsBySku);
  if (pageInfo) pageInfo.textContent = `Page ${page} (rows: ${products.length})`;
}

// =========================
async function renderMatchRows(products, matchesByProductId, tagsByProductId, assetsBySku = {}) {
  const ALL_TAGS = await getAllTagsCached();   // ← ONE list used for all rows
  const presenceMode = (document.getElementById("praktisPresence")?.value || "");
  tbodyMatch.innerHTML = "";
  for (const p of products) {
    if (presenceMode) {
        const a = assetsBySku[p.sku] || null;
        const onSite = isOnPraktis(a?.product_url || "");
        if ((presenceMode === "present" && !onSite) || (presenceMode === "missing" && onSite)) {
          continue; // skip this row
    }}
    const m = matchesByProductId[p.id] || null;
    const prodTags = tagsByProductId[p.id] || [];
    const asset = assetsBySku[p.sku] || null;
    const praktisUrl = asset?.product_url || null;
    const praktisImg = asset?.image_url || null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.sku}</td>
      <td>${p.barcode ?? ""}</td>
      ${imgCell(praktisImg)}
      <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
      <td>
        <div style="display:flex; gap:6px; align-items:center;">
          <input placeholder="competitor SKU" class="comp-sku" value="${m?.competitor_sku ?? ""}" style="flex:1"/>
          ${m?.competitor_url ? `<a class="link-btn" href="${m.competitor_url}" target="_blank" title="${escapeHtml(m?.competitor_name ?? 'Продукт')}">🔗</a>` : ""}
        </div>
      </td>
      <td>
        <div style="display:flex; gap:6px; align-items:center;">
          <input placeholder="competitor barcode" class="comp-bar" value="${m?.competitor_barcode ?? ""}" style="flex:1"/>
          ${(!m?.competitor_url && m?.competitor_barcode) ? `<a class="link-btn" href="https://praktiker.bg/search/${encodeURIComponent(m.competitor_barcode)}" target="_blank" title="Search by barcode">🔍</a>` : ""}
        </div>
      </td>
      <td>
        <div class="tags-cell" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;"></div>
        <div style="display:flex;gap:6px;align-items:center;">
          <select class="tag-picker"></select>
          <button class="addTag">Add</button>
        </div>
      </td>
      <td><button class="saveMatch">${m ? "Update" : "Save"}</button></td>
    `;

    // --- badges: render from local state (NO per-row network calls)
    const tagsCell = tr.querySelector(".tags-cell");
    let currTags = Array.isArray(prodTags) ? [...prodTags] : [];
    function drawBadges() {
      tagsCell.innerHTML = "";
      for (const t of currTags) {
        tagsCell.appendChild(
          makeTagBadge(t, async () => {
            await fetch(`${API}/api/tags/unassign`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ product_id: p.id, tag_id: t.id })
            });
            currTags = currTags.filter(x => x.id !== t.id);
            drawBadges();
          })
        );
      }
    }
    drawBadges();

    // --- tag picker: fill from cached ALL_TAGS (no GET per row)
    const picker = tr.querySelector(".tag-picker");
    picker.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "Choose tag…";
    picker.appendChild(opt0);
    for (const t of ALL_TAGS) {
      const o = document.createElement("option");
      o.value = String(t.id);
      o.textContent = t.name;
      picker.appendChild(o);
    }

    // assign tag (POST once; update local state)
    tr.querySelector(".addTag").onclick = async () => {
      const tagId = Number(picker.value || 0);
      if (!tagId) return;
      await fetch(`${API}/api/tags/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: p.id, tag_id: tagId })
      });
      const newTag = ALL_TAGS.find(t => Number(t.id) === tagId);
      if (newTag && !currTags.some(t => t.id === newTag.id)) {
        currTags.push(newTag);
        drawBadges();
      }
    };

    // save/update match (kept)
    tr.querySelector(".saveMatch").onclick = async () => {
      const compSku = tr.querySelector(".comp-sku").value.trim() || null;
      const compBar = tr.querySelector(".comp-bar").value.trim() || null;
      const payload = {
        product_id: p.id,
        site_code: siteSelect.value,
        competitor_sku: compSku,
        competitor_barcode: compBar
      };
      const r = await fetch(`${API}/api/matches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const err = await r.text();
        alert("Save failed:\n" + err);
        return;
      }
      tr.querySelector(".saveMatch").textContent = "Update";
      tr.querySelector(".comp-sku").style.background = compSku ? "rgba(59,130,246,.12)" : "";
      tr.querySelector(".comp-bar").style.background = compBar ? "rgba(59,130,246,.12)" : "";
      await reloadOneRowLink(p.id, tr);
      alert("Saved");
    };

    tbodyMatch.appendChild(tr);
  }
}

// add competitor link after save if available
async function reloadOneRowLink(productId, tr) {
  const r = await fetch(`${API}/api/matches/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_code: siteSelect.value, product_ids: [productId] })
  });
  if (!r.ok) return;
  const [m] = await r.json();
  if (!m) return;

  const skuCell = tr.querySelector(".comp-sku")?.parentElement;
  if (skuCell && m.competitor_url) {
    let a = skuCell.querySelector("a.link-btn");
    if (!a) {
      a = document.createElement("a");
      a.className = "link-btn";
      a.textContent = "🔗";
      a.target = "_blank";
      skuCell.appendChild(a);
    }
    a.href = m.competitor_url;
    a.title = m.competitor_name || "Продукт";
  }
}

// Buttons & paging (kept)
loadProductsBtn.onclick = () => { page = 1; loadProducts(); };
prevPageBtn.onclick = () => { page = Math.max(1, page - 1); loadProducts(); };
nextPageBtn.onclick = () => { page = page + 1; loadProducts(); };
tagFilter.onchange = () => { page = 1; loadProducts(); };
autoMatchBtn.onclick = async () => {
  const code = siteSelect.value;
  const r = await fetch(`${API}/api/matches/auto?site_code=${encodeURIComponent(code)}&limit=100`, { method: "POST" });
  if (!r.ok) {
    const err = await r.text();
    alert("Auto-match failed:\n" + err);
    return;
  }
  const data = await r.json();
  alert(`Auto match -> attempted=${data.attempted}, found=${data.found}`);
  await loadProducts();
};
refreshAssetsBtn.onclick = async () => {
  // Optional: limit how many SKUs to refresh each click
  const payload = { limit: 500 }; // change or remove to refresh all
  refreshAssetsBtn.disabled = true;
  const original = refreshAssetsBtn.textContent;
  refreshAssetsBtn.textContent = "Refreshing…";
  try {
    const r = await fetch(`${API}/api/praktis/assets/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    const info = await r.json();
    alert(`Praktis assets refreshed:\nchecked=${info.checked}, updated=${info.updated}, skipped=${info.skipped}, errors=${info.errors}`);
    await loadProducts(); // reload to show new images/links
  } catch (e) {
    alert("Refresh failed:\n" + (e?.message || e));
  } finally {
    refreshAssetsBtn.textContent = original;
    refreshAssetsBtn.disabled = false;
  }
};

// Initial load
await loadProducts();
