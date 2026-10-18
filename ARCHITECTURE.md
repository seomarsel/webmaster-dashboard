# yandex-dash — полная документация системы (handoff для ИИ)

> **Цель документа:** дать полному ИИ (OpenCode и др.) исчерпывающее описание системы дашбордов
> Яндекс Метрика + Яндекс Вебмастер: инфраструктура, код, база, деплой, известные проблемы.
> Документ написан 18.10.2026 после recovery-сессии. Все файлы «восстановления» лежат рядом.

---

## 0. Кратко (TL;DR)

**Что это:** система SEO-дашбордов для клиентов. Один Cloudflare Worker обслуживает:
- клиентские дашборды `/s/<slug>` (публичные, по ссылке),
- админку `/admin` (пароль-сессия),
- сбор данных из API Яндекс Метрики и Яндекс Вебмастера по cron каждые 15 минут,
- AI-инсайты («Выводы» на дашборде) через внешний LLM (aitunnel/gpt-5-nano) с фолбэком на Workers AI.

**Где:** Worker `yandex-dash` в аккаунте Cloudflare (`seomarsel@gmail.com's Account`, account_id `0470d79fe54db6420dd092a929a9b380`), домен `https://yandex-dash.seomarsel.workers.dev`, данные в Cloudflare D1.

**GitHub:** https://github.com/seomarsel/webmaster-dashboard — это **старая версия** (Python `fetch.py` + статичный `dashboard.html` + `data.json`). Она историческая; актуальный код — только в Worker. Исходников воркера в этом репо НЕТ.

**Пример действующего дашборда:** `https://yandex-dash.seomarsel.workers.dev/s/sskrztqnha` (сайт `руннер.рф`).

---

## 1. Инфраструктура Cloudflare (факты, проверены через API 18.10.2026)

| Сущность | Значение |
|---|---|
| Аккаунт | Seomarsel@gmail.com's Account, `0470d79fe54db6420dd092a929a9b380` |
| Worker | `yandex-dash` |
| Рабочий домен | `yandex-dash.seomarsel.workers.dev` (поддомен `seomarsel`; custom-доменов нет) |
| compatibility_date | `2026-08-01` |
| D1 база | id `61833d55-6f43-4f9b-b9ef-2155bae6526f`, регион WEUR, служит биндингом `DB` |
| Bindings | `DB` (d1), `AI` (workers ai), `ADMIN_PASSWORD` (secret), `SESSION_SECRET` (secret) |
| Cron triggers | `*/15 * * * *` (каждые 15 минут) |
| Последний деплой | 2026-09-06 08:22 UTC (через **wrangler**, автор seomarsel@gmail.com; всего 40 деплоев) |
| Размер бандла | ~197 КБ, esbuild-уровень без минификации (читаем, с комментариями `// src/...`) |

**Секреты (значения НЕ известны, только имена):** `ADMIN_PASSWORD`, `SESSION_SECRET`.
При пересборке через `wrangler secrets put` их значения сохранятся, если НЕ трогать явно.

---

## 2. Локальные файлы (папка `yandex-dash-recovered/`)

| Файл | Что это |
|---|---|
| `yandex-dash-bundle.js` | сырой multipart-ответ от CF API (`GET /workers/scripts/yandex-dash`) — архивный, правки не вносить |
| `index.js` | **исполняемый бандл для деплоя**; содержит `src/yandex.js` (стр. до 320 в бандле) + `src/index.js`. **⚠️ В этом файле применяется ВАЖНЫЙ фикс бага cron (см. §9) — ещё не задеплоен** |
| `src-yandex.js` | извлечённый модуль `src/yandex.js` — интеграция с Яндекс API (read-only копия) |
| `src-index.js` | извлечённый модуль `src/index.js` — роутинг, админка, дашборд-HTML |
| `dump-d1.mjs` | скрипт полного дампа D1 в JSON (Node, fetch; запускается `node dump-d1.mjs`) |
| `.env` | активный Cloudflare API-токен, account_id, D1 database_id, имя воркера (секрет!) |
| `START.md` | стартовый промпт для нового окна OpenCode: как подключиться и работать без контекста этой сессии |
| `.gitignore` | исключает .env и файлы с токенами из git |
| `d1-backup-full.json` | полный бэкап базы на 18.10.2026 (вкл. Yandex-токены в `sites`) |
| `snapshot-site{1,3,4}.json` | payloads снапшотов из D1 (данные контент-движка) |
| `../webmaster-dashboard/` | клон GitHub-репо (старая версия, см. §12) |

