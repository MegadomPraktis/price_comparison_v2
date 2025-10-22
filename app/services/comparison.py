# -*- coding: utf-8 -*-
from __future__ import annotations
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Tuple

from sqlalchemy import select, func, desc, or_, and_, delete
from sqlalchemy.orm import Session

from app.models import (
    Product,
    Match,
    PriceSnapshot,
    CompetitorSite,
    ProductTag,
    Tag,
)
from app.scrapers.base import BaseScraper, CompetitorDetail


def _norm_brand_sql(col):
    """
    Case-insensitive brand compare, ignoring '.' and whitespace.
    lower(replace(replace(col, '.', ''), ' ', ''))
    """
    return func.lower(func.replace(func.replace(col, ".", ""), " ", ""))


def _effective_price(promo: Optional[float], regular: Optional[float]) -> Optional[float]:
    return promo if promo is not None else regular


def _latest_snapshot_stmt(site_id: int, comp_sku: Optional[str], comp_barcode: Optional[str]):
    """
    Latest snapshot for SKU (preferred) or fallback to BARCODE.
    """
    if comp_sku:
        return (
            select(PriceSnapshot)
            .where(PriceSnapshot.site_id == site_id, PriceSnapshot.competitor_sku == comp_sku)
            .order_by(desc(PriceSnapshot.ts))
            .limit(1)
        )
    if comp_barcode:
        return (
            select(PriceSnapshot)
            .where(PriceSnapshot.site_id == site_id, PriceSnapshot.competitor_barcode == comp_barcode)
            .order_by(desc(PriceSnapshot.ts))
            .limit(1)
        )
    # empty
    return select(PriceSnapshot).where(PriceSnapshot.id == -1).limit(1)


def _product_base_query(
    q: Optional[str],
    tag_id: Optional[int],
    brand: Optional[str],
):
    """
    Build a selectable for products with optional q / tag / brand filters.
    NOTE: expects Product.brand to exist.
    """
    stmt = select(Product)

    # Free-text over SKU / Barcode / Name
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Product.sku.ilike(like),
                Product.barcode.ilike(like),
                Product.name.ilike(like),
            )
        )

    # Tag filter
    if tag_id:
        stmt = (
            stmt.join(ProductTag, ProductTag.c.product_id == Product.id)
                .where(ProductTag.c.tag_id == tag_id)
        )

    # Brand filter (case-insensitive, ignore '.' and spaces)
    if brand:
        norm = brand.strip().lower().replace(".", "").replace(" ", "")
        stmt = stmt.where(_norm_brand_sql(Product.brand) == norm)

    # Newest first (makes "limit" behave nicely)
    stmt = stmt.order_by(desc(Product.id))
    return stmt


def build_rows_from_snapshots(
    session: Session,
    site_code: str,
    limit: int = 200,
    q: Optional[str] = None,
    tag_id: Optional[int] = None,
    brand: Optional[str] = None,
) -> List[Dict]:
    """
    Rows for a single competitor site, already filtered by q / tag_id / brand.
    Only returns rows for products that are **matched** to this site.
    Includes product_brand and product_tags (as [{id,name}, …]) for frontend filters.
    """
    site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == site_code)
    ).scalars().first()
    if not site:
        return []

    # 1) Filter products (q, tag, brand) then LIMIT
    prod_stmt = _product_base_query(q=q, tag_id=tag_id, brand=brand).limit(limit)
    products = session.execute(prod_stmt).scalars().all()
    if not products:
        return []

    # 2) Gather product tags (id + name) for client fallback
    prod_ids = [p.id for p in products]
    tags_by_product: Dict[int, List[Dict[str, object]]] = {}
    if prod_ids:
        qtags = (
            select(ProductTag.c.product_id, Tag.id, Tag.name)
            .join(Tag, Tag.id == ProductTag.c.tag_id)
            .where(ProductTag.c.product_id.in_(prod_ids))
        )
        for pid, tid, tname in session.execute(qtags).all():
            tags_by_product.setdefault(pid, []).append({"id": tid, "name": tname})

    # 3) Load matches for this site for these products
    matches_by_pid: Dict[int, Match] = {}
    if prod_ids:
        qmatch = (
            select(Match)
            .where(Match.site_id == site.id, Match.product_id.in_(prod_ids))
        )
        for m in session.execute(qmatch).scalars().all():
            matches_by_pid[m.product_id] = m

    # 4) Build rows **only when there is a match** for this site
    rows: List[Dict] = []
    for p in products:
        m = matches_by_pid.get(p.id)
        if not m:
            # ← critical: skip UNMATCHED products for comparison
            continue

        snap = session.execute(
            _latest_snapshot_stmt(site.id, m.competitor_sku, m.competitor_barcode)
        ).scalars().first()

        # competitor fields (may be None if not scraped yet)
        comp_name = snap.name if snap else None
        comp_reg = snap.regular_price if snap else None
        comp_prm = snap.promo_price if snap else None
        comp_url = snap.url if snap else None
        comp_label = snap.competitor_label if snap else None  # <<< ADDED

        rows.append({
            # ours
            "product_sku": p.sku,
            "product_barcode": p.barcode,
            "product_name": p.name,
            "product_price_regular": p.price_regular,
            "product_price_promo": p.price_promo,
            "product_brand": getattr(p, "brand", None),
            "product_tags": tags_by_product.get(p.id, []),  # [{id,name}, …]

            # competitor
            "competitor_site": site.code,
            "competitor_sku": m.competitor_sku,
            "competitor_barcode": m.competitor_barcode,
            "competitor_name": comp_name,
            "competitor_price_regular": comp_reg,
            "competitor_price_promo": comp_prm,
            "competitor_url": comp_url,
            "competitor_label": comp_label,  # <<< ADDED
        })

    return rows


