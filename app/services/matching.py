# -*- coding: utf-8 -*-
from typing import List, Optional
from sqlalchemy import select, func, and_
from sqlalchemy.orm import aliased
from datetime import datetime

from app.models import Product, Match, CompetitorSite, PriceSnapshot
from app.schemas import MatchOut, MatchCreate
from app.scrapers.base import BaseScraper

def list_products_simple(session, page: int, page_size: int, q: Optional[str]) -> List[Product]:
    stmt = select(Product).order_by(Product.id.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            (Product.sku.ilike(like)) |
            (Product.name.ilike(like)) |
            (Product.barcode.ilike(like))
        )
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    res = session.execute(stmt)
    return res.scalars().all()

def get_site(session, site_code: str) -> CompetitorSite:
    r = session.execute(select(CompetitorSite).where(CompetitorSite.code == site_code))
    site = r.scalars().first()
    if not site:
        raise ValueError(f"Unknown site code: {site_code}")
    return site

def list_matches(session, site_code: str, page: int, page_size: int) -> List[MatchOut]:
    site = get_site(session, site_code)
    stmt = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id)
        .order_by(Match.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    res = session.execute(stmt)
    out: List[MatchOut] = []
    for m, p in res.all():
        out.append(MatchOut(
            id=m.id,
            product_id=p.id,
            site_code=site_code,
            competitor_sku=m.competitor_sku,
            competitor_barcode=m.competitor_barcode,
            product_sku=p.sku,
            product_barcode=p.barcode,
            product_name=p.name,
            competitor_name=None,
            competitor_url=None,
        ))
    return out

def create_or_update_match(session, payload: MatchCreate) -> MatchOut:
    site = get_site(session, payload.site_code)
    r = session.execute(select(Match).where(Match.product_id == payload.product_id, Match.site_id == site.id))
    m = r.scalars().first()
    rp = session.execute(select(Product).where(Product.id == payload.product_id))
    p = rp.scalars().first()
    if not p:
        raise ValueError("Product not found")

    if m:
        m.competitor_sku = payload.competitor_sku
        m.competitor_barcode = payload.competitor_barcode
        m.updated_at = datetime.utcnow()
    else:
        m = Match(
            product_id=p.id, site_id=site.id,
            competitor_sku=payload.competitor_sku,
            competitor_barcode=payload.competitor_barcode
        )
        session.add(m)
    session.commit()
    session.refresh(m)
    return MatchOut(
        id=m.id, product_id=p.id, site_code=payload.site_code,
        competitor_sku=m.competitor_sku, competitor_barcode=m.competitor_barcode,
        product_sku=p.sku, product_barcode=p.barcode, product_name=p.name,
        competitor_name=None, competitor_url=None
    )

async def auto_match_for_site(session, scraper: BaseScraper, limit: int = 100) -> tuple[int, int]:
    site = get_site(session, scraper.site_code)
    sub = select(Match.product_id).where(Match.site_id == site.id)
    stmt = (
        select(Product)
        .where(Product.barcode.is_not(None), Product.id.not_in(sub))
        .order_by(Product.id.desc()).limit(limit)
    )
    res = session.execute(stmt)
    products = res.scalars().all()

    attempted = 0
    found = 0
    for p in products:
        attempted += 1
        sres = await scraper.search_by_barcode(p.barcode)
        if sres and (sres.competitor_sku or sres.competitor_barcode):
            m = Match(
                product_id=p.id, site_id=site.id,
                competitor_sku=sres.competitor_sku,
                competitor_barcode=sres.competitor_barcode,
            )
            session.add(m)
            found += 1
    if attempted:
        session.commit()
    return attempted, found

# NEW: bulk lookup with latest snapshot URL/Name (prefers SKU snapshot, else barcode)
def get_matches_for_product_ids(session, site_code: str, product_ids: List[int]) -> List[MatchOut]:
    if not product_ids:
        return []
    site = get_site(session, site_code)

    # base: matches + products for this page
    base = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id, Match.product_id.in_(product_ids))
    ).subquery()

    # latest-by-sku and latest-by-barcode subqueries
    latest_by_sku = (
        select(
            PriceSnapshot.competitor_sku.label("key_sku"),
            func.max(PriceSnapshot.ts).label("max_ts")
        )
        .where(PriceSnapshot.site_id == site.id, PriceSnapshot.competitor_sku.is_not(None))
        .group_by(PriceSnapshot.competitor_sku)
        .subquery()
    )
    latest_by_bar = (
        select(
            PriceSnapshot.competitor_barcode.label("key_bar"),
            func.max(PriceSnapshot.ts).label("max_ts")
        )
        .where(PriceSnapshot.site_id == site.id, PriceSnapshot.competitor_barcode.is_not(None))
        .group_by(PriceSnapshot.competitor_barcode)
        .subquery()
    )
    SnapSKU = aliased(PriceSnapshot)
    SnapBAR = aliased(PriceSnapshot)

    q = (
        select(
            base.c.id.label("match_id"),
            base.c.product_id,
            base.c.competitor_sku,
            base.c.competitor_barcode,
            base.c.sku.label("product_sku"),
            base.c.barcode.label("product_barcode"),
            base.c.name.label("product_name"),
            func.coalesce(SnapSKU.name, SnapBAR.name).label("snap_name"),
            func.coalesce(SnapSKU.url,  SnapBAR.url).label("snap_url"),
        )
        .join(latest_by_sku, latest_by_sku.c.key_sku == base.c.competitor_sku, isouter=True)
        .join(
            SnapSKU,
            and_(
                SnapSKU.site_id == site.id,
                SnapSKU.competitor_sku == latest_by_sku.c.key_sku,
                SnapSKU.ts == latest_by_sku.c.max_ts,
            ),
            isouter=True
        )
        .join(latest_by_bar, latest_by_bar.c.key_bar == base.c.competitor_barcode, isouter=True)
        .join(
            SnapBAR,
            and_(
                SnapBAR.site_id == site.id,
                SnapBAR.competitor_barcode == latest_by_bar.c.key_bar,
                SnapBAR.ts == latest_by_bar.c.max_ts,
            ),
            isouter=True
        )
    )

    out: List[MatchOut] = []
    for row in session.execute(q).all():
        out.append(MatchOut(
            id=row.match_id,
            product_id=row.product_id,
            site_code=site_code,
            competitor_sku=row.competitor_sku,
            competitor_barcode=row.competitor_barcode,
            product_sku=row.product_sku,
            product_barcode=row.product_barcode,
            product_name=row.product_name,
            competitor_name=row.snap_name,
            competitor_url=row.snap_url,
        ))
    return out
