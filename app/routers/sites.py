# -*- coding: utf-8 -*-
from typing import List
from fastapi import APIRouter
from sqlalchemy import select
from app.db import get_session
from app import models
from app.schemas import SiteOut, SiteCreate

router = APIRouter()

@router.get("/sites", response_model=List[SiteOut])
async def list_sites():
    with get_session() as session:
        q = session.execute(models.select_sites())
        return [SiteOut.model_validate(s) for s in q.scalars().all()]

@router.post("/sites", response_model=SiteOut)
async def add_site(payload: SiteCreate):
    with get_session() as session:
        site = models.CompetitorSite(code=payload.code, name=payload.name, base_url=payload.base_url)
        session.add(site)
        session.commit()
        session.refresh(site)
        return SiteOut.model_validate(site)
