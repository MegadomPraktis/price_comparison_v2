# -*- coding: utf-8 -*-
from typing import Tuple
from xml.etree import ElementTree as ET
from sqlalchemy import select
from datetime import datetime
from app.models import Product

async def parse_erp_xml_and_upsert(xml_text: str, session) -> Tuple[int, int]:
    tree = ET.fromstring(xml_text)
    inserted = 0
    updated = 0

    for item in tree.findall(".//item"):
        sku = (item.findtext("sku") or "").strip()
        if not sku:
            continue
        barcode = (item.findtext("barcode") or "").strip() or None
        name = (item.findtext("name") or "").strip() or sku
        pr = item.findtext("price_regular")
        pp = item.findtext("price_promo")
        try:
            pr_val = float(pr.replace(",", ".")) if pr else None
        except Exception:
            pr_val = None
        try:
            pp_val = float(pp.replace(",", ".")) if pp else None
        except Exception:
            pp_val = None

        existing = session.execute(select(Product).where(Product.sku == sku)).scalars().first()
        if existing:
            existing.barcode = barcode
            existing.name = name
            existing.price_regular = pr_val
            existing.price_promo = pp_val
            existing.updated_at = datetime.utcnow()
            updated += 1
        else:
            session.add(Product(
                sku=sku, barcode=barcode, name=name,
                price_regular=pr_val, price_promo=pp_val
            ))
            inserted += 1

    session.commit()
    return inserted, updated
