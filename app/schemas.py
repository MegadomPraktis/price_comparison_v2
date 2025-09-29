# -*- coding: utf-8 -*-
from typing import Optional
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

class ProductIn(BaseModel):
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None

class ProductOut(BaseModel):
    id: int
    sku: str
    barcode: Optional[str] = None
    name: str
    price_regular: Optional[float] = None
    price_promo: Optional[float] = None
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
