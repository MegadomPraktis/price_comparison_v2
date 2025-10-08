# -*- coding: utf-8 -*-
from typing import List, Literal, Optional
from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.db import get_session
from app.schemas import ComparisonRowOut
from app.services.comparison import (
    build_rows_from_snapshots,
    scrape_and_snapshot,
)
from app.registry import registry

router = APIRouter()

class ScrapeResult(BaseModel):
    written: int

@router.get("/compare", response_model=List[ComparisonRowOut])
async def api_compare(
    site_code: str,
    limit: int = Query(200, ge=1, le=2000),
    source: Literal["snapshots", "live"] = Query("snapshots"),
    tag_id: Optional[int] = Query(None),
):
    """
    source=snapshots -> read from DB (fast; default)
    source=live      -> run scraper now (writes snapshots and returns fresh rows)
    """
    if source == "snapshots":
        with get_session() as session:
            return build_rows_from_snapshots(session, site_code, limit=limit, tag_id=tag_id)
    else:
        scraper = registry.get(site_code)
        with get_session() as session:
            written = await scrape_and_snapshot(session, scraper, limit=limit)
            return build_rows_from_snapshots(session, site_code, limit=limit, tag_id=tag_id)

@router.post("/compare/scrape", response_model=ScrapeResult)
async def api_compare_scrape_now(
    site_code: str,
    limit: int = Query(200, ge=1, le=2000),
):
    scraper = registry.get(site_code)
    with get_session() as session:
        written = await scrape_and_snapshot(session, scraper, limit=limit)
        return ScrapeResult(written=written)
