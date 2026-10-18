# yandex-dash worker

Актуальный код воркера `yandex-dash` (Cloudflare Workers): SEO-дашборды
Яндекс Метрика + Яндекс Вебмастер с админкой и cron-сбором.

## Структура

```
worker/
  src/runtime.js   служебные помощники esbuild (var __defProp/__name)
  src/yandex.js    модуль интеграции: API Яндекс Метрики (180 дней, 15 целей, топ-500 страниц)
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
2. Проверка синтаксиса: `npx wrangler deploy --dry-run` или просто сборка + `node --check dist/index.js` — выполняется командой `npm run build`, затем `node --check dist/index.js`.
3. Деплой: `npx wrangler deploy` (или `npm run deploy`). Секреты существующие сохраняются.

## Важно

- Полная документация системы: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — архитектура,
  схема базы D1, все API-маршруты, деплой, известные баги. **Прочитайте первым делом.**
- Критический фикс 18.10.2026 уже применён в `src/index.js`: функция `isDue` корректно
  парсит `last_run_at` в ISO-формате (`2026-10-13T14:02:39.497Z` — без двойного суффикса "Z").
  До фикса cron-обновления молча не срабатывали после первого обновления снапшота.
