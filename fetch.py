import os
import json
import datetime
import requests

TOKEN = os.environ["YANDEX_TOKEN"]
SITE = os.environ.get("SITE", "igear-shop.ru")
COUNTER = os.environ.get("METRIKA_COUNTER", "")

HEADERS = {"Authorization": f"OAuth {TOKEN}"}
print(f"🔑 Длина токена: {len(TOKEN)} символов, начало: {TOKEN[:4]}...")

def get(url, params=None):
    r = requests.get(url, headers=HEADERS, params=params)
    if not r.ok:
        print(f"❌ Ошибка {r.status_code} при запросе: {url}")
        print(f"📩 Что ответил Яндекс: {r.text}")
    r.raise_for_status()
    return r.json()

def safe(fn, default):
    try:
        return fn()
    except Exception as e:
        print(f"⚠️ Пропускаю (ошибка): {e}")
        return default

today = datetime.date.today()
date_from = (today - datetime.timedelta(days=30)).isoformat()
date_to = today.isoformat()
prev_from = (today - datetime.timedelta(days=60)).isoformat()
prev_to = (today - datetime.timedelta(days=30)).isoformat()
date_from_90 = (today - datetime.timedelta(days=90)).isoformat()

WM = "https://api.webmaster.yandex.net/v4"

user_id = get(f"{WM}/user")["user_id"]

hosts = get(f"{WM}/user/{user_id}/hosts")["hosts"]
host = next(
    (h for h in hosts if SITE in h.get("unicode_host_url", "") or SITE in h.get("ascii_host_url", "")),
    hosts[0],
)
host_id = host["host_id"]

summary = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/summary"), {})

# ============ ЗАПРОСЫ ============
def fetch_queries(df, dt, limit=500):
    raw = safe(lambda: get(
        f"{WM}/user/{user_id}/hosts/{host_id}/search-queries/popular/",
        params={
            "order_by": "TOTAL_SHOWS",
            "query_indicator": ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"],
            "date_from": df,
            "date_to": dt,
            "limit": limit,
        },
    ), {"queries": []})
    out = []
    for q in raw.get("queries", []):
        ind = q.get("indicators", {})
        shows = ind.get("TOTAL_SHOWS") or 0
        clicks = ind.get("TOTAL_CLICKS") or 0
        pos = ind.get("AVG_SHOW_POSITION") or 0
        out.append({
            "query": q.get("query_text", ""),
            "shows": shows,
            "clicks": clicks,
            "ctr": round(clicks / shows * 100, 2) if shows else 0,
            "position": round(pos, 1),
        })
    return out

all_q = fetch_queries(date_from, date_to, 500)
queries = all_q[:10] if all_q else fetch_queries(date_from, date_to, 10)
prev_q = fetch_queries(prev_from, prev_to, 500)
print(f"🔢 Запросов: текущих {len(all_q)}, прошлый период {len(prev_q)}")

# --- распределение по позициям ---
position_buckets = {"top3": 0, "top4_10": 0, "top11_50": 0, "top50plus": 0}
for q in all_q:
    p = q["position"]
    if p <= 0:
        continue
    if p <= 3:
        position_buckets["top3"] += 1
    elif p <= 10:
        position_buckets["top4_10"] += 1
    elif p <= 50:
        position_buckets["top11_50"] += 1
    else:
        position_buckets["top50plus"] += 1

# --- запросы-возможности (высокие показы + низкий CTR + позиция 4–10) ---
opp_pool = []
for q in all_q:
    if 4 <= q["position"] <= 10 and q["shows"] > 0:
        score = q["shows"] * (1 - q["ctr"] / 100.0)
        opp_pool.append((score, q))
opportunities = [q for _, q in sorted(opp_pool, key=lambda x: -x[0])[:10]]

# --- новые / потерянные запросы ---
cur_set = {q["query"] for q in all_q if q["query"]}
prev_set = {q["query"] for q in prev_q if q["query"]}
new_q = sorted([q for q in all_q if q["query"] and q["query"] not in prev_set], key=lambda x: -x["shows"])
lost_q = sorted([q for q in prev_q if q["query"] and q["query"] not in cur_set], key=lambda x: -x["shows"])

