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

PRAKTIKER_SEARCH_URL = "https://praktiker.bg/search/{}"
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
    m = re.search(r"(\d+(?:[.,]\d{1,2})?)", txt.replace("\xa0"," "))
    if not m: return None
    return float(m.group(1).replace(",", "."))

def parse_dual_price_block(scope) -> Tuple[Optional[float], Optional[float]]:
    """
    Return (BGN, EUR) from a price block.

    Supports both the legacy structure with <span class="price-wrapper">…</span>
    and the new one where values live directly under .product-price.

    Also prefers the non-old block so we don't accidentally read the struck-out price.
    """
    # Prefer the non-old block; fall back to the first product-price
    cont = (scope.css_first("span.product-price:not(.product-price--old)")
            or scope.css_first("span.product-price"))
    if not cont:
        return (None, None)

    # Old structure: wrappers contain separate BGN/EUR nodes
    wrappers = cont.css("span.price-wrapper")
    if wrappers:
        bgn = None
        v = wrappers[0].css_first("span.product-price__value")
        if v:
            bgn = to_float(v.text(strip=True))
        eur = None
        if len(wrappers) > 1:
            v2 = wrappers[1].css_first("span.product-price__value")
            if v2:
                eur = to_float(v2.text(strip=True))
        return (bgn, eur)

    # New structure: values are direct children inside .product-price
    values = [to_float(v.text(strip=True)) for v in cont.css("span.product-price__value")]
    values = [x for x in values if x is not None]
    if not values:
        return (None, None)
    bgn = values[0]
    eur = values[1] if len(values) > 1 else None
    return (bgn, eur)

# ---- NEW: extract regular & promo according to Praktiker's markup ----
def extract_praktiker_prices(scope) -> Tuple[Optional[float], Optional[float]]:
    """
    Return (regular_bgn, promo_bgn).

    If an old price exists (.product-price--old), that's the regular price.
    The next .product-price (without --old) provides the current/promo BGN (its FIRST value).
    If no old price exists, the single price is treated as regular, promo=None.
    """
    # Old (regular) price
    old_el = scope.css_first("span.product-price.product-price--old span.product-price__value")
    regular = to_float(old_el.text(strip=True)) if old_el else None

    # Promo/current price (BGN is the first value in the non-old block)
    promo = None
    current_block = scope.css_first("span.product-price:not(.product-price--old)")
    if current_block:
        v = current_block.css_first("span.product-price__value")
        if v:
            promo = to_float(v.text(strip=True))

    # Fallback: if nothing found at all, fall back to dual-price parser as "current" price
    if regular is None and promo is None:
        bgn, _ = parse_dual_price_block(scope)
        regular = bgn
        promo = None

    # If only promo is present (no old), treat it as regular
    if regular is None and promo is not None:
        regular, promo = promo, None

    return (regular, promo)

async def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(http2=False, limits=CLIENT_LIMITS, timeout=CLIENT_TIMEOUT, headers=build_headers(), follow_redirects=True)

@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(0.8, 2.2))
async def _get(client: httpx.AsyncClient, url: str) -> str:
    r = await client.get(url, headers=build_headers())
    r.raise_for_status()
    return r.text

class PraktikerScraper(BaseScraper):
    def __init__(self):
        self.site_code = "praktiker"  # required by BaseScraper
        self._bucket = _TokenBucket(REQUESTS_PER_SECOND, BURST)
        self._sem = asyncio.Semaphore(CONCURRENCY)

    async def search_by_barcode(self, barcode: Optional[str]) -> Optional[SearchResult]:
        """
        Lightweight helper used by auto-match: given a barcode, try to find a card and derive the SKU.
        """
        if not barcode: return None
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, PRAKTIKER_SEARCH_URL.format(barcode))
        tree = HTMLParser(html)
        grid = tree.css_first("div.products-grid")
        if not grid: return None
        card = grid.css_first("te-product-box div.products-grid__item")
        if not card: return None
        a = card.css_first("a[href*='/p/']")
        href = a.attributes.get("href") if a else None
        url = (href if (href and href.startswith("http")) else ("https://praktiker.bg" + href)) if href else None
        competitor_sku = None
        if href:
            m = re.search(r"/p/(\d+)", href)
            if m: competitor_sku = m.group(1)
        name_el = card.css_first("h2.product-item__title a")
        name = name_el.text(strip=True) if name_el else None
        return SearchResult(competitor_sku=competitor_sku, competitor_barcode=None, url=url, name=name)

    def _choose_query(self, match) -> tuple[str, str]:
        """
        Decide what to search with.
        - If both SKU and barcode populated -> use SKU
        - Else use whichever is populated
        Empty strings are treated as missing.
        Returns: (query_string, "sku"|"barcode")
        """
        sku = (match.competitor_sku or "").strip() or None
        bar = (match.competitor_barcode or "").strip() or None
        if sku:
            return sku, "sku"
        if bar:
            return bar, "barcode"
        return "", "none"

    async def fetch_product_by_match(self, match, product=None) -> Optional[CompetitorDetail]:
        """
        Scrape using the chosen key (SKU preferred over barcode).
        If searching by barcode, we try to DERIVE the Praktiker SKU from the /p/<digits> link.
        """
        query, used = self._choose_query(match)
        if not query:
            return None

        search_url = PRAKTIKER_SEARCH_URL.format(query)

        # Search page
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, search_url)

        tree = HTMLParser(html)
        grid = tree.css_first("div.products-grid")
        name = None
        price_reg_bgn = None
        price_promo_bgn = None
        pdp_url = None
        derived_sku = None

        if grid:
            card = grid.css_first("te-product-box div.products-grid__item")
            if card:
                name_el = card.css_first("h2.product-item__title a")
                name = name_el.text(strip=True) if name_el else None

                # >>> NEW: capture (regular, promo) directly from the card
                price_reg_bgn, price_promo_bgn = extract_praktiker_prices(card)

                a = card.css_first("a[href*='/p/']")
                if a:
                    href = a.attributes.get("href")
                    if href:
                        pdp_url = href if href.startswith("http") else "https://praktiker.bg" + href
                        m_id = re.search(r"/p/(\d+)", href)
                        if m_id:
                            derived_sku = m_id.group(1)  # we ALWAYS try to derive a SKU from the link

        # If we still have no price (e.g., card hides it), follow PDP
        if (price_reg_bgn is None and price_promo_bgn is None) and pdp_url:
            async with self._sem:
                await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
                await self._bucket.take()
                async with await _make_client() as client:
                    html2 = await _get(client, pdp_url)
            t2 = HTMLParser(html2)
            if not name:
                h = t2.css_first("h1, h1.product-title, title")
                name = h.text(strip=True) if h else None

            # >>> NEW: capture (regular, promo) from PDP
            price_reg_bgn, price_promo_bgn = extract_praktiker_prices(t2)

            # Fallback to dual parser as a last resort
            if price_reg_bgn is None and price_promo_bgn is None:
                price_reg_bgn, _ = parse_dual_price_block(t2)

        # Decide final identifiers:
        # - Prefer derived_sku when present (especially when we searched by barcode)
        # - Keep original barcode if present on the match (Praktiker rarely shows EAN on page)
        final_sku = (derived_sku or (match.competitor_sku or "").strip() or None)
        final_bar = (match.competitor_barcode or "").strip() or None

        return CompetitorDetail(
            competitor_sku=final_sku,
            competitor_barcode=final_bar,
            url=pdp_url or search_url,
            name=name,
            regular_price=price_reg_bgn,
            promo_price=price_promo_bgn
        )

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
