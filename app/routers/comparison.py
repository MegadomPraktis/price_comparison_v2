# -*- coding: utf-8 -*-
from __future__ import annotations
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.services import comparison as svc

router = APIRouter()

# ----------------------- Core data for comparison -----------------------
@router.get("/compare")
def get_compare_rows(
    site_code: str = Query(..., description="Site code or 'all'"),
    limit: int = Query(2000, ge=1, le=10000),
    source: str = Query("snapshots"),
    q: str | None = Query(None),
    tag_id: str | None = Query(None),
    brand: str | None = Query(None),
    category_id: int | None = Query(None, description="ERP group/category id (root or leaf)"),
    db: Session = Depends(get_db),
):
    """
    Returns flat rows for the comparison table. UNMATCHED products are skipped.
    """
    return svc.build_rows_from_snapshots(
        session=db,
        site_code=site_code,
        limit=limit,
        source=source,
        q=q,
        tag_id=tag_id,
        brand=brand,
        category_id=category_id,
    )

# ----------------------- NEW: filtered scrape (first page, <=50) -----------------------
@router.post("/compare/scrape/filtered")
async def scrape_filtered(
    site_code: str = Query(..., description="Single site code to scrape"),
    q: str | None = Query(None),
    tag_id: str | None = Query(None),
    brand: str | None = Query(None),
    category_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=50, description="Hard capped at 50"),
    db: Session = Depends(get_db),
):
    """
    Scrape ONLY the currently visible first-page items for the selected site,
    honoring the same filters as the UI. Maximum of 50.
    """
    return await svc.scrape_filtered(
        session=db,
        site_code=site_code,
        q=q,
        tag_id=tag_id,
        brand=brand,
        category_id=category_id,
        limit=limit,
    )

# ----------------------- NEW: nightly mass scrape (all sites) -----------------------
@router.post("/compare/scrape/all")
async def scrape_all_nightly(
    db: Session = Depends(get_db),
):
    """
    Nightly cronjob: scrape all matched products across all registered sites concurrently.
    Returns counts for visibility; safe to call from a scheduler.
    """
    return await svc.scrape_all(session=db)

# ----------------------- Price history for charts (preserved) -----------------------
@router.get("/compare/history")
def price_history(
    product_sku: str = Query(...),
    site_code: str | None = Query(None, description="Optional site to narrow charts"),
    db: Session = Depends(get_db),
):
    prod, data = svc.get_history_for_product(db, site_code or "", product_sku)
    if not prod:
        return {"ok": False, "error": "Product not found"}
    # serialize snapshots simply
    out = {}
    for code, snaps in data.items():
        out[code] = [
            {
                "ts": s.ts.isoformat(),
                "regular": s.regular_price,
                "promo": s.promo_price,
                "label": s.competitor_label,
            }
            for s in snaps
        ]
    return {"ok": True, "product": {"sku": prod.sku, "name": prod.name}, "series": out}
