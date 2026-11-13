import datetime as dt

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_session
from app.auth import CurrentUser, current_user
from app.schemas import (
    PreparedSolutionOut,
    PreparedSolutionUpdate,
    ReagentLotIn,
    ReagentLotRow,
    ReagentLotUpdate,
    TissueLotDetail,
    TissueLotIn,
    TissueLotRow,
    TissueLotUpdate,
)
from app.services import experiments, inventory

router = APIRouter(prefix="/api/inventory", tags=["inventory"], dependencies=[Depends(current_user)])


@router.get("/reagent-lots", response_model=list[ReagentLotRow])
def reagent_lots(session: Session = Depends(get_session)) -> list[ReagentLotRow]:
    return inventory.reagent_lots(session, dt.date.today())


@router.post("/reagent-lots", response_model=ReagentLotRow, status_code=201)
def add_reagent_lot(
    body: ReagentLotIn, session: Session = Depends(get_session), user: CurrentUser = Depends(current_user)
) -> ReagentLotRow:
    return inventory.create_reagent_lot(session, body, dt.date.today())


@router.patch("/reagent-lots/{lot_id}", response_model=ReagentLotRow)
def edit_reagent_lot(
    lot_id: int,
    body: ReagentLotUpdate,
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(current_user),
) -> ReagentLotRow:
    return inventory.update_reagent_lot(session, lot_id, body, dt.date.today())


@router.get("/tissue-lots", response_model=list[TissueLotRow])
def tissue_lots(session: Session = Depends(get_session)) -> list[TissueLotRow]:
    return inventory.tissue_lots(session, dt.date.today())


@router.post("/tissue-lots", response_model=TissueLotRow, status_code=201)
def add_tissue_lot(
    body: TissueLotIn, session: Session = Depends(get_session), user: CurrentUser = Depends(current_user)
) -> TissueLotRow:
    return inventory.create_tissue_lot(session, body, dt.date.today())


@router.get("/tissue-lots/{lot_id}", response_model=TissueLotDetail)
def tissue_lot(lot_id: int, session: Session = Depends(get_session)) -> TissueLotDetail:
    return inventory.tissue_lot(session, lot_id, dt.date.today())


@router.patch("/tissue-lots/{lot_id}", response_model=TissueLotRow)
def edit_tissue_lot(
    lot_id: int,
    body: TissueLotUpdate,
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(current_user),
) -> TissueLotRow:
    return inventory.update_tissue_lot(session, lot_id, body, dt.date.today())


@router.patch("/prepared-solutions/{solution_id}", response_model=PreparedSolutionOut)
def edit_prepared_solution(
    solution_id: int,
    body: PreparedSolutionUpdate,
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(current_user),
) -> PreparedSolutionOut:
    return experiments.update_prepared_solution(session, solution_id, body)
