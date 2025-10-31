# -*- coding: utf-8 -*-
from typing import List, Optional
from fastapi import APIRouter, Query
from app.db import get_session
from app.schemas import ProductOut
from app.services.matching import list_products_simple
from sqlalchemy import select, func, or_, exists, and_
from app.models import Product
from app.models import Product, ProductTag, Match, CompetitorSite


router = APIRouter()

@router.get("/products", response_model=List[ProductOut])
async def api_list_products(
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=500),
        q: str | None = None,
        tag_id: int | None = None,
        brand: str | None = None,
        site_code: str | None = None,
        matched: str | None = None,  # "matched" | "unmatched"
        # --- NEW:
        group_id: int | None = Query(None, description="ERP group/category id (products.groupid)")
):
    with get_session() as s:
        stmt = select(Product)

        if q:
            like = f"%{q}%"
            stmt = stmt.where(
                (Product.sku.ilike(like)) |
                (Product.name.ilike(like)) |
                (Product.barcode.ilike(like)) |
                (Product.item_number.ilike(like))
            )

        if brand:
            norm = brand.lower().replace(" ", "").replace(".", "")
            from sqlalchemy import func
            def _norm(col):
                return func.lower(func.replace(func.replace(col, " ", ""), ".", ""))

            stmt = stmt.where(_norm(Product.brand).like(f"%{norm}%"))

        if tag_id:
            stmt = stmt.join(ProductTag, ProductTag.c.product_id == Product.id).where(ProductTag.c.tag_id == tag_id)

        # --- NEW: group/category filter
        if group_id:
            stmt = stmt.where(Product.groupid == group_id)

        # optional: matched/unmatched per site (existing behavior)
        if matched in ("matched", "unmatched") and site_code:
            from app.models import Match, CompetitorSite
            site = s.execute(select(CompetitorSite).where(CompetitorSite.code == site_code)).scalars().first()
            if site:
                sub = select(Match.product_id).where(Match.site_id == site.id)
                if matched == "matched":
                    stmt = stmt.where(Product.id.in_(sub))
                else:
                    stmt = stmt.where(Product.id.not_in(sub))

        stmt = stmt.order_by(Product.id.desc()).offset((page - 1) * page_size).limit(page_size)
        rows = s.execute(stmt).scalars().unique().all()
        return rows


@router.get("/products/brands", response_model=List[str])
async def api_list_brands():
    with get_session() as session:
        rows = session.execute(
            select(func.distinct(Product.brand)).where(Product.brand.is_not(None)).order_by(Product.brand.asc())
        ).all()
        return [r[0] for r in rows if r[0]]

# ─────────────────────────────────────────────────────────────────────────────
# NEW: exact count of products for current filters (no paging guesswork)
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/products/count")
async def api_count_products(
    q: Optional[str] = Query(None),
    tag_id: Optional[int] = Query(None),
    brand: Optional[str] = Query(None),
    site_code: Optional[str] = Query(None),
    matched: Optional[str] = Query(None),     # "matched" | "unmatched" | None
    group_id: Optional[int] = Query(None),
):
    """
    Returns {"count": N} for the exact same filters used by /products.
    This lets the UI show a correct total and compute page numbers precisely.
    """
    with get_session() as session:
        stmt = select(func.count(func.distinct(Product.id)))

        # base FROM
        from_stmt = stmt.select_from(Product)

        # text search over SKU / Barcode / Name
        if q:
            like = f"%{q.strip()}%"
            from_stmt = from_stmt.where(
                or_(
                    Product.sku.ilike(like),
                    Product.barcode.ilike(like),
                    Product.name.ilike(like),
                )
            )

        # tag filter (m2m)
        if tag_id:
            from_stmt = (
                from_stmt.join(ProductTag, ProductTag.c.product_id == Product.id)
                .where(ProductTag.c.tag_id == tag_id)
            )

        # brand filter (case-insensitive)
        if brand:
            from_stmt = from_stmt.where(
                func.lower(func.replace(func.replace(Product.brand, ".", ""), " ", "")) ==
                func.lower(func.replace(func.replace(brand.strip(), ".", ""), " ", ""))
            )

        # optional ERP group/category (if present in the model)
        group_col = getattr(Product, "group_id", None)
        if group_id and group_col is not None:
            from_stmt = from_stmt.where(group_col == group_id)

        # matched / unmatched for a site
        if site_code and matched:
            site = session.execute(
                select(CompetitorSite.id).where(CompetitorSite.code == site_code)
            ).scalar_one_or_none()
            if site:
                sub = select(Match.id).where(and_(Match.product_id == Product.id, Match.site_id == site))
                if matched == "matched":
                    from_stmt = from_stmt.where(exists(sub))
                elif matched == "unmatched":
                    from_stmt = from_stmt.where(~exists(sub))

        total = session.execute(from_stmt).scalar_one() or 0
        return {"count": int(total)}