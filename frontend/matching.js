// matching.js — Matching tab with brand & tag filters + MEGA MENU category picker (hover/click)
// Keeps all existing behavior; adds: (a) L2→L3 hover flyout, (b) close-delay so menu doesn't close too fast.

import { API, loadSitesInto, loadTagsInto, loadGroupsInto, escapeHtml, makeTagBadge } from "./shared.js";

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
const pageInfo = document.getElementById("pageInfo");
const tbodyMatch = document.querySelector("#matchTable tbody");
const loadProductsBtn = document.getElementById("loadProducts");
const searchInput = document.getElementById("searchInput");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const autoMatchBtn = document.getElementById("autoMatch");
const refreshAssetsBtn = document.getElementById("refreshPraktisAssets");

// Toolbar-created controls (if missing in HTML)
const toolbar = document.querySelector(".toolbar");

// Remove legacy 3 buttons if present
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

// Match status dropdown
let matchSelect = document.getElementById("matchSelect");
if (!matchSelect) {
  matchSelect = document.createElement("select");
  matchSelect.id = "matchSelect";
  toolbar?.appendChild(matchSelect);
}
function initMatchSelect() {
  matchSelect.innerHTML = "";
  [["","All"],["matched","Matched"],["unmatched","Unmatched"]].forEach(([v,t])=>{
    const o = document.createElement("option"); o.value=v; o.textContent=t; matchSelect.appendChild(o);
  });
}
initMatchSelect();

// --- Praktis presence dropdown
let praktisPresence = document.getElementById("praktisPresence");
if (!praktisPresence) {
  praktisPresence = document.createElement("select");
  praktisPresence.id = "praktisPresence";
  praktisPresence.innerHTML = `
    <option value="">All products</option>
    <option value="present">Products on Praktis website</option>
    <option value="missing">Products NOT on Praktis website</option>`;
  toolbar?.appendChild(praktisPresence);
}
praktisPresence.addEventListener("change", () => { page = 1; loadProducts(); });

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
matchSelect.addEventListener("change", () => {
  matchState = matchSelect.value || "";
  page = 1; loadProducts();
});

function isOnPraktis(url) {
  if (!url) return false;
  const u = String(url).trim();
  return u.startsWith("https://praktis.bg/") && u !== "https://praktis.bg/";
}

/* ────────────────────────────────────────────────────────────────────────────
   Category MEGA MENU
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
  attachL2HoverHandlers(ul);   // keep L3 open briefly when moving mouse
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

// --- ensure the hidden <select> reflects the clicked id, and keep a JS fallback
function ensureSelectHasOption(selectEl, id, label) {
  const idStr = String(id || "");
  if (!selectEl) return; // handled by CURRENT_GROUP_ID fallback
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
  selectEl.value = idStr; // selects it (or clears if idStr === "")
}

function applyGroupSelection(id, label) {
  CURRENT_GROUP_ID = String(id || "");                    // ← always set fallback
  if (groupFilter) ensureSelectHasOption(groupFilter, id, label); // keep select in sync when present
  if (groupSelectedLabel) groupSelectedLabel.textContent = id ? label : "Всички";
  page = 1;
  loadProducts();
}

// Open/close with delay so it doesn't collapse too fast
const CLOSE_DELAY = 350; // ms
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

// Init menu
(async function initMegaMenu() {
  if (!catsPanel) return; // if HTML not present, silently skip
  try {
    const r = await fetch(`${API}/api/groups`);
    const groups = r.ok ? await r.json() : [];
    GROUP_TREE = buildGroupTree(groups);
    renderLeftRoots();
    // default active = first root
    const firstRoot = GROUP_TREE.roots[0]?.id;
    setActiveRoot(firstRoot ? String(firstRoot) : "");
  } catch (e) {
    console.warn("Groups load failed", e);
  }

  // open on hover & click; close on delayed mouseleave and outside click
  if (catsWrap && catsPanel) {
    catsWrap.addEventListener("mouseenter", openCatsPanel);
    catsWrap.addEventListener("mouseleave", scheduleClose);
    catsTrigger?.addEventListener("click", (e)=> {
      e.preventDefault();
      if (catsWrap.classList.contains("open")) scheduleClose(); else openCatsPanel();
    });
    // keep open while moving between children
    catsPanel.addEventListener("mouseenter", () => { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }});
    document.addEventListener("click", (e)=>{
      if (!catsWrap.contains(e.target)) closeCatsPanel();
    });
  }

  // clear btn
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
   Data load & render
   ──────────────────────────────────────────────────────────────────────────── */
async function loadProducts() {
  const q = searchInput?.value.trim();
  const url = new URL(`${API}/api/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", "50");
  if (q) url.searchParams.set("q", q);

  const tagId = tagFilter?.value?.trim?.() || "";
  if (tagId) url.searchParams.set("tag_id", tagId);

  const brand = currentBrandFilter();
  if (brand) url.searchParams.set("brand", brand);

  if (siteSelect?.value) url.searchParams.set("site_code", siteSelect.value);
  if (matchState) url.searchParams.set("matched", matchState);

  // read from <select> when it exists; otherwise from JS fallback
  const selectedGroupId = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "");
  if (selectedGroupId) url.searchParams.set("group_id", selectedGroupId);

  const r = await fetch(url);
  if (!r.ok) {
    alert("Failed to load products");
    return;
  }
  const products = await r.json();

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
    } else {
      console.warn("Lookup matches failed", await r2.text());
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
  if (pageInfo) pageInfo.textContent = `Page ${page} (rows: ${products.length})`;
}

async function renderMatchRows(products, matchesByProductId, tagsByProductId, assetsBySku = {}) {
  const ALL_TAGS = await getAllTagsCached();
  const presenceMode = (document.getElementById("praktisPresence")?.value || "");
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
prevPageBtn && (prevPageBtn.onclick = () => { page = Math.max(1, page - 1); loadProducts(); });
nextPageBtn && (nextPageBtn.onclick = () => { page = page + 1; loadProducts(); });
tagFilter && (tagFilter.onchange = () => { page = 1; loadProducts(); });
autoMatchBtn && (autoMatchBtn.onclick = async () => {
  const code = siteSelect?.value || "";
  const r = await fetch(`${API}/api/matches/auto?site_code=${encodeURIComponent(code)}&limit=100`, { method: "POST" });
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
  const payload = { limit: 500 };
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
