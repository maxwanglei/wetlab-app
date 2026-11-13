import datetime as dt
from collections import defaultdict

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from app.models import Compound, Experiment, Reagent, ReagentComponent, ReagentLot, TissueLot, TissueLotDonor
from app.schemas import (
    Donor,
    ExperimentRef,
    LotAlert,
    ReagentComponentOut,
    ReagentLotIn,
    ReagentLotRow,
    ReagentLotUpdate,
    TissueLotDetail,
    TissueLotIn,
    TissueLotRow,
    TissueLotUpdate,
)
from app.services import lookups
from app.services.lots import days_to_expiry, lot_flags, percent_remaining


def components_by_lot(session: Session) -> dict[int, list[ReagentComponentOut]]:
    """Each regenerating-system lot's components, in the order they were recorded, by lot id."""
    component_lot = aliased(ReagentLot)
    found: dict[int, list[ReagentComponentOut]] = defaultdict(list)
    for component, lot_number in session.execute(
        select(ReagentComponent, component_lot.lot_number)
        .outerjoin(component_lot, component_lot.id == ReagentComponent.component_lot_id)
        .order_by(ReagentComponent.id)
    ):
        found[component.reagent_lot_id].append(
            ReagentComponentOut(
                component_name=component.component_name,
                amount=component.amount,
                amount_unit=component.amount_unit,
                lot_number=lot_number,
            )
        )
    return found


def reagent_lots(session: Session, today: dt.date) -> list[ReagentLotRow]:
    components = components_by_lot(session)
    rows = session.execute(
        select(ReagentLot, Reagent, Compound.canonical_name)
        .join(Reagent, Reagent.id == ReagentLot.reagent_id)
        .outerjoin(Compound, Compound.id == Reagent.compound_id)
        .order_by(ReagentLot.expiry_date.nulls_last(), Reagent.name)
    ).all()
    return [
        ReagentLotRow(
            id=lot.id,
            reagent=reagent.name,
            reagent_type=reagent.reagent_type,
            compound=compound,
            lot_number=lot.lot_number,
            vendor=lot.vendor or reagent.vendor,
            catalog_number=lot.catalog_number or reagent.catalog_number,
            concentration=lot.concentration,
            concentration_unit=lot.concentration_unit,
            received_date=lot.received_date,
            expiry_date=lot.expiry_date,
            days_to_expiry=days_to_expiry(lot.expiry_date, today),
            storage_temp_c=lot.storage_temp_c,
            quantity_received=lot.quantity_received,
            quantity_remaining=lot.quantity_remaining,
            quantity_unit=lot.quantity_unit,
            percent_remaining=percent_remaining(lot.quantity_received, lot.quantity_remaining),
            is_depleted=lot.is_depleted,
            flags=lot_flags(lot.expiry_date, today, lot.quantity_received, lot.quantity_remaining, lot.is_depleted),
            notes=lot.notes,
            components=components.get(lot.id, []),
        )
        for lot, reagent, compound in rows
    ]


def _tissue_row(lot: TissueLot, today: dt.date) -> TissueLotRow:
    return TissueLotRow(
        id=lot.id,
        material_type=lot.material_type,
        species=lot.species,
        lot_number=lot.lot_number,
        vendor_or_source=lot.vendor_or_source,
        catalog_number=lot.catalog_number,
        pooled_or_individual=lot.pooled_or_individual,
        number_of_donors=lot.number_of_donors,
        protein_concentration=lot.protein_concentration,
        protein_concentration_unit=lot.protein_concentration_unit,
        viability=lot.viability,
        received_date=lot.received_date,
        expiry_date=lot.expiry_date,
        days_to_expiry=days_to_expiry(lot.expiry_date, today),
        storage_temp_c=lot.storage_temp_c,
        quantity_remaining=lot.quantity_remaining,
        quantity_unit=lot.quantity_unit,
        is_depleted=lot.is_depleted,
        notes=lot.notes,
        flags=lot_flags(lot.expiry_date, today, None, lot.quantity_remaining, lot.is_depleted),
    )


def tissue_lots(session: Session, today: dt.date) -> list[TissueLotRow]:
    lots = session.scalars(select(TissueLot).order_by(TissueLot.expiry_date.nulls_last(), TissueLot.id))
    return [_tissue_row(lot, today) for lot in lots]


# What each material type is, so the lot records its organ and fraction without asking.
MATERIAL_ORIGIN = {
    "HLM": ("liver", "microsome"),
    "S9": ("liver", "S9"),
    "cytosol": ("liver", "cytosol"),
    "hepatocytes": ("liver", "hepatocyte"),
    "intestinal_microsomes": ("intestine", "microsome"),
    "liver_tissue": ("liver", "tissue"),
}


def create_tissue_lot(session: Session, body: TissueLotIn, today: dt.date) -> TissueLotRow:
    organ, fraction = MATERIAL_ORIGIN[body.material_type]
    lot = TissueLot(**body.model_dump(), organ_or_tissue=organ, tissue_fraction=fraction)
    session.add(lot)
    session.commit()
    return _tissue_row(lot, today)


