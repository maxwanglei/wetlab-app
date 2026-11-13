from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth import CurrentUser, current_user
from app.db import get_session
from app.schemas import (
    DepletionResult,
    ExperimentDetail,
    ExperimentDetailsUpdate,
    ExperimentIn,
    ExperimentSummary,
    Measurements,
    PastePreview,
    PastePreviewRequest,
    PreviewRequest,
    ReplaceMeasurements,
    SaveRequest,
    StatusChange,
    StatusChanged,
)
from app.services import depletion, experiments, export, measurements

router = APIRouter(prefix="/api/experiments", tags=["experiments"], dependencies=[Depends(current_user)])


@router.get("", response_model=list[ExperimentSummary])
def list_experiments(session: Session = Depends(get_session)) -> list[ExperimentSummary]:
    return experiments.summaries(session)


@router.post("", response_model=ExperimentDetail, status_code=201)
def create_experiment(
    body: ExperimentIn, session: Session = Depends(get_session), user: CurrentUser = Depends(current_user)
) -> ExperimentDetail:
    return experiments.create(session, body, user)


@router.get("/{experiment_id}", response_model=ExperimentDetail)
def get_experiment(experiment_id: int, session: Session = Depends(get_session)) -> ExperimentDetail:
    return experiments.detail(session, experiment_id)


@router.patch("/{experiment_id}", response_model=ExperimentDetail)
def update_details(experiment_id: int, body: ExperimentDetailsUpdate, session: Session = Depends(get_session)) -> ExperimentDetail:
    return experiments.update_details(session, experiment_id, body)


@router.get("/{experiment_id}/design", response_model=ExperimentIn)
def get_design(experiment_id: int, session: Session = Depends(get_session)) -> ExperimentIn:
    """The design as the request that would write it again, for the edit form."""
    return experiments.design_request(session, experiment_id)


@router.put("/{experiment_id}/design", response_model=ExperimentDetail)
def replace_design(experiment_id: int, body: ExperimentIn, session: Session = Depends(get_session)) -> ExperimentDetail:
    """Refused with 409 once the experiment has bench data."""
    return experiments.replace_design(session, experiment_id, body)


@router.get(
    "/{experiment_id}/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "one row per measurement, ready for Excel"}},
)
def export_measurements(experiment_id: int, session: Session = Depends(get_session)) -> Response:
    name, body = export.experiment_csv(session, experiment_id)
    return Response(body, media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/{experiment_id}/status", response_model=StatusChanged)
def change_status(
    experiment_id: int, body: StatusChange, session: Session = Depends(get_session), _user: CurrentUser = Depends(current_user)
) -> StatusChanged:
    return experiments.change_status(session, experiment_id, body.status)


@router.get("/{experiment_id}/measurements", response_model=Measurements)
def get_measurements(
    experiment_id: int,
    metabolite: str | None = Query(default=None, min_length=1, max_length=200, description="single endpoint: a metabolite's rows"),
    session: Session = Depends(get_session),
) -> Measurements:
    return measurements.listing(session, experiment_id, metabolite.strip() if metabolite else None)


@router.post("/{experiment_id}/measurements/paste-preview", response_model=PastePreview)
def paste_preview(experiment_id: int, body: PastePreviewRequest, session: Session = Depends(get_session)) -> PastePreview:
    return measurements.preview(session, experiment_id, body)


@router.put("/{experiment_id}/measurements", response_model=Measurements)
def replace_measurements(
    experiment_id: int,
    body: ReplaceMeasurements,
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(current_user),
) -> Measurements:
    return measurements.replace(session, experiment_id, body)


@router.get("/{experiment_id}/depletion", response_model=DepletionResult)
def get_depletion(experiment_id: int, session: Session = Depends(get_session)) -> DepletionResult:
    return depletion.current(session, experiment_id)


@router.post("/{experiment_id}/depletion/preview", response_model=DepletionResult)
def preview_depletion(
    experiment_id: int, body: PreviewRequest, session: Session = Depends(get_session)
) -> DepletionResult:
    return depletion.preview(session, experiment_id, body.excluded_ids)


@router.post("/{experiment_id}/depletion/save", response_model=DepletionResult)
def save_depletion(
    experiment_id: int,
    body: SaveRequest,
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(current_user),
) -> DepletionResult:
    return depletion.save(session, experiment_id, body.exclusions, user)
