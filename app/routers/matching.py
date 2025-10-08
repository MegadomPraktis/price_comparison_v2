# -*- coding: utf-8 -*-
from typing import List, Optional
from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.db import get_session
from app.schemas import MatchOut, MatchCreate
from app.services.matching import (
    list_matches,
    create_or_update_match,
    auto_match_for_site,
    get_matches_for_product_ids,  # NEW
)
from app.registry import registry

router = APIRouter()

@router.get("/matches", response_model=List[MatchOut])
async def api_list_matches(
    site_code: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
    tag_id: Optional[int] = Query(None),
):
    with get_session() as session:
        return list_matches(session, site_code=site_code, page=page, page_size=page_size, tag_id=tag_id)

@router.post("/matches", response_model=MatchOut)
async def api_create_match(payload: MatchCreate):
    with get_session() as session:
        return create_or_update_match(session, payload)

class AutoMatchResult(BaseModel):
    attempted: int
    found: int

@router.post("/matches/auto", response_model=AutoMatchResult)
async def api_auto_match(
    site_code: str,
    limit: int = Query(100, ge=1, le=1000),
):
    scraper = registry.get(site_code)
    with get_session() as session:
        attempted, found = await auto_match_for_site(session, scraper, limit=limit)
        return AutoMatchResult(attempted=attempted, found=found)

# NEW: bulk lookup endpoint to prefill competitor fields for a page of products
class MatchesLookupRequest(BaseModel):
    site_code: str
    product_ids: List[int]

@router.post("/matches/lookup", response_model=List[MatchOut])
async def api_matches_lookup(payload: MatchesLookupRequest):
    with get_session() as session:
        return get_matches_for_product_ids(session, payload.site_code, payload.product_ids)
