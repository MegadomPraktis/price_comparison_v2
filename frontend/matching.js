// matching.js — Matching tab with brand & tag filters + MEGA MENU category picker (hover/click)
// Restores visible filters for (1) matched/unmatched and (2) Praktis presence,
// keeps accurate DB count + centered pager with numeric buttons.

import { API, loadSitesInto, loadTagsInto, loadGroupsInto, escapeHtml, makeTagBadge } from "./shared.js";

/* ────────────────────────────────────────────────────────────────────────────
   TAG CACHE (5-min TTL)
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
refreshSitesBtn && (refreshSitesBtn.onclick = () => loadSitesInto(siteSelect));
await loadSitesInto(siteSelect);

// Auto reload on site change
siteSelect && (siteSelect.onchange = () => { page = 1; loadProducts(); });

// Tag filter
const tagFilter = document.getElementById("tagFilter");
if (tagFilter) await loadTagsInto(tagFilter, true);
void getAllTagsCached(); // warm cache

// --- Category (ERP group) hidden <select> (kept; can be hidden via CSS)
const groupFilter = document.getElementById("groupFilter");
if (groupFilter && !groupFilter.options.length) await loadGroupsInto(groupFilter, true);
groupFilter?.addEventListener("change", () => {
  CURRENT_GROUP_ID = groupFilter.value || ""; // keep JS fallback in sync
  page = 1; loadProducts();
});

// Mega menu elements
const catsWrap   = document.getElementById("catsWrap");
const catsTrigger= document.getElementById("catsTrigger");
const catsPanel  = document.getElementById("catsPanel");
const catsLeft   = document.getElementById("catsLeft");
const catsRight  = document.getElementById("catsRight");
const groupSelectedLabel = document.getElementById("groupSelectedLabel");
const groupClearBtn = document.getElementById("groupClear");

// Paging + search
let page = 1;
const PAGE_SIZE = 50;

const pageInfo       = document.getElementById("pageInfo"); // numeric buttons container
const prevPageBtn    = document.getElementById("prevPage");
const nextPageBtn    = document.getElementById("nextPage");
const pagerContainer = document.querySelector(".pager");

const tbodyMatch     = document.querySelector("#matchTable tbody");
const loadProductsBtn= document.getElementById("loadProducts");
const searchInput    = document.getElementById("searchInput");

const autoMatchBtn       = document.getElementById("autoMatch");
const refreshAssetsBtn   = document.getElementById("refreshPraktisAssets");

// Toolbar & right-top counter
const toolbar = document.querySelector(".toolbar");
let recordCount = document.getElementById("recordCount");
if (!recordCount && toolbar) {
  recordCount = document.createElement("div");
  recordCount.id = "recordCount";
  recordCount.style.marginLeft = "auto";
  recordCount.style.fontWeight = "600";
  recordCount.style.opacity = ".9";
  toolbar.appendChild(recordCount);
}

// Center pager nicely
if (pagerContainer) {
  pagerContainer.style.display = "flex";
  pagerContainer.style.alignItems = "center";
  pagerContainer.style.justifyContent = "center";
  pagerContainer.style.gap = "10px";
}
if (pageInfo) {
  pageInfo.style.minWidth = "220px";
  pageInfo.style.display = "flex";
  pageInfo.style.alignItems = "center";
  pageInfo.style.justifyContent = "center";
  pageInfo.style.gap = "8px";
}

/* ────────────────────────────────────────────────────────────────────────────
   Restore filters (Matched/Unmatched + Praktis Presence)
   ──────────────────────────────────────────────────────────────────────────── */

// Remove legacy buttons if present to avoid duplicates
["showMatched","showUnmatched","showAll"].forEach(id=>{
  const el = document.getElementById(id);
  if (el?.parentNode) el.parentNode.removeChild(el);
});

// Brand inputs
let brandInput = document.getElementById("brandInput");
if (!brandInput) {
  brandInput = document.createElement("input");
  brandInput.id = "brandInput";
  brandInput.placeholder = "Brand…";
  toolbar?.appendChild(brandInput);
}
let brandSelect = document.getElementById("brandSelect");
if (!brandSelect) {
  brandSelect = document.createElement("select");
  brandSelect.id = "brandSelect";
  toolbar?.appendChild(brandSelect);
}
function ensureBrandPlaceholder() {
  if (!brandSelect.querySelector("option[value='']")) {
    const opt0 = document.createElement("option");
    opt0.value = ""; opt0.textContent = "— Brands —";
    brandSelect.insertBefore(opt0, brandSelect.firstChild);
  } else {
    brandSelect.querySelector("option[value='']").textContent = "— Brands —";
  }
}

