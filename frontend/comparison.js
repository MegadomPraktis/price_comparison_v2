// comparison.js — pager like Matching + accurate record counter (active columns + Praktis presence)
import { API, loadSitesInto, loadTagsInto, loadGroupsInto, escapeHtml, fmtPrice } from "./shared.js";

/* ────────────────────────────────────────────────────────────────────────────
   DOM
   ──────────────────────────────────────────────────────────────────────────── */
const siteSelect      = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
const loadLatestBtn   = document.getElementById("loadLatest");
const scrapeNowBtn    = document.getElementById("scrapeNow");

// IMPORTANT: same id as in matching.html
const tagFilter       = document.getElementById("tagFilter");

const table  = document.getElementById("compareTable");
const thead  = table.querySelector("thead") || table.createTHead();
const tbody  = table.querySelector("tbody") || table.appendChild(document.createElement("tbody"));

// Ensure a pager exists (replicate Matching layout)
let pagerContainer = document.querySelector(".pager");
let prevPageBtn    = document.getElementById("prevPage");
let pageInfo       = document.getElementById("pageInfo");
let nextPageBtn    = document.getElementById("nextPage");

(function ensurePager(){
  if (!pagerContainer) {
    pagerContainer = document.createElement("div");
    pagerContainer.className = "pager";
    table.after(pagerContainer);
  }
  // center like Matching
  pagerContainer.style.display = "flex";
  pagerContainer.style.alignItems = "center";
  pagerContainer.style.justifyContent = "center";
  pagerContainer.style.gap = "10px";
  // ensure prev
  if (!prevPageBtn) {
    prevPageBtn = document.createElement("button");
    prevPageBtn.id = "prevPage";
    prevPageBtn.textContent = "Prev";
    pagerContainer.appendChild(prevPageBtn);
  }
  // ensure numbers
  if (!pageInfo) {
    pageInfo = document.createElement("div");
    pageInfo.id = "pageInfo";
    pagerContainer.appendChild(pageInfo);
  }
  pageInfo.style.minWidth = "220px";
  pageInfo.style.display = "flex";
  pageInfo.style.alignItems = "center";
  pageInfo.style.justifyContent = "center";
  pageInfo.style.gap = "8px";
  // ensure next
  if (!nextPageBtn) {
    nextPageBtn = document.createElement("button");
    nextPageBtn.id = "nextPage";
    nextPageBtn.textContent = "Next";
    pagerContainer.appendChild(nextPageBtn);
  }
})();

// ---------------- Toolbar (inject if missing) ----------------
const toolbar = document.querySelector(".toolbar");

// Record counter (right side) — same approach as Matching
let recordCount = document.getElementById("recordCount");
if (!recordCount && toolbar) {
  recordCount = document.createElement("div");
  recordCount.id = "recordCount";
  recordCount.style.marginLeft = "auto";
  recordCount.style.fontWeight = "600";
  recordCount.style.opacity = ".9";
  toolbar.appendChild(recordCount);
}

/* ────────────────────────────────────────────────────────────────────────────
   Search / Brand / Price / Presence (mirrors Matching)
   ──────────────────────────────────────────────────────────────────────────── */
let searchInput = document.getElementById("searchInput");
if (!searchInput) {
  searchInput = document.createElement("input");
  searchInput.id = "searchInput";
  searchInput.placeholder = "Search SKU/Name/Barcode…";
  toolbar?.appendChild(searchInput);
}

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

// Praktis presence dropdown (All / On site / Not on site)
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
   CATEGORIES MEGA MENU — same behavior as Matching
   ──────────────────────────────────────────────────────────────────────────── */
const groupFilter = document.getElementById("groupFilter");
if (groupFilter && !groupFilter.options.length) await loadGroupsInto(groupFilter, true);
let CURRENT_GROUP_ID = "";
let CURRENT_GROUP_LABEL = "";
groupFilter?.addEventListener("change", () => {
  CURRENT_GROUP_ID = groupFilter.value || "";
  CURRENT_GROUP_LABEL = groupFilter.selectedOptions?.[0]?.textContent || "";
  updateSelectedChip();
  page = 1; loadCore(true);
});

let catsTriggerWrap = document.getElementById("catsTriggerWrap");
let catsTrigger, catsMega, catsLeft, catsRight, catsChip;

