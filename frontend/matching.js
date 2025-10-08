import { API, loadSitesInto, loadTagsInto, escapeHtml, makeTagBadge } from "./shared.js";

const siteSelect = document.getElementById("siteSelect");
const refreshSitesBtn = document.getElementById("refreshSites");
refreshSitesBtn.onclick = () => loadSitesInto(siteSelect);
await loadSitesInto(siteSelect);

// NEW: tag filter
const tagFilter = document.getElementById("tagFilter");
await loadTagsInto(tagFilter, true);

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

  // NEW: tag filter
  const tagId = tagFilter.value.trim();
  if (tagId) url.searchParams.set("tag_id", tagId);

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

  // 3) fetch tags per product (for badges)
  let tagsByProductId = {};
  if (productIds.length) {
    const r3 = await fetch(`${API}/api/tags/by_products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: productIds })
    });
    if (r3.ok) {
      tagsByProductId = await r3.json();
    }
  }

  renderMatchRows(products, matchesByProductId, tagsByProductId);
  pageInfo.textContent = `Page ${page} (rows: ${products.length})`;
}

function renderMatchRows(products, matchesByProductId, tagsByProductId) {
  tbodyMatch.innerHTML = "";
  for (const p of products) {
    const m = matchesByProductId[p.id] || null;
    const prodTags = tagsByProductId[p.id] || [];

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

      <td>
        <div class="tags-cell" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;"></div>
        <div style="display:flex;gap:6px;align-items:center;">
          <select class="tag-picker"></select>
          <button class="addTag">Add</button>
        </div>
      </td>

      <td><button class="saveMatch">${m ? "Update" : "Save"}</button></td>
    `;

    // prefill highlight
    if (m?.competitor_sku)  tr.querySelector(".comp-sku").style.background  = "rgba(59,130,246,.12)";
    if (m?.competitor_barcode) tr.querySelector(".comp-bar").style.background = "rgba(59,130,246,.12)";

    // render current tags
    const tagsCell = tr.querySelector(".tags-cell");
    const renderBadges = async () => {
      tagsCell.innerHTML = "";
      const r = await fetch(`${API}/api/tags/by_products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_ids: [p.id] })
      });
      const data = r.ok ? await r.json() : {};
      const tags = data[p.id] || [];
      for (const t of tags) {
        const badge = makeTagBadge(t, async () => {
          await fetch(`${API}/api/tags/unassign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: p.id, tag_id: t.id })
          });
          await renderBadges();
        });
        tagsCell.appendChild(badge);
      }
    };
    // initial badges
    for (const t of prodTags) {
      const badge = makeTagBadge(t, async () => {
        await fetch(`${API}/api/tags/unassign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: p.id, tag_id: t.id })
        });
        await renderBadges();
      });
      tagsCell.appendChild(badge);
    }

    // load picker options
    (async () => {
      const picker = tr.querySelector(".tag-picker");
      await (async function loadPicker() {
        const r = await fetch(`${API}/api/tags`);
        const tags = r.ok ? await r.json() : [];
        picker.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "Choose tag…";
        picker.appendChild(opt);
        for (const t of tags) {
          const o = document.createElement("option");
          o.value = String(t.id);
          o.textContent = t.name;
          picker.appendChild(o);
        }
      })();
    })();

    tr.querySelector(".addTag").onclick = async () => {
      const tagId = Number(tr.querySelector(".tag-picker").value || 0);
      if (!tagId) return;
      await fetch(`${API}/api/tags/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: p.id, tag_id: tagId })
      });
      await renderBadges();
    };

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

loadProductsBtn.onclick = () => { page = 1; loadProducts(); };
prevPageBtn.onclick = () => { page = Math.max(1, page - 1); loadProducts(); };
nextPageBtn.onclick = () => { page = page + 1; loadProducts(); };

// Refetch on tag filter change
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

// initial load
await loadSitesInto(siteSelect);
await loadProducts();
