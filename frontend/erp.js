// frontend/erp.js
import { API } from "./shared.js";

const erpForm   = document.getElementById("erpForm");
const erpFile   = document.getElementById("erpFile");
const erpResult = document.getElementById("erpResult");

erpForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = erpFile.files[0];
  if (!file) {
    erpResult.textContent = "Моля, изберете Excel файл (.xlsx или .xls).";
    return;
  }

  const fd = new FormData();
  fd.append("file", file);

  erpResult.textContent = "Импортът стартира...";

  try {
    const r = await fetch(`${API}/api/erp/import_excel`, {
      method: "POST",
      body: fd,
    });

    if (!r.ok) {
      let msg;
      try {
        const data = await r.json();
        msg = data.detail || JSON.stringify(data);
      } catch {
        msg = await r.text();
      }
      erpResult.textContent = "Грешка при импорта:\n" + msg;
      return;
    }

    const data = await r.json();
    erpResult.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    erpResult.textContent = "Грешка при връзка с API:\n" + err;
  }
});