# --- группировка по интентам ---
COMMERCIAL = ["купить", "куплю", "цена", "цены", "стоимость", "сколько стоит", "заказать",
              "заказ ", "доставка", "магазин", "опт", "оптом", "недорог", "дешев",
              "прайс", "каталог", "продаж", "скидк", "в наличии", "купить в"]
INFO = [" как ", " что ", " чем ", " зачем ", " почему ", " какой", " какая", " какие",
        " какое", "для чего", "можно ли", "отзыв", "инструкц", "своими руками", "рейтинг",
        "сравнен", " лучш", "что такое", "чем отлич", " нужно ли"]

def classify(text):
    t = " " + text.lower().replace("ё", "е") + " "
    if any(w in t for w in COMMERCIAL):
        return "commercial"
    if any(w in t for w in INFO):
        return "informational"
    return "other"

intents = {
    "commercial": {"count": 0, "shows": 0, "clicks": 0},
    "informational": {"count": 0, "shows": 0, "clicks": 0},
    "other": {"count": 0, "shows": 0, "clicks": 0},
}
for q in all_q:
    g = classify(q["query"])
    intents[g]["count"] += 1
    intents[g]["shows"] += q["shows"]
    intents[g]["clicks"] += q["clicks"]

query_analytics = {
    "total_queries": len(all_q),
    "position_buckets": position_buckets,
    "opportunities": opportunities,
    "new_count": len(new_q),
    "new_queries": new_q[:15],
    "lost_count": len(lost_q),
    "lost_queries": lost_q[:15],
    "intents": intents,
}

# ============ ИСТОРИЯ ПОКАЗОВ/КЛИКОВ ПО ДНЯМ ============
history_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-queries/all/history/",
    params={
        "query_indicator": ["TOTAL_SHOWS", "TOTAL_CLICKS"],
        "date_from": date_from_90,
        "date_to": date_to,
    },
), {})
ind_hist = history_raw.get("indicators", {}) or {}
hist = {}
for pt in ind_hist.get("TOTAL_SHOWS", []):
    d = (pt.get("date") or "")[:10]
    if d:
        hist.setdefault(d, {"shows": 0, "clicks": 0})
        hist[d]["shows"] = pt.get("value") or 0
for pt in ind_hist.get("TOTAL_CLICKS", []):
    d = (pt.get("date") or "")[:10]
    if d:
        hist.setdefault(d, {"shows": 0, "clicks": 0})
        hist[d]["clicks"] = pt.get("value") or 0
history = [{"date": d, "shows": v["shows"], "clicks": v["clicks"]} for d, v in sorted(hist.items())]

# ============ ДИНАМИКА ИНДЕКСА: СТРАНИЦЫ В ПОИСКЕ ============
def history_series(path, params=None):
    p = {"date_from": date_from_90, "date_to": date_to}
    if params:
        p.update(params)
    raw = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/{path}", params=p), {})
    print(f"📈 {path} ключи: {list(raw.keys())}")
    out = []
    for pt in (raw.get("history") or []):
        d = (pt.get("date") or "")[:10]
        if d:
            out.append({"date": d, "value": pt.get("value") or 0})
    return out

pages_in_search = history_series("search-urls/in-search/history/")

events_hist_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-urls/events/history/",
    params={"date_from": date_from_90, "date_to": date_to},
), {})
ev_ind = events_hist_raw.get("indicators", {}) or {}
print(f"📈 events/history индикаторы: {list(ev_ind.keys())}")
removed_key = next((k for k in ev_ind if any(w in k.upper() for w in ("REMOV", "EXCLUD", "DISAPPEAR", "DEL"))), None)
pages_excluded = []
if removed_key:
    for pt in ev_ind[removed_key]:
        d = (pt.get("date") or "")[:10]
        if d:
            pages_excluded.append({"date": d, "value": abs(pt.get("value") or 0)})

# ============ ИСКЛЮЧЁННЫЕ СТРАНИЦЫ: ПРИЧИНЫ ============
events_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-urls/events/samples/",
    params={"limit": 100},
), {})
samples = events_raw.get("samples") or events_raw.get("events") or []
NOT_EXCLUSION = ("APPEARED_IN_SEARCH", "WAS_FOUND_IN_SEARCH", "FOUND_IN_SEARCH")

