# app/routers/analytics.py
# -*- coding: utf-8 -*-
from __future__ import annotations
import random
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Body
from sqlalchemy import select

from app.db import get_session
from app.models import Product, CompetitorSite, Match, PriceSnapshot
from app.schemas import AnalyticsHistoryOut, AnalyticsSeriesOut, AnalyticsPointOut
from app.services.comparison import get_history_for_product

router = APIRouter()

# Fixed colors (match your requirement)
_COLORS = {
    "praktis":      "#f58220",  # orange
    "praktiker":    "#16a34a",  # green
    "mashinibg":    "#1461ff",  # blue
    "mrbricolage":  "#dc2626",  # red
}

@router.get("/analytics/history", response_model=AnalyticsHistoryOut)
def api_analytics_history(product_sku: str = Query(..., min_length=1)):
    """
    Returns time-ordered (asc) series by site for the last 6 months.
    Each point includes:
      - regular_price, promo_price, effective_price (promo or regular)
      - label (snapshot.competitor_label)
    """
    with get_session() as session:
        prod, hist = get_history_for_product(session, product_sku)
        if not prod:
            raise HTTPException(status_code=404, detail="Product not found")

        series: List[AnalyticsSeriesOut] = []
        sites = {s.code: s for s in session.execute(select(CompetitorSite)).scalars().all()}

        for code, snaps in hist.items():
            site = sites.get(code)
            if not site:
                continue
            pts: List[AnalyticsPointOut] = []
            for sn in snaps:
                eff = sn.promo_price if (sn.promo_price is not None) else sn.regular_price
                pts.append(AnalyticsPointOut(
                    ts=sn.ts,
                    regular_price=sn.regular_price,
                    promo_price=sn.promo_price,
                    effective_price=eff,
                    label=sn.competitor_label,
                ))
            series.append(AnalyticsSeriesOut(
                site_code=code,
                site_name=site.name or code,
                color=_COLORS.get(code, "#999999"),
                points=pts
            ))

        return AnalyticsHistoryOut(
            product_sku=prod.sku,
            product_name=prod.name,
            product_barcode=prod.barcode,
            series=series
        )