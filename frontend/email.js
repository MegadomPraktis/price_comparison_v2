// email.js — rules CRUD (update vs create), per-rule send, tag name chips,
// multi-select toggle, subscribers string for backend, normalized load.

import { API, escapeHtml } from "./shared.js";

const $  = (s,p=document)=>p.querySelector(s);
const $$ = (s,p=document)=>Array.from(p.querySelectorAll(s));

// ---------- toasts ----------
function toast(msg, ok=true){
  let w = $("#toast-wrap");
  if (!w) {
    w = document.createElement("div");
    w.id = "toast-wrap";
    w.style.cssText = "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none";
    document.body.appendChild(w);
  }
  const d = document.createElement("div");
  d.style.cssText = "padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:#0f1730;min-width:220px;text-align:center;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,.35);";
  d.style.color = ok ? "#22c55e" : "#ef4444";
  d.textContent = msg;
  w.appendChild(d);
  setTimeout(()=>{ try{ w.removeChild(d);}catch{} }, 2400);
}

// ---------- schedule ----------
function readScheduleUI(){
  const v = id => ($(id)?.value || "").trim() || null;
  return {
    mon: v("#sch_mon"), tue: v("#sch_tue"), wed: v("#sch_wed"),
    thu: v("#sch_thu"), fri: v("#sch_fri"), sat: v("#sch_sat"), sun: v("#sch_sun"),
  };
}
function putScheduleUI(s){
  const set = (id,val)=>{ const el=$(id); if(!el) return; el.value = (val || ""); };
  set("#sch_mon", s?.mon); set("#sch_tue", s?.tue); set("#sch_wed", s?.wed);
  set("#sch_thu", s?.thu); set("#sch_fri", s?.fri); set("#sch_sat", s?.sat); set("#sch_sun", s?.sun);
}
async function loadSchedule(){
  try{
    const r = await fetch(`${API}/api/email/schedule`);
    if (!r.ok) return;
    putScheduleUI(await r.json());
  }catch{}
}
async function saveSchedule(){
  try{
    const r = await fetch(`${API}/api/email/schedule`, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(readScheduleUI())
    });
    toast(r.ok ? "Schedule saved" : "Save failed", r.ok);
  }catch{ toast("Save failed", false); }
}

// ---------- sites & tags ----------
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
  }catch{ /* keep All */ }
}

let tagsMap = new Map();     // id -> name
let tagsList = [];           // [{id,name}]

async function loadTagsInto(sel){
  try{
    const r = await fetch(`${API}/api/tags`);
    tagsList = r.ok ? await r.json() : [];
    tagsMap = new Map(tagsList.map(t => [String(t.id), t.name]));
    sel.innerHTML = "";
    for(const t of tagsList){
      const o = document.createElement("option");
      o.value = String(t.id);
      o.textContent = t.name;
      sel.appendChild(o);
    }
  }catch{
    sel.innerHTML = "";
    tagsMap = new Map();
    tagsList = [];
  }
}
// click-to-toggle multi-select (no Ctrl/⌘)
function enableMultiToggle(selectEl){
  selectEl.addEventListener("mousedown", (e)=>{
    if (e.target.tagName === "OPTION") {
      e.preventDefault();
      const opt = e.target;
      opt.selected = !opt.selected;
    }
  });
}
const getMultiValues = (sel)=> Array.from(sel.selectedOptions).map(o=>o.value);

// ---------- rules api ----------
function normalizeRule(r){
  // emails
  let emailsArr = [];
  if (Array.isArray(r.emails)) emailsArr = r.emails;
  else if (Array.isArray(r.subscribers)) emailsArr = r.subscribers;
  else if (typeof r.subscribers === "string") {
    emailsArr = r.subscribers.split(",").map(s=>s.trim()).filter(Boolean);
  } else if (typeof r.emails === "string") {
    emailsArr = r.emails.split(",").map(s=>s.trim()).filter(Boolean);
  }
  // tags (ids)
  let tagIds = [];
  if (Array.isArray(r.tag_ids)) tagIds = r.tag_ids;
  else if (Array.isArray(r.tags)) tagIds = r.tags.map(t => typeof t === "object" ? (t.id ?? t) : t);
  // ensure strings for mapping
  tagIds = tagIds.map(x => String(x));
  return {
    ...r,
    _emails: emailsArr,
    _tag_ids: tagIds
  };
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
  // requires backend endpoint POST /api/email/send?rule_id={id}
  const r = await fetch(`${API}/api/email/send?rule_id=${encodeURIComponent(id)}`, { method:"POST" });
  return r.ok;
}