// Match status dropdown (VISIBLE)
let matchSelect = document.getElementById("matchSelect");
if (!matchSelect) {
  // create labeled group
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "6px";

  const lbl = document.createElement("span");
  lbl.textContent = "Match:";
  lbl.style.opacity = ".8";

  matchSelect = document.createElement("select");
  matchSelect.id = "matchSelect";

  wrap.appendChild(lbl);
  wrap.appendChild(matchSelect);
  toolbar?.appendChild(wrap);
}
function initMatchSelect() {
  matchSelect.innerHTML = "";
  [["","All"],["matched","Matched"],["unmatched","Unmatched"]].forEach(([v,t])=>{
    const o = document.createElement("option"); o.value=v; o.textContent=t; matchSelect.appendChild(o);
  });
}
initMatchSelect();

// Praktis presence dropdown (VISIBLE)
let praktisPresence = document.getElementById("praktisPresence");
if (!praktisPresence) {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "6px";

  const lbl = document.createElement("span");
  lbl.textContent = "Praktis:";
  lbl.style.opacity = ".8";

  praktisPresence = document.createElement("select");
  praktisPresence.id = "praktisPresence";
  praktisPresence.innerHTML = `
    <option value="">All products</option>
    <option value="present">Products on Praktis website</option>
    <option value="missing">Products NOT on Praktis website</option>`;

  wrap.appendChild(lbl);
  wrap.appendChild(praktisPresence);
  toolbar?.appendChild(wrap);
}

// State
let matchState = ""; // "", "matched", "unmatched"
let CURRENT_GROUP_ID = ""; // ← JS fallback for selected group id

// Load brands
async function loadBrands() {
  try {
    const r = await fetch(`${API}/api/products/brands`);
    const brands = r.ok ? await r.json() : [];
    brandSelect.innerHTML = "";
    ensureBrandPlaceholder();
    for (const b of brands) {
      const o = document.createElement("option"); o.value=b; o.textContent=b;
      brandSelect.appendChild(o);
    }
  } catch(e) {
    ensureBrandPlaceholder();
    console.warn("Failed to load brands", e);
  }
}
await loadBrands();

// Brand events
function currentBrandFilter() {
  return (brandSelect.value || brandInput.value || "").trim();
}
brandInput.addEventListener("input", () => {
  if (brandInput.value) brandSelect.value = "";
  page = 1; loadProducts();
});
brandSelect.addEventListener("change", () => {
  if (brandSelect.value) brandInput.value = "";
  page = 1; loadProducts();
});

// Match/Presence events
matchSelect.addEventListener("change", () => {
  matchState = matchSelect.value || "";
  page = 1; loadProducts();
});
praktisPresence.addEventListener("change", () => { page = 1; loadProducts(); });

// Helper
function isOnPraktis(url) {
  if (!url) return false;
  const u = String(url).trim();
  return u.startsWith("https://praktis.bg/") && u !== "https://praktis.bg/";
}

/* ────────────────────────────────────────────────────────────────────────────
   Category MEGA MENU (unchanged logic)
   ──────────────────────────────────────────────────────────────────────────── */
function buildGroupTree(list) {
  const byId = new Map();
  list.forEach(g => byId.set(g.id, { ...g, children: [] }));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id == null) roots.push(node);
    else {
      const p = byId.get(node.parent_id);
      if (p) p.children.push(node);
      else roots.push(node);
    }
  }
  const sortByName = (a,b)=>a.name.localeCompare(b.name,'bg');
  roots.sort(sortByName);
  roots.forEach(function rec(n){
    n.children.sort(sortByName);
    n.children.forEach(rec);
  });
  return { roots, byId };
}

let GROUP_TREE = null;
let ACTIVE_ROOT_ID = null;

