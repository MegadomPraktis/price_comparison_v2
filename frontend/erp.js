// frontend/erp.js
import { API } from "./shared.js";

const erpForm    = document.getElementById("erpForm");
const erpFile    = document.getElementById("erpFile");
const erpMessage = document.getElementById("erpMessage");
const erpMeta    = document.getElementById("erpMeta");

function setMessage(text, type = "ok", meta = "") {
  erpMessage.textContent = text;
  erpMessage.classList.remove("ok", "err");
  if (type === "ok") {
    erpMessage.classList.add("ok");
  } else if (type === "err") {
    erpMessage.classList.add("err");
  }
  erpMeta.textContent = meta || "";
}

erpForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = erpFile.files[0];
  if (!file) {
    setMessage("Моля, избери Excel файл (.xlsx или .xls).", "err");
    return;
  }

  const fd = new FormData();
  fd.append("file", file);

  setMessage("Импортът започна, моля изчакай…", "ok");

  try {
    const r = await fetch(`${API}/api/erp/import_excel`, {
      method: "POST",
      body: fd,
    });

    if (!r.ok) {
      let msg = "Възникна грешка при импорта.";
      try {
        const data = await r.json();
        if (data.detail) msg = data.detail;
      } catch {
        const txt = await r.text();
        if (txt) msg = txt;
      }
      setMessage(msg, "err");
      return;
    }

    const data = await r.json();

    // Очакваме формата от бекенда: ok, skus_in_file, skus_unique, skus_with_data, created, updated, missing_in_erp
    const total   = data.skus_in_file ?? 0;
    const unique  = data.skus_unique ?? 0;
    const haveERP = data.skus_with_data ?? 0;
    const created = data.created ?? 0;
    const updated = data.updated ?? 0;
    const missing = Array.isArray(data.missing_in_erp) ? data.missing_in_erp : [];

    let msg = "Импортът завърши успешно.";
    let metaLines = [];
    metaLines.push(`SKU във файла: ${total}`);
    metaLines.push(`Уникални SKU: ${unique}`);
    metaLines.push(`Артикули с върнати данни от ERP: ${haveERP}`);
    metaLines.push(`Ново създадени продукти: ${created}`);
    metaLines.push(`Обновени продукти: ${updated}`);

    if (missing.length > 0) {
      const firstFew = missing.slice(0, 15).join(", ");
      metaLines.push(`SKU без данни в ERP: ${missing.length}`);
      metaLines.push(`Примерни липсващи: ${firstFew}${missing.length > 15 ? "…" : ""}`);
    } else {
      metaLines.push("Всички SKU от файла имат данни в ERP.");
    }

    setMessage(msg, "ok", metaLines.join("\n"));
  } catch (err) {
    setMessage("Проблем с връзката към сървъра. Провери дали услугата работи.", "err");
    console.error("ERP import error", err);
  }
});
