# -*- coding: utf-8 -*-
from typing import List, Literal
from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.db import get_session
from app.schemas import ComparisonRowOut
from app.services.comparison import (
    build_rows_from_snapshots,
    scrape_and_snapshot,
)
from app.registry import registry
from app.models import CompetitorSite

router = APIRouter()

class ScrapeResult(BaseModel):
    written: int

@router.get("/compare", response_model=List[ComparisonRowOut])
async def api_compare(
    site_code: str,
    limit: int = Query(200, ge=1, le=2000),
    source: Literal["snapshots", "live"] = Query("snapshots")
):
    """
    Returns comparison rows.

    - source=snapshots (default): read from DB snapshots (fast).
    - source=live: run scraper now (writes snapshots) then return from snapshots.
    - site_code='<code>': single-site behavior (unchanged).
    - site_code='all': flat union of rows across *all* competitor sites (same schema).
    """
    # Single-site (legacy behavior)
    if site_code != "all":
        if source == "snapshots":
            with get_session() as session:
                return build_rows_from_snapshots(session, site_code, limit=limit)
        else:
            scraper = registry.get(site_code)
            with get_session() as session:
                await scrape_and_snapshot(session, scraper, limit=limit)
                return build_rows_from_snapshots(session, site_code, limit=limit)

    # site_code == "all" -> union
    rows: List[ComparisonRowOut] = []
    with get_session() as session:
        sites = list(session.execute(select(CompetitorSite)).scalars().all())

        if source == "live":
            # Scrape sites that have a registered scraper, then read snapshots
            for s in sites:
                try:
                    scraper = registry.get(s.code)
                except Exception:
                    continue
                await scrape_and_snapshot(session, scraper, limit=limit)

        for s in sites:
            rows.extend(build_rows_from_snapshots(session, s.code, limit=limit))

    return rows

@router.post("/compare/scrape", response_model=ScrapeResult)
async def api_compare_scrape_now(
    site_code: str,
    limit: int = Query(200, ge=1, le=2000),
):
    """
    Manually trigger scraping and snapshot writing without returning rows.
    Supports site_code='all'.
    """
    if site_code != "all":
        scraper = registry.get(site_code)
        with get_session() as session:
            written = await scrape_and_snapshot(session, scraper, limit=limit)
            return ScrapeResult(written=written)

    written_total = 0
    with get_session() as session:
        sites = list(session.execute(select(CompetitorSite)).scalars().all())
    for s in sites:
        try:
            scraper = registry.get(s.code)
        except Exception:
            continue
        with get_session() as session:
            written_total += await scrape_and_snapshot(session, scraper, limit=limit)
    return ScrapeResult(written=written_total)
