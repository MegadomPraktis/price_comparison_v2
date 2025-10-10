# -*- coding: utf-8 -*-
from typing import List, Literal, Optional
from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.db import get_session
from app.services.comparison import (
    build_rows_from_snapshots,
    scrape_and_snapshot,
)
from app.registry import registry
from app.models import CompetitorSite

router = APIRouter()


class ScrapeResult(BaseModel):
    written: int


@router.get("/compare")  # keep open dicts so extra fields (brand/tags) survive
async def api_compare(
    site_code: str = Query("all", description="competitor code or 'all'"),
    limit: int = Query(200, ge=1, le=2000),
    source: Literal["snapshots", "live"] = Query("snapshots"),
    q: Optional[str] = Query(None, description="Search SKU/Barcode/Name"),
    tag_id: Optional[str] = Query(None),  # accept as str; cast later for safety
    brand: Optional[str] = Query(None, description="Case-insensitive; dots/spaces ignored"),
    price_filter: Optional[Literal["ours_lower", "ours_higher"]] = Query(
        None,
        description="Server-side price filter; ignores N/A competitor prices.",
    ),
):
    """
    Comparison rows:
      - 'snapshots' (default): read from DB
      - 'live'     : scrape then read from DB
      - 'all' site: union across all competitor sites
      - Filters: q, tag_id, brand (brand normalize like Matching)
      - Optional price_filter: ours_lower / ours_higher (N/A ignored)
    """
    # Normalize tag_id to int if provided
    tag_id_int: Optional[int] = None
    if tag_id not in (None, "", "all"):
        try:
            tag_id_int = int(tag_id)
        except ValueError:
            tag_id_int = None  # ignore bad value

    # Scrape first if requested
    if source == "live":
        if site_code == "all":
            with get_session() as session:
                sites = list(session.execute(select(CompetitorSite)).scalars().all())
            for s in sites:
                try:
                    scraper = registry.get(s.code)
                except Exception:
                    continue
                with get_session() as session:
                    await scrape_and_snapshot(session, scraper, limit=limit)
        else:
            scraper = registry.get(site_code)
            with get_session() as session:
                await scrape_and_snapshot(session, scraper, limit=limit)

    # Build rows (pre-filtered by q/tag/brand). Only matched items are returned.
    rows: List[dict] = []
    if site_code == "all":
        with get_session() as session:
            sites = list(session.execute(select(CompetitorSite)).scalars().all())
        for s in sites:
            with get_session() as session:
                rows.extend(
                    build_rows_from_snapshots(
                        session,
                        site_code=s.code,
                        limit=limit,
                        q=q,
                        tag_id=tag_id_int,
                        brand=brand,
                    )
                )
        if price_filter:
            rows = _apply_price_filter(rows, mode=price_filter, all_sites=True)
    else:
        with get_session() as session:
            rows = build_rows_from_snapshots(
                session,
                site_code=site_code,
                limit=limit,
                q=q,
                tag_id=tag_id_int,
                brand=brand,
            )
        if price_filter:
            rows = _apply_price_filter(rows, mode=price_filter, all_sites=False)

    return rows


def _apply_price_filter(rows: List[dict], mode: Literal["ours_lower", "ours_higher"], all_sites: bool) -> List[dict]:
    """
    - all_sites=True: group by product_sku; compare ours to MIN competitor price across sites
    - all_sites=False: compare ours to that site's competitor price
    Ignore rows where a comparable price is missing (N/A).
    """
    from collections import defaultdict

    def eff(promo, regular):
        return promo if promo is not None else regular

    if not all_sites:
        out = []
        for r in rows:
            ours = eff(r.get("product_price_promo"), r.get("product_price_regular"))
            comp = eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
            if comp is None or ours is None:
                continue
            if mode == "ours_lower" and ours < comp:
                out.append(r)
            elif mode == "ours_higher" and ours > comp:
                out.append(r)
        return out

    groups = defaultdict(list)
    for r in rows:
        groups[r.get("product_sku")].append(r)

    out = []
    for sku, grp in groups.items():
        ours_val = None
        for r in grp:
            ours_val = eff(r.get("product_price_promo"), r.get("product_price_regular"))
            if ours_val is not None:
                break
        if ours_val is None:
            continue

        comps = []
        for r in grp:
            comp_val = eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
            if comp_val is not None:
                comps.append(comp_val)
        if not comps:
            continue

        min_comp = min(comps)
        if mode == "ours_lower" and ours_val < min_comp:
            out.extend(grp)
        elif mode == "ours_higher" and ours_val > min_comp:
            out.extend(grp)
    return out


@router.post("/compare/scrape", response_model=ScrapeResult)
async def api_compare_scrape_now(
    site_code: str,
    limit: int = Query(200, ge=1, le=2000),
):
    """
    Manual scrape trigger. Supports site_code='all'.
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
