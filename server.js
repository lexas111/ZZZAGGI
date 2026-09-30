import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateInput } from "./src/copy.js";
import { generateVariants } from "./src/generate.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

loadEnv(join(ROOT, ".env"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApp({ generate = defaultGenerate, publicDir = PUBLIC_DIR } = {}) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/api/generate") {
        await handleGenerate(req, res, generate);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await handleStatic(url.pathname, req, res, publicDir);
        return;
      }
      sendJson(res, 405, { error: "Метод не поддерживается." });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "request failed");
      sendJson(res, 500, { error: "Не удалось обработать запрос." });
    }
  });
}

async function defaultGenerate(input) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    const error = new Error("Сервер не настроен: отсутствует XAI_API_KEY.");
    error.status = 503;
    throw error;
  }
  return generateVariants(input, {
    apiKey,
    series: randomBytes(4).toString("hex"),
  });
}

async function handleGenerate(req, res, generate) {
  const raw = await readBody(req, 16_000);
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "Некорректный запрос." });
    return;
  }

  const checked = validateInput(body);
  if (!checked.ok) {
    sendJson(res, 400, { error: checked.error });
    return;
  }

  try {
    const variants = await generate(checked.input);
    if (!Array.isArray(variants) || variants.length !== 10) {
      sendJson(res, 502, { error: "Не удалось получить тексты. Попробуйте ещё раз." });
      return;
    }
    sendJson(res, 200, { variants });
  } catch (error) {
    const status = error && error.status === 503 ? 503 : 502;
    const message = status === 503
      ? "Сервер не настроен: отсутствует XAI_API_KEY."
      : "Не удалось получить тексты. Попробуйте ещё раз.";
    console.error(error instanceof Error ? error.message : "generate failed");
    sendJson(res, status, { error: message });
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleStatic(pathname, req, res, publicDir) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = safePublicPath(publicDir, requested);
  if (!filePath) {
    sendJson(res, 404, { error: "Не найдено." });
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendJson(res, 404, { error: "Не найдено." });
      return;
    }
    throw error;
  }
}

function safePublicPath(publicDir, pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) return null;
  const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, relative);
  const root = publicDir.endsWith(sep) ? publicDir : publicDir + sep;
  if (filePath !== publicDir && !filePath.startsWith(root)) return null;
  return filePath;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT || process.env.VIBEFORGE_SESSION_PORT || 4173);
  const server = createApp();
  server.listen(port, () => {
    console.log(`listening on ${port}`);
  });
}