Править для новых изменений нужно **`index.js`** (единый бандл-модуль). Если он ещё не распакован у ИИ — восстановить из `yandex-dash-bundle.js`: вырезать содержимое между `Content-Disposition: form-data; name="index.js"` и финальным `--boundary--`.

---

## 3. Архитектура кода (модули бандла)

### `src/yandex.js` — сбор данных из Яндекса
Константы:
```js
DAYS = 180          // глубина периода сбора (180 дней)
MAX_GOALS = 15      // до 15 целей Метрики
MAX_PAGES = 500     // до 500 страниц за месяц
PAGE_MONTHS = [1,2,3,4]  // страницы за 4 последних полных месяца
METRIKA = "https://api-metrika.yandex.net"
WEBMASTER = "https://api.webmaster.yandex.net/v4/user"
```
Все запросы ходят заголовком `Authorization: OAuth <token>` (токен Яндекса из `sites.token`).

`collectSite(site)` формирует payload (описан в §6 «snapshots»). Последовательность:
1. `GET /management/v1/counter/{ids}/goals?useAutoGoals=true&useDirectGoals=true` → список целей, `goalMetrics` = `ym:s:goal{id}reaches`.
2. `GET /stat/v1/data` (`ym:s:visits,ym:s:users,ym:s:bounceRate`, dimension `ym:s:date`, день×день = `daily`).
3. Ещё раз с `ym:s:lastTrafficSource` → `sourcesDaily`.
4. С `ym:s:lastSearchEngineRoot` + filter `ym:s:lastTrafficSource=='organic'` → `searchDaily` (посещения/пользователи/конверсии по поисковикам).
5. С `ym:s:sumGoalReachesAny` (organic) → `searchConvDaily`.
6. Для каждого из 4 месяцев — `pagesForMonth` (`ym:s:startURL` as dimension) → `pagesMonths["YYYY-MM"] = [{url, visits, conversions}]`.
7. Вебмастер (если заполнен `host_id`): `GET /` → `user_id`, затем
   - `GET /{user_id}/hosts/{host_id}/summary/` → `webmaster = {sqi, pages_in_search, excluded_pages}`
   - `GET /{user_id}/hosts/{host_id}/search-queries/popular/?order_by=TOTAL_SHOWS&query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS` → `queries[] = {query, shows, clicks}`.
Все ошибки складываются в payload.errors и не валят процесс.

### `src/index.js` — роутинг,	auth, HTML-страницы, работа с D1, insights
- Вся админка и весь дашборд — **inline HTML-CSS-JS шаблоны внутри этого модуля** (тёмная тема, `#0f1115`). Отдельных статики/файлов нет.
- `COOKIE = "sess"`, `MAX_AGE = 604800` (7 дней).
- `html()` / `json()` — Response-хелперы, `no-store`.

#### Авторизация (важно для доработок!)
- `POST /api/login` с `{password}`: сравнивает с `env.ADMIN_PASSWORD` → выдаёт cookie `sess=ok.<exp>.<hmac_hex>`, где `sign("ok."+"exp", SESSION_SECRET)` HMAC-SHA256;
- `isLoggedIn()`: cookie `sess`, три части `[ok, exp, sig]`; проверяет `exp > now` и совпадение HMAC. В коде фолбэк: если `SESSION_SECRET` пуст, секретом считается строка `"dev"` (на практике secret задан).