function renderLeftRoots() {
  if (!catsLeft || !GROUP_TREE) return;
  catsLeft.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "cats-left-list";
  // "All"
  const liAll = document.createElement("li");
  liAll.className = "root-item all";
  liAll.innerHTML = `<span class="ico">📂</span><span class="lbl">Всички</span>`;
  liAll.dataset.groupId = "";
  ul.appendChild(liAll);

  for (const r of GROUP_TREE.roots) {
    const li = document.createElement("li");
    li.className = "root-item";
    li.dataset.groupId = String(r.id);
    li.innerHTML = `<span class="ico">📁</span><span class="lbl">${escapeHtml(r.name)}</span>`;
    ul.appendChild(li);
  }
  catsLeft.appendChild(ul);

  // hover & click (left)
  ul.addEventListener("mouseover", (e)=>{
    const li = e.target.closest("li.root-item");
    if (!li) return;
    const id = li.dataset.groupId || "";
    setActiveRoot(id);
  });
  ul.addEventListener("click", (e)=>{
    const li = e.target.closest("li.root-item");
    if (!li) return;
    e.preventDefault();
    const id = li.dataset.groupId || "";
    const label = li.querySelector(".lbl")?.textContent || "Всички";
    applyGroupSelection(id, label);
    closeCatsPanel();
  });
}

function renderRightColumns(rootId) {
  if (!catsRight || !GROUP_TREE) return;
  catsRight.innerHTML = "";

  if (!rootId) {
    catsRight.innerHTML = `<div class="hint">Изберете категория отляво</div>`;
    return;
  }
  const root = GROUP_TREE.byId.get(Number(rootId));
  if (!root) return;

  // vertical L2 list; L3 appears next to hovered L2
  const ul = document.createElement("ul");
  ul.className = "l2-list";

  for (const lvl2 of root.children) {
    const li = document.createElement("li");
    li.className = "l2-item";

    const a2 = document.createElement("a");
    a2.href = "#";
    a2.className = "l2-link" + ((lvl2.children && lvl2.children.length) ? " has-children" : "");
    a2.dataset.groupId = String(lvl2.id);
    a2.textContent = lvl2.name;
    li.appendChild(a2);

    if (lvl2.children && lvl2.children.length) {
      const fly = document.createElement("ul");
      fly.className = "l3-fly";
      for (const lvl3 of lvl2.children) {
        const li3 = document.createElement("li");
        li3.innerHTML = `<a href="#" data-group-id="${lvl3.id}">${escapeHtml(lvl3.name)}</a>`;
        fly.appendChild(li3);
      }
      li.appendChild(fly);
    }

    ul.appendChild(li);
  }

  catsRight.appendChild(ul);
  attachL2HoverHandlers(ul);
}

function attachL2HoverHandlers(rootEl) {
  const DELAY = 250; // ms hide delay for L3
  rootEl.querySelectorAll('.l2-item').forEach(li => {
    let timer = null;
    li.addEventListener('mouseenter', () => {
      if (timer) { clearTimeout(timer); timer = null; }
      li.classList.add('open');
    });
    li.addEventListener('mouseleave', () => {
      timer = setTimeout(() => li.classList.remove('open'), DELAY);
    });
  });
}

// Click L2 or L3 to filter
catsRight?.addEventListener("click", (e)=>{
  const a = e.target.closest("a[data-group-id]");
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.groupId || "";
  const label = a.textContent || "";
  applyGroupSelection(id, label);
  closeCatsPanel();
});

function setActiveRoot(id) {
  ACTIVE_ROOT_ID = id || "";
  catsLeft?.querySelectorAll("li.root-item").forEach(li=>{
    li.classList.toggle("active", (li.dataset.groupId || "") === ACTIVE_ROOT_ID);
  });
  if (ACTIVE_ROOT_ID) renderRightColumns(ACTIVE_ROOT_ID);
  else {
    catsRight.innerHTML = `<div class="hint">Изберете категория отляво</div>`;
  }
}

function ensureSelectHasOption(selectEl, id, label) {
  const idStr = String(id || "");
  if (!selectEl) return;
  let found = false;
  for (const opt of selectEl.options) {
    if (String(opt.value) === idStr) { found = true; break; }
  }
  if (!found && idStr) {
    const o = document.createElement("option");
    o.value = idStr;
    o.textContent = label || idStr;
    selectEl.appendChild(o);
  }
  selectEl.value = idStr;
}

function applyGroupSelection(id, label) {
  CURRENT_GROUP_ID = String(id || "");
  if (groupFilter) ensureSelectHasOption(groupFilter, id, label);
  if (groupSelectedLabel) groupSelectedLabel.textContent = id ? label : "Всички";
  page = 1;
  loadProducts();
}

