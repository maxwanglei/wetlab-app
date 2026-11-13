import os

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.auth import CurrentUser, current_user
from app.db import get_session
from app.schemas import Health, Me

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health", response_model=Health)
def health(session: Session = Depends(get_session)) -> Health:
    database = session.execute(text("SELECT current_database()")).scalar_one()
    return Health(status="ok", database=database, version=os.environ.get("APP_VERSION", "dev"), demo=database.endswith("_demo"))


@router.get("/me", response_model=Me)
def me(user: CurrentUser = Depends(current_user)) -> Me:
    return Me(email=user.email, full_name=user.full_name, member_id=user.member_id, is_admin=user.is_admin)
