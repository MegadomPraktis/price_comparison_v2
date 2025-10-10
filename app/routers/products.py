# -*- coding: utf-8 -*-
from typing import List, Optional
from fastapi import APIRouter, Query
from app.db import get_session
from app.schemas import ProductOut
from app.services.matching import list_products_simple
from sqlalchemy import select, func
from app.models import Product

router = APIRouter()

@router.get("/products", response_model=List[ProductOut])
async def api_list_products(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    q: Optional[str] = Query(None),
    tag_id: Optional[int] = Query(None),
    brand: Optional[str] = Query(None),               # NEW
    site_code: Optional[str] = Query(None),           # NEW (for matched/unmatched)
    matched: Optional[str] = Query(None, pattern="^(matched|unmatched)$"),  # NEW
):
    with get_session() as session:
        products = list_products_simple(
            session,
            page=page,
            page_size=page_size,
            q=q,
            tag_id=tag_id,
            brand=brand,
            site_code=site_code,
            matched=matched,
        )
        return [ProductOut.model_validate(p) for p in products]

@router.get("/products/brands", response_model=List[str])
async def api_list_brands():
    with get_session() as session:
        rows = session.execute(
            select(func.distinct(Product.brand)).where(Product.brand.is_not(None)).order_by(Product.brand.asc())
        ).all()
        return [r[0] for r in rows if r[0]]