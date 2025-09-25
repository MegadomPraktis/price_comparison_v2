# -*- coding: utf-8 -*-
import os
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DATABASE_URL = os.getenv("DATABASE_URL", "mssql+pyodbc://@localhost/price_comparison_v2?driver=ODBC+Driver+17+for+SQL+Server&trusted_connection=yes")

print(f"[DB] DATABASE_URL={DATABASE_URL}")

# For SQL Server via pyodbc (sync engine)
engine = create_engine(DATABASE_URL, echo=False, future=True)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()

@contextmanager
def get_session():
    """Sync session contextmanager (works with SQL Server)."""
    session = SessionLocal()
    try:
        yield session
        # commit responsibility is at call sites when needed
    finally:
        session.close()

def init_db():
    """Create all tables if they do not exist."""
    from app import models  # import models to register metadata
    Base.metadata.create_all(bind=engine)
    print("[DB] create_all() completed (SQL Server)")
