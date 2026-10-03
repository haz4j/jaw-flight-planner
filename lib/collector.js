/**
 * Сборщик Open Jaw маршрутов Москва ↔ Китай (кэш Travelpayouts).
 */

const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN || "";

const ORIGIN = "MOW";
const CHINA_CITIES = {
  BJS: "Пекин",
  SHA: "Шанхай",
  CAN: "Гуанчжоу",
  CTU: "Чэнду",
  SZX: "Шэньчжэнь",
};

const REQUEST_DELAY_MS = 120;
const AVIASALES_BASE = "https://www.aviasales.ru";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMonth(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseDateOnly(isoOrDate) {
  return String(isoOrDate).slice(0, 10);
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA + "T00:00:00Z");
  const b = new Date(dateB + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Список YYYY-MM, покрывающих диапазон дат включительно */
function monthsCoveringRange(fromStr, toStr) {
  const from = new Date(fromStr + "T00:00:00Z");
  const to = new Date(toStr + "T00:00:00Z");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return [];
  }
  const months = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push(formatMonth(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function fetchPrices(origin, destination, month) {
  const params = new URLSearchParams({
    origin,
    destination,
    departure_at: month,
    one_way: "true",
    currency: "rub",
    market: "ru",
    limit: "1000",
    sorting: "price",
    token: TOKEN,
  });

  const url = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `HTTP ${response.status} для ${origin}→${destination} (${month}): ${body}`
    );
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(
      `API error для ${origin}→${destination} (${month}): ${
        data.error || JSON.stringify(data)
      }`
    );
  }

  return data.data || [];
}

function indexByDate(flights, maxTransfers) {
  const map = new Map();
  for (const flight of flights) {
    if (!flight.departure_at || flight.price == null) continue;
    const transfers = Number(flight.transfers ?? 0);
    if (transfers > maxTransfers) continue;
    const date = parseDateOnly(flight.departure_at);
    const prev = map.get(date);
    if (!prev || flight.price < prev.price) {
      map.set(date, flight);
    }
  }
  return map;
}

function toAviasalesLink(link) {
  if (!link) return "";
  if (link.startsWith("http")) return link;
  return AVIASALES_BASE + link;
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsv(filePath, rows) {
  const headers = [
    "Город прилета",
    "Город вылета",
    "Общая цена (руб)",
    "Цена туда",
    "Цена обратно",
    "Дата туда",
    "Дата обратно",
    "Дней в Китае",
    "Ссылка туда",
    "Ссылка обратно",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.arrivalCity,
        row.departureCity,
        row.totalPrice,
        row.priceTo,
        row.priceBack,
        row.dateTo,
        row.dateBack,
        row.daysInChina,
        row.linkTo,
        row.linkBack,
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "\uFEFF" + lines.join("\n"), "utf8");
}

async function healthCheck() {
  const month = formatMonth(new Date());
  const flights = await fetchPrices(ORIGIN, "BJS", month);
  if (!flights.length) {
    throw new Error(
      "Тестовый запрос прошёл, но кэш пуст (нет данных Москва — Пекин)."
    );
  }
  return flights.length;
}

async function collectRouteCache({ months, outbound, maxTransfers, onProgress }) {
  const cache = new Map();

  for (const city of Object.keys(CHINA_CITIES)) {
    const byDate = new Map();
    for (const month of months) {
      const origin = outbound ? ORIGIN : city;
      const destination = outbound ? city : ORIGIN;
      if (onProgress) {
        onProgress(
          `${outbound ? "Туда" : "Обратно"}: ${origin} → ${destination} (${month})`
        );
      }
      const flights = await fetchPrices(origin, destination, month);
      const indexed = indexByDate(flights, maxTransfers);
      for (const [date, flight] of indexed) {
        const prev = byDate.get(date);
        if (!prev || flight.price < prev.price) {
          byDate.set(date, flight);
        }
      }
      await sleep(REQUEST_DELAY_MS);
    }
    cache.set(city, byDate);
  }

  return cache;
}

function buildOpenJawCombinations(outboundCache, inboundCache, params) {
  const {
    startFrom,
    startTo,
    returnFrom,
    returnTo,
    durationFrom,
    durationTo,
  } = params;

  const rows = [];

  for (const [arrivalCode, outboundByDate] of outboundCache) {
    for (const [dateTo, flightTo] of outboundByDate) {
      if (dateTo < startFrom || dateTo > startTo) continue;

      for (let stay = durationFrom; stay <= durationTo; stay++) {
        const dateBack = addDays(dateTo, stay);
        if (dateBack < returnFrom || dateBack > returnTo) continue;

        for (const [departureCode, inboundByDate] of inboundCache) {
          const flightBack = inboundByDate.get(dateBack);
          if (!flightBack) continue;

          rows.push({
            arrivalCity: CHINA_CITIES[arrivalCode],
            departureCity: CHINA_CITIES[departureCode],
            totalPrice: flightTo.price + flightBack.price,
            priceTo: flightTo.price,
            priceBack: flightBack.price,
            dateTo,
            dateBack,
            daysInChina: daysBetween(dateTo, dateBack),
            linkTo: toAviasalesLink(flightTo.link),
            linkBack: toAviasalesLink(flightBack.link),
          });
        }
      }
    }
  }

  rows.sort(
    (a, b) => a.totalPrice - b.totalPrice || a.dateTo.localeCompare(b.dateTo)
  );
  return rows;
}

function normalizeParams(raw) {
  const startFrom = parseDateOnly(raw.startFrom);
  const startTo = parseDateOnly(raw.startTo);
  const returnFrom = parseDateOnly(raw.returnFrom);
  const returnTo = parseDateOnly(raw.returnTo);
  const durationFrom = Number(raw.durationFrom);
  const durationTo = Number(raw.durationTo);
  const maxTransfers = Number(raw.maxTransfers);
  const maxLayoverHours = Number(raw.maxLayoverHours);

  if (!startFrom || !startTo || startFrom > startTo) {
    throw new Error("Некорректный диапазон даты старта.");
  }
  if (!returnFrom || !returnTo || returnFrom > returnTo) {
    throw new Error("Некорректный диапазон даты возврата.");
  }
  if (
    !Number.isFinite(durationFrom) ||
    !Number.isFinite(durationTo) ||
    durationFrom < 1 ||
    durationTo < durationFrom
  ) {
    throw new Error("Некорректный диапазон продолжительности.");
  }
  if (!Number.isFinite(maxTransfers) || maxTransfers < 0) {
    throw new Error("Некорректное максимальное число пересадок.");
  }
  if (!Number.isFinite(maxLayoverHours) || maxLayoverHours < 0) {
    throw new Error("Некорректная максимальная продолжительность пересадки.");
  }

  return {
    startFrom,
    startTo,
    returnFrom,
    returnTo,
    durationFrom,
    durationTo,
    maxTransfers,
    maxLayoverHours,
  };
}

/**
 * @param {object} rawParams
 * @param {string} outputPath
 * @param {(stage: string) => void} [onProgress]
 * @returns {Promise<{ resultCount: number, params: object }>}
 */
async function runSearch(rawParams, outputPath, onProgress = () => {}) {
  if (!TOKEN) {
    throw new Error("Не задан TRAVELPAYOUTS_TOKEN.");
  }

  const params = normalizeParams(rawParams);

  onProgress("Проверка API: Москва → Пекин...");
  await healthCheck();
  onProgress("API доступен. Загрузка рейсов туда...");

  const outboundMonths = monthsCoveringRange(params.startFrom, params.startTo);
  const inboundMonths = monthsCoveringRange(params.returnFrom, params.returnTo);

  if (!outboundMonths.length) {
    throw new Error("Пустой диапазон месяцев для даты старта.");
  }
  if (!inboundMonths.length) {
    throw new Error("Пустой диапазон месяцев для даты возврата.");
  }

  const outboundCache = await collectRouteCache({
    months: outboundMonths,
    outbound: true,
    maxTransfers: params.maxTransfers,
    onProgress,
  });

  onProgress("Загрузка рейсов обратно...");
  const inboundCache = await collectRouteCache({
    months: inboundMonths,
    outbound: false,
    maxTransfers: params.maxTransfers,
    onProgress,
  });

  onProgress("Сборка Open Jaw комбинаций...");
  const rows = buildOpenJawCombinations(outboundCache, inboundCache, params);
  writeCsv(outputPath, rows);
  onProgress(`Готово: ${rows.length} маршрутов`);

  return { resultCount: rows.length, params };
}

module.exports = {
  runSearch,
  normalizeParams,
  CHINA_CITIES,
};
