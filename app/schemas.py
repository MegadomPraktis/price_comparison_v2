# -*- coding: utf-8 -*-
from typing import Optional, List, Dict
from pydantic import BaseModel, Field, ConfigDict

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

# --- NEW: Tag schemas
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
    # NEW: enrich matching grid with link + name (when known)
    competitor_name: Optional[str] = None
    competitor_url: Optional[str] = None

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

# NEW: assets
class ProductAssetOut(BaseModel):
  sku: str
  product_url: Optional[str] = None
  image_url: Optional[str] = None