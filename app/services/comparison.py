# -*- coding: utf-8 -*-
from __future__ import annotations
import logging
import math
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Tuple

from sqlalchemy import select, func, desc, or_, and_, delete, text as _sql_text, outerjoin
from sqlalchemy.orm import Session

from app.models import (
    Product,
    Match,
    PriceSnapshot,
    CompetitorSite,
    ProductTag,
    Tag,
    Group,  # ← has id, parent_id, name
)
from app.db import get_session
from app.registry import registry, register_default_scrapers

# ─────────────────────────────────────────────────────────────────────────────
# Logger
# ─────────────────────────────────────────────────────────────────────────────
logger = logging.getLogger(__name__)

# ---------- brand normalization (server-side fallback, mirrors client) ----------
def _norm_brand_sql(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    return s.lower().replace(".", "").replace(" ", "")

# ---------- price helpers ----------
def _effective_price(promo: Optional[float], regular: Optional[float]) -> Optional[float]:
    return promo if promo is not None else regular

def _latest_snapshot_stmt(site_id: int, key_sku: Optional[str], key_bar: Optional[str]):
    conds = []
    if key_sku:
        conds.append(PriceSnapshot.competitor_sku == key_sku)
    if key_bar:
        conds.append(PriceSnapshot.competitor_barcode == key_bar)
    if not conds:
        return select(PriceSnapshot).where(PriceSnapshot.id == -1).limit(1)
    return (
        select(PriceSnapshot)
        .where(PriceSnapshot.site_id == site_id, or_(*conds))
        .order_by(PriceSnapshot.ts.desc(), PriceSnapshot.id.desc())
        .limit(1)
    )

def _empty_latest_stmt():
    return select(PriceSnapshot).where(PriceSnapshot.id == -1).limit(1)

# ---------- NEW: group helpers (for Product.groupid) ----------
def _get_descendant_group_ids(session: Session, root_id: int) -> List[int]:
    if not root_id:
        return []
    rows = session.execute(select(Group.id, Group.parent_id)).all()
    if not rows:
        return [root_id]

    children: Dict[Optional[int], List[int]] = {}
    for gid, pid in rows:
        children.setdefault(pid, []).append(gid)

    out: List[int] = []
    stack = [root_id]
    seen = set()
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        out.append(cur)
        for ch in children.get(cur, []):
            stack.append(ch)
    return out

# ---------- base query for products with filters ----------
def _product_base_query(
    q: Optional[str] = None,
    tag_id: Optional[str] = None,
    brand: Optional[str] = None,
    group_ids: Optional[List[int]] = None,
):
    stmt = select(Product)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Product.sku.ilike(like),
                Product.name.ilike(like),
                Product.barcode.ilike(like),
            )
        )
    if tag_id:
        stmt = stmt.join(ProductTag, ProductTag.c.product_id == Product.id).where(ProductTag.c.tag_id == int(tag_id))

    if brand:
        b = _norm_brand_sql(brand)
        if b:
            stmt = stmt.where(func.replace(func.replace(func.lower(Product.brand), ".", ""), " ", "").like(f"%{b}%"))

    if group_ids:
        stmt = stmt.where(Product.groupid.in_(group_ids))

    stmt = stmt.order_by(Product.id.asc())
    return stmt