def is_excluded(s):
    ev = str(s.get("event") or "").upper()
    if ev in NOT_EXCLUSION:
        return bool(s.get("excluded_url_status") or s.get("bad_http_status"))
    if s.get("excluded_url_status") or s.get("bad_http_status"):
        return True
    return any(w in ev for w in ("REMOV", "EXCLUD", "DISAPPEAR"))

def excl_reason(s):
    if s.get("excluded_url_status"):
        return s["excluded_url_status"]
    if s.get("bad_http_status"):
        return f"HTTP {s['bad_http_status']}"
    return "REMOVED"

reason_counts = {}
for s in samples:
    if not isinstance(s, dict) or not is_excluded(s):
        continue
    r = excl_reason(s)
    reason_counts[r] = reason_counts.get(r, 0) + 1
excluded_reasons = sorted(
    [{"reason": k, "reason_ru": k, "count": v} for k, v in reason_counts.items()],
    key=lambda x: -x["count"],
)

# ============ ЗДОРОВЬЕ САЙТА ============
SEVERITY_RU = {
    "FATAL": "Фатальная", "CRITICAL": "Критическая",
    "POSSIBLE_PROBLEM": "Возможная", "RECOMMENDATION": "Рекомендация",
}
PROBLEM_RU = {
    "SITE_ERROR": "Ошибки на сайте",
    "DISALLOWED_IN_ROBOTS": "Страницы запрещены в robots.txt",
    "DNS_ERROR": "Ошибка DNS",
    "SITEMAP_ERROR": "Ошибки в Sitemap",
    "SITEMAP_NOT_SET": "Не указан файл Sitemap",
    "MAIN_MIRROR_IS_NOT_HTTPS": "Главное зеркало не на HTTPS",
    "NO_METRIKA_COUNTER_BINDING": "Не привязан счётчик Метрики",
    "THREATS": "Угрозы безопасности",
    "SLOW_AVG_RESPONSE_TIME": "Медленный ответ сервера",
    "ERRORS_IN_MICRODATA": "Ошибки в микроразметке",
    "DECREASED_TIC": "Снижение ИКС",
    "NO_ROBOTS_TXT": "Отсутствует robots.txt",
    "ROBOTS_TXT_ERROR": "Ошибки в robots.txt",
    "DOCUMENTS_MISSING_DESCRIPTION": "Страницы без description",
    "DOCUMENTS_MISSING_TITLE": "Страницы без title",
    "NOT_MOBILE_FRIENDLY": "Нет мобильной версии",
}
diag_raw = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/diagnostics/"), {})
problems = []
counts = {"FATAL": 0, "CRITICAL": 0, "POSSIBLE_PROBLEM": 0, "RECOMMENDATION": 0}
problems_data = diag_raw.get("problems")
diag_items = []
if isinstance(problems_data, dict):
    diag_items = list(problems_data.items())
elif isinstance(problems_data, list):
    diag_items = [(p.get("type") or p.get("problem_type") or "", p) for p in problems_data if isinstance(p, dict)]
for ptype, pdata in diag_items:
    if not isinstance(pdata, dict):
        continue
    state = str(pdata.get("state", "")).upper()
    severity = pdata.get("severity", "")
    if state == "ABSENT":
        continue
    problems.append({
        "code": ptype,
        "title": PROBLEM_RU.get(ptype, ptype),
        "severity": severity,
        "severity_ru": SEVERITY_RU.get(severity, severity),
    })
    if severity in counts:
        counts[severity] += 1

# ============ SITEMAP ============
sitemaps_raw = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/sitemaps/"), {})
sitemaps = []
for s in (sitemaps_raw.get("sitemaps") or []):
    sitemaps.append({
        "url": s.get("sitemap_url", ""),
        "urls": s.get("urls_count", 0),
        "errors": s.get("errors_count", 0),
        "last_access": s.get("last_access_date", ""),
    })

