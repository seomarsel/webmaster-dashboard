# yandex-dash worker

Актуальный код воркера `yandex-dash` (Cloudflare Workers): SEO-дашборды
Яндекс Метрика + Яндекс Вебмастер с админкой и cron-сбором.

## Структура

```
worker/
  src/runtime.js   служебные помощники esbuild (var __defProp/__name)
  src/yandex.js    модуль интеграции: API Яндекс Метрики (180 дней, 50 целей, топ-500 страниц,
                   ежедневные ряды: sources/search/conversions/цели/браузеры(+версии)/устройства/разрешения)
                   и Яндекс Вебмастера (summary + search-queries)
  src/index.js     модуль: роутинг, авторизация (HMAC cookie sess), админка, дашборд,
                   работа с D1, AI-инсайты, scheduled(cron)
  build.mjs        сборка prod-бандла dist/index.js (конкатенация — идентичный esbuild-бандлу результат)
  wrangler.toml    конфиг деплоя (D1-база DB, AI-биндинг, cron */15 * * * *)
  package.json     скрипты build/check/deploy
dist/              собранный бандл (не в git; создаётся build.mjs)
```

## Разработка

1. Правки вносятся в **`src/yandex.js`** или **`src/index.js`** (в бандле они размечены
   комментариями `// src/yandex.js` / `// src/index.js` — это границы сборки).
2. Сборка и проверка: `npm run build` (или `node build.mjs`), затем `node --check dist/index.js`.
3. Рабочий деплой-флоу (используется фактически, 19.10.2026): скопировать
   `dist/index.js` в `../../yandex-dash-recovered/index.js` и из этой папки выполнить
   `node deploy-prod.mjs` — токен живёт в её `.env`; скрипт делает multipart-PUT через
   Cloudflare API, биндинги (`DB`, `AI`) и секреты (`ADMIN_PASSWORD`, `SESSION_SECRET`)
   сохраняются, в конце — проверки (`prodBindings`, `liveCheck`). После любого изменения
   инлайн-скриптов дашборда проверить живой JS: `node dump-live-scripts.mjs` +
   `node --check live-script-0.js` (файлы удалить).
4. `npx wrangler deploy` тоже работает, но основной путь — скрипт выше.
5. Инлайн-скрипты шаблонов: строки, содержащие `"` внутри атрибутов, оборачивать в
   одинарные кавычки (`'<th class="num">…</th>'`) — бандл-шаблон это JS-строка, `\"`
   в ней ломает живой скрипт (ловили 19.10.2026).

## Важно

- Полная документация системы: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — архитектура,
  схема базы D1, все API-маршруты, деплой, известные баги. **Прочитайте первым делом.**
- Критический фикс 18.10.2026 уже применён в `src/index.js`: функция `isDue` корректно
  парсит `last_run_at` в ISO-формате (`2026-10-13T14:02:39.497Z` — без двойного суффикса "Z").
  До фикса cron-обновления молча не срабатывали после первого обновления снапшота.
