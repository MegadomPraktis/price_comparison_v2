# -*- coding: utf-8 -*-
from fastapi import APIRouter
from sqlalchemy import select
from app.db import get_session
from app.models import Group
from app.schemas import GroupOut

router = APIRouter()

@router.get("/groups", response_model=list[GroupOut])
def list_groups():
    with get_session() as s:
        rows = s.execute(select(Group).order_by(Group.name.asc())).scalars().all()
        return rows