# ============ ССЫЛОЧНЫЙ ПРОФИЛЬ ============
def links_samples(path, limit=100):
    raw = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/{path}", params={"limit": limit}), {})
    print(f"🔗 {path} ключи: {list(raw.keys())}")
    items = raw.get("links") or raw.get("samples") or []
    if items:
        print(f"🔗 {path} пример: {json.dumps(items[0], ensure_ascii=False)[:300]}")
    out = []
    for l in items[:20]:
        if not isinstance(l, dict):
            continue
        out.append({
            "source": l.get("source_url") or l.get("source") or l.get("url") or "",
            "date": (l.get("discovery_date") or l.get("broken_date") or l.get("date") or "")[:10],
        })
    cnt = raw.get("count")
    if cnt is None:
        cnt = len(items)
    return cnt, out

links_hist_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/links/external/history/",
    params={"indicator": "LINKS_TOTAL_COUNT"},
), {})
lh_ind = links_hist_raw.get("indicators", {}) or {}
print(f"🔗 links/external/history индикаторы: {list(lh_ind.keys())}")
links_history = []
total_links = None
if lh_ind:
    series = lh_ind.get("LINKS_TOTAL_COUNT") or next(iter(lh_ind.values()), [])
    for pt in series:
        d = (pt.get("date") or "")[:10]
        if d:
            links_history.append({"date": d, "value": pt.get("value") or 0})
    if links_history:
        total_links = links_history[-1]["value"]

total_samples, _ = links_samples("links/external/samples/")
if total_links is None:
    total_links = total_samples
new_count, new_links = links_samples("links/external/new/samples/")
broken_count, broken_links = links_samples("links/external/broken/samples/")

link_profile = {
    "total_count": total_links,
    "history": links_history,
    "new_count": new_count,
    "new_links": new_links,
    "broken_count": broken_count,
    "broken_links": broken_links,
}

# ============ МЕТРИКА (по дням, 90 дней) ============
metrika = {}
metrika_history = []
if COUNTER:
    bt = safe(lambda: get(
        "https://api-metrika.yandex.net/stat/v1/data/bytime",
        params={
            "ids": COUNTER,
            "metrics": "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate",
            "date1": date_from_90,
            "date2": date_to,
            "group": "day",
        },
    ), {})
    intervals = bt.get("time_intervals") or []
    series = bt.get("data") or []
    metric_arrays = series[0].get("metrics") if series else None
    if intervals and metric_arrays and len(metric_arrays) >= 4:
        visits_s, users_s, views_s, bounce_s = metric_arrays[0], metric_arrays[1], metric_arrays[2], metric_arrays[3]
        for i, iv in enumerate(intervals):
            d = (iv[0] if isinstance(iv, list) else iv)[:10]
            metrika_history.append({
                "date": d,
                "visits": int(visits_s[i]) if i < len(visits_s) else 0,
                "users": int(users_s[i]) if i < len(users_s) else 0,
                "pageviews": int(views_s[i]) if i < len(views_s) else 0,
                "bounceRate": round(bounce_s[i], 1) if i < len(bounce_s) else 0,
            })
    print(f"📊 Метрика дней: {len(metrika_history)}")

    m = safe(lambda: get(
        "https://api-metrika.yandex.net/stat/v1/data",
        params={
            "ids": COUNTER,
            "metrics": "ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate",
            "date1": date_from,
            "date2": date_to,
        },
    ), {})
    totals = m.get("totals", [])
    if totals:
        metrika = {
            "visits": int(totals[0]),
            "users": int(totals[1]),
            "pageviews": int(totals[2]),
            "bounceRate": round(totals[3], 1) if len(totals) > 3 else None,
        }

# ============ СОХРАНЯЕМ ============
result = {
    "updated": datetime.datetime.now().isoformat(timespec="minutes"),
    "site": SITE,
    "sqi": summary.get("sqi"),
    "queries": queries,
    "query_analytics": query_analytics,
    "history": history,
    "pages_in_search": pages_in_search,
    "pages_excluded": pages_excluded,
    "excluded_reasons": excluded_reasons,
    "health": {"problems": problems, "counts": counts},
    "sitemaps": sitemaps,
    "link_profile": link_profile,
    "metrika": metrika,
    "metrika_history": metrika_history,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"✅ Готово! Запросов: {len(all_q)}, Ссылок: {total_links}, Метрика дней: {len(metrika_history)}")
