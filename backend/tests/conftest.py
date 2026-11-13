import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

BACKEND = Path(__file__).resolve().parents[1]
SERVER_URL = os.environ.get("TEST_SERVER_URL", "postgresql+psycopg://postgres:postgres@localhost:5433")
TEST_URL = f"{SERVER_URL}/wetlab_test"
# Requests without a session act as the sample's demo member; test_logins.py removes this to test sign-in.
os.environ.setdefault("DEV_USER_EMAIL", "demo@example.org")


@pytest.fixture(scope="session")
def engine() -> Iterator[Engine]:
    admin = create_engine(f"{SERVER_URL}/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text("DROP DATABASE IF EXISTS wetlab_test WITH (FORCE)"))
        conn.execute(text("CREATE DATABASE wetlab_test"))
    admin.dispose()

    config = Config(str(BACKEND / "alembic.ini"))
    config.attributes["url"] = TEST_URL
    config.attributes["configure_logger"] = False
    command.upgrade(config, "head")

    os.environ["DATABASE_URL"] = TEST_URL
    test_engine = create_engine(TEST_URL)
    yield test_engine
    test_engine.dispose()


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with engine.connect() as conn:
        outer = conn.begin()
        with Session(bind=conn, join_transaction_mode="create_savepoint") as db:
            yield db
        outer.rollback()