(function ensureCatsMenu() {
  if (!toolbar) return;

  if (!catsTriggerWrap) {
    catsTriggerWrap = document.createElement("div");
    catsTriggerWrap.id = "catsTriggerWrap";
    catsTriggerWrap.className = "cats-trigger-wrap";
    catsTriggerWrap.innerHTML = `
      <button class="cats-trigger" id="catsTrigger" type="button">
        Categories ▾
      </button>
      <span id="catsSelectedChip" class="group-selected" style="display:none"></span>
      <button id="catsClearBtn" class="btn-clear" style="display:none" type="button">Clear</button>
      <div class="cats-mega" id="catsMega" aria-hidden="true">
        <div class="cats-left">
          <ul class="cats-left-list" id="catsLeft"></ul>
        </div>
        <div class="cats-right">
          <div id="catsRight"></div>
        </div>
      </div>
    `;
    toolbar.insertBefore(catsTriggerWrap, toolbar.firstChild);
  }

  catsTrigger = document.getElementById("catsTrigger");
  catsMega    = document.getElementById("catsMega");
  catsLeft    = document.getElementById("catsLeft");
  catsRight   = document.getElementById("catsRight");
  catsChip    = document.getElementById("catsSelectedChip");

  const clearBtn = document.getElementById("catsClearBtn");
  clearBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    applyGroupSelection("", "Всички");
  });
})();

