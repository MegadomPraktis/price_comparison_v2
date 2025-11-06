
# app/scheduler.py
# -*- coding: utf-8 -*-
"""
Email scheduler loop (standalone module). Minimal and reliable:
- Does NOT touch UI or endpoints.
- Triggers your existing /api/email/send-all endpoint at the scheduled minute.
- Correctly handles "today" vs "tomorrow" by checking DUE before overwriting next_run_at.
- Recomputes next_run_at when you edit the weekly schedule.
"""

import os
import asyncio
from datetime import datetime, timedelta
from typing import Optional

import pytz
import httpx
from sqlalchemy import select

from app.db import get_session
from app.models import EmailWeeklySchedule

# ---------------------------- TZ helpers -------------------------------------
def _get_tz():
    tz_name = os.getenv("EMAIL_TZ") or os.getenv("APP_TZ") or "Europe/Sofia"
    try:
        import pytz
        return pytz.timezone(tz_name)
    except Exception:
        return pytz.timezone("Europe/Sofia")

def _now_local_naive() -> datetime:
    tz = _get_tz()
    return datetime.now(tz).replace(tzinfo=None)

# ------------------------------ Core logic -----------------------------------
GRACE_SECONDS = int(os.getenv("EMAIL_SCHEDULER_GRACE", "65"))  # catch same-minute sends

def _norm_time_str(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() in {"-", "--", "null", "none"}:
        return None
    return s

async def _compute_next_run(baseline: datetime, schedule: dict) -> Optional[datetime]:
    """
    Find the earliest time >= baseline, where baseline is typically now or (now - grace).
    schedule is {"mon":"HH:MM", "tue":"HH:MM", ...} (case-insensitive keys).
    """
    keys = {str(k).lower(): v for k, v in (schedule or {}).items()}
    mapday = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    for delta in range(0, 8):
        dt = baseline + timedelta(days=delta)
        key = mapday[dt.weekday()]
        hhmm = _norm_time_str(keys.get(key))
        if not hhmm:
            continue
        try:
            hh, mm = [int(x) for x in hhmm.split(":")]
        except Exception:
            continue
        cand = dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if cand >= baseline:
            return cand
    return None

async def run_email_scheduler():
    """
    Minute ticker that:
      1) Loads schedule row
      2) Checks if the stored next_run_at is DUE (now >= stored)
         - If due -> triggers send-all and then advances next_run_at
      3) Otherwise adjusts next_run_at toward the nearest upcoming candidate if the schedule changed
    """
    send_all_url = os.getenv("EMAIL_SCHEDULER_SEND_ALL_URL", "").strip() or "http://127.0.0.1:8001/api/email/send-all"

    while True:
        try:
            with get_session() as s:
                row = s.execute(select(EmailWeeklySchedule)).scalars().first()
                if not row:
                    row = EmailWeeklySchedule()
                    s.add(row); s.commit(); s.refresh(row)

                now = _now_local_naive()
                # DUE check is against the CURRENT stored value (critical: do this BEFORE overwriting it)
                stored = row.next_run_at
                due = bool(stored and now >= stored)

                if due:
                    # Trigger send-all
                    try:
                        async with httpx.AsyncClient(timeout=40.0) as client:
                            resp = await client.post(send_all_url)
                            print(f"[Scheduler] send-all status={resp.status_code}")
                    except Exception as e:
                        print(f"[Scheduler] send-all error: {e}")

                    # Advance to the next occurrence AFTER 'now'
                    candidate = await _compute_next_run(now + timedelta(seconds=1), row.data or {})
                    row.next_run_at = candidate
                    s.commit()
                else:
                    # Not due yet -> reconcile with schedule
                    baseline = now - timedelta(seconds=GRACE_SECONDS)
                    candidate = await _compute_next_run(baseline, row.data or {})
                    # Only update stored_next in these cases:
                    #  - None (not set)
                    #  - stored is in the past
                    #  - candidate exists and is earlier than stored (schedule changed to earlier time)
                    update_reason = None
                    if stored is None:
                        update_reason = "init"
                    elif stored < now:
                        update_reason = "stored_in_past"
                    elif candidate and stored > candidate >= now:
                        update_reason = "schedule_moved_earlier"

                    if update_reason:
                        row.next_run_at = candidate
                        s.commit()

        except Exception as e:
            print(f"[Scheduler] loop error: {e}")

        await asyncio.sleep(60)
