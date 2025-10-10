# -*- coding: utf-8 -*-
import asyncio
import random
import re
import time
from datetime import datetime
from typing import List, Dict, Optional

import httpx
from httpx import Limits, Timeout
from fastapi import APIRouter, Query
from pydantic import BaseModel
from selectolax.parser import HTMLParser
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from sqlalchemy import select
from app.db import get_session
from app.models import Product, ProductAsset

router = APIRouter()

# ---------- scraper (URL + image only) ----------
BASE = "https://praktis.bg"
SEARCH_URL = BASE + "/catalogsearch/result?q={}"

CONCURRENCY, RPS, BURST = 8, 1.4, 3
JITTER_MIN, JITTER_MAX = (0.03, 0.12)
CLIENT_LIMITS = Limits(max_keepalive_connections=16, max_connections=32)
CLIENT_TIMEOUT = Timeout(connect=8.0, read=14.0, write=14.0, pool=14.0)

def headers() -> dict:
    return {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": BASE + "/",
    }

async def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(http2=False, limits=CLIENT_LIMITS, timeout=CLIENT_TIMEOUT, headers=headers(), follow_redirects=True)

@retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(0.6, 1.6))
async def fetch_html(url: str) -> Optional[str]:
    async with await make_client() as client:
        r = await client.get(url, headers=headers())
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text

def _abs(url: Optional[str]) -> Optional[str]:
    from urllib.parse import urljoin
    if not url:
        return None
    if url.startswith("//"): return "https:" + url
    if url.startswith("/"):  return urljoin(BASE, url)
    return url

def _first_attr(node, names=("src","data-src","data-original","data-lazy")) -> Optional[str]:
    if not node: return None
    for n in names:
        v = node.attributes.get(n)
        if v: return v
    return None

def _first_srcset_url(srcset: Optional[str]) -> Optional[str]:
    if not srcset: return None
    parts = [p.strip() for p in srcset.split(",") if p.strip()]
    if not parts: return None
    return parts[0].split()[0]

def pick_name_link_image(scope: HTMLParser) -> tuple[Optional[str], Optional[str], Optional[str]]:
    # link/name
    a = scope.css_first('a[data-name^="pc:default-title:"]') or scope.css_first('a[data-name^="pc:hover-title:"]') or scope.css_first("a[href]")
    name = a.text(strip=True) if a else None
    href = a.attributes.get("href","") if a else ""
    link = _abs(href) if href else None

    # image
    img = scope.css_first('img[loading][decoding][data-nimg]') \
       or scope.css_first('img[data-name^="pc:default"]') \
       or scope.css_first("img.product-image-photo") \
       or scope.css_first("img")
    image = None
    if img:
        url = _first_attr(img) or _first_srcset_url(img.attributes.get("srcset"))
        image = _abs(url)

    if not image:
        src = scope.css_first("source[srcset]")
        if src:
            url = _first_srcset_url(src.attributes.get("srcset"))
            image = _abs(url)

    if not image:
        meta = scope.css_first('meta[property="og:image"]')
        if meta:
            image = _abs(meta.attributes.get("content"))

    return name, link, image

def parse_search_or_pdp(html: str) -> Optional[Dict]:
    tree = HTMLParser(html)
    card = tree.css_first('article[data-name^="pc:root:"]') or tree.css_first('section[data-name^="pc:default-section:"]') or tree
    name, link, image = pick_name_link_image(card)
    # fallback to whole page if card missed
    if not (name and link):
        n2, l2, i2 = pick_name_link_image(tree)
        name = name or n2; link = link or l2; image = image or i2
    if name or link or image:
        return {"name": name or "N/A", "url": link or "", "image_url": image}
    return None

class _Bucket:
    def __init__(self, rate: float, cap: float):
        self.rate, self.cap = float(rate), float(cap)
        self.tokens, self.last = float(cap), time.perf_counter()
        self._lock = asyncio.Lock()
    async def take(self, n: float = 1.0):
        async with self._lock:
            now = time.perf_counter()
            self.tokens = min(self.cap, self.tokens + (now - self.last) * self.rate); self.last = now
            if self.tokens >= n:
                self.tokens -= n; return
            wait_for = (n - self.tokens) / self.rate
        await asyncio.sleep(wait_for)
        async with self._lock:
            now = time.perf_counter()
            self.tokens = min(self.cap, self.tokens + (now - self.last) * self.rate); self.last = now
            self.tokens = max(0.0, self.tokens - n)

