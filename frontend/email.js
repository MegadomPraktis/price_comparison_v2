// Email tab UI
// - Dropdowns fixed (render on open)
// - Subscribers always sent as non-null string
// - Layout kept consistent with project palette

import { API, escapeHtml } from "./shared.js";

const $  = (s,p=document)=>p.querySelector(s);
const $$ = (s,p=document)=>Array.from(p.querySelectorAll(s));

/* Toasts */
function toast(msg, ok=true){
  let w = $("#toast-wrap");
  if (!w) {
    w = document.createElement("div");
    w.id = "toast-wrap";
    w.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none";
    document.body.appendChild(w);
  }
  const d = document.createElement("div");
  d.className = "toast " + (ok ? "ok" : "err");
  d.textContent = msg;
  w.appendChild(d);
  setTimeout(()=>{ try{ w.removeChild(d);}catch{} }, 2400);
}

/* Schedule I/O */
function readScheduleUI(){
  const v = id => ($(id)?.value || "").trim() || null;
  return { mon:v("#sch_mon"), tue:v("#sch_tue"), wed:v("#sch_wed"),
           thu:v("#sch_thu"), fri:v("#sch_fri"), sat:v("#sch_sat"), sun:v("#sch_sun") };
}
function putScheduleUI(s){
  const set = (id,val)=>{ const el=$(id); if(!el) return; el.value = (val || ""); };
  set("#sch_mon", s?.mon); set("#sch_tue", s?.tue); set("#sch_wed", s?.wed);
  set("#sch_thu", s?.thu); set("#sch_fri", s?.fri); set("#sch_sat", s?.sat); set("#sch_sun", s?.sun);
}
async function loadSchedule(){
  try{ const r = await fetch(`${API}/api/email/schedule`); if (!r.ok) return; putScheduleUI(await r.json()); }catch{}
}
async function saveSchedule(){
  try{
    const r = await fetch(`${API}/api/email/schedule`, {
      method:"PUT", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(readScheduleUI())
    });
    toast(r.ok ? "Schedule saved" : "Save failed", r.ok);
  }catch{ toast("Save failed", false); }
}

/* Sites */
async function loadSitesInto(sel){
  try{
    const r = await fetch(`${API}/api/sites`);
    const sites = r.ok ? await r.json() : [];
    sel.innerHTML = `<option value="all">All competitors</option>`;
    for(const s of sites){
      const o = document.createElement("option");
      o.value = s.code; o.textContent = s.name || s.code;
      sel.appendChild(o);
    }
  }catch{}
}

/* Tags dropdown */
let tagsList = [];   // [{id,name}]
async function loadTags(){
  try{
    const r = await fetch(`${API}/api/tags`);
    const raw = r.ok ? await r.json() : [];
    tagsList = Array.isArray(raw) ? raw.map(t => ({
      id: (t.id ?? t.tag_id ?? t.value ?? t),
      name: (t.name ?? t.tag_name ?? t.label ?? String(t))
    })) : [];
  }catch{ tagsList = []; }
}
function getTagIds(){
  const raw = ($("#r_tags")?.value || "").trim();
  return raw ? raw.split(",").filter(Boolean) : [];
}
function setTagIds(arr){ $("#r_tags").value = arr.join(","); }
function addTag(id){ const now = new Set(getTagIds()); now.add(String(id)); setTagIds([...now]); }
function removeTag(id){ const now = new Set(getTagIds()); now.delete(String(id)); setTagIds([...now]); }

function renderTagsDropdown(){
  const listEl = $("#tagsList");
  const empty  = $("#tagsEmpty");
  const search = ($("#tagsSearch")?.value || "").toLowerCase();
  const filtered = tagsList.filter(t => (t.name || "").toLowerCase().includes(search));

  listEl.innerHTML = "";
  empty.style.display = filtered.length ? "none" : "";

  const selectedSet = new Set(getTagIds());
  for (const t of filtered){
    const row = document.createElement("div");
    row.className = "dd-row";
    row.innerHTML = `
      <input type="checkbox" ${selectedSet.has(String(t.id)) ? "checked" : ""} data-id="${t.id}"/>
      <span>${escapeHtml(t.name)}</span>`;
    listEl.appendChild(row);
  }
  listEl.querySelectorAll("input[type=checkbox]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const id = String(inp.getAttribute("data-id"));
      if (inp.checked) addTag(id); else removeTag(id);
      updateTagUI();
    });
  });
}
function updateTagUI(){
  const ids = getTagIds();
  const chips = $("#tagsChips");
  chips.innerHTML = "";
  for (const id of ids){
    const t = tagsList.find(x => String(x.id) === String(id));
    const name = t?.name || id;
    const span = document.createElement("span");
    span.className = "chip";
    span.innerHTML = `${escapeHtml(name)} <button type="button" title="Remove" style="border:0;background:transparent;cursor:pointer;margin-left:4px">×</button>`;
    span.querySelector("button").onclick = ()=>{ removeTag(String(id)); updateTagUI(); };
    chips.appendChild(span);
  }
  $("#tagsBtnText").textContent = (ids.length ? `${ids.length} selected` : "— All tags —");
}

