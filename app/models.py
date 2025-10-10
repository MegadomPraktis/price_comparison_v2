# -*- coding: utf-8 -*-
from datetime import datetime
from sqlalchemy import (
    Integer, String, Float, DateTime, ForeignKey, UniqueConstraint, Text, Index, select, Table, Column
)
from sqlalchemy.orm import relationship, Mapped, mapped_column
from app.db import Base

# --- NEW: ProductTag association table (many-to-many)
from sqlalchemy import MetaData
ProductTag = Table(
    "product_tags", Base.metadata,
    Column("product_id", Integer, ForeignKey("products.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    Index("ix_product_tags_product_id", "product_id"),
    Index("ix_product_tags_tag_id", "tag_id"),
    UniqueConstraint("product_id", "tag_id", name="uq_product_tag")
)

class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sku: Mapped[str] = mapped_column(String(64), index=True, unique=True)
    barcode: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    item_number: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    brand: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    name: Mapped[str] = mapped_column(Text)   # UTF-8: Cyrillic-safe
    price_regular: Mapped[float | None] = mapped_column(Float, nullable=True)
    price_promo: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # --- NEW: m2m to tags
    tags = relationship("Tag", secondary=ProductTag, back_populates="products", lazy="selectin")

class CompetitorSite(Base):
    __tablename__ = "competitor_sites"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    base_url: Mapped[str] = mapped_column(String(256))

class Match(Base):
    __tablename__ = "matches"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(Integer, ForeignKey("products.id"))
    site_id: Mapped[int] = mapped_column(Integer, ForeignKey("competitor_sites.id"))
    competitor_sku: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    competitor_barcode: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    product = relationship("Product")
    site = relationship("CompetitorSite")

    __table_args__ = (
        UniqueConstraint("product_id", "site_id", name="uq_product_site"),
        Index("ix_match_comp_sku_site", "competitor_sku", "site_id"),
        Index("ix_match_comp_barcode_site", "competitor_barcode", "site_id"),
    )

class PriceSnapshot(Base):
    __tablename__ = "price_snapshots"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    site_id: Mapped[int] = mapped_column(Integer, ForeignKey("competitor_sites.id"))
    competitor_sku: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    competitor_barcode: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    regular_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    promo_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    url: Mapped[str | None] = mapped_column(Text, nullable=True)

# --- NEW: Tag model
class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    # backref
    products = relationship("Product", secondary=ProductTag, back_populates="tags", lazy="selectin")

# NEW: Praktis assets (URL + Image) stored separately from ERP products
class ProductAsset(Base):
    __tablename__ = "product_assets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_id: Mapped[int] = mapped_column(Integer, ForeignKey("products.id"), index=True, unique=True)
    sku: Mapped[str] = mapped_column(String(64), index=True, unique=True)
    product_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)  # ok / not_found / error
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_fetched: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

def select_sites():
    return select(CompetitorSite)