#### Сессия/страницы
| Маршрут | Что |
|---|---|
| `GET /s/<slug>` | клиентский дашборд (без auth): ищет `sites` по slug, отдаёт шаблон с mode=`client` |
| `GET /api/public/data?slug=<slug>` | JSON данные дашборда (публично, по slug, `dashData` — см. §5) |
| `GET /api/public/insights?slug=<slug>` | JSON insights (публично) |
| `GET /login`, `POST /api/login`, `GET /api/logout` | логин/логаут |
| `GET /` или `/admin` | если не залогинен → 302 на `/login`; `/admin` — стр. админки, `/` — дашборд mode=`owner` (по ВСЕМ активным сайтам) |

#### /api/* (после auth-check, если не указано иное)
| Группа | Маршруты |
|---|---|
| Сайты | `GET /api/sites` (список вместе с токенами!), `POST /api/sites` (создать), `/api/sites/update`, `/api/sites/active`, `/api/sites/slug` (перегенерировать), `/api/sites/delete` (каскадно чистит snapshots/runs/etc.) |
| «Ручные» метрики | `GET /api/manual?site_id=`, `POST /api/manual` (upsert в manual_stats: y3/y10/g3/g10, top3/top10) |
| Страницы | `GET /api/pages?site_id=`, `/api/pages/add`, `/api/pages/import` (bulk), `/api/pages/comment`, `/api/pages/delete` |
| Позиции | `GET /api/positions/stats`, `POST /api/positions/upload` (bulk: engine×month×query×url×position), `POST /api/positions/delete` (site×month) |
| AI-видимость | `GET /api/ai?site_id=`, `POST /api/ai/save`, `POST /api/ai/delete` |
| Конкуренты | `GET /api/competitors/stats`, `POST /api/competitors/upload`, `POST /api/competitors/delete` |
| Промпты | `GET /api/prompts`, `POST /api/prompts/total`, `/api/prompts/add`, `/api/prompts/delete` |
| AI-движок | `GET /api/ai-engine` (текущий ai_config), `POST /api/ai-engine`, `POST /api/ai-engine/test` |
| Работы | `GET /api/done`, `POST /api/done` (done_works: месяц + текст «что сделали») |
| Выводы | `GET /api/insights?site_id=`, `POST /api/insights/generate-one`, `/api/insights/save` (ручная правка), `POST /api/insights/generate` |
| Сбор | `POST /api/refresh` (принудительный сбор через `collectAll(env, site_id?)`), `GET /api/data?site_id=` (owner-данные), `GET /api/runs` (посл. 60 запусков) |

### AI-инсайты
- `ai_config` (одна строка id=1): `provider=aitunnel`, `base_url=https://api.aitunnel.ru/v1`, token (secret-ish, лежит в D1, префикс `sk-ait…`), `model=gpt-5-nano`, `model_free=@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Workers AI — фолбэк).
- Генерация: собирает 6 ключевых таблиц дашборда (SEO-трафик, AI-видимость, конкуренты, страницы, поз. Яндекса/Google), системный промпт задаёт формат ответа: `Итог:` / `Что делаем дальше:` без вступлений, тон спокойный, только цифры из таблиц.
- Результат пишется в `insights` (JSON в `text`), модель и время сохраняются; на дашборде рендерится блоком `.ins`.

---

## 4. Страница дашборда (UI)
Единый шаблон `DASH_TEMPLATE` (инлайн HTML+JS), `dashPage(mode, slug)` подставляет `__MODE__` (`client`/`owner`) и `__SLUG__`.
frontend:
- грузит `/api/public/data?slug=...` (client) или `owner`-режиме `/api/data` (все активные сайты, селектор),
- отрисовывает блоки: сводка, графики (daily/sources/search), страницы (4 мес.), позиции (Я/Г), AI-видимость, конкуренты, промпты, «работы», «Выводы» (insights),
- данные вручную редактируются через `/admin` → табы (`#sites`, и др.), публично видит только чтение.

---

## 5. Полный маршрут `dashData(env, site)` — что видит клиент

