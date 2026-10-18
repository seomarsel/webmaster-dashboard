// src/yandex.js
var DAYS = 180;
var MAX_GOALS = 15;
var MAX_PAGES = 500;
var PAGE_MONTHS = [1, 2, 3, 4];
var METRIKA = "https://api-metrika.yandex.net";
var WEBMASTER = "https://api.webmaster.yandex.net/v4/user";
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
__name(ymd, "ymd");
function pad2(n) {
  return n < 10 ? "0" + n : "" + n;
}
__name(pad2, "pad2");
function monthRange(offset) {
  const now = /* @__PURE__ */ new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset + 1, 0));
  return {
    key: start.getUTCFullYear() + "-" + pad2(start.getUTCMonth() + 1),
    from: ymd(start),
    to: ymd(end)
  };
}
__name(monthRange, "monthRange");
async function getJson(url, token) {
  const r = await fetch(url, { headers: { Authorization: "OAuth " + token } });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(r.status + " " + text.slice(0, 200));
    err.status = r.status;
    throw err;
  }
  return JSON.parse(text);
}
__name(getJson, "getJson");
function statUrl(params) {
  const u = new URL(METRIKA + "/stat/v1/data");
  for (const k of Object.keys(params)) {
    if (params[k] === void 0 || params[k] === null || params[k] === "") continue;
    u.searchParams.set(k, String(params[k]));
  }
  return u.toString();
}
__name(statUrl, "statUrl");
async function pagesForMonth(site, goalMetrics, from, to) {
  const metrics = ["ym:s:visits"].concat(goalMetrics).join(",");
  const url = statUrl({
    ids: site.counter_id,
    metrics,
    dimensions: "ym:s:startURL",
    date1: from,
    date2: to,
    sort: "-ym:s:visits",
    limit: MAX_PAGES,
    accuracy: "full"
  });
  const data = await getJson(url, site.token);
  const out = [];
  for (const row of data.data || []) {
    const pageUrl = row.dimensions[0].name;
    if (!pageUrl) continue;
    const visits = Number(row.metrics[0]) || 0;
    let conversions = 0;
    for (let i = 1; i < row.metrics.length; i++) {
      conversions += Number(row.metrics[i]) || 0;
    }
    out.push({ url: pageUrl, visits, conversions });
  }
  return out;
}
__name(pagesForMonth, "pagesForMonth");
async function collectSite(site) {
  const errors = [];
  const now = /* @__PURE__ */ new Date();
  const past = new Date(now.getTime() - DAYS * 864e5);
  const from = ymd(past);
  const to = ymd(now);
  const result = {
    name: site.name,
    counter_id: site.counter_id,
    host_id: site.host_id || null,
    period: from + " \u2014 " + to,
    updated_at: (/* @__PURE__ */ new Date()).toISOString(),
    errors,
    goals: [],
    daily: [],
    sourcesDaily: [],
    searchDaily: [],
    searchConvDaily: [],
    pagesMonths: {},
    webmaster: {},
    queries: []
  };
  const goalMetrics = [];
  try {
    const g = await getJson(
      METRIKA + "/management/v1/counter/" + site.counter_id + "/goals?useAutoGoals=true&useDirectGoals=true",
      site.token
    );
    const goals = (g.goals || []).slice(0, MAX_GOALS);
    for (const goal of goals) {
      result.goals.push({ id: goal.id, name: goal.name });
      goalMetrics.push("ym:s:goal" + goal.id + "reaches");
    }
  } catch (e) {
    errors.push("\u0426\u0435\u043B\u0438: " + e.message);
  }
  try {
    const data = await getJson(
      statUrl({
        ids: site.counter_id,
        metrics: "ym:s:visits,ym:s:users,ym:s:bounceRate",
        dimensions: "ym:s:date",
        date1: from,
        date2: to,
        limit: 1e5,
        accuracy: "full"
      }),
      site.token
    );
    for (const row of data.data || []) {
      result.daily.push({
        date: row.dimensions[0].name,
        visits: Number(row.metrics[0]) || 0,
        users: Number(row.metrics[1]) || 0,
        bounce: Number(row.metrics[2]) || 0
      });
    }
    result.daily.sort(function(a, b) {
      return a.date < b.date ? -1 : 1;
    });
  } catch (e) {
    errors.push("\u041C\u0435\u0442\u0440\u0438\u043A\u0430: " + e.message);
  }
  try {
    const data = await getJson(
      statUrl({
        ids: site.counter_id,
        metrics: "ym:s:visits,ym:s:users",
        dimensions: "ym:s:date,ym:s:lastTrafficSource",
        date1: from,
        date2: to,
        limit: 1e5,
        accuracy: "full"
      }),
      site.token
    );
    for (const row of data.data || []) {
      result.sourcesDaily.push({
        date: row.dimensions[0].name,
        source: row.dimensions[1].name,
        visits: Number(row.metrics[0]) || 0,
        users: Number(row.metrics[1]) || 0
      });
    }
  } catch (e) {
    errors.push("\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438: " + e.message);
  }
  try {
    const metrics = ["ym:s:visits", "ym:s:users"].concat(goalMetrics).join(",");
    const data = await getJson(
      statUrl({
        ids: site.counter_id,
        metrics,
        dimensions: "ym:s:date,ym:s:lastSearchEngineRoot",
        filters: "ym:s:lastTrafficSource=='organic'",
        date1: from,
        date2: to,
        limit: 1e5,
        accuracy: "full"
      }),
      site.token
    );
    for (const row of data.data || []) {
      let conversions = 0;
      for (let i = 2; i < row.metrics.length; i++) {
        conversions += Number(row.metrics[i]) || 0;
      }
      result.searchDaily.push({
        date: row.dimensions[0].name,
        engine: row.dimensions[1].name,
        visits: Number(row.metrics[0]) || 0,
        users: Number(row.metrics[1]) || 0,
        conversions
      });
    }
  } catch (e) {
    errors.push("\u041F\u043E\u0438\u0441\u043A\u043E\u0432\u044B\u0439 \u0442\u0440\u0430\u0444\u0438\u043A: " + e.message);
  }
  try {
    const data = await getJson(
      statUrl({
        ids: site.counter_id,
        metrics: "ym:s:sumGoalReachesAny",
        dimensions: "ym:s:date",
        filters: "ym:s:lastTrafficSource=='organic'",
        date1: from,
        date2: to,
        limit: 1e5,
        accuracy: "full"
      }),
      site.token
    );
    for (const row of data.data || []) {
      result.searchConvDaily.push({
        date: row.dimensions[0].name,
        conversions: Number(row.metrics[0]) || 0
      });
    }
  } catch (e) {
    errors.push("\u041A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u0438 \u0441 \u043F\u043E\u0438\u0441\u043A\u0430: " + e.message);
  }
  for (const off of PAGE_MONTHS) {
    const m = monthRange(off);
    try {
      result.pagesMonths[m.key] = await pagesForMonth(site, goalMetrics, m.from, m.to);
    } catch (e) {
      errors.push("\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u044B " + m.key + ": " + e.message);
      result.pagesMonths[m.key] = [];
    }
  }
  if (site.host_id) {
    let userId = null;
    try {
      const me = await getJson(WEBMASTER + "/", site.token);
      userId = me.user_id;
    } catch (e) {
      errors.push("\u0412\u0435\u0431\u043C\u0430\u0441\u0442\u0435\u0440 (\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C): " + e.message);
    }
    if (userId) {
      const base = WEBMASTER + "/" + userId + "/hosts/" + encodeURIComponent(site.host_id);
      try {
        const s = await getJson(base + "/summary/", site.token);
        result.webmaster = {
          sqi: s.sqi === void 0 ? null : s.sqi,
          pages_in_search: s.searchable_pages_count === void 0 ? null : s.searchable_pages_count,
          excluded_pages: s.excluded_pages_count === void 0 ? null : s.excluded_pages_count
        };
      } catch (e) {
        errors.push("\u0412\u0435\u0431\u043C\u0430\u0441\u0442\u0435\u0440: " + e.message);
      }
      try {
        const q = await getJson(
          base + "/search-queries/popular/?order_by=TOTAL_SHOWS&query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS",
          site.token
        );
        for (const item of q.queries || []) {
          result.queries.push({
            query: item.query_text,
            shows: item.indicators && item.indicators.TOTAL_SHOWS || 0,
            clicks: item.indicators && item.indicators.TOTAL_CLICKS || 0
          });
        }
      } catch (e) {
        errors.push("\u0412\u0435\u0431\u043C\u0430\u0441\u0442\u0435\u0440 (\u0437\u0430\u043F\u0440\u043E\u0441\u044B): " + e.message);
      }
    }
  }
  return result;
}
__name(collectSite, "collectSite");
function isDue(site, now) {
  const interval = Number(site.interval_min) || 60;
  if (interval >= 1440 && site.run_hour !== null && site.run_hour !== void 0) {
    const ufaHour = (now.getUTCHours() + 5) % 24;
    if (ufaHour !== Number(site.run_hour)) return false;
    if (!site.last_run_at) return true;
    const lastRaw = site.last_run_at || "";
    const last2 = new Date(/[zZ]$/.test(lastRaw) ? lastRaw : lastRaw + "Z");
    return now.getTime() - last2.getTime() > 20 * 3600 * 1e3;
  }
  if (!site.last_run_at) return true;
  const lastRaw = site.last_run_at;
  const last = new Date(/[zZ]$/.test(lastRaw) ? lastRaw : lastRaw + "Z");
  const passed = (now.getTime() - last.getTime()) / 6e4;
  return passed >= interval - 1;
}
__name(isDue, "isDue");
async function collectAll(env, siteId) {
  const now = /* @__PURE__ */ new Date();
  const q = siteId ? env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId) : env.DB.prepare("SELECT * FROM sites WHERE active = 1");
  const { results } = await q.all();
  let count = 0;
  for (const site of results) {
    if (!siteId && !isDue(site, now)) continue;
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    let status = "ok";
    let message = "";
    try {
      const data = await collectSite(site);
      if (data.errors && data.errors.length) {
        status = data.daily.length ? "partial" : "error";
        message = data.errors.join("; ").slice(0, 400);
      }
      await env.DB.prepare(
        "INSERT INTO snapshots (site_id, updated_at, payload) VALUES (?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET updated_at = excluded.updated_at, payload = excluded.payload"
      ).bind(site.id, data.updated_at, JSON.stringify(data)).run();
    } catch (e) {
      status = "error";
      message = String(e && e.message ? e.message : e).slice(0, 400);
    }
    await env.DB.prepare(
      "INSERT INTO runs (site_id, started_at, status, message) VALUES (?, ?, ?, ?)"
    ).bind(site.id, startedAt, status, message).run();
    await env.DB.prepare("UPDATE sites SET last_run_at = ? WHERE id = ?").bind((/* @__PURE__ */ new Date()).toISOString(), site.id).run();
    count++;
  }
  await env.DB.prepare(
    "DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 300)"
  ).run();
  return count;
}
__name(collectAll, "collectAll");
