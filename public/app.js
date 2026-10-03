const form = document.getElementById("search-form");
const submitBtn = document.getElementById("submit-btn");
const formMessage = document.getElementById("form-message");
const historyBody = document.getElementById("history-body");
const refreshBtn = document.getElementById("refresh-btn");

let pollTimer = null;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toInputDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function setDefaults() {
  const today = new Date();
  form.startFrom.value = toInputDate(today);
  form.startTo.value = toInputDate(addDays(today, 90));
  form.returnFrom.value = toInputDate(addDays(today, 11));
  form.returnTo.value = toInputDate(addDays(today, 120));
  form.durationFrom.value = 11;
  form.durationTo.value = 17;
  form.maxTransfers.value = 1;
  form.maxLayoverHours.value = 4;
}

function showMessage(text, isError = false) {
  formMessage.hidden = !text;
  formMessage.textContent = text || "";
  formMessage.classList.toggle("error", Boolean(isError));
}

function formatDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusLabel(status) {
  switch (status) {
    case "pending":
      return "В очереди";
    case "running":
      return "Идёт";
    case "done":
      return "Готово";
    case "failed":
      return "Ошибка";
    default:
      return status;
  }
}

function formatParams(params = {}) {
  return [
    `Старт: ${params.startFrom || "—"} — ${params.startTo || "—"}`,
    `Возврат: ${params.returnFrom || "—"} — ${params.returnTo || "—"}`,
    `Дней: ${params.durationFrom ?? "—"}–${params.durationTo ?? "—"}`,
    `Пересадок ≤ ${params.maxTransfers ?? "—"}, пересадка ≤ ${
      params.maxLayoverHours ?? "—"
    } ч`,
  ].join("\n");
}

function renderHistory(searches) {
  if (!searches.length) {
    historyBody.innerHTML =
      '<tr><td colspan="4" class="empty">Пока нет запусков — заполните форму и нажмите «Запустить поиск»</td></tr>';
    return;
  }

  historyBody.innerHTML = searches
    .map((item) => {
      let resultHtml = "—";
      if (item.status === "done") {
        const count =
          item.resultCount != null ? `${item.resultCount} маршрутов` : "CSV";
        resultHtml = `<a href="${item.downloadUrl}">Скачать CSV</a><div class="meta">${count}</div>`;
      } else if (item.status === "failed") {
        resultHtml = `<span class="meta">${escapeHtml(item.error || "Ошибка")}</span>`;
      } else if (item.stage) {
        resultHtml = `<span class="meta">${escapeHtml(item.stage)}</span>`;
      }

      return `
        <tr>
          <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
          <td><div class="params">${escapeHtml(formatParams(item.params))}</div></td>
          <td>
            <span class="status ${escapeHtml(item.status)}">${escapeHtml(
              statusLabel(item.status)
            )}</span>
            ${
              item.status === "running" || item.status === "pending"
                ? `<span class="stage">${escapeHtml(item.stage || "")}</span>`
                : ""
            }
          </td>
          <td class="result">${resultHtml}</td>
        </tr>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadHistory() {
  const res = await fetch("/api/searches");
  if (!res.ok) throw new Error("Не удалось загрузить историю");
  const data = await res.json();
  const searches = data.searches || [];
  renderHistory(searches);

  const hasActive = searches.some(
    (s) => s.status === "pending" || s.status === "running"
  );
  if (hasActive) startPolling();
  else stopPolling();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    loadHistory().catch(() => {});
  }, 2000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function readFormParams() {
  return {
    startFrom: form.startFrom.value,
    startTo: form.startTo.value,
    returnFrom: form.returnFrom.value,
    returnTo: form.returnTo.value,
    durationFrom: Number(form.durationFrom.value),
    durationTo: Number(form.durationTo.value),
    maxTransfers: Number(form.maxTransfers.value),
    maxLayoverHours: Number(form.maxLayoverHours.value),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");
  submitBtn.disabled = true;

  try {
    const params = readFormParams();
    if (params.startFrom > params.startTo) {
      throw new Error("Дата старта: «с» не может быть позже «по».");
    }
    if (params.returnFrom > params.returnTo) {
      throw new Error("Дата возврата: «с» не может быть позже «по».");
    }
    if (params.durationFrom > params.durationTo) {
      throw new Error("Продолжительность: «с» не может быть больше «по».");
    }

    const res = await fetch("/api/searches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Не удалось запустить поиск");

    showMessage("Поиск добавлен в очередь. Строка появится в истории.");
    await loadHistory();
    startPolling();
  } catch (err) {
    showMessage(err.message || String(err), true);
  } finally {
    submitBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", () => {
  loadHistory().catch((err) => showMessage(err.message, true));
});

setDefaults();
loadHistory().catch((err) => {
  historyBody.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(
    err.message
  )}</td></tr>`;
});