async def scrape_one_sku(sku: str, bucket: _Bucket) -> Dict:
    sku = (sku or "").strip()
    if not sku:
        return {"sku": sku, "status": "not_found", "url": None, "image_url": None}
    await asyncio.sleep(random.uniform(JITTER_MIN, JITTER_MAX)); await bucket.take(1.0)
    url = SEARCH_URL.format(sku)
    try:
        html = await fetch_html(url)
        if not html:
            return {"sku": sku, "status": "not_found", "url": None, "image_url": None}
        parsed = parse_search_or_pdp(html)
        if parsed:
            return {"sku": sku, "status": "ok", "url": parsed.get("url") or url, "image_url": parsed.get("image_url")}
    except Exception:
        pass
    return {"sku": sku, "status": "not_found", "url": url, "image_url": None}

async def run_batch(skus: List[str]) -> List[Dict]:
    bucket = _Bucket(RPS, BURST)
    sem = asyncio.Semaphore(CONCURRENCY)
    async def one(code):
        async with sem:
            return await scrape_one_sku(code, bucket)
    tasks = [asyncio.create_task(one(s)) for s in skus]
    return await asyncio.gather(*tasks)

# ---------- API ----------
class SyncPayload(BaseModel):
    skus: Optional[List[str]] = None
    limit: Optional[int] = None  # optional cap if skus not provided

@router.post("/praktis/assets/sync")
async def sync_praktis_assets(payload: SyncPayload):
    with get_session() as session:
        # collect SKUs
        skus: List[str]
        if payload.skus:
            skus = [s for s in payload.skus if s]
        else:
            q = select(Product.sku).order_by(Product.id.desc())
            if payload.limit and payload.limit > 0:
                q = q.limit(int(payload.limit))
            skus = [r[0] for r in session.execute(q).all()]

        if not skus:
            return {"checked": 0, "updated": 0, "skipped": 0, "errors": 0}

    # run scraper outside session
    rows = await run_batch(skus)

    updated = 0
    skipped = 0
    errors  = 0
    now = datetime.utcnow()

    with get_session() as session:
        # quick map for product_id by sku
        prod_rows = session.execute(select(Product.id, Product.sku).where(Product.sku.in_(skus))).all()
        id_by_sku = {s: i for (i, s) in [(pid, sku) for pid, sku in prod_rows]}

        for r in rows:
            sku = r["sku"]
            pid = id_by_sku.get(sku)
            if not pid:
                skipped += 1
                continue
            asset = session.execute(select(ProductAsset).where(ProductAsset.product_id == pid)).scalars().first()
            if not asset:
                asset = ProductAsset(product_id=pid, sku=sku)
                session.add(asset)
            # update fields
            asset.product_url = r.get("url")
            asset.image_url   = r.get("image_url")
            asset.status      = r.get("status") or "not_found"
            asset.last_fetched = now
            if asset.status == "ok":
                updated += 1
            else:
                errors += 1
        session.commit()

    return {"checked": len(skus), "updated": updated, "skipped": skipped, "errors": errors}

@router.get("/products/assets")
async def get_assets(skus: str = Query(..., description="Comma-separated SKUs")) -> Dict[str, Dict[str, Optional[str]]]:
    wanted = [s.strip() for s in (skus or "").split(",") if s.strip()]
    if not wanted:
        return {}
    with get_session() as session:
        rows = session.execute(
            select(ProductAsset.sku, ProductAsset.product_url, ProductAsset.image_url).where(ProductAsset.sku.in_(wanted))
        ).all()
        out = {sku: {"product_url": url, "image_url": img} for (sku, url, img) in rows}
        # include empty stubs for missing
        for s in wanted:
            out.setdefault(s, {"product_url": None, "image_url": None})
        return out