function buildGroupTree(list) {
  const byId = new Map();
  list.forEach(g => byId.set(g.id, { ...g, children: [] }));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id == null) roots.push(node);
    else {
      const p = byId.get(node.parent_id);
      if (p) p.children.push(node); else roots.push(node);
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

  const liAll = document.createElement("li");
  liAll.className = "root-item all";
  liAll.innerHTML = `<span class="ico">📂</span><span class="lbl">Всички</span>`;
  liAll.dataset.groupId = "";
  catsLeft.appendChild(liAll);

  for (const r of GROUP_TREE.roots) {
    const li = document.createElement("li");
    li.className = "root-item";
    li.dataset.groupId = String(r.id);
    li.innerHTML = `<span class="ico">📁</span><span class="lbl">${escapeHtml(r.name)}</span>`;
    catsLeft.appendChild(li);
  }

  catsLeft.addEventListener("mouseover", (e)=>{
    const li = e.target.closest("li.root-item");
    if (!li) return;
    setActiveRoot(li.dataset.groupId || "");
  });

  catsLeft.addEventListener("click", (e)=>{
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
    catsRight.innerHTML = `<div class="muted" style="padding:10px;">Изберете категория</div>`;
    return;
  }
  const root = GROUP_TREE.byId.get(Number(rootId));
  if (!root) return;

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

  const DELAY = 260;
  ul.querySelectorAll('.l2-item').forEach(li => {
    let t = null;
    li.addEventListener('mouseenter', () => {
      if (t) { clearTimeout(t); t = null; }
      li.classList.add('open');
    });
    li.addEventListener('mouseleave', () => {
      t = setTimeout(() => li.classList.remove('open'), DELAY);
    });
  });

  ul.addEventListener("click", (e)=>{
    const a = e.target.closest("a[data-group-id]");
    if (!a) return;
    e.preventDefault();
    applyGroupSelection(a.dataset.groupId || "", a.textContent || "");
    closeCatsPanel();
  });
}

function setActiveRoot(id) {
  ACTIVE_ROOT_ID = id || "";
  catsLeft?.querySelectorAll("li.root-item").forEach(li=>{
    li.classList.toggle("active", (li.dataset.groupId || "") === ACTIVE_ROOT_ID);
  });
  if (ACTIVE_ROOT_ID) renderRightColumns(ACTIVE_ROOT_ID);
  else catsRight.innerHTML = `<div class="muted" style="padding:10px;">Изберете категория</div>`;
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

function updateSelectedChip() {
  if (!catsChip) return;
  const clearBtn = document.getElementById("catsClearBtn");
  if (CURRENT_GROUP_ID) {
    catsChip.style.display = "";
    catsChip.textContent = CURRENT_GROUP_LABEL || `ID ${CURRENT_GROUP_ID}`;
    if (clearBtn) clearBtn.style.display = "";
  } else {
    catsChip.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
  }
}

function applyGroupSelection(id, label) {
  CURRENT_GROUP_ID = String(id || "");
  CURRENT_GROUP_LABEL = label || "";
  if (groupFilter) ensureSelectHasOption(groupFilter, id, label);
  updateSelectedChip();
  page = 1; loadCore(true);
}

// Panel open/close
const PANEL_DELAY = 380;
let panelTimer = null;
function openCatsPanel() {
  if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
  catsTriggerWrap?.classList.add("open");
  catsMega?.setAttribute("aria-hidden", "false");
}
function closeCatsPanel() {
  if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }
  catsTriggerWrap?.classList.remove("open");
  catsMega?.setAttribute("aria-hidden", "true");
}
function scheduleClosePanel() {
  if (panelTimer) clearTimeout(panelTimer);
  panelTimer = setTimeout(() => closeCatsPanel(), PANEL_DELAY);
}

(async function initMegaMenu() {
  if (!catsMega) return;
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

  catsTriggerWrap?.addEventListener("mouseenter", openCatsPanel);
  catsTriggerWrap?.addEventListener("mouseleave", scheduleClosePanel);
  catsTrigger?.addEventListener("click", (e)=>{
    e.preventDefault();
    if (catsTriggerWrap.classList.contains("open")) scheduleClosePanel(); else openCatsPanel();
  });
  catsMega?.addEventListener("mouseenter", ()=>{ if (panelTimer) { clearTimeout(panelTimer); panelTimer = null; }});
  document.addEventListener("click", (e)=>{ if (!catsTriggerWrap.contains(e.target)) closeCatsPanel(); });
})();

/* ────────────────────────────────────────────────────────────────────────────
   Columns popover
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

let colWrap = document.getElementById("colWrap");
let colBtn  = document.getElementById("colBtn");
let colMenu = document.getElementById("colMenu");
(function ensureColMenu(){
  if (!toolbar) return;
  toolbar.style.position = toolbar.style.position || "relative";
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
    colWrap.appendChild(colBtn);
  } else {
    colWrap.appendChild(colBtn);
  }
  if (!colMenu) {
    colMenu = document.createElement("div");
    colMenu.id = "colMenu";
    colMenu.className = "col-menu";
    colMenu.style.display = "none";
    colWrap.appendChild(colMenu);
  } else {
    colWrap.appendChild(colMenu);
  }
  renderColMenu();
})();
function renderColMenu(){
  if (!colMenu) return;
  const enabled = new Set(colOrder);
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

  colMenu.querySelectorAll(".col-row input[type=checkbox]").forEach(inp=>{
    inp.addEventListener("change", (e)=>{
      e.stopPropagation();
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
      e.stopPropagation();
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
      e.stopPropagation();
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
    e.stopPropagation();
    colOrder = [...ALL_COLS];
    saveCols(colOrder);
    renderColMenu();
    page = 1; loadCore(false);
  });
  colMenu.querySelector(".col-reset")?.addEventListener("click", (e)=>{
    e.stopPropagation();
    colOrder = [...ALL_COLS];
    saveCols(colOrder);
    renderColMenu();
    page = 1; loadCore(false);
  });
}
colBtn?.addEventListener("click", (e)=>{
  e.stopPropagation();
  if (!colMenu) return;
  colMenu.style.display = (colMenu.style.display === "none") ? "block" : "none";
});
document.addEventListener("click", (e)=>{
  if (!colMenu || !colBtn) return;
  if (colMenu.style.display === "none") return;
  if (colMenu.contains(e.target) || colBtn.contains(e.target)) return;
  colMenu.style.display = "none";
});

/* ────────────────────────────────────────────────────────────────────────────
   State / Styles
   ──────────────────────────────────────────────────────────────────────────── */
let page = 1;
const PER_PAGE   = 50;     // fixed page size (like Matching)
const FETCH_LIMIT= 2000;   // server fetch size used to build pages client-side

let lastRows = [];    // raw rows from /api/compare
let lastSite = "all";
let lastTag  = "";

// CSS bits
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

    .price-wrap{
      display:grid;
      grid-template-rows: 14px 22px;
      align-items:center;
      justify-items:center;
      row-gap:2px;
      min-height: 44px;
      line-height:1.1;
      text-align:center;
      white-space:nowrap;
      font-variant-numeric: tabular-nums;
      font-family: Inter, "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, "Noto Sans", "Liberation Sans", "Apple Color Emoji", "Segoe UI Emoji";
    }
    .price-old{ font-size:11px; color:#9aa3b2; text-decoration:line-through; }
    .price-old.hidden{ visibility:hidden; }
    .price-line{ display:inline-flex; align-items:center; gap:6px; }
    .price-new{ font-weight:800; font-size:15px; letter-spacing:.2px; }
    .price-link{ text-decoration:none; font-size:12px; line-height:1; }
    .price-badge{
      font-size:10px; font-weight:700; letter-spacing:.3px;
      border:1px solid var(--border); border-radius:999px;
      padding:1px 6px;
      background:#fff1e2; color:#8d4a12;
    }
    .muted{ font-size:12px; color:#6b7280; padding:6px; }
  `;
  document.head.appendChild(s);
})();

/* ────────────────────────────────────────────────────────────────────────────
   Spinner & Toast
   ──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Utils
   ──────────────────────────────────────────────────────────────────────────── */
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
function fmtPlain(n) {
  const v = toNum(n);
  if (v === null) return "N/A";
  return v.toFixed(2);
}
function isOnPraktis(url) {
  if (!url) return false;
  const u = String(url).trim();
  return u.startsWith("https://praktis.bg/") && u !== "https://praktis.bg";
}
const effective = (promo, regular) => {
  const p = toNum(promo);
  const r = toNum(regular);
  return p !== null ? p : r;
};
function abbrLabel(lbl) {
  if (!lbl) return "";
  const s = lbl.trim();
  const map = { "Оферта на седмицата":"ОС", "Оферта на деня":"ОД", "Топ оферта":"ТО", "В брошура":"БР" };
  if (map[s]) return map[s];
  return s.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 3);
}
function getRowLabel(row) {
  const v = row && row.competitor_label;
  return (typeof v === "string" && v.trim()) ? v.trim() : null;
}
function priceCellHTML(promo, regular, url=null, labelText=null) {
  const eff = effective(promo, regular);
  const showOld = (toNum(regular) !== null && toNum(promo) !== null && toNum(promo) < toNum(regular));
  const oldStr  = showOld ? fmtPlain(regular) : "";
  const newStr  = fmtPlain(eff);
  const link = url ? `<a class="price-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">↗</a>` : "";
  const badge = labelText ? `<span class="price-badge" title="${escapeHtml(labelText)}">${escapeHtml(abbrLabel(labelText))}</span>` : "";
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
function classForEffective(valEff, allEff) {
  const v = toNum(valEff);
  const nums = allEff.map(toNum).filter(n => n !== null);
  if (v === null || nums.length === 0) return "";
  const min = Math.min(...nums);
  if (v === min) return "green";
  if (v > min) return "red";
  return "";
}

// Matching-style brand helpers
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

// Categories helpers
function getDescendantIds(rootId) {
  const out = new Set();
  if (!GROUP_TREE || !rootId) return out;
  const start = GROUP_TREE.byId.get(Number(rootId));
  if (!start) return out;
  (function walk(n){
    out.add(Number(n.id));
    (n.children || []).forEach(walk);
  })(start);
  return out;
}
function extractRowGroupIds(row) {
  if (Array.isArray(row.group_ids))               return row.group_ids.map(Number);
  if (Array.isArray(row.product_group_ids))       return row.product_group_ids.map(Number);
  if (Array.isArray(row.groups))                  return row.groups.map(g => Number(g?.id ?? g));
  if (Array.isArray(row.product_groups))          return row.product_groups.map(g => Number(g?.id ?? g));
  if (row.group_id != null)                       return [Number(row.group_id)];
  if (row.product_group_id != null)               return [Number(row.product_group_id)];
  return [];
}
function filterByGroup(rows, selectedGroupId, isPivot=false) {
  if (!selectedGroupId) return rows;
  const want = getDescendantIds(selectedGroupId);
  if (want.size === 0) return rows;

  if (!isPivot) {
    return rows.filter(r => {
      const ids = extractRowGroupIds(r);
      if (!ids.length) return false;
      return ids.some(id => want.has(Number(id)));
    });
  }
  const withInline = rows.filter(p => Array.isArray(p.group_ids) && p.group_ids.length > 0);
  if (withInline.length > 0) {
    return rows.filter(p => {
      const ids = Array.isArray(p.group_ids) ? p.group_ids : [];
      return ids.some(id => want.has(Number(id)));
    });
  }
  const goodSkus = new Set(
    lastRows.filter(r => {
      const ids = extractRowGroupIds(r);
      return ids.length && ids.some(id => want.has(Number(id)));
    }).map(r => r.product_sku)
  );
  if (goodSkus.size === 0) return rows;
  return rows.filter(p => goodSkus.has(p.code));
}

/* ────────────────────────────────────────────────────────────────────────────
   Data fetch
   ──────────────────────────────────────────────────────────────────────────── */
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

// Backend rows (flat)
async function fetchCompare({ site_code, limit, source="snapshots", tag_id=null, brand=null, q=null, category_id=null }) {
  const params = new URLSearchParams();
  params.set("site_code", site_code);
  params.set("limit", String(limit));
  params.set("source", source);
  if (tag_id && tag_id !== "all" && tag_id !== "") params.set("tag_id", tag_id);
  if (brand && brand.trim()) params.set("brand", brand);
  if (q && q.trim()) params.set("q", q.trim());
  if (category_id && String(category_id).trim() !== "") params.set("category_id", String(category_id).trim());
  const r = await fetch(`${API}/api/compare?${params.toString()}`);
  if (!r.ok) throw new Error(`compare HTTP ${r.status}`);
  return r.json();
}

/* ────────────────────────────────────────────────────────────────────────────
   Pivot (All sites)
   ──────────────────────────────────────────────────────────────────────────── */
function pivotAll(flatRows) {
  const map = new Map();
  for (const r of flatRows) {
    const sku = r.product_sku ?? "";
    if (!sku) continue;

    const rowGroups = extractRowGroupIds(r);

    if (!map.has(sku)) {
      map.set(sku, {
        code: sku,
        name: r.product_name ?? "N/A",
        brand: r.product_brand || r.brand || null,
        tags:  r.product_tags || r.tags || null,
        praktis_regular: toNum(r.product_price_regular),
        praktis_promo:   toNum(r.product_price_promo),
        group_ids: rowGroups && rowGroups.length ? rowGroups.slice() : [],
        // competitor slots
        praktiker_regular: null, praktiker_promo: null, praktiker_url: null, praktiker_label: null,
        mrbricolage_regular: null, mrbricolage_promo: null, mrbricolage_url: null, mrbricolage_label: null,
        mashinibg_regular: null, mashinibg_promo: null, mashinibg_url: null, mashinibg_label: null,
      });
    } else {
      const agg = map.get(sku);
      if ((!agg.group_ids || agg.group_ids.length === 0) && rowGroups && rowGroups.length) {
        agg.group_ids = rowGroups.slice();
      }
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

/* ────────────────────────────────────────────────────────────────────────────
   Price status helpers
   ──────────────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────────────
   Renderers
   ──────────────────────────────────────────────────────────────────────────── */
function priceCell(promo, regular, url, cls, label=null) {
  return `<td class="${cls}">${priceCellHTML(promo, regular, url, label)}</td>`;
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
  const headers = siteKey.includes("praktiker") ? [
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

    const compLabel = getRowLabel(r);

    return `
      <tr>
        <td>${escapeHtml(r.product_sku ?? "")}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(r.product_name ?? "N/A")}</a>` : escapeHtml(r.product_name ?? "N/A")}</td>
        <td>${escapeHtml(r.competitor_sku ?? "")}</td>
        <td>${compLink}</td>
        ${priceCell(r.product_price_promo, r.product_price_regular, null, clsOur)}
        ${priceCell(r.competitor_price_promo, r.competitor_price_regular, r.competitor_url || null, clsComp, compLabel)}
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

  const activeCols = colOrder.slice();

  if (activeCols.length > 0) {
    pivotPage = pivotPage.filter(p => {
      for (const key of activeCols) {
        const meta = COL_META[key];
        const hasPrice = toNum(p[meta.promo]) !== null || toNum(p[meta.regular]) !== null;
        if (hasPrice) return true;
      }
      return false;
    });
  }

  const headers = [
    "Praktis Code","Image","Praktis Name","Praktis Price",
    ...activeCols.map(k => `${COL_LABELS[k]} Price`)
  ];
  resetHead(headers);

  const html = pivotPage.map(p => {
    const effP   = effective(p.praktis_promo, p.praktis_regular);

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

    const compEff = compEntries.map(e => e.eff).filter(v => v !== null);
    const allEff  = [effP, ...compEff];
    const clsP    = compEff.length ? classForEffective(effP, allEff) : "";

    const asset = assetsBySku[p.code] || {};
    const praktisUrl = asset.product_url || null;
    const praktisImg = asset.image_url || null;

    const compCells = compEntries.map(e => {
      const cls = classForEffective(e.eff, allEff);
      return priceCell(e.promo, e.reg, e.url, cls, e.label);
    }).join("");

    return `
      <tr>
        <td>${escapeHtml(p.code)}</td>
        ${imgTd(praktisImg)}
        <td>${praktisUrl ? `<a href="${escapeHtml(praktisUrl)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</td>
        ${priceCell(p.praktis_promo, p.praktis_regular, null, clsP)}
        ${compCells}
      </tr>`;
  }).join("");
  tbody.innerHTML = html;
}

