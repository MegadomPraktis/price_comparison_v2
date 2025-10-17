# app/routers/export.py
# -*- coding: utf-8 -*-
from __future__ import annotations

import io
import os
from typing import Any, Dict, List, Optional
from datetime import datetime

import requests
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.drawing.image import Image as XLImage
from mimetypes import MimeTypes
import openpyxl.packaging.manifest as _manifest
router = APIRouter()

# -----------------------------------------------------------------------------
# Helpers: reuse your own API so filters match the Comparison tab 1:1
# -----------------------------------------------------------------------------
try:
    if ".webp" not in _manifest.mimetypes.types_map[True]:
        _manifest.mimetypes.add_type("image/webp", ".webp")
        _manifest.mimetypes.add_type("image/webp", ".WEBP")  # just in case
except Exception:
    # keep going even if the table shape differs
    pass
def _internal_base() -> str:
    """
    Base URL for calling the app internally.
    Set APP_PORT or EMAIL_INTERNAL_BASE_URL in your environment if needed.
    """
    return os.getenv("EMAIL_INTERNAL_BASE_URL", f"http://127.0.0.1:{os.getenv('APP_PORT','8001')}")

def _fetch_compare(
    site_code: str,
    limit: int,
    source: str,
    q: Optional[str],
    tag_id: Optional[str],
    brand: Optional[str],
    price_filter: Optional[str],   # ours_lower | ours_higher | None
) -> List[Dict[str, Any]]:
    params: Dict[str, str] = {
        "site_code": site_code,
        "limit": str(limit),
        "source": source,
    }
    if q:            params["q"] = q
    if tag_id:       params["tag_id"] = str(tag_id)
    if brand:        params["brand"] = brand
    if price_filter: params["price_filter"] = price_filter  # /api/compare already supports this

    url = f"{_internal_base()}/api/compare"
    r = requests.get(url, params=params, timeout=300)
    r.raise_for_status()
    return r.json()

def _fetch_assets(skus: List[str]) -> Dict[str, Dict[str, Any]]:
    if not skus:
        return {}
    url = f"{_internal_base()}/api/products/assets"
    r = requests.get(url, params={"skus": ",".join(skus)}, timeout=120)
    if r.status_code != 200:
        return {}
    return r.json()

def _to_num(v):
    if v is None: return None
    s = str(v).strip().lower()
    if not s or s in ("n/a", "none"): return None
    try:
        return float(s.replace(" ", "").replace(",", "."))
    except:
        return None