/* Brands dropdown */
async function loadBrandsInto(sel){
  try{
    const r = await fetch(`${API}/api/products/brands`);
    const raw = r.ok ? await r.json() : [];
    const brands = Array.isArray(raw) ? raw : [];
    sel.innerHTML = `<option value="">— Any —</option>`;
    for (const b of brands){
      const name = typeof b === "string" ? b : (b.name || b.brand || "");
      if (!name) continue;
      const o = document.createElement("option");
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    }
  }catch{
    sel.innerHTML = `<option value="">— Any —</option>`;
  }
}

/* Categories → full path labels from /api/groups */
let GROUPS = [];
let BY_ID  = new Map();
let PATHS  = [];

async function loadGroups(){
  try{
    const r = await fetch(`${API}/api/groups`);
    GROUPS = r.ok ? await r.json() : [];
    BY_ID = new Map(GROUPS.map(g => [Number(g.id), g]));
    PATHS = GROUPS.map(g => {
      const parts = [];
      let cur = g;
      while (cur){
        parts.push(cur.name);
        cur = cur.parent_id ? BY_ID.get(Number(cur.parent_id)) : null;
      }
      return { id: g.id, label: parts.reverse().join("/") };
    }).sort((a,b)=> a.label.localeCompare(b.label, 'bg'));
  }catch{
    GROUPS = []; BY_ID = new Map(); PATHS = [];
  }
}
function renderCatDropdown(){
  const listEl = $("#catList");
  const empty  = $("#catEmpty");
  const search = ($("#catSearch")?.value || "").toLowerCase();

  const filtered = PATHS.filter(p => p.label.toLowerCase().includes(search));
  listEl.innerHTML = "";
  empty.style.display = filtered.length ? "none" : "";

  const noneRow = document.createElement("div");
  noneRow.className = "dd-row";
  noneRow.innerHTML = `<input type="radio" name="catpick" data-id=""/> <span>— All categories —</span>`;
  noneRow.querySelector("input").addEventListener("change", ()=>{
    $("#r_category").value = "";
    $("#catBtnText").textContent = "— All categories —";
    $("#catDD").classList.remove("open");
  });
  listEl.appendChild(noneRow);

  const current = ($("#r_category")?.value || "");
  for (const p of filtered){
    const row = document.createElement("div");
    row.className = "dd-row";
    row.innerHTML = `
      <input type="radio" name="catpick" ${String(p.id)===String(current)?"checked":""} data-id="${p.id}"/>
      <span>${escapeHtml(p.label)}</span>`;
    listEl.appendChild(row);
  }
  listEl.querySelectorAll("input[type=radio]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const id = String(inp.getAttribute("data-id"));
      $("#r_category").value = id;
      $("#catBtnText").textContent = escapeHtml((PATHS.find(p => String(p.id)===id)?.label) || "— All categories —");
      $("#catDD").classList.remove("open");
    });
  });
}