# ---------------- NEW: retention helper ----------------
def _enforce_snapshot_retention(session: Session, site_id: int, key_sku: Optional[str], key_barcode: Optional[str]) -> None:
    """
    Keep snapshots for a (site, key) for up to 6 months OR max 10 newest.
    'key' prefers competitor_sku; falls back to competitor_barcode.
    """
    key = key_sku or key_barcode
    if not key:
        return

    cutoff = datetime.utcnow() - timedelta(days=183)

    # delete older than 6 months
    session.execute(
        delete(PriceSnapshot).where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key, PriceSnapshot.competitor_barcode == key),
            PriceSnapshot.ts < cutoff,
        )
    )
    session.flush()

    # ensure only 10 newest remain
    rows = session.execute(
        select(PriceSnapshot.id)
        .where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key, PriceSnapshot.competitor_barcode == key),
        )
        .order_by(PriceSnapshot.ts.desc())
    ).scalars().all()

    if len(rows) > 10:
        to_delete = rows[10:]
        session.execute(delete(PriceSnapshot).where(PriceSnapshot.id.in_(to_delete)))
        session.flush()


async def scrape_and_snapshot(session: Session, scraper: BaseScraper, limit: int = 200) -> int:
    """
    Iterate latest N matches for this site and persist snapshots.
    Also records a 'praktis' snapshot for our own price for the same product,
    and enforces retention (6 months OR 10 newest) per (site, sku/barcode).
    """
    site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == scraper.site_code)
    ).scalars().first()
    if not site:
        return 0

    # we also want to record our own price history as site 'praktis'
    praktis_site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == "praktis")
    ).scalars().first()

    qmatch = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id)
        .order_by(desc(Product.id))
        .limit(limit)
    )
    written = 0
    for m, p in session.execute(qmatch).all():
        try:
            detail: Optional[CompetitorDetail] = await scraper.fetch_product_by_match(m, p)
        except Exception:
            continue
        if not detail:
            continue

        # competitor snapshot
        snap = PriceSnapshot(
            ts=datetime.utcnow(),
            site_id=site.id,
            competitor_sku=detail.competitor_sku or m.competitor_sku,
            competitor_barcode=detail.competitor_barcode or m.competitor_barcode,
            name=detail.name,
            regular_price=detail.regular_price,
            promo_price=detail.promo_price,
            url=detail.url,
            competitor_label=getattr(detail, "label", None),
        )
        session.add(snap)
        _enforce_snapshot_retention(session, site.id, snap.competitor_sku, snap.competitor_barcode)
        written += 1

        # our own snapshot (praktis) for analytics orange line
        if praktis_site:
            ours = PriceSnapshot(
                ts=datetime.utcnow(),
                site_id=praktis_site.id,
                competitor_sku=p.sku,
                competitor_barcode=p.barcode,
                name=p.name,
                regular_price=p.price_regular,
                promo_price=p.price_promo,
                url=None,
                competitor_label=None,
            )
            session.add(ours)
            _enforce_snapshot_retention(session, praktis_site.id, ours.competitor_sku, ours.competitor_barcode)

    if written:
        session.commit()
    return written


# ---------------- NEW: analytics history helper ----------------
def get_history_for_product(session: Session, product_sku: str) -> Tuple[Optional[Product], Dict[str, List[PriceSnapshot]]]:
    """
    Returns product + dict(site_code -> snapshots within last 6 months) for:
    - praktis (our own)
    - matched competitor sites for this product
    """
    prod = session.execute(select(Product).where(Product.sku == product_sku)).scalars().first()
    if not prod:
        return None, {}

    cutoff = datetime.utcnow() - timedelta(days=183)
    sites = {s.code: s for s in session.execute(select(CompetitorSite)).scalars().all()}
    out: Dict[str, List[PriceSnapshot]] = {}

    # praktis series (by our sku/barcode)
    if "praktis" in sites:
        s = sites["praktis"]
        snaps = session.execute(
            select(PriceSnapshot)
            .where(
                PriceSnapshot.site_id == s.id,
                or_(
                    PriceSnapshot.competitor_sku == prod.sku,
                    PriceSnapshot.competitor_barcode == prod.barcode,
                ),
                PriceSnapshot.ts >= cutoff,
            )
            .order_by(PriceSnapshot.ts.asc())
        ).scalars().all()
        if snaps:
            out["praktis"] = snaps

    # competitors by matches (only those actually matched)
    for code in ("praktiker", "mrbricolage", "mashinibg"):
        s = sites.get(code)
        if not s:
            continue
        m = session.execute(
            select(Match).where(Match.product_id == prod.id, Match.site_id == s.id)
        ).scalars().first()
        if not m:
            continue

        snaps = session.execute(
            select(PriceSnapshot)
            .where(
                PriceSnapshot.site_id == s.id,
                or_(
                    and_(PriceSnapshot.competitor_sku.is_not(None),
                         PriceSnapshot.competitor_sku == m.competitor_sku),
                    and_(PriceSnapshot.competitor_barcode.is_not(None),
                         PriceSnapshot.competitor_barcode == m.competitor_barcode),
                ),
                PriceSnapshot.ts >= cutoff,
            )
            .order_by(PriceSnapshot.ts.asc())
        ).scalars().all()
        if snaps:
            out[code] = snaps

    return prod, out