```js
{
  site: {id, name},
  data: <snapshot payload, JSON из D1 — см. §6>,
  manual:  loadManual(env, site_id),    // manual_stats строки
  pages:   loadPages(...),              // pages + comments
  positions: loadPositions(...),        // positions по месяцам
  ai:      loadAi(...),                 // ai_visibility
  competitors: loadCompetitors(...),
  prompts: loadPrompts(...),            // + site_meta.prompts_total
  done:    loadDone(...),               // done_works
}
```

---

## 6. База D1 (биндинг `DB`): таблицы и роли

Актуальные CREATE-схемы (проверены через PRAGMA):

```sql
sites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, counter_id TEXT NOT NULL,
       host_id TEXT NOT NULL, token TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       interval_min INTEGER NOT NULL DEFAULT 60, run_hour INTEGER, last_run_at TEXT, slug TEXT)
snapshots (site_id INTEGER PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL)  -- payload = JSON collectSite
runs (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER, started_at TEXT NOT NULL DEFAULT(datetime('now')),
      status TEXT NOT NULL, message TEXT)
manual_stats (site_id INTEGER NOT NULL, month TEXT NOT NULL, top3 INTEGER, top10 INTEGER,
       y3 INTEGER, y10 INTEGER, g3 INTEGER, g10 INTEGER, PRIMARY KEY(site_id, month))
pages (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER NOT NULL, url TEXT NOT NULL, comment TEXT,
       UNIQUE(site_id, url))
positions (site_id INTEGER NOT NULL, engine TEXT NOT NULL, month TEXT NOT NULL, query TEXT NOT NULL,
       url TEXT, position INTEGER, PRIMARY KEY (site_id, engine, month, query))
ai_visibility (site_id INTEGER NOT NULL, month TEXT NOT NULL, platform TEXT NOT NULL, visibility REAL,
       PRIMARY KEY (site_id, month, platform))
competitors (site_id INTEGER, month TEXT, name TEXT, domain TEXT, queries INTEGER, share REAL, avg_pos REAL,
       category TEXT, is_our INTEGER DEFAULT 0, PRIMARY KEY (site_id, month, name))
prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, site_id INTEGER, text TEXT, UNIQUE (site_id, text))
site_meta (site_id INTEGER PRIMARY KEY, prompts_total INTEGER)
insights (site_id INTEGER PRIMARY KEY, generated_at TEXT, model TEXT, text TEXT)
ai_config (id INTEGER PRIMARY KEY, provider TEXT, base_url TEXT, token TEXT, model TEXT, model_free TEXT)
done_works (site_id INTEGER, month TEXT, text TEXT, PRIMARY KEY (site_id, month))
```

Актуальные данные (18.10.2026):

| site_id | сайт | counter_id | host_id | interval_min | run_hour | slug | последний запуск |
|---|---|---|---|---|---|---|---|
| 1 | xeniabaranova.ru | 109096235 | https:xeniabaranova.ru:443 | 15 | NULL | `6zzn56xujbty` | 2026-09-01 (застыл из-за бага cron) |
| 3 | mybotica.pro | 109364832 | — | 15 | 7 | `zwt98zmy4p` | 2026-09-04 (там же) |
| 4 | руннер.рф | 43608079 | — | 60 | 7 | `sskrztqnha` | 2026-10-13 (вручную) |

У всех `token` — Yandex OAuth токен вида `y0__…` (54 симв.), лежит в D1 **в открытом виде** — бэкап `d1-backup-full.json` хранит их тоже (файл чувствительный, не расшарить).

Снапшот payload (`snapshots.payload`) — JSON от `collectSite`:
```
{ name, counter_id, host_id, period:"YYYY-MM-DD — YYYY-MM-DD", updated_at,
  errors:[], goals:[{id,name}], daily:[{date,visits,users,bounce}],
  sourcesDaily:[{date,source,visits,users}], searchDaily:[{date,engine,visits,users,conversions}],
  searchConvDaily:[{date,conversions}], pagesMonths:{"YYYY-MM":[{url,visits,conversions}]},
  webmaster:{sqi, pages_in_search, excluded_pages}, queries:[{query,shows,clicks}] }
```
Размеры снапшотов: site1 ≈ 272 КБ, site3 ≈ 21 КБ, site4 ≈ 336 КБ.

