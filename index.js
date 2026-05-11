import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, ".env") });

const DATA_DIR = join(__dirname, "data");
const STORE_PATH = join(DATA_DIR, "licenses.json");

const PORT = Number(process.env.PORT || 3847);
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
).trim();

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

const ADMIN_COOKIE_NAME = "xai_admin";
const ADMIN_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hmacHex(input) {
  return createHmac("sha256", ADMIN_PASSWORD).update(input).digest("hex");
}

function makeAdminCookieValue() {
  // Static token derived from ADMIN_PASSWORD; HTTPS-only cookie protects it in transit.
  // If you rotate ADMIN_PASSWORD, all existing sessions become invalid automatically.
  return hmacHex("xai_admin_v1");
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i <= 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function safeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: "Server misconfigured: set ADMIN_PASSWORD in the environment",
    });
  }
  const sent = String(
    req.get("x-admin-password") || req.get("X-Admin-Password") || "",
  ).trim();
  if (sent) {
    if (!safeEq(sent, ADMIN_PASSWORD)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  }
  const cookies = parseCookies(req);
  const cookie = cookies[ADMIN_COOKIE_NAME] || "";
  if (!cookie || !safeEq(cookie, makeAdminCookieValue())) {
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

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({
      error:
        "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.",
    });
    return null;
  }
  return supabase;
}

