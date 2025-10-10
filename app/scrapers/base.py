# -*- coding: utf-8 -*-
from __future__ import annotations
from typing import Optional, Dict
from dataclasses import dataclass

@dataclass
class SearchResult:
    competitor_sku: Optional[str] = None
    competitor_barcode: Optional[str] = None
    url: Optional[str] = None
    name: Optional[str] = None

@dataclass
class CompetitorDetail:
    competitor_sku: Optional[str] = None
    competitor_barcode: Optional[str] = None
    url: Optional[str] = None
    name: Optional[str] = None
    regular_price: Optional[float] = None
    promo_price: Optional[float] = None

class BaseScraper:
    site_code: str
    async def search_by_barcode(self, barcode: Optional[str]) -> Optional[SearchResult]:
        raise NotImplementedError
    async def fetch_product_by_match(self, match) -> Optional[CompetitorDetail]:
        raise NotImplementedError
    async def search_by_item_number(self, item_number: Optional[str], brand: Optional[str] = None) -> Optional[SearchResult]:
        return None

class ScraperRegistry:
    def __init__(self):
        self._reg: Dict[str, BaseScraper] = {}
    def register(self, site_code: str, scraper: BaseScraper):
        scraper.site_code = site_code
        self._reg[site_code] = scraper
    def get(self, site_code: str) -> BaseScraper:
        if site_code not in self._reg:
            raise ValueError(f"No scraper registered for {site_code}")
        return self._reg[site_code]