---

## 7. Cron-поток (scheduled)

Каждые 15 мин Cloudflare вызывает `scheduled()`:
```js
async scheduled(event, env, ctx) {
  ctx.waitUntil(collectAll(env));
}
```
`collectAll(env, siteId?)`:
1. `SELECT * FROM sites WHERE active = 1` (или по site_id, если это ручной `/api/refresh`);
2. для каждого, где `isDue(site, now)`:
   - `collectSite(site)` → сохранить/обновить `snapshots` payload;
   - впоследствии всегда: `INSERT INTO runs` (status ok/partial/error) + `UPDATE sites.last_run_at`;
3. удалить старые runs, оставив 300.

`isDue`:
```js
interval = site.interval_min || 60;
if (interval >= 1440 && site.run_hour != null)   // раз в сутки в заданный час (колонка run_hour, время в UTC+5)
    { запуск, если час совпал и предыдущий запуск был более 20 ч назад }
if (!site.last_run_at) return true;
passed = (now - new Date(site.last_run_at + "Z"))/60000;
return passed >= interval - 1;
```

---

## 8. ⚠️ ИЗВЕСТНЫЙ КРИТИЧЕСКИЙ БАГ (найден 18.10.2026) — cron «умирает»

Январский формат хранения: старые строки `last_run_at` имеют SQLite-вид (`"2026-08-28 05:45:24"`), а после объединения все записи обновляются как ISO со временем `toISOString()`, который **уже содержит `Z`**: `"2026-10-13T14:02:39.497Z"`.

`isDue` делает `new Date(site.last_run_at + "Z")` → `"….ZZ"` → Invalid Date → все вычисления `NaN` → `isDue` возвращает `false` навсегда → **ни один сайт никогда не «подходит» по расписанию после первого же обновления**. Cron работает (галочка активна, высокие вызовы: ~96–99 инвокаций/день по GraphQL), но `collectAll` молча пропускает всё (isDue = false), из-за чего в `runs` после 13.10 записи паттернов нет вовсе.

Проявление на живой системе: дашборды выглядят «живыми», пока payload в `snapshots` не устареет; обновление dataset'ов возможно только кнопкой «Обновить» из админки (ручной `POST /api/refresh` идёт по site_id и не зависит от isDue). Поэтому сайт 4 обновлялся 13.10 вручную, а 1 и 3 — застыли 01.09/04.09.

**Фикс (применён в локальном `index.js`, НЕ задеплоен):**
```js
// было:
const last2 = new Date(site.last_run_at + "Z");
// стало:
const lastRaw = site.last_run_at || "";
const last2 = new Date(/[zZ]$/.test(lastRaw) ? lastRaw : lastRaw + "Z");
```
то же самое в ветке `< 1440`:
```js
const lastRaw = site.last_run_at;
const last = new Date(/[zZ]$/.test(lastRaw) ? lastRaw : lastRaw + "Z");
```
Проверено `node --check index.js` → OK. Задача деплоя — см. «Технические долги» в конце и §10.

---

## 9. GitHub-старая версия (webmaster-dashboard)

`https://github.com/seomarsel/webmaster-dashboard` (**публичный**, last push 10.10.2026):
```
README.md      «Дашборд Яндекс.Вебмастер и Метрика»
fetch.py       Питон: METRIKA_COUNTER env → api-metrika (stat/v1/data, stat/v1/data/bytime),
               api.webmaster (v4), пишет data.json. Ежедневно запускается GitHub Action
               .github/workflows/update.yml (cron 0 6 * * * UTC) с секретами
               YANDEX_TOKEN / METRIKA_COUNTER; сайт в workflow захардкожен: igear-shop.ru
dashboard.html статичный HTML, читает data.json
data.json      последний собранный результат
```
Понимание: это «исходная версия v0», она всё ещё работает через GitHub Actions —
файлы fetch.py/dashboard.html/data.json в корне репо можно оставить как есть.
Cloudflare-Worker — v1, развитие той же логики.