/* API */
function normalizeRule(r){
  let emailsArr = [];
  if (Array.isArray(r.emails)) emailsArr = r.emails;
  else if (Array.isArray(r.subscribers)) emailsArr = r.subscribers;
  else if (typeof r.subscribers === "string") {
    emailsArr = r.subscribers.split(",").map(s=>s.trim()).filter(Boolean);
  } else if (typeof r.emails === "string") {
    emailsArr = r.emails.split(",").map(s=>s.trim()).filter(Boolean);
  }
  let tagIds = [];
  if (Array.isArray(r.tag_ids)) tagIds = r.tag_ids;
  else if (Array.isArray(r.tags)) tagIds = r.tags.map(t => typeof t === "object" ? (t.id ?? t) : t);

  return { ...r, _emails: emailsArr, _tag_ids: tagIds.map(x => String(x)) };
}
async function fetchRules(){
  const r = await fetch(`${API}/api/email/rules`);
  if (!r.ok) return [];
  const list = await r.json();
  return Array.isArray(list) ? list.map(normalizeRule) : [];
}
async function createRule(payload){
  const r = await fetch(`${API}/api/email/rules`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text().catch(()=>`HTTP ${r.status}`));
  return r.json();
}
async function updateRule(id, payload){
  const r = await fetch(`${API}/api/email/rules/${encodeURIComponent(id)}`, {
    method:"PUT", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text().catch(()=>`HTTP ${r.status}`));
  return r.json();
}
async function deleteRule(id){
  const r = await fetch(`${API}/api/email/rules/${encodeURIComponent(id)}`, { method:"DELETE" });
  return r.ok;
}
async function sendOneRule(id){
  const r = await fetch(`${API}/api/email/send/${encodeURIComponent(id)}`, { method:"POST" });
  return r.ok;
}

/* Table render */
let tagsMap = new Map();
function tagsHtml(ids){
  if (!ids?.length) return "-";
  return ids.map(id => {
    const name = tagsMap.get(String(id)) || id;
    return `<span class="chip" title="Tag #${escapeHtml(String(id))}">${escapeHtml(String(name))}</span>`;
  }).join(" ");
}
function renderRules(list){
  const tbody = $("#rulesTable tbody");
  const q = ($("#search")?.value || "").toLowerCase();

  const filtered = list.filter(r=>{
    if (!q) return true;
    return [
      r.name || "",
      (r._emails || []).join(", "),
      r.notes || "",
      r.site_code || "",
      r.brand || "",
      r.category_path || "",
      ...((r._tag_ids || []).map(id => tagsMap.get(String(id)) || String(id))),
    ].join(" ").toLowerCase().includes(q);
  });

  $("#records").textContent = `Records: ${filtered.length}`;

  tbody.innerHTML = filtered.map(r=>{
    const catPath = r.category_path || r.category_label || "";
    return `<tr>
      <td>${escapeHtml(r.name || "")}</td>
      <td>${tagsHtml(r._tag_ids)}</td>
      <td>${r.promo_only ? "Yes" : "-"}</td>
      <td>${r.changed_24h ? "Yes" : "-"}</td>
      <td>${escapeHtml(r.brand || "-")}</td>
      <td>${escapeHtml(catPath || "-")}</td>
      <td>${escapeHtml(r.site_code || "all")}</td>
      <td>${escapeHtml((r._emails || []).join(", "))}</td>
      <td>${escapeHtml(r.notes || "")}</td>
      <td>${escapeHtml(r.created_on || "")}</td>
      <td style="white-space:nowrap;display:flex;gap:6px">
        <button class="btn btn-outline" data-send="${escapeHtml(String(r.id ?? ""))}">Send</button>
        <button class="btn btn-outline" data-edit="${escapeHtml(String(r.id ?? ""))}">Edit</button>
        <button class="btn btn-red" data-del="${escapeHtml(String(r.id ?? ""))}">Delete</button>
      </td>
    </tr>`;
  }).join("");

  $$("button[data-del]").forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-del");
      if (!id) return;
      if (!confirm("Delete this rule?")) return;
      const ok = await deleteRule(id);
      toast(ok ? "Rule deleted" : "Delete failed", ok);
      if (ok) initRules();
    };
  });
  $$("button[data-edit]").forEach(b=>{
    b.onclick = ()=>{
      const id = b.getAttribute("data-edit");
      const the = list.find(x => String(x.id) === String(id));
      openDialog(the || null);
    };
  });
  $$("button[data-send]").forEach(b=>{
    b.onclick = async ()=>{
      const id = b.getAttribute("data-send");
      if (!id) return;
      const old = b.textContent;
      b.disabled = true; b.textContent = "Sending…";
      try{
        const ok = await sendOneRule(id);
        toast(ok ? "Email queued" : "Send failed", ok);
      }catch{ toast("Send failed", false); }
      finally{ b.disabled = false; b.textContent = old; }
    };
  });
}

/* Dialog open/fill/save */
let editingId = null;

