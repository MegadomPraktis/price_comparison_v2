# -*- coding: utf-8 -*-
from app.scrapers.base import ScraperRegistry
from app.scrapers.praktiker import PraktikerScraper
from app.scrapers.mrbricolage import MrBricolageScraper  # NEW
from app.scrapers.mashinibg import MashiniBgScraper   # <-- add

registry = ScraperRegistry()

def register_default_scrapers():
    registry.register("praktiker", PraktikerScraper())
    registry.register("mrbricolage", MrBricolageScraper())  # NEW
    registry.register("mashinibg", MashiniBgScraper())  # <-- add
