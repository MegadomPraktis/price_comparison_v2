export const API = /^https?:/.test(location.origin)
  ? location.origin
  : (window.__API_BASE__ || "http://127.0.0.1:8001");

export async function loadSitesInto(selectEl) {
  const r = await fetch(`${API}/api/sites`);
  if (!r.ok) {
    console.error("Failed to load sites", r.status);
    return;
  }
  const data = await r.json();
  selectEl.innerHTML = "";
  data.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.code;
    opt.textContent = `${s.name} (${s.code})`;
    selectEl.appendChild(opt);
  });
}

// --- NEW
export async function loadTagsInto(selectEl, withAllOption = true) {
  const r = await fetch(`${API}/api/tags`);
  if (!r.ok) {
    console.error("Failed to load tags", r.status);
    return;
  }
  const data = await r.json();
  selectEl.innerHTML = "";
  if (withAllOption) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "— All tags —";
    selectEl.appendChild(opt);
  }
  data.forEach(t => {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.name;
    selectEl.appendChild(opt);
  });
}

export function escapeHtml(s) {
  if (typeof s !== "string") return s ?? "";
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

export function fmtPrice(v) {
  if (v === null || v === undefined) return "N/A";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

// --- NEW: small badge factory
export function makeTagBadge(tag, onRemove) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = tag.name;
  if (onRemove) {
    const x = document.createElement("button");
    x.textContent = "×";
    x.style.border = "0";
    x.style.background = "transparent";
    x.style.cursor = "pointer";
    x.title = "Remove tag";
    x.onclick = onRemove;
    span.appendChild(x);
  }
  return span;
}
