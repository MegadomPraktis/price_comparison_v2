# -*- coding: utf-8 -*-
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel
from app.db import get_session
from app.erp import parse_erp_xml_and_upsert

router = APIRouter()

class ERPIngestResult(BaseModel):
    inserted: int
    updated: int

@router.post("/erp/ingest_xml", response_model=ERPIngestResult)
async def api_ingest_erp_xml(
    xml_file: Optional[UploadFile] = File(None),
    xml_text: Optional[str] = Form(None),
):
    if xml_file:
        xml_text = (await xml_file.read()).decode("utf-8", errors="ignore")
    if not xml_text:
        return ERPIngestResult(inserted=0, updated=0)
    with get_session() as session:
        inserted, updated = await parse_erp_xml_and_upsert(xml_text, session)
        return ERPIngestResult(inserted=inserted, updated=updated)
