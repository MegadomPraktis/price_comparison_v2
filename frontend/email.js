import { API, loadSitesInto } from "./shared.js";

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const tbl = $("#rulesTable tbody");
const rec = $("#records");
const dlg = $("#ruleDlg");
const form = $("#ruleForm");

const f = {
  name: $("#r_name"),
  site: $("#r_site"),
  tags: $("#r_tags"),
  brand: $("#r_brand"),
  subset: $("#r_subset"),
  promo: $("#r_promo"),
  subs: $("#r_subs"),
  notes: $("#r_notes"),
};

let rules = [];
let allTags = [];
let editId = null;

// ------- schedule ----------
async function fetchSchedule() {
  const r = await fetch(`${API}/api/email/schedule`);
  return r.ok ? r.json() : {};
}
async function saveSchedule() {
  const payload = {
    mon: $("#sch_mon").value || null,
    tue: $("#sch_tue").value || null,
    wed: $("#sch_wed").value || null,
    thu: $("#sch_thu").value || null,
    fri: $("#sch_fri").value || null,
    sat: $("#sch_sat").value || null,
    sun: $("#sch_sun").value || null,
  };
  const r = await fetch(`${API}/api/email/schedule`, {
    method:"PUT", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  if (!r.ok) alert(await r.text());
}

// ------- rules -----------
async function fetchRules() {
  const r = await fetch(`${API}/api/email/rules`);
  rules = r.ok ? await r.json() : [];
  render();
}
function render() {
  const term = ($("#search").value || "").toLowerCase();
  const rows = rules.filter(r =>
    r.name.toLowerCase().includes(term) ||
    (r.subscribers || "").toLowerCase().includes(term)
  );
  rec.textContent = `Records: ${rows.length}`;
  tbl.innerHTML = rows.map(r => {
    const t = (r.tag_ids || []).map(id => {
      const tag = allTags.find(x => String(x.id) === String(id));
      return `<span class="chip">${tag ? tag.name : id}</span>`;
    }).join(" ");
    return `
      <tr>
        <td>${r.name}</td>
        <td>${t || "-"}</td>
        <td>${r.only_promo ? "Yes" : "-"}</td>
        <td>${r.site_code}</td>
        <td>${r.subscribers}</td>
        <td>${r.notes || ""}</td>
        <td>${new Date(r.created_on).toLocaleString()}</td>
        <td>
          <button class="btn btn-outline" data-act="send" data-id="${r.id}">Send now</button>
          <button class="btn" data-act="edit" data-id="${r.id}">Edit</button>
          <button class="btn btn-red" data-act="del" data-id="${r.id}">Delete</button>
        </td>
      </tr>`;
  }).join("");
}

tbl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "edit") openEdit(id);
  if (act === "del") {
    if (!confirm("Delete this rule?")) return;
    const r = await fetch(`${API}/api/email/rules/${id}`, { method:"DELETE" });
    if (!r.ok) return alert(await r.text());
    await fetchRules();
  }
  if (act === "send") {
    const r = await fetch(`${API}/api/email/send/${id}`, { method:"POST" });
    if (!r.ok) return alert(await r.text());
    alert("Email sent.");
  }
});

// ------- dialog ----------
function fillTagsSelect(selectedIds = []) {
  f.tags.innerHTML = allTags
    .map(t => `<option value="${t.id}" ${selectedIds.includes(t.id) ? "selected":""}>${t.name}</option>`)
    .join("");
}

function openEdit(id=null) {
  editId = id;
  if (id) {
    const r = rules.find(x => String(x.id) === String(id));
    $("#dlgTitle").textContent = "Edit rule";
    f.name.value = r.name || "";
    f.site.value = r.site_code || "all";
    fillTagsSelect((r.tag_ids || []).map(Number));
    f.brand.value = r.brand || "";
    f.subset.value = r.price_subset || "all";
    f.promo.value = r.only_promo ? "1" : "0";
    f.subs.value = r.subscribers || "";
    f.notes.value = r.notes || "";
  } else {
    $("#dlgTitle").textContent = "Add rule";
    form.reset();
    f.site.value = "all"; f.subset.value = "all"; f.promo.value = "0";
    fillTagsSelect([]);
  }
  dlg.showModal();
}

$("#dlgCancel").addEventListener("click", () => dlg.close());

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const selectedTagIds = Array.from(f.tags.selectedOptions).map(o => Number(o.value));
  const payload = {
    name: f.name.value.trim(),
    site_code: f.site.value,
    tag_ids: selectedTagIds,
    brand: f.brand.value.trim() || null,
    price_subset: f.subset.value,
    only_promo: f.promo.value === "1",
    subscribers: f.subs.value.trim(),
    notes: f.notes.value.trim() || null,
  };
  const url = editId ? `${API}/api/email/rules/${editId}` : `${API}/api/email/rules`;
  const method = editId ? "PUT" : "POST";
  const r = await fetch(url, { method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) });
  if (!r.ok) return alert(await r.text());
  dlg.close();
  await fetchRules();
});

// ------- buttons ----------
$("#btnAdd").addEventListener("click", () => openEdit(null));
$("#btnSaveSchedule").addEventListener("click", async () => {
  await saveSchedule(); alert("Schedule saved");
});
$("#btnSendAll").addEventListener("click", async () => {
  const r = await fetch(`${API}/api/email/send-all`, { method:"POST" });
  if (!r.ok) return alert(await r.text());
  alert("All rules sent.");
});
$("#search").addEventListener("input", render);

// ------- init ----------
(async function init(){
  // sites
  await loadSitesInto(f.site);
  if (!f.site.querySelector('option[value="all"]')) {
    const o = document.createElement("option");
    o.value = "all"; o.textContent = "All competitors";
    f.site.insertBefore(o, f.site.firstChild);
  }
  f.site.value = "all";

  // tags
  try {
    const r = await fetch(`${API}/api/tags`);
    allTags = r.ok ? await r.json() : [];
  } catch { allTags = []; }
  fillTagsSelect([]);

  // schedule
  const sch = await fetchSchedule();
  $("#sch_mon").value = sch.mon || "";
  $("#sch_tue").value = sch.tue || "";
  $("#sch_wed").value = sch.wed || "";
  $("#sch_thu").value = sch.thu || "";
  $("#sch_fri").value = sch.fri || "";
  $("#sch_sat").value = sch.sat || "";
  $("#sch_sun").value = sch.sun || "";

  await fetchRules();
})();
