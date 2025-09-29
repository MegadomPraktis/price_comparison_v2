import { API, loadSitesInto, escapeHtml } from "./shared.js";

const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
refreshSitesBtn.onclick = () => loadSitesInto(siteSelect);
await loadSitesInto(siteSelect);

// paging + search
let page = 1;
const pageInfo = document.getElementById("pageInfo");
const tbodyMatch = document.querySelector("#matchTable tbody");
const loadProductsBtn = document.getElementById("loadProducts");
const searchInput = document.getElementById("searchInput");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const autoMatchBtn = document.getElementById("autoMatch");

async function loadProducts() {
  const q = searchInput.value.trim();
  const url = new URL(`${API}/api/products`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", "50");
  if (q) url.searchParams.set("q", q);

  // 1) load products
  const r = await fetch(url);
  if (!r.ok) {
    alert("Failed to load products");
    return;
  }
  const products = await r.json();

  // 2) ask backend for existing matches for these product IDs
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

  renderMatchRows(products, matchesByProductId);
  pageInfo.textContent = `Page ${page} (rows: ${products.length})`;
}

function renderMatchRows(products, matchesByProductId) {
  tbodyMatch.innerHTML = "";
  for (const p of products) {
    const m = matchesByProductId[p.id] || null;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.sku}</td>
      <td>${p.barcode ?? ""}</td>
      <td>${escapeHtml(p.name)}</td>

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

      <td><button class="saveMatch">${m ? "Update" : "Save"}</button></td>
    `;

    // Subtle prefill highlight
    if (m?.competitor_sku)  tr.querySelector(".comp-sku").style.background  = "rgba(59,130,246,.12)";
    if (m?.competitor_barcode) tr.querySelector(".comp-bar").style.background = "rgba(59,130,246,.12)";

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
      // Reload just this row's link if needed:
      await reloadOneRowLink(p.id, tr);
      alert("Saved");
    };

    tbodyMatch.appendChild(tr);
  }
}

async function reloadOneRowLink(productId, tr) {
  // re-fetch matches/lookup for this single product to refresh the link (if a snapshot exists)
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
    // add/update the 🔗 anchor
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

loadProductsBtn.onclick = () => { page = 1; loadProducts(); };
prevPageBtn.onclick = () => { page = Math.max(1, page - 1); loadProducts(); };
nextPageBtn.onclick = () => { page = page + 1; loadProducts(); };

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

// initial load
await loadSitesInto(siteSelect);
await loadProducts();