**Актуальный код воркера залит в репо** в папку `worker/` (18.10.2026):
- `worker/src/{runtime,yandex,index}.js` — собранный бандл разделён на 3 модуля по границам esbuild;
- `worker/build.mjs` — сборка `dist/index.js` (проверяется байт-в-байт против прод-бандла);
- `worker/wrangler.toml` + `package.json` — деплой через `npm run deploy`;
- `worker/README.md` — быстрый старт;
- `ARCHITECTURE.md` — этот документ (копия в корне репо).

---

## 10. Деплой / развёртывание с нуля (после переноса на ноутбук)

1. **Установить wrangler:**
   `npm i -g wrangler` (нужен Node ≥ 20). На Windows, если `npx` блокируется политикои PS, запускать из cmd (`npx.cmd`) либо `Set-ExecutionPolicy -Scope Process Bypass`.
2. **Проект:**
   ```
   yandex-dash/
     index.js         ← правленный бандл (❗ см. фикс isDue §8)
     wrangler.toml
   ```
3. **wrangler.toml:**
   ```toml
   name = "yandex-dash"
   main = "index.js"
   compatibility_date = "2026-08-01"
   account_id = "0470d79fe54db6420dd092a929a9b380"

   [[d1_databases]]
   binding = "DB"
   database_name = "yandex-dash-db"
   database_id  = "61833d55-6f43-4f9b-b9ef-2155bae6526f"

   [ai]
   binding = "AI"

   [triggers]
   crons = ["*/15 * * * *"]
   ```
4. **Аунтентикация:** `wrangler login` (браузер) или `CLOUDFLARE_API_TOKEN=<токен>` (шаблон Edit Cloudflare Workers: Workers Scripts:Edit, KV:Edit, D1:Edit, Workers Routes:Edit, Workers Builds, Observability, Pages…).
5. **Секреты (если пропали/восстановить):**
   `wrangler secret put ADMIN_PASSWORD` и `wrangler secret put SESSION_SECRET` (произвольная секретная строка; для SESSION_SECRET лучше случайные 32 hex-символа). Существующие секреты **переживают** обычный `wrangler deploy`.
6. **Деплой:** `wrangler deploy` — заменит текущий код воркера в Cloudflare на наш бандл.
7. **Проверка cron:** после деплоя, через 15–20 мин: `SELECT id, status, started_at, message FROM runs ORDER BY id DESC LIMIT 5` (через `wrangler d1 execute`) — должны появиться свежие `status=ok` и обновиться `last_run_at` по всем активным сайтам.

**Альтернатива деплоя без wrangler (через API):** собрать multipart с двумя частями — `metadata` и файл `index.js` — и сделать `PUT /accounts/{acc}/workers/scripts/yandex-dash` с `Content-Type: multipart/form-data`. В metadata-части обязательно указать `main_module`, `compatibility_date` и все биндинги (`DB` d1, `AI` ai, `ADMIN_PASSWORD` и `SESSION_SECRET` — как secret_text, значения не передаются, привязки сохранятся), иначе биндинги сбрасываются. Метаданные: `{"main_module":"index.js","compatibility_date":"2026-08-01","bindings":[{"type":"d1","name":"DB","id":"61833d55-6f43-4f9b-b9ef-2155bae6526f"},{"type":"ai","name":"AI"},{"type":"secret_text","name":"ADMIN_PASSWORD"},{"type":"secret_text","name":"SESSION_SECRET"}]}` — для secret_text допустимо передать пустые `"text"` (сохранив Привязку). После проверить `GET …/workers/scripts/yandex-dash/settings` → биндинги на месте.

---

## 11. Как ИИ может соединиться с этой системой снова (быстрый вход)

