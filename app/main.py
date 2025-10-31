#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()  # load .env early

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db, get_session
from app.routers import sites as r_sites
from app.routers import products as r_products
from app.routers import matching as r_matching
from app.routers import comparison as r_comparison
from app.routers import erp as r_erp
from app.routers import tags as r_tags
from app.routers import praktis_assets as r_assets   # existing
from app.routers import email as r_email
from app.routers import export as r_export
# NEW: analytics router
from app.routers import analytics as r_analytics
from app.routers import groups as r_groups


from app.registry import register_default_scrapers

app = FastAPI(title="Price Compare Service (MSSQL)", version="0.5.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["*"],
    allow_methods=["*"],
)

# Resolve frontend dir robustly (no more 404 for styles.css)
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

# Routers
app.include_router(r_sites.router, prefix="/api", tags=["sites"])
app.include_router(r_products.router, prefix="/api", tags=["products"])
app.include_router(r_matching.router, prefix="/api", tags=["matching"])
app.include_router(r_comparison.router, prefix="/api", tags=["comparison"])
app.include_router(r_erp.router, prefix="/api", tags=["erp"])
app.include_router(r_tags.router, prefix="/api", tags=["tags"])
app.include_router(r_assets.router, prefix="/api", tags=["praktis-assets"])
app.include_router(r_email.router, prefix="/api", tags=["email"])
app.include_router(r_export.router, prefix="/api", tags=["export"])
# NEW
app.include_router(r_analytics.router, prefix="/api", tags=["analytics"])
app.include_router(r_groups.router,     prefix="/api", tags=["groups"])

@app.on_event("startup")
def startup():
    # 1) Ensure tables exist
    init_db()
    # 2) Register scrapers
    register_default_scrapers()
    # 3) Seed competitor sites we rely on, including 'praktis' (for orange line)
    from sqlalchemy import select
    from app.models import CompetitorSite
    with get_session() as session:
        def ensure(code, name, base):
            exists = session.execute(select(CompetitorSite).where(CompetitorSite.code == code)).scalars().first()
            if not exists:
                session.add(CompetitorSite(code=code, name=name, base_url=base))
                session.commit()
        ensure("praktiker",    "Praktiker",     "https://praktiker.bg")
        ensure("mrbricolage",  "Mr. Bricolage", "https://mr-bricolage.bg")
        ensure("mashinibg",    "OnlineMashini", "https://www.onlinemashini.bg")
        # NEW: treat our own prices as a "site" so we can draw an orange line
        ensure("praktis",      "Praktis",       "https://praktis.bg")

@app.get("/", response_class=HTMLResponse)
def root():
    return """<html><head><meta http-equiv="refresh" content="0; url=/app/index.html" /></head>
<body>Go to <a href="/app/index.html">UI</a></body></html>"""

if __name__ == "__main__":
    import uvicorn, os
    host = os.getenv("APP_HOST", "127.0.0.1")
    port = int(os.getenv("APP_PORT", "8001"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