/** Log and return a JSON body so admin / logs can see the real PostgREST error. */
function respondSupabaseError(res, route, error, { validateResponse } = {}) {
  const message = error?.message || String(error);
  const code = error?.code || "";
  console.error(`[${route}] Supabase error:`, message, code || "", error?.details || "", error?.hint || "");
  if (validateResponse) {
    return res.status(500).json({ valid: false, error: "db error", detail: message });
  }
  return res.status(500).json({
    error: "db error",
    detail: message,
    ...(code ? { code } : {}),
  });
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

app.get("/", (_, res) => {
  res
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>xAI License API</title><style>body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial;background:#07080c;color:#e8eaef}main{max-width:760px;margin:0 auto;padding:28px}a{color:#7dd3fc;text-decoration:none}code{background:rgba(255,255,255,.06);padding:.15rem .35rem;border-radius:8px}</style></head><body><main><h1>xAI License API</h1><p>Status: <a href="/health">/health</a></p><p>Public validate: <code>POST /api/validate</code></p><p>Admin: <a href="/admin">/admin</a></p></main></body></html>`,
    );
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/admin", (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res
      .status(503)
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>xAI Admin</title></head><body style="font-family:system-ui;padding:24px"><h2>Admin disabled</h2><p>Set <code>ADMIN_PASSWORD</code> on the server.</p></body></html>`,
      );
  }

  const cookies = parseCookies(req);
  const authed = safeEq(cookies[ADMIN_COOKIE_NAME] || "", makeAdminCookieValue());
  if (!authed) {
    return res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>xAI Admin Login</title>
  <style>
    body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial;background:#07080c;color:#e8eaef}
    main{max-width:520px;margin:0 auto;padding:28px}
    .card{border:1px solid rgba(255,255,255,.10);background:rgba(15,17,24,.92);border-radius:16px;padding:18px}
    label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px}
    input{width:100%;box-sizing:border-box;padding:12px 12px;border-radius:12px;border:1px solid rgba(125,211,252,.35);background:rgba(2,6,23,.55);color:#e2e8f0}
    button{margin-top:12px;width:100%;padding:12px;border-radius:12px;border:0;background:#38bdf8;color:#0c1929;font-weight:900}
    .err{margin-top:10px;color:#fb7185;font-size:12px}
    code{background:rgba(255,255,255,.06);padding:.15rem .35rem;border-radius:8px}
  </style>
</head>
<body>
  <main>
    <h1 style="margin:0 0 12px 0">xAI Admin</h1>
    <div class="card">
      <form method="POST" action="/admin/login">
        <label>Admin password</label>
        <input name="password" type="password" placeholder="ADMIN_PASSWORD" autocomplete="current-password" />
        <button type="submit">Login</button>
      </form>
      <p style="margin:10px 0 0 0;color:#94a3b8;font-size:12px">API: <code>/api/admin/*</code></p>
    </div>
  </main>
</body>
</html>`);
  }

  return res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>xAI Admin</title>
  <style>
    body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial;background:#07080c;color:#e8eaef}
    main{max-width:980px;margin:0 auto;padding:22px}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
    .card{border:1px solid rgba(255,255,255,.10);background:rgba(15,17,24,.92);border-radius:16px;padding:16px;margin-bottom:12px}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px}
    input{flex:1;min-width:220px;box-sizing:border-box;padding:10px 12px;border-radius:12px;border:1px solid rgba(125,211,252,.25);background:rgba(2,6,23,.55);color:#e2e8f0}
    button{padding:10px 12px;border-radius:12px;border:0;background:#38bdf8;color:#0c1929;font-weight:900;cursor:pointer}
    button.secondary{background:rgba(255,255,255,.08);color:#e8eaef;border:1px solid rgba(255,255,255,.12)}
    .msg{font-size:12px;color:#94a3b8;margin-top:10px}
    .err{color:#fb7185}
    .ok{color:#4ade80}
    code{background:rgba(255,255,255,.06);padding:.15rem .35rem;border-radius:8px}
    .lic{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(2,6,23,.35);margin-top:8px}
    .meta{color:#94a3b8;font-size:12px}
    .badge{font-size:11px;font-weight:800;padding:4px 8px;border-radius:999px;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.25);color:#cbd5e1}
    .badge.ok{background:rgba(74,222,128,.10);border-color:rgba(74,222,128,.25);color:#86efac}
    .actions{display:flex;gap:8px;align-items:center}
    .copy{background:rgba(255,255,255,.08);color:#e8eaef;border:1px solid rgba(255,255,255,.12)}
    .danger{background:rgba(251,113,133,.12);color:#fecdd3;border:1px solid rgba(251,113,133,.35)}
  </style>
</head>
<body>
  <main>
    <div class="top">
      <h1 style="margin:0">xAI License Admin</h1>
      <form method="POST" action="/admin/logout">
        <button class="secondary" type="submit">Logout</button>
      </form>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px 0;font-size:16px">Create license</h2>
      <div class="row">
        <div style="flex:1;min-width:260px">
          <label>Label (optional)</label>
          <input id="label" placeholder="Customer name" />
        </div>
        <div style="align-self:flex-end">
          <button id="btn-create">Generate key</button>
        </div>
      </div>
      <div id="created" class="msg"></div>
    </div>

    <div class="card">
      <div class="top" style="margin:0 0 10px 0">
        <h2 style="margin:0;font-size:16px">Licenses</h2>
        <button id="btn-refresh" class="secondary">Refresh</button>
      </div>
      <div id="list" class="msg">Loading…</div>
    </div>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);

    async function api(path, opts) {
      const r = await fetch(path, Object.assign({ headers: { "Accept": "application/json" } }, opts || {}));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const parts = [j.error, j.detail].filter(Boolean);
        throw new Error(parts.length ? parts.join(": ") : r.statusText);
      }
      return j;
    }

    function setMsg(el, text, kind) {
      el.className = "msg" + (kind ? " " + kind : "");
      el.textContent = text || "";
    }

    async function refresh() {
      const list = $("list");
      setMsg(list, "Loading…");
      try {
        const j = await api("/api/admin/licenses");
        const items = j.licenses || [];
        if (!items.length) return setMsg(list, "No licenses yet.");
        list.textContent = "";
        list.className = "";
        for (const L of items.slice().reverse()) {
          const row = document.createElement("div");
          row.className = "lic";
          const left = document.createElement("div");
          const code = document.createElement("code");
          code.textContent = L.key;
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.textContent = (L.label || "") + " · " + String(L.createdAt || "").slice(0,10);
          left.appendChild(code);
          left.appendChild(document.createElement("div")).appendChild(meta);

          const right = document.createElement("div");
          right.className = "actions";
          const badge = document.createElement("span");
          badge.className = "badge" + (L.revoked ? "" : " ok");
          badge.textContent = L.revoked ? "revoked" : "active";
          const copy = document.createElement("button");
          copy.className = "copy";
          copy.textContent = "Copy";
          copy.onclick = async () => {
            try { await navigator.clipboard.writeText(L.key); } catch {}
          };
          right.appendChild(copy);
          right.appendChild(badge);
          if (!L.revoked) {
            const rv = document.createElement("button");
            rv.className = "danger";
            rv.textContent = "Revoke";
            rv.onclick = async () => {
              if (!confirm("Revoke " + L.key + "?")) return;
              await api("/api/admin/licenses/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: L.key }) });
              refresh();
            };
            right.appendChild(rv);
          }

          row.appendChild(left);
          row.appendChild(right);
          list.appendChild(row);
        }
      } catch (e) {
        setMsg(list, "Error: " + (e.message || e), "err");
      }
    }

    $("btn-refresh").addEventListener("click", refresh);
    $("btn-create").addEventListener("click", async () => {
      const created = $("created");
      setMsg(created, "");
      try {
        const label = $("label").value.trim();
        const j = await api("/api/admin/licenses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
        setMsg(created, "New key: " + j.license.key, "ok");
        $("label").value = "";
        refresh();
      } catch (e) {
        setMsg(created, "Error: " + (e.message || e), "err");
      }
    });

    refresh();
  </script>
</body>
</html>`);
});

app.use(express.urlencoded({ extended: false, limit: "8kb" }));

app.post("/admin/login", (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).send("ADMIN_PASSWORD not set");
  const pass = String(req.body?.password || "").trim();
  if (!pass || !safeEq(pass, ADMIN_PASSWORD)) {
    return res.status(401).type("html").send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Login failed</title></head><body style="font-family:system-ui;background:#07080c;color:#e8eaef;padding:24px"><h2>Login failed</h2><p>Wrong password.</p><p><a style="color:#7dd3fc" href="/admin">Back</a></p></body></html>`);
  }
  const secure = req.secure || String(req.get("x-forwarded-proto") || "").includes("https");
  const cookie = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(makeAdminCookieValue())}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ADMIN_COOKIE_TTL_MS / 1000)}`,
  ];
  if (secure) cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
  res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  const secure = req.secure || String(req.get("x-forwarded-proto") || "").includes("https");
  const cookie = [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
  res.redirect("/admin");
});

app.post("/api/validate", (req, res) => {
  const key = normalizeKey(req.body?.key);
  if (!key) {
    return res.json({ valid: false, reason: "missing" });
  }
  const sb = requireSupabase(res);
  if (!sb) return;
  (async () => {
    const { data, error } = await sb
      .from("licenses")
      .select("key, revoked")
      .ilike("key", key)
      .limit(1);
    if (error) {
      return respondSupabaseError(res, "POST /api/validate", error, {
        validateResponse: true,
      });
    }
    const row = data?.[0];
    return res.json({ valid: Boolean(row && row.revoked !== true) });
  })();
});

app.get("/api/admin/licenses", requireAdmin, (_, res) => {
  const sb = requireSupabase(res);
  if (!sb) return;
  (async () => {
    const { data, error } = await sb
      .from("licenses")
      .select("key,label,created_at,revoked")
      .order("created_at", { ascending: true });
    if (error) return respondSupabaseError(res, "GET /api/admin/licenses", error);
    const licenses = (data || []).map((r) => ({
      key: r.key,
      label: r.label,
      createdAt: r.created_at,
      revoked: Boolean(r.revoked),
    }));
    res.json({ licenses });
  })();
});

app.post("/api/admin/licenses", requireAdmin, (req, res) => {
  const label = String(req.body?.label || "").trim() || "unnamed";
  const key = generateKey();
  const sb = requireSupabase(res);
  if (!sb) return;
  (async () => {
    const { data, error } = await sb
      .from("licenses")
      .insert({ key, label, revoked: false })
      .select("key,label,created_at,revoked")
      .single();
    if (error) return respondSupabaseError(res, "POST /api/admin/licenses", error);
    res.json({
      license: {
        key: data.key,
        label: data.label,
        createdAt: data.created_at,
        revoked: Boolean(data.revoked),
      },
    });
  })();
});

app.post("/api/admin/licenses/revoke", requireAdmin, (req, res) => {
  const key = normalizeKey(req.body?.key);
  if (!key) return res.status(400).json({ error: "key required" });
  const sb = requireSupabase(res);
  if (!sb) return;
  (async () => {
    const { data, error } = await sb
      .from("licenses")
      .update({ revoked: true })
      .ilike("key", key)
      .select("key");
    if (error) return respondSupabaseError(res, "POST /api/admin/licenses/revoke", error);
    res.json({ revoked: (data || []).length });
  })();
});

ensureStore();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`xAI license server listening on port ${PORT}`);
  console.log(`  Health:  http://127.0.0.1:${PORT}/health`);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("  WARNING: Supabase not configured — API will return 503");
  } else {
    console.log("  Storage: Supabase (licenses table)");
  }
  if (!ADMIN_PASSWORD) {
    console.warn("  WARNING: ADMIN_PASSWORD is not set — /api/admin/* returns 503");
  } else {
    console.log("  Admin routes require header X-Admin-Password");
  }
});