**Токен и идентификаторы лежат в `.env` рядом с этим документом** (см. §2 список файлов):
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `WORKER_NAME`, `GITHUB_USER/GITHUB_REPO`.
Прочитать его перед работой: `node -e "..."` или просто прочитать файл `.env`.

- **Cloudflare API** (`Authorization: Bearer <token>`, base `https://api.cloudflare.com/client/v4`):
  - `GET  /accounts/{acc}/workers/scripts` — список воркеров;
  - `GET  /accounts/{acc}/workers/scripts/yandex-dash` — код бандла (multipart! разобрать);
  - `GET  /accounts/{acc}/workers/scripts/yandex-dash/settings` — биндинги/compat;
  - `GET  /accounts/{acc}/workers/scripts/yandex-dash/schedules` — кроны;
  - `POST /accounts/{acc}/d1/database/61833d55-…/query` `{"sql": …}` — SQL;
  - `GET  /accounts/{acc}/workers/domains` — домены.
  Права токена (одноразовый recovery): Workers Scripts/Edit, KV Edit/Read, R2 Edit, Pages Edit, Workers Builds Config Edit, Workers Observability Edit, Containers Edit, Workers Routes Edit (All zones), Account Settings Read, Workers Tail Read, D1 Edit (добавлен отдельно 18.10.2026), User Details Read, Memberships Read.
- **GitHub:** аккаунт `seomarsel` (https://github.com/seomarsel), ключевой репо `webmaster-dashboard` — **публичный**, токен не нужен; клонировать просто `git clone https://github.com/seomarsel/webmaster-dashboard.git`

---

## 12. Чего НЕ восстановлено / к каким рискам готовиться

- **ADMIN_PASSWORD** — значение неизвестно и невосстановимо (это secret CF). Если нужно установить заново: `wrangler secret put ADMIN_PASSWORD` (просто задаёт новое значение).
- **SESSION_SECRET** — аналогично; но при смене все открытые сессии инвалидируются (безопасно, придётся перелогиниться).
- **Yandex OAuth tokens** в `sites.token`: 54 симв., формат `y0__…`, обычно бессрочные, но могут быть отозваны с аккаунтов Яндекса → при 401 от api-metrika нужно получить новый токен (OAuth-токен Метрики) и вписать в админке или через D1.
- **cron-баг** — главный критический дефект: без деплоя фикса (§8) дашборды живут, пока payload не устареет. **Фикс применён только в локальном `index.js`** — осталось задеплоить.

---

## 13. Полезные команды

```
# вся работа — в папке yandex-dash-recovered/
node dump-d1.mjs            # пересобрать полный бэкап D1 (устаревает!)
node --check index.js       # проверить синтаксис перед деплоем
wrangler deploy             # выкатить исправленный worker
# или API-методом, см. §10
```

---

## 14. Резюме для ИИ, который читает это впервые

1. Система жива: worker `yandex-dash` в Cloudflare (аккаунт seomarsel@gmail.com), D1 `61833d55-…`, cron `*/15 * * * *`, URL `https://yandex-dash.seomarsel.workers.dev`.
2. Актуальный код = локальный `index.js` (бандл из двух модулей). `src-yandex.js` и `src-index.js` — читаемые проекции, идентичные по логике; правки вносить в `index.js`.
3. Данные: D1 13 таблиц (§6), полный бэкап в `d1-backup-full.json`. Yandex OAuth-токены хранятся в `sites.token` в открытом виде.
4. Критический баг cron (§8): `isDue` ломается на suffix `Z` → сайты ни дешевле 24 ч не обновляются. Фикс уже в `index.js`, НЕ требуется дополнительной правки кода — нужен только деплой (§10).
5. Клиентские дашборды публичны по slug; админка защищена `ADMIN_PASSWORD` (значение неизвестно, можно сбросить через `wrangler secret put`).
6. GitHub-репо `webmaster-dashboard` — старая версия (Python), актуального кода воркера в нём нет; можно залить архив.
