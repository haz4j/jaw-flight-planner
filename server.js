const http = require("http");
const fs = require("fs");
const path = require("path");
const { runSearch } = require("./lib/collector");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const RESULTS_DIR = path.join(DATA_DIR, "results");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeHistory(history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

function getSearch(id) {
  return readHistory().find((item) => item.id === id) || null;
}

function updateSearch(id, patch) {
  const history = readHistory();
  const idx = history.findIndex((item) => item.id === id);
  if (idx === -1) return null;
  history[idx] = { ...history[idx], ...patch };
  writeHistory(history);
  return history[idx];
}

function createSearch(params) {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    status: "pending",
    stage: "В очереди",
    params,
    resultCount: null,
    error: null,
    downloadUrl: null,
  };
  const history = readHistory();
  history.unshift(record);
  writeHistory(history);
  return record;
}

/** Очередь: один поиск за раз */
const queue = [];
let running = false;

async function processQueue() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;

  running = true;
  const { id, params } = next;
  const outputPath = path.join(RESULTS_DIR, `${id}.csv`);

  try {
    updateSearch(id, { status: "running", stage: "Запуск...", error: null });
    const { resultCount, params: normalized } = await runSearch(
      params,
      outputPath,
      (stage) => updateSearch(id, { status: "running", stage })
    );
    updateSearch(id, {
      status: "done",
      stage: "Готово",
      params: normalized,
      resultCount,
      error: null,
      downloadUrl: `/api/results/${id}`,
    });
  } catch (err) {
    updateSearch(id, {
      status: "failed",
      stage: "Ошибка",
      error: err.message || String(err),
      downloadUrl: null,
    });
  } finally {
    running = false;
    processQueue();
  }
}

function enqueueSearch(params) {
  const record = createSearch(params);
  queue.push({ id: record.id, params });
  processQueue();
  return record;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Некорректный JSON в теле запроса."));
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const cleaned = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.join(base, cleaned);
  if (!full.startsWith(base)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let filePath = safeJoin(PUBLIC_DIR, urlPath === "/" ? "/index.html" : urlPath);
  if (!filePath) {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/searches") {
    sendJson(res, 200, { searches: readHistory() });
    return;
  }

  const oneMatch = pathname.match(/^\/api\/searches\/([^/]+)$/);
  if (req.method === "GET" && oneMatch) {
    const item = getSearch(oneMatch[1]);
    if (!item) {
      sendJson(res, 404, { error: "Поиск не найден" });
      return;
    }
    sendJson(res, 200, item);
    return;
  }

  if (req.method === "POST" && pathname === "/api/searches") {
    try {
      const body = await readBody(req);
      const record = enqueueSearch(body);
      sendJson(res, 201, record);
    } catch (err) {
      sendJson(res, 400, { error: err.message || String(err) });
    }
    return;
  }

  const resultMatch = pathname.match(/^\/api\/results\/([^/]+)$/);
  if (req.method === "GET" && resultMatch) {
    const id = resultMatch[1];
    const item = getSearch(id);
    if (!item || item.status !== "done") {
      sendJson(res, 404, { error: "Файл результата недоступен" });
      return;
    }
    const filePath = path.join(RESULTS_DIR, `${id}.csv`);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: "CSV не найден" });
      return;
    }
    const filename = `china_open_jaw_${id}.csv`;
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

if (!fs.existsSync(HISTORY_FILE)) {
  writeHistory([]);
}

server.listen(PORT, () => {
  console.log(`Open Jaw UI: http://localhost:${PORT}`);
});
