# -*- coding: utf-8 -*-
"""
Тестов скрипт, който вкарва ЕДИН snapshot в price_snapshots
за конкретен (site_code, competitor_sku[, competitor_barcode]).

НЕ пипа други SKUs и НЕ вика scrape_and_snapshot.
"""

from datetime import datetime, timedelta

from app.db import get_session
from app.models import Product, Match, CompetitorSite, PriceSnapshot


# ============= НАСТРОЙКИ – СМЕНЯШ САМО ТЕЗИ НЕЩА =============

# Код на сайта от competitor_sites.code
SITE_CODE = "praktiker"

# Praktis SKU (твоят код), за да свържем към правилния продукт
PRAKTIS_SKU = "35545070"

# Код на конкурента (Praktiker Code)
COMPETITOR_SKU = "122525"

# Ако имаш отделен баркод за конкурента – сложи го тук, иначе остави None
COMPETITOR_BARCODE = None

# Данните, които искаш да "симулираш" като върнати от scraper-а
DUMMY_REGULAR_PRICE = 200.00
DUMMY_PROMO_PRICE = None
DUMMY_LABEL = None
DUMMY_URL = "https://www.praktiker.bg/bg/produkt/481113"
DUMMY_NAME = "	АКУМУЛАТОРНА БОРМАШИНА BOSCH PROFESSIONAL GSR 120 Li 12 V, 30.00 nm, БРОЙ БАТЕРИИ 2, 2.00 Ah, КУФАР"

# =============================================================


def main() -> None:
    # 1) Подготвяме: сайт, продукт, match
    with get_session() as s:
        # --- сайт ---
        site = (
            s.query(CompetitorSite)
             .filter(CompetitorSite.code == SITE_CODE)
             .first()
        )
        if not site:
            print(f"[ERROR] Няма CompetitorSite с code='{SITE_CODE}'.")
            return

        # --- продукт (Практис) ---
        prod = s.query(Product).filter(Product.sku == PRAKTIS_SKU).first()
        if not prod:
            print(f"[INFO] Няма Product със sku='{PRAKTIS_SKU}', създавам тестов продукт.")
            prod = Product(
                sku=PRAKTIS_SKU,
                barcode=None,
                item_number=None,
                brand=None,
                name=f"Тестов продукт {PRAKTIS_SKU}",
                price_regular=0.0,
                price_promo=None,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
                groupid=None,
            )
            s.add(prod)
            s.flush()

        # --- match (връзка към конкурента) ---
        match = (
            s.query(Match)
             .filter(
                 Match.product_id == prod.id,
                 Match.site_id == site.id,
             )
             .first()
        )
        if not match:
            print(f"[INFO] Няма Match за продукт {PRAKTIS_SKU} и сайт {SITE_CODE}, създавам нов.")
            match = Match(
                product_id=prod.id,
                site_id=site.id,
                competitor_sku=COMPETITOR_SKU,
                competitor_barcode=COMPETITOR_BARCODE,
            )
            s.add(match)
            s.flush()
        else:
            # Обновяваме да сме сигурни, че е с този competitor_sku
            match.competitor_sku = COMPETITOR_SKU
            match.competitor_barcode = COMPETITOR_BARCODE

        s.commit()

    # 2) Вкарваме snapshot САМО за този competitor_sku/barcode
    with get_session() as s2:
        site = (
            s2.query(CompetitorSite)
               .filter(CompetitorSite.code == SITE_CODE)
               .first()
        )

        key_sku = COMPETITOR_SKU
        key_bar = COMPETITOR_BARCODE

        # последен snapshot за този ключ
        latest = (
            s2.query(PriceSnapshot)
              .filter(
                  PriceSnapshot.site_id == site.id,
                  PriceSnapshot.competitor_sku == key_sku,
                  PriceSnapshot.competitor_barcode == key_bar,
              )
              .order_by(PriceSnapshot.ts.desc())
              .first()
        )

        changed = True
        if latest is not None:
            same_price = (
                (latest.regular_price == DUMMY_REGULAR_PRICE)
                and (latest.promo_price == DUMMY_PROMO_PRICE)
            )
            same_label = (latest.competitor_label or None) == (DUMMY_LABEL or None)
            if same_price and same_label:
                changed = False

        if not changed:
            print("[INFO] Няма промяна спрямо последния snapshot – не записвам нов.")
            return

        snap = PriceSnapshot(
            ts=datetime.utcnow(),
            site_id=site.id,
            competitor_sku=key_sku,
            competitor_barcode=key_bar,
            name=DUMMY_NAME,
            regular_price=DUMMY_REGULAR_PRICE,
            promo_price=DUMMY_PROMO_PRICE,
            url=DUMMY_URL,
            competitor_label=DUMMY_LABEL,
        )
        s2.add(snap)
        s2.flush()

        # --- опционално: чистим много стари / прекалено много записи за този ключ ---
        cutoff = datetime.utcnow() - timedelta(days=180)

        # трие по-стари от 180 дни
        (
            s2.query(PriceSnapshot)
              .filter(
                  PriceSnapshot.site_id == site.id,
                  PriceSnapshot.competitor_sku == key_sku,
                  PriceSnapshot.competitor_barcode == key_bar,
                  PriceSnapshot.ts < cutoff,
              )
              .delete(synchronize_session=False)
        )

        # оставяме максимум 10 най-нови
        all_snaps = (
            s2.query(PriceSnapshot)
              .filter(
                  PriceSnapshot.site_id == site.id,
                  PriceSnapshot.competitor_sku == key_sku,
                  PriceSnapshot.competitor_barcode == key_bar,
              )
              .order_by(PriceSnapshot.ts.desc())
              .all()
        )
        if len(all_snaps) > 10:
            ids_keep = [sn.id for sn in all_snaps[:10]]
            (
                s2.query(PriceSnapshot)
                  .filter(
                      PriceSnapshot.site_id == site.id,
                      PriceSnapshot.competitor_sku == key_sku,
                      PriceSnapshot.competitor_barcode == key_bar,
                      ~PriceSnapshot.id.in_(ids_keep),
                  )
                  .delete(synchronize_session=False)
            )

        s2.commit()

        print(f"[INFO] Вкаран е нов snapshot с ID={snap.id} за {SITE_CODE} / {COMPETITOR_SKU}")

        # показваме всички за този ключ
        final_snaps = (
            s2.query(PriceSnapshot)
              .filter(
                  PriceSnapshot.site_id == site.id,
                  PriceSnapshot.competitor_sku == key_sku,
                  PriceSnapshot.competitor_barcode == key_bar,
              )
              .order_by(PriceSnapshot.ts.asc())
              .all()
        )
        print(f"[INFO] Общо snapshots за {SITE_CODE} / {COMPETITOR_SKU}: {len(final_snaps)}")
        for sn in final_snaps:
            print(
                f"  ID={sn.id} | ts={sn.ts} | "
                f"reg={sn.regular_price} | promo={sn.promo_price} | "
                f"label={sn.competitor_label}"
            )


if __name__ == "__main__":
    main()
