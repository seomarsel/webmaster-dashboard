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

# ============ ЗАПРОСЫ (топ) ============
queries_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-queries/popular/",
    params={
        "order_by": "TOTAL_SHOWS",
        "query_indicator": ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION"],
        "date_from": date_from,
        "date_to": date_to,
        "limit": 10,
    },
), {"queries": []})

queries = []
for q in queries_raw.get("queries", []):
    ind = q.get("indicators", {})
    shows = ind.get("TOTAL_SHOWS") or 0
    clicks = ind.get("TOTAL_CLICKS") or 0
    queries.append({
        "query": q.get("query_text", ""),
        "shows": shows,
        "clicks": clicks,
        "ctr": round(clicks / shows * 100, 2) if shows else 0,
        "position": round(ind.get("AVG_SHOW_POSITION") or 0, 1),
    })

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
pages_excluded = []  # отдельного /excluded/ нет — берём из событий (events) ниже

# история событий (появились / исчезли из поиска)
events_hist_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-urls/events/history/",
    params={"date_from": date_from_90, "date_to": date_to},
), {})
print(f"📈 events/history ключи: {list(events_hist_raw.keys())}")
for pt in (events_hist_raw.get("history") or []):
    d = (pt.get("date") or "")[:10]
    if not d:
        continue
    removed = (pt.get("removed_from_search_count")
               or pt.get("removed_count")
               or pt.get("DEL")
               or pt.get("value") or 0)
    pages_excluded.append({"date": d, "value": removed})

# ============ ИСКЛЮЧЁННЫЕ: ПРИЧИНЫ (через события) ============
REASON_RU = {
    "WAS_REMOVED_FROM_SEARCH": "Удалена из поиска",
    "REMOVED_FROM_SEARCH": "Удалена из поиска",
    "WAS_FOUND_IN_SEARCH": "Добавлена в поиск",
    "HTTP_ERROR": "Ошибка HTTP",
    "REDIRECT": "Редирект",
    "CLEAN_PARAM": "Clean-param",
    "DISALLOWED_BY_USER": "Запрещено в robots.txt",
    "DISALLOWED_IN_ROBOTS": "Запрещено в robots.txt",
    "NOINDEX": "Запрет meta noindex",
    "DUPLICATE": "Дубликат",
    "LOW_QUALITY": "Низкое качество",
    "INSUFFICIENT_QUALITY": "Недостаточно качественная",
    "NOT_CANONICAL": "Неканоническая",
    "PARSER_ERROR": "Ошибка обработки",
    "NOT_MAIN_MIRROR": "Не главное зеркало",
    "SITE_ERROR": "Ошибка сайта",
}

def find_reason(s):
    ev = s.get("event") if isinstance(s.get("event"), dict) else {}
    cand = (s.get("excluded_url_status") or s.get("status") or s.get("reason")
            or s.get("event_kind") or ev.get("event_kind") or ev.get("kind")
            or ev.get("reason") or ev.get("status"))
    if isinstance(cand, dict):
        cand = cand.get("event_kind") or cand.get("kind") or cand.get("reason")
    if not cand and isinstance(s.get("event"), str):
        cand = s.get("event")
    return cand or "OTHER"

events_raw = safe(lambda: get(
    f"{WM}/user/{user_id}/hosts/{host_id}/search-urls/events/samples/",
    params={"limit": 100},
), {})
print(f"🚫 events/samples ключи: {list(events_raw.keys())}")
samples = events_raw.get("samples") or events_raw.get("events") or []
if samples:
    print(f"🚫 Пример события: {json.dumps(samples[0], ensure_ascii=False)[:500]}")

reason_counts = {}
for s in samples:
    if not isinstance(s, dict):
        continue
    r = find_reason(s)
    reason_counts[r] = reason_counts.get(r, 0) + 1
excluded_reasons = sorted(
    [{"reason": k, "reason_ru": REASON_RU.get(k, k), "count": v} for k, v in reason_counts.items()],
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
print(f"🩺 Диагностика, ключи: {list(diag_raw.keys())}")
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

# ============ МЕТРИКА ============
metrika = {}
if COUNTER:
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
    "history": history,
    "pages_in_search": pages_in_search,
    "pages_excluded": pages_excluded,
    "excluded_reasons": excluded_reasons,
    "health": {"problems": problems, "counts": counts},
    "sitemaps": sitemaps,
    "metrika": metrika,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"✅ Готово! Дней: {len(history)}, В поиске точек: {len(pages_in_search)}, Событий-причин: {len(excluded_reasons)}")