// Open/close with delay
const CLOSE_DELAY = 350;
let closeTimer = null;
function openCatsPanel() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  catsWrap?.classList.add("open");
  catsPanel?.setAttribute("aria-hidden","false");
}
function closeCatsPanel() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  catsWrap?.classList.remove("open");
  catsPanel?.setAttribute("aria-hidden","true");
}
function scheduleClose() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => closeCatsPanel(), CLOSE_DELAY);
}
(async function initMegaMenu() {
  if (!catsPanel) return;
  try {
    const r = await fetch(`${API}/api/groups`);
    const groups = r.ok ? await r.json() : [];
    GROUP_TREE = buildGroupTree(groups);
    renderLeftRoots();
    const firstRoot = GROUP_TREE.roots[0]?.id;
    setActiveRoot(firstRoot ? String(firstRoot) : "");
  } catch (e) {
    console.warn("Groups load failed", e);
  }
  if (catsWrap && catsPanel) {
    catsWrap.addEventListener("mouseenter", openCatsPanel);
    catsWrap.addEventListener("mouseleave", scheduleClose);
    catsTrigger?.addEventListener("click", (e)=> {
      e.preventDefault();
      if (catsWrap.classList.contains("open")) scheduleClose(); else openCatsPanel();
    });
    catsPanel.addEventListener("mouseenter", () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }});
    document.addEventListener("click", (e)=>{
      if (!catsWrap.contains(e.target)) closeCatsPanel();
    });
  }
  groupClearBtn?.addEventListener("click", (e)=>{
    e.preventDefault();
    applyGroupSelection("", "Всички");
    closeCatsPanel();
  });
})();

/* ────────────────────────────────────────────────────────────────────────────
   Assets helpers
   ──────────────────────────────────────────────────────────────────────────── */
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

function getCurrentPageSkus() {
  const skus = [];
  if (!tbodyMatch) return skus;

  const rows = tbodyMatch.querySelectorAll("tr");
  for (const tr of rows) {
    // first <td> in each row is "Our SKU" (p.sku from the products table)
    const firstCell = tr.querySelector("td");
    if (!firstCell) continue;
    const sku = (firstCell.textContent || "").trim();
    if (sku) skus.push(sku);
  }
  return skus;
}

/* ────────────────────────────────────────────────────────────────────────────
   Search: live + Enter
   ──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Helpers: build filters, count, and pager UI
   ──────────────────────────────────────────────────────────────────────────── */
function currentFilters() {
  const q = (searchInput?.value || "").trim();
  const tagId = (tagFilter?.value || "").trim();
  const brand = currentBrandFilter();
  const site = siteSelect?.value || "";
  const matched = matchState || "";
  const groupId = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "");
  const presence = (praktisPresence?.value || "");
  return { q, tagId, brand, site, matched, groupId, presence };
}

async function fetchTotalCount() {
  const f = currentFilters();
  const url = new URL(`${API}/api/products/count`);
  if (f.q)       url.searchParams.set("q", f.q);
  if (f.tagId)   url.searchParams.set("tag_id", f.tagId);
  if (f.brand)   url.searchParams.set("brand", f.brand);
  if (f.site)    url.searchParams.set("site_code", f.site);
  if (f.matched) url.searchParams.set("matched", f.matched);
  if (f.groupId) url.searchParams.set("group_id", f.groupId);
  if (f.presence) url.searchParams.set("presence", f.presence);
  try {
    const r = await fetch(url);
    if (!r.ok) return 0;
    const js = await r.json();
    return Number(js?.count || 0);
  } catch {
    return 0;
  }
}

function clearNode(n){ if(!n) return; while(n.firstChild) n.removeChild(n.firstChild); }

function makePageBtn(n, active=false) {
  const b = document.createElement("button");
  b.textContent = String(n);
  b.disabled = active;
  b.style.minWidth = "34px";
  b.style.height   = "34px";
  b.style.borderRadius = "10px";
  b.style.border = "1px solid var(--border, #26324c)";
  b.style.background = active ? "var(--accent, #3b82f6)" : "rgba(255,255,255,0.04)";
  b.style.color = active ? "#fff" : "inherit";
  b.style.fontWeight = active ? "700" : "500";
  if (!active) b.onclick = () => { page = n; window.scrollTo({top:0, behavior:"smooth"}); loadProducts(); };
  return b;
}
function makeDots(){
  const s = document.createElement("span");
  s.textContent = "…";
  s.style.opacity = ".7";
  return s;
}

