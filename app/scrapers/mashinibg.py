# -*- coding: utf-8 -*-
"""
OnlineMashini (mashinibg) scraper integrated with your BaseScraper interface.

- Uses your Match model's competitor_sku / competitor_barcode as the query.
- Prefers SKU if present; else falls back to barcode (same strategy as Praktiker).
- Search page parsers match the selectors you used in your standalone script:
  card:   div.product-box-h.cat.rounded.col-md-12.product_container.mb-2
  name:   div.col-8.col-md-8.full.description.pr-md-4 -> first a|h2|h3|h4
  old:    span.otstupka.oldprice s
  price:  div.price
- PDP fallback with broad price/name extraction if the search card is not enough.
"""
from __future__ import annotations
import re
import time
import random
import asyncio
import threading
from typing import Optional, Tuple

import httpx
from httpx import Limits, Timeout
from selectolax.parser import HTMLParser
from tenacity import retry, stop_after_attempt, wait_exponential_jitter
import cloudscraper
from urllib.parse import quote as url_quote

from app.scrapers.base import BaseScraper, SearchResult, CompetitorDetail

MASHINIBG_SEARCH_URL = "https://www.onlinemashini.bg/search/{}"

# Gentle defaults; site is sensitive
CONCURRENCY = 4
REQUESTS_PER_SECOND = 0.8
BURST = 2
JITTER_MIN, JITTER_MAX = (0.03, 0.12)

CLIENT_LIMITS = Limits(max_keepalive_connections=16, max_connections=32)
CLIENT_TIMEOUT = Timeout(connect=8.0, read=14.0, write=14.0, pool=14.0)

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

def _headers() -> dict:
    import random as _r
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": _r.choice(_USER_AGENTS),
        "Referer": "https://www.onlinemashini.bg/",
    }

def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        http2=False,
        limits=CLIENT_LIMITS,
        timeout=CLIENT_TIMEOUT,
        headers=_headers(),
        follow_redirects=True,
    )

# ---- Token bucket (same idea as in Praktiker) --------------------------------
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

# ---- cloudscraper fallback first, httpx second -------------------------------
_scraper_lock = threading.Lock()
_scraper_session = None

def _cloudscraper_fetch(url: str) -> str:
    global _scraper_session
    with _scraper_lock:
        if _scraper_session is None:
            s = cloudscraper.create_scraper()
            s.headers.update(_headers())
            try:
                s.get("https://www.onlinemashini.bg", timeout=17)
            except Exception:
                pass
            _scraper_session = s
        s = _scraper_session
    r = s.get(url, timeout=17)
    r.raise_for_status()
    return r.text

@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(0.8, 2.2))
async def _get_html(url: str) -> str:
    loop = asyncio.get_running_loop()
    # Try cloudscraper in a thread first
    try:
        return await loop.run_in_executor(None, _cloudscraper_fetch, url)
    except Exception:
        pass
    # Fallback to httpx
    async with _make_client() as client:
        r = await client.get(url, headers=_headers())
        r.raise_for_status()
        return r.text

# ---- utils -------------------------------------------------------------------
_NUM_RE = r"(?:\d{1,3}(?:[ \u00A0.,]\d{3})+|\d+)"
_PRICE_BGN_RE = re.compile(rf"({_NUM_RE})(?:[.,](\d{{2}}))?\s*лв", re.IGNORECASE)

def _norm_num(s: str) -> Optional[float]:
    if not s: return None
    s = s.replace("\u00A0", " ").strip()
    s = re.sub(r"[^\d,\.]", "", s).replace(" ", "")
    if re.search(r"[.,]\d{2}$", s):
        s = s.replace(",", ".")
    else:
        if "," in s and not re.search(r",\d{2}$", s):
            s = s.replace(",", "")
        if re.fullmatch(r"\d{3,}", s):
            try: return round(float(s) / 100, 2)
            except Exception: pass
        s = s.replace(",", ".")
    try:
        return round(float(s), 2)
    except Exception:
        return None

def _price_from_text(text: str) -> Optional[float]:
    if not text: return None
    m = _PRICE_BGN_RE.search(text)
    if not m: return None
    whole, dec = m.group(1), m.group(2) or ""
    return _norm_num(whole + ("." + dec if dec else ""))