function openDialog(rule=null){
  editingId = rule?.id ?? null;
  $("#dlgTitle").textContent = rule ? "Edit rule" : "Add rule";

  $("#r_name").value        = rule?.name || "";
  $("#r_site").value        = rule?.site_code || "all";
  $("#r_brand").value       = rule?.brand || "";
  $("#r_direction").value   = (rule?.price_direction || rule?.direction || "any");
  $("#r_emails").value      = (Array.isArray(rule?._emails) ? rule._emails.join(", ") :
                               Array.isArray(rule?.subscribers) ? rule.subscribers.join(", ") :
                               (rule?.subscribers || rule?.emails || ""));
  $("#r_notes").value       = rule?.notes || "";
  $("#r_category").value    = rule?.category_id ? String(rule.category_id) : "";
  $("#r_promo").checked     = !!rule?.promo_only;
  $("#r_changed24").checked = !!rule?.changed_24h;

  const tagIds = (rule?._tag_ids || []);
  setTagIds(tagIds.map(String));
  updateTagUI();

  const catId = $("#r_category").value;
  const label = catId ? (PATHS.find(p => String(p.id)===String(catId))?.label) : null;
  $("#catBtnText").textContent = label || "— All categories —";

  $("#ruleDlg").showModal();
}

function readDialog(){
  const tag_ids = getTagIds().map(id => Number(id));
  const catId = ($("#r_category").value || "").trim();
  const catLabel = catId ? (PATHS.find(p => String(p.id)===String(catId))?.label) : null;

  const subs = ($("#r_emails").value || "").trim();

  return {
    name: ($("#r_name").value || "").trim(),
    site_code: $("#r_site").value || "all",
    brand: ($("#r_brand").value || "").trim() || null,
    tag_ids: tag_ids.length ? tag_ids : null,
    category_id: catId || null,
    category_path: catLabel || null, // optional display-only
    promo_only: $("#r_promo").checked,
    price_direction: $("#r_direction").value || "any",
    changed_24h: $("#r_changed24").checked,
    subscribers: subs,   // always a non-null string
    notes: ($("#r_notes").value || "").trim() || null
  };
}

$("#ruleForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const payload = readDialog();
  if (!payload.name){ toast("Name is required", false); return; }
  if (!payload.subscribers){ toast("Subscribers are required (comma-separated emails).", false); return; }
  try{
    if (editingId) await updateRule(editingId, payload);
    else           await createRule(payload);
    toast("Saved");
    $("#ruleDlg").close();
    await initRules();
  }catch(err){
    console.error(err);
    toast("Save failed", false);
  }
});
$("#btnCancel").onclick = ()=> $("#ruleDlg").close();

/* Boot */
async function initRules(){
  try{
    const r = await fetch(`${API}/api/tags`);
    const tags = r.ok ? await r.json() : [];
    const norm = tags.map(t => ({ id:(t.id ?? t.tag_id ?? t.value ?? t), name:(t.name ?? t.tag_name ?? t.label ?? String(t)) }));
    tagsMap = new Map(norm.map(t => [String(t.id), t.name]));
  }catch{ tagsMap = new Map(); }

  const list = await fetchRules();
  renderRules(list);
}

(async function boot(){
  await loadSchedule();
  $("#btnSaveSchedule").onclick = saveSchedule;
  $("#btnSendAll").onclick = async ()=>{
    try{
      const ok = await fetch(`${API}/api/email/send-all`, { method:"POST" }).then(r=>r.ok);
      toast(ok ? "All rules queued" : "Send failed", ok);
    }catch{ toast("Send failed", false); }
  };

  await loadSitesInto($("#r_site"));
  await loadTags();
  await loadBrandsInto($("#r_brand"));
  await loadGroups();

  // TAGS: render on open
  $("#tagsBtn").onclick = ()=>{
    const dd = $("#tagsDD");
    dd.classList.toggle("open");
    if (dd.classList.contains("open")) renderTagsDropdown();
  };
  $("#tagsSearch").addEventListener("input", renderTagsDropdown);
  document.addEventListener("click", (e)=>{
    const cont = $("#tagsDD");
    if (cont && !cont.contains(e.target) && !$("#tagsBtn").contains(e.target)) cont.classList.remove("open");
  });

  // CATEGORIES: render on open
  $("#catBtn").onclick = ()=> {
    const dd = $("#catDD");
    dd.classList.toggle("open");
    if (dd.classList.contains("open")) renderCatDropdown();
  };
  $("#catSearch").addEventListener("input", renderCatDropdown);
  document.addEventListener("click", (e)=>{
    const cont = $("#catDD");
    if (cont && !cont.contains(e.target) && !$("#catBtn").contains(e.target)) cont.classList.remove("open");
  });

  $("#btnAdd").onclick = ()=> openDialog(null);
  $("#search").addEventListener("input", ()=> initRules());

  await initRules();
})();
