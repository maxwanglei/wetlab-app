import datetime as dt

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_session
from app.schemas import ReferenceData
from app.services.reference import reference_data

router = APIRouter(prefix="/api", tags=["reference"], dependencies=[Depends(current_user)])


@router.get("/reference", response_model=ReferenceData)
def reference(session: Session = Depends(get_session)) -> ReferenceData:
    """Everything the experiment and lot forms offer as choices."""
    return reference_data(session, dt.date.today())
