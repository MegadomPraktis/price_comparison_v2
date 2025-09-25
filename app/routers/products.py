# -*- coding: utf-8 -*-
from typing import List, Optional
from fastapi import APIRouter, Query
from app.db import get_session
from app.schemas import ProductOut
from app.services.matching import list_products_simple

router = APIRouter()

@router.get("/products", response_model=List[ProductOut])
async def api_list_products(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    q: Optional[str] = Query(None),
):
    with get_session() as session:
        products = list_products_simple(session, page=page, page_size=page_size, q=q)
        return [ProductOut.model_validate(p) for p in products]
