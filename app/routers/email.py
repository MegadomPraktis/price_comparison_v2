# -*- coding: utf-8 -*-
from __future__ import annotations

import io
import os
import re
import ssl
import smtplib
import asyncio
import requests
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Tuple

from fastapi import APIRouter, HTTPException, Body
from fastapi.responses import JSONResponse
from sqlalchemy import select

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

from app.db import get_session
from app.models import EmailRule, EmailWeeklySchedule, PriceSubset
from app.schemas import EmailRuleIn, EmailRuleOut, WeeklySchedule

router = APIRouter()

# =============================================================================
# SMTP / runtime settings
# =============================================================================

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASS = os.getenv("SMTP_PASS", "")

# Explicit: starttls | ssl | plain (defaults to starttls)
SMTP_SECURITY = os.getenv("SMTP_SECURITY", "starttls").lower()

# Back-compat flags (optional; override if present)
SMTP_TLS_FLAG = os.getenv("SMTP_TLS", None)   # "1"/"0"
SMTP_SSL_FLAG = os.getenv("SMTP_SSL", None)   # "1"/"0"

SMTP_DEBUG = os.getenv("SMTP_DEBUG", "0").lower() in ("1", "true", "yes", "on")
SMTP_TIMEOUT = float(os.getenv("SMTP_TIMEOUT", "20"))

SENDER = os.getenv("SMTP_SENDER", SMTP_USER or "no-reply@example.com")

OUTBOX_DIR = os.getenv(
    "SMTP_OUTBOX_DIR",
    os.path.join(os.path.dirname(__file__), "..", "..", "outbox")
)

APP_BASE = os.getenv("EMAIL_INTERNAL_BASE_URL", f"http://127.0.0.1:{os.getenv('APP_PORT', '8001')}")

# =============================================================================
# XLSX styles
# =============================================================================

_thin = Side(style="thin", color="999999")
_border = Border(left=_thin, right=_thin, top=_thin, bottom=_thin)
_head = PatternFill("solid", fgColor="0F1B38")
_center = Alignment(horizontal="center", vertical="center")
_right = Alignment(horizontal="right", vertical="center")
_mid = Alignment(vertical="center")
_green = PatternFill("solid", fgColor="E9F6E9")
_red = PatternFill("solid", fgColor="FBE4E6")


def _px_to_w(px: int) -> float:
    return max(8.0, px / 7.0)


# =============================================================================
# Internal API calls
# =============================================================================

def _get_json(url: str, params: dict) -> Any:
    r = requests.get(url, params=params, timeout=600)
    r.raise_for_status()
    return r.json()


def _fetch_compare(site_code: str, tag_id: Optional[int], brand: Optional[str], q: Optional[str] = None) -> List[Dict[str, Any]]:
    params = {"site_code": site_code, "limit": "2000", "source": "snapshots"}
    if tag_id not in (None, "", "all"):
        params["tag_id"] = str(tag_id)
    if brand:
        params["brand"] = brand
    if q:
        params["q"] = q
    return _get_json(f"{APP_BASE}/api/compare", params)


def _fetch_assets(skus: List[str]) -> Dict[str, Dict[str, Any]]:
    if not skus:
        return {}
    qs = ",".join(skus)
    return _get_json(f"{APP_BASE}/api/products/assets", {"skus": qs})


# =============================================================================
# SMTP / mail transport
# =============================================================================

def _validate_emails(s: str) -> List[str]:
    emails = [e.strip() for e in (s or "").split(",") if e.strip()]
    if not emails:
        raise HTTPException(status_code=400, detail="Subscribers list is empty")
    rx = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    bad = [e for e in emails if not rx.match(e)]
    if bad:
        raise HTTPException(status_code=400, detail=f"Invalid emails: {', '.join(bad)}")
    return emails


