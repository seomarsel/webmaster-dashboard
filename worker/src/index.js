// src/index.js
var COOKIE = "sess";
var MAX_AGE = 604800;
function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(html, "html");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(json, "json");
function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const p of raw.split(";")) {
    const i = p.indexOf("=");
    if (i < 0) continue;
    if (p.slice(0, i).trim() === name) return decodeURIComponent(p.slice(i + 1).trim());
  }
  return "";
}
__name(readCookie, "readCookie");
async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sign, "sign");
async function makeSession(env) {
  const exp = Date.now() + MAX_AGE * 1e3;
  const value = "ok." + exp;
  const sig = await sign(value, env.SESSION_SECRET || "dev");
  return value + "." + sig;
}
__name(makeSession, "makeSession");
async function isLoggedIn(request, env) {
  const raw = readCookie(request, COOKIE);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  if (Number(parts[1]) < Date.now()) return false;
  const sig = await sign(parts[0] + "." + parts[1], env.SESSION_SECRET || "dev");
  return sig === parts[2];
}
__name(isLoggedIn, "isLoggedIn");
function cookieHeader(token) {
  return COOKIE + "=" + encodeURIComponent(token) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + MAX_AGE;
}
__name(cookieHeader, "cookieHeader");
var ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function newSlug() {
  let s = "";
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  for (const b of buf) s += ALPHABET[b % ALPHABET.length];
  return s;
}
__name(newSlug, "newSlug");
async function ensureSlugs(env) {
  try {
    await env.DB.prepare("ALTER TABLE sites ADD COLUMN slug TEXT").run();
  } catch (e) {
  }
  const rows = await env.DB.prepare(
    "SELECT id FROM sites WHERE slug IS NULL OR slug = ''"
  ).all();
  for (const r of rows.results || []) {
    await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(newSlug(), r.id).run();
  }
}
__name(ensureSlugs, "ensureSlugs");
var MANUAL_FIELDS = ["y3", "y10", "g3", "g10"];
async function ensureManual(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS manual_stats (site_id INTEGER, month TEXT, top3 INTEGER, top10 INTEGER, y3 INTEGER, y10 INTEGER, g3 INTEGER, g10 INTEGER, PRIMARY KEY (site_id, month))"
    ).run();
  } catch (e) {
  }
  for (const f of MANUAL_FIELDS) {
    try {
      await env.DB.prepare("ALTER TABLE manual_stats ADD COLUMN " + f + " INTEGER").run();
    } catch (e) {
    }
  }
}
__name(ensureManual, "ensureManual");
async function loadManual(env, siteId) {
  await ensureManual(env);
  const rows = await env.DB.prepare(
    "SELECT month, y3, y10, g3, g10 FROM manual_stats WHERE site_id = ?"
  ).bind(siteId).all();
  const out = {};
  for (const r of rows.results || []) {
    out[r.month] = { y3: r.y3, y10: r.y10, g3: r.g3, g10: r.g10 };
  }
  return out;
}
__name(loadManual, "loadManual");
async function ensurePages(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER, url TEXT, comment TEXT, UNIQUE (site_id, url))"
    ).run();
  } catch (e) {
  }
}
__name(ensurePages, "ensurePages");
async function loadPages(env, siteId) {
  await ensurePages(env);
  const rows = await env.DB.prepare(
    "SELECT id, url, comment FROM pages WHERE site_id = ? ORDER BY url"
  ).bind(siteId).all();
  return rows.results || [];
}
__name(loadPages, "loadPages");
async function ensurePositions(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS positions (site_id INTEGER, engine TEXT, month TEXT, query TEXT, url TEXT, position REAL, PRIMARY KEY (site_id, engine, month, query))"
    ).run();
  } catch (e) {
  }
}
__name(ensurePositions, "ensurePositions");
function pad2s(n) {
  return (n < 10 ? "0" : "") + n;
}
__name(pad2s, "pad2s");
function lastMonths(n) {
  const out = [];
  const d = /* @__PURE__ */ new Date();
  d.setUTCDate(1);
  for (let i = 1; i <= n; i++) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(x.getUTCFullYear() + "-" + pad2s(x.getUTCMonth() + 1));
  }
  return out;
}
__name(lastMonths, "lastMonths");
async function loadPositions(env, siteId) {
  await ensurePositions(env);
  const months = lastMonths(4);
  const out = {};
  for (const m of months) {
    const rows = await env.DB.prepare(
      "SELECT engine, query, url, position FROM positions WHERE site_id = ? AND month = ?"
    ).bind(siteId, m).all();
    const list = rows.results || [];
    if (!list.length) continue;
    out[m] = list.map((r) => ({
      e: r.engine,
      q: r.query,
      u: r.url,
      p: r.position
    }));
  }
  return out;
}
__name(loadPositions, "loadPositions");
async function ensureAi(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS ai_visibility (site_id INTEGER, month TEXT, platform TEXT, visibility REAL, PRIMARY KEY (site_id, month, platform))"
    ).run();
  } catch (e) {
  }
}
__name(ensureAi, "ensureAi");
async function loadAiRows(env, siteId) {
  await ensureAi(env);
  const rows = await env.DB.prepare(
    "SELECT month, platform, visibility FROM ai_visibility WHERE site_id = ? ORDER BY month DESC, platform"
  ).bind(siteId).all();
  return rows.results || [];
}
__name(loadAiRows, "loadAiRows");
async function loadAi(env, siteId) {
  const rows = await loadAiRows(env, siteId);
  const months = lastMonths(4);
  const out = {};
  for (const r of rows) {
    if (months.indexOf(r.month) < 0) continue;
    if (!out[r.month]) out[r.month] = {};
    out[r.month][r.platform] = r.visibility;
  }
  return out;
}
__name(loadAi, "loadAi");
async function ensureCompetitors(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS competitors (site_id INTEGER, month TEXT, name TEXT, domain TEXT, queries INTEGER, share REAL, avg_pos REAL, category TEXT, is_our INTEGER DEFAULT 0, PRIMARY KEY (site_id, month, name))"
    ).run();
  } catch (e) {
  }
}
__name(ensureCompetitors, "ensureCompetitors");
async function loadCompetitorsStats(env, siteId) {
  await ensureCompetitors(env);
  const rows = await env.DB.prepare(
    "SELECT month, COUNT(*) AS cnt FROM competitors WHERE site_id = ? GROUP BY month ORDER BY month DESC"
  ).bind(siteId).all();
  return rows.results || [];
}
__name(loadCompetitorsStats, "loadCompetitorsStats");
async function loadCompetitors(env, siteId) {
  await ensureCompetitors(env);
  const months = lastMonths(4);
  const out = {};
  for (const m of months) {
    const rows = await env.DB.prepare(
      "SELECT name, domain, queries, share, avg_pos, category, is_our FROM competitors WHERE site_id = ? AND month = ? ORDER BY share DESC"
    ).bind(siteId, m).all();
    const list = rows.results || [];
    if (!list.length) continue;
    out[m] = list.map((r) => ({
      n: r.name,
      d: r.domain,
      q: r.queries,
      s: r.share,
      p: r.avg_pos,
      c: r.category,
      our: r.is_our
    }));
  }
  return out;
}
__name(loadCompetitors, "loadCompetitors");
async function ensurePrompts(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER, text TEXT, UNIQUE (site_id, text))"
    ).run();
  } catch (e) {
  }
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS site_meta (site_id INTEGER PRIMARY KEY, prompts_total INTEGER)"
    ).run();
  } catch (e) {
  }
}
__name(ensurePrompts, "ensurePrompts");
async function loadPrompts(env, siteId) {
  await ensurePrompts(env);
  const rows = await env.DB.prepare(
    "SELECT id, text FROM prompts WHERE site_id = ? ORDER BY id"
  ).bind(siteId).all();
  const meta = await env.DB.prepare(
    "SELECT prompts_total FROM site_meta WHERE site_id = ?"
  ).bind(siteId).first();
  const list = rows.results || [];
  return {
    total: meta && meta.prompts_total != null ? meta.prompts_total : list.length,
    items: list,
    list: list.map((r) => r.text)
  };
}
__name(loadPrompts, "loadPrompts");
var INS_KEYS = ["seo", "ai", "comp", "pages", "ypos", "gpos"];
var INS_TITLES = {
  seo: "\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0442\u0440\u0430\u0444\u0438\u043A \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C",
  ai: "\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418",
  comp: "\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432",
  pages: "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B: \u0432\u0438\u0437\u0438\u0442\u044B \u0438 \u043A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438",
  ypos: "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435 \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C",
  gpos: "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 Google \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C"
};
var INS_SYSTEM = [
  "\u0422\u044B \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442 \u043F\u043E SEO-\u043F\u0440\u043E\u0434\u0432\u0438\u0436\u0435\u043D\u0438\u044E \u0438 \u043F\u043E GEO-\u043F\u0440\u043E\u0434\u0432\u0438\u0436\u0435\u043D\u0438\u044E \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418 (ChatGPT, Gemini, Perplexity, \u042F\u043D\u0434\u0435\u043A\u0441 \u0418\u0418 \u0438 \u0434\u0440\u0443\u0433\u0438\u0435).",
  "\u041E\u0442\u0447\u0451\u0442 \u0447\u0438\u0442\u0430\u0435\u0442 \u0437\u0430\u043A\u0430\u0437\u0447\u0438\u043A, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u0442\u043E\u043D \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u044B\u0439, \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u0439 \u0438 \u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u044B\u0439: \u0440\u043E\u0441\u0442 \u043F\u043E\u0434\u0430\u0432\u0430\u0439 \u043A\u0430\u043A \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0440\u0430\u0431\u043E\u0442\u044B, \u0441\u043D\u0438\u0436\u0435\u043D\u0438\u0435 \u2014 \u043A\u0430\u043A \u0440\u0430\u0431\u043E\u0447\u0438\u0439 \u043C\u043E\u043C\u0435\u043D\u0442 \u0438 \u0442\u043E\u0447\u043A\u0443 \u0440\u043E\u0441\u0442\u0430, \u0431\u0435\u0437 \u0442\u0440\u0435\u0432\u043E\u0433\u0438, \u043E\u043F\u0440\u0430\u0432\u0434\u0430\u043D\u0438\u0439 \u0438 \u0443\u043F\u0440\u0451\u043A\u043E\u0432.",
  "\u0422\u0435\u0431\u0435 \u0434\u0430\u044E\u0442 \u043E\u0434\u043D\u0443 \u0442\u0430\u0431\u043B\u0438\u0446\u0443 \u0441 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430 \u0441\u0430\u0439\u0442\u0430: \u0441\u0442\u0440\u043E\u043A\u0438 \u2014 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u0438, \u0441\u0442\u043E\u043B\u0431\u0446\u044B \u2014 \u043C\u0435\u0441\u044F\u0446\u044B, \u0441\u0432\u0435\u0436\u0438\u0439 \u043C\u0435\u0441\u044F\u0446 \u043E\u0431\u044B\u0447\u043D\u043E \u043F\u0435\u0440\u0432\u044B\u0439.",
  "\u041E\u0442\u0432\u0435\u0442\u044C \u0441\u0442\u0440\u043E\u0433\u043E \u0432 \u0442\u0430\u043A\u043E\u043C \u0444\u043E\u0440\u043C\u0430\u0442\u0435, \u043A\u0430\u0436\u0434\u044B\u0439 \u043F\u0443\u043D\u043A\u0442 \u0441 \u043D\u043E\u0432\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u0438:",
  "\u0418\u0442\u043E\u0433: \u043E\u0434\u043D\u043E \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
  "\u0418\u0442\u043E\u0433: \u043E\u0434\u043D\u043E \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435",
  "\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435: \u043E\u0434\u043D\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435",
  "\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435: \u043E\u0434\u043D\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435",
  "\u041D\u0443\u0436\u043D\u043E 2-3 \u0441\u0442\u0440\u043E\u043A\u0438 \u0418\u0442\u043E\u0433 \u0438 2-3 \u0441\u0442\u0440\u043E\u043A\u0438 \u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435. \u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u043F\u0438\u0448\u0438 \u043E\u0442 \u043B\u0438\u0446\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B, \u0441\u043B\u043E\u0432\u0430\u043C\u0438 \u0432\u0440\u043E\u0434\u0435 \u0443\u0441\u0438\u043B\u0438\u043C, \u0434\u043E\u0431\u0430\u0432\u0438\u043C, \u043F\u0440\u043E\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u043C, \u0440\u0430\u0441\u0448\u0438\u0440\u0438\u043C.",
  "\u041D\u0438\u043A\u0430\u043A\u0438\u0445 \u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0439, \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u043E\u0432, \u043F\u0440\u0438\u0432\u0435\u0442\u0441\u0442\u0432\u0438\u0439 \u0438 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u0438\u0439 \u043F\u0440\u043E \u0444\u043E\u0440\u043C\u0430\u0442. \u0426\u0438\u0444\u0440\u044B \u0431\u0435\u0440\u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0437 \u0442\u0430\u0431\u043B\u0438\u0446\u044B, \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043F\u0440\u0438\u0434\u0443\u043C\u044B\u0432\u0430\u0439, \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u044B \u0438 \u0447\u0438\u0441\u043B\u0430 \u0443\u043A\u0430\u0437\u044B\u0432\u0430\u0439 \u0442\u043E\u0447\u043D\u043E.",
  "\u0415\u0441\u043B\u0438 \u0432 \u0442\u0430\u0431\u043B\u0438\u0446\u0435 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445 \u0438\u043B\u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u043E\u0447\u0435\u0440\u043A\u0438, \u043E\u0442\u0432\u0435\u0442\u044C \u0434\u0432\u0443\u043C\u044F \u0441\u0442\u0440\u043E\u043A\u0430\u043C\u0438: \u0418\u0442\u043E\u0433: \u0414\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u043C\u043D\u043E\u0433\u043E, \u0431\u0430\u0437\u0430 \u0434\u043B\u044F \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0444\u043E\u0440\u043C\u0438\u0440\u0443\u0435\u0442\u0441\u044F. \u0438 \u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435: \u041D\u0430\u043A\u043E\u043F\u0438\u043C \u0434\u0430\u043D\u043D\u044B\u0435 \u0437\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043C\u0435\u0441\u044F\u0446 \u0438 \u0432\u0435\u0440\u043D\u0451\u043C\u0441\u044F \u043A \u043F\u043E\u0434\u0440\u043E\u0431\u043D\u043E\u043C\u0443 \u0440\u0430\u0437\u0431\u043E\u0440\u0443."
].join(" ");
async function ensureInsights(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS insights (site_id INTEGER PRIMARY KEY, generated_at TEXT, model TEXT, text TEXT)"
    ).run();
  } catch (e) {
  }
}
__name(ensureInsights, "ensureInsights");
async function loadInsights(env, siteId) {
  await ensureInsights(env);
  const row = await env.DB.prepare(
    "SELECT generated_at, model, text FROM insights WHERE site_id = ?"
  ).bind(siteId).first();
  if (!row) return { generated_at: null, model: null, items: {} };
  let items = {};
  try {
    items = JSON.parse(row.text || "{}");
  } catch (e) {
    items = {};
  }
  return { generated_at: row.generated_at, model: row.model, items };
}
__name(loadInsights, "loadInsights");
async function ensureAiConfig(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS ai_config (id INTEGER PRIMARY KEY, provider TEXT, base_url TEXT, token TEXT, model TEXT, model_free TEXT)"
    ).run();
  } catch (e) {
  }
}
__name(ensureAiConfig, "ensureAiConfig");
var FREE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
var TUNNEL_BASE = "https://api.aitunnel.ru/v1";
var TUNNEL_MODEL = "gpt-4o-mini";
async function loadAiConfig(env) {
  await ensureAiConfig(env);
  let row = null;
  try {
    row = await env.DB.prepare("SELECT * FROM ai_config WHERE id = 1").first();
  } catch (e) {
  }
  const envBase = (env.AI_BASE_URL || "").trim();
  const fallback = envBase ? "aitunnel" : "workers";
  return {
    provider: row && row.provider || fallback,
    base_url: row && row.base_url || envBase || TUNNEL_BASE,
    token: row && row.token || env.AI_TOKEN || "",
    model: row && row.model || env.AI_MODEL || TUNNEL_MODEL,
    model_free: row && row.model_free || FREE_MODEL
  };
}
__name(loadAiConfig, "loadAiConfig");
async function askAi(env, system, user, maxTokens) {
  const cfg = await loadAiConfig(env);
  const useTunnel = cfg.provider === "aitunnel";
  const base = useTunnel ? String(cfg.base_url || TUNNEL_BASE).trim() : "";
  const token = useTunnel ? String(cfg.token || "").trim() : "";
  const model = useTunnel ? cfg.model || TUNNEL_MODEL : cfg.model_free || FREE_MODEL;
  if (useTunnel && !token) {
    throw new Error("\u041D\u0435 \u0437\u0430\u0434\u0430\u043D \u043A\u043B\u044E\u0447 AITunnel \u2014 \u0432\u0441\u0442\u0430\u0432\u044C \u0435\u0433\u043E \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435, \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \xAB\u0414\u0432\u0438\u0436\u043E\u043A \u0418\u0418\xBB");
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
  if (base) {
    const r = await fetch(base.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: Math.max(maxTokens || 500, 16e3)
      })
    });
    if (!r.ok) {
      let detail = "";
      try {
        detail = (await r.text()).slice(0, 300);
      } catch (e) {
      }
      throw new Error("\u0418\u0418 \u043E\u0442\u0432\u0435\u0442\u0438\u043B " + r.status + (detail ? ": " + detail : ""));
    }
    const j = await r.json();
    const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "";
    if (!txt.trim()) {
      throw new Error(
        "\u041C\u043E\u0434\u0435\u043B\u044C " + model + " \u0432\u0435\u0440\u043D\u0443\u043B\u0430 \u043F\u0443\u0441\u0442\u043E\u0439 \u043E\u0442\u0432\u0435\u0442. \u0421\u043A\u043E\u0440\u0435\u0435 \u0432\u0441\u0435\u0433\u043E \u043E\u043D\u0430 \xAB\u0434\u0443\u043C\u0430\u044E\u0449\u0430\u044F\xBB \u2014 \u0432\u044B\u0431\u0435\u0440\u0438 \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435 \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E\u043F\u0440\u043E\u0449\u0435, \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 gpt-4o-mini"
      );
    }
    return { text: txt, model: j.model || model };
  }
  if (!env.AI) throw new Error('Workers AI \u043D\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D: \u0434\u043E\u0431\u0430\u0432\u044C [ai] binding = "AI" \u0432 wrangler.toml');
  const res = await env.AI.run(model, { messages, max_tokens: maxTokens || 500 });
  return { text: res.response || "", model };
}
__name(askAi, "askAi");
function cleanInsight(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/```[a-zA-Z]*/g, "").replace(/```/g, "");
  const concl = [];
  const next = [];
  for (let line of s.split("\n")) {
    line = line.trim();
    if (!line) continue;
    line = line.replace(/^[-*\u2022\d.)\s]+/, "").replace(/\*\*/g, "").trim();
    if (!line) continue;
    const low = line.toLowerCase();
    if (low.indexOf("\u0432\u043E\u0442 ") === 0) continue;
    if (low.indexOf("\u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435") === 0 || low.indexOf("\u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C \u0434\u0430\u043B\u044C\u0448\u0435") === 0) {
      const t = line.replace(/^[^:]*:\s*/, "").trim();
      if (t && next.length < 4) next.push(t);
      continue;
    }
    if (low.indexOf("\u0438\u0442\u043E\u0433") === 0 || low.indexOf("\u0432\u044B\u0432\u043E\u0434") === 0) {
      const t = line.replace(/^[^:]*:\s*/, "").trim();
      if (t && concl.length < 4) concl.push(t);
      continue;
    }
    if (low.indexOf("\u0430\u043D\u0430\u043B\u0438\u0437") === 0 && line.length < 30) continue;
    if (concl.length < 4) concl.push(line);
  }
  const a = concl.join(" \u2022 ");
  const b = next.join(" \u2022 ");
  if (!a && !b) return "";
  return (b ? a + " \u2016 " + b : a).slice(0, 1600);
}
__name(cleanInsight, "cleanInsight");
var PLAN_SYSTEM = [
  "\u0422\u044B \u0441\u0435\u043D\u044C\u043E\u0440-\u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442 \u043F\u043E SEO-\u043F\u0440\u043E\u0434\u0432\u0438\u0436\u0435\u043D\u0438\u044E \u0438 \u043F\u043E GEO-\u043F\u0440\u043E\u0434\u0432\u0438\u0436\u0435\u043D\u0438\u044E \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418 (ChatGPT, Gemini, Perplexity, \u042F\u043D\u0434\u0435\u043A\u0441 \u0418\u0418, DeepSeek, Claude).",
  "\u041F\u0438\u0448\u0435\u0448\u044C \u043F\u043B\u0430\u043D \u0440\u0430\u0431\u043E\u0442 \u0434\u043B\u044F \u0437\u0430\u043A\u0430\u0437\u0447\u0438\u043A\u0430 \u2014 \u0442\u0430\u043A\u043E\u0439, \u043A\u0430\u043A\u043E\u0439 \u0430\u0433\u0435\u043D\u0442\u0441\u0442\u0432\u043E \u043F\u0440\u0438\u0441\u044B\u043B\u0430\u0435\u0442 \u043A\u043B\u0438\u0435\u043D\u0442\u0443 \u0432 \u043D\u0430\u0447\u0430\u043B\u0435 \u043C\u0435\u0441\u044F\u0446\u0430: \u0436\u0438\u0432\u044B\u043C \u0447\u0435\u043B\u043E\u0432\u0435\u0447\u0435\u0441\u043A\u0438\u043C \u044F\u0437\u044B\u043A\u043E\u043C, \u0431\u0435\u0437 \u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u043E\u0433\u043E \u0436\u0430\u0440\u0433\u043E\u043D\u0430 \u0438 \u0431\u0435\u0437 \u0441\u0441\u044B\u043B\u043E\u043A \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043E\u0442\u0447\u0451\u0442\u0430.",
  "\u041A\u0430\u0442\u0435\u0433\u043E\u0440\u0438\u0447\u0435\u0441\u043A\u0438 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D\u043E \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u0442\u044C \u0434\u0430\u0448\u0431\u043E\u0440\u0434, \u0442\u0430\u0431\u043B\u0438\u0446\u044B, \u0431\u043B\u043E\u043A\u0438, \u0440\u0430\u0437\u0434\u0435\u043B\u044B \u043E\u0442\u0447\u0451\u0442\u0430, \u0441\u0442\u043E\u043B\u0431\u0446\u044B \u0438 \u0441\u043B\u043E\u0432\u0430 \xAB\u0432\u044B\u0432\u043E\u0434\u044B\xBB, \xAB\u0434\u0430\u043D\u043D\u044B\u0435 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430\xBB. \u041D\u0435 \u043A\u043E\u043F\u0438\u0440\u0443\u0439 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0438 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0445 \u0431\u043B\u043E\u043A\u043E\u0432 \u0432\u0440\u043E\u0434\u0435 \xAB\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0442\u0440\u0430\u0444\u0438\u043A \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C\xBB, \xAB\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435 \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C\xBB, \xAB\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432\xBB.",
  "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u044F \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0439 \u043F\u0440\u0438\u0434\u0443\u043C\u044B\u0432\u0430\u0435\u0448\u044C \u0441\u0430\u043C \u043F\u043E \u0441\u043C\u044B\u0441\u043B\u0443 \u0440\u0430\u0431\u043E\u0442, \u043A\u0430\u043A \u0432 \u043A\u043E\u043C\u043C\u0435\u0440\u0447\u0435\u0441\u043A\u043E\u043C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0438: \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 \xAB\u0420\u0430\u0441\u0448\u0438\u0440\u044F\u0435\u043C \u043E\u0445\u0432\u0430\u0442 \u043F\u043E \u043A\u043E\u043C\u043C\u0435\u0440\u0447\u0435\u0441\u043A\u0438\u043C \u0437\u0430\u043F\u0440\u043E\u0441\u0430\u043C\xBB, \xAB\u0423\u0441\u0438\u043B\u0438\u0432\u0430\u0435\u043C \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B\xBB, \xAB\u0417\u0430\u043A\u0440\u0435\u043F\u043B\u044F\u0435\u043C\u0441\u044F \u0432 \u043E\u0442\u0432\u0435\u0442\u0430\u0445 \u0418\u0418\xBB, \xAB\u0420\u0430\u0441\u0442\u0451\u043C \u0431\u044B\u0441\u0442\u0440\u0435\u0435 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432\xBB, \xAB\u041F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u0435\u043C \u0442\u0440\u0430\u0444\u0438\u043A \u0432 \u0437\u0430\u044F\u0432\u043A\u0438\xBB.",
  "\u0422\u0435\u0431\u0435 \u0434\u0430\u044E\u0442 \u043A\u0440\u0430\u0442\u043A\u0438\u0435 \u0438\u0442\u043E\u0433\u0438 \u0440\u0430\u0431\u043E\u0442\u044B \u0441\u0430\u0439\u0442\u0430 \u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u043C\u0435\u0441\u044F\u0446\u044B. \u0421\u043E\u0431\u0435\u0440\u0438 \u0438\u0437 \u043D\u0438\u0445 \u043F\u043E\u0434\u0440\u043E\u0431\u043D\u044B\u0439 \u043F\u0440\u0435\u0437\u0435\u043D\u0442\u0430\u0431\u0435\u043B\u044C\u043D\u044B\u0439 \u043F\u043B\u0430\u043D \u0440\u0430\u0431\u043E\u0442 \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043C\u0435\u0441\u044F\u0446.",
  "\u041F\u043B\u0430\u043D \u0447\u0438\u0442\u0430\u0435\u0442 \u0437\u0430\u043A\u0430\u0437\u0447\u0438\u043A: \u0442\u043E\u043D \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u044B\u0439, \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u0439 \u0438 \u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u044B\u0439, \u0431\u0435\u0437 \u0442\u0440\u0435\u0432\u043E\u0433\u0438 \u0438 \u0443\u043F\u0440\u0451\u043A\u043E\u0432. \u041F\u0438\u0448\u0438 \u043E\u0442 \u043B\u0438\u0446\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B: \u0443\u0441\u0438\u043B\u0438\u043C, \u0434\u043E\u0431\u0430\u0432\u0438\u043C, \u043F\u0440\u043E\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u043C, \u0440\u0430\u0441\u0448\u0438\u0440\u0438\u043C.",
  "\u0424\u043E\u0440\u043C\u0430\u0442 \u043E\u0442\u0432\u0435\u0442\u0430 \u0441\u0442\u0440\u043E\u0433\u0438\u0439, \u043A\u0430\u0436\u0434\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 \u043E\u0434\u043D\u043E\u0433\u043E \u0438\u0437 \u0441\u043B\u043E\u0432:",
  "\u0412\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435: 2-3 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u043E \u0442\u043E\u043C, \u043D\u0430 \u0447\u0451\u043C \u0441\u043E\u0441\u0440\u0435\u0434\u043E\u0442\u043E\u0447\u0438\u043C\u0441\u044F \u0432 \u043D\u043E\u0432\u043E\u043C \u043C\u0435\u0441\u044F\u0446\u0435 \u0438 \u043F\u043E\u0447\u0435\u043C\u0443 \u0438\u043C\u0435\u043D\u043D\u043E \u043D\u0430 \u044D\u0442\u043E\u043C \u2014 \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439",
  "\u041D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435: \u0436\u0438\u0432\u043E\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0431\u043B\u043E\u043A\u0430 \u0440\u0430\u0431\u043E\u0442",
  "\u0428\u0430\u0433: \u0447\u0442\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u2014 \u0437\u0430\u0447\u0435\u043C \u044D\u0442\u043E \u043D\u0443\u0436\u043D\u043E \u0438 \u043A\u0430\u043A\u043E\u0439 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u0436\u0434\u0451\u043C",
  "\u0418\u0442\u043E\u0433: 1-2 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u043E \u0442\u043E\u043C, \u0447\u0442\u043E \u0437\u0430\u043A\u0430\u0437\u0447\u0438\u043A \u0443\u0432\u0438\u0434\u0438\u0442 \u043A \u043A\u043E\u043D\u0446\u0443 \u043C\u0435\u0441\u044F\u0446\u0430 \u2014 \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u043E\u0439 \u0432 \u0441\u0430\u043C\u043E\u043C \u043A\u043E\u043D\u0446\u0435",
  "\u0421\u0442\u0440\u0443\u043A\u0442\u0443\u0440\u0430: \u043E\u0434\u043D\u043E \u0412\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435, \u0437\u0430\u0442\u0435\u043C \u043E\u0442 4 \u0434\u043E 6 \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0439, \u0432 \u043A\u0430\u0436\u0434\u043E\u043C \u043E\u0442 3 \u0434\u043E 5 \u0448\u0430\u0433\u043E\u0432, \u0432 \u043A\u043E\u043D\u0446\u0435 \u043E\u0434\u0438\u043D \u0418\u0442\u043E\u0433.",
  "\u041A\u0430\u0436\u0434\u044B\u0439 \u0448\u0430\u0433 \u043D\u0430\u0447\u0438\u043D\u0430\u0435\u0442\u0441\u044F \u0441 \u0433\u043B\u0430\u0433\u043E\u043B\u0430 \u043E\u0442 \u043B\u0438\u0446\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u044B (\u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u043C, \u0434\u043E\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u043C, \u0440\u0430\u0441\u0448\u0438\u0440\u0438\u043C, \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u043C, \u043F\u0435\u0440\u0435\u043F\u0438\u0448\u0435\u043C, \u0441\u043E\u0431\u0435\u0440\u0451\u043C) \u0438 \u043F\u0438\u0448\u0435\u0442\u0441\u044F \u0440\u0430\u0437\u0432\u0451\u0440\u043D\u0443\u0442\u043E, \u043D\u0430 1-2 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F, \u0430 \u043D\u0435 \u0432 \u0442\u0440\u0438 \u0441\u043B\u043E\u0432\u0430.",
  "\u0428\u0430\u0433\u0438 \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u044B\u0435 \u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u043C\u044B\u0435 \u0437\u0430 \u043C\u0435\u0441\u044F\u0446: \u043D\u0430\u0437\u044B\u0432\u0430\u0439 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446 \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442\u043E\u0432, \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u044B\u0435 \u0430\u0434\u0440\u0435\u0441\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446, \u0437\u0430\u043F\u0440\u043E\u0441\u044B, \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0435 \u0441\u0438\u0441\u0442\u0435\u043C\u044B \u0438 \u043F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u044B \u0418\u0418, \u0435\u0441\u043B\u0438 \u043E\u043D\u0438 \u0435\u0441\u0442\u044C \u0432 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445.",
  "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E \u0437\u0430\u043A\u0440\u043E\u0439 \u0432\u0441\u0435 \u0442\u0435\u043C\u044B, \u043F\u043E \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u0435\u0441\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435: \u0442\u0440\u0430\u0444\u0438\u043A \u0438 \u0441\u0435\u043C\u0430\u043D\u0442\u0438\u043A\u0430, \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u043D\u0438\u0435 \u0438 \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B, \u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435 \u0438 Google, \u0432\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u043E\u0442\u0432\u0435\u0442\u0430\u0445 \u0418\u0418, \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u044B, \u0437\u0430\u044F\u0432\u043A\u0438 \u0438 \u043A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438 \u2014 \u043D\u043E \u0440\u0430\u0441\u043A\u043B\u0430\u0434\u044B\u0432\u0430\u0439 \u0438\u0445 \u043F\u043E \u0441\u0432\u043E\u0438\u043C \u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u044F\u043C, \u0430 \u043D\u0435 \u043F\u043E \u0447\u0443\u0436\u0438\u043C \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0430\u043C.",
  "\u041F\u0440\u043E \u0432\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0432 \u0418\u0418 \u043F\u0438\u0448\u0438 \u043F\u0440\u0435\u0434\u043C\u0435\u0442\u043D\u043E: \u044D\u043A\u0441\u043F\u0435\u0440\u0442\u043D\u044B\u0435 \u043E\u0431\u0437\u043E\u0440\u044B \u0438 \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u044F, \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0432\u043E\u043F\u0440\u043E\u0441-\u043E\u0442\u0432\u0435\u0442, \u0446\u0438\u0442\u0438\u0440\u0443\u0435\u043C\u044B\u0435 \u0444\u0430\u043A\u0442\u044B \u0438 \u0446\u0438\u0444\u0440\u044B, \u043E\u0442\u0437\u044B\u0432\u044B \u0438 \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u044F \u043D\u0430 \u0432\u043D\u0435\u0448\u043D\u0438\u0445 \u043F\u043B\u043E\u0449\u0430\u0434\u043A\u0430\u0445, \u0440\u0430\u0431\u043E\u0442\u0430 \u0441 \u0437\u0430\u043F\u0440\u043E\u0441\u0430\u043C\u0438, \u043F\u043E \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u0431\u0440\u0435\u043D\u0434 \u043F\u043E\u043A\u0430 \u043D\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442\u0441\u044F.",
  "\u0422\u043E\u043D \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u044B\u0439, \u0443\u0432\u0435\u0440\u0435\u043D\u043D\u044B\u0439 \u0438 \u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u044B\u0439, \u0431\u0435\u0437 \u0442\u0440\u0435\u0432\u043E\u0433\u0438 \u0438 \u0443\u043F\u0440\u0451\u043A\u043E\u0432. \u041D\u0438\u043A\u0430\u043A\u0438\u0445 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u0438\u0439 \u043F\u0440\u043E \u0444\u043E\u0440\u043C\u0430\u0442, \u043D\u0443\u043C\u0435\u0440\u0430\u0446\u0438\u0438 \u0438 \u0437\u0432\u0451\u0437\u0434\u043E\u0447\u0435\u043A. \u0426\u0438\u0444\u0440\u044B \u0431\u0435\u0440\u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0437 \u0438\u0441\u0445\u043E\u0434\u043D\u044B\u0445 \u0434\u0430\u043D\u043D\u044B\u0445, \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043F\u0440\u0438\u0434\u0443\u043C\u044B\u0432\u0430\u0439."
].join(" ");
var PLAN_BAN = [
  "\u0434\u0430\u0448\u0431\u043E\u0440\u0434",
  "\u0442\u0430\u0431\u043B\u0438\u0446",
  "\u0431\u043B\u043E\u043A\u0435 ",
  "\u0431\u043B\u043E\u043A\u0430 ",
  "\u0440\u0430\u0437\u0434\u0435\u043B\u0435 \u043E\u0442\u0447\u0451\u0442",
  "\u0441\u0442\u043E\u043B\u0431\u0435\u0446",
  "\u0441\u043E\u0433\u043B\u0430\u0441\u043D\u043E \u0432\u044B\u0432\u043E\u0434\u0430\u043C",
  "\u0438\u0441\u0445\u043E\u0434\u044F \u0438\u0437 \u0432\u044B\u0432\u043E\u0434\u043E\u0432",
  "\u0432\u043E\u0442 \u043F\u043B\u0430\u043D",
  "\u043F\u043B\u0430\u043D \u0440\u0430\u0431\u043E\u0442 \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043C\u0435\u0441\u044F\u0446:"
];
function planStrip(line) {
  return line.replace(/^[-*\u2022\u2013\u2014\s]+/, "").replace(/^\d+[.)]\s*/, "").replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^#+\s*/, "").trim();
}
__name(planStrip, "planStrip");
function cleanPlan(raw) {
  let s = String(raw || "").trim();
  s = s.replace(/```[a-zA-Z]*/g, "").replace(/```/g, "");
  const out = [];
  let tail = "";
  for (let line of s.split("\n")) {
    line = planStrip(line.trim());
    if (!line) continue;
    const low = line.toLowerCase();
    let banned = false;
    for (const b of PLAN_BAN) {
      if (low.indexOf(b) >= 0) banned = true;
    }
    if (banned) continue;
    if (low.indexOf("\u0432\u0441\u0442\u0443\u043F\u043B\u0435\u043D\u0438\u0435") === 0 || low.indexOf("\u0432\u0432\u0435\u0434\u0435\u043D\u0438\u0435") === 0) {
      const t = planStrip(line.replace(/^[^:]*:\s*/, ""));
      if (t) out.unshift("~ " + t);
      continue;
    }
    if (low.indexOf("\u0438\u0442\u043E\u0433") === 0 || low.indexOf("\u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 \u043C\u0435\u0441\u044F\u0446\u0430") === 0) {
      const t = planStrip(line.replace(/^[^:]*:\s*/, ""));
      if (t) tail = "~ " + t;
      continue;
    }
    if (low.indexOf("\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435") === 0 || low.indexOf("\u0440\u0430\u0437\u0434\u0435\u043B") === 0) {
      const t = planStrip(line.replace(/^[^:]*:\s*/, ""));
      if (t) out.push("# " + t);
      continue;
    }
    if (low.indexOf("\u0448\u0430\u0433") === 0 || low.indexOf("\u0437\u0430\u0434\u0430\u0447\u0430") === 0) {
      const t = planStrip(line.replace(/^[^:]*:\s*/, ""));
      if (t) out.push("- " + t);
      continue;
    }
    if (line.length < 60 && line.slice(-1) !== "." && out.length && line.indexOf(" \u2014 ") < 0) {
      out.push("# " + line);
      continue;
    }
    out.push("- " + line);
    if (out.length > 80) break;
  }
  if (tail) out.push(tail);
  return out.join("\n").slice(0, 6e3);
}
__name(cleanPlan, "cleanPlan");
async function saveInsightItems(env, siteId, items, model) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await ensureInsights(env);
  await env.DB.prepare(
    "INSERT INTO insights (site_id, generated_at, model, text) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET generated_at = excluded.generated_at, model = excluded.model, text = excluded.text"
  ).bind(siteId, now, model || null, JSON.stringify(items || {})).run();
  return { generated_at: now, model: model || null, items: items || {} };
}
__name(saveInsightItems, "saveInsightItems");
async function generateOne(env, site, key, table) {
  const cur = await loadInsights(env, site.id);
  const items = cur.items || {};
  let model = cur.model || null;
  if (key === "plan") {
    const parts = [];
    for (const k of INS_KEYS) {
      if (!items[k]) continue;
      const body = String(items[k]).split(" \u2016 ").join("\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435: ").split(" \u2022 ").join("\n");
      parts.push(INS_TITLES[k] + ":\n" + body);
    }
    if (!parts.length) {
      throw new Error("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439 \u0432\u044B\u0432\u043E\u0434\u044B \u043F\u043E\u0434 \u0442\u0430\u0431\u043B\u0438\u0446\u0430\u043C\u0438 \u2014 \u043F\u043B\u0430\u043D \u0441\u043E\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044F \u043F\u043E \u043D\u0438\u043C");
    }
    const user2 = "\u0421\u0430\u0439\u0442: " + site.name + "\n\n\u0427\u0442\u043E \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u044E\u0442 \u0446\u0438\u0444\u0440\u044B \u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u043C\u0435\u0441\u044F\u0446\u044B:\n\n" + parts.join("\n\n").slice(0, 4e3);
    const ans2 = await askAi(env, PLAN_SYSTEM, user2, 2400);
    const plan = cleanPlan(ans2.text);
    if (!plan) throw new Error("\u0418\u0418 \u0432\u0435\u0440\u043D\u0443\u043B \u043F\u0443\u0441\u0442\u043E\u0439 \u043F\u043B\u0430\u043D");
    items.plan = plan;
    model = ans2.model || model;
    return await saveInsightItems(env, site.id, items, model);
  }
  if (INS_KEYS.indexOf(key) < 0) throw new Error("\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u0431\u043B\u043E\u043A \u0432\u044B\u0432\u043E\u0434\u043E\u0432");
  const t = String(table || "").trim();
  if (t.length < 20) throw new Error("\u0412 \u044D\u0442\u043E\u0439 \u0442\u0430\u0431\u043B\u0438\u0446\u0435 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445 \u0434\u043B\u044F \u0432\u044B\u0432\u043E\u0434\u0430");
  const user = "\u0421\u0430\u0439\u0442: " + site.name + "\n\u0411\u043B\u043E\u043A: " + INS_TITLES[key] + "\n\n\u0422\u0430\u0431\u043B\u0438\u0446\u0430:\n" + t.slice(0, 2500);
  const ans = await askAi(env, INS_SYSTEM, user);
  const txt = cleanInsight(ans.text);
  if (!txt) throw new Error("\u0418\u0418 \u0432\u0435\u0440\u043D\u0443\u043B \u043F\u0443\u0441\u0442\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 \u2014 \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439 \u0435\u0449\u0451 \u0440\u0430\u0437 \u0438\u043B\u0438 \u0432\u044B\u0431\u0435\u0440\u0438 \u043C\u043E\u0434\u0435\u043B\u044C \u043F\u043E\u043F\u0440\u043E\u0449\u0435");
  items[key] = txt;
  model = ans.model || model;
  return await saveInsightItems(env, site.id, items, model);
}
__name(generateOne, "generateOne");
async function generateInsights(env, siteId, siteName, facts) {
  const items = {};
  let lastError = null;
  let model = null;
  for (const k of INS_KEYS) {
    const table = String(facts && facts[k] || "").trim();
    if (table.length < 20) continue;
    const user = "\u0421\u0430\u0439\u0442: " + siteName + "\n\u0411\u043B\u043E\u043A: " + INS_TITLES[k] + "\n\n\u0422\u0430\u0431\u043B\u0438\u0446\u0430:\n" + table.slice(0, 2500);
    try {
      const ans = await askAi(env, INS_SYSTEM, user);
      model = ans.model;
      const txt = cleanInsight(ans.text);
      if (txt) items[k] = txt;
    } catch (e) {
      lastError = e;
    }
  }
  if (Object.keys(items).length) {
    try {
      const parts = [];
      for (const k of INS_KEYS) {
        if (!items[k]) continue;
        const body = String(items[k]).split(" \u2016 ").join("\n\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435: ").split(" \u2022 ").join("\n");
        parts.push(INS_TITLES[k] + ":\n" + body);
      }
      const user = "\u0421\u0430\u0439\u0442: " + siteName + "\n\n\u0427\u0442\u043E \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u044E\u0442 \u0446\u0438\u0444\u0440\u044B \u0437\u0430 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0435 \u043C\u0435\u0441\u044F\u0446\u044B:\n\n" + parts.join("\n\n").slice(0, 4e3);
      const ans = await askAi(env, PLAN_SYSTEM, user, 2400);
      model = ans.model || model;
      const plan = cleanPlan(ans.text);
      if (plan) items.plan = plan;
    } catch (e) {
      lastError = e;
    }
  }
  if (!Object.keys(items).length) {
    throw new Error(lastError ? String(lastError.message || lastError) : "\u0418\u0418 \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0442\u0435\u043A\u0441\u0442");
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await ensureInsights(env);
  await env.DB.prepare(
    "INSERT INTO insights (site_id, generated_at, model, text) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET generated_at = excluded.generated_at, model = excluded.model, text = excluded.text"
  ).bind(siteId, now, model, JSON.stringify(items)).run();
  return { generated_at: now, model, items };
}
__name(generateInsights, "generateInsights");
async function ensureDone(env) {
  try {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS done_works (site_id INTEGER, month TEXT, text TEXT, PRIMARY KEY (site_id, month))"
    ).run();
  } catch (e) {
  }
}
__name(ensureDone, "ensureDone");
async function loadDone(env, siteId) {
  await ensureDone(env);
  const rows = await env.DB.prepare(
    "SELECT month, text FROM done_works WHERE site_id = ? ORDER BY month DESC"
  ).bind(siteId).all();
  const out = {};
  for (const r of rows.results || []) {
    if (r.text && String(r.text).trim()) out[r.month] = String(r.text);
  }
  return out;
}
__name(loadDone, "loadDone");
async function dashData(env, site) {
  const snap = await env.DB.prepare(
    "SELECT updated_at, payload FROM snapshots WHERE site_id = ?"
  ).bind(site.id).first();
  let data = null;
  if (snap && snap.payload) {
    try {
      data = JSON.parse(snap.payload);
    } catch (e) {
      data = null;
    }
  }
  return {
    site: { id: site.id, name: site.name },
    data,
    manual: await loadManual(env, site.id),
    pages: await loadPages(env, site.id),
    positions: await loadPositions(env, site.id),
    ai: await loadAi(env, site.id),
    competitors: await loadCompetitors(env, site.id),
    prompts: await loadPrompts(env, site.id),
    done: await loadDone(env, site.id)
  };
}
__name(dashData, "dashData");
var CSS = `
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #0f1115; color: #e7e9ee;
	font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 12px; }
a { color: #6aa9ff; }
.muted { color: #8b93a7; font-size: 13px; }
.card { background: #171a21; border: 1px solid #242833; border-radius: 12px;
	padding: 18px; margin-bottom: 18px; }
label { display: block; font-size: 12px; color: #8b93a7; margin-bottom: 4px; }
input, select, textarea, button { font: inherit; }
input, select, textarea { width: 100%; padding: 9px 10px; border-radius: 8px;
	border: 1px solid #2b3040; background: #10131a; color: #e7e9ee; }
textarea { min-height: 90px; resize: vertical; }
button { padding: 9px 14px; border-radius: 8px; border: 1px solid #2b3040;
	background: #232838; color: #e7e9ee; cursor: pointer; }
button:hover { background: #2c3245; }
button.primary { background: #2f6df6; border-color: #2f6df6; }
button.danger { background: #7f1d1d; border-color: #7f1d1d; }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
.row > div { flex: 1 1 160px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #242833;
	vertical-align: middle; }
th { color: #8b93a7; font-weight: 500; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.hidden { display: none !important; }
.fmt { font-variant-numeric: tabular-nums; }
.chip { display: inline-block; padding: 6px 12px; border-radius: 999px;
	border: 1px solid #2b3040; background: #171a21; cursor: pointer; font-size: 13px; }
.chip.on { background: #2f6df6; border-color: #2f6df6; }
.kpi { display: flex; gap: 12px; flex-wrap: wrap; }
.kpi .box { flex: 1 1 150px; background: #171a21; border: 1px solid #242833;
	border-radius: 12px; padding: 14px; }
.kpi .box b { display: block; font-size: 22px; margin-top: 4px; }
`;
var LOGIN_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u0412\u0445\u043E\u0434</title><style>${CSS}
body { display: flex; align-items: center; justify-content: center; height: 100vh; }
.card { width: 320px; }
</style></head>
<body>
<form class="card" id="f">
	<h1>\u0412\u0445\u043E\u0434 \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0443</h1>
	<p class="muted">\u0414\u0430\u0448\u0431\u043E\u0440\u0434 \u042F\u043D\u0434\u0435\u043A\u0441.\u041C\u0435\u0442\u0440\u0438\u043A\u0430 + \u0412\u0435\u0431\u043C\u0430\u0441\u0442\u0435\u0440</p>
	<label>\u041F\u0430\u0440\u043E\u043B\u044C</label>
	<input type="password" id="p" autocomplete="current-password" autofocus>
	<div class="actions"><button class="primary" type="submit">\u0412\u043E\u0439\u0442\u0438</button></div>
	<p class="muted" id="e"></p>
