from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

from app.db import database_url

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

engine = create_engine(config.attributes.get("url") or database_url())
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()
engine.dispose()
