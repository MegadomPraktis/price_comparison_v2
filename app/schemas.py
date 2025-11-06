# -*- coding: utf-8 -*-
from typing import Optional, List, Dict
from pydantic import BaseModel, Field, ConfigDict
from datetime import datetime
from enum import Enum

class SiteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    name: str
    base_url: str

class SiteCreate(BaseModel):
    code: str
    name: str
    base_url: str

# Tags
class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str

class TagCreate(BaseModel):
    name: str

class TagAssign(BaseModel):
    product_id: int
    tag_id: int

class TagsByProductsRequest(BaseModel):
    product_ids: List[int]

# Products & matching
class ProductIn(BaseModel):
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None
    item_number: Optional[str] = None
    brand: Optional[str] = None

class ProductOut(BaseModel):
    id: int
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None
    item_number: Optional[str] = None
    brand: Optional[str] = None
    tags: List[TagOut] = []
    class Config:
        from_attributes = True

class MatchCreate(BaseModel):
    product_id: int
    site_code: str
    competitor_sku: Optional[str] = None
    competitor_barcode: Optional[str] = None

class MatchOut(BaseModel):
    id: int
    product_id: int
    site_code: str
    competitor_sku: Optional[str] = None
    competitor_barcode: Optional[str] = None
    product_sku: str
    product_barcode: Optional[str] = None
    product_name: str
    competitor_name: Optional[str] = None
    competitor_url: Optional[str] = None

# Comparison
class ComparisonRowOut(BaseModel):
    product_sku: str
    product_barcode: Optional[str]
    product_name: str
    product_price_regular: Optional[float]
    product_price_promo: Optional[float]
    competitor_site: str
    competitor_sku: Optional[str]
    competitor_barcode: Optional[str]
    competitor_name: Optional[str]
    competitor_price_regular: Optional[float]
    competitor_price_promo: Optional[float]
    competitor_url: Optional[str]
    competitor_label: Optional[str] = None

class ProductAssetOut(BaseModel):
    sku: str
    product_url: Optional[str] = None
    image_url: Optional[str] = None

# Email/export enums (existing)
class PriceSubset(str, Enum):
    all = "all"
    changed = "changed"
    ours_higher = "ours_higher"


class PriceDirection(str, Enum):
    any = "any"
    better = "better"   # our price lower
    worse = "worse"     # our price higher


class EmailRuleIn(BaseModel):
    name: str

    # filters
    tag_ids: Optional[List[int]] = None
    brand: Optional[str] = None
    site_code: str = "all"

    # legacy server option (still stored)
    price_subset: PriceSubset = PriceSubset.all

    # UI sends 'promo_only'; DB column is 'only_promo'
    only_promo: bool = Field(False, alias="promo_only")

    # NEW: category + direction + changed24
    category_id: Optional[int] = None
    price_direction: PriceDirection = PriceDirection.any
    changed_24h: bool = False

    # recipients / notes
    subscribers: str = Field(..., description="Comma-separated emails")
    notes: Optional[str] = None

    model_config = ConfigDict(populate_by_name=True)


class EmailRuleOut(EmailRuleIn):
    id: int
    created_by: Optional[str] = None
    created_on: datetime
    modified_by: Optional[str] = None
    modified_on: datetime
    # For convenience: API may enrich with category_path for display
    category_path: Optional[str] = None

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

class WeeklySchedule(BaseModel):
    mon: str | None = "10:00"
    tue: str | None = "10:00"
    wed: str | None = "10:00"
    thu: str | None = "10:00"
    fri: str | None = "10:00"
    sat: str | None = None
    sun: str | None = None

# Local response models (kept here to avoid touching app/schemas.py)
class AnalyticsPointOut(BaseModel):
    ts: datetime
    regular_price: Optional[float] = None
    promo_price: Optional[float] = None
    effective_price: Optional[float] = None  # promo if present else regular
    label: Optional[str] = None              # WHY price is set (promo/brochure/campaign/etc.)

class AnalyticsSeriesOut(BaseModel):
    site_code: str
    site_name: str
    color: str
    points: List[AnalyticsPointOut]

class AnalyticsHistoryOut(BaseModel):
    product_sku: str
    product_name: Optional[str] = None
    product_barcode: Optional[str] = None
    series: List[AnalyticsSeriesOut]

# --- NEW: Groups -------------------------------------------------------------
class GroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    parent_id: Optional[int] = None

# --- EXISTING: ProductIn / ProductOut (add groupid) -------------------------
class ProductIn(BaseModel):
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None
    item_number: Optional[str] = None
    brand: Optional[str] = None
    # NEW
    groupid: Optional[int] = None

class ProductOut(BaseModel):
    id: int
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None
    item_number: Optional[str] = None
    brand: Optional[str] = None
    # NEW
    groupid: Optional[int] = None
    class Config:
        from_attributes = True