# -*- coding: utf-8 -*-
import re
import time
import random
import asyncio
from typing import Optional, Tuple

import httpx
from httpx import Limits, Timeout
from selectolax.parser import HTMLParser
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from app.scrapers.base import BaseScraper, SearchResult, CompetitorDetail

MRB_SEARCH_URL = "https://mr-bricolage.bg/search-list?query={}"

# keep these in line with praktiker scraper style
CONCURRENCY = 8
REQUESTS_PER_SECOND = 1.5
BURST = 3
JITTER_MIN, JITTER_MAX = (0.03, 0.12)
CLIENT_LIMITS = Limits(max_keepalive_connections=16, max_connections=32)
CLIENT_TIMEOUT = Timeout(connect=8.0, read=14.0, write=14.0, pool=14.0)

def build_headers() -> dict:
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    }

def to_float(txt: Optional[str]) -> Optional[float]:
    if not txt: return None
    m = re.search(r"(\d+(?:[.,]\d{1,2})?)", txt.replace("\xa0", " "))
    if not m: return None
    return float(m.group(1).replace(",", "."))

def parse_price_block(el) -> Optional[float]:
    if not el: return None
    # MrBricolage often renders like: <div class="product__price"><span>12,99 лв.</span></div>
    txt = el.text(strip=True) if hasattr(el, "text") else None
    return to_float(txt)

def parse_mrb_card(card) -> Tuple[Optional[str], Optional[float], Optional[float], Optional[str]]:
    """
    Returns: (name, regular_price, promo_price, pdp_url)
    HTML sketch (as per your example):
      div.plp-product div.product
        div.product__content-top a/h2/h3...
        div.product__price--old div.product__price       -> old (regular)
        div.product__price--new div.product__price       -> new (promo)
        OR single div.product__price (regular when only one)
    """
    if not card: return (None, None, None, None)

    # name & link
    name = None
    pdp_url = None
    name_cont = card.css_first("div.product__content-top")
    if name_cont:
        a = name_cont.css_first("a")
        if a:
            name = a.text(strip=True)
            href = a.attributes.get("href")
            if href:
                pdp_url = href if href.startswith("http") else ("https://mr-bricolage.bg" + href)
        else:
            # fallback to any header text inside content-top
            h = name_cont.css_first("a, h2, h3, h4, .product__title")
            if h:
                name = h.text(strip=True)

    # prices
    old_div = card.css_first("div.product__price--old div.product__price")
    new_div = card.css_first("div.product__price--new div.product__price")
    old_price = parse_price_block(old_div) if old_div else None
    new_price = parse_price_block(new_div) if new_div else None

    if old_price is None and new_price is None:
        single = card.css_first("div.product__price")
        if single:
            old_price = parse_price_block(single)  # treat single as regular
            new_price = None

    # map to (regular, promo)
    if old_price is not None and new_price is not None:
        regular_price = old_price
        promo_price = new_price
    else:
        regular_price = old_price or new_price
        promo_price = None

    return (name, regular_price, promo_price, pdp_url)

async def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        http2=False,
        limits=CLIENT_LIMITS,
        timeout=CLIENT_TIMEOUT,
        headers=build_headers(),
        follow_redirects=True,
    )

@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(0.8, 2.2))
async def _get(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, headers=build_headers())
    r.raise_for_status()
    return r.text

class _TokenBucket:
    def __init__(self, rate: float, capacity: float):
        self.rate = float(rate); self.capacity = float(capacity)
        self.tokens = float(capacity); self.last = time.perf_counter()
        self._lock = asyncio.Lock()
    async def take(self, n: float = 1.0):
        async with self._lock:
            now = time.perf_counter()
            elapsed = now - self.last
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now
            if self.tokens >= n:
                self.tokens -= n; return
            wait_for = (n - self.tokens) / self.rate
        await asyncio.sleep(wait_for)
        async with self._lock:
            now = time.perf_counter()
            elapsed = now - self.last
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now
            self.tokens = max(0.0, self.tokens - n)

class MrBricolageScraper(BaseScraper):
    def __init__(self):
        self.site_code = "mrbricolage"
        self._bucket = _TokenBucket(REQUESTS_PER_SECOND, BURST)
        self._sem = asyncio.Semaphore(CONCURRENCY)

    async def search_by_barcode(self, barcode: Optional[str]) -> Optional[SearchResult]:
        """
        Used by auto-match: try to find a first card for this EAN and return URL & name.
        (MrBricolage doesn’t expose a stable numeric SKU in the URL, so we usually key by barcode.)
        """
        if not barcode: return None
        search_url = MRB_SEARCH_URL.format(barcode)
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, search_url)

        tree = HTMLParser(html)
        card = tree.css_first("div.plp-product div.product")
        if not card:
            return None

        name, _, _, pdp_url = parse_mrb_card(card)
        return SearchResult(
            competitor_sku=None,               # usually unknown from search page
            competitor_barcode=None,           # we don’t discover it on page; we keep user’s EAN in Match
            url=pdp_url or search_url,
            name=name
        )

    def _choose_query(self, match) -> tuple[str, str]:
        # Prefer SKU if present; else barcode — exactly like Praktiker
        sku = (match.competitor_sku or "").strip() or None
        bar = (match.competitor_barcode or "").strip() or None
        if sku: return sku, "sku"
        if bar: return bar, "barcode"
        return "", "none"

    async def fetch_product_by_match(self, match, product=None) -> Optional[CompetitorDetail]:
        """
        Scrape using chosen key. We search and parse the first card.
        If prices aren’t visible on the grid, we’ll still return name+URL
        (you can later extend this to fetch PDP if needed).
        """
        query, _ = self._choose_query(match)
        if not query:
            return None

        search_url = MRB_SEARCH_URL.format(query)
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, search_url)

        tree = HTMLParser(html)
        card = tree.css_first("div.plp-product div.product")
        if not card:
            return None

        name, regular_price, promo_price, pdp_url = parse_mrb_card(card)

        # MrBricolage: we typically cannot derive a clean numeric SKU from the link → keep given identifiers
        final_sku = (match.competitor_sku or "").strip() or None
        final_bar = (match.competitor_barcode or "").strip() or None

        return CompetitorDetail(
            competitor_sku=final_sku,
            competitor_barcode=final_bar,
            url=pdp_url or search_url,
            name=name,
            regular_price=regular_price,
            promo_price=promo_price
        )
