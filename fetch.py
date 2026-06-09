import os
import json
import datetime
import requests

# Токен берётся из секретов GitHub (НЕ пишем его прямо в коде!)
TOKEN = os.environ["YANDEX_TOKEN"]
SITE = os.environ.get("SITE", "igear-shop.ru")          # адрес сайта в Вебмастере
COUNTER = os.environ.get("METRIKA_COUNTER", "")          # номер счётчика Метрики

HEADERS = {"Authorization": f"OAuth {TOKEN}"}

def get(url, params=None):
    r = requests.get(url, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()

def safe(fn, default):
    """Если один запрос упал — не ломаем весь дашборд."""
    try:
        return fn()
    except Exception as e:
        print(f"⚠️ Ошибка: {e}")
        return default

# Период: последние 30 дней
today = datetime.date.today()
date_from = (today - datetime.timedelta(days=30)).isoformat()
date_to = today.isoformat()

# ======================= ЯНДЕКС.ВЕБМАСТЕР =======================
WM = "https://api.webmaster.yandex.net/v4"

user_id = get(f"{WM}/user")["user_id"]

hosts = get(f"{WM}/user/{user_id}/hosts")["hosts"]
host = next(
    (h for h in hosts if SITE in h.get("unicode_host_url", "") or SITE in h.get("ascii_host_url", "")),
    hosts[0],
)
host_id = host["host_id"]

summary = safe(lambda: get(f"{WM}/user/{user_id}/hosts/{host_id}/summary"), {})

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

# ======================= ЯНДЕКС.МЕТРИКА =======================
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

# ======================= СОХРАНЯЕМ =======================
result = {
    "updated": datetime.datetime.now().isoformat(timespec="minutes"),
    "site": SITE,
    "sqi": summary.get("sqi"),
    "queries": queries,
    "metrika": metrika,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"✅ Готово! Запросов: {len(queries)}, Метрика: {'есть' if metrika else 'нет'}")