# ---- parsing per your search-card structure ----------------------------------
def _parse_search_card(html: str) -> Tuple[Optional[dict], Optional[str]]:
    tree = HTMLParser(html)
    card = tree.css_first("div.product-box-h.cat.rounded.col-md-12.product_container.mb-2")
    if not card:
        return None, None

    desc = card.css_first("div.col-8.col-md-8.full.description.pr-md-4")
    name = "N/A"
    if desc:
        t = None
        for sel in ("a", "h2", "h3", "h4"):
            el = desc.css_first(sel)
            if el:
                t = el.text(strip=True)
                if t: break
        if not t:
            t = desc.text(strip=True)
        name = t or "N/A"

    pdp_link = None
    if desc:
        a = desc.css_first("a[href]")
        if a:
            href = a.attributes.get("href", "")
            if href:
                pdp_link = href if href.startswith("http") else "https://www.onlinemashini.bg" + href

    old_el = card.css_first("span.otstupka.oldprice s")
    price_el = card.css_first("div.price")
    old_bgn = _price_from_text(old_el.text(strip=True) if old_el else "")
    new_bgn = _price_from_text(price_el.text(strip=True) if price_el else "")

    data = None
    if (new_bgn is not None) or (old_bgn is not None):
        data = {
            "name": name,
            "regular_price": old_bgn if old_bgn is not None else new_bgn,
            "promo_price": new_bgn if old_bgn is not None else None,
            "url": pdp_link,
        }
    return data, pdp_link

def _parse_pdp(html: str) -> Tuple[Optional[str], Optional[float], Optional[float]]:
    tree = HTMLParser(html)
    name = None
    for sel in ("h1", "h1.product-title", "title"):
        el = tree.css_first(sel)
        if el:
            t = el.text(strip=True)
            if t:
                name = t; break
    compact = re.sub(r"\s+", " ", html)
    m_old = re.search(r"ПЦД:\s*([^\n\r<]+?)лв", compact, flags=re.IGNORECASE)
    old_bgn = _norm_num(m_old.group(1)) if m_old else None
    m_new = re.search(r"(\d[\d\s.,]{0,12})\s*лв", compact)
    new_bgn = _norm_num(m_new.group(1)) if m_new else None
    if old_bgn is None and new_bgn is not None:
        return name, new_bgn, None
    return name, old_bgn, new_bgn

# ---- scraper -----------------------------------------------------------------
class MashiniBgScraper(BaseScraper):
    def __init__(self):
        self.site_code = "mashinibg"
        self._bucket = _TokenBucket(REQUESTS_PER_SECOND, BURST)
        self._sem = asyncio.Semaphore(CONCURRENCY)

    # Used by auto-match (barcode → a potential SKU we can store)
    async def search_by_barcode(self, barcode: Optional[str]) -> Optional[SearchResult]:
        if not barcode:
            return None
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            # in search_by_barcode(...)
            html = await _get_html(MASHINIBG_SEARCH_URL.format(url_quote(str(barcode), safe="")))

        data, pdp_link = _parse_search_card(html)
        if not data and not pdp_link:
            return None

        # We usually don’t have an internal “SKU” in the URL, but keep URL/name
        return SearchResult(
            competitor_sku=None,                   # Mashini may not expose a canonical numeric id on list
            competitor_barcode=str(barcode),       # keep the barcode we searched with
            url=(data or {}).get("url") or pdp_link,
            name=(data or {}).get("name"),
        )

    def _choose_query(self, match) -> tuple[str, str]:
        sku = (match.competitor_sku or "").strip() or None
        bar = (match.competitor_barcode or "").strip() or None
        if sku: return sku, "sku"
        if bar: return bar, "barcode"
        return "", "none"

    async def fetch_product_by_match(self, match) -> Optional[CompetitorDetail]:
        query, used = self._choose_query(match)
        if not query:
            return None

        # in fetch_product_by_match(...)
        search_url = MASHINIBG_SEARCH_URL.format(url_quote(str(query), safe=""))

        # Search page pass
        async with self._sem:
            await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
            await self._bucket.take()
            html = await _get_html(search_url)

        parsed, pdp_link = _parse_search_card(html)
        name = (parsed or {}).get("name")
        regular = (parsed or {}).get("regular_price")
        promo = (parsed or {}).get("promo_price")
        url = (parsed or {}).get("url") or pdp_link or search_url

        # PDP fallback if prices missing
        if (regular is None and promo is None) and pdp_link:
            async with self._sem:
                await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX))
                await self._bucket.take()
                html2 = await _get_html(pdp_link)
            n2, r2, p2 = _parse_pdp(html2)
            if n2: name = n2
            if r2 is not None: regular = r2
            if p2 is not None: promo = p2
            url = pdp_link

        # Final identifiers:
        # - Keep provided competitor_sku if you have one; Mashini rarely exposes a stable numeric id in list urls.
        final_sku = (match.competitor_sku or "").strip() or None
        final_bar = (match.competitor_barcode or "").strip() or (query if used == "barcode" else None)

        return CompetitorDetail(
            competitor_sku=final_sku,
            competitor_barcode=final_bar,
            url=url,
            name=name,
            regular_price=regular,
            promo_price=promo,
        )
