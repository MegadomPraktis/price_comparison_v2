# -*- coding: utf-8 -*-
from typing import List
from sqlalchemy import select, func
from sqlalchemy.orm import aliased

from app.models import Product, Match, CompetitorSite, PriceSnapshot
from app.schemas import ComparisonRowOut
from app.scrapers.base import BaseScraper

def _get_site(session, code: str) -> CompetitorSite:
    r = session.execute(select(CompetitorSite).where(CompetitorSite.code == code))
    s = r.scalars().first()
    if not s:
        raise ValueError(f"Unknown site: {code}")
    return s

async def scrape_and_snapshot(session, scraper: BaseScraper, limit: int = 200) -> int:
    """
    Actively scrape competitor data for ALL matched items (up to limit)
    and write a new row into PriceSnapshot for each item scraped.
    Returns number of snapshots written.
    """
    site = _get_site(session, scraper.site_code)
    stmt = (
        select(Product, Match)
        .join(Match, Match.product_id == Product.id)
        .where(Match.site_id == site.id)
        .order_by(Product.id.desc())
        .limit(limit)
    )
    pairs = session.execute(stmt).all()

    # async scrape competitor details
    import asyncio
    tasks = [scraper.fetch_product_by_match(m) for _, m in pairs]
    comp_items = await asyncio.gather(*tasks)

    written = 0
    for (p, m), c in zip(pairs, comp_items):
        if c:
            session.add(PriceSnapshot(
                site_id=site.id,
                competitor_sku=c.competitor_sku or m.competitor_sku,
                name=c.name,
                regular_price=c.regular_price,
                promo_price=c.promo_price,
                url=c.url
            ))
            written += 1

    if written:
        session.commit()
    return written

def build_rows_from_snapshots(session, site_code: str, limit: int = 200) -> List[ComparisonRowOut]:
    """
    DO NOT SCRAPE. Load the latest snapshot per competitor_sku and
    join to our products via Match. This is fast and page-safe.
    """
    site = _get_site(session, site_code)

    # subquery: latest ts per competitor_sku for this site
    latest = (
        select(
            PriceSnapshot.competitor_sku,
            func.max(PriceSnapshot.ts).label("max_ts")
        )
        .where(PriceSnapshot.site_id == site.id)
        .group_by(PriceSnapshot.competitor_sku)
        .subquery()
    )

    Snap = aliased(PriceSnapshot)

    # join Match -> Product, and LEFT JOIN latest snapshot on competitor_sku
    stmt = (
        select(
            Product, Match,
            Snap.name, Snap.regular_price, Snap.promo_price, Snap.url
        )
        .join(Match, Match.product_id == Product.id)
        .where(Match.site_id == site.id)
        .join(latest, latest.c.competitor_sku == Match.competitor_sku, isouter=True)
        .join(
            Snap,
            (Snap.site_id == site.id) &
            (Snap.competitor_sku == latest.c.competitor_sku) &
            (Snap.ts == latest.c.max_ts),
            isouter=True
        )
        .order_by(Product.id.desc())
        .limit(limit)
    )

    rows: List[ComparisonRowOut] = []
    for p, m, name, r_price, promo, url in session.execute(stmt).all():
        rows.append(ComparisonRowOut(
            product_sku=p.sku,
            product_barcode=p.barcode,
            product_name=p.name,
            product_price_regular=p.price_regular,
            product_price_promo=p.price_promo,
            competitor_site=site.code,
            competitor_sku=m.competitor_sku,
            competitor_barcode=m.competitor_barcode,
            competitor_name=name,
            competitor_price_regular=r_price,
            competitor_price_promo=promo,
            competitor_url=url,
        ))
    return rows