# ---------- rows for comparison (snapshots source) ----------
def build_rows_from_snapshots(
    session: Session,
    site_code: str,
    limit: int,
    source: str = "snapshots",
    q: Optional[str] = None,
    tag_id: Optional[str] = None,
    brand: Optional[str] = None,
    category_id: Optional[int] = None,
):
    site: Optional[CompetitorSite] = None
    if site_code != "all":
        site = session.execute(
            select(CompetitorSite).where(CompetitorSite.code == site_code)
        ).scalars().first()
        if not site:
            return []

    descendant_ids: Optional[List[int]] = None
    if category_id:
        descendant_ids = _get_descendant_group_ids(session, category_id)
        if not descendant_ids:
            return []

    prod_stmt = _product_base_query(
        q=q, tag_id=tag_id, brand=brand, group_ids=descendant_ids
    ).limit(limit)
    products = session.execute(prod_stmt).scalars().all()
    if not products:
        return []

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

    matches_by_pid: Dict[int, Match] = {}
    if site:
        qmatch = (
            select(Match)
            .where(Match.site_id == site.id, Match.product_id.in_(prod_ids))
        )
        for m in session.execute(qmatch).scalars().all():
            matches_by_pid[m.product_id] = m

    rows: List[Dict] = []
    for p in products:
        if site:
            m = matches_by_pid.get(p.id)
            if not m:
                continue

            snap = session.execute(
                _latest_snapshot_stmt(site.id, m.competitor_sku, m.competitor_barcode)
            ).scalars().first()

            comp_name = snap.name if snap else None
            comp_reg = snap.regular_price if snap else None
            comp_prm = snap.promo_price if snap else None
            comp_url = snap.url if snap else None
            comp_lbl = snap.competitor_label if snap else None

            rows.append({
                "product_id": p.id,
                "product_sku": p.sku,
                "product_name": p.name,
                "product_barcode": p.barcode,
                "product_brand": p.brand,
                "product_price_regular": p.price_regular,
                "product_price_promo": p.price_promo,
                "product_tags": tags_by_product.get(p.id, []),

                "competitor_site": site.code,
                "competitor_sku": m.competitor_sku,
                "competitor_name": comp_name,
                "competitor_price_regular": comp_reg,
                "competitor_price_promo": comp_prm,
                "competitor_url": comp_url,
                "competitor_label": comp_lbl,
            })
        else:
            qms = select(Match, CompetitorSite).join(CompetitorSite, CompetitorSite.id == Match.site_id)\
                                               .where(Match.product_id == p.id)
            for m, s in session.execute(qms).all():
                snap = session.execute(
                    _latest_snapshot_stmt(s.id, m.competitor_sku, m.competitor_barcode)
                ).scalars().first()
                rows.append({
                    "product_id": p.id,
                    "product_sku": p.sku,
                    "product_name": p.name,
                    "product_barcode": p.barcode,
                    "product_brand": p.brand,
                    "product_price_regular": p.price_regular,
                    "product_price_promo": p.price_promo,
                    "product_tags": tags_by_product.get(p.id, []),

                    "competitor_site": s.code,
                    "competitor_sku": m.competitor_sku,
                    "competitor_name": (snap.name if snap else None),
                    "competitor_price_regular": (snap.regular_price if snap else None),
                    "competitor_price_promo": (snap.promo_price if snap else None),
                    "competitor_url": (snap.url if snap else None),
                    "competitor_label": (snap.competitor_label if snap else None),
                })

    return rows

# ---------- retention for snapshots per key ----------
def _enforce_snapshot_retention(session: Session, site_id: int, key_sku: Optional[str], key_bar: Optional[str]):
    cutoff = datetime.utcnow() - timedelta(days=180)
    session.execute(
        delete(PriceSnapshot).where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key_sku, PriceSnapshot.competitor_barcode == key_bar),
            PriceSnapshot.ts < cutoff,
        )
    )
    session.flush()

    ids_desc = session.execute(
        select(PriceSnapshot.id)
        .where(
            PriceSnapshot.site_id == site_id,
            or_(PriceSnapshot.competitor_sku == key_sku, PriceSnapshot.competitor_barcode == key_bar),
        )
        .order_by(PriceSnapshot.ts.desc(), PriceSnapshot.id.desc())
    ).scalars().all()

    if len(ids_desc) > 10:
        to_delete = ids_desc[10:]
        session.execute(delete(PriceSnapshot).where(PriceSnapshot.id.in_(to_delete)))
        session.flush()

