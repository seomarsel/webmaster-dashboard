# webmaster-dashboard

Два поколения одного проекта (дашборды Яндекс Метрика + Вебмастер):

- **`worker/`** — актуальная версия: Cloudflare Worker `yandex-dash`
  (дашборды `/s/<slug>`, админка `/admin`, cron-сбор каждые 15 минут,
  Cloudflare D1, AI-инсайты). Полная документация — [`ARCHITECTURE.md`](ARCHITECTURE.md).
  Сайт: `https://yandex-dash.seomarsel.workers.dev`.

- **корень репо** — первая версия: GitHub Actions (`update.yml`, ежедневно 06:00 UTC)
  запускает `fetch.py` (Python) с секретами `YANDEX_TOKEN` / `METRIKA_COUNTER`,
  обновляет `data.json` для сайта `igear-shop.ru`; `dashboard.html` читает его статику.
  ⚠️ Файлы корня не переносить — сломается действие.

## Быстрый старт с worker/

```
cd worker
npm i
npm run deploy     # сборка dist/index.js + wrangler deploy
```

Секреты админки хранятся в Cloudflare (`ADMIN_PASSWORD`, `SESSION_SECRET`)
и при деплоях сохраняются.