def update_tissue_lot(session: Session, lot_id: int, body: TissueLotUpdate, today: dt.date) -> TissueLotRow:
    lot = session.get(TissueLot, lot_id)
    if lot is None:
        raise HTTPException(404, f"tissue lot {lot_id} not found")
    for field in body.model_fields_set:
        setattr(lot, field, getattr(body, field))
    session.commit()
    return _tissue_row(lot, today)


def tissue_lot(session: Session, lot_id: int, today: dt.date) -> TissueLotDetail:
    lot = session.get(TissueLot, lot_id)
    if lot is None:
        raise HTTPException(404, f"tissue lot {lot_id} not found")
    donors = session.scalars(
        select(TissueLotDonor).where(TissueLotDonor.tissue_lot_id == lot_id).order_by(TissueLotDonor.donor_id_in_source)
    )
    used_in = session.scalars(
        select(Experiment).where(Experiment.tissue_lot_id == lot_id).order_by(Experiment.experiment_date.desc())
    )
    return TissueLotDetail(
        **_tissue_row(lot, today).model_dump(),
        donors=[Donor.model_validate(d, from_attributes=True) for d in donors],
        used_in=[
            ExperimentRef(id=e.id, code=e.experiment_code, title=e.title, status=e.status, experiment_date=e.experiment_date)
            for e in used_in
        ],
    )


def alerts(session: Session, today: dt.date) -> list[LotAlert]:
    found = [
        LotAlert(
            kind="reagent",
            id=r.id,
            name=r.reagent,
            lot_number=r.lot_number,
            expiry_date=r.expiry_date,
            days_to_expiry=r.days_to_expiry,
            quantity_remaining=r.quantity_remaining,
            quantity_unit=r.quantity_unit,
            percent_remaining=r.percent_remaining,
            flags=r.flags,
        )
        for r in reagent_lots(session, today)
        if r.flags
    ] + [
        LotAlert(
            kind="tissue",
            id=t.id,
            name=f"{t.material_type} ({t.species})",
            lot_number=t.lot_number,
            expiry_date=t.expiry_date,
            days_to_expiry=t.days_to_expiry,
            quantity_remaining=t.quantity_remaining,
            quantity_unit=t.quantity_unit,
            percent_remaining=None,
            flags=t.flags,
        )
        for t in tissue_lots(session, today)
        if t.flags
    ]
    return sorted(found, key=lambda a: (a.days_to_expiry is None, a.days_to_expiry or 0))


def reagent_lot_row(session: Session, lot_id: int, today: dt.date) -> ReagentLotRow:
    row = next((r for r in reagent_lots(session, today) if r.id == lot_id), None)
    if row is None:
        raise HTTPException(404, f"reagent lot {lot_id} not found")
    return row


def create_reagent_lot(session: Session, body: ReagentLotIn, today: dt.date) -> ReagentLotRow:
    reagent = session.scalar(
        select(Reagent).where(func.lower(Reagent.name) == body.reagent_name.lower()).order_by(Reagent.id).limit(1)
    )
    if reagent is None:
        reagent = Reagent(
            name=body.reagent_name,
            reagent_type=body.reagent_type,
            compound_id=lookups.compound(session, body.compound_name).id if body.compound_name else None,
            vendor=body.vendor,
            catalog_number=body.catalog_number,
        )
        session.add(reagent)
        session.flush()
    elif reagent.reagent_type is None and body.reagent_type:
        reagent.reagent_type = body.reagent_type
    if body.components and reagent.reagent_type != "regenerating_system":
        raise HTTPException(422, f"{reagent.name} is not a regenerating system, so its lots list no components.")
    lot = ReagentLot(
        reagent_id=reagent.id,
        lot_number=body.lot_number,
        vendor=body.vendor,
        catalog_number=body.catalog_number,
        concentration=body.concentration,
        concentration_unit=body.concentration_unit,
        received_date=body.received_date,
        expiry_date=body.expiry_date,
        storage_temp_c=body.storage_temp_c,
        quantity_received=body.quantity_received,
        # A new lot with no amount remaining given is unopened, so all of it remains.
        quantity_remaining=body.quantity_remaining if body.quantity_remaining is not None else body.quantity_received,
        quantity_unit=body.quantity_unit,
        notes=body.notes,
    )
    session.add(lot)
    session.flush()
    session.add_all(ReagentComponent(reagent_lot_id=lot.id, **component.model_dump()) for component in body.components)
    session.commit()
    return reagent_lot_row(session, lot.id, today)


def update_reagent_lot(session: Session, lot_id: int, body: ReagentLotUpdate, today: dt.date) -> ReagentLotRow:
    lot = session.get(ReagentLot, lot_id)
    if lot is None:
        raise HTTPException(404, f"reagent lot {lot_id} not found")
    for field in body.model_fields_set - {"compound_name"}:
        setattr(lot, field, getattr(body, field))
    if body.compound_name is not None:
        reagent = session.get(Reagent, lot.reagent_id)
        if reagent.compound_id is not None:
            raise HTTPException(409, f"{reagent.name} is already linked to a compound.")
        reagent.compound_id = lookups.compound(session, body.compound_name).id
    session.commit()
    return reagent_lot_row(session, lot_id, today)