# ---------- main site scrape ----------
async def scrape_and_snapshot(session, scraper, limit: int = 200) -> int:
    """
    Scrape recent matches for the site and persist snapshots **only on change**.
    Picks matches whose latest snapshot is oldest (or missing) first.
    """
    try:
        session.execute(_sql_text("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED"))
    except Exception:
        pass

    site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == getattr(scraper, "site_code", None))
    ).scalars().first()
    if not site:
        return 0

    # Subquery: latest snapshot ts per key
    snap_max = (
        select(
            PriceSnapshot.site_id.label("site_id"),
            PriceSnapshot.competitor_sku.label("key_sku"),
            PriceSnapshot.competitor_barcode.label("key_bar"),
            func.max(PriceSnapshot.ts).label("last_ts"),
        )
        .where(PriceSnapshot.site_id == site.id)
        .group_by(PriceSnapshot.site_id, PriceSnapshot.competitor_sku, PriceSnapshot.competitor_barcode)
        .subquery()
    )

    order_anchor = datetime(1900, 1, 1)
    coalesced_last = func.coalesce(snap_max.c.last_ts, order_anchor)

    q_pick = (
        select(Match, Product, snap_max.c.last_ts)
        .join(Product, Product.id == Match.product_id)
        .outerjoin(
            snap_max,
            or_(
                and_(
                    snap_max.c.key_sku.is_not(None),
                    Match.competitor_sku.is_not(None),
                    snap_max.c.key_sku == Match.competitor_sku,
                ),
                and_(
                    snap_max.c.key_bar.is_not(None),
                    Match.competitor_barcode.is_not(None),
                    snap_max.c.key_bar == Match.competitor_barcode,
                ),
            )
        )
        .where(Match.site_id == site.id)
        .order_by(coalesced_last.asc(), Product.id.asc())
        .limit(int(limit or 200))
    )

    picked = session.execute(q_pick).all()
    to_process = [(m, p) for (m, p, _ts) in picked]

    # End read txn before network scraping
    try:
        session.rollback()
    except Exception:
        pass

    results = []
    for m, p in to_process:
        try:
            detail = await scraper.fetch_product_by_match(m, p)
        except Exception:
            continue
        if not detail:
            continue
        results.append((m, detail))

    written = 0
    CHUNK = 50
    EPS = 0.005

    def _num(x):
        if x is None:
            return None
        try:
            return float(x)
        except Exception:
            return None

    def _eq_price(a, b):
        a = _num(a); b = _num(b)
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        return math.isclose(a, b, abs_tol=EPS)

    for i in range(0, len(results), CHUNK):
        chunk = results[i:i + CHUNK]
        with get_session() as s2:
            try:
                for m, detail in chunk:
                    key_sku = (getattr(detail, "competitor_sku", None) or m.competitor_sku or None)
                    key_bar = (getattr(detail, "competitor_barcode", None) or m.competitor_barcode or None)

                    latest = s2.execute(_latest_snapshot_stmt(site.id, key_sku, key_bar)).scalars().first()

                    # Compare fields; write only if something changed
                    changed = False
                    if latest is None:
                        changed = True
                    else:
                        # Only track changes in prices or label; ignore name / URL changes
                        if not _eq_price(detail.regular_price, latest.regular_price):
                            changed = True
                        elif not _eq_price(detail.promo_price, latest.promo_price):
                            changed = True
                        elif (getattr(detail, "label", None) or None) != (latest.competitor_label or None):
                            changed = True
                    if not changed:
                        continue

                    s2.add(PriceSnapshot(
                        ts=datetime.utcnow(),
                        site_id=site.id,
                        competitor_sku=key_sku,
                        competitor_barcode=key_bar,
                        name=getattr(detail, "name", None),
                        regular_price=_num(getattr(detail, "regular_price", None)),
                        promo_price=_num(getattr(detail, "promo_price", None)),
                        url=(getattr(detail, "url", None) or None),
                        competitor_label=getattr(detail, "label", None),
                    ))
                    s2.flush()

                    _enforce_snapshot_retention(s2, site.id, key_sku, key_bar)
                    written += 1

                s2.commit()
            except Exception:
                try:
                    s2.rollback()
                except Exception:
                    pass

    return written

