# -*- coding: utf-8 -*-
import asyncio, time

from typing import List, Optional, Tuple, Set, Dict, Any
from sqlalchemy.orm import aliased
from datetime import datetime
from sqlalchemy import select, func, and_, exists

from app.models import Product, Match, CompetitorSite, PriceSnapshot, ProductTag
from app.schemas import MatchOut, MatchCreate
from app.scrapers.base import BaseScraper, SearchResult


def list_products_simple(session, page: int, page_size: int, q: Optional[str], tag_id: Optional[int] = None) -> List[Product]:
    stmt = select(Product).order_by(Product.id.desc())
    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            (Product.sku.ilike(like)) |
            (Product.name.ilike(like)) |
            (Product.barcode.ilike(like))
        )
    if tag_id:
        # join product_tags
        stmt = stmt.join(ProductTag, ProductTag.c.product_id == Product.id).where(ProductTag.c.tag_id == tag_id)
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    res = session.execute(stmt)
    return res.scalars().unique().all()

def get_site(session, site_code: str) -> CompetitorSite:
    r = session.execute(select(CompetitorSite).where(CompetitorSite.code == site_code))
    site = r.scalars().first()
    if not site:
        raise ValueError(f"Unknown site code: {site_code}")
    return site

def list_matches(session, site_code: str, page: int, page_size: int, tag_id: Optional[int] = None) -> List[MatchOut]:
    site = get_site(session, site_code)
    stmt = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id)
    )
    if tag_id:
        stmt = stmt.join(ProductTag, ProductTag.c.product_id == Product.id).where(ProductTag.c.tag_id == tag_id)
    stmt = stmt.order_by(Match.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)

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

async def auto_match_for_site(session, scraper: BaseScraper, limit: Optional[int] = None) -> Tuple[int, int]:
    """
    Auto-match using each scraper's own lightweight search logic.
    - OnlineMashini: prefer item_number (+brand), fallback to barcode; if no SKU is discoverable, store our item_number as competitor_sku.
    - Others: prefer barcode.
    Runs lookups concurrently; DB writes happen in batches.
    """
    site = get_site(session, scraper.site_code)

    # Concurrency & batching
    PAR = 12          # tune to your scraper throttles (each scraper also has its own semaphore & bucket)
    BATCH = 500       # how many DB rows to stage per iteration
    to_process = None if (limit is None or limit <= 0) else int(limit)

    attempted = 0
    found = 0
    tried_ids: Set[int] = set()
    cache: Dict[tuple, Optional[SearchResult]] = {}

    t0 = time.perf_counter()
    print(f"[AUTO] Start: site={scraper.site_code} limit={limit} batch={BATCH} par={PAR}")

    async def resolve(prod: Product) -> Optional[SearchResult]:
        """Use per-site locating strategy; cache repeated keys inside this run."""
        async def by_item_number():
            item_no = (prod.item_number or "").strip() or None
            brand   = (prod.brand or "").strip() or None
            if not item_no:
                return None
            key = (scraper.site_code, "item_number", item_no.lower(), (brand or "").lower())
            if key in cache:
                return cache[key]
            try:
                r = await scraper.search_by_item_number(item_no, brand=brand)  # Mashini implements this
            except Exception:
                r = None
            cache[key] = r
            return r

        async def by_barcode():
            code = (prod.barcode or "").strip() or None
            if not code:
                return None
            key = (scraper.site_code, "barcode", code)
            if key in cache:
                return cache[key]
            try:
                r = await scraper.search_by_barcode(code)  # Praktiker/MrB/Mashini implement this
            except Exception:
                r = None
            cache[key] = r
            return r

        # Site-specific preference
        if scraper.site_code == "mashinibg":
            return (await by_item_number()) or (await by_barcode())
        else:
            return await by_barcode()

    while True:
        batch_cap = BATCH if (to_process is None) else max(0, min(BATCH, to_process - attempted))
        if batch_cap == 0:
            break

        # Unmatched for this site
        sub = select(Match.product_id).where(Match.site_id == site.id)
        stmt = (
            select(Product)
            .where(Product.id.not_in(sub))
            .order_by(Product.id.desc())
        )
        if tried_ids:
            stmt = stmt.where(~Product.id.in_(tried_ids))
        stmt = stmt.limit(batch_cap)

        products = session.execute(stmt).scalars().all()
        if not products:
            print(f"[AUTO] No more unmatched rows for site={scraper.site_code}")
            break

        for p in products:
            tried_ids.add(p.id)

        sem = asyncio.Semaphore(PAR)
        async def pooled(p: Product):
            async with sem:
                return p, await resolve(p)

        results = await asyncio.gather(*(pooled(p) for p in products))
        before_found = found

        for p, sres in results:
            attempted += 1
            if not sres:
                continue

            comp_sku = (sres.competitor_sku or "").strip() or None
            comp_bar = (sres.competitor_barcode or "").strip() or None

            # Site-specific identifier fill-ins
            if scraper.site_code == "mashinibg":
                # If Mashini search didn’t expose a SKU, store our item_number as their SKU.
                if not comp_sku:
                    comp_sku = (p.item_number or "").strip() or None
                if not comp_bar:
                    comp_bar = (p.barcode or "").strip() or None
            else:
                # For sites that don’t return barcode from search, keep our EAN as matching key.
                if not comp_bar:
                    comp_bar = (p.barcode or "").strip() or None

            if comp_sku or comp_bar:
                session.add(Match(
                    product_id=p.id,
                    site_id=site.id,
                    competitor_sku=comp_sku,
                    competitor_barcode=comp_bar,
                ))
                found += 1

        session.commit()
        elapsed = time.perf_counter() - t0
        print(
            f"[AUTO] Batch committed: site={scraper.site_code} "
            f"processed={attempted} new_matches={found - before_found} "
            f"batch_size={len(products)} elapsed={elapsed:.1f}s "
            f"remaining={'∞' if to_process is None else max(0, to_process - attempted)}"
        )

        if to_process is not None and attempted >= to_process:
            break

    total = time.perf_counter() - t0
    print(f"[AUTO] Finished: site={scraper.site_code} attempted={attempted} found={found} elapsed={total:.1f}s")
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

