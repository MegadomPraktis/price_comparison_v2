# -*- coding: utf-8 -*-
from typing import List, Dict
from fastapi import APIRouter, Query
from sqlalchemy import select, delete, insert
from app.db import get_session
from app.models import Tag, Product, ProductTag
from app.schemas import TagOut, TagCreate, TagAssign, TagsByProductsRequest

router = APIRouter()

@router.get("/tags", response_model=List[TagOut])
async def list_tags():
    with get_session() as session:
        rows = session.execute(select(Tag).order_by(Tag.name.asc())).scalars().all()
        return [TagOut.model_validate(t) for t in rows]

@router.post("/tags", response_model=TagOut)
async def create_tag(payload: TagCreate):
    with get_session() as session:
        t = Tag(name=payload.name.strip())
        session.add(t)
        session.commit()
        session.refresh(t)
        return TagOut.model_validate(t)

@router.delete("/tags/{tag_id}")
async def delete_tag(tag_id: int):
    with get_session() as session:
        session.execute(delete(ProductTag).where(ProductTag.c.tag_id == tag_id))
        session.execute(delete(Tag).where(Tag.id == tag_id))
        session.commit()
        return {"ok": True}

@router.post("/tags/assign")
async def assign_tag(payload: TagAssign):
    with get_session() as session:
        # ensure product/tag exist
        p = session.execute(select(Product.id).where(Product.id == payload.product_id)).scalar_one_or_none()
        t = session.execute(select(Tag.id).where(Tag.id == payload.tag_id)).scalar_one_or_none()
        if not p or not t:
            return {"ok": False, "error": "Invalid product or tag"}
        # upsert-like: ignore if exists
        try:
            session.execute(insert(ProductTag).values(product_id=p, tag_id=t))
            session.commit()
        except Exception:
            session.rollback()  # likely duplicate
        return {"ok": True}

@router.post("/tags/unassign")
async def unassign_tag(payload: TagAssign):
    with get_session() as session:
        session.execute(
            delete(ProductTag).where(ProductTag.c.product_id == payload.product_id, ProductTag.c.tag_id == payload.tag_id)
        )
        session.commit()
        return {"ok": True}

@router.post("/tags/by_products")
async def tags_by_products(payload: TagsByProductsRequest):
    if not payload.product_ids:
        return {}
    with get_session() as session:
        q = (
            select(ProductTag.c.product_id, Tag.id, Tag.name)
            .join(Tag, Tag.id == ProductTag.c.tag_id)
            .where(ProductTag.c.product_id.in_(payload.product_ids))
        )
        out: Dict[int, List[dict]] = {}
        for pid, tid, name in session.execute(q).all():
            out.setdefault(pid, []).append({"id": tid, "name": name})
        return out
