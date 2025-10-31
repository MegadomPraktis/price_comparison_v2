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


def _enforce_snapshot_retention(session, site_id: int, key_sku: str | None, key_barcode: str | None) -> None:
    """
    Keep at most 10 newest snapshots for (site_id, key) where key is competitor_sku (preferred) or competitor_barcode.
    Also prunes anything older than 6 months (optional safety).
    """
    from app.models import PriceSnapshot

    key = key_sku or key_barcode
    if not key:
        return

    # Optional time-based pruning (kept from before)
    cutoff = datetime.utcnow() - timedelta(days=183)
    session.execute(
        delete(PriceSnapshot).where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key, PriceSnapshot.competitor_barcode == key),
            PriceSnapshot.ts < cutoff,
        )
    )
    session.flush()

    # Size-based pruning: keep 10 newest
    ids_desc = session.execute(
        select(PriceSnapshot.id)
        .where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key, PriceSnapshot.competitor_barcode == key),
        )
        .order_by(PriceSnapshot.ts.desc(), PriceSnapshot.id.desc())
    ).scalars().all()

    if len(ids_desc) > 10:
        to_delete = ids_desc[10:]
        session.execute(delete(PriceSnapshot).where(PriceSnapshot.id.in_(to_delete)))
        session.flush()


import math

async def scrape_and_snapshot(session, scraper, limit: int = 200) -> int:
    """
    Scrape recent matches for the site and persist snapshots **only on change**.
    Also enforces 'keep 10 newest per key' retention after inserts.
    """
    from sqlalchemy import select, desc, text as _sql_text, or_
    from app.models import Product, Match, PriceSnapshot, CompetitorSite
    from app.db import get_session
    from datetime import datetime as _dt

    # --- phase 1: lightweight reads
    try:
        session.execute(_sql_text("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED"))
    except Exception:
        pass

    site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == getattr(scraper, "site_code", None))
    ).scalars().first()
    if not site:
        return 0

    qmatch = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id)
        .order_by(desc(Match.updated_at), desc(Product.id))
        .limit(limit)
    )
    to_process = session.execute(qmatch).all()

    # end read tx before network
    try:
        session.rollback()
    except Exception:
        pass

    # --- phase 2: scrape without DB locks
    results = []
    for m, p in to_process:
        try:
            detail = await scraper.fetch_product_by_match(m, p)
        except Exception:
            continue
        if not detail:
            continue
        results.append((m, detail))

    # --- phase 3: short, chunked writes with change detection + retention
    written = 0
    CHUNK = 50
    EPS = 0.005  # price tolerance for equals

    def _num(v):
        try:
            return None if v is None else float(v)
        except Exception:
            return None

    def _eq_price(a, b):
        a = _num(a); b = _num(b)
        if a is None and b is None: return True
        if a is None or b is None:  return False
        return math.isclose(a, b, abs_tol=EPS)

    for i in range(0, len(results), CHUNK):
        chunk = results[i:i + CHUNK]
        with get_session() as s2:
            try:
                for m, detail in chunk:
                    key_sku = (detail.competitor_sku or m.competitor_sku or None)
                    key_bar = (detail.competitor_barcode or m.competitor_barcode or None)

                    # Fetch latest snapshot for this key
                    latest = s2.execute(_latest_snapshot_stmt(site.id, key_sku, key_bar)).scalars().first()

                    # Compare fields; write only if something changed
                    changed = False
                    if latest is None:
                        changed = True
                    else:
                        if (detail.name or None) != (latest.name or None):
                            changed = True
                        elif not _eq_price(detail.regular_price, latest.regular_price):
                            changed = True
                        elif not _eq_price(detail.promo_price, latest.promo_price):
                            changed = True
                        elif (detail.url or None) != (latest.url or None):
                            changed = True
                        elif (getattr(detail, "label", None) or None) != (latest.competitor_label or None):
                            changed = True

                    if not changed:
                        # nothing changed → skip insert
                        continue

                    s2.add(PriceSnapshot(
                        ts=_dt.utcnow(),
                        site_id=site.id,
                        competitor_sku=key_sku,
                        competitor_barcode=key_bar,
                        name=detail.name,
                        regular_price=_num(detail.regular_price),
                        promo_price=_num(detail.promo_price),
                        url=(detail.url or None),
                        competitor_label=getattr(detail, "label", None),
                    ))
                    s2.flush()

                    # Retention: keep only the 10 newest for that key
                    _enforce_snapshot_retention(s2, site.id, key_sku, key_bar)

                    written += 1

                s2.commit()
            except Exception:
                try: s2.rollback()
                except: pass
                # continue with remaining chunks
                continue

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
