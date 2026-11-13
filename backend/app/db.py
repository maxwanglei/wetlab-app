import os
from collections.abc import Iterator
from functools import cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

LOCAL_DOCKER_URL = "postgresql+psycopg://postgres:postgres@localhost:5433/wetlab_demo"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", LOCAL_DOCKER_URL)


@cache
def get_engine() -> Engine:
    return create_engine(database_url(), pool_pre_ping=True, pool_size=5, max_overflow=2)


def get_session() -> Iterator[Session]:
    with Session(get_engine(), expire_on_commit=False) as session:
        yield session
