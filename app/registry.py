# -*- coding: utf-8 -*-
from app.scrapers.base import ScraperRegistry
from app.scrapers.praktiker import PraktikerScraper

registry = ScraperRegistry()

def register_default_scrapers():
    registry.register("praktiker", PraktikerScraper())