def _pivot_all(flat_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    product_sku -> single record with praktis price + best competitor price per site
    """
    out: Dict[str, Dict[str, Any]] = {}
    for r in flat_rows:
        sku = r.get("product_sku") or ""
        if not sku:
            continue
        g = out.setdefault(
            sku,
            {
                "product_sku": sku,
                "product_name": r.get("product_name"),
                "praktis_price": _to_num(r.get("product_price_regular")),
                "praktiker":   {"price": None, "url": None},
                "mrbricolage": {"price": None, "url": None},
                "mashinibg":   {"price": None, "url": None},
            },
        )
        site = (r.get("competitor_site") or "").lower()
        price = _to_num(r.get("competitor_price_regular"))
        url = r.get("competitor_url")
        if "praktiker" in site:
            best = g["praktiker"]["price"]
            if best is None or (price is not None and price < best):
                g["praktiker"] = {"price": price, "url": url}
        elif "bricol" in site:
            best = g["mrbricolage"]["price"]
            if best is None or (price is not None and price < best):
                g["mrbricolage"] = {"price": price, "url": url}
        elif "mashin" in site:
            best = g["mashinibg"]["price"]
            if best is None or (price is not None and price < best):
                g["mashinibg"] = {"price": price, "url": url}
    return out

# -----------------------------------------------------------------------------
# Excel styling helpers
# -----------------------------------------------------------------------------

_thin   = Side(style="thin", color="999999")
_border = Border(left=_thin, right=_thin, top=_thin, bottom=_thin)
_hdr    = PatternFill("solid", fgColor="F2F2F2")

# light fills (match web highlighting intent)
_fill_green = PatternFill("solid", fgColor="DFF0D8")  # light green
_fill_red   = PatternFill("solid", fgColor="F8D7DA")  # light red

def _ws_header(ws, headers: List[str], widths_px: List[int]):
    """
    Write header on the first empty row.
    Ensures first header goes to row 1 (no blank first row).
    """
    # if sheet is brand-new, max_row is 1 but row 1 is empty
    row = 1 if (ws.max_row == 1 and ws.cell(row=1, column=1).value in (None, "")) else ws.max_row + 1
    for i, (h, wpx) in enumerate(zip(headers, widths_px), start=1):
        c = ws.cell(row=row, column=i, value=h)
        c.font = Font(bold=True)
        c.alignment = Alignment(vertical="center", wrap_text=False)
        c.fill = _hdr
        c.border = _border
        # approx convert pixels → Excel column width
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = wpx / 7.0

def _ws_row(ws, values: List[Any], number_cols: set[int]):
    row = ws.max_row + 1
    for i, v in enumerate(values, start=1):
        if isinstance(v, dict) and v.get("__HYPERLINK__"):
            cell = ws.cell(row=row, column=i, value=v["text"])
            cell.hyperlink = v["url"]
        else:
            cell = ws.cell(row=row, column=i, value=v)
        cell.border = _border
        cell.alignment = Alignment(
            horizontal=("right" if i in number_cols else "left"),
            vertical="center",
            wrap_text=False,
        )

def _set_fill(ws, row_idx: int, col_idx: int, fill: PatternFill | None):
    if fill:
        ws.cell(row=row_idx, column=col_idx).fill = fill

def _insert_img(ws, row_idx: int, col_idx: int, url: str, col_width_px: int = 110, row_height_pt: int = 60):
    """
    Insert image scaled to fit, centered in the cell (approx).
    """
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        bio = io.BytesIO(resp.content)
        img = XLImage(bio)

        # Desired box (match your Image column width/height)
        max_w_px, max_h_px = 96, 64  # leave some padding from 110×60 cell
        ratio = min(max_w_px / img.width, max_h_px / img.height, 1.0)
        img.width = int(img.width * ratio)
        img.height = int(img.height * ratio)

        # Set anchor first, then nudge offsets, then add
        anchor_ref = f"{ws.cell(row=row_idx, column=col_idx).column_letter}{row_idx}"
        img.anchor = anchor_ref

        # Try to nudge to center using internal offsets (works in practice)
        try:
            EMU_PER_PX = 9525
            cell_w_px = col_width_px
            cell_h_px = int(row_height_pt * 4 / 3)  # pt → px (approx 1pt ≈ 1.333px)
            dx = max(0, (cell_w_px - img.width) // 2)
            dy = max(0, (cell_h_px - img.height) // 2)

            if hasattr(img, "anchor") and hasattr(img.anchor, "_from"):
                img.anchor._from.colOff = dx * EMU_PER_PX
                img.anchor._from.rowOff = dy * EMU_PER_PX
        except Exception:
            pass

        ws.add_image(img)
        ws.row_dimensions[row_idx].height = row_height_pt  # visual vertical centering
    except Exception:
        pass

def _fmt_money(v):
    if v is None: return None
    try:
        return float(v)
    except:
        return v

# -----------------------------------------------------------------------------
# Public endpoint
# -----------------------------------------------------------------------------

@router.get("/export/compare.xlsx")
def export_compare_xlsx(
    site_code: str,
    # keep our own default aligned with /api/compare's le=2000 to avoid 422
    limit: int = Query(2000, ge=1, le=100000),
    source: str = "snapshots",
    q: Optional[str] = None,
    tag_id: Optional[str] = None,
    brand: Optional[str] = None,
    price_status: Optional[str] = Query(None, pattern="^(ours_lower|ours_higher)$"),
    page: Optional[int] = None,
    per_page: Optional[int] = None,
):
    """
    Real XLSX export that mirrors the Comparison tab.
    Uses the same /api/compare filters (via HTTP) + product assets for images/links.
    - site_code: competitor or "all"
    - q, tag_id, brand: same as UI
    - price_status: "ours_lower" | "ours_higher" (same logic as the UI)
    - page, per_page: export exactly the page the user is viewing
    """
    # /api/compare enforces limit <= 2000, so clamp to avoid 422
    limit_for_compare = min(int(limit), 2000)

    rows = _fetch_compare(
        site_code=site_code,
        limit=limit_for_compare,
        source=source,
        q=q,
        tag_id=tag_id,
        brand=brand,
        price_filter=price_status,  # pass-through
    )

    # respect current page if provided
    if page and per_page:
        start = max(0, (page - 1) * per_page)
        rows = rows[start : start + per_page]

    # gather assets (praktis URL + image)
    skus = [r.get("product_sku") for r in rows if r.get("product_sku")]
    assets = _fetch_assets(list(dict.fromkeys(skus)))

    wb = Workbook()
    ws = wb.active
    ws.title = "Comparison"

    if site_code == "all":
        # pivot by product
        pivot = _pivot_all(rows)
        keys = list(pivot.keys())
        if page and per_page:
            start = max(0, (page - 1) * per_page)
            keys = keys[start : start + per_page]

        headers = [
            "Praktis Code", "Image", "Praktis Name",
            "Praktis Regular Price", "Praktiker Regular Price",
            "MrBricolage Regular Price", "OnlineMashini Regular Price",
        ]
        widths = [110, 110, 360, 140, 170, 190, 200]
        _ws_header(ws, headers, widths)
        number_cols = {4, 5, 6, 7}

        for sku in keys:
            g = pivot[sku]
            a = assets.get(sku) or {}
            praktis_url = a.get("product_url")
            img_url = a.get("image_url")

            row_idx = ws.max_row + 1

            # Build clickable prices for competitors (links on prices for ALL-SITES view)
            p_praktiker = g["praktiker"]["price"]
            p_mrb       = g["mrbricolage"]["price"]
            p_mash      = g["mashinibg"]["price"]

            v_praktiker = {"__HYPERLINK__": True, "text": _fmt_money(p_praktiker), "url": g["praktiker"]["url"]} if g["praktiker"]["url"] else _fmt_money(p_praktiker)
            v_mrb       = {"__HYPERLINK__": True, "text": _fmt_money(p_mrb),       "url": g["mrbricolage"]["url"]} if g["mrbricolage"]["url"] else _fmt_money(p_mrb)
            v_mash      = {"__HYPERLINK__": True, "text": _fmt_money(p_mash),      "url": g["mashinibg"]["url"]} if g["mashinibg"]["url"] else _fmt_money(p_mash)

            vals = [
                {"__HYPERLINK__": True, "text": sku, "url": praktis_url} if praktis_url else sku,  # SKU also clickable
                None,  # image
                {"__HYPERLINK__": True, "text": g.get("product_name") or "Няма име", "url": praktis_url} if praktis_url else (g.get("product_name") or "Няма име"),
                _fmt_money(g.get("praktis_price")),
                v_praktiker,
                v_mrb,
                v_mash,
            ]
            _ws_row(ws, vals, number_cols)

            # Highlight like UI: min across available (ours+competitors)
            nums = [x for x in [
                _to_num(g.get("praktis_price")),
                _to_num(p_praktiker),
                _to_num(p_mrb),
                _to_num(p_mash),
            ] if x is not None]
            if nums:
                mn = min(nums)
                # column indices (1-based): our=4, praktiker=5, mrbricolage=6, mashini=7
                cols = [4, 5, 6, 7]
                vals_flat = [
                    _to_num(g.get("praktis_price")),
                    _to_num(p_praktiker),
                    _to_num(p_mrb),
                    _to_num(p_mash),
                ]
                for idx, num in enumerate(vals_flat, start=0):
                    if num is None:
                        continue
                    col = cols[idx]
                    if num == mn:
                        _set_fill(ws, row_idx, col, _fill_green)
                    elif num > mn:
                        _set_fill(ws, row_idx, col, _fill_red)

            if img_url:
                _insert_img(ws, row_idx, 2, img_url, col_width_px=110, row_height_pt=60)

    else:
        # single-site layout; link in competitor NAME (not price) for this view
        if "praktiker" in site_code:
            headers = [
                "Praktis Code","Image","Praktis Name",
                "Praktiker Code","Praktiker Name",
                "Praktis Regular Price","Praktiker Regular Price",
                "Praktis Promo Price","Praktiker Promo Price",
            ]
            widths = [110, 110, 360, 160, 320, 140, 170, 150, 160]
        elif "mrbricolage" in site_code:
            headers = [
                "Praktis Code","Image","Praktis Name",
                "MrBricolage Code","MrBricolage Name",
                "Praktis Regular Price","MrBricolage Regular Price",
                "Praktis Promo Price","MrBricolage Promo Price",
            ]
            widths = [110, 110, 360, 160, 320, 140, 190, 150, 180]
        else:
            headers = [
                "Praktis Code","Image","Praktis Name",
                "OnlineMashini Code","OnlineMashini Name",
                "Praktis Regular Price","OnlineMashini Regular Price",
                "Praktis Promo Price","OnlineMashini Promo Price",
            ]
            widths = [110, 110, 360, 170, 320, 140, 200, 150, 190]

        _ws_header(ws, headers, widths)
        number_cols = {6, 7, 8, 9}

        for r in rows:
            sku = r.get("product_sku") or ""
            a = assets.get(sku) or {}
            praktis_url = a.get("product_url")
            img_url = a.get("image_url")

            comp_name = r.get("competitor_name") or "N/A"
            comp_url  = r.get("competitor_url")

            our_reg   = _to_num(r.get("product_price_regular"))
            comp_reg  = _to_num(r.get("competitor_price_regular"))

            row_idx = ws.max_row + 1
            vals = [
                {"__HYPERLINK__": True, "text": sku, "url": praktis_url} if praktis_url else sku,  # Praktis SKU as link
                None,  # image placeholder
                {"__HYPERLINK__": True, "text": r.get("product_name") or "Няма име", "url": praktis_url} if praktis_url else (r.get("product_name") or "Няма име"),
                r.get("competitor_sku"),
                {"__HYPERLINK__": True, "text": comp_name, "url": comp_url} if comp_url else comp_name,  # link in NAME
                _fmt_money(our_reg),
                _fmt_money(comp_reg),  # price not linked in single-site view
                _fmt_money(r.get("product_price_promo")),
                _fmt_money(r.get("competitor_price_promo")),
            ]
            _ws_row(ws, vals, number_cols)

            # Highlight regular price comparison like the web view
            if our_reg is not None and comp_reg is not None:
                # our regular = column 6, competitor regular = column 7
                if our_reg < comp_reg:
                    _set_fill(ws, row_idx, 6, _fill_green)
                    _set_fill(ws, row_idx, 7, _fill_red)
                elif our_reg > comp_reg:
                    _set_fill(ws, row_idx, 6, _fill_red)
                    _set_fill(ws, row_idx, 7, _fill_green)

            if img_url:
                _insert_img(ws, row_idx, 2, img_url, col_width_px=110, row_height_pt=60)

    # header is at row 1 now; freeze below it
    ws.freeze_panes = "A2"

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    fname = f"comparison_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        out,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'}
    )