function renderNumbers(totalPages){
  if (!pageInfo) return;
  clearNode(pageInfo);
  let start = Math.max(1, page - 2);
  let end   = Math.min(totalPages, page + 2);
  if (end - start < 4) {
    start = Math.max(1, Math.min(start, totalPages - 4));
    end   = Math.min(totalPages, Math.max(end, 5));
  }
  if (start > 1) {
    pageInfo.appendChild(makePageBtn(1, page===1));
    if (start > 2) pageInfo.appendChild(makeDots());
  }
  for (let i=start;i<=end;i++) pageInfo.appendChild(makePageBtn(i, i===page));
  if (end < totalPages) {
    if (end < totalPages-1) pageInfo.appendChild(makeDots());
    pageInfo.appendChild(makePageBtn(totalPages, page===totalPages));
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Data load & render
   ──────────────────────────────────────────────────────────────────────────── */
async function loadProducts() {
  // 1) Accurate total to clamp pages
  const total = await fetchTotalCount();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > totalPages) page = totalPages;

  // update top-right counter
  if (recordCount) {
    recordCount.textContent = `${total} records`;
  }

  // 2) Load current page data
  const q = searchInput?.value.trim();
  const url = new URL(`${API}/api/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(PAGE_SIZE));
  if (q) url.searchParams.set("q", q);

  const tagId = tagFilter?.value?.trim?.() || "";
  if (tagId) url.searchParams.set("tag_id", tagId);

  const brand = currentBrandFilter();
  if (brand) url.searchParams.set("brand", brand);

  if (siteSelect?.value) url.searchParams.set("site_code", siteSelect.value);
  if (matchState) url.searchParams.set("matched", matchState);

  const selectedGroupId = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "");
  if (selectedGroupId) url.searchParams.set("group_id", selectedGroupId);

  // presence filter is client-side (assets-derived), but we still pass it in case backend supports it
  const presenceVal = (praktisPresence?.value || "");
  if (presenceVal) url.searchParams.set("presence", presenceVal);

  const r = await fetch(url);
  if (!r.ok) { alert("Failed to load products"); return; }
  const products = await r.json();

  // 3) Enrich and render rows
  const productIds = products.map(p => p.id);
  let matchesByProductId = {};
  if (productIds.length) {
    const r2 = await fetch(`${API}/api/matches/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_code: siteSelect?.value, product_ids: productIds })
    });
    if (r2.ok) {
      const matches = await r2.json();
      for (const m of matches) matchesByProductId[m.product_id] = m;
    }
  }

  let tagsByProductId = {};
  if (productIds.length) {
    const r3 = await fetch(`${API}/api/tags/by_products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: productIds })
    });
    if (r3.ok) tagsByProductId = await r3.json();
  }

  const skus = products.map(p => p.sku);
  const assetsBySku = await fetchAssetsForSkus(skus);

  await renderMatchRows(products, matchesByProductId, tagsByProductId, assetsBySku);

  // 4) Pager UI
  renderNumbers(totalPages);
  prevPageBtn.disabled = (page <= 1);
  nextPageBtn.disabled = (page >= totalPages);
}

async function renderMatchRows(products, matchesByProductId, tagsByProductId, assetsBySku = {}) {
  const ALL_TAGS = await getAllTagsCached();
  const presenceMode = (praktisPresence?.value || "");
  tbodyMatch.innerHTML = "";
  for (const p of products) {
    if (presenceMode) {
      const a = assetsBySku[p.sku] || null;
      const onSite = isOnPraktis(a?.product_url || "");
      if ((presenceMode === "present" && !onSite) || (presenceMode === "missing" && onSite)) {
        continue;
      }
    }
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

    tr.querySelector(".saveMatch").onclick = async () => {
      const compSku = tr.querySelector(".comp-sku").value.trim() || null;
      const compBar = tr.querySelector(".comp-bar").value.trim() || null;
      const payload = {
        product_id: p.id,
        site_code: siteSelect?.value,
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

async function reloadOneRowLink(productId, tr) {
  const r = await fetch(`${API}/api/matches/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site_code: siteSelect?.value, product_ids: [productId] })
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

