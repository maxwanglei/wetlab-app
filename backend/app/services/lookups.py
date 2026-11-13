"""Find a compound, enzyme or metabolite by name (ignoring case), creating it when the lab types a new one."""

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Compound, Enzyme, Metabolite


def compound(session: Session, name: str) -> Compound:
    found = session.scalar(select(Compound).where(func.lower(Compound.canonical_name) == name.lower()))
    if found is None:
        found = Compound(canonical_name=name)
        session.add(found)
        session.flush()
    return found


def enzyme(session: Session, name: str) -> Enzyme:
    found = session.scalar(select(Enzyme).where(func.lower(Enzyme.enzyme_name) == name.lower()))
    if found is None:
        found = Enzyme(enzyme_name=name, gene_symbol=name)
        session.add(found)
        session.flush()
    return found


def find_metabolite(session: Session, parent_compound_id: int, name: str) -> Metabolite | None:
    """A metabolite of the parent compound whose name or label is this one."""
    return session.scalar(
        select(Metabolite)
        .where(
            Metabolite.parent_compound_id == parent_compound_id,
            or_(func.lower(Metabolite.metabolite_name) == name.lower(), func.lower(Metabolite.metabolite_label) == name.lower()),
        )
        .order_by(Metabolite.id)
        .limit(1)
    )


def metabolite(session: Session, parent_compound_id: int, name: str) -> Metabolite:
    found = find_metabolite(session, parent_compound_id, name)
    if found is None:
        found = Metabolite(parent_compound_id=parent_compound_id, metabolite_name=name, metabolite_label=name)
        session.add(found)
        session.flush()
    return found