def _send_email(
    to_list: List[str],
    subject: str,
    body: str,
    attachments: List[Tuple[str, bytes]],
) -> Dict[str, Any]:
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["From"] = SENDER
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    msg.set_content(body)
    for filename, data in attachments:
        msg.add_attachment(
            data,
            maintype="application",
            subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=filename,
        )

    def save_to_outbox(reason: str) -> Dict[str, Any]:
        os.makedirs(OUTBOX_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", subject)[:64]
        path = os.path.join(OUTBOX_DIR, f"{ts}_{safe}.eml")
        with open(path, "wb") as f:
            f.write(msg.as_bytes())
        print(f"[email] saved to {os.path.abspath(path)} ({reason})")
        return {"transport": "file", "paths": [os.path.abspath(path)]}

    if not SMTP_HOST:
        return save_to_outbox("SMTP_HOST not configured")

    sec = SMTP_SECURITY
    if SMTP_PORT == 465 or (SMTP_SSL_FLAG and SMTP_SSL_FLAG.lower() in ("1", "true", "yes", "on")):
        sec = "ssl"
    else:
        if SMTP_TLS_FLAG is not None:
            sec = "starttls" if SMTP_TLS_FLAG.lower() in ("1", "true", "yes", "on") else "plain"

    try:
        if sec == "ssl":
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT, context=context) as s:
                if SMTP_DEBUG: s.set_debuglevel(1)
                s.ehlo()
                if SMTP_USER: s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        elif sec == "starttls":
            context = ssl.create_default_context()
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as s:
                if SMTP_DEBUG: s.set_debuglevel(1)
                s.ehlo()
                s.starttls(context=context)
                s.ehlo()
                if SMTP_USER: s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=SMTP_TIMEOUT) as s:
                if SMTP_DEBUG: s.set_debuglevel(1)
                s.ehlo()
                if SMTP_USER: s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)

        print(f"[email] sent via SMTP ({sec}) -> {to_list} host={SMTP_HOST}:{SMTP_PORT}")
        return {"transport": "smtp", "recipients": to_list, "security": sec}
    except Exception as e:
        print(f"[email] SMTP error: {e!r}; falling back to file.")
        return save_to_outbox(f"SMTP error: {e!r}")


# =============================================================================
# Comparison helpers + filtering + stats
# =============================================================================

def _to_num(v) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip().lower()
    if not s or s in ("n/a", "none"): return None
    try:
        return float(s.replace(" ", "").replace(",", "."))
    except:
        return None


def _eff(promo, regular) -> Optional[float]:
    pv = _to_num(promo)
    return pv if pv is not None else _to_num(regular)