</form>
<script>
document.getElementById("f").onsubmit = async function (ev) {
	ev.preventDefault();
	var r = await fetch("/api/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password: document.getElementById("p").value })
	});
	if (r.ok) { location.href = "/admin"; return; }
	document.getElementById("e").textContent = "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C";
};
<\/script>
</body></html>`;
var ADMIN_PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u0410\u0434\u043C\u0438\u043D\u043A\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430</title>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"><\/script>
<style>${CSS}
.layout { display: flex; gap: 18px; align-items: flex-start; }
.side { flex: 0 0 250px; position: sticky; top: 24px; background: #171a21;
	border: 1px solid #242833; border-radius: 12px; padding: 10px; }
.side .grp { color: #8b93a7; font-size: 11px; text-transform: uppercase;
	letter-spacing: .05em; padding: 12px 10px 4px; }
.side button { display: block; width: 100%; text-align: left; background: transparent;
	border: 0; padding: 9px 10px; border-radius: 8px; color: #c9d1e0; font-size: 14px; }
.side button:hover { background: #1f2431; }
.side button.on { background: #2f6df6; color: #fff; }
.pane { flex: 1 1 0; min-width: 0; }
.pane h1.sec { font-size: 18px; margin: 4px 0 14px; }
@media (max-width: 900px) {
	.layout { flex-direction: column; }
	.side { position: static; width: 100%; flex: 1 1 auto; }
}
</style></head>
<body>
<h1>\u0410\u0434\u043C\u0438\u043D\u043A\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430</h1>
<p class="muted">
	<a href="/" target="_blank">\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0434\u0430\u0448\u0431\u043E\u0440\u0434</a> \xB7
	<a href="/api/logout">\u0412\u044B\u0439\u0442\u0438</a>
</p>

<div class="layout">
<nav class="side" id="side"></nav>
<div class="pane" id="pane">
<h1 class="sec" id="secTitle"></h1>

<div class="card" id="formCard">
	<h2 id="formTitle">\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0441\u0430\u0439\u0442</h2>
	<div class="row">
		<div><label>\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u0430\u0439\u0442\u0430</label><input id="name" placeholder="example.ru"></div>
		<div><label>\u041D\u043E\u043C\u0435\u0440 \u0441\u0447\u0451\u0442\u0447\u0438\u043A\u0430 \u041C\u0435\u0442\u0440\u0438\u043A\u0438</label><input id="counter" placeholder="109096235"></div>
	</div>
	<div class="row" style="margin-top:10px">
		<div><label>host_id \u0412\u0435\u0431\u043C\u0430\u0441\u0442\u0435\u0440\u0430 (\u043C\u043E\u0436\u043D\u043E \u043F\u0443\u0441\u0442\u043E)</label><input id="host" placeholder="https:example.ru:443"></div>
		<div><label>OAuth-\u0442\u043E\u043A\u0435\u043D \u042F\u043D\u0434\u0435\u043A\u0441\u0430</label><input id="token" placeholder="y0__..." value="y0__wgBEJG19VQYv6pIIL-D3egY42dAcGpfImvD0cO3yWkfA5mffvc"></div>
	</div>
	<div class="row" style="margin-top:10px">
		<div><label>\u041A\u0430\u043A \u0447\u0430\u0441\u0442\u043E \u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0442\u044C</label>
			<select id="interval">
				<option value="15">\u043A\u0430\u0436\u0434\u044B\u0435 15 \u043C\u0438\u043D\u0443\u0442</option>
				<option value="60" selected>\u043A\u0430\u0436\u0434\u044B\u0439 \u0447\u0430\u0441</option>
				<option value="360">\u043A\u0430\u0436\u0434\u044B\u0435 6 \u0447\u0430\u0441\u043E\u0432</option>
				<option value="1440">\u0440\u0430\u0437 \u0432 \u0441\u0443\u0442\u043A\u0438</option>
			</select>
		</div>
		<div><label>\u0427\u0430\u0441 \u0437\u0430\u043F\u0443\u0441\u043A\u0430 (\u0434\u043B\u044F \xAB\u0440\u0430\u0437 \u0432 \u0441\u0443\u0442\u043A\u0438\xBB)</label><select id="hour"></select></div>
	</div>
	<div class="actions">
		<button class="primary" id="submitBtn">\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C</button>
		<button id="cancelBtn" class="hidden">\u041E\u0442\u043C\u0435\u043D\u0430</button>
	</div>
	<p class="muted" id="formHint"></p>
</div>

<div class="card">
	<h2>\u0421\u0430\u0439\u0442\u044B</h2>
	<table>
		<thead><tr>
			<th>\u0421\u0430\u0439\u0442</th><th>\u0421\u0447\u0451\u0442\u0447\u0438\u043A</th><th>host_id</th><th>\u041E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435</th>
			<th>\u0421\u0441\u044B\u043B\u043A\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0443</th><th>\u0412\u043A\u043B</th><th></th>
		</tr></thead>
		<tbody id="rows"></tbody>
	</table>
	<div class="actions"><button id="refreshAll">\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0441\u0435 \u0441\u0430\u0439\u0442\u044B \u0441\u0435\u0439\u0447\u0430\u0441</button></div>
</div>

<div class="card">
	<h2>\u0414\u0432\u0438\u0436\u043E\u043A \u0418\u0418 \u0434\u043B\u044F \u0432\u044B\u0432\u043E\u0434\u043E\u0432</h2>
	<p class="muted">\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0430 \u043E\u0431\u0449\u0430\u044F \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u0441\u0430\u0439\u0442\u043E\u0432. \u0411\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 Workers AI \u0438\u043B\u0438 AITunnel \u043F\u043E \u043A\u043B\u044E\u0447\u0443.</p>
	<div class="row">
		<div><label>\u041A\u0442\u043E \u043F\u0438\u0448\u0435\u0442 \u0432\u044B\u0432\u043E\u0434\u044B</label>
			<select id="engProvider">
				<option value="workers">\u0411\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 Workers AI</option>
				<option value="aitunnel">AITunnel (\u043F\u043E \u043A\u043B\u044E\u0447\u0443, \u043F\u043B\u0430\u0442\u043D\u043E)</option>
			</select>
		</div>
		<div><label>\u041C\u043E\u0434\u0435\u043B\u044C AITunnel</label><input id="engModel" placeholder="gpt-4o-mini"></div>
		<div><label>\u041A\u043B\u044E\u0447 AITunnel</label><input id="engToken" placeholder="sk-aitunnel-..."></div>
	</div>
	<div class="row" style="margin-top:10px">
		<div><label>\u0410\u0434\u0440\u0435\u0441 API AITunnel</label><input id="engBase" placeholder="https://api.aitunnel.ru/v1"></div>
		<div><label>\u041C\u043E\u0434\u0435\u043B\u044C Workers AI</label><input id="engFree" placeholder="@cf/meta/llama-3.3-70b-instruct-fp8-fast"></div>
	</div>
	<div class="actions">
		<button class="primary" id="engSave">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>
		<button id="engTest">\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0441\u0432\u044F\u0437\u044C</button>
	</div>
	<p class="muted" id="engHint"></p>
</div>

<div class="card">
	<h2>\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0438\u0437 Excel</h2>
	<p class="muted">\u0424\u043E\u0440\u043C\u0430\u0442 \u0441\u0442\u043E\u043B\u0431\u0446\u043E\u0432: \u041A\u043B\u044E\u0447\u0435\u0432\u0430\u044F \u0444\u0440\u0430\u0437\u0430 | \u041F\u043E\u0437\u0438\u0446\u0438\u0438 | \u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430. \u0414\u043B\u044F \u043A\u0430\u0436\u0434\u043E\u0439 \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u043E\u0439 \u0441\u0438\u0441\u0442\u0435\u043C\u044B \u2014 \u0441\u0432\u043E\u0439 \u0444\u0430\u0439\u043B.</p>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="posSite"></select></div>
		<div><label>\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u0430\u044F \u0441\u0438\u0441\u0442\u0435\u043C\u0430</label>
			<select id="posEngine">
				<option value="yandex">\u042F\u043D\u0434\u0435\u043A\u0441</option>
				<option value="google">Google</option>
			</select>
		</div>
		<div><label>\u041C\u0435\u0441\u044F\u0446 \u043E\u0442\u0447\u0451\u0442\u0430</label><select id="posMonth"></select></div>
		<div><label>\u0424\u0430\u0439\u043B xlsx</label><input type="file" id="posFile" accept=".xlsx,.xls,.csv"></div>
	</div>
	<div class="actions">
		<button class="primary" id="posUpload">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0432 \u0431\u0430\u0437\u0443</button>
		<button id="posTemplate">\u0421\u043A\u0430\u0447\u0430\u0442\u044C \u0448\u0430\u0431\u043B\u043E\u043D</button>
		<button class="danger" id="posDelete">\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043C\u0435\u0441\u044F\u0446</button>
	</div>
	<p class="muted" id="posHint"></p>
	<table><thead><tr><th>\u041C\u0435\u0441\u044F\u0446</th><th>\u0421\u0438\u0441\u0442\u0435\u043C\u0430</th><th class="num">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432</th><th></th></tr></thead>
		<tbody id="posStats"></tbody></table>
</div>

<div class="card">
	<h2>\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0434\u043B\u044F \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430</h2>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="pagesSite"></select></div>
	</div>
	<div style="margin-top:10px">
		<label>\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0441\u043F\u0438\u0441\u043A\u043E\u043C (\u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0430\u0434\u0440\u0435\u0441\u0443 \u0432 \u0441\u0442\u0440\u043E\u043A\u0435)</label>
		<textarea id="pagesInput" placeholder="/uslugi&#10;/blog/seo"></textarea>
	</div>
	<div class="actions">
		<button class="primary" id="addPages">\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B</button>
		<button id="importPages">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0438\u0437 \u041C\u0435\u0442\u0440\u0438\u043A\u0438</button>
		<button class="danger" id="deletePages">\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043E\u0442\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0435</button>
	</div>
	<p class="muted" id="pagesHint"></p>
	<table><thead><tr>
		<th style="width:32px"><input type="checkbox" id="pagesAll" style="width:auto"></th>
		<th>\u0410\u0434\u0440\u0435\u0441 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B</th><th>\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439</th><th></th>
	</tr></thead><tbody id="pagesRows"></tbody></table>
</div>

<div class="card">
	<h2>\u0417\u0430\u043F\u0440\u043E\u0441\u044B \u0432 \u0422\u041E\u041F \u2014 \u0432\u0432\u043E\u0434 \u0432\u0440\u0443\u0447\u043D\u0443\u044E</h2>
	<div class="row"><div><label>\u0421\u0430\u0439\u0442</label><select id="manualSite"></select></div></div>
	<table style="margin-top:10px"><thead><tr>
		<th>\u041C\u0435\u0441\u044F\u0446</th><th class="num">\u0422\u041E\u041F-3 \u042F\u043D\u0434\u0435\u043A\u0441</th><th class="num">\u0422\u041E\u041F-10 \u042F\u043D\u0434\u0435\u043A\u0441</th>
		<th class="num">\u0422\u041E\u041F-3 Google</th><th class="num">\u0422\u041E\u041F-10 Google</th><th></th>
	</tr></thead><tbody id="manualRows"></tbody></table>
</div>

<div class="card">
	<h2>\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418</h2>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="aiSite"></select></div>
		<div><label>\u041C\u0435\u0441\u044F\u0446</label><select id="aiMonth"></select></div>
		<div><label>\u041F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u0430</label>
			<select id="aiPlatform">
				<option>ChatGPT</option><option>Claude</option><option>DeepSeek</option>
				<option>Google Gemini</option><option>Perplexity</option><option>\u042F\u043D\u0434\u0435\u043A\u0441 \u0418\u0418</option>
			</select>
		</div>
		<div><label>\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C, %</label><input id="aiValue" placeholder="10.9"></div>
	</div>
	<div class="actions"><button class="primary" id="aiSave">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button></div>
	<p class="muted" id="aiHint"></p>
	<table><thead><tr><th>\u041C\u0435\u0441\u044F\u0446</th><th>\u041F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u0430</th><th class="num">\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C, %</th><th></th></tr></thead>
		<tbody id="aiRows"></tbody></table>
</div>

<div class="card">
	<h2>\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432</h2>
	<p class="muted">\u0417\u0430\u0433\u0440\u0443\u0437\u0438 xlsx \u0441 \u043B\u0438\u0441\u0442\u043E\u043C \xAB\u041F\u0440\u044F\u043C\u044B\u0435 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u044B\xBB: \u041A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442 | \u0421\u0430\u0439\u0442 | \u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 | \u0414\u043E\u043B\u044F, % | \u0421\u0440\u0435\u0434\u043D\u044F\u044F \u043F\u043E\u0437\u0438\u0446\u0438\u044F | \u041A\u0430\u0442\u0435\u0433\u043E\u0440\u0438\u044F.</p>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="cmpSite"></select></div>
		<div><label>\u041C\u0435\u0441\u044F\u0446 \u043E\u0442\u0447\u0451\u0442\u0430</label><select id="cmpMonth"></select></div>
		<div><label>\u0424\u0430\u0439\u043B xlsx</label><input type="file" id="cmpFile" accept=".xlsx,.xls"></div>
	</div>
	<div class="actions">
		<button class="primary" id="cmpUpload">\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0432 \u0431\u0430\u0437\u0443</button>
		<button class="danger" id="cmpDelete">\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043C\u0435\u0441\u044F\u0446</button>
	</div>
	<p class="muted" id="cmpHint"></p>
	<table><thead><tr><th>\u041C\u0435\u0441\u044F\u0446</th><th class="num">\u041A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432</th><th></th></tr></thead>
		<tbody id="cmpStats"></tbody></table>
</div>

<div class="card">
	<h2>\u041F\u0440\u043E\u043C\u0442\u044B \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0418\u0418</h2>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="prSite"></select></div>
		<div><label>\u0412\u0441\u0435\u0433\u043E \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u043E \u043F\u0440\u043E\u043C\u0442\u043E\u0432</label><input id="prTotal" placeholder="100"></div>
		<div style="flex:0 0 auto"><button class="primary" id="prSaveTotal">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0447\u0438\u0441\u043B\u043E</button></div>
	</div>
	<div style="margin-top:10px">
		<label>\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043F\u0440\u043E\u043C\u0442\u044B \u0441\u043F\u0438\u0441\u043A\u043E\u043C (\u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0432 \u0441\u0442\u0440\u043E\u043A\u0435)</label>
		<textarea id="prInput" placeholder="\u043A\u0443\u0440\u0441\u044B \u0434\u0438\u0437\u0430\u0439\u043D\u0430 \u0438\u043D\u0442\u0435\u0440\u044C\u0435\u0440\u0430"></textarea>
	</div>
	<div class="actions">
		<button class="primary" id="prAdd">\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u043F\u0440\u043E\u043C\u0442\u044B</button>
		<button class="danger" id="prClear">\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0432\u0441\u0435 \u043F\u0440\u043E\u043C\u0442\u044B</button>
	</div>
	<p class="muted" id="prHint"></p>
	<table><thead><tr><th style="width:48px" class="num">\u2116</th><th>\u041F\u0440\u043E\u043C\u0442</th><th></th></tr></thead>
		<tbody id="prRows"></tbody></table>
</div>

<div class="card">
	<h2>\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E\u0434 \u0442\u0430\u0431\u043B\u0438\u0446\u0430\u043C\u0438</h2>
	<p class="muted">\u0423 \u043A\u0430\u0436\u0434\u043E\u0433\u043E \u0431\u043B\u043E\u043A\u0430 \u0441\u0432\u043E\u044F \u043A\u043D\u043E\u043F\u043A\u0430. \u0418\u0418 \u0431\u0435\u0440\u0451\u0442 \u0446\u0438\u0444\u0440\u044B \u0438\u0437 \u0442\u0430\u0431\u043B\u0438\u0446\u044B \u043D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435, \u0442\u0435\u043A\u0441\u0442 \u043C\u043E\u0436\u043D\u043E \u043F\u043E\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C. \u041D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0442\u043E, \u0447\u0442\u043E \u0442\u0443\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E.</p>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="insSite"></select></div>
	</div>
	<p class="muted" id="insTop"></p>
	<div id="insBlocks"></div>
	<iframe id="insFrame" title="\u0441\u043A\u0440\u044B\u0442\u044B\u0439 \u0434\u0430\u0448\u0431\u043E\u0440\u0434" style="width:1px;height:1px;opacity:0;position:absolute;left:-9999px;border:0"></iframe>
</div>

<div class="card">
	<h2>\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B</h2>
	<p class="muted">\u0422\u0435\u043A\u0441\u0442 \u043F\u043E\u043A\u0430\u0436\u0435\u0442\u0441\u044F \u043D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435 \u043F\u0435\u0440\u0435\u0434 \u043F\u043B\u0430\u043D\u043E\u043C \u0440\u0430\u0431\u043E\u0442. \u041A\u0430\u0436\u0434\u0430\u044F \u0441\u0442\u0440\u043E\u043A\u0430 \u2014 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u043F\u0443\u043D\u043A\u0442 \u0441\u043F\u0438\u0441\u043A\u0430. \u0421\u0442\u0440\u043E\u043A\u0430 \u0431\u0435\u0437 \u0442\u043E\u0447\u043A\u0438 \u0432 \u043A\u043E\u043D\u0446\u0435 \u0438 \u043A\u043E\u0440\u043E\u0447\u0435 60 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432 \u0441\u0442\u0430\u043D\u0435\u0442 \u043F\u043E\u0434\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u043E\u043C.</p>
	<div class="row">
		<div><label>\u0421\u0430\u0439\u0442</label><select id="dwSite"></select></div>
		<div><label>\u041C\u0435\u0441\u044F\u0446</label><select id="dwMonth"></select></div>
	</div>
	<div style="margin-top:10px">
		<label>\u0427\u0442\u043E \u0441\u0434\u0435\u043B\u0430\u043D\u043E \u0437\u0430 \u043C\u0435\u0441\u044F\u0446</label>
		<textarea id="dwText" rows="10" placeholder="\u0421\u043E\u0431\u0440\u0430\u043B\u0438 \u0441\u0435\u043C\u0430\u043D\u0442\u0438\u043A\u0443&#10;\u041F\u0435\u0440\u0435\u043F\u0438\u0441\u0430\u043B\u0438 \u0442\u0435\u043A\u0441\u0442 \u043D\u0430 \u0433\u043B\u0430\u0432\u043D\u043E\u0439 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 \u0438 \u0434\u043E\u0431\u0430\u0432\u0438\u043B\u0438 \u0431\u043B\u043E\u043A \u0432\u043E\u043F\u0440\u043E\u0441-\u043E\u0442\u0432\u0435\u0442"></textarea>
	</div>
	<div class="actions">
		<button class="primary" id="dwSave">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>
		<button class="danger" id="dwClear">\u041E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u043C\u0435\u0441\u044F\u0446</button>
	</div>
	<p class="muted" id="dwHint"></p>
	<table><thead><tr><th>\u041C\u0435\u0441\u044F\u0446</th><th>\u041D\u0430\u0447\u0430\u043B\u043E \u0442\u0435\u043A\u0441\u0442\u0430</th></tr></thead>
		<tbody id="dwRows"></tbody></table>
</div>

<div class="card">
	<h2>\u0416\u0443\u0440\u043D\u0430\u043B \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0439</h2>
	<table><thead><tr><th>\u0412\u0440\u0435\u043C\u044F</th><th>\u0421\u0430\u0439\u0442</th><th>\u0421\u0442\u0430\u0442\u0443\u0441</th><th>\u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435</th></tr></thead>
		<tbody id="runs"></tbody></table>
</div>

</div>
</div>

<script>
var MONTHS_RU = ["\u044F\u043D\u0432\u0430\u0440\u044C","\u0444\u0435\u0432\u0440\u0430\u043B\u044C","\u043C\u0430\u0440\u0442","\u0430\u043F\u0440\u0435\u043B\u044C","\u043C\u0430\u0439","\u0438\u044E\u043D\u044C","\u0438\u044E\u043B\u044C",
	"\u0430\u0432\u0433\u0443\u0441\u0442","\u0441\u0435\u043D\u0442\u044F\u0431\u0440\u044C","\u043E\u043A\u0442\u044F\u0431\u0440\u044C","\u043D\u043E\u044F\u0431\u0440\u044C","\u0434\u0435\u043A\u0430\u0431\u0440\u044C"];
var sitesCache = [];
var editingId = null;

/* ---- \u041B\u0435\u0432\u043E\u0435 \u043C\u0435\u043D\u044E \u0430\u0434\u043C\u0438\u043D\u043A\u0438 ---- */
var NAV = [
	["\u0421\u0430\u0439\u0442\u044B", [
		["sites", "\u0421\u0430\u0439\u0442\u044B \u0438 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435", ["\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0441\u0430\u0439\u0442", "\u0421\u0430\u0439\u0442\u044B"]]
	]],
	["\u0414\u0430\u043D\u043D\u044B\u0435 \u0434\u043B\u044F \u0442\u0430\u0431\u043B\u0438\u0446", [
		["pos", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432", ["\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0438\u0437 Excel"]],
		["pages", "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B", ["\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0434\u043B\u044F \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430"]],
		["top", "\u0417\u0430\u043F\u0440\u043E\u0441\u044B \u0432 \u0422\u041E\u041F", ["\u0417\u0430\u043F\u0440\u043E\u0441\u044B \u0432 \u0422\u041E\u041F \u2014 \u0432\u0432\u043E\u0434 \u0432\u0440\u0443\u0447\u043D\u0443\u044E"]],
		["aiv", "\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0432 \u0418\u0418", ["\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418"]],
		["comp", "\u041A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u044B", ["\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432"]],
		["prompts", "\u041F\u0440\u043E\u043C\u0442\u044B", ["\u041F\u0440\u043E\u043C\u0442\u044B \u0434\u043B\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0418\u0418"]]
	]],
	["\u0422\u0435\u043A\u0441\u0442\u044B \u0434\u043B\u044F \u0437\u0430\u043A\u0430\u0437\u0447\u0438\u043A\u0430", [
		["ins", "\u0412\u044B\u0432\u043E\u0434\u044B \u0438 \u043F\u043B\u0430\u043D", ["\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E\u0434 \u0442\u0430\u0431\u043B\u0438\u0446\u0430\u043C\u0438"]],
		["done", "\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B", ["\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B"]]
	]],
	["\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438", [
		["engine", "\u0414\u0432\u0438\u0436\u043E\u043A \u0418\u0418", ["\u0414\u0432\u0438\u0436\u043E\u043A \u0418\u0418 \u0434\u043B\u044F \u0432\u044B\u0432\u043E\u0434\u043E\u0432"]],
		["runs", "\u0416\u0443\u0440\u043D\u0430\u043B \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0439", ["\u0416\u0443\u0440\u043D\u0430\u043B \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0439"]]
	]]
];
var navCur = "";

function navItem(sec) {
	for (var g = 0; g < NAV.length; g++) {
		for (var k = 0; k < NAV[g][1].length; k++) {
			if (NAV[g][1][k][0] === sec) return NAV[g][1][k];
		}
	}
	return null;
}

function navMark() {
	var cards = document.querySelectorAll("#pane > .card");
	for (var i = 0; i < cards.length; i++) {
		var h2 = cards[i].querySelector("h2");
		var t = h2 ? h2.textContent.replace(/\\s+/g, " ").trim() : "";
		var sec = "sites";
		for (var g = 0; g < NAV.length; g++) {
			for (var k = 0; k < NAV[g][1].length; k++) {
				if (NAV[g][1][k][2].indexOf(t) >= 0) sec = NAV[g][1][k][0];
			}
		}
		cards[i].setAttribute("data-sec", sec);
	}
}

function navRender() {
	var h = "";
	for (var g = 0; g < NAV.length; g++) {
		h += '<div class="grp">' + esc(NAV[g][0]) + "</div>";
		for (var k = 0; k < NAV[g][1].length; k++) {
			var it = NAV[g][1][k];
			h += '<button data-nav="' + it[0] + '">' + esc(it[1]) + "</button>";
		}
	}
	byId("side").innerHTML = h;
	byId("side").onclick = function (ev) {
		var t = ev.target;
		if (!t || !t.getAttribute) return;
		var sec = t.getAttribute("data-nav");
		if (sec) navGo(sec);
	};
}

function navGo(sec) {
	var it = navItem(sec);
	if (!it) { it = NAV[0][1][0]; sec = it[0]; }
	navCur = sec;
	var cards = document.querySelectorAll("#pane > .card");
	for (var i = 0; i < cards.length; i++) {
		cards[i].className = cards[i].getAttribute("data-sec") === sec ? "card" : "card hidden";
	}
	var btns = document.querySelectorAll("#side button");
	for (var j = 0; j < btns.length; j++) {
		btns[j].className = btns[j].getAttribute("data-nav") === sec ? "on" : "";
	}
	byId("secTitle").textContent = it[1];
	try { history.replaceState(null, "", "#" + sec); } catch (e) {}
	try { localStorage.setItem("adminSec", sec); } catch (e) {}
	window.scrollTo(0, 0);
}

function navBoot() {
	navMark();
	navRender();
	var want = "";
	try { want = (location.hash || "").replace("#", ""); } catch (e) { want = ""; }
	if (!want) { try { want = localStorage.getItem("adminSec") || ""; } catch (e) { want = ""; } }
	navGo(want || "sites");
}

try { navBoot(); } catch (e) { console.log("nav", e); }

function byId(id) { return document.getElementById(id); }
function esc(s) {
	return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
		.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }

async function api(path, body) {
	var opt = body ? {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	} : {};
	var r = await fetch(path, opt);
	if (r.status === 401) { location.href = "/login"; return null; }
	try { return await r.json(); } catch (e) { return null; }
}

function monthKeys(count) {
	var out = [];
	var d = new Date();
	d.setDate(1);
	for (var i = 1; i <= count; i++) {
		var x = new Date(d.getFullYear(), d.getMonth() - i, 1);
		out.push(x.getFullYear() + "-" + pad2(x.getMonth() + 1));
	}
	return out;
}
function monthLabel(key) {
	var p = String(key).split("-");
	return MONTHS_RU[Number(p[1]) - 1] + " " + p[0];
}

(function fillHours() {
	var h = byId("hour");
	var s = "";
	for (var i = 0; i < 24; i++) s += '<option value="' + i + '">' + pad2(i) + ":00</option>";
	h.innerHTML = s;
	h.value = "7";
})();

function fillSites(selId) {
	var sel = byId(selId);
	if (!sel) return;
	var keep = sel.value;
	var s = "";
	for (var i = 0; i < sitesCache.length; i++) {
		s += '<option value="' + sitesCache[i].id + '">' + esc(sitesCache[i].name) + "</option>";
	}
	sel.innerHTML = s;
	if (keep) sel.value = keep;
}

function intervalCell(s) {
	var opts = [[15, "\u043A\u0430\u0436\u0434\u044B\u0435 15 \u043C\u0438\u043D\u0443\u0442"], [60, "\u043A\u0430\u0436\u0434\u044B\u0439 \u0447\u0430\u0441"], [360, "\u043A\u0430\u0436\u0434\u044B\u0435 6 \u0447\u0430\u0441\u043E\u0432"], [1440, "\u0440\u0430\u0437 \u0432 \u0441\u0443\u0442\u043A\u0438"]];
	var h = '<select data-int="' + s.id + '" style="width:auto">';
	for (var i = 0; i < opts.length; i++) {
		var v = opts[i][0];
		h += '<option value="' + v + '"' + (Number(s.interval_min) === v ? " selected" : "") + ">" + opts[i][1] + "</option>";
	}
	return h + "</select>";
}

function render() {
	var s = "";
	for (var i = 0; i < sitesCache.length; i++) {
		var x = sitesCache[i];
		var link = x.slug ? '<a href="/s/' + x.slug + '" target="_blank">/s/' + x.slug + "</a>" : "\u2014";
		s += "<tr>" +
			"<td>" + esc(x.name) + "</td>" +
			'<td class="num">' + esc(x.counter_id) + "</td>" +
			"<td>" + (x.host_id ? esc(x.host_id) : '<span class="muted">\u043D\u0435\u0442</span>') + "</td>" +
			"<td>" + intervalCell(x) + "</td>" +
			"<td>" + link + ' <button data-slug="' + x.id + '" style="padding:4px 8px">\u043D\u043E\u0432\u0430\u044F</button></td>' +
			'<td><input type="checkbox" data-act="' + x.id + '"' + (x.active ? " checked" : "") + ' style="width:auto"></td>' +
			"<td>" +
				'<button data-edit="' + x.id + '" style="padding:4px 8px">\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C</button> ' +
				'<button data-run="' + x.id + '" style="padding:4px 8px">\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C</button> ' +
				'<button class="danger" data-del="' + x.id + '" style="padding:4px 8px">\u0423\u0434\u0430\u043B\u0438\u0442\u044C</button>' +
			"</td></tr>";
	}
	byId("rows").innerHTML = s || '<tr><td colspan="7" class="muted">\u0421\u0430\u0439\u0442\u043E\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

function findSite(id) {
	for (var i = 0; i < sitesCache.length; i++) {
		if (String(sitesCache[i].id) === String(id)) return sitesCache[i];
	}
	return null;
}

function startEdit(id) {
	var s = findSite(id);
	if (!s) return;
	editingId = s.id;
	byId("name").value = s.name || "";
	byId("counter").value = s.counter_id || "";
	byId("host").value = s.host_id || "";
	byId("token").value = s.token || DEFAULT_TOKEN;
	byId("interval").value = String(s.interval_min || 60);
	byId("hour").value = String(s.run_hour == null ? 7 : s.run_hour);
	byId("formTitle").textContent = "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0441\u0430\u0439\u0442: " + s.name;
	byId("submitBtn").textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C";
	byId("cancelBtn").className = "";
	byId("formHint").textContent = "\u0412 \u043F\u043E\u043B\u0435 \u0442\u043E\u043A\u0435\u043D\u0430 \u043F\u043E\u043A\u0430\u0437\u0430\u043D \u0442\u0435\u043A\u0443\u0449\u0438\u0439 \u0442\u043E\u043A\u0435\u043D \u044D\u0442\u043E\u0433\u043E \u0441\u0430\u0439\u0442\u0430. \u041E\u0447\u0438\u0441\u0442\u0438 \u043F\u043E\u043B\u0435, \u0435\u0441\u043B\u0438 \u043C\u0435\u043D\u044F\u0442\u044C \u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0434\u043E.";
	navGo("sites");
	byId("formCard").scrollIntoView({ behavior: "smooth" });
}

var DEFAULT_TOKEN = "y0__wgBEJG19VQYv6pIIL-D3egY42dAcGpfImvD0cO3yWkfA5mffvc";

function resetForm() {
	editingId = null;
	byId("name").value = "";
	byId("counter").value = "";
	byId("host").value = "";
	byId("token").value = DEFAULT_TOKEN;
	byId("interval").value = "60";
	byId("hour").value = "7";
	byId("formTitle").textContent = "\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0441\u0430\u0439\u0442";
	byId("submitBtn").textContent = "\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C";
	byId("cancelBtn").className = "hidden";
	byId("formHint").textContent = "";
}

byId("submitBtn").onclick = async function () {
	var body = {
		name: byId("name").value.trim(),
		counter_id: byId("counter").value.trim(),
		host_id: byId("host").value.trim(),
		token: byId("token").value.trim(),
		interval_min: Number(byId("interval").value),
		run_hour: Number(byId("hour").value)
	};
	if (!body.name || !body.counter_id) {
		byId("formHint").textContent = "\u0417\u0430\u043F\u043E\u043B\u043D\u0438 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0438 \u0441\u0447\u0451\u0442\u0447\u0438\u043A";
		return;
	}
	var res = null;
	byId("formHint").textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u2026";
	if (editingId) {
		body.id = editingId;
		res = await api("/api/sites/update", body);
	} else {
		if (!body.token) { byId("formHint").textContent = "\u041D\u0443\u0436\u0435\u043D \u0442\u043E\u043A\u0435\u043D"; return; }
		res = await api("/api/sites", body);
	}
	if (!res) {
		byId("formHint").textContent = "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B. \u041E\u0442\u043A\u0440\u043E\u0439 F12 \u2192 Console \u0438 \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438 \u043E\u0448\u0438\u0431\u043A\u0443.";
		return;
	}
	if (res.error) {
		byId("formHint").textContent = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: " + res.error;
		return;
	}
	resetForm();
	load();
};

byId("cancelBtn").onclick = resetForm;

byId("refreshAll").onclick = async function () {
	byId("refreshAll").textContent = "\u041E\u0431\u043D\u043E\u0432\u043B\u044F\u044E\u2026";
	await api("/api/refresh", {});
	byId("refreshAll").textContent = "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0441\u0435 \u0441\u0430\u0439\u0442\u044B \u0441\u0435\u0439\u0447\u0430\u0441";
	loadRuns();
};

byId("rows").onclick = async function (ev) {
	var t = ev.target;
	if (t.getAttribute("data-edit")) { startEdit(t.getAttribute("data-edit")); return; }
	if (t.getAttribute("data-run")) {
		t.textContent = "\u2026";
		await api("/api/refresh", { site_id: Number(t.getAttribute("data-run")) });
		t.textContent = "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C";
		loadRuns();
		return;
	}
	if (t.getAttribute("data-slug")) {
		await api("/api/sites/slug", { id: Number(t.getAttribute("data-slug")) });
		load();
		return;
	}
	if (t.getAttribute("data-del")) {
		if (!confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0441\u0430\u0439\u0442 \u0438 \u0432\u0441\u0435 \u0435\u0433\u043E \u0434\u0430\u043D\u043D\u044B\u0435?")) return;
		await api("/api/sites/delete", { id: Number(t.getAttribute("data-del")) });
		load();
		return;
	}
};

byId("rows").onchange = async function (ev) {
	var t = ev.target;
	if (t.getAttribute("data-act")) {
		await api("/api/sites/active", { id: Number(t.getAttribute("data-act")), active: t.checked ? 1 : 0 });
		return;
	}
	if (t.getAttribute("data-int")) {
		await api("/api/sites/update", { id: Number(t.getAttribute("data-int")), interval_min: Number(t.value) });
		load();
		return;
	}
};

/* ---- \u0417\u0430\u043F\u0440\u043E\u0441\u044B \u0432 \u0422\u041E\u041F \u0432\u0440\u0443\u0447\u043D\u0443\u044E ---- */
async function loadManualTable() {
	var site = byId("manualSite").value;
	if (!site) { byId("manualRows").innerHTML = ""; return; }
	var d = await api("/api/manual?site=" + encodeURIComponent(site));
	var data = (d && d.manual) || {};
	var keys = monthKeys(6);
	var s = "";
	for (var i = 0; i < keys.length; i++) {
		var k = keys[i];
		var v = data[k] || {};
		s += '<tr data-m="' + k + '"><td>' + monthLabel(k) + "</td>";
		var fields = ["y3", "y10", "g3", "g10"];
		for (var j = 0; j < fields.length; j++) {
			var f = fields[j];
			s += '<td class="num"><input data-f="' + f + '" value="' + (v[f] == null ? "" : v[f]) +
				'" style="width:80px;text-align:right"></td>';
		}
		s += '<td><button data-save="' + k + '" style="padding:4px 8px">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button></td></tr>';
	}
	byId("manualRows").innerHTML = s;
}

byId("manualRows").onclick = async function (ev) {
	var key = ev.target.getAttribute("data-save");
	if (!key) return;
	var tr = ev.target.closest("tr");
	var body = { site_id: Number(byId("manualSite").value), month: key };
	var inputs = tr.querySelectorAll("input[data-f]");
	for (var i = 0; i < inputs.length; i++) {
		var raw = inputs[i].value.trim();
		body[inputs[i].getAttribute("data-f")] = raw === "" ? null : Number(raw);
	}
	ev.target.textContent = "\u2026";
	await api("/api/manual", body);
	ev.target.textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E";
};

byId("manualSite").onchange = loadManualTable;

/* ---- \u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B ---- */
async function loadPagesList() {
	var site = byId("pagesSite").value;
	if (!site) { byId("pagesRows").innerHTML = ""; return; }
	var d = await api("/api/pages?site=" + encodeURIComponent(site));
	var list = (d && d.pages) || [];
	var s = "";
	for (var i = 0; i < list.length; i++) {
		var p = list[i];
		s += "<tr>" +
			'<td><input type="checkbox" data-pick="' + p.id + '" style="width:auto"></td>' +
			"<td>" + esc(p.url) + "</td>" +
			'<td><input data-cm="' + p.id + '" value="' + esc(p.comment || "") + '"></td>' +
			'<td><button class="danger" data-del="' + p.id + '" style="padding:4px 8px">\xD7</button></td>' +
			"</tr>";
	}
	byId("pagesRows").innerHTML = s || '<tr><td colspan="4" class="muted">\u0421\u0442\u0440\u0430\u043D\u0438\u0446 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
	byId("pagesHint").textContent = "\u0412\u0441\u0435\u0433\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446: " + list.length;
}

byId("pagesSite").onchange = loadPagesList;

byId("addPages").onclick = async function () {
	var raw = byId("pagesInput").value.split(/\\r?\\n/);
	var urls = [];
	for (var i = 0; i < raw.length; i++) {
		var t = raw[i].trim();
		if (t) urls.push(t);
	}
	if (!urls.length) return;
	byId("pagesHint").textContent = "\u0414\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u2026";
	await api("/api/pages/add", { site_id: Number(byId("pagesSite").value), urls: urls });
	byId("pagesInput").value = "";
	loadPagesList();
};

byId("importPages").onclick = async function () {
	byId("pagesHint").textContent = "\u0422\u044F\u043D\u0443 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u0438\u0437 \u041C\u0435\u0442\u0440\u0438\u043A\u0438\u2026";
	var d = await api("/api/pages/import", { site_id: Number(byId("pagesSite").value) });
	byId("pagesHint").textContent = d && d.added != null ? "\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E: " + d.added : "\u0413\u043E\u0442\u043E\u0432\u043E";
	loadPagesList();
};

byId("deletePages").onclick = async function () {
	var picks = byId("pagesRows").querySelectorAll("input[data-pick]:checked");
	var ids = [];
	for (var i = 0; i < picks.length; i++) ids.push(Number(picks[i].getAttribute("data-pick")));
	if (!ids.length) { byId("pagesHint").textContent = "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043E\u0442\u043C\u0435\u0447\u0435\u043D\u043E"; return; }
	await api("/api/pages/delete", { site_id: Number(byId("pagesSite").value), ids: ids });
	loadPagesList();
};

byId("pagesAll").onchange = function () {
	var boxes = byId("pagesRows").querySelectorAll("input[data-pick]");
	for (var i = 0; i < boxes.length; i++) boxes[i].checked = byId("pagesAll").checked;
};

byId("pagesRows").onclick = async function (ev) {
	var id = ev.target.getAttribute("data-del");
	if (!id) return;
	await api("/api/pages/delete", { site_id: Number(byId("pagesSite").value), ids: [Number(id)] });
	loadPagesList();
};

byId("pagesRows").onchange = async function (ev) {
	var id = ev.target.getAttribute("data-cm");
	if (!id) return;
	await api("/api/pages/comment", { id: Number(id), comment: ev.target.value });
	byId("pagesHint").textContent = "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D";
};

/* ---- \u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 ---- */
var posRows = [];

function cellText(v) {
	return v == null ? "" : String(v).trim();
}

function toPos(v) {
	var t = cellText(v).replace(",", ".");
	if (!t || t === "-" || t === "--" || t === "\u2014") return null;
	var n = parseFloat(t);
	return isFinite(n) ? n : null;
}

function pickCols(row) {
	var res = { q: -1, p: -1, u: -1 };
	for (var i = 0; i < row.length; i++) {
		var t = cellText(row[i]).toLowerCase();
		if (res.q < 0 && (t.indexOf("\u043A\u043B\u044E\u0447\u0435\u0432") >= 0 || t.indexOf("\u0444\u0440\u0430\u0437") >= 0 || t.indexOf("\u0437\u0430\u043F\u0440\u043E\u0441") >= 0)) res.q = i;
		else if (res.p < 0 && (t.indexOf("\u043F\u043E\u0437\u0438\u0446") >= 0 || t.indexOf("position") >= 0)) res.p = i;
		else if (res.u < 0 && (t.indexOf("\u0441\u0442\u0440\u0430\u043D\u0438\u0446") >= 0 || t.indexOf("url") >= 0 || t.indexOf("\u0430\u0434\u0440\u0435\u0441") >= 0 || t.indexOf("\u0440\u0435\u043B\u0435\u0432\u0430\u043D\u0442") >= 0)) res.u = i;
	}
	return res;
}

(function fillPosMonths() {
	var keys = monthKeys(14);
	var s = "";
	for (var i = 0; i < keys.length; i++) {
		s += '<option value="' + keys[i] + '">' + monthLabel(keys[i]) + "</option>";
	}
	byId("posMonth").innerHTML = s;
	byId("cmpMonth").innerHTML = s;
	byId("aiMonth").innerHTML = s;
})();

byId("posFile").onchange = async function () {
	var f = byId("posFile").files[0];
	posRows = [];
	if (!f) return;
	if (typeof XLSX === "undefined") {
		byId("posHint").textContent = "\u0411\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0430 \u0447\u0442\u0435\u043D\u0438\u044F xlsx \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430\u0441\u044C, \u043E\u0431\u043D\u043E\u0432\u0438 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443";
		return;
	}
	var wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array" });
	var ws = wb.Sheets[wb.SheetNames[0]];
	var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
	var head = -1, cols = null;
	for (var i = 0; i < Math.min(aoa.length, 15); i++) {
		var c = pickCols(aoa[i] || []);
		if (c.q >= 0 && c.p >= 0) { head = i; cols = c; break; }
	}
	if (head < 0) {
		byId("posHint").textContent = "\u041D\u0435 \u043D\u0430\u0448\u0451\u043B \u0441\u0442\u043E\u043B\u0431\u0446\u044B \xAB\u041A\u043B\u044E\u0447\u0435\u0432\u0430\u044F \u0444\u0440\u0430\u0437\u0430\xBB \u0438 \xAB\u041F\u043E\u0437\u0438\u0446\u0438\u0438\xBB";
		return;
	}
	for (var r = head + 1; r < aoa.length; r++) {
		var row = aoa[r] || [];
		var q = cellText(row[cols.q]);
		if (!q) continue;
		posRows.push({ query: q, position: toPos(row[cols.p]), url: cols.u >= 0 ? cellText(row[cols.u]) : "" });
	}
	byId("posHint").textContent = "\u0412 \u0444\u0430\u0439\u043B\u0435 \u0441\u0442\u0440\u043E\u043A: " + posRows.length;
};

byId("posUpload").onclick = async function () {
	if (!posRows.length) {
		byId("posHint").textContent = "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u044B\u0431\u0435\u0440\u0438 \u0444\u0430\u0439\u043B \u0438 \u043C\u0435\u0441\u044F\u0446 \u043E\u0442\u0447\u0451\u0442\u0430";
		return;
	}
	var body0 = {
		site_id: Number(byId("posSite").value),
		engine: byId("posEngine").value,
		month: byId("posMonth").value
	};
	var done = 0;
	for (var i = 0; i < posRows.length; i += 150) {
		var chunk = posRows.slice(i, i + 150);
		await api("/api/positions/upload", {
			site_id: body0.site_id,
			engine: body0.engine,
			month: body0.month,
			replace: i === 0 ? 1 : 0,
			rows: chunk
		});
		done += chunk.length;
		byId("posHint").textContent = "\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0441\u0442\u0440\u043E\u043A: " + done;
	}
	loadPosStats();
};

byId("posTemplate").onclick = function () {
	var wb = XLSX.utils.book_new();
	var ws = XLSX.utils.aoa_to_sheet([
		["\u041A\u043B\u044E\u0447\u0435\u0432\u0430\u044F \u0444\u0440\u0430\u0437\u0430", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438", "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430"],
		["\u043A\u0443\u043F\u0438\u0442\u044C \u043E\u043A\u043D\u0430", 7, "/okna"],
		["\u043E\u043A\u043D\u0430 \u043F\u0432\u0445 \u0446\u0435\u043D\u0430", "--", "/okna/pvh"]
	]);
	XLSX.utils.book_append_sheet(wb, ws, "\u041F\u043E\u0437\u0438\u0446\u0438\u0438");
	XLSX.writeFile(wb, "shablon-pozicii.xlsx");
};

byId("posDelete").onclick = async function () {
	if (!confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u0437\u0430 \u044D\u0442\u043E\u0442 \u043C\u0435\u0441\u044F\u0446 \u0438 \u0441\u0438\u0441\u0442\u0435\u043C\u0443?")) return;
	await api("/api/positions/delete", {
		site_id: Number(byId("posSite").value),
		month: byId("posMonth").value,
		engine: byId("posEngine").value
	});
	loadPosStats();
};

async function loadPosStats() {
	var site = byId("posSite").value;
	if (!site) return;
	var d = await api("/api/positions/stats?site=" + encodeURIComponent(site));
	var list = (d && d.stats) || [];
	var s = "";
	for (var i = 0; i < list.length; i++) {
		var x = list[i];
		s += "<tr><td>" + monthLabel(x.month) + "</td><td>" +
			(x.engine === "google" ? "Google" : "\u042F\u043D\u0434\u0435\u043A\u0441") + '</td><td class="num">' + x.cnt + "</td><td></td></tr>";
	}
	byId("posStats").innerHTML = s || '<tr><td colspan="4" class="muted">\u041F\u043E\u0437\u0438\u0446\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

byId("posSite").onchange = loadPosStats;

/* ---- \u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418 ---- */
async function loadAiList() {
	var site = byId("aiSite").value;
	if (!site) return;
	var d = await api("/api/ai?site=" + encodeURIComponent(site));
	var list = (d && d.rows) || [];
	var s = "";
	for (var i = 0; i < list.length; i++) {
		var x = list[i];
		s += "<tr><td>" + monthLabel(x.month) + "</td><td>" + esc(x.platform) +
			'</td><td class="num">' + x.visibility + "</td>" +
			'<td><button class="danger" data-aidel="' + x.month + "|" + esc(x.platform) +
			'" style="padding:4px 8px">\xD7</button></td></tr>';
	}
	byId("aiRows").innerHTML = s || '<tr><td colspan="4" class="muted">\u0414\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

byId("aiSave").onclick = async function () {
	var v = byId("aiValue").value.trim().replace(",", ".");
	if (!v) { byId("aiHint").textContent = "\u0412\u0432\u0435\u0434\u0438 \u043F\u0440\u043E\u0446\u0435\u043D\u0442"; return; }
	await api("/api/ai/save", {
		site_id: Number(byId("aiSite").value),
		month: byId("aiMonth").value,
		platform: byId("aiPlatform").value,
		visibility: Number(v)
	});
	byId("aiValue").value = "";
	byId("aiHint").textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E";
	loadAiList();
};

byId("aiRows").onclick = async function (ev) {
	var key = ev.target.getAttribute("data-aidel");
	if (!key) return;
	var p = key.split("|");
	await api("/api/ai/delete", {
		site_id: Number(byId("aiSite").value),
		month: p[0],
		platform: p[1]
	});
	loadAiList();
};

byId("aiSite").onchange = loadAiList;

/* ---- \u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432 ---- */
var cmpRows = [];

function cmpNum(v) {
	if (v == null) return null;
	var t = String(v).replace(/\\s/g, "").replace("%", "").replace(",", ".");
	if (!t || t === "-" || t === "\u2014") return null;
	var n = parseFloat(t);
	return isFinite(n) ? n : null;
}

function cmpFindCols(row) {
	var res = { name: -1, dom: -1, q: -1, share: -1, pos: -1, cat: -1 };
	for (var i = 0; i < row.length; i++) {
		var t = cellText(row[i]).toLowerCase();
		if (res.name < 0 && t.indexOf("\u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442") >= 0) res.name = i;
		else if (res.dom < 0 && (t.indexOf("\u0441\u0430\u0439\u0442") >= 0 || t.indexOf("\u0434\u043E\u043C\u0435\u043D") >= 0)) res.dom = i;
		else if (res.q < 0 && t.indexOf("\u0437\u0430\u043F\u0440\u043E\u0441") >= 0) res.q = i;
		else if (res.share < 0 && t.indexOf("\u0434\u043E\u043B\u044F") >= 0) res.share = i;
		else if (res.pos < 0 && t.indexOf("\u043F\u043E\u0437\u0438\u0446") >= 0) res.pos = i;
		else if (res.cat < 0 && t.indexOf("\u043A\u0430\u0442\u0435\u0433\u043E\u0440") >= 0) res.cat = i;
	}
	return res;
}

byId("cmpFile").onchange = async function () {
	var f = byId("cmpFile").files[0];
	cmpRows = [];
	if (!f) return;
	if (typeof XLSX === "undefined") {
		byId("cmpHint").textContent = "\u0411\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0430 \u0447\u0442\u0435\u043D\u0438\u044F xlsx \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430\u0441\u044C, \u043E\u0431\u043D\u043E\u0432\u0438 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443";
		return;
	}
	var wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array" });
	var name = wb.SheetNames[0];
	for (var i = 0; i < wb.SheetNames.length; i++) {
		if (wb.SheetNames[i].toLowerCase().indexOf("\u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442") >= 0) { name = wb.SheetNames[i]; break; }
	}
	var aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
	var head = -1, cols = null;
	for (var r = 0; r < Math.min(aoa.length, 15); r++) {
		var c = cmpFindCols(aoa[r] || []);
		if (c.name >= 0 && c.share >= 0) { head = r; cols = c; break; }
	}
	if (head < 0) {
		byId("cmpHint").textContent = "\u041D\u0435 \u043D\u0430\u0448\u0451\u043B \u0441\u0442\u043E\u043B\u0431\u0446\u044B \xAB\u041A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\xBB \u0438 \xAB\u0414\u043E\u043B\u044F\xBB";
		return;
	}
	for (var r2 = head + 1; r2 < aoa.length; r2++) {
		var row = aoa[r2] || [];
		var nm = cellText(row[cols.name]);
		var low = nm.toLowerCase();
		if (!nm) break;
		if (low.indexOf("\u043F\u0440\u043E\u0435\u043A\u0442") === 0 || low.indexOf("\u043F\u0435\u0440\u0438\u043E\u0434") === 0 || low.indexOf("\u0442\u0430\u0431\u043B\u0438\u0446\u0430") === 0) break;
		var dom = cols.dom >= 0 ? cellText(row[cols.dom]) : "";
		cmpRows.push({
			name: nm,
			domain: dom,
			queries: cmpNum(cols.q >= 0 ? row[cols.q] : null),
			share: cmpNum(row[cols.share]),
			pos: cmpNum(cols.pos >= 0 ? row[cols.pos] : null),
			category: cols.cat >= 0 ? cellText(row[cols.cat]) : "",
			our: low.indexOf("\u043D\u0430\u0448") >= 0 ? 1 : 0
		});
	}
	byId("cmpHint").textContent = "\u0412 \u0444\u0430\u0439\u043B\u0435 \u0441\u0442\u0440\u043E\u043A: " + cmpRows.length;
};

byId("cmpUpload").onclick = async function () {
	if (!cmpRows.length) {
		byId("cmpHint").textContent = "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u044B\u0431\u0435\u0440\u0438 \u0444\u0430\u0439\u043B \u0438 \u043C\u0435\u0441\u044F\u0446 \u043E\u0442\u0447\u0451\u0442\u0430";
		return;
	}
	var d = await api("/api/competitors/upload", {
		site_id: Number(byId("cmpSite").value),
		month: byId("cmpMonth").value,
		rows: cmpRows
	});
	byId("cmpHint").textContent = "\u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E \u0441\u0442\u0440\u043E\u043A: " + ((d && d.saved) || 0);
	loadCmpStats();
};

byId("cmpDelete").onclick = async function () {
	if (!confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432 \u0437\u0430 \u044D\u0442\u043E\u0442 \u043C\u0435\u0441\u044F\u0446?")) return;
	await api("/api/competitors/delete", {
		site_id: Number(byId("cmpSite").value),
		month: byId("cmpMonth").value
	});
	loadCmpStats();
};

async function loadCmpStats() {
	var site = byId("cmpSite").value;
	if (!site) return;
	var d = await api("/api/competitors/stats?site=" + encodeURIComponent(site));
	var list = (d && d.stats) || [];
	var s = "";
	for (var i = 0; i < list.length; i++) {
		s += "<tr><td>" + monthLabel(list[i].month) + '</td><td class="num">' + list[i].cnt +
			'</td><td><button class="danger" data-cmpdel="' + list[i].month +
			'" style="padding:4px 8px">\xD7</button></td></tr>';
	}
	byId("cmpStats").innerHTML = s || '<tr><td colspan="3" class="muted">\u0414\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

byId("cmpStats").onclick = async function (ev) {
	var m = ev.target.getAttribute("data-cmpdel");
	if (!m) return;
	await api("/api/competitors/delete", { site_id: Number(byId("cmpSite").value), month: m });
	loadCmpStats();
};

byId("cmpSite").onchange = loadCmpStats;

/* ---- \u041F\u0440\u043E\u043C\u0442\u044B ---- */
async function loadPromptsList() {
	var site = byId("prSite").value;
	if (!site) return;
	var d = await api("/api/prompts?site=" + encodeURIComponent(site));
	var list = (d && d.items) || [];
	byId("prTotal").value = d && d.total != null ? d.total : "";
	var s = "";
	for (var i = 0; i < list.length; i++) {
		s += '<tr><td class="num">' + (i + 1) + "</td><td>" + esc(list[i].text) +
			'</td><td><button class="danger" data-prdel="' + list[i].id +
			'" style="padding:4px 8px">\xD7</button></td></tr>';
	}
	byId("prRows").innerHTML = s || '<tr><td colspan="3" class="muted">\u041F\u0440\u043E\u043C\u0442\u043E\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
	byId("prHint").textContent = "\u041F\u0440\u043E\u043C\u0442\u043E\u0432 \u0432 \u0441\u043F\u0438\u0441\u043A\u0435: " + list.length;
}

byId("prSaveTotal").onclick = async function () {
	var v = byId("prTotal").value.trim();
	await api("/api/prompts/total", {
		site_id: Number(byId("prSite").value),
		total: v === "" ? null : Number(v)
	});
	byId("prHint").textContent = "\u0427\u0438\u0441\u043B\u043E \u043F\u0440\u043E\u043C\u0442\u043E\u0432 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E";
};

byId("prAdd").onclick = async function () {
	var raw = byId("prInput").value.split(/\\r?\\n/);
	var list = [];
	for (var i = 0; i < raw.length; i++) {
		var t = raw[i].trim();
		if (t) list.push(t);
	}
	if (!list.length) { byId("prHint").textContent = "\u041F\u0443\u0441\u0442\u043E"; return; }
	byId("prHint").textContent = "\u0414\u043E\u0431\u0430\u0432\u043B\u044F\u044E\u2026";
	var d = await api("/api/prompts/add", { site_id: Number(byId("prSite").value), list: list });
	byId("prInput").value = "";
	byId("prHint").textContent = "\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E: " + ((d && d.added) || 0);
	loadPromptsList();
};

byId("prClear").onclick = async function () {
	if (!confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0432\u0441\u0435 \u043F\u0440\u043E\u043C\u0442\u044B \u044D\u0442\u043E\u0433\u043E \u0441\u0430\u0439\u0442\u0430?")) return;
	await api("/api/prompts/delete", { site_id: Number(byId("prSite").value), all: 1 });
	loadPromptsList();
};

byId("prRows").onclick = async function (ev) {
	var id = ev.target.getAttribute("data-prdel");
	if (!id) return;
	await api("/api/prompts/delete", { site_id: Number(byId("prSite").value), ids: [Number(id)] });
	loadPromptsList();
};

byId("prSite").onchange = loadPromptsList;

/* ---- \u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B ---- */
var dwCache = {};

(function fillDwMonths() {
	var keys = monthKeys(12);
	var s = "";
	for (var i = 0; i < keys.length; i++) {
		s += '<option value="' + keys[i] + '">' + monthLabel(keys[i]) + "</option>";
	}
	byId("dwMonth").innerHTML = s;
})();

function dwFill() {
	var m = byId("dwMonth").value;
	byId("dwText").value = dwCache[m] || "";
}

async function loadDoneWorks() {
	var site = byId("dwSite").value;
	if (!site) return;
	var d = await api("/api/done?site=" + encodeURIComponent(site));
	dwCache = (d && d.items) || {};
	dwFill();
	var keys = [];
	for (var k in dwCache) keys.push(k);
	keys.sort();
	keys.reverse();
	var s = "";
	for (var i = 0; i < keys.length; i++) {
		var t = String(dwCache[keys[i]]).replace(/\\s+/g, " ").slice(0, 90);
		s += "<tr><td>" + esc(monthLabel(keys[i])) + "</td><td>" + esc(t) + "</td></tr>";
	}
	byId("dwRows").innerHTML = s || '<tr><td colspan="2" class="muted">\u0417\u0430\u043F\u0438\u0441\u0435\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

byId("dwSave").onclick = async function () {
	byId("dwHint").textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u2026";
	var res = await api("/api/done", {
		site_id: Number(byId("dwSite").value),
		month: byId("dwMonth").value,
		text: byId("dwText").value
	});
	if (!res) { byId("dwHint").textContent = "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B"; return; }
	if (res.error) { byId("dwHint").textContent = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: " + res.error; return; }
	byId("dwHint").textContent = res.cleared
		? "\u0422\u0435\u043A\u0441\u0442 \u0437\u0430 \u044D\u0442\u043E\u0442 \u043C\u0435\u0441\u044F\u0446 \u0443\u0434\u0430\u043B\u0451\u043D"
		: "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u2014 \u043E\u0431\u043D\u043E\u0432\u0438 \u0434\u0430\u0448\u0431\u043E\u0440\u0434, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C";
	loadDoneWorks();
};

byId("dwClear").onclick = async function () {
	if (!confirm("\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0442\u0435\u043A\u0441\u0442 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0445 \u0440\u0430\u0431\u043E\u0442 \u0437\u0430 \u044D\u0442\u043E\u0442 \u043C\u0435\u0441\u044F\u0446?")) return;
	byId("dwText").value = "";
	byId("dwSave").onclick();
};

byId("dwSite").onchange = loadDoneWorks;
byId("dwMonth").onchange = dwFill;

/* ---- \u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E\u0434 \u0442\u0430\u0431\u043B\u0438\u0446\u0430\u043C\u0438 ---- */
var INS_BLOCKS = [
	["seo", "seoRows", "seoHead", "\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0442\u0440\u0430\u0444\u0438\u043A \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C"],
	["ai", "aiRows", "aiHead", "\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418"],
	["comp", "compRows", "compHead", "\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432"],
	["pages", "pageRows", "pagesHead", "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B: \u0432\u0438\u0437\u0438\u0442\u044B \u0438 \u043A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438"],
	["ypos", "yPosRows", "yPosHead", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435 \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C"],
	["gpos", "gPosRows", "gPosHead", "\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 Google \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C"],
	["plan", "", "", "\u041F\u043B\u0430\u043D \u0440\u0430\u0431\u043E\u0442 \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043C\u0435\u0441\u044F\u0446"]
];

function insBlockTitle(key) {
	for (var i = 0; i < INS_BLOCKS.length; i++) {
		if (INS_BLOCKS[i][0] === key) return INS_BLOCKS[i];
	}
	return null;
}

(function insAdminInit() {
	var host = byId("insBlocks");
	if (!host) return;
	var s = "";
	for (var i = 0; i < INS_BLOCKS.length; i++) {
		var b = INS_BLOCKS[i];
		var key = b[0];
		var note = key === "plan"
			? "\u0421\u043E\u0431\u0438\u0440\u0430\u0435\u0442\u0441\u044F \u043F\u043E \u0432\u0441\u0435\u043C \u0432\u044B\u0432\u043E\u0434\u0430\u043C \u0432\u044B\u0448\u0435 \u2014 \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u0434\u0435\u043B\u0430\u0439 \u0438\u0445, \u043F\u043E\u0442\u043E\u043C \u043F\u043B\u0430\u043D"
			: "\u041F\u043E\u043A\u0430\u0436\u0435\u0442\u0441\u044F \u043D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435 \u043F\u043E\u0434 \u044D\u0442\u043E\u0439 \u0442\u0430\u0431\u043B\u0438\u0446\u0435\u0439";
		s += '<div style="border-top:1px solid #24304a;margin-top:14px;padding-top:12px">' +
			'<div style="font-size:14px;color:#6aa9ff;margin-bottom:2px">' + esc(b[3]) + "</div>" +
			'<p class="muted" style="margin:0 0 6px">' + note + "</p>" +
			'<textarea id="insTa_' + key + '" rows="' + (key === "plan" ? 14 : 7) + '"></textarea>' +
			'<div class="actions">' +
			'<button data-insgen="' + key + '">\u0421\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0432\u044B\u0432\u043E\u0434</button> ' +
			'<button class="primary" data-inssave="' + key + '">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button> ' +
			'<span class="muted" id="insHint_' + key + '"></span>' +
			"</div></div>";
	}
	host.innerHTML = s;
	host.onclick = function (e) {
		var t = e.target;
		if (!t || !t.getAttribute) return;
		var g = t.getAttribute("data-insgen");
		if (g) { insGenerate(g, t); return; }
		var sv = t.getAttribute("data-inssave");
		if (sv) { insSaveText(sv, t); return; }
	};
})();

function insToText(key, v) {
	if (!v) return "";
	if (key === "plan") return String(v);
	var parts = String(v).split("\u2016");
	var out = [];
	var a = parts[0].split("\u2022");
	for (var i = 0; i < a.length; i++) {
		var t = a[i].trim();
		if (t) out.push(t);
	}
	if (parts.length > 1) {
		var add = [];
		var b = parts[1].split("\u2022");
		for (var j = 0; j < b.length; j++) {
			var q = b[j].trim();
			if (q) add.push(q);
		}
		if (add.length) {
			out.push("");
			out.push("\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435:");
			for (var k = 0; k < add.length; k++) out.push(add[k]);
		}
	}
	return out.join("\\n");
}

function insFromText(key, raw) {
	var s = String(raw || "").trim();
	if (!s) return "";
	if (key === "plan") return s;
	var lines = s.split(/\\r?\\n/);
	var a = [];
	var b = [];
	var mode = 0;
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].replace(/^[-*\\u2022\\s]+/, "").trim();
		if (!line) continue;
		var low = line.toLowerCase();
		if (low.indexOf("\u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435") === 0 || low.indexOf("\u0447\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C \u0434\u0430\u043B\u044C\u0448\u0435") === 0) {
			mode = 1;
			var rest = line.indexOf(":") >= 0 ? line.slice(line.indexOf(":") + 1).trim() : "";
			if (rest) b.push(rest);
			continue;
		}
		if (low.indexOf("\u0438\u0442\u043E\u0433:") === 0 || low.indexOf("\u0432\u044B\u0432\u043E\u0434:") === 0) {
			line = line.slice(line.indexOf(":") + 1).trim();
			if (!line) continue;
		}
		if (mode === 0) a.push(line);
		else b.push(line);
	}
	var out = a.join(" \u2022 ");
	if (b.length) out += " \u2016 " + b.join(" \u2022 ");
	return out;
}

function insRowTextAt(tr) {
	var cells = tr.querySelectorAll("th,td");
	var arr = [];
	for (var i = 0; i < cells.length; i++) {
		arr.push((cells[i].innerText || "").replace(/\\s+/g, " ").trim());
	}
	return arr.join(" | ").trim();
}

function insFactsFrom(doc, rowsId, headId) {
	var rows = doc.getElementById(rowsId);
	if (!rows) return "";
	var lines = [];
	var head = doc.getElementById(headId);
	if (head) {
		var hr = head.tagName === "TR" ? head : (head.querySelector("tr") || head);
		var h = insRowTextAt(hr);
		if (h) lines.push(h);
	}
	var trs = rows.children;
	for (var i = 0; i < trs.length && lines.length < 26; i++) {
		var tr = trs[i];
		if ((tr.className || "").indexOf("hidden") >= 0) continue;
		if (tr.getAttribute && tr.getAttribute("data-child")) continue;
		var t = insRowTextAt(tr);
		if (t && t.replace(/[|\\s\u2014\u2013-]/g, "") !== "") lines.push(t);
	}
	if (lines.length < 2) return "";
	return lines.join("\\n");
}

function insFrameDoc(siteId) {
	return new Promise(function (resolve) {
		var fr = byId("insFrame");
		if (!fr) { resolve(null); return; }
		var ready = null;
		try { ready = fr.contentDocument; } catch (e) { ready = null; }
		if (fr.getAttribute("data-site") === String(siteId) && ready && ready.getElementById("seoRows") && ready.getElementById("seoRows").children.length) {
			resolve(ready);
			return;
		}
		fr.setAttribute("data-site", String(siteId));
		fr.src = "/?site=" + encodeURIComponent(siteId);
		var tries = 0;
		var timer = setInterval(function () {
			tries++;
			var doc = null;
			try { doc = fr.contentDocument; } catch (e) { doc = null; }
			var rows = doc ? doc.getElementById("seoRows") : null;
			if (rows && rows.children.length) { clearInterval(timer); resolve(doc); return; }
			if (tries > 60) { clearInterval(timer); resolve(doc); }
		}, 500);
	});
}

async function insGenerate(key, btn) {
	var sel = byId("insSite");
	var hint = byId("insHint_" + key);
	var site = sel ? sel.value : "";
	if (!site) { if (hint) hint.textContent = "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u044B\u0431\u0435\u0440\u0438 \u0441\u0430\u0439\u0442"; return; }
	var old = btn.textContent;
	btn.disabled = true;
	btn.textContent = "\u0418\u0418 \u0434\u0443\u043C\u0430\u0435\u0442\u2026";
	if (hint) hint.textContent = "";
	try {
		var body = { site_id: Number(site), key: key };
		if (key !== "plan") {
			var blk = insBlockTitle(key);
			if (hint) hint.textContent = "\u0427\u0438\u0442\u0430\u044E \u0442\u0430\u0431\u043B\u0438\u0446\u0443 \u0441 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0430\u2026";
			var doc = await insFrameDoc(site);
			var table = doc ? insFactsFrom(doc, blk[1], blk[2]) : "";
			if (!table) {
				if (hint) hint.textContent = "\u0412 \u044D\u0442\u043E\u0439 \u0442\u0430\u0431\u043B\u0438\u0446\u0435 \u043D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445";
				return;
			}
			body.table = table;
			if (hint) hint.textContent = "\u0418\u0418 \u0434\u0443\u043C\u0430\u0435\u0442\u2026";
		}
		var res = await api("/api/insights/generate-one", body);
		if (!res) { if (hint) hint.textContent = "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B"; return; }
		if (res.error) { if (hint) hint.textContent = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: " + res.error; return; }
		var ta = byId("insTa_" + key);
		if (ta) ta.value = insToText(key, res.items ? res.items[key] : "");
		if (hint) hint.textContent = "\u0413\u043E\u0442\u043E\u0432\u043E \u0438 \u0443\u0436\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u2014 \u043C\u043E\u0436\u043D\u043E \u043F\u043E\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u0435\u043A\u0441\u0442 \u0438 \u043D\u0430\u0436\u0430\u0442\u044C \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C";
		insTopInfo(res);
	} catch (e) {
		if (hint) hint.textContent = "\u041E\u0448\u0438\u0431\u043A\u0430: " + (e && e.message ? e.message : e);
	} finally {
		btn.disabled = false;
		btn.textContent = old;
	}
}

async function insSaveText(key, btn) {
	var sel = byId("insSite");
	var hint = byId("insHint_" + key);
	var site = sel ? sel.value : "";
	if (!site) { if (hint) hint.textContent = "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0432\u044B\u0431\u0435\u0440\u0438 \u0441\u0430\u0439\u0442"; return; }
	var ta = byId("insTa_" + key);
	var old = btn.textContent;
	btn.disabled = true;
	btn.textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u2026";
	try {
		var res = await api("/api/insights/save", {
			site_id: Number(site),
			key: key,
			text: insFromText(key, ta ? ta.value : "")
		});
		if (!res) { if (hint) hint.textContent = "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B"; return; }
		if (res.error) { if (hint) hint.textContent = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: " + res.error; return; }
		var has = res.items && res.items[key];
		if (hint) hint.textContent = has ? "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E \u2014 \u043E\u0431\u043D\u043E\u0432\u0438 \u0434\u0430\u0448\u0431\u043E\u0440\u0434, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C" : "\u0422\u0435\u043A\u0441\u0442 \u0443\u0434\u0430\u043B\u0451\u043D \u2014 \u0431\u043B\u043E\u043A \u043D\u0430 \u0434\u0430\u0448\u0431\u043E\u0440\u0434\u0435 \u0431\u0443\u0434\u0435\u0442 \u043F\u0443\u0441\u0442\u044B\u043C";
		insTopInfo(res);
	} catch (e) {
		if (hint) hint.textContent = "\u041E\u0448\u0438\u0431\u043A\u0430: " + (e && e.message ? e.message : e);
	} finally {
		btn.disabled = false;
		btn.textContent = old;
	}
}

function insTopInfo(res) {
	var p = byId("insTop");
	if (!p) return;
	if (!res || !res.generated_at) { p.textContent = "\u0412\u044B\u0432\u043E\u0434\u043E\u0432 \u043F\u043E \u044D\u0442\u043E\u043C\u0443 \u0441\u0430\u0439\u0442\u0443 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442"; return; }
	var d = new Date(res.generated_at);
	p.textContent = "\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0435\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435: " + d.toLocaleString("ru-RU") + (res.model ? " \xB7 \u043C\u043E\u0434\u0435\u043B\u044C " + res.model : "");
}

async function loadInsAdmin() {
	var sel = byId("insSite");
	if (!sel) return;
	for (var i = 0; i < INS_BLOCKS.length; i++) {
		var ta = byId("insTa_" + INS_BLOCKS[i][0]);
		if (ta) ta.value = "";
		var hint = byId("insHint_" + INS_BLOCKS[i][0]);
		if (hint) hint.textContent = "";
	}
	var site = sel.value;
	if (!site) { insTopInfo(null); return; }
	var res = await api("/api/insights?site=" + encodeURIComponent(site));
	if (!res) { insTopInfo(null); return; }
	var items = res.items || {};
	for (var j = 0; j < INS_BLOCKS.length; j++) {
		var key = INS_BLOCKS[j][0];
		var box = byId("insTa_" + key);
		if (box) box.value = insToText(key, items[key] || "");
	}
	insTopInfo(res);
}

if (byId("insSite")) byId("insSite").onchange = loadInsAdmin;

/* ---- \u0414\u0432\u0438\u0436\u043E\u043A \u0418\u0418 ---- */
async function loadEngine() {
	var d = await api("/api/ai-engine");
	if (!d) return;
	byId("engProvider").value = d.provider || "workers";
	byId("engModel").value = d.model || "";
	byId("engBase").value = d.base_url || "";
	byId("engFree").value = d.model_free || "";
	byId("engToken").value = "";
	byId("engToken").placeholder = d.has_token
		? "\u043A\u043B\u044E\u0447 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D \u2014 \u043E\u0441\u0442\u0430\u0432\u044C \u043F\u0443\u0441\u0442\u044B\u043C"
		: "sk-aitunnel-...";
	byId("engHint").textContent = d.provider === "aitunnel"
		? "\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u044B\u0432\u043E\u0434\u044B \u043F\u0438\u0448\u0435\u0442 AITunnel, \u043C\u043E\u0434\u0435\u043B\u044C " + (d.model || "")
		: "\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u044B\u0432\u043E\u0434\u044B \u043F\u0438\u0448\u0435\u0442 \u0431\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u044B\u0439 Workers AI";
}

byId("engSave").onclick = async function () {
	byId("engHint").textContent = "\u0421\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u2026";
	var res = await api("/api/ai-engine", {
		provider: byId("engProvider").value,
		model: byId("engModel").value.trim(),
		base_url: byId("engBase").value.trim(),
		model_free: byId("engFree").value.trim(),
		token: byId("engToken").value.trim()
	});
	if (!res || res.error) {
		byId("engHint").textContent = "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: " + ((res && res.error) || "\u0441\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B");
		return;
	}
	await loadEngine();
	byId("engHint").textContent += " \xB7 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E";
};

byId("engTest").onclick = async function () {
	byId("engHint").textContent = "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u2026";
	var res = await api("/api/ai-engine/test", {});
	if (!res || res.error) {
		byId("engHint").textContent = "\u041E\u0448\u0438\u0431\u043A\u0430: " + ((res && res.error) || "\u0441\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B");
		return;
	}
	byId("engHint").textContent =
		"\u0421\u0432\u044F\u0437\u044C \u0435\u0441\u0442\u044C. \u041C\u043E\u0434\u0435\u043B\u044C: " + (res.model || "") + ". \u041E\u0442\u0432\u0435\u0442: " + (res.text || "");
};

/* ---- \u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0432\u0441\u0435\u0433\u043E ---- */
async function load() {
	var d = await api("/api/sites");
	sitesCache = (d && d.sites) || [];
	render();
	fillSites("manualSite");
	fillSites("pagesSite");
	fillSites("posSite");
	fillSites("aiSite");
	fillSites("cmpSite");
	fillSites("prSite");
	fillSites("dwSite");
	fillSites("insSite");
	loadManualTable();
	loadPagesList();
	loadPosStats();
	loadAiList();
	loadCmpStats();
	loadPromptsList();
	loadDoneWorks();
	loadInsAdmin();
	loadEngine();
	loadRuns();
}

async function loadRuns() {
	var d = await api("/api/runs");
	var list = (d && d.runs) || [];
	var s = "";
	for (var i = 0; i < list.length; i++) {
		var r = list[i];
		var icon = r.status === "ok" ? "\u2705" : r.status === "partial" ? "\u26A0\uFE0F" : "\u274C";
		s += "<tr><td>" + esc(r.started_at) + "</td><td>" + esc(r.site_name || r.site_id) +
			"</td><td>" + icon + " " + esc(r.status) + "</td><td>" + esc(r.message || "") + "</td></tr>";
	}
	byId("runs").innerHTML = s || '<tr><td colspan="4" class="muted">\u0416\u0443\u0440\u043D\u0430\u043B \u043F\u0443\u0441\u0442</td></tr>';
}

if (!navCur) { try { navBoot(); } catch (e) { console.log("nav2", e); } }
load();
<\/script>
</body></html>`;
var DASH_TEMPLATE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>\u0414\u0430\u0448\u0431\u043E\u0440\u0434</title><style>${CSS}
canvas { width: 100%; height: 300px; display: block; }
.legend span { display: inline-flex; align-items: center; gap: 6px; margin-right: 14px; font-size: 13px; }
.legend i { width: 12px; height: 3px; border-radius: 2px; display: inline-block; }
.up { color: #22c55e; }
.down { color: #ef4444; }
tr[data-child] td { color: #8b93a7; font-size: 13px; }
.toggle { cursor: pointer; color: #6aa9ff; }
</style></head>
<body>
<h1 id="title">\u0414\u0430\u0448\u0431\u043E\u0440\u0434</h1>
<p class="muted"><span id="updated"></span></p>

<div class="card">
	<div class="row">
		<div id="pickerBox"><label>\u0421\u0430\u0439\u0442</label><select id="picker"></select></div>
		<div style="flex:0 0 auto"><button id="reload">\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435</button></div>
	</div>
	<div id="periods" style="margin-top:14px"></div>
	<div class="row" style="margin-top:14px">
		<div><label>\u0421 \u0434\u0430\u0442\u044B</label><input type="date" id="from"></div>
		<div><label>\u041F\u043E \u0434\u0430\u0442\u0443</label><input type="date" id="to"></div>
		<div><label>\u0414\u0435\u0442\u0430\u043B\u0438\u0437\u0430\u0446\u0438\u044F</label>
			<select id="group">
				<option value="day">\u043F\u043E \u0434\u043D\u044F\u043C</option>
				<option value="week">\u043F\u043E \u043D\u0435\u0434\u0435\u043B\u044F\u043C</option>
				<option value="month">\u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C</option>
			</select>
		</div>
		<div style="flex:0 0 auto"><button id="apply">\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C</button></div>
	</div>
</div>

<div class="kpi" id="kpi"></div>

<div class="card">
	<h2 id="chartTitle">\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438</h2>
	<div class="legend" id="legend"></div>
	<canvas id="chart"></canvas>
</div>

<div class="card">
	<h2>\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0442\u0440\u0430\u0444\u0438\u043A \u043F\u043E \u043C\u0435\u0441\u044F\u0446\u0430\u043C</h2>
	<table>
		<thead><tr id="seoHead"></tr></thead>
		<tbody id="seoRows"></tbody>
	</table>
</div>

<div class="card">
	<h2>\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B</h2>
	<table>
		<thead><tr id="pagesHead"></tr></thead>
		<tbody id="pageRows"></tbody>
	</table>
</div>

<div class="card">
	<h2>\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435 \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C</h2>
	<table>
		<thead><tr id="yPosHead"></tr></thead>
		<tbody id="yPosRows"></tbody>
	</table>
</div>

<div class="card">
	<h2>\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0432 Google \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C</h2>
	<table>
		<thead><tr id="gPosHead"></tr></thead>
		<tbody id="gPosRows"></tbody>
	</table>
</div>

<div class="card hidden" id="aiCard">
	<h2>\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u0431\u0440\u0435\u043D\u0434\u0430 \u0432 \u0418\u0418</h2>
	<p class="muted" id="aiNote"></p>
	<table>
		<thead><tr id="aiHead"></tr></thead>
		<tbody id="aiRows"></tbody>
	</table>
</div>

<div class="card hidden" id="compCard">
	<h2>\u0414\u043E\u043B\u044F \u0443\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u0439 \u0441\u0440\u0435\u0434\u0438 \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u043E\u0432</h2>
	<p class="muted" id="compNote"></p>
	<table>
		<thead><tr id="compHead"></tr></thead>
		<tbody id="compRows"></tbody>
	</table>
</div>

<div class="card hidden" id="prCard">
	<h2>\u041F\u0440\u043E\u043C\u0442\u044B, \u043F\u043E \u043A\u043E\u0442\u043E\u0440\u044B\u043C \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u043B\u0438 \u0432\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C</h2>
	<p class="muted" id="prNote"></p>
	<table><thead><tr><th style="width:48px" class="num">\u2116</th><th>\u041F\u0440\u043E\u043C\u0442</th></tr></thead>
		<tbody id="prRows"></tbody></table>
	<div class="actions"><button id="prMore" class="hidden">\u0414\u0430\u043B\u0435\u0435</button></div>
</div>

<div class="card hidden" id="doneCard">
	<h2>\u0412\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043D\u044B\u0435 \u0440\u0430\u0431\u043E\u0442\u044B</h2>
	<p class="muted" id="doneNote"></p>
	<div id="doneBody"></div>
</div>

<div class="card hidden" id="planCard">
	<h2>\u041F\u043B\u0430\u043D \u0440\u0430\u0431\u043E\u0442 \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u043C\u0435\u0441\u044F\u0446</h2>
	<p class="muted" id="planNote"></p>
	<div id="planBody"></div>
</div>

<script>
var MODE = "__MODE__";
var SLUG = "__SLUG__";
var MCOUNT = 4;

var payload = null;
var sitesList = [];
var compare = true;
var group = "day";
var fromStr = "";
var toStr = "";
var lastLabels = [];
var lastSeries = [];

var MONTHS = ["\u044F\u043D\u0432\u0430\u0440\u044F","\u0444\u0435\u0432\u0440\u0430\u043B\u044F","\u043C\u0430\u0440\u0442\u0430","\u0430\u043F\u0440\u0435\u043B\u044F","\u043C\u0430\u044F","\u0438\u044E\u043D\u044F","\u0438\u044E\u043B\u044F",
	"\u0430\u0432\u0433\u0443\u0441\u0442\u0430","\u0441\u0435\u043D\u0442\u044F\u0431\u0440\u044F","\u043E\u043A\u0442\u044F\u0431\u0440\u044F","\u043D\u043E\u044F\u0431\u0440\u044F","\u0434\u0435\u043A\u0430\u0431\u0440\u044F"];

function esc(s) {
	return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
		.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function fmtDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function monthStart(off) { var d = new Date(); return new Date(d.getFullYear(), d.getMonth() - off, 1); }
function monthEnd(off) { var d = new Date(); return new Date(d.getFullYear(), d.getMonth() - off + 1, 0); }
function monthKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1); }
function monthLabel(d) { return MONTHS[d.getMonth()] + " " + d.getFullYear(); }

function lastMonths(n) {
	var out = [];
	for (var i = 1; i <= n; i++) {
		var s = monthStart(i);
		out.push({ start: fmtDate(s), end: fmtDate(monthEnd(i)), key: monthKey(s), label: monthLabel(s) });
	}
	return out;
}

function hasKeys(o) {
	if (!o) return false;
	for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true;
	return false;
}

var PRESETS = [
	{ id: "cmp", label: "\u041F\u0440\u043E\u0448\u043B\u044B\u0439 \u0438 \u043F\u043E\u0437\u0430\u043F\u0440\u043E\u0448\u043B\u044B\u0439 \u043C\u0435\u0441\u044F\u0446" },
	{ id: "7", label: "7 \u0434\u043D\u0435\u0439" },
	{ id: "30", label: "30 \u0434\u043D\u0435\u0439" },
	{ id: "90", label: "90 \u0434\u043D\u0435\u0439" },
	{ id: "180", label: "180 \u0434\u043D\u0435\u0439" }
];

function highlight(id) {
	var chips = document.querySelectorAll("#periods .chip");
	for (var i = 0; i < chips.length; i++) {
		var on = chips[i].getAttribute("data-p") === id;
		chips[i].className = on ? "chip on" : "chip";
	}
}

function setPreset(id) {
	if (id === "cmp") {
		compare = true;
		highlight("cmp");
		paint();
		return;
	}
	compare = false;
	var days = Number(id);
	var to = new Date();
	var from = new Date();
	from.setDate(from.getDate() - days + 1);
	fromStr = fmtDate(from);
	toStr = fmtDate(to);
	document.getElementById("from").value = fromStr;
	document.getElementById("to").value = toStr;
	group = days > 120 ? "month" : days > 40 ? "week" : "day";
	document.getElementById("group").value = group;
	highlight(id);
	paint();
}

(function buildChips() {
	var s = "";
	for (var i = 0; i < PRESETS.length; i++) {
		s += '<span class="chip" data-p="' + PRESETS[i].id + '">' + PRESETS[i].label + "</span> ";
	}
	document.getElementById("periods").innerHTML = s;
	document.getElementById("periods").onclick = function (ev) {
		var id = ev.target.getAttribute("data-p");
		if (id) setPreset(id);
	};
})();

function bucketOf(dateStr) {
	if (group === "day") return dateStr;
	var d = new Date(dateStr + "T00:00:00");
	if (group === "month") return monthKey(d);
	var day = (d.getDay() + 6) % 7;
	d.setDate(d.getDate() - day);
	return fmtDate(d);
}

function labelOf(bucket) {
	if (group === "month") {
		var p = bucket.split("-");
		return MONTHS[Number(p[1]) - 1] + " " + p[0];
	}
	var d = new Date(bucket + "T00:00:00");
	return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
}

function drawSeries(labels, series) {
	lastLabels = labels;
	lastSeries = series;
	var c = document.getElementById("chart");
	var ratio = window.devicePixelRatio || 1;
	var w = c.clientWidth;
	var h = 300;
	c.width = w * ratio;
	c.height = h * ratio;
	var g = c.getContext("2d");
	g.setTransform(ratio, 0, 0, ratio, 0, 0);
	g.clearRect(0, 0, w, h);

	var padL = 44, padR = 12, padT = 14, padB = 26;
	var max = 1;
	for (var i = 0; i < series.length; i++) {
		for (var j = 0; j < series[i].values.length; j++) {
			if (num(series[i].values[j]) > max) max = num(series[i].values[j]);
		}
	}
	max = Math.ceil(max * 1.15);

	g.strokeStyle = "#242833";
	g.fillStyle = "#8b93a7";
	g.font = "11px sans-serif";
	g.lineWidth = 1;
	for (var t = 0; t <= 4; t++) {
		var y = padT + ((h - padT - padB) * t) / 4;
		g.beginPath();
		g.moveTo(padL, y);
		g.lineTo(w - padR, y);
		g.stroke();
		g.fillText(String(Math.round(max - (max * t) / 4)), 6, y + 3);
	}

	var n = labels.length;
	if (!n) return;
	var stepX = n > 1 ? (w - padL - padR) / (n - 1) : 0;

	for (var s = 0; s < series.length; s++) {
		g.strokeStyle = series[s].color;
		g.lineWidth = 2;
		g.beginPath();
		for (var k = 0; k < series[s].values.length; k++) {
			var x = padL + stepX * k;
			var v = num(series[s].values[k]);
			var yy = padT + (h - padT - padB) * (1 - v / max);
			if (k === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
		}
		g.stroke();
	}

	g.fillStyle = "#8b93a7";
	var everyX = Math.ceil(n / 10);
	for (var q = 0; q < n; q += everyX) {
		g.fillText(labels[q], padL + stepX * q - 10, h - 8);
	}
}

function setLegend(items) {
	var s = "";
	for (var i = 0; i < items.length; i++) {
		s += '<span><i style="background:' + items[i].color + '"></i>' + esc(items[i].name) + "</span>";
	}
	document.getElementById("legend").innerHTML = s;
}

function isSearchSource(name) {
	var t = String(name || "").toLowerCase();
	return t.indexOf("organic") >= 0 || t.indexOf("\u043F\u043E\u0438\u0441\u043A") >= 0 || t.indexOf("search") >= 0;
}

function searchTotals(from, to) {
	var d = payload && payload.data ? payload.data : {};
	var res = { visits: 0, users: 0, yandex: 0, google: 0, conv: 0 };
	var sd = d.searchDaily || [];
	for (var i = 0; i < sd.length; i++) {
		var r = sd[i];
		var dt = String(r.date || "");
		if (dt < from || dt > to) continue;
		res.visits += num(r.visits);
		res.users += num(r.users);
		var eng = String(r.engine || r.searchEngine || "").toLowerCase();
		if (eng.indexOf("yandex") >= 0 || eng.indexOf("\u044F\u043D\u0434\u0435\u043A\u0441") >= 0) res.yandex += num(r.users);
		else if (eng.indexOf("google") >= 0) res.google += num(r.users);
	}
	if (!sd.length) {
		var src = d.sourcesDaily || [];
		for (var j = 0; j < src.length; j++) {
			var s2 = src[j];
			var dt2 = String(s2.date || "");
			if (dt2 < from || dt2 > to) continue;
			if (!isSearchSource(s2.source)) continue;
			res.visits += num(s2.visits);
			res.users += num(s2.users);
		}
	}
	var cd = d.searchConvDaily || [];
	for (var k = 0; k < cd.length; k++) {
		var c = cd[k];
		var dt3 = String(c.date || "");
		if (dt3 < from || dt3 > to) continue;
		res.conv += num(c.conv != null ? c.conv : c.goals);
	}
	return res;
}

function changeCell(a, b) {
	if (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0) {
		return '<td class="num">\u2014</td>';
	}
	var p = ((a - b) / b) * 100;
	var cls = p > 0 ? "up" : p < 0 ? "down" : "";
	var sign = p > 0 ? "\u25B2 +" : p < 0 ? "\u25BC " : "";
	return '<td class="num ' + cls + '">' + sign + p.toFixed(1) + "%</td>";
}

function renderSeoTable() {
	var months = lastMonths(MCOUNT);
	var live = [];
	var stats = [];
	for (var i = 0; i < months.length; i++) {
		var t = searchTotals(months[i].start, months[i].end);
		var man = (payload.manual && payload.manual[months[i].key]) || {};
		var empty = !t.visits && !t.users && !t.conv &&
			man.y3 == null && man.y10 == null && man.g3 == null && man.g10 == null;
		if (empty) continue;
		live.push(months[i]);
		stats.push({ t: t, man: man });
	}

	var head = "<th>\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u0435\u043B\u044C</th>";
	for (var h = 0; h < live.length; h++) head += '<th class="num">' + live[h].label + "</th>";
	if (live.length >= 2) head += '<th class="num">\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435</th>';
	document.getElementById("seoHead").innerHTML = head;

	var defs = [
		["\u0412\u0438\u0437\u0438\u0442\u044B \u0441 \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0445 \u0441\u0438\u0441\u0442\u0435\u043C", function (s) { return s.t.visits; }],
		["\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438 \u0441 \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0445 \u0441\u0438\u0441\u0442\u0435\u043C", function (s) { return s.t.users; }],
		["\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438 \u0441 \u042F\u043D\u0434\u0435\u043A\u0441\u0430", function (s) { return s.t.yandex; }],
		["\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438 \u0441 Google", function (s) { return s.t.google; }],
		["\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0432 \u0422\u041E\u041F-3 \u042F\u043D\u0434\u0435\u043A\u0441\u0430", function (s) { return s.man.y3; }],
		["\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0432 \u0422\u041E\u041F-10 \u042F\u043D\u0434\u0435\u043A\u0441\u0430", function (s) { return s.man.y10; }],
		["\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0432 \u0422\u041E\u041F-3 Google", function (s) { return s.man.g3; }],
		["\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432 \u0432 \u0422\u041E\u041F-10 Google", function (s) { return s.man.g10; }],
		["\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0439 \u0441 \u043F\u043E\u0438\u0441\u043A\u0430", function (s) { return s.t.conv; }]
	];

	var body = "";
	for (var r = 0; r < defs.length; r++) {
		body += "<tr><td>" + defs[r][0] + "</td>";
		var vals = [];
		for (var c = 0; c < stats.length; c++) {
			var v = defs[r][1](stats[c]);
			vals.push(v);
			body += '<td class="num fmt">' + (v == null || v === "" ? "\u2014" : v) + "</td>";
		}
		if (live.length >= 2) body += changeCell(vals[0], vals[1]);
		body += "</tr>";
	}
	document.getElementById("seoRows").innerHTML = body ||
		'<tr><td class="muted">\u0414\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442</td></tr>';
}

function aiCell(cur, prev) {
	if (cur == null) return '<td class="num">\u2014</td>';
	var v = Number(cur).toFixed(1);
	if (prev != null && Number(cur) > Number(prev)) {
		return '<td class="num up">\u25B2 ' + v + "%</td>";
	}
	return '<td class="num">' + v + "%</td>";
}

function renderAiTable() {
	var ai = (payload && payload.ai) || {};
	var card = document.getElementById("aiCard");
	if (!hasKeys(ai)) { card.className = "card hidden"; return; }
	card.className = "card";

	var months = lastMonths(MCOUNT);
	var live = [];
	for (var i = 0; i < months.length; i++) {
		if (ai[months[i].key] && hasKeys(ai[months[i].key])) live.push(months[i]);
	}
	if (!live.length) { card.className = "card hidden"; return; }

	var names = {};
	for (var m = 0; m < live.length; m++) {
		var block = ai[live[m].key];
		for (var p in block) if (Object.prototype.hasOwnProperty.call(block, p)) names[p] = 1;
	}
	var plats = Object.keys(names).sort();

	var head = "<th>\u041F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u0430</th>";
	for (var h = 0; h < live.length; h++) head += '<th class="num">' + live[h].label + "</th>";
	document.getElementById("aiHead").innerHTML = head;

	var body = "";
	for (var k = 0; k < plats.length; k++) {
		body += "<tr><td>" + esc(plats[k]) + "</td>";
		for (var c = 0; c < live.length; c++) {
			var cur = ai[live[c].key][plats[k]];
			var prev = c + 1 < live.length ? ai[live[c + 1].key][plats[k]] : null;
			body += aiCell(cur == null ? null : cur, prev == null ? null : prev);
		}
		body += "</tr>";
	}
	document.getElementById("aiRows").innerHTML = body;
	document.getElementById("aiNote").textContent =
		"\u0414\u0430\u043D\u043D\u044B\u0435 \u0432\u0432\u043E\u0434\u044F\u0442\u0441\u044F \u0432\u0440\u0443\u0447\u043D\u0443\u044E \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435. \u0417\u0435\u043B\u0451\u043D\u0430\u044F \u0441\u0442\u0440\u0435\u043B\u043A\u0430 \u2014 \u0440\u043E\u0441\u0442 \u043A \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u043C\u0443 \u043C\u0435\u0441\u044F\u0446\u0443.";
}

function shareCell(cur, prev) {
	if (cur == null) return '<td class="num">\u2014</td>';
	var v = Number(cur).toFixed(1);
	if (prev != null && Number(cur) > Number(prev)) {
		return '<td class="num up">\u25B2 ' + v + "%</td>";
	}
	return '<td class="num">' + v + "%</td>";
}

function renderCompTable() {
	var comp = (payload && payload.competitors) || {};
	var card = document.getElementById("compCard");
	if (!hasKeys(comp)) { card.className = "card hidden"; return; }

	var months = lastMonths(MCOUNT);
	var live = [];
	for (var i = 0; i < months.length; i++) {
		if (comp[months[i].key] && comp[months[i].key].length) live.push(months[i]);
	}
	if (!live.length) { card.className = "card hidden"; return; }
	card.className = "card";

	var byName = {};
	for (var m = 0; m < live.length; m++) {
		var list = comp[live[m].key];
		for (var j = 0; j < list.length; j++) {
			var row = list[j];
			var key = (row.d || row.n || "").toLowerCase();
			if (!byName[key]) {
				byName[key] = { name: row.n, domain: row.d, our: row.our ? 1 : 0, vals: {}, q: null, p: null };
			}
			byName[key].vals[live[m].key] = row.s;
			if (m === 0) {
				byName[key].q = row.q;
				byName[key].p = row.p;
			}
			if (row.our) byName[key].our = 1;
		}
	}

	var arr = [];
	for (var k in byName) if (Object.prototype.hasOwnProperty.call(byName, k)) arr.push(byName[k]);
	arr.sort(function (a, b) {
		if (a.our !== b.our) return b.our - a.our;
		return num(b.vals[live[0].key]) - num(a.vals[live[0].key]);
	});
	arr = arr.slice(0, 25);

	var head = "<th>\u041A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442</th>";
	for (var h = 0; h < live.length; h++) head += '<th class="num">\u0412\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C, ' + live[h].label + "</th>";
	head += '<th class="num">\u0417\u0430\u043F\u0440\u043E\u0441\u043E\u0432</th><th class="num">\u0421\u0440\u0435\u0434\u043D\u044F\u044F \u043F\u043E\u0437\u0438\u0446\u0438\u044F</th>';
	document.getElementById("compHead").innerHTML = head;

	var body = "";
	for (var r = 0; r < arr.length; r++) {
		var x = arr[r];
		var label = esc(x.domain || x.name);
		if (x.our) label = '<span style="color:#6aa9ff">' + label + " \u2014 \u043D\u0430\u0448 \u0431\u0440\u0435\u043D\u0434</span>";
		body += "<tr><td>" + label + "</td>";
		for (var c = 0; c < live.length; c++) {
			var cur = x.vals[live[c].key];
			var prev = c + 1 < live.length ? x.vals[live[c + 1].key] : null;
			body += shareCell(cur == null ? null : cur, prev == null ? null : prev);
		}
		body += '<td class="num fmt">' + (x.q == null ? "\u2014" : x.q) + "</td>";
		body += '<td class="num fmt">' + (x.p == null ? "\u2014" : Number(x.p).toFixed(1)) + "</td></tr>";
	}
	document.getElementById("compRows").innerHTML = body;
	var pt = (payload && payload.prompts && payload.prompts.total) || 0;
	document.getElementById("compNote").textContent = pt
		? "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u043B\u0438 " + pt + " \u043F\u0440\u043E\u043C\u0442\u043E\u0432"
		: "\u0427\u0438\u0441\u043B\u043E \u043F\u0440\u043E\u043C\u0442\u043E\u0432 \u043D\u0435 \u0437\u0430\u0434\u0430\u043D\u043E \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435";
}

function normUrl(u) {
	var t = String(u || "").trim().replace(/^https?:\\/\\//, "");
	var i = t.indexOf("/");
	var path = i < 0 ? "/" : t.slice(i);
	path = path.split("?")[0].split("#")[0];
	if (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
	return path || "/";
}

function pagesMap(key) {
	var d = payload && payload.data ? payload.data : {};
	var src = (d.pagesMonths && d.pagesMonths[key]) || [];
	var out = {};
	for (var i = 0; i < src.length; i++) {
		var p = src[i];
		var k = normUrl(p.url || p.page);
		if (!out[k]) out[k] = { visits: 0, conv: 0 };
		out[k].visits += num(p.visits);
		out[k].conv += num(p.conv != null ? p.conv : p.goals);
	}
	return out;
}

function renderPagesTable() {
	var list = (payload && payload.pages) || [];
	var months = lastMonths(MCOUNT);
	var maps = [];
	var live = [];
	for (var i = 0; i < months.length; i++) {
		var mp = pagesMap(months[i].key);
		if (!hasKeys(mp)) continue;
		live.push(months[i]);
		maps.push(mp);
	}

	var head = "<th>URL \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B</th>";
	for (var h = 0; h < live.length; h++) head += '<th class="num">' + live[h].label + "</th>";
	head += '<th class="num">\u041A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438</th><th>\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439</th>';
	document.getElementById("pagesHead").innerHTML = head;

	var body = "";
	for (var r = 0; r < list.length; r++) {
		var key = normUrl(list[r].url);
		body += "<tr><td>" + esc(list[r].url) + "</td>";
		for (var c = 0; c < live.length; c++) {
			var cell = maps[c][key];
			body += '<td class="num fmt">' + (cell ? cell.visits : "\u2014") + "</td>";
		}
		var first = live.length ? maps[0][key] : null;
		body += '<td class="num fmt">' + (first ? first.conv : "\u2014") + "</td>";
		body += "<td>" + esc(list[r].comment || "") + "</td></tr>";
	}
	document.getElementById("pageRows").innerHTML = body ||
		'<tr><td class="muted">\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u044B \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435</td></tr>';
}

function avgOf(listVals) {
	var sum = 0;
	var n = 0;
	for (var i = 0; i < listVals.length; i++) {
		if (listVals[i] != null && isFinite(listVals[i])) {
			sum += Number(listVals[i]);
			n++;
		}
	}
	if (!n) return null;
	return Math.floor(sum / n);
}

function posIndex(engine, key) {
	var pos = (payload && payload.positions) || {};
	var list = pos[key] || [];
	var out = {};
	for (var i = 0; i < list.length; i++) {
		var r = list[i];
		if (r.e !== engine) continue;
        if (r.p == null || r.p >= 20) continue;
		var u = normUrl(r.u || "/");
		if (!out[u]) out[u] = [];
		out[u].push({ q: r.q, p: r.p });
	}
	return out;
}

function changePos(a, b) {
	if (a == null || b == null) return '<td class="num">\u2014</td>';
	var diff = b - a;
	if (diff === 0) return '<td class="num">0</td>';
	var cls = diff > 0 ? "up" : "down";
	var sign = diff > 0 ? "\u25B2 +" : "\u25BC ";
	return '<td class="num ' + cls + '">' + sign + Math.abs(diff) + "</td>";
}

function posCell(v) {
	return '<td class="num fmt">' + (v == null ? "\u2014" : v) + "</td>";
}

function renderPosTable(engine, rowsId, headId) {
	var months = lastMonths(MCOUNT);
	var live = [];
	var idx = [];
	for (var i = 0; i < months.length; i++) {
		var m = posIndex(engine, months[i].key);
		if (!hasKeys(m)) continue;
		live.push(months[i]);
		idx.push(m);
	}

	var head = "<th>URL \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B</th><th class=\\"num\\">\u0417\u0430\u043F\u0440\u043E\u0441\u044B</th>";
	for (var h = 0; h < live.length; h++) head += '<th class="num">' + live[h].label + "</th>";
	if (live.length >= 2) head += '<th class="num">\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435</th>';
	document.getElementById(headId).innerHTML = head;

	if (!live.length) {
		document.getElementById(rowsId).innerHTML =
			'<tr><td class="muted">\u041F\u043E\u0437\u0438\u0446\u0438\u0438 \u0435\u0449\u0451 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u044B</td></tr>';
		return;
	}

	var urls = {};
	for (var a = 0; a < idx.length; a++) {
		for (var u in idx[a]) if (Object.prototype.hasOwnProperty.call(idx[a], u)) urls[u] = 1;
	}
	var keys = Object.keys(urls).sort();

	var body = "";
	for (var r = 0; r < keys.length; r++) {
		var u2 = keys[r];
		var meds = [];
		var qcount = 0;
		var queries = {};
		for (var c = 0; c < idx.length; c++) {
			var rows = idx[c][u2] || [];
			var vals = [];
			for (var j = 0; j < rows.length; j++) {
				vals.push(rows[j].p);
				if (!queries[rows[j].q]) queries[rows[j].q] = {};
				queries[rows[j].q][live[c].key] = rows[j].p;
			}
			if (rows.length > qcount) qcount = rows.length;
			meds.push(avgOf(vals));
		}
		var rid = engine + "_" + r;
		body += '<tr><td><span class="toggle" data-grp="' + rid + '">' + esc(u2) +
			'</span></td><td class="num fmt">' + qcount + "</td>";
		for (var c2 = 0; c2 < meds.length; c2++) body += posCell(meds[c2]);
		if (live.length >= 2) body += changePos(meds[0], meds[1]);
		body += "</tr>";

		var qkeys = Object.keys(queries).sort();
		for (var q = 0; q < qkeys.length; q++) {
			body += '<tr data-child="' + rid + '"><td>' + esc(qkeys[q]) +
				'</td><td class="num"></td>';
			var qv = [];
			for (var c3 = 0; c3 < live.length; c3++) {
				var val = queries[qkeys[q]][live[c3].key];
				qv.push(val == null ? null : val);
				body += posCell(val == null ? null : val);
			}
			if (live.length >= 2) body += changePos(qv[0], qv[1]);
			body += "</tr>";
		}
	}
	document.getElementById(rowsId).innerHTML = body;
	bindPosToggle(rowsId);
}

function bindPosToggle(rowsId) {
	document.getElementById(rowsId).onclick = function (ev) {
		var grp = ev.target.getAttribute("data-grp");
		if (!grp) return;
		var kids = document.querySelectorAll('[data-child="' + grp + '"]');
		for (var i = 0; i < kids.length; i++) {
			kids[i].className = kids[i].className.indexOf("hidden") >= 0 ? "" : "hidden";
		}
	};
}

function kpiBox(name, value, extra) {
	return '<div class="box"><span class="muted">' + name + "</span><b>" + value + "</b>" +
		(extra ? '<span class="muted">' + extra + "</span>" : "") + "</div>";
}

function paintCompare() {
	var months = lastMonths(2);
	var d = payload && payload.data ? payload.data : {};
	var daily = d.daily || [];
	var series = [];
	var labels = [];
	var colors = ["#6aa9ff", "#f59e0b"];

	for (var m = 0; m < months.length; m++) {
		var vals = [];
		for (var day = 1; day <= 31; day++) {
			var dt = months[m].key + "-" + pad2(day);
			if (dt > months[m].end) break;
			var found = 0;
			for (var i = 0; i < daily.length; i++) {
				if (String(daily[i].date) === dt) { found = num(daily[i].users); break; }
			}
			vals.push(found);
			if (m === 0) labels.push(String(day));
		}
		series.push({ name: months[m].label, color: colors[m], values: vals });
	}
	while (series.length > 1 && series[1].values.length > labels.length) {
		labels.push(String(labels.length + 1));
	}

	document.getElementById("chartTitle").textContent = "\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438: " +
		months[0].label + " \u0438 " + months[1].label;
	setLegend(series);
	drawSeries(labels, series);

	var a = searchTotals(months[0].start, months[0].end);
	var b = searchTotals(months[1].start, months[1].end);
	document.getElementById("kpi").innerHTML =
		kpiBox("\u0412\u0438\u0437\u0438\u0442\u044B \u0441 \u043F\u043E\u0438\u0441\u043A\u0430, " + months[0].label, a.visits, "\u0431\u044B\u043B\u043E " + b.visits) +
		kpiBox("\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438 \u0441 \u043F\u043E\u0438\u0441\u043A\u0430", a.users, "\u0431\u044B\u043B\u043E " + b.users) +
		kpiBox("\u0421 \u042F\u043D\u0434\u0435\u043A\u0441\u0430", a.yandex, "\u0431\u044B\u043B\u043E " + b.yandex) +
		kpiBox("\u0421 Google", a.google, "\u0431\u044B\u043B\u043E " + b.google) +
		kpiBox("\u041A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438 \u0441 \u043F\u043E\u0438\u0441\u043A\u0430", a.conv, "\u0431\u044B\u043B\u043E " + b.conv);

	renderSeoTable();
	renderAiTable();
	renderCompTable();
	renderPrompts();
	renderPagesTable();
	renderPosTable("yandex", "yPosRows", "yPosHead");
	renderPosTable("google", "gPosRows", "gPosHead");
}

function paintPeriod() {
	var d = payload && payload.data ? payload.data : {};
	var daily = d.daily || [];
	var buckets = {};
	var order = [];
	for (var i = 0; i < daily.length; i++) {
		var dt = String(daily[i].date);
		if (fromStr && dt < fromStr) continue;
		if (toStr && dt > toStr) continue;
		var b = bucketOf(dt);
		if (!buckets[b]) { buckets[b] = { visits: 0, users: 0 }; order.push(b); }
		buckets[b].visits += num(daily[i].visits);
		buckets[b].users += num(daily[i].users);
	}
	order.sort();
	var labels = [];
	var vVisits = [];
	var vUsers = [];
	for (var j = 0; j < order.length; j++) {
		labels.push(labelOf(order[j]));
		vVisits.push(buckets[order[j]].visits);
		vUsers.push(buckets[order[j]].users);
	}
	var series = [
		{ name: "\u0412\u0438\u0437\u0438\u0442\u044B", color: "#6aa9ff", values: vVisits },
		{ name: "\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438", color: "#f59e0b", values: vUsers }
	];
	document.getElementById("chartTitle").textContent = "\u0412\u0438\u0437\u0438\u0442\u044B \u0438 \u043F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438";
	setLegend(series);
	drawSeries(labels, series);

	var t = searchTotals(fromStr, toStr);
	var totalV = 0, totalU = 0;
	for (var k = 0; k < vVisits.length; k++) { totalV += vVisits[k]; totalU += vUsers[k]; }
	document.getElementById("kpi").innerHTML =
		kpiBox("\u0412\u0438\u0437\u0438\u0442\u044B, \u0432\u0441\u0435\u0433\u043E", totalV) +
		kpiBox("\u041F\u043E\u0441\u0435\u0442\u0438\u0442\u0435\u043B\u0438, \u0432\u0441\u0435\u0433\u043E", totalU) +
		kpiBox("\u0412\u0438\u0437\u0438\u0442\u044B \u0441 \u043F\u043E\u0438\u0441\u043A\u0430", t.visits) +
		kpiBox("\u041A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438 \u0441 \u043F\u043E\u0438\u0441\u043A\u0430", t.conv);

	renderSeoTable();
	renderAiTable();
	renderCompTable();
	renderPrompts();
	renderPagesTable();
	renderPosTable("yandex", "yPosRows", "yPosHead");
	renderPosTable("google", "gPosRows", "gPosHead");
}

function paint() {
	if (!payload) return;
	if (compare) paintCompare(); else paintPeriod();
}

async function loadData(siteId) {
	var u = MODE === "client"
		? "/api/public/data?slug=" + encodeURIComponent(SLUG)
		: "/api/data" + (siteId ? "?site=" + encodeURIComponent(siteId) : "");
	var r = await fetch(u);
	if (r.status === 401) { location.href = "/login"; return; }
	var d = await r.json();
	payload = {
		site: d.site || {},
		data: d.data || {},
		manual: d.manual || {},
		pages: d.pages || [],
		positions: d.positions || {},
		ai: d.ai || {},
		competitors: d.competitors || {},
		prompts: d.prompts || {},
		done: d.done || {}
	};
	document.getElementById("title").textContent = "\u0414\u0430\u0448\u0431\u043E\u0440\u0434 \xB7 " + (payload.site.name || "");
	var upd = payload.data && payload.data.updated_at ? payload.data.updated_at : "";
	document.getElementById("updated").textContent = upd ? "\u0414\u0430\u043D\u043D\u044B\u0435 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u044B: " + upd : "\u0414\u0430\u043D\u043D\u044B\u0445 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442";
	paint();
}

async function boot() {
	if (MODE === "client") {
		document.getElementById("pickerBox").className = "hidden";
		document.getElementById("reload").className = "hidden";
	} else {
		var r = await fetch("/api/sites");
		if (r.status === 401) { location.href = "/login"; return; }
		var d = await r.json();
		sitesList = d.sites || [];
		var s = "";
		for (var i = 0; i < sitesList.length; i++) {
			s += '<option value="' + sitesList[i].id + '">' + esc(sitesList[i].name) + "</option>";
		}
		document.getElementById("picker").innerHTML = s;
		document.getElementById("picker").onchange = function () {
			loadData(document.getElementById("picker").value);
		};
		document.getElementById("reload").onclick = async function () {
			document.getElementById("reload").textContent = "\u041E\u0431\u043D\u043E\u0432\u043B\u044F\u044E\u2026";
			await fetch("/api/refresh", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ site_id: Number(document.getElementById("picker").value) })
			});
			document.getElementById("reload").textContent = "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0434\u0430\u043D\u043D\u044B\u0435";
			loadData(document.getElementById("picker").value);
		};
	}

	document.getElementById("apply").onclick = function () {
		compare = false;
		fromStr = document.getElementById("from").value;
		toStr = document.getElementById("to").value;
		group = document.getElementById("group").value;
		highlight("");
		paint();
	};
	window.onresize = function () {
		if (lastLabels.length) drawSeries(lastLabels, lastSeries);
	};

	highlight("cmp");
	var qsSite = "";
	try { qsSite = new URLSearchParams(location.search).get("site") || ""; } catch (e) { qsSite = ""; }
	var first = MODE === "client" ? "" : (qsSite || (sitesList[0] ? sitesList[0].id : ""));
	if (MODE !== "client" && qsSite) {
		var pk = document.getElementById("picker");
		if (pk) pk.value = qsSite;
	}
	await loadData(first);
}

boot();

/* ============ \u041F\u0440\u043E\u043C\u0442\u044B ============ */
var prOpen = false;

function renderPrompts() {
	var card = document.getElementById("prCard");
	if (!card) return;
	var list = (payload && payload.prompts && payload.prompts.list) || [];
	if (!list.length) { card.className = "card hidden"; return; }
	card.className = "card";
	var total = (payload.prompts && payload.prompts.total) || list.length;
	var note = document.getElementById("prNote");
	if (note) note.textContent = "\u041F\u0440\u043E\u0432\u0435\u0440\u0438\u043B\u0438 " + total + " \u043F\u0440\u043E\u043C\u0442\u043E\u0432, \u0432 \u0441\u043F\u0438\u0441\u043A\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E " + list.length;
	var limit = prOpen ? list.length : 10;
	var s = "";
	for (var i = 0; i < list.length; i++) {
		s += "<tr" + (i >= limit ? ' class="hidden"' : "") + '><td class="num">' +
			(i + 1) + "</td><td>" + esc(list[i]) + "</td></tr>";
	}
	document.getElementById("prRows").innerHTML = s;
	var btn = document.getElementById("prMore");
	if (list.length > 10) {
		btn.className = "";
		btn.textContent = prOpen ? "\u0421\u0432\u0435\u0440\u043D\u0443\u0442\u044C" : "\u0414\u0430\u043B\u0435\u0435 (\u0435\u0449\u0451 " + (list.length - 10) + ")";
	} else {
		btn.className = "hidden";
	}
}

(function bindPrMore() {
	var btn = document.getElementById("prMore");
	if (!btn) return;
	btn.onclick = function () { prOpen = !prOpen; renderPrompts(); };
})();

/* ============ \u0412\u044B\u0432\u043E\u0434\u044B \u0418\u0418 \u043F\u043E\u0434 \u0442\u0430\u0431\u043B\u0438\u0446\u0430\u043C\u0438 ============ */
var INS_MAP = [
	["seo", "seoRows", "seoHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u043F\u043E\u0438\u0441\u043A\u043E\u0432\u043E\u043C\u0443 \u0442\u0440\u0430\u0444\u0438\u043A\u0443"],
	["ai", "aiRows", "aiHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u0432\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u0432 \u0418\u0418"],
	["comp", "compRows", "compHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u043A\u043E\u043D\u043A\u0443\u0440\u0435\u043D\u0442\u0430\u043C"],
	["pages", "pageRows", "pagesHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430\u043C"],
	["ypos", "yPosRows", "yPosHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u043F\u043E\u0437\u0438\u0446\u0438\u044F\u043C \u0432 \u042F\u043D\u0434\u0435\u043A\u0441\u0435"],
	["gpos", "gPosRows", "gPosHead", "\u0412\u044B\u0432\u043E\u0434\u044B \u043F\u043E \u043F\u043E\u0437\u0438\u0446\u0438\u044F\u043C \u0432 Google"]
];
var insData = null;
var insBusy = false;
var insKey = "";

(function insStyle() {
	var st = document.createElement("style");
	st.textContent = ".ins{margin-top:14px;padding:12px 14px;border-left:3px solid #6aa9ff;background:rgba(106,169,255,.08);border-radius:8px;font-size:14px;line-height:1.6}.ins h4{margin:0 0 6px;font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:#6aa9ff}.ins p{margin:5px 0}.ins .muted{color:#8b93a7}.ins h5{margin:12px 0 4px;font-size:12px;letter-spacing:.4px;text-transform:uppercase;color:#22c55e}#planCard h5,#doneCard h5{margin:16px 0 6px;font-size:14px;color:#6aa9ff;text-transform:none;letter-spacing:0}#doneCard h5:first-child{margin-top:4px}#planCard p.lead{margin:6px 0 12px;line-height:1.7;color:#c9d1e0}#planCard p.lead+h5{margin-top:6px}#planCard p.task,#doneCard p.task{margin:4px 0;padding-left:16px;position:relative;line-height:1.6}#planCard p.task:before,#doneCard p.task:before{content:'\u2022';position:absolute;left:2px;color:#22c55e}#insBtn{margin-left:8px}";
	document.head.appendChild(st);
})();

function insSiteId() {
	var p = document.getElementById("picker");
	if (p && p.value) return p.value;
	return payload && payload.site ? payload.site.id : "";
}

function insBox(key, rowsId, title) {
	var box = document.getElementById("ins_" + key);
	if (box) return box;
	var rows = document.getElementById(rowsId);
	if (!rows) return null;
	var tbl = rows.closest ? rows.closest("table") : null;
	var anchor = tbl || rows;
	box = document.createElement("div");
	box.id = "ins_" + key;
	box.className = "ins hidden";
	box.innerHTML = '<h4></h4><div class="body"></div>';
	box.querySelector("h4").textContent = title;
	anchor.parentNode.insertBefore(box, anchor.nextSibling);
	return box;
}

function insPart(v) {
	var parts = String(v || "").split("\u2022");
	var out = "";
	for (var i = 0; i < parts.length; i++) {
		var t = parts[i].replace(/^[\\s\\-\u2013\u2014]+/, "").trim();
		if (t) out += "<p>" + esc(t) + "</p>";
	}
	return out;
}

function insHtml(v) {
	var whole = String(v || "").split("\u2016");
	var out = insPart(whole[0]);
	if (whole.length > 1 && whole[1].trim()) {
		out += "<h5>\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0435\u043C \u0434\u0430\u043B\u044C\u0448\u0435</h5>" + insPart(whole[1]);
	}
	return out;
}

function insRowText(tr) {
	var cells = tr.querySelectorAll("th,td");
	var arr = [];
	for (var i = 0; i < cells.length; i++) {
		arr.push((cells[i].innerText || "").replace(/\\s+/g, " ").trim());
	}
	return arr.join(" | ").trim();
}

function insFacts(rowsId, headId) {
	var rows = document.getElementById(rowsId);
	if (!rows) return "";
	var lines = [];
	var head = document.getElementById(headId);
	if (head) {
		var hr = head.tagName === "TR" ? head : head.querySelector("tr") || head;
		var h = insRowText(hr);
		if (h) lines.push(h);
	}
	var trs = rows.children;
	for (var i = 0; i < trs.length && lines.length < 26; i++) {
		var tr = trs[i];
		var cls = tr.className || "";
		if (cls.indexOf("hidden") >= 0) continue;
		if (tr.getAttribute && tr.getAttribute("data-child")) continue;
		var t = insRowText(tr);
		if (t && t.replace(/[|\\s\u2014\u2013-]/g, "") !== "") lines.push(t);
	}
	if (lines.length < 2) return "";
	return lines.join("\\n");
}

var PLAN_MONTHS = ["\u044F\u043D\u0432\u0430\u0440\u044C","\u0444\u0435\u0432\u0440\u0430\u043B\u044C","\u043C\u0430\u0440\u0442","\u0430\u043F\u0440\u0435\u043B\u044C","\u043C\u0430\u0439","\u0438\u044E\u043D\u044C","\u0438\u044E\u043B\u044C",
	"\u0430\u0432\u0433\u0443\u0441\u0442","\u0441\u0435\u043D\u0442\u044F\u0431\u0440\u044C","\u043E\u043A\u0442\u044F\u0431\u0440\u044C","\u043D\u043E\u044F\u0431\u0440\u044C","\u0434\u0435\u043A\u0430\u0431\u0440\u044C"];

function planNextMonth() {
	var d = new Date();
	var m = d.getMonth() + 1;
	var y = d.getFullYear();
	if (m > 11) { m = 0; y = y + 1; }
	return PLAN_MONTHS[m] + " " + y;
}

function planHtml(v) {
	var lines = String(v || "").split("\\n");
	var out = "";
	for (var i = 0; i < lines.length; i++) {
		var t = lines[i].trim();
		if (!t) continue;
		if (t.indexOf("~ ") === 0) {
			out += '<p class="lead">' + esc(t.slice(2)) + "</p>";
		} else if (t.indexOf("# ") === 0) {
			out += "<h5>" + esc(t.slice(2)) + "</h5>";
		} else {
			if (t.charAt(0) === "-") t = t.slice(1).trim();
			if (t) out += '<p class="task">' + esc(t) + "</p>";
		}
	}
	return out;
}

function doneHtml(v) {
	var lines = String(v || "").split(/\\r?\\n/);
	var out = "";
	for (var i = 0; i < lines.length; i++) {
		var t = lines[i].replace(/^[-*\\u2022\\s]+/, "").trim();
		if (!t) continue;
		if (t.length < 60 && t.slice(-1) !== "." && t.indexOf(" \u2014 ") < 0) {
			out += "<h5>" + esc(t) + "</h5>";
		} else {
			out += '<p class="task">' + esc(t) + "</p>";
		}
	}
	return out;
}

function renderDone() {
	var card = document.getElementById("doneCard");
	if (!card) return;
	var map = (payload && payload.done) || {};
	var keys = [];
	for (var k in map) { if (map[k]) keys.push(k); }
	if (!keys.length) { card.className = "card hidden"; return; }
	keys.sort();
	var key = keys[keys.length - 1];
	var p = String(key).split("-");
	var label = MONTHS[Number(p[1]) - 1] + " " + p[0];
	card.className = "card";
	var note = document.getElementById("doneNote");
	if (note) note.textContent = "\u0417\u0430 " + label;
	document.getElementById("doneBody").innerHTML = doneHtml(map[key]);
}

function renderPlan() {
	var card = document.getElementById("planCard");
	if (!card) return;
	var txt = insData && insData.items ? insData.items.plan : "";
	if (!txt) { card.className = "card hidden"; return; }
	card.className = "card";
	var note = document.getElementById("planNote");
	if (note) note.textContent = "\u0421\u043E\u0431\u0440\u0430\u043D \u043F\u043E \u0432\u044B\u0432\u043E\u0434\u0430\u043C \u0432\u044B\u0448\u0435 \xB7 " + planNextMonth();
	document.getElementById("planBody").innerHTML = planHtml(txt);
}

function renderInsights() {
	for (var i = 0; i < INS_MAP.length; i++) {
		var key = INS_MAP[i][0];
		var box = insBox(key, INS_MAP[i][1], INS_MAP[i][3]);
		if (!box) continue;
		var rows = document.getElementById(INS_MAP[i][1]);
		var hasRows = rows && rows.children.length > 0;
		var txt = insData && insData.items ? insData.items[key] : "";
		if (!hasRows) { box.className = "ins hidden"; continue; }
		if (!txt) {
			box.className = "ins";
			box.className = MODE === "client" ? "ins hidden" : "ins";
			box.querySelector(".body").innerHTML = '<p class="muted">\u0412\u044B\u0432\u043E\u0434 \u043F\u043E\u043A\u0430 \u043D\u0435 \u0441\u0434\u0435\u043B\u0430\u043D \u2014 \u0441\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u0443\u0439 \u0435\u0433\u043E \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435.</p>';
			continue;
		}
		box.className = "ins";
		box.querySelector(".body").innerHTML = insHtml(txt);
	}
	renderPlan();
}

function insWait() {
	for (var i = 0; i < INS_MAP.length; i++) {
		var box = document.getElementById("ins_" + INS_MAP[i][0]);
		if (box && box.className.indexOf("hidden") < 0) {
			box.querySelector(".body").innerHTML = '<p class="muted">\u0418\u0418 \u0447\u0438\u0442\u0430\u0435\u0442 \u0446\u0438\u0444\u0440\u044B\u2026</p>';
		}
	}
}

async function insFetch() {
	var u = MODE === "client"
		? "/api/public/insights?slug=" + encodeURIComponent(SLUG)
		: "/api/insights?site=" + encodeURIComponent(insSiteId());
	try {
		var r = await fetch(u);
		var j = await r.json();
		return j && j.items ? j : { generated_at: null, items: {} };
	} catch (e) {
		return { generated_at: null, items: {} };
	}
}

function insFresh() {
	if (!insData || !insData.generated_at) return false;
	return Date.now() - new Date(insData.generated_at).getTime() < 20 * 3600 * 1000;
}

async function insSync(force) {
	if (insBusy) return;
	var sid = String(insSiteId() || SLUG);
	if (sid !== insKey) { insKey = sid; insData = null; }
	insBusy = true;
	try {
		if (!insData) {
			insData = await insFetch();
			renderInsights();
		}
		return; /* \u0442\u0435\u043A\u0441\u0442\u044B \u0432\u044B\u0432\u043E\u0434\u043E\u0432 \u0442\u0435\u043F\u0435\u0440\u044C \u0433\u043E\u0442\u043E\u0432\u044F\u0442\u0441\u044F \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435 */
		var facts = {};
		var any = false;
		for (var i = 0; i < INS_MAP.length; i++) {
			var f = insFacts(INS_MAP[i][1], INS_MAP[i][2]);
			facts[INS_MAP[i][0]] = f;
			if (f) any = true;
		}
		if (!any) return;
		insWait();
		var r = await fetch("/api/insights/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ site_id: Number(insSiteId()), facts: facts })
		});
		var j = await r.json();
		if (j && j.error) {
			insData = insData || { items: {} };
			renderInsights();
			var b0 = document.getElementById("ins_seo");
			if (b0) b0.querySelector(".body").innerHTML = '<p class="muted">\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C: ' + esc(j.error) + "</p>";
			return;
		}
		insData = j;
		renderInsights();
	} catch (e) {
	} finally {
		insBusy = false;
	}
}

(function insButton() {
	if (MODE === "client") return;
	var host = document.getElementById("reload");
	if (!host || !host.parentNode) return;
	var b = document.createElement("button");
	b.id = "insBtn";
	b.textContent = "\u0412\u044B\u0432\u043E\u0434\u044B \u0432 \u0430\u0434\u043C\u0438\u043D\u043A\u0435";
	b.onclick = function () { window.open("/admin", "_blank"); };
	host.parentNode.insertBefore(b, host.nextSibling);
})();

var insOldPaint = paint;
paint = function () {
	insOldPaint.apply(null, arguments);
	renderDone();
	renderInsights();
	setTimeout(function () { insSync(false); }, 400);
};
<\/script>
</body></html>`;
function dashPage(mode, slug) {
  return DASH_TEMPLATE.replace(/__MODE__/g, mode).replace(/__SLUG__/g, slug || "");
}
__name(dashPage, "dashPage");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith("/s/")) {
      const slug = path.slice(3).replace(/\/+$/, "");
      const site = await env.DB.prepare(
        "SELECT id FROM sites WHERE slug = ? AND active = 1"
      ).bind(slug).first();
      if (!site) return html("<h1>\u0414\u0430\u0448\u0431\u043E\u0440\u0434 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D</h1>", 404);
      return html(dashPage("client", slug));
    }
    if (path === "/api/public/data" && request.method === "GET") {
      const slug = url.searchParams.get("slug") || "";
      const site = await env.DB.prepare(
        "SELECT id, name FROM sites WHERE slug = ? AND active = 1"
      ).bind(slug).first();
      if (!site) return json({ error: "not found" }, 404);
      return json(await dashData(env, site));
    }
    if (path === "/api/public/insights" && request.method === "GET") {
      const slug = url.searchParams.get("slug") || "";
      const site = await env.DB.prepare(
        "SELECT id FROM sites WHERE slug = ? AND active = 1"
      ).bind(slug).first();
      if (!site) return json({ error: "not found" }, 404);
      return json(await loadInsights(env, site.id));
    }
    if (path === "/login") return html(LOGIN_PAGE);
    if (path === "/api/login" && request.method === "POST") {
      const body = await request.json();
      if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
        return json({ error: "bad password" }, 401);
      }
      const token = await makeSession(env);
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": cookieHeader(token)
        }
      });
    }
    if (path === "/api/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          location: "/login",
          "set-cookie": COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
        }
      });
    }
    const logged = await isLoggedIn(request, env);
    if (path === "/" || path === "/admin") {
      if (!logged) return Response.redirect(new URL("/login", request.url).toString(), 302);
      await ensureSlugs(env);
      if (path === "/admin") return html(ADMIN_PAGE);
      return html(dashPage("owner", ""));
    }
    if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!logged) return json({ error: "auth" }, 401);
    if (path === "/api/sites" && request.method === "GET") {
      await ensureSlugs(env);
      const rows = await env.DB.prepare(
        "SELECT id, name, counter_id, host_id, token, active, interval_min, run_hour, last_run_at, slug FROM sites ORDER BY name"
      ).all();
      return json({ sites: rows.results || [] });
    }
    if (path === "/api/sites" && request.method === "POST") {
      const b = await request.json();
      try {
        await env.DB.prepare(
          "INSERT INTO sites (name, counter_id, host_id, token, active, created_at, interval_min, run_hour, slug) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)"
        ).bind(
          b.name,
          String(b.counter_id),
          b.host_id || "",
          b.token,
          (/* @__PURE__ */ new Date()).toISOString(),
          Number(b.interval_min || 60),
          b.run_hour == null ? null : Number(b.run_hour),
          newSlug()
        ).run();
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
      return json({ ok: true });
    }
    if (path === "/api/sites/update" && request.method === "POST") {
      const b = await request.json();
      const id = Number(b.id);
      if (b.name != null) {
        await env.DB.prepare("UPDATE sites SET name = ? WHERE id = ?").bind(b.name, id).run();
      }
      if (b.counter_id != null && b.counter_id !== "") {
        await env.DB.prepare("UPDATE sites SET counter_id = ? WHERE id = ?").bind(String(b.counter_id), id).run();
      }
      if (b.host_id != null) {
        await env.DB.prepare("UPDATE sites SET host_id = ? WHERE id = ?").bind(b.host_id || "", id).run();
      }
      if (b.token) {
        await env.DB.prepare("UPDATE sites SET token = ? WHERE id = ?").bind(b.token, id).run();
      }
      if (b.interval_min != null) {
        await env.DB.prepare("UPDATE sites SET interval_min = ? WHERE id = ?").bind(Number(b.interval_min), id).run();
      }
      if (b.run_hour != null) {
        await env.DB.prepare("UPDATE sites SET run_hour = ? WHERE id = ?").bind(Number(b.run_hour), id).run();
      }
      return json({ ok: true });
    }
    if (path === "/api/sites/active" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare("UPDATE sites SET active = ? WHERE id = ?").bind(Number(b.active) ? 1 : 0, Number(b.id)).run();
      return json({ ok: true });
    }
    if (path === "/api/sites/slug" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(newSlug(), Number(b.id)).run();
      return json({ ok: true });
    }
    if (path === "/api/sites/delete" && request.method === "POST") {
      const b = await request.json();
      const id = Number(b.id);
      const tables = [
        "snapshots",
        "runs",
        "manual_stats",
        "pages",
        "positions",
        "ai_visibility",
        "competitors",
        "insights",
        "prompts",
        "site_meta"
      ];
      for (const t of tables) {
        try {
          await env.DB.prepare("DELETE FROM " + t + " WHERE site_id = ?").bind(id).run();
        } catch (e) {
        }
      }
      await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (path === "/api/manual" && request.method === "GET") {
      const siteId = Number(url.searchParams.get("site") || 0);
      return json({ manual: await loadManual(env, siteId) });
    }
    if (path === "/api/manual" && request.method === "POST") {
      const b = await request.json();
      await ensureManual(env);
      await env.DB.prepare(
        "INSERT INTO manual_stats (site_id, month, y3, y10, g3, g10) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, month) DO UPDATE SET y3 = excluded.y3, y10 = excluded.y10, g3 = excluded.g3, g10 = excluded.g10"
      ).bind(
        Number(b.site_id),
        b.month,
        b.y3 == null ? null : Number(b.y3),
        b.y10 == null ? null : Number(b.y10),
        b.g3 == null ? null : Number(b.g3),
        b.g10 == null ? null : Number(b.g10)
      ).run();
      return json({ ok: true });
    }
    if (path === "/api/pages" && request.method === "GET") {
      const siteId = Number(url.searchParams.get("site") || 0);
      return json({ pages: await loadPages(env, siteId) });
    }
    if (path === "/api/pages/add" && request.method === "POST") {
      const b = await request.json();
      await ensurePages(env);
      let added = 0;
      for (const u of b.urls || []) {
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO pages (site_id, url, comment) VALUES (?, ?, '')"
          ).bind(Number(b.site_id), String(u).trim()).run();
          added++;
        } catch (e) {
        }
      }
      return json({ ok: true, added });
    }
    if (path === "/api/pages/import" && request.method === "POST") {
      const b = await request.json();
      await ensurePages(env);
      const snap = await env.DB.prepare("SELECT payload FROM snapshots WHERE site_id = ?").bind(Number(b.site_id)).first();
      let data = null;
      try {
        data = snap && snap.payload ? JSON.parse(snap.payload) : null;
      } catch (e) {
      }
      const seen = {};
      const months = data && data.pagesMonths || {};
      for (const k in months) {
        for (const p of months[k] || []) {
          const u = String(p.url || p.page || "").trim();
          if (u) seen[u] = 1;
        }
      }
      let added = 0;
      for (const u of Object.keys(seen)) {
        try {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO pages (site_id, url, comment) VALUES (?, ?, '')"
          ).bind(Number(b.site_id), u).run();
          added++;
        } catch (e) {
        }
      }
      return json({ ok: true, added });
    }
    if (path === "/api/pages/comment" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare("UPDATE pages SET comment = ? WHERE id = ?").bind(String(b.comment || ""), Number(b.id)).run();
      return json({ ok: true });
    }
    if (path === "/api/pages/delete" && request.method === "POST") {
      const b = await request.json();
      for (const id of b.ids || []) {
        await env.DB.prepare("DELETE FROM pages WHERE id = ? AND site_id = ?").bind(Number(id), Number(b.site_id)).run();
      }
      return json({ ok: true });
    }
    if (path === "/api/positions/stats" && request.method === "GET") {
      await ensurePositions(env);
      const siteId = Number(url.searchParams.get("site") || 0);
      const rows = await env.DB.prepare(
        "SELECT month, engine, COUNT(*) AS cnt FROM positions WHERE site_id = ? GROUP BY month, engine ORDER BY month DESC, engine"
      ).bind(siteId).all();
      return json({ stats: rows.results || [] });
    }
    if (path === "/api/positions/upload" && request.method === "POST") {
      const b = await request.json();
      await ensurePositions(env);
      const siteId = Number(b.site_id);
      if (Number(b.replace)) {
        await env.DB.prepare(
          "DELETE FROM positions WHERE site_id = ? AND month = ? AND engine = ?"
        ).bind(siteId, b.month, b.engine).run();
      }
      let saved = 0;
      for (const r of b.rows || []) {
        if (!r.query) continue;
        await env.DB.prepare(
          "INSERT INTO positions (site_id, engine, month, query, url, position) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, engine, month, query) DO UPDATE SET url = excluded.url, position = excluded.position"
        ).bind(
          siteId,
          b.engine,
          b.month,
          String(r.query),
          String(r.url || ""),
          r.position == null ? null : Number(r.position)
        ).run();
        saved++;
      }
      return json({ ok: true, saved });
    }
    if (path === "/api/positions/delete" && request.method === "POST") {
      const b = await request.json();
      if (b.engine) {
        await env.DB.prepare(
          "DELETE FROM positions WHERE site_id = ? AND month = ? AND engine = ?"
        ).bind(Number(b.site_id), b.month, b.engine).run();
      } else {
        await env.DB.prepare("DELETE FROM positions WHERE site_id = ? AND month = ?").bind(Number(b.site_id), b.month).run();
      }
      return json({ ok: true });
    }
    if (path === "/api/ai" && request.method === "GET") {
      const siteId = Number(url.searchParams.get("site") || 0);
      return json({ rows: await loadAiRows(env, siteId) });
    }
    if (path === "/api/ai/save" && request.method === "POST") {
      const b = await request.json();
      await ensureAi(env);
      await env.DB.prepare(
        "INSERT INTO ai_visibility (site_id, month, platform, visibility) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, month, platform) DO UPDATE SET visibility = excluded.visibility"
      ).bind(Number(b.site_id), b.month, String(b.platform), Number(b.visibility)).run();
      return json({ ok: true });
    }
    if (path === "/api/ai/delete" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare(
        "DELETE FROM ai_visibility WHERE site_id = ? AND month = ? AND platform = ?"
      ).bind(Number(b.site_id), b.month, String(b.platform)).run();
      return json({ ok: true });
    }
    if (path === "/api/competitors/stats" && request.method === "GET") {
      const siteId = Number(url.searchParams.get("site") || 0);
      return json({ stats: await loadCompetitorsStats(env, siteId) });
    }
    if (path === "/api/competitors/upload" && request.method === "POST") {
      const b = await request.json();
      await ensureCompetitors(env);
      const siteId = Number(b.site_id);
      await env.DB.prepare("DELETE FROM competitors WHERE site_id = ? AND month = ?").bind(siteId, b.month).run();
      let saved = 0;
      for (const r of b.rows || []) {
        if (!r.name) continue;
        await env.DB.prepare(
          "INSERT INTO competitors (site_id, month, name, domain, queries, share, avg_pos, category, is_our) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id, month, name) DO UPDATE SET domain = excluded.domain, queries = excluded.queries, share = excluded.share, avg_pos = excluded.avg_pos, category = excluded.category, is_our = excluded.is_our"
        ).bind(
          siteId,
          b.month,
          String(r.name),
          String(r.domain || ""),
          r.queries == null ? null : Number(r.queries),
          r.share == null ? null : Number(r.share),
          r.pos == null ? null : Number(r.pos),
          String(r.category || ""),
          Number(r.our) ? 1 : 0
        ).run();
        saved++;
      }
      return json({ ok: true, saved });
    }
    if (path === "/api/competitors/delete" && request.method === "POST") {
      const b = await request.json();
      await env.DB.prepare("DELETE FROM competitors WHERE site_id = ? AND month = ?").bind(Number(b.site_id), b.month).run();
      return json({ ok: true });
    }
    if (path === "/api/prompts" && request.method === "GET") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const siteId = Number(url.searchParams.get("site") || 0);
      return json(await loadPrompts(env, siteId));
    }
    if (path === "/api/prompts/total" && request.method === "POST") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const b = await request.json();
      await ensurePrompts(env);
      await env.DB.prepare(
        "INSERT INTO site_meta (site_id, prompts_total) VALUES (?, ?) ON CONFLICT(site_id) DO UPDATE SET prompts_total = excluded.prompts_total"
      ).bind(Number(b.site_id), b.total == null ? null : Number(b.total)).run();
      return json({ ok: true });
    }
    if (path === "/api/prompts/add" && request.method === "POST") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const b = await request.json();
      await ensurePrompts(env);
      let added = 0;
      for (const raw of b.list || []) {
        const t = String(raw || "").trim().slice(0, 500);
        if (!t) continue;
        try {
          await env.DB.prepare("INSERT OR IGNORE INTO prompts (site_id, text) VALUES (?, ?)").bind(Number(b.site_id), t).run();
          added++;
        } catch (e) {
        }
      }
      return json({ ok: true, added });
    }
    if (path === "/api/prompts/delete" && request.method === "POST") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const b = await request.json();
      await ensurePrompts(env);
      if (b.all) {
        await env.DB.prepare("DELETE FROM prompts WHERE site_id = ?").bind(Number(b.site_id)).run();
      } else {
        for (const id of b.ids || []) {
          await env.DB.prepare("DELETE FROM prompts WHERE id = ? AND site_id = ?").bind(Number(id), Number(b.site_id)).run();
        }
      }
      return json({ ok: true });
    }
    if (path === "/api/ai-engine" && request.method === "GET") {
      const cfg = await loadAiConfig(env);
      return json({
        provider: cfg.provider,
        base_url: cfg.base_url,
        model: cfg.model,
        model_free: cfg.model_free,
        has_token: cfg.token ? 1 : 0
      });
    }
    if (path === "/api/ai-engine" && request.method === "POST") {
      const b = await request.json();
      const cur = await loadAiConfig(env);
      const token = b.token && String(b.token).trim() ? String(b.token).trim() : cur.token;
      try {
        await env.DB.prepare(
          "INSERT INTO ai_config (id, provider, base_url, token, model, model_free) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url, token = excluded.token, model = excluded.model, model_free = excluded.model_free"
        ).bind(
          b.provider === "aitunnel" ? "aitunnel" : "workers",
          b.base_url && String(b.base_url).trim() || TUNNEL_BASE,
          token,
          b.model && String(b.model).trim() || TUNNEL_MODEL,
          b.model_free && String(b.model_free).trim() || FREE_MODEL
        ).run();
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
      return json({ ok: true });
    }
    if (path === "/api/ai-engine/test" && request.method === "POST") {
      try {
        const ans = await askAi(
          env,
          "\u041E\u0442\u0432\u0435\u0447\u0430\u0439 \u043E\u0434\u043D\u0438\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u043C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435\u043C \u043F\u043E-\u0440\u0443\u0441\u0441\u043A\u0438.",
          "\u041D\u0430\u043F\u0438\u0448\u0438: \u0441\u0432\u044F\u0437\u044C \u0441 \u0418\u0418 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442.",
          60
        );
        return json({ ok: true, model: ans.model, text: String(ans.text || "").slice(0, 200) });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }
    if (path === "/api/done" && request.method === "GET") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const siteId = Number(url.searchParams.get("site") || 0);
      if (!siteId) return json({ items: {} });
      return json({ items: await loadDone(env, siteId) });
    }
    if (path === "/api/done" && request.method === "POST") {
      if (!await isLoggedIn(request, env)) return json({ error: "auth" }, 401);
      const b = await request.json();
      await ensureDone(env);
      const siteId = Number(b.site_id);
      const month = String(b.month || "").slice(0, 7);
      if (!siteId || !month) return json({ error: "\u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D \u0441\u0430\u0439\u0442 \u0438\u043B\u0438 \u043C\u0435\u0441\u044F\u0446" }, 400);
      const text = String(b.text == null ? "" : b.text).slice(0, 8e3);
      if (!text.trim()) {
        await env.DB.prepare("DELETE FROM done_works WHERE site_id = ? AND month = ?").bind(siteId, month).run();
        return json({ ok: true, cleared: true });
      }
      await env.DB.prepare(
        "INSERT INTO done_works (site_id, month, text) VALUES (?, ?, ?) ON CONFLICT(site_id, month) DO UPDATE SET text = excluded.text"
      ).bind(siteId, month, text).run();
      return json({ ok: true });
    }
    if (path === "/api/insights" && request.method === "GET") {
      const siteId = Number(url.searchParams.get("site") || 0);
      return json(await loadInsights(env, siteId));
    }
    if (path === "/api/insights/generate-one" && request.method === "POST") {
      const b = await request.json();
      const site = await env.DB.prepare("SELECT id, name FROM sites WHERE id = ?").bind(Number(b.site_id)).first();
      if (!site) return json({ error: "\u043D\u0435\u0442 \u0442\u0430\u043A\u043E\u0433\u043E \u0441\u0430\u0439\u0442\u0430" }, 404);
      try {
        return json(await generateOne(env, site, String(b.key || ""), b.table || ""));
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }
    if (path === "/api/insights/save" && request.method === "POST") {
      const b = await request.json();
      const siteId = Number(b.site_id || 0);
      const key = String(b.key || "");
      if (!siteId || key !== "plan" && INS_KEYS.indexOf(key) < 0) {
        return json({ error: "\u041D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D \u0441\u0430\u0439\u0442 \u0438\u043B\u0438 \u0431\u043B\u043E\u043A" }, 400);
      }
      const cur = await loadInsights(env, siteId);
      const items = cur.items || {};
      const text = String(b.text || "").slice(0, 6e3).trim();
      if (text) items[key] = text;
      else delete items[key];
      try {
        return json(await saveInsightItems(env, siteId, items, cur.model));
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }
    if (path === "/api/insights/generate" && request.method === "POST") {
      const b = await request.json();
      const site = await env.DB.prepare("SELECT id, name FROM sites WHERE id = ?").bind(Number(b.site_id)).first();
      if (!site) return json({ error: "\u043D\u0435\u0442 \u0442\u0430\u043A\u043E\u0433\u043E \u0441\u0430\u0439\u0442\u0430" }, 404);
      try {
        return json(await generateInsights(env, site.id, site.name, b.facts || {}));
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }
    if (path === "/api/data" && request.method === "GET") {
      const q = url.searchParams.get("site");
      const site = q ? await env.DB.prepare("SELECT id, name FROM sites WHERE id = ?").bind(Number(q)).first() : await env.DB.prepare(
        "SELECT id, name FROM sites WHERE active = 1 ORDER BY name LIMIT 1"
      ).first();
      if (!site) return json({ error: "\u043D\u0435\u0442 \u0441\u0430\u0439\u0442\u043E\u0432" }, 404);
      return json(await dashData(env, site));
    }
    if (path === "/api/refresh" && request.method === "POST") {
      let b = {};
      try {
        b = await request.json();
      } catch (e) {
      }
      const count = await collectAll(env, b.site_id ? Number(b.site_id) : null);
      return json({ ok: true, count });
    }
    if (path === "/api/runs" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT r.started_at, r.site_id, r.status, r.message, s.name AS site_name FROM runs r LEFT JOIN sites s ON s.id = r.site_id ORDER BY r.id DESC LIMIT 60"
      ).all();
      return json({ runs: rows.results || [] });
    }
    return json({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectAll(env));
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