/* ────────────────────────────────────────────────────────────────────────────
   Pager UI — numeric buttons with ellipses (like Matching)
   ──────────────────────────────────────────────────────────────────────────── */
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
  if (!active) b.onclick = () => { page = n; window.scrollTo({top:0, behavior:"smooth"}); loadCore(false); };
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
   Filters snapshot
   ──────────────────────────────────────────────────────────────────────────── */
function currentFilters() {
  const site_code = siteSelect?.value || "all";
  const q = (searchInput?.value || "").trim();
  const tag_id = (tagFilter?.value || "").trim();
  const brand = currentBrandFilter();
  const category_id = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "");
  const praktis_presence = (praktisPresence?.value || "");
  return { site_code, q, tag_id, brand, category_id, praktis_presence };
}

/* ────────────────────────────────────────────────────────────────────────────
   Main load
   ──────────────────────────────────────────────────────────────────────────── */
async function loadCore(refetch=true) {
  const site_code = siteSelect?.value || "all";
  const selectedGroupId = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "");
  const tagVal   = tagFilter?.value ?? "";
  const qText    = (searchInput?.value || "").trim().toLowerCase();
  const brandRaw = currentBrandFilter();
  const priceF   = (priceSelect?.value || "");
  const presenceVal = (praktisPresence?.value || "");

  // 0) remove legacy "compareLimit" control if present (the old "200")
  const oldLimit = document.getElementById("compareLimit");
  if (oldLimit && oldLimit.parentNode) oldLimit.parentNode.removeChild(oldLimit);

  // 1) (Re)fetch base rows from backend (includes category_id)
  if (refetch || site_code !== lastSite || (tagFilter?.value ?? "") !== lastTag) {
    lastRows = await fetchCompare({
      site_code, limit: FETCH_LIMIT, source: "snapshots",
      tag_id: tagVal, brand: brandRaw, q: qText,
      category_id: selectedGroupId || null
    }) || [];
    lastSite = site_code; lastTag = tagVal; page = 1;
  }

  // Helper: apply basic filters (tag, q, brand, category, price)
  const applyCommonFilters = (rowsOrPivot, isPivot) => {
    let arr = rowsOrPivot.slice();

    if (tagVal) {
      arr = arr.filter(x => {
        const tags = (isPivot ? x.tags : (x.product_tags || x.tags)) || [];
        return Array.isArray(tags) ? tags.some(t => String(t.id) === String(tagVal)) : true;
      });
    }
    if (qText) {
      arr = arr.filter(x => {
        if (isPivot) {
          return (x.code || "").toLowerCase().includes(qText) ||
                 (x.name || "").toLowerCase().includes(qText);
        }
        return [x.product_sku, x.product_name, x.product_barcode, x.competitor_sku, x.competitor_name]
          .map(v => (v || "").toString().toLowerCase())
          .some(s => s.includes(qText));
      });
    }
    if (brandRaw) {
      arr = arr.filter(x => brandMatches(isPivot ? x.brand : (x.product_brand || x.brand), brandRaw));
    }
    if (selectedGroupId) {
      arr = filterByGroup(arr, selectedGroupId, isPivot);
    }
    if (priceF) {
      arr = arr.filter(x => (isPivot ? statusAll(x) : statusSingle(x)) === priceF);
    }
    return arr;
  };

  // 2) Build data + count AFTER applying column visibility & presence filters
  if (site_code === "all") {
    // base pivot
    let pivot = pivotAll(lastRows);
    // apply common (non-presence) filters
    pivot = applyCommonFilters(pivot, true);

    // apply "active columns only" to COUNT as well
    const activeCols = colOrder.slice();
    if (activeCols.length > 0) {
      pivot = pivot.filter(p => {
        for (const key of activeCols) {
          const meta = COL_META[key];
          const hasPrice = toNum(p[meta.promo]) !== null || toNum(p[meta.regular]) !== null;
          if (hasPrice) return true;
        }
        return false;
      });
    }

    // presence-aware count -> need assets for all SKUs when filtering by presence
    let totalPivotForCount = pivot;
    if (presenceVal) {
      const allSkus = totalPivotForCount.map(p => p.code);
      const assetsMap = await fetchAssetsForSkus(allSkus);
      totalPivotForCount = totalPivotForCount.filter(p => {
        const a = assetsMap[p.code] || {};
        const onSite = isOnPraktis(a.product_url || "");
        return presenceVal === "present" ? onSite : !onSite;
      });
    }

    const total = totalPivotForCount.length;
    if (recordCount) recordCount.textContent = `${total} records`;

    // 3) Pagination + render: fetch assets only for current page
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page > totalPages) page = totalPages;

    const start = (page - 1) * PER_PAGE, end = start + PER_PAGE;
    const pageSlice = totalPivotForCount.slice(start, end);

    const assets = await fetchAssetsForSkus(pageSlice.map(p => p.code));
    renderAllPage(pageSlice, assets);

    renderNumbers(totalPages);
    if (prevPageBtn) prevPageBtn.disabled = (page <= 1);
    if (nextPageBtn) nextPageBtn.disabled = (page >= totalPages);
  } else {
    // single-site
    let rows = applyCommonFilters(lastRows.slice(), false);

    // presence-aware count for single-site too
    let rowsForCount = rows;
    if (presenceVal) {
      const allSkus = rowsForCount.map(r => r.product_sku).filter(Boolean);
      const assetsMap = await fetchAssetsForSkus(allSkus);
      rowsForCount = rowsForCount.filter(r => {
        const a = assetsMap[r.product_sku] || {};
        const onSite = isOnPraktis(a.product_url || "");
        return presenceVal === "present" ? onSite : !onSite;
      });
    }

    const total = rowsForCount.length;
    if (recordCount) recordCount.textContent = `${total} records`;

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (page > totalPages) page = totalPages;
    const start = (page - 1) * PER_PAGE, end = start + PER_PAGE;
    const slice = rowsForCount.slice(start, end);

    const assets = await fetchAssetsForSkus(slice.map(r => r.product_sku).filter(Boolean));
    renderSingle(slice, site_code, assets);

    renderNumbers(totalPages);
    if (prevPageBtn) prevPageBtn.disabled = (page <= 1);
    if (nextPageBtn) nextPageBtn.disabled = (page >= totalPages);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Init & Events
   ──────────────────────────────────────────────────────────────────────────── */
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

  await loadTagsInto(tagFilter, true);
  tagFilter.addEventListener("change", () => { page = 1; loadCore(true); });

  await fetchBrands();
  brandInput.addEventListener("input", () => { if (brandInput.value) brandSelect.value = ""; page = 1; loadCore(true); });
  brandSelect.addEventListener("change", () => { if (brandSelect.value) brandInput.value = ""; page = 1; loadCore(true); });

  let t; searchInput.addEventListener("input", () => {
    clearTimeout(t); t = setTimeout(() => { page = 1; loadCore(false); }, 300);
  });
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); page = 1; loadCore(false); }});

  priceSelect.addEventListener("change", () => { page = 1; loadCore(false); });
  (document.getElementById("praktisPresence"))?.addEventListener("change", () => { page = 1; loadCore(false); });

  const onLoadLatest = withSpinner(loadLatestBtn, "Loading…", async () => { await loadCore(true); toast("Loaded latest data from DB"); });

  // ────────────── CHANGED: Scrape only current filtered page (max 50) ──────────────
  const onScrapeNow  = withSpinner(scrapeNowBtn,  "Scraping…", async () => {
    const site = (siteSelect?.value || "").trim();
    if (!site || site === "all") { toast("Pick a single store first", "error"); return; }

    const q           = (searchInput?.value || "").trim();
    const tag_id      = (tagFilter?.value || "").trim();
    const brand       = (brandSelect?.value || brandInput?.value || "").trim();
    const category_id = (groupFilter?.value?.trim?.() || CURRENT_GROUP_ID || "").trim();

    const params = new URLSearchParams();
    params.set("site_code", site);
    if (q)           params.set("q", q);
    if (tag_id)      params.set("tag_id", tag_id);
    if (brand)       params.set("brand", brand);
    if (category_id) params.set("category_id", category_id);
    params.set("limit", "50"); // hard cap for the button scrape

    const r = await fetch(`${API}/api/compare/scrape/filtered?${params.toString()}`, { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let js = {};
    try { js = await r.json(); } catch {}
    toast(`Queued: ${js.attempted ?? 0}, new snapshots: ${js.written ?? 0}`);
    await loadCore(true);
    toast("Scrape finished");
  });

  loadLatestBtn?.addEventListener("click", () => { page = 1; onLoadLatest(); });
  scrapeNowBtn?.addEventListener("click",  () => { page = 1; onScrapeNow(); });
  prevPageBtn?.addEventListener("click",   () => { page = Math.max(1, page - 1); window.scrollTo({top:0,behavior:"smooth"}); loadCore(false); });
  nextPageBtn?.addEventListener("click",   () => { page = page + 1; window.scrollTo({top:0,behavior:"smooth"}); loadCore(false); });

  // Export (unchanged; still honors filters)
  function exportViaBackend() {
    const site_code = siteSelect?.value || "all";

    const q = (document.getElementById("searchInput")?.value || "").trim();
    const tag_id = (document.getElementById("tagFilter")?.value || "").trim();

    const bt = (document.getElementById("brandInput")?.value || "").trim();
    const bs = (document.getElementById("brandSelect")?.value || "").trim();
    const brand = bs || bt;

    const priceRaw = (document.getElementById("priceStatus")?.value || "").trim(); // "" | better | worse
    let price_status = "";
    if (priceRaw === "better") price_status = "ours_lower";
    else if (priceRaw === "worse") price_status = "ours_higher";

    const category_id =
      (document.getElementById("categoryFilter")?.value ||
       document.getElementById("categorySelect")?.value ||
       groupFilter?.value || CURRENT_GROUP_ID || "").trim();

    const praktis_presence = (document.getElementById("praktisPresence")?.value || "").trim(); // "" | present | missing

    const baseCols = ["praktis_code", "image", "praktis_name", "praktis_price"];
    let competitorTokens = [];

    const table = document.getElementById("compareTable");
    const thead = table?.querySelector("thead");
    if (site_code === "all" && thead) {
      const ths = thead.querySelectorAll("th");
      ths.forEach(th => {
        const cs = window.getComputedStyle(th);
        const visible = cs.display !== "none" && th.offsetWidth > 0 && th.offsetHeight > 0;
        if (!visible) return;

        let key = (th.getAttribute("data-site") || "").trim().toLowerCase();
        if (!key) {
          const txt = (th.textContent || "").trim().toLowerCase();
          if (txt.includes("praktiker")) key = "praktiker";
          else if (txt.includes("bricol")) key = "mrbricolage";
          else if (txt.includes("mashin")) key = "mashinibg";
        }
        if (key && (key === "praktiker" || key === "mrbricolage" || key === "mashinibg")) {
          competitorTokens.push(`${key}_price`);
        }
      });
    }

    if (site_code === "all" && competitorTokens.length === 0 && Array.isArray(window.colOrder)) {
      competitorTokens = window.colOrder.map(k => `${String(k).toLowerCase()}_price`);
    }

    const columns = site_code === "all" ? baseCols.concat(competitorTokens) : null;

    const per_page = PER_PAGE;
    const currentPage = Number(page) || 1;

    const params = new URLSearchParams();
    params.set("site_code", site_code);
    params.set("limit", String(FETCH_LIMIT));
    params.set("source", "snapshots");

    if (q)                 params.set("q", q);
    if (tag_id)            params.set("tag_id", tag_id);
    if (brand)             params.set("brand", brand);
    if (price_status)      params.set("price_status", price_status);
    if (category_id)       params.set("category_id", category_id);
    if (praktis_presence)  params.set("praktis_presence", praktis_presence);

    params.set("page", String(currentPage));
    params.set("per_page", String(per_page));

    if (columns && columns.length) {
      params.set("columns", columns.join(","));
    }

    window.location = `${API}/api/export/compare.xlsx?${params.toString()}`;
  }

  {
    const btn = document.getElementById("exportExcel") || document.querySelector("[data-export], .export");
    if (btn) {
      const clone = btn.cloneNode(true);
      btn.parentNode.replaceChild(clone, btn);
      clone.addEventListener("click", exportViaBackend);
    }
  }

  // Initial load
  await loadCore(true);
}

init().catch(e => { console.error("Comparison init failed:", e); toast("Init failed", "error"); });


/* ────────────────────────────────────────────────────────────────────────────
   Toolbar layout: reorder controls per requested design
   Left (in order): Categories, Search, Brand input, Brand dropdown, Tags, Price status, Presence
   Right (right→left): Export, Scrape Now, Load Latest, Columns, Record count
   ──────────────────────────────────────────────────────────────────────────── */
(function ensureToolbarLayout(){
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
    // Move all existing children temporarily to a fragment (to avoid losing them)
    const frag = document.createDocumentFragment();
    while (tb.firstChild) frag.appendChild(tb.firstChild);
    tb.appendChild(left);
    tb.appendChild(right);
    // Re-attach old children; they will be repositioned below
    tb.appendChild(frag);
  }

  // Helpers
  const move = (el, parent) => { if (el && parent && el !== parent) parent.appendChild(el); };

  const catsWrap = document.getElementById("catsTriggerWrap") || document.getElementById("catsWrap");
  const search   = document.getElementById("searchInput");
  const brandInp = document.getElementById("brandInput");
  const brandSel = document.getElementById("brandSelect");
  const tagsSel  = document.getElementById("tagFilter");
  const priceSel = document.getElementById("priceStatus");
  const presSel  = document.getElementById("praktisPresence");
  const exportBtn= document.getElementById("exportExcel");
  const scrapeBtn= document.getElementById("scrapeNow");
  const loadBtn  = document.getElementById("loadLatest");
  const colWrap  = document.getElementById("colWrap");
  const recCnt   = document.getElementById("recordCount");

  // If some elements are not created yet (because other scripts build them), retry shortly.
  const needLater = [catsWrap, search, brandInp, brandSel, tagsSel, priceSel, presSel, exportBtn, scrapeBtn, loadBtn, colWrap, recCnt].some(x => !x);
  if (needLater) return setTimeout(ensureToolbarLayout, 300);

  // LEFT ORDER
  move(catsWrap, left);
  move(search, left);
  move(brandInp, left);
  move(brandSel, left);
  move(tagsSel, left);
  move(priceSel, left);
  move(presSel, left);

  // RIGHT ORDER (right→left visually; we append in the reverse desired order so export ends up rightmost)
  move(recCnt, right);
  move(colWrap, right);
  move(loadBtn, right);
  move(scrapeBtn, right);
  move(exportBtn, right);
})();