// ---------- rules render ----------
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
      r.price_subset || r.subset || "",
      ...((r._tag_ids || []).map(id => tagsMap.get(String(id)) || String(id))),
    ].join(" ").toLowerCase().includes(q);
  });

  $("#records").textContent = `Records: ${filtered.length}`;

  tbody.innerHTML = filtered.map(r=>{
    return `<tr>
      <td>${escapeHtml(r.name || "")}</td>
      <td>${tagsHtml(r._tag_ids)}</td>
      <td>${r.promo_only ? "Yes" : "-"}</td>
      <td>${escapeHtml(r.site_code || "all")}</td>
      <td>${escapeHtml(r.price_subset || r.subset || "all")}</td>
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

// ---------- dialog ----------
let editingId = null;

function openDialog(rule=null){
  editingId = rule?.id ?? null;
  $("#dlgTitle").textContent = rule ? "Edit rule" : "Add rule";
  $("#r_name").value  = rule?.name || "";
  $("#r_site").value  = rule?.site_code || "all";
  $("#r_brand").value = rule?.brand || "";
  $("#r_subset").value= (rule?.price_subset || rule?.subset || "all");
  $("#r_promo").value = rule?.promo_only ? "1" : "0";
  $("#r_subs").value  = (rule?._emails || []).join(", ");
  $("#r_notes").value = rule?.notes || "";

  const tagSel = $("#r_tags");
  Array.from(tagSel.options).forEach(o => o.selected = false);
  const existing = (rule?._tag_ids || []).map(t => String(t));
  Array.from(tagSel.options).forEach(o => { if (existing.includes(o.value)) o.selected = true; });

  $("#ruleDlg").showModal();
  $("#dlgCancel").onclick = () => { $("#ruleDlg").close(); editingId = null; };

  $("#dlgSave").onclick = async (e)=>{
    e.preventDefault();
    const name = $("#r_name").value.trim();
    if (!name) { toast("Please enter a name", false); return; }

    const subsString = ($("#r_subs").value || "").split(",").map(s=>s.trim()).filter(Boolean).join(", ");
    if (!subsString) { toast("Please add at least one subscriber email", false); return; }

    const tag_ids = getMultiValues($("#r_tags")).map(v => Number(v));
    const emailsArr = subsString.split(",").map(s=>s.trim()).filter(Boolean);

    const payload = {
      name,
      site_code: $("#r_site").value || "all",
      brand: ($("#r_brand").value || "").trim() || null,
      price_subset: $("#r_subset").value || "all",
      promo_only: $("#r_promo").value === "1",
      tag_ids,
      subscribers: subsString,   // backend expects string
      emails: emailsArr,         // optional, for downstream use
      notes: ($("#r_notes").value || "").trim() || null
    };

    try{
      if (editingId) await updateRule(editingId, payload);
      else await createRule(payload);
      toast("Rule saved");
      $("#ruleDlg").close();
      editingId = null;
      initRules();
    }catch(err){
      console.error(err);
      toast(`Save failed — ${err.message || "HTTP error"}`, false);
    }
  };
}

// ---------- manual send-all ----------
async function sendAll(){
  const btn = $("#btnSendAll");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "Sending…";
  try{
    const r = await fetch(`${API}/api/email/send-all`, { method:"POST" });
    toast(r.ok ? "Send triggered" : "Send failed", r.ok);
  }catch{ toast("Send failed", false); }
  finally{ btn.disabled = false; btn.textContent = old; }
}

// ---------- init ----------
async function initRules(){
  try{ renderRules(await fetchRules()); }
  catch(e){ console.error(e); renderRules([]); }
}

async function init(){
  await loadSchedule();
  $("#btnSaveSchedule").onclick = saveSchedule;
  $("#btnSendAll").onclick = sendAll;

  await loadSitesInto($("#r_site"));
  await loadTagsInto($("#r_tags"));
  enableMultiToggle($("#r_tags"));

  $("#btnAdd").onclick = ()=> openDialog(null);
  $("#search").oninput = ()=> initRules();

  await initRules();
}

init();