# ---------- NEW: filtered scrape (first page only; max 50) ----------
async def scrape_filtered(
    session: Session,
    site_code: str,
    q: Optional[str] = None,
    tag_id: Optional[str] = None,
    brand: Optional[str] = None,
    category_id: Optional[int] = None,
    limit: int = 50,
) -> Dict[str, int]:
    limit = max(1, min(50, int(limit or 50)))

    site = session.execute(
        select(CompetitorSite).where(CompetitorSite.code == site_code)
    ).scalars().first()
    if not site:
        logger.warning("scrape_filtered: unknown site_code=%s", site_code)
        return {"attempted": 0, "written": 0}

    logger.info("scrape_filtered: site=%s q=%s tag=%s brand=%s group=%s limit=%s",
                site_code, q, tag_id, brand, category_id, limit)

    descendants = None
    if category_id:
        descendants = _get_descendant_group_ids(session, int(category_id))

    prod_stmt = _product_base_query(q=q, tag_id=tag_id, brand=brand, group_ids=descendants)
    qjoin = (
        select(Match, Product)
        .join(Product, Product.id == Match.product_id)
        .where(Match.site_id == site.id)
        .where(Product.id.in_(select(prod_stmt.subquery().c.id)))
        .order_by(Product.id.asc())
        .limit(limit)
    )
    to_process = session.execute(qjoin).all()
    logger.info("scrape_filtered: site=%s items_to_process=%d", site_code, len(to_process))
    if not to_process:
        return {"attempted": 0, "written": 0}

    register_default_scrapers()
    scraper = registry.get(site_code)

    results: List[Tuple[Match, object]] = []
    for m, p in to_process:
        try:
            detail = await scraper.fetch_product_by_match(m, p)
        except Exception as e:
            logger.exception("scrape_filtered: scraper error site=%s m.id=%s: %s", site_code, getattr(m, "id", "?"), e)
            continue
        if not detail:
            continue
        results.append((m, detail))

    written = 0
    CHUNK = 50
    EPS = 0.005

    def _num(x):
        if x is None:
            return None
        try:
            return float(x)
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
                    key_sku = (getattr(detail, "competitor_sku", None) or m.competitor_sku or None)
                    key_bar = (getattr(detail, "competitor_barcode", None) or m.competitor_barcode or None)
                    latest = s2.execute(_latest_snapshot_stmt(site.id, key_sku, key_bar)).scalars().first()

                    changed = False
                    if latest is None:
                        changed = True
                    else:
                        if (getattr(detail, "name", None) or None) != (latest.name or None):
                            changed = True
                        elif not _eq_price(getattr(detail, "regular_price", None), latest.regular_price):
                            changed = True
                        elif not _eq_price(getattr(detail, "promo_price", None), latest.promo_price):
                            changed = True
                        elif (getattr(detail, "url", None) or None) != (latest.url or None):
                            changed = True
                        elif (getattr(detail, "label", None) or None) != (latest.competitor_label or None):
                            changed = True
                    if not changed:
                        continue

                    s2.add(PriceSnapshot(
                        ts=datetime.utcnow(),
                        site_id=site.id,
                        competitor_sku=key_sku,
                        competitor_barcode=key_bar,
                        name=getattr(detail, "name", None),
                        regular_price=_num(getattr(detail, "regular_price", None)),
                        promo_price=_num(getattr(detail, "promo_price", None)),
                        url=(getattr(detail, "url", None) or None),
                        competitor_label=getattr(detail, "label", None),
                    ))
                    s2.flush()
                    _enforce_snapshot_retention(s2, site.id, key_sku, key_bar)
                    written += 1
                s2.commit()
            except Exception as e:
                logger.exception("scrape_filtered: DB chunk commit failed: %s", e)
                try:
                    s2.rollback()
                except Exception:
                    pass

    logger.info("scrape_filtered: site=%s done written=%d", site_code, written)
    return {"attempted": len(to_process), "written": written}

