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

MASHINIBG_SEARCH_URL = "https://www.onlinemashini.bg/search/{}"

# basic concurrency config
CONCURRENCY = 8
REQUESTS_PER_SECOND = 1.5
BURST = 3
JITTER_MIN, JITTER_MAX = (0.03, 0.12)
CLIENT_LIMITS = Limits(max_keepalive_connections=16, max_connections=32)
CLIENT_TIMEOUT = Timeout(connect=8.0, read=14.0, write=14.0, pool=14.0)


def build_headers() -> dict:
    # A realistic header set to reduce blocking
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.onlinemashini.bg/",
        "Sec-Ch-Ua": '"Chromium";v="126", "Not.A/Brand";v="8"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.6478.127 Safari/537.36"
        ),
    }


def to_float(txt: Optional[str]) -> Optional[float]:
    if not txt:
        return None
    m = re.search(r"(\d+(?:[.,]\d{1,2})?)", txt.replace("\xa0", " "))
    if not m:
        return None
    return float(m.group(1).replace(",", "."))


def parse_price_block(el) -> Optional[float]:
    if not el:
        return None
    txt = el.text(strip=True) if hasattr(el, "text") else None
    return to_float(txt)


def parse_mashinibg_card(card) -> Tuple[Optional[str], Optional[float], Optional[float], Optional[str]]:
    """
    Example HTML structure:
    <div class="product-box-h cat rounded col-md-12 product_container mb-2">
        <div class="col-8 col-md-8 full description pr-md-4">
            <a href="/product/some-product">Product Name</a>
        </div>
        <span class="otstupka oldprice"><s>189.00 лв.</s></span>
        <div class="price">169.00 лв.</div>
    </div>
    """
    if not card:
        return (None, None, None, None)

    # Name & link
    name = None
    pdp_url = None
    desc_div = card.css_first("div.col-8.col-md-8.full.description.pr-md-4")
    if desc_div:
        a = desc_div.css_first("a")
        if a:
            name = a.text(strip=True)
            href = a.attributes.get("href")
            if href:
                pdp_url = href if href.startswith("http") else "https://www.onlinemashini.bg" + href
        else:
            name = desc_div.text(" ", strip=True)

    # Prices
    oldprice_s = card.css_first("span.otstupka.oldprice s")
    old_price = parse_price_block(oldprice_s) if oldprice_s else None
    price_div = card.css_first("div.price")
    new_price = parse_price_block(price_div) if price_div else None

    if old_price and new_price:
        regular_price = old_price
        promo_price = new_price
    else:
        regular_price = new_price if new_price else None
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


@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(1, 3))
async def _get(client: httpx.AsyncClient, url: str) -> str:
    """
    Make GET request with randomized headers to avoid blocking by MashiniBG.
    If the site still blocks us, return empty HTML instead of raising an error.
    """
    try:
        # small random delay between requests
        await asyncio.sleep(random.uniform(0.8, 1.8))

        headers = build_headers().copy()
        headers["Referer"] = random.choice([
            "https://www.google.com/",
            "https://www.facebook.com/",
            "https://www.bing.com/"
        ])

        r = await client.get(url, headers=headers)

        # Retry with different UA if blocked
        if r.status_code in (403, 503):
            ua = random.choice([
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
                "(KHTML, like Gecko) Version/17.3 Safari/605.1.15"
            ])
            headers["User-Agent"] = ua
            headers["Referer"] = "https://www.google.com/"
            await asyncio.sleep(random.uniform(1.0, 2.5))
            r = await client.get(url, headers=headers)

        # If still blocked, skip gracefully
        if r.status_code in (403, 503):
            print(f"[MashiniBG] Blocked for URL: {url} (status={r.status_code})")
            return ""

        r.raise_for_status()
        return r.text

    except Exception as e:
        print(f"[MashiniBG] Request failed for {url}: {e}")
        return ""


class _TokenBucket:
    def __init__(self, rate: float, capacity: float):
        self.rate = float(rate)
        self.capacity = float(capacity)
        self.tokens = float(capacity)
        self.last = time.perf_counter()
        self._lock = asyncio.Lock()

    async def take(self, n: float = 1.0):
        async with self._lock:
            now = time.perf_counter()
            elapsed = now - self.last
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now
            if self.tokens >= n:
                self.tokens -= n
                return
            wait_for = (n - self.tokens) / self.rate
        await asyncio.sleep(wait_for)
        async with self._lock:
            now = time.perf_counter()
            elapsed = now - self.last
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            self.last = now
            self.tokens = max(0.0, self.tokens - n)


class MashiniBGScraper(BaseScraper):
    def __init__(self):
        self.site_code = "mashinibg"
        self._bucket = _TokenBucket(REQUESTS_PER_SECOND, BURST)
        self._sem = asyncio.Semaphore(CONCURRENCY)

    async def search_by_barcode(self, barcode: Optional[str]) -> Optional[SearchResult]:
        if not barcode:
            return None
        search_url = MASHINIBG_SEARCH_URL.format(barcode)
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, search_url)
        if not html:
            return None

        tree = HTMLParser(html)
        card = tree.css_first("div.product-box-h.cat.rounded.col-md-12.product_container.mb-2")
        if not card:
            return None

        name, _, _, pdp_url = parse_mashinibg_card(card)
        return SearchResult(
            competitor_sku=None,
            competitor_barcode=None,
            url=pdp_url or search_url,
            name=name,
        )

    def _choose_query(self, match) -> tuple[str, str]:
        sku = (match.competitor_sku or "").strip() or None
        bar = (match.competitor_barcode or "").strip() or None
        if sku:
            return sku, "sku"
        if bar:
            return bar, "barcode"
        return "", "none"

    async def fetch_product_by_match(self, match) -> Optional[CompetitorDetail]:
        query, _ = self._choose_query(match)
        if not query:
            return None

        search_url = MASHINIBG_SEARCH_URL.format(query)
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            async with await _make_client() as client:
                html = await _get(client, search_url)
        if not html:
            return None

        tree = HTMLParser(html)
        card = tree.css_first("div.product-box-h.cat.rounded.col-md-12.product_container.mb-2")
        if not card:
            return None

        name, regular_price, promo_price, pdp_url = parse_mashinibg_card(card)
        final_sku = (match.competitor_sku or "").strip() or None
        final_bar = (match.competitor_barcode or "").strip() or None

        return CompetitorDetail(
            competitor_sku=final_sku,
            competitor_barcode=final_bar,
            url=pdp_url or search_url,
            name=name,
            regular_price=regular_price,
            promo_price=promo_price,
        )
