# -*- coding: utf-8 -*-
from typing import List, Optional
from sqlalchemy import select
from datetime import datetime

from app.models import Product, Match, CompetitorSite
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
        product_sku=p.sku, product_barcode=p.barcode, product_name=p.name
    )

async def auto_match_for_site(session, scraper: BaseScraper, limit: int = 100) -> tuple[int, int]:
    """Async because we await scraper; DB ops remain sync."""
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

# NEW: bulk lookup to prefill competitor fields in the matching grid
def get_matches_for_product_ids(session, site_code: str, product_ids: List[int]) -> List[MatchOut]:
    if not product_ids:
        return []
    site = get_site(session, site_code)
    stmt = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id, Match.product_id.in_(product_ids))
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
        ))
    return out