def _normlike(col):
    # normalize for case / spaces / dots: lower(replace(replace(col,' ',''),'.',''))
    return func.lower(func.replace(func.replace(col, " ", ""), ".", ""))

def list_products_simple(session, page: int, page_size: int, q: Optional[str],
                         tag_id: Optional[int] = None,
                         brand: Optional[str] = None,                # NEW
                         site_code: Optional[str] = None,            # NEW
                         matched: Optional[str] = None               # NEW ('matched'|'unmatched')
                         ) -> List[Product]:
    stmt = select(Product).order_by(Product.id.desc())

    if q:
        like = f"%{q}%"
        stmt = stmt.where(
            (Product.sku.ilike(like)) |
            (Product.name.ilike(like)) |
            (Product.barcode.ilike(like)) |
            (Product.item_number.ilike(like)) |          # NEW
            (Product.brand.ilike(like))                  # NEW
        )

    if brand:
        norm = brand.replace(" ", "").replace(".", "").lower()
        stmt = stmt.where(_normlike(Product.brand).ilike(f"%{norm}%"))  # NEW

    if tag_id:
        stmt = stmt.join(ProductTag, ProductTag.c.product_id == Product.id)\
                   .where(ProductTag.c.tag_id == tag_id)

    # Matched/Unmatched per selected site
    if site_code and matched:
        site = get_site(session, site_code)  # reuse existing helper
        sub = select(Match.id).where(and_(Match.product_id == Product.id, Match.site_id == site.id))
        if matched == "matched":
            stmt = stmt.where(exists(sub))
        elif matched == "unmatched":
            stmt = stmt.where(~exists(sub))

    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    return session.execute(stmt).scalars().unique().all()