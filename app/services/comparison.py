from typing import List, Iterable, Set, Optional
import os
from decimal import Decimal, InvalidOperation

from sqlalchemy import select, func, text, and_
from sqlalchemy.orm import aliased

from app.models import Product, Match, CompetitorSite, PriceSnapshot, ProductTag
from app.schemas import ComparisonRowOut
from app.scrapers.base import BaseScraper

# Tunables via .env
SNAPSHOT_WRITE_ON_CHANGE_ONLY = os.getenv("SNAPSHOT_WRITE_ON_CHANGE_ONLY", "true").lower() in ("1","true","yes","y")
SNAPSHOT_PRICE_EPSILON = float(os.getenv("SNAPSHOT_PRICE_EPSILON", "0.001"))
SNAPSHOT_MAX_PER_SKU = int(os.getenv("SNAPSHOT_MAX_PER_SKU", "3") or "0")  # per (site, competitor_sku, competitor_barcode)

def _get_site(session, code: str) -> CompetitorSite:
    r = session.execute(select(CompetitorSite).where(CompetitorSite.code == code))
    s = r.scalars().first()
    if not s:
        raise ValueError(f"Unknown site: {code}")
    return s

def _to_dec(v):
    if v is None: return None
    try: return Decimal(str(v))
    except (InvalidOperation, ValueError, TypeError): return None

def _changed(last_regular, last_promo, new_regular, new_promo, eps: float) -> bool:
    a = _to_dec(last_regular); b = _to_dec(new_regular)
    if a is None and b is not None: return True
    if a is not None and b is None: return True
    if a is not None and b is not None and abs(a - b) > Decimal(str(eps)): return True
    a = _to_dec(last_promo); b = _to_dec(new_promo)
    if a is None and b is not None: return True
    if a is not None and b is None: return True
    if a is not None and b is not None and abs(a - b) > Decimal(str(eps)): return True
    return False

async def scrape_and_snapshot(session, scraper: BaseScraper, limit: int = 200) -> int:
    """
    Scrape competitor data for matched items (up to limit) and write snapshots.
    - Search rule: scraper prefers SKU if present; else barcode (handled inside scraper).
    - If we searched by barcode and derive a SKU, we backfill it to Match and snapshots.
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

    import asyncio
    tasks = [scraper.fetch_product_by_match(m) for _, m in pairs]
    comp_items = await asyncio.gather(*tasks)

    written = 0
    touched_keys: Set[tuple] = set()  # (sku, barcode)

    for (p, m), c in zip(pairs, comp_items):
        if not c:
            continue

        if c.competitor_sku and not (m.competitor_sku or "").strip():
            m.competitor_sku = c.competitor_sku
        if c.competitor_barcode and not (m.competitor_barcode or "").strip():
            m.competitor_barcode = c.competitor_barcode

        key_sku = (m.competitor_sku or "").strip() or None
        key_bar = (m.competitor_barcode or "").strip() or None
        if not key_sku and not key_bar:
            continue

        latest_q = (
            select(PriceSnapshot)
            .where(
                PriceSnapshot.site_id == site.id,
                ((PriceSnapshot.competitor_sku == key_sku) | (PriceSnapshot.competitor_sku.is_(None) & (key_sku is None))),
                ((PriceSnapshot.competitor_barcode == key_bar) | (PriceSnapshot.competitor_barcode.is_(None) & (key_bar is None))),
            )
            .order_by(PriceSnapshot.ts.desc())
            .limit(1)
        )
        last = session.execute(latest_q).scalars().first()

        write_it = True
        if SNAPSHOT_WRITE_ON_CHANGE_ONLY and last:
            if not _changed(last.regular_price, last.promo_price, c.regular_price, c.promo_price, SNAPSHOT_PRICE_EPSILON):
                write_it = False

        if write_it:
            session.add(PriceSnapshot(
                site_id=site.id,
                competitor_sku=key_sku,          # store both identifiers
                competitor_barcode=key_bar,
                name=c.name,
                regular_price=c.regular_price,
                promo_price=c.promo_price,
                url=c.url
            ))
            written += 1
            touched_keys.add((key_sku, key_bar))

    # Commit: snapshots + any backfilled Match identifiers
    if written or pairs:
        session.commit()

    # Prune newest N per key if configured
    if SNAPSHOT_MAX_PER_SKU and touched_keys:
        _prune_snapshots_for(session, site.id, touched_keys, SNAPSHOT_MAX_PER_SKU)

    return written

def _prune_snapshots_for(session, site_id: int, keys: Iterable[tuple], keep: int) -> None:
    sql = """
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY site_id, competitor_sku, competitor_barcode
               ORDER BY ts DESC
             ) AS rn
      FROM dbo.price_snapshots
      WHERE site_id = :site_id
        AND ( (competitor_sku = :sku) OR (competitor_sku IS NULL AND :sku IS NULL) )
        AND ( (competitor_barcode = :bar) OR (competitor_barcode IS NULL AND :bar IS NULL) )
    )
    DELETE FROM dbo.price_snapshots
    WHERE id IN (SELECT id FROM ranked WHERE rn > :keep);
    """
    for sku, bar in keys:
        session.execute(text(sql), {"site_id": site_id, "sku": sku, "bar": bar, "keep": keep})
    session.commit()

def build_rows_from_snapshots(session, site_code: str, limit: int = 200, tag_id: Optional[int] = None) -> List[ComparisonRowOut]:
    """
    Load latest snapshot per match using SKU when available, else Barcode.
    Optionally restrict to products that have a given tag.
    """
    site = _get_site(session, site_code)

    latest_by_sku = (
        select(
            PriceSnapshot.competitor_sku.label("key_sku"),
            func.max(PriceSnapshot.ts).label("max_ts")
        )
        .where(PriceSnapshot.site_id == site.id, PriceSnapshot.competitor_sku.is_not(None))
        .group_by(PriceSnapshot.competitor_sku)
        .subquery()
    )
    SnapSKU = aliased(PriceSnapshot)

    latest_by_bar = (
        select(
            PriceSnapshot.competitor_barcode.label("key_bar"),
            func.max(PriceSnapshot.ts).label("max_ts")
        )
        .where(PriceSnapshot.site_id == site.id, PriceSnapshot.competitor_barcode.is_not(None))
        .group_by(PriceSnapshot.competitor_barcode)
        .subquery()
    )
    SnapBAR = aliased(PriceSnapshot)

    base_stmt = (
        select(Product, Match)
        .join(Match, Match.product_id == Product.id)
        .where(Match.site_id == site.id)
        .order_by(Product.id.desc())
        .limit(limit)
    )
    if tag_id:
        base_stmt = base_stmt.join(ProductTag, ProductTag.c.product_id == Product.id).where(ProductTag.c.tag_id == tag_id)

    base = base_stmt.subquery()

    stmt = (
        select(
            base.c.sku, base.c.barcode, base.c.name,
            base.c.price_regular, base.c.price_promo,
            base.c.competitor_sku, base.c.competitor_barcode,
            func.coalesce(SnapSKU.name,          SnapBAR.name),
            func.coalesce(SnapSKU.regular_price, SnapBAR.regular_price),
            func.coalesce(SnapSKU.promo_price,   SnapBAR.promo_price),
            func.coalesce(SnapSKU.url,           SnapBAR.url),
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

    rows: List[ComparisonRowOut] = []
    for (p_sku, p_bar, p_name, p_reg, p_pro,
         m_sku, m_bar, s_name, s_reg, s_pro, s_url) in session.execute(stmt).all():
        rows.append(ComparisonRowOut(
            product_sku=p_sku,
            product_barcode=p_bar,
            product_name=p_name,
            product_price_regular=p_reg,
            product_price_promo=p_pro,
            competitor_site=site.code,
            competitor_sku=m_sku,
            competitor_barcode=m_bar,
            competitor_name=s_name,
            competitor_price_regular=s_reg,
            competitor_price_promo=s_pro,
            competitor_url=s_url,
        ))
    return rows
