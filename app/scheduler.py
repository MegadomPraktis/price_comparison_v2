# app/scheduler.py
# -*- coding: utf-8 -*-
import asyncio
from datetime import datetime
import pytz

from app.db import get_session
from app.models import EmailRule
from app.routers.email import _send_rule

async def run_email_scheduler():
    while True:
        try:
            with get_session() as s:
                rules = s.query(EmailRule).filter(EmailRule.is_active == True).all()
                for r in rules:
                    tz = pytz.timezone(r.timezone or "Europe/Sofia")
                    now_local = datetime.now(tz)
                    if now_local.hour == r.send_hour and now_local.minute == r.send_minute:
                        sent_today = False
                        if r.last_sent_at:
                            last_local = r.last_sent_at.astimezone(tz)
                            sent_today = last_local.date() == now_local.date()
                        if not sent_today:
                            rows = _send_rule(r)
                            r.last_sent_at = datetime.utcnow().astimezone(pytz.utc)
                            s.commit()
                            print(f"[Scheduler] Sent rule #{r.id} rows={rows}")
        except Exception as e:
            print("[Scheduler] Error:", e)
        await asyncio.sleep(60)