# ---------- NEW: nightly mass scrape (all matched, all sites; concurrent) ----------
async def scrape_all(session: Session) -> Dict[str, object]:
    """
    Scrape all matched products for all registered sites concurrently.
    Returns detailed counts and logs progress.
    """
    register_default_scrapers()

    # Fetch sites with ids+codes
    site_rows = session.execute(
        select(CompetitorSite.id, CompetitorSite.code).order_by(CompetitorSite.id.asc())
    ).all()
    sites = [{"id": sid, "code": scode} for (sid, scode) in site_rows if scode]
    if not sites:
        logger.warning("scrape_all: no sites registered")
        return {"attempted_sites": 0, "total_matches": 0, "written_snapshots": 0, "per_site": {}}

    # Pre-compute number of matches per site
    per_site_counts: Dict[str, int] = {}
    for s in sites:
        cnt = session.execute(select(func.count()).select_from(Match).where(Match.site_id == s["id"])).scalar() or 0
        per_site_counts[s["code"]] = int(cnt)

    total_matches = sum(per_site_counts.values())
    logger.info("scrape_all: starting. sites=%s total_matches=%d", [s["code"] for s in sites], total_matches)

    import asyncio

    async def _run_one(site_id: int, site_code: str) -> Dict[str, int]:
        # Use a fresh session in the task
        try:
            scraper = registry.get(site_code)
        except Exception:
            logger.warning("scrape_all: no scraper found for site=%s", site_code)
            return {"matches": per_site_counts.get(site_code, 0), "written": 0}

        with get_session() as s2:
            try:
                written = await scrape_and_snapshot(s2, scraper, limit=2000)
                logger.info("scrape_all: site=%s done written=%d", site_code, written)
                return {"matches": per_site_counts.get(site_code, 0), "written": int(written or 0)}
            except Exception as e:
                logger.exception("scrape_all: site=%s failed: %s", site_code, e)
                return {"matches": per_site_counts.get(site_code, 0), "written": 0}

    tasks = [asyncio.create_task(_run_one(s["id"], s["code"])) for s in sites]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    per_site: Dict[str, Dict[str, int]] = {}
    written_total = 0
    for s, res in zip(sites, results):
        if isinstance(res, Exception):
            logger.exception("scrape_all: task error site=%s: %s", s["code"], res)
            per_site[s["code"]] = {"matches": per_site_counts.get(s["code"], 0), "written": 0}
            continue
        per_site[s["code"]] = {"matches": int(res.get("matches", 0)), "written": int(res.get("written", 0))}
        written_total += int(res.get("written", 0))

    summary = {
        "attempted_sites": len(sites),
        "total_matches": total_matches,
        "written_snapshots": written_total,
        "per_site": per_site,
    }
    logger.info("scrape_all: summary %s", summary)
    return summary

# ---------- tiny numeric helper ----------
def _num(x):
    if x is None:
        return None
    try:
        return float(x)
    except Exception:
        return None

def _eq_price(a, b, eps: float = 0.005) -> bool:
    a = _num(a); b = _num(b)
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    return math.isclose(a, b, abs_tol=eps)

# ---------- public: price history for a product (backward compatible) ----------
def get_history_for_product(
    session: Session,
    product_sku: str,
    site_code: Optional[str] = None,
) -> Tuple[Optional[Product], Dict[str, List[PriceSnapshot]]]:
    prod = session.execute(select(Product).where(Product.sku == product_sku)).scalars().first()
    if not prod:
        return None, {}

    out: Dict[str, List[PriceSnapshot]] = {}
    cutoff = datetime.utcnow() - timedelta(days=180)

    qms = select(Match, CompetitorSite).join(CompetitorSite, CompetitorSite.id == Match.site_id)\
                                       .where(Match.product_id == prod.id)
    for m, s in session.execute(qms).all():
        code = s.code
        if site_code and code != site_code:
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
