# Price Compare Service

Run once:
- Open in IDE, run `app/main.py`
- UI at `http://127.0.0.1:8001/app/index.html`

Pages:
- `matching.html` – manual/auto matching (barcode) per site
- `comparison.html` – live competitor scrape + price highlight
- `erp.html` – upload ERP XML

Backend:
- Routers per page (`app/routers/*`), services per feature, pluggable scrapers via `registry.py`.
- Add a site: create `app/scrapers/<site>.py` (implements `BaseScraper`), then `registry.register("<code>", Scraper())`.

DB:
- SQLite by default (`data.sqlite3`). For Postgres: set `DATABASE_URL=postgresql+asyncpg://user:pass@host/db`.

- TO DO://
- Adding margin to analytics
- fixing scrape and refresh buttons to be only on showed items and doing all records if endpoint is called
- fixing what is shown on the page with how many pages and records visualization
- email functionality rework
- Fixing the input of praktis data, reworking the endpoints
- aligning the promo price for products in the comparison tab
- Fixing the category menu layout