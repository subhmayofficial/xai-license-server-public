import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const DATA_DIR = join(__dirname, "data");
const STORE_PATH = join(DATA_DIR, "licenses.json");

const PORT = Number(process.env.PORT || 3847);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Server misconfigured: set ADMIN_PASSWORD in the environment",
    });
  }
  const sent = String(
    req.get("x-admin-password") || req.get("X-Admin-Password") || "",
  ).trim();
  if (sent !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function ensureStore() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(STORE_PATH)) {
    writeFileSync(STORE_PATH, JSON.stringify({ licenses: [] }, null, 2));
  }
}

function readStore() {
  ensureStore();
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    return { licenses: [] };
  }
}

function writeStore(data) {
  writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function normalizeKey(k) {
  return String(k || "").trim();
}

function generateKey() {
  return `XAI-${randomBytes(8).toString("hex").toUpperCase()}`;
}

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "X-Admin-Password"],
  }),
);
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/api/validate", (req, res) => {
  const key = normalizeKey(req.body?.key);
  if (!key) {
    return res.json({ valid: false, reason: "missing" });
  }
  const { licenses } = readStore();
  const hit = licenses.find(
    (L) => !L.revoked && normalizeKey(L.key).toLowerCase() === key.toLowerCase(),
  );
  return res.json({ valid: Boolean(hit) });
});

app.get("/api/admin/licenses", requireAdmin, (_, res) => {
  const { licenses } = readStore();
  res.json({ licenses });
});

app.post("/api/admin/licenses", requireAdmin, (req, res) => {
  const label = String(req.body?.label || "").trim() || "unnamed";
  const key = generateKey();
  const store = readStore();
  const row = {
    key,
    label,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  store.licenses.push(row);
  writeStore(store);
  res.json({ license: row });
});

app.post("/api/admin/licenses/revoke", requireAdmin, (req, res) => {
  const key = normalizeKey(req.body?.key);
  if (!key) return res.status(400).json({ error: "key required" });
  const store = readStore();
  let n = 0;
  for (const L of store.licenses) {
    if (normalizeKey(L.key).toLowerCase() === key.toLowerCase()) {
      L.revoked = true;
      n++;
    }
  }
  writeStore(store);
  res.json({ revoked: n });
});

ensureStore();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`xAI license server listening on port ${PORT}`);
  console.log(`  Health:  http://127.0.0.1:${PORT}/health`);
  if (!ADMIN_PASSWORD) {
    console.warn("  WARNING: ADMIN_PASSWORD is not set — /api/admin/* returns 503");
  } else {
    console.log("  Admin routes require header X-Admin-Password");
  }
});
