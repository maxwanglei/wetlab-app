import datetime as dt
from typing import get_args

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Compound, Enzyme, LabMember, Protocol, Reagent
from app.schemas import AdditionStep, ComponentRole, ControlType, ExperimentStatus, NamedRef, PathwayRole, ProtocolRef, ReagentRef, ReagentType, ReferenceData, StudyType
from app.services import experiments, inventory


def reference_data(session: Session, today: dt.date) -> ReferenceData:
    compound_names = dict(session.execute(select(Compound.id, Compound.canonical_name)).all())
    return ReferenceData(
        compounds=[
            NamedRef(id=i, name=n)
            for i, n in session.execute(select(Compound.id, Compound.canonical_name).order_by(func.lower(Compound.canonical_name)))
        ],
        enzymes=[
            NamedRef(id=i, name=n) for i, n in session.execute(select(Enzyme.id, Enzyme.enzyme_name).order_by(Enzyme.enzyme_name))
        ],
        members=[
            NamedRef(id=i, name=n)
            for i, n in session.execute(
                select(LabMember.id, LabMember.full_name).where(LabMember.is_active).order_by(LabMember.full_name)
            )
        ],
        protocols=[
            ProtocolRef(id=p.id, code=p.protocol_code, name=p.name, version=p.version, study_type=p.study_type)
            for p in session.scalars(select(Protocol).where(Protocol.is_active).order_by(Protocol.protocol_code, Protocol.version))
        ],
        reagents=[
            ReagentRef(id=r.id, name=r.name, reagent_type=r.reagent_type, compound=compound_names.get(r.compound_id))
            for r in session.scalars(select(Reagent).order_by(func.lower(Reagent.name)))
        ],
        reagent_lots=inventory.reagent_lots(session, today),
        tissue_lots=inventory.tissue_lots(session, today),
        study_types=list(get_args(StudyType)),
        reagent_types=list(get_args(ReagentType)),
        pathway_roles=list(get_args(PathwayRole)),
        control_types=list(get_args(ControlType)),
        addition_steps=list(get_args(AdditionStep)),
        component_roles=list(get_args(ComponentRole)),
        experiment_statuses=list(get_args(ExperimentStatus)),
        prepared_solutions=list(experiments.prepared_solutions(session).values()),
    )
