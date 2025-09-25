export const API = location.origin;

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

export function escapeHtml(s) {
  if (typeof s !== "string") return s ?? "";
  return s.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

export function fmtPrice(v) {
  if (v === null || v === undefined) return "N/A";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}
