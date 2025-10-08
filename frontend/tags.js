import { API, loadTagsInto, escapeHtml, makeTagBadge } from "./shared.js";

const newTagName = document.getElementById("newTagName");
const addTagBtn = document.getElementById("addTagBtn");
const tagsTbody = document.getElementById("tagsTbody");
const assignTagSelect = document.getElementById("assignTagSelect");
const searchSku = document.getElementById("searchSku");
const searchBtn = document.getElementById("searchBtn");
const assignTbody = document.querySelector("#assignTable tbody");

async function refreshTags() {
  const r = await fetch(`${API}/api/tags`);
  const data = r.ok ? await r.json() : [];
  tagsTbody.innerHTML = "";
  for (const t of data) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(t.name)}</td>
      <td><button class="del">Delete</button></td>
    `;
    tr.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete tag "${t.name}"?`)) return;
      await fetch(`${API}/api/tags/${t.id}`, { method: "DELETE" });
      await refreshTags();
      await loadTagsInto(assignTagSelect, false);
    };
    tagsTbody.appendChild(tr);
  }
}

addTagBtn.onclick = async () => {
  const name = newTagName.value.trim();
  if (!name) return;
  const r = await fetch(`${API}/api/tags`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!r.ok) {
    alert(await r.text());
    return;
  }
  newTagName.value = "";
  await refreshTags();
  await loadTagsInto(assignTagSelect, false);
};

async function searchProducts() {
  const q = searchSku.value.trim();
  const url = new URL(`${API}/api/products`);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "100");
  if (q) url.searchParams.set("q", q);
  const r = await fetch(url);
  if (!r.ok) return;
  const products = await r.json();
  const productIds = products.map(p => p.id);

  // load existing tags by product
  let tagsByProductId = {};
  if (productIds.length) {
    const r2 = await fetch(`${API}/api/tags/by_products`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: productIds })
    });
    if (r2.ok) tagsByProductId = await r2.json();
  }

  assignTbody.innerHTML = "";
  for (const p of products) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.sku}</td>
      <td>${p.barcode ?? ""}</td>
      <td>${escapeHtml(p.name)}</td>
      <td><div class="badges" style="display:flex;gap:6px;flex-wrap:wrap;"></div></td>
      <td><button class="assignBtn">Assign</button></td>
    `;
    const badges = tr.querySelector(".badges");
    const renderBadges = async () => {
      const r3 = await fetch(`${API}/api/tags/by_products`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_ids: [p.id] })
      });
      const data = r3.ok ? await r3.json() : {};
      badges.innerHTML = "";
      for (const t of (data[p.id] || [])) {
        badges.appendChild(makeTagBadge(t, async () => {
          await fetch(`${API}/api/tags/unassign`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: p.id, tag_id: t.id })
          });
          await renderBadges();
        }));
      }
    };
    // initial badges
    for (const t of (tagsByProductId[p.id] || [])) {
      badges.appendChild(makeTagBadge(t, async () => {
        await fetch(`${API}/api/tags/unassign`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: p.id, tag_id: t.id })
        });
        await renderBadges();
      }));
    }

    tr.querySelector(".assignBtn").onclick = async () => {
      const tagId = Number(assignTagSelect.value || 0);
      if (!tagId) { alert("Choose a tag from the dropdown above."); return; }
      await fetch(`${API}/api/tags/assign`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id: p.id, tag_id: tagId })
      });
      await renderBadges();
    };

    assignTbody.appendChild(tr);
  }
}

await refreshTags();
await loadTagsInto(assignTagSelect, false);
searchBtn.onclick = searchProducts;