// Buttons & paging
loadProductsBtn && (loadProductsBtn.onclick = () => { page = 1; loadProducts(); });
prevPageBtn && (prevPageBtn.onclick = () => { page = Math.max(1, page - 1); window.scrollTo({top:0,behavior:"smooth"}); loadProducts(); });
nextPageBtn && (nextPageBtn.onclick = () => { page = page + 1; window.scrollTo({top:0,behavior:"smooth"}); loadProducts(); });
tagFilter && (tagFilter.onchange = () => { page = 1; loadProducts(); });
autoMatchBtn && (autoMatchBtn.onclick = async () => {
  const code = siteSelect?.value || "";
  const r = await fetch(`${API}/api/matches/auto?site_code=${encodeURIComponent(code)}&limit=100}`, { method: "POST" });
  if (!r.ok) {
    const err = await r.text();
    alert("Auto-match failed:\n" + err);
    return;
  }
  const data = await r.json();
  alert(`Auto match -> attempted=${data.attempted}, found=${data.found}`);
  await loadProducts();
});
refreshAssetsBtn && (refreshAssetsBtn.onclick = async () => {
  // Take SKUs from the *currently visible* rows (after all filters)
  const allSkus = getCurrentPageSkus();
  // Safety cap – do not send more than PAGE_SIZE items
  const skus = allSkus.slice(0, PAGE_SIZE);

  if (!skus.length) {
    alert("Няма заредени продукти на екрана за обновяване.");
    return;
  }

  const payload = { skus };

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
    await loadProducts();
  } catch (e) {
    alert("Refresh failed:\n" + (e?.message || e));
  } finally {
    refreshAssetsBtn.textContent = original;
    refreshAssetsBtn.disabled = false;
  }
});

// Initial load
await loadProducts();


/* ────────────────────────────────────────────────────────────────────────────
   Toolbar layout (MATCHING TAB): reorder controls per requested design
   Left (in order): Categories, Search, Brand input, Brand dropdown, Tags,
                    Praktis presence, Match status
   Right (right→left): Refresh Praktis assets, Auto-match, Load Products,
                       Record count
   ──────────────────────────────────────────────────────────────────────────── */
(function ensureToolbarLayoutMatching(){
  const tb = document.querySelector(".toolbar");
  if (!tb) return;

  // create wrappers once
  let left = document.getElementById("tbLeft");
  let right = document.getElementById("tbRight");
  if (!left){
    left = document.createElement("div");
    left.id = "tbLeft";
    left.style.display = "flex";
    left.style.flexWrap = "wrap";
    left.style.gap = "8px";
  }
  if (!right){
    right = document.createElement("div");
    right.id = "tbRight";
    right.style.display = "flex";
    right.style.flexWrap = "wrap";
    right.style.gap = "8px";
    right.style.marginLeft = "auto";
  }

  // If wrappers not in DOM, reset toolbar and append
  if (!tb.contains(left) || !tb.contains(right)){
    const frag = document.createDocumentFragment();
    while (tb.firstChild) frag.appendChild(tb.firstChild);
    tb.appendChild(left);
    tb.appendChild(right);
    tb.appendChild(frag);
  }

  // Helpers
  const move = (el, parent) => { if (el && parent && el !== parent) parent.appendChild(el); };

  // LEFT SIDE ELEMENTS (Matching tab IDs)
  const catsWrap  = document.getElementById("catsTriggerWrap") || document.getElementById("catsWrap");
  const search    = document.getElementById("searchInput");
  const brandInp  = document.getElementById("brandInput");
  const brandSel  = document.getElementById("brandSelect");
  const tagsSel   = document.getElementById("tagFilter");
  const praktisSel= document.getElementById("praktisPresence");
  const matchSel  = document.getElementById("matchSelect");

  // RIGHT SIDE ELEMENTS (Matching tab IDs)
  const refreshBtn = document.getElementById("refreshPraktisAssets");
  const autoBtn    = document.getElementById("autoMatch");
  const loadBtn    = document.getElementById("loadProducts");
  const recCnt     = document.getElementById("recordCount");

  // If some elements are not created yet (because other scripts build them), retry shortly.
  const needLater = [
    catsWrap, search, brandInp, brandSel, tagsSel, praktisSel, matchSel,
    refreshBtn, autoBtn, loadBtn, recCnt
  ].some(x => !x);
  if (needLater) return setTimeout(ensureToolbarLayoutMatching, 300);

  // LEFT ORDER
  move(catsWrap,  left);
  move(search,    left);
  move(brandInp,  left);
  move(brandSel,  left);
  move(tagsSel,   left);
  move(praktisSel,left);
  move(matchSel,  left);

  // RIGHT ORDER (right→left visually; append in reverse so Refresh ends up rightmost)
  move(recCnt,    right);  // leftmost in the right cluster
  move(loadBtn,   right);
  move(autoBtn,   right);
  move(refreshBtn,right);  // rightmost

  // Done — from now on, even if something re-renders, this function can run again and fix the order.
})();