def _pivot_all(flat_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    sku -> { name, our, comps: [{site, price, url, name}], sites_count }
    """
    out: Dict[str, Dict[str, Any]] = {}
    for r in flat_rows:
        sku = r.get("product_sku") or ""
        if not sku:
            continue
        g = out.setdefault(
            sku,
            {
                "name": r.get("product_name") or "N/A",
                "our": _eff(r.get("product_price_promo"), r.get("product_price_regular")),
                "comps": [],
                "sites_count": 0,
            },
        )
        site = (r.get("competitor_site") or "").strip()
        price = _eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
        url = r.get("competitor_url")
        cname = r.get("competitor_name")
        if site:
            g["comps"].append({"site": site, "price": price, "url": url, "name": cname})
    for g in out.values():
        g["sites_count"] = len({c["site"] for c in g["comps"]})
    return out


def _min_comp_info(comps: List[Dict[str, Any]]) -> Tuple[Optional[float], List[str], List[str]]:
    vals = [(c["price"], c["site"], c.get("url")) for c in comps if c["price"] is not None]
    if not vals:
        return (None, [], [])
    minv = min(v for v, _, _ in vals)
    sites = sorted({site for v, site, _ in vals if v == minv})
    urls = list({(url or "") for v, _, url in vals if v == minv and url})
    return (minv, sites, urls)


def _apply_only_promo(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        if _to_num(r.get("product_price_promo")) is not None:
            out.append(r)
    return out


def _apply_price_subset(rows: List[Dict[str, Any]], site_code: str, subset: PriceSubset) -> List[Dict[str, Any]]:
    """
    Keep only items where ours is lower/higher than competitor:
      - single site: compare ours vs that site's price.
      - all sites: compare ours vs MIN(competitor) across sites per SKU.
    """
    if subset == PriceSubset.all:
        return rows

    if site_code == "all":
        out = []
        grouped = _pivot_all(rows)
        for sku, g in grouped.items():
            our = g["our"]
            min_comp, _, _ = _min_comp_info(g["comps"])
            if our is None or min_comp is None:
                continue
            if subset == PriceSubset.ours_lower and our < min_comp:
                # append all rows for that SKU so your same-structure XLSX still works
                out.extend([r for r in rows if r.get("product_sku") == sku])
            elif subset == PriceSubset.ours_higher and our > min_comp:
                out.extend([r for r in rows if r.get("product_sku") == sku])
        return out

    # single site
    out = []
    for r in rows:
        our = _eff(r.get("product_price_promo"), r.get("product_price_regular"))
        comp = _eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
        if our is None or comp is None:
            continue
        if subset == PriceSubset.ours_lower and our < comp:
            out.append(r)
        elif subset == PriceSubset.ours_higher and our > comp:
            out.append(r)
    return out


def _compose_stats(rows: List[Dict[str, Any]], site_code: str) -> Dict[str, int]:
    """
    Counts for: total, ours_lower, ours_higher, equal, no_comp
    """
    total = 0
    ours_lower = ours_higher = equal = no_comp = 0

    if site_code == "all":
        grouped = _pivot_all(rows)
        for _, g in grouped.items():
            total += 1
            our = g["our"]
            minc, _, _ = _min_comp_info(g["comps"])
            if our is None or minc is None:
                no_comp += 1
            elif our < minc:
                ours_lower += 1
            elif our > minc:
                ours_higher += 1
            else:
                equal += 1
    else:
        # treat each SKU once; if duplicates exist, count by SKU
        seen = set()
        by_sku: Dict[str, Dict[str, Any]] = {}
        for r in rows:
            sku = r.get("product_sku") or ""
            if not sku:
                continue
            if sku not in by_sku:
                by_sku[sku] = r
        for r in by_sku.values():
            total += 1
            our = _eff(r.get("product_price_promo"), r.get("product_price_regular"))
            comp = _eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
            if our is None or comp is None:
                no_comp += 1
            elif our < comp:
                ours_lower += 1
            elif our > comp:
                ours_higher += 1
            else:
                equal += 1

    return {
        "total": total,
        "ours_lower": ours_lower,
        "ours_higher": ours_higher,
        "equal": equal,
        "no_comp": no_comp,
    }


# =============================================================================
# Workbook generator (requested columns & coloring)
# =============================================================================

def _build_report_workbook(rows: List[Dict[str, Any]], site_code: str, assets: Dict[str, Dict[str, Any]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Report"

    headers = [
        "ID",
        "Product name",
        "My price",
        "Change",
        "Min price comp.",
        "Change",
        "Diff",
        "Competitor(s)",
    ]
    widths = [110, 720, 120, 110, 160, 110, 110, 280]

    ws.append(headers)
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=i)
        c.value = h
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = _head
        c.alignment = _mid
        c.border = _border
        ws.column_dimensions[get_column_letter(i)].width = _px_to_w(widths[i - 1])

    if site_code == "all":
        grouped = _pivot_all(rows)
        for sku, g in grouped.items():
            our = g["our"]
            min_comp, sites, urls = _min_comp_info(g["comps"])
            diff = (our - min_comp) if (our is not None and min_comp is not None) else None

            # we do not have historical store here; expose 0 change as placeholder
            chg_our = 0.0
            chg_cmp = 0.0

            comps_label = "N/A"
            if sites:
                comps_label = f"{sites[0]} (1 of {g['sites_count']})"

            ws.append(
                [
                    sku,
                    g["name"] or "N/A",
                    round(our, 2) if our is not None else None,
                    round(chg_our, 2),
                    round(min_comp, 2) if min_comp is not None else None,
                    round(chg_cmp, 2),
                    round(diff, 2) if diff is not None else None,
                    comps_label,
                ]
            )

            # hyperlink competitor price to first min URL
            if urls:
                cell = ws.cell(row=ws.max_row, column=5)
                if cell.value is not None:
                    cell.hyperlink = urls[0]
    else:
        for r in rows:
            sku = r.get("product_sku") or ""
            pname = r.get("product_name") or "N/A"
            our = _eff(r.get("product_price_promo"), r.get("product_price_regular"))
            comp = _eff(r.get("competitor_price_promo"), r.get("competitor_price_regular"))
            diff = (our - comp) if (our is not None and comp is not None) else None

            chg_our = 0.0
            chg_cmp = 0.0

            comps_label = f"{r.get('competitor_site') or 'N/A'}"
            if comps_label and comps_label != "N/A":
                comps_label += " (1 of 1)"

            ws.append(
                [
                    sku,
                    pname,
                    round(our, 2) if our is not None else None,
                    round(chg_our, 2),
                    round(comp, 2) if comp is not None else None,
                    round(chg_cmp, 2),
                    round(diff, 2) if diff is not None else None,
                    comps_label,
                ]
            )

            comp_url = r.get("competitor_url")
            if comp_url:
                ws.cell(row=ws.max_row, column=5).hyperlink = comp_url

    # format rows
    for r in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=8):
        for idx, cell in enumerate(r, start=1):
            cell.border = _border
            cell.alignment = _mid if idx in (1, 2, 8) else _right

        # color Diff (col 7)
        my = r[2].value  # col 3
        cmpv = r[4].value  # col 5
        if my is not None and cmpv is not None:
            if my < cmpv:
                r[6].fill = _green
            elif my > cmpv:
                r[6].fill = _red

    ws.freeze_panes = "A2"

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out.read()


# =============================================================================
# Build + stats + send
# =============================================================================

def _build_and_send(rule: EmailRule) -> Dict[str, Any]:
    """
    - Applies: site_code, tag_ids (multi), brand, only_promo, price_subset (for all-sites AND single).
    - Adds a stats section into the email body.
    - One XLSX per tag (or one named 'all' when no tag).
    """
    emails = _validate_emails(rule.subscribers)
    attachments: List[Tuple[str, bytes]] = []

    # stats accumulator across all tag attachments
    total_all = ours_lower_all = ours_higher_all = equal_all = no_comp_all = 0

    tag_ids = rule.tag_ids or [None]
    for tag_id in tag_ids:
        rows = _fetch_compare(
            site_code=rule.site_code or "all",
            tag_id=tag_id,
            brand=rule.brand,
            q=None,
        )

        # only promo
        if rule.only_promo:
            rows = _apply_only_promo(rows)

        # price subset (both single and all-sites)
        rows = _apply_price_subset(rows, rule.site_code or "all", rule.price_subset)

        # stats for the body
        stats = _compose_stats(rows, rule.site_code or "all")
        total_all       += stats["total"]
        ours_lower_all  += stats["ours_lower"]
        ours_higher_all += stats["ours_higher"]
        equal_all       += stats["equal"]
        no_comp_all     += stats["no_comp"]

        # workbook
        skus = [r.get("product_sku") for r in rows if r.get("product_sku")]
        assets = _fetch_assets(list(dict.fromkeys(skus))) if skus else {}
        data = _build_report_workbook(rows, rule.site_code or "all", assets)

        tag_name = (str(tag_id) if tag_id is not None else "all")
        fname = f"report_{tag_name}_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
        attachments.append((fname, data))

    # compose human-readable stats body
    body_lines = [
        f"Report: {rule.name}",
        f"Site scope: {rule.site_code or 'all'}",
        f"Price subset: {rule.price_subset.value}",
        f"Only promo: {'yes' if rule.only_promo else 'no'}",
        f"Brand filter: {rule.brand or '—'}",
        f"Tags: {', '.join([str(t) for t in (rule.tag_ids or ['all'])])}",
        "",
        "Summary:",
        f"  • Items: {total_all}",
        f"  • Ours lower: {ours_lower_all}",
        f"  • Ours higher: {ours_higher_all}",
        f"  • Equal: {equal_all}",
        f"  • Missing competitor price: {no_comp_all}",
        "",
        "This is an automated message.",
    ]
    body_text = "\n".join(body_lines)

    info = _send_email(
        to_list=emails,
        subject=f"[Price Report] {rule.name}",
        body=body_text,
        attachments=attachments,
    )
    return info


# =============================================================================
# CRUD & schedule endpoints
# =============================================================================

@router.get("/email/rules", response_model=List[EmailRuleOut])
def list_rules():
    with get_session() as session:
        rows = list(session.execute(select(EmailRule).order_by(EmailRule.created_on.desc())).scalars())
        return rows


@router.post("/email/rules", response_model=EmailRuleOut)
def create_rule(payload: EmailRuleIn):
    _validate_emails(payload.subscribers)
    with get_session() as session:
        row = EmailRule(
            name=payload.name,
            tag_ids=payload.tag_ids or [],
            brand=payload.brand,
            site_code=payload.site_code or "all",
            price_subset=PriceSubset(payload.price_subset.value),
            only_promo=bool(payload.only_promo),
            subscribers=payload.subscribers,
            notes=payload.notes,
            created_by="UI",
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


@router.put("/email/rules/{rule_id}", response_model=EmailRuleOut)
def update_rule(rule_id: int, payload: EmailRuleIn):
    _validate_emails(payload.subscribers)
    with get_session() as session:
        row = session.get(EmailRule, rule_id)
        if not row:
            raise HTTPException(404, "Rule not found")
        row.name = payload.name
        row.tag_ids = payload.tag_ids or []
        row.brand = payload.brand
        row.site_code = payload.site_code or "all"
        row.price_subset = PriceSubset(payload.price_subset.value)
        row.only_promo = bool(payload.only_promo)
        row.subscribers = payload.subscribers
        row.notes = payload.notes
        session.commit()
        session.refresh(row)
        return row


@router.delete("/email/rules/{rule_id}")
def delete_rule(rule_id: int):
    with get_session() as session:
        row = session.get(EmailRule, rule_id)
        if not row:
            raise HTTPException(404, "Rule not found")
        session.delete(row)
        session.commit()
        return {"ok": True}


@router.get("/email/schedule", response_model=WeeklySchedule)
def get_schedule():
    with get_session() as session:
        row = session.execute(select(EmailWeeklySchedule)).scalars().first()
        if not row:
            row = EmailWeeklySchedule()
            session.add(row)
            session.commit()
            session.refresh(row)
        data = row.data or {}
        return WeeklySchedule(
            **{
                "mon": data.get("mon"),
                "tue": data.get("tue"),
                "wed": data.get("wed"),
                "thu": data.get("thu"),
                "fri": data.get("fri"),
                "sat": data.get("sat"),
                "sun": data.get("sun"),
            }
        )


@router.put("/email/schedule", response_model=WeeklySchedule)
def put_schedule(payload: WeeklySchedule):
    with get_session() as session:
        row = session.execute(select(EmailWeeklySchedule)).scalars().first()
        if not row:
            row = EmailWeeklySchedule()
            session.add(row)
        row.data = payload.dict()
        row.next_run_at = None
        session.commit()
        session.refresh(row)
        return payload


@router.post("/email/send/{rule_id}")
def send_now(rule_id: int):
    with get_session() as session:
        row = session.get(EmailRule, rule_id)
        if not row:
            raise HTTPException(404, "Rule not found")
    info = _build_and_send(row)
    return {"ok": info.get("transport") == "smtp", **info}


@router.post("/email/send-all")
def send_all_now():
    with get_session() as session:
        rules = list(session.execute(select(EmailRule)).scalars())
    results = []
    for r in rules:
        try:
            info = _build_and_send(r)
            results.append({"rule_id": r.id, "name": r.name, **info})
        except Exception as e:
            results.append({"rule_id": r.id, "name": r.name, "error": str(e)})
    return {"ok": True, "results": results}


# =============================================================================
# Minimal SMTP test
# =============================================================================

@router.post("/email/send-test")
def send_test_email(
    to: List[str] = Body(..., embed=True),
    subject: str = Body("SMTP test from price_comparison_v2", embed=True),
    text: str = Body("If you receive this, SMTP works.", embed=True),
):
    info = _send_email(
        to_list=to,
        subject=subject,
        body=text,
        attachments=[],
    )
    code = 200 if info.get("transport") == "smtp" else 207
    return JSONResponse(content={"ok": info.get("transport") == "smtp", **info}, status_code=code)


# =============================================================================
# Simple scheduler
# =============================================================================

async def _compute_next_run(now: datetime, schedule: dict) -> Optional[datetime]:
    mapday = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    for delta in range(0, 8):
        dt = now + timedelta(days=delta)
        key = mapday[dt.weekday()]
        hhmm = (schedule or {}).get(key)
        if not hhmm or hhmm in ("-", "--", ""):
            continue
        try:
            hh, mm = [int(x) for x in hhmm.split(":")]
        except:
            continue
        cand = dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if cand >= now:
            return cand
    return None


async def email_scheduler_loop():
    while True:
        try:
            with get_session() as session:
                row = session.execute(select(EmailWeeklySchedule)).scalars().first()
                if not row:
                    row = EmailWeeklySchedule()
                    session.add(row)
                    session.commit()
                    session.refresh(row)
                now = datetime.now()
                if not row.next_run_at:
                    row.next_run_at = await _compute_next_run(now, row.data or {})
                    session.commit()
                if row.next_run_at and now >= row.next_run_at:
                    rules = list(session.execute(select(EmailRule)).scalars())
                    for r in rules:
                        try:
                            _build_and_send(r)
                        except Exception as e:
                            print("scheduler rule error:", r.id, e)
                    row.next_run_at = await _compute_next_run(now + timedelta(seconds=1), row.data or {})
                    session.commit()
        except Exception as e:
            print("email scheduler loop exception:", e)
        await asyncio.sleep(60)
