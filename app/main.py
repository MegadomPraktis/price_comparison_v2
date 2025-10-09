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
from app.registry import register_default_scrapers

app = FastAPI(title="Price Compare Service (MSSQL)", version="0.4.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_headers=["*"],
    allow_methods=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/app", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

# Routers
app.include_router(r_sites.router, prefix="/api", tags=["sites"])
app.include_router(r_products.router, prefix="/api", tags=["products"])
app.include_router(r_matching.router, prefix="/api", tags=["matching"])
app.include_router(r_comparison.router, prefix="/api", tags=["comparison"])
app.include_router(r_erp.router, prefix="/api", tags=["erp"])
app.include_router(r_tags.router, prefix="/api", tags=["tags"])

@app.on_event("startup")
def startup():
    init_db()
    register_default_scrapers()
    from sqlalchemy import select
    from app.models import CompetitorSite
    with get_session() as session:
        # Praktiker
        site = session.execute(select(CompetitorSite).where(CompetitorSite.code == "praktiker")).scalars().first()
        if not site:
            session.add(CompetitorSite(code="praktiker", name="Praktiker", base_url="https://praktiker.bg"))
            session.commit()

        # Mr. Bricolage
        mrb = session.execute(select(CompetitorSite).where(CompetitorSite.code == "mrbricolage")).scalars().first()
        if not mrb:
            session.add(CompetitorSite(code="mrbricolage", name="Mr. Bricolage", base_url="https://mr-bricolage.bg"))
            session.commit()

        # ✅ MashiniBG
        mash = session.execute(select(CompetitorSite).where(CompetitorSite.code == "mashinibg")).scalars().first()
        if not mash:
            session.add(CompetitorSite(code="mashinibg", name="MashiniBG", base_url="https://www.onlinemashini.bg"))
            session.commit()

@app.get("/", response_class=HTMLResponse)
def root():
    return """<html><head><meta http-equiv="refresh" content="0; url=/app/index.html" /></head>
<body>Go to <a href="/app/index.html">UI</a></body></html>"""

if __name__ == "__main__":
    import uvicorn, os
    host = os.getenv("APP_HOST", "127.0.0.1")
    port = int(os.getenv("APP_PORT", "8001"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)
