import datetime as dt

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_session
from app.models import Experiment
from app.schemas import Dashboard, StatusCount
from app.services import inventory
from app.services.experiments import summaries

router = APIRouter(prefix="/api", tags=["dashboard"], dependencies=[Depends(current_user)])

STATUS_ORDER = ("planned", "in_progress", "completed", "qc_passed", "qc_failed", "failed")


@router.get("/dashboard", response_model=Dashboard)
def dashboard(session: Session = Depends(get_session)) -> Dashboard:
    counts = dict(session.execute(select(Experiment.status, func.count()).group_by(Experiment.status)).all())
    return Dashboard(
        experiments_by_status=[StatusCount(status=s, count=counts.get(s, 0)) for s in STATUS_ORDER],
        recent_experiments=summaries(session)[:5],
        lot_alerts=inventory.alerts(session, dt.date.today()),
    )
