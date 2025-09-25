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

  // 3) render rows with inputs **prefilled** if match exists (still editable)
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
      <td><input placeholder="competitor SKU" class="comp-sku" value="${m?.competitor_sku ?? ""}"/></td>
      <td><input placeholder="competitor barcode" class="comp-bar" value="${m?.competitor_barcode ?? ""}"/></td>
      <td>
        <button class="saveMatch">${m ? "Update" : "Save"}</button>
      </td>
    `;

    // Optional: style prefilled cells so it's obvious they were auto-matched
    if (m?.competitor_sku) tr.querySelector(".comp-sku").style.background = "rgba(59,130,246,.12)";
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
      // update button label + subtle feedback
      tr.querySelector(".saveMatch").textContent = "Update";
      tr.querySelector(".comp-sku").style.background = compSku ? "rgba(59,130,246,.12)" : "";
      tr.querySelector(".comp-bar").style.background = compBar ? "rgba(59,130,246,.12)" : "";
      alert("Saved");
    };

    tbodyMatch.appendChild(tr);
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
  // reload to show the prefilled matches
  await loadProducts();
};

// initial load
await loadSitesInto(siteSelect);
await loadProducts();
