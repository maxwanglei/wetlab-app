"""Reset a demo database to the fictitious Wet Lab dataset: `uv run python -m app.seed.demo`."""

import datetime as dt

from sqlalchemy import Engine, func, select, text
from sqlalchemy.orm import Session

from app.db import get_engine
from app.models import (
    AssayMeasurement,
    Compound,
    Enzyme,
    Experiment,
    ExperimentCofactor,
    ExperimentCondition,
    ExperimentControl,
    ExperimentEnzyme,
    ExperimentModulator,
    ExperimentStage,
    LabMember,
    Metabolite,
    Protocol,
    ProtocolStep,
    Reagent,
    ReagentLot,
    TissueLot,
    TissueLotDonor,
)
from app.seed.data import seed_measurements

DEMO_DATABASE_SUFFIXES = ("_demo", "_test")
DEMO_USER_EMAIL = "demo@example.org"


class NotADemoDatabase(RuntimeError):
    pass


class NotEmpty(RuntimeError):
    pass


def reset(engine: Engine) -> dict[str, int]:
    with Session(engine) as session, session.begin():
        name = session.execute(text("SELECT current_database()")).scalar_one()
        if not name.endswith(DEMO_DATABASE_SUFFIXES):
            raise NotADemoDatabase(f"refusing to reseed {name!r}: only databases ending in _demo or _test")
        session.execute(text(f"TRUNCATE {', '.join(_lab_tables(session))} RESTART IDENTITY CASCADE"))
        _load(session)
        return _counts(session)


def load_into_empty(engine: Engine) -> dict[str, int]:
    """Load the dataset once into a shared database (such as `wetlab`) without ever truncating it."""
    with Session(engine) as session, session.begin():
        filled = [t for t in _lab_tables(session) if session.scalar(text(f"SELECT EXISTS (SELECT 1 FROM {t})"))]
        if filled:
            raise NotEmpty(f"refusing to load: {', '.join(filled)} already hold rows")
        _load(session)
        return _counts(session)


def _lab_tables(session: Session) -> list[str]:
    return list(session.execute(text("SELECT 'lab.' || tablename FROM pg_tables WHERE schemaname = 'lab'")).scalars())


def _counts(session: Session) -> dict[str, int]:
    return {
        "measurements": session.scalar(select(func.count()).select_from(AssayMeasurement)),
        "modulator_arms": session.scalar(select(func.count()).select_from(ExperimentModulator)),
        "donors": session.scalar(select(func.count()).select_from(TissueLotDonor)),
        "experiments": session.scalar(select(func.count()).select_from(Experiment)),
    }


def _added(session: Session, row):
    session.add(row)
    session.flush()
    return row


def _load(session: Session) -> None:
    pi = _added(session, LabMember(full_name="Wet Lab PI", email="pi@example.org", role="PI"))
    postdoc = _added(session, LabMember(full_name="Wet Lab Postdoc", email="postdoc@example.org", role="postdoc"))
    technician = _added(
        session, LabMember(full_name="Wet Lab Technician", email="technician@example.org", role="technician")
    )
    _added(session, LabMember(full_name="Wet Lab demo user", email=DEMO_USER_EMAIL, role="demo"))

    compound = {
        name: _added(session, Compound(canonical_name=name))
        for name in ("tucatinib", "montelukast", "ketoconazole", "quinidine", "azamulin", "midazolam", "tucatinib-d6")
    }
    enzyme = {
        name: _added(session, Enzyme(enzyme_name=name, gene_symbol=name))
        for name in ("CYP2C8", "CYP3A4", "CYP2D6", "CYP2C9", "CYP2C19", "CYP1A2")
    }
    _added(
        session,
        Metabolite(
            parent_compound_id=compound["tucatinib"].id,
            metabolite_name="hydroxy-tucatinib",
            metabolite_label="M1",
            reaction_type="hydroxylation",
        ),
    )

    lot = {}
    for name, reagent_type, compound_name, lot_number, conc, conc_unit, received, expiry, temp, qty, left, qty_unit in (
        ("Tucatinib", "substrate", "tucatinib", "TUC-26014", 10, "mM", "2026-02-10", "2028-03-31", -20, 1.0, 0.62, "mL"),
        ("Montelukast sodium", "inhibitor", "montelukast", "MTK-25092", 10, "mM", "2025-09-22", "2027-06-30", -20, 1.0, 0.70, "mL"),
        ("Ketoconazole", "inhibitor", "ketoconazole", "KTZ-25088", 10, "mM", "2025-08-14", "2026-11-05", -20, 1.0, 0.35, "mL"),
        ("Quinidine", "inhibitor", "quinidine", "QND-24402", 10, "mM", "2024-11-02", "2027-09-30", -20, 1.0, 0.80, "mL"),
        ("Azamulin", "inhibitor", "azamulin", "AZM-26003", 10, "mM", "2026-03-05", "2027-12-31", -20, 0.5, 0.50, "mL"),
        ("NADPH tetrasodium salt", "cofactor", None, "NAD-25610", None, None, "2025-11-20", "2026-11-12", -20, 500, 100, "mg"),
        ("Potassium phosphate buffer, 0.5 M, pH 7.4", "buffer", None, "KPB-2609", 0.5, "M", "2026-09-01", "2027-02-28", 4, 500, 310, "mL"),
        ("Tucatinib-d6", "internal_standard", "tucatinib-d6", "TUCD6-2602", 1, "mM", "2026-02-10", "2027-12-31", -20, 0.5, 0.42, "mL"),
        ("DMSO, anhydrous", "solvent", None, "DMSO-2601", None, None, "2026-01-15", "2028-01-31", 20, 100, 64, "mL"),
    ):
        reagent = _added(
            session,
            Reagent(
                name=name,
                reagent_type=reagent_type,
                compound_id=compound[compound_name].id if compound_name else None,
                vendor="Vendor B",
            ),
        )
        lot[lot_number] = _added(
            session,
            ReagentLot(
                reagent_id=reagent.id,
                lot_number=lot_number,
                concentration=conc,
                concentration_unit=conc_unit,
                received_date=dt.date.fromisoformat(received),
                expiry_date=dt.date.fromisoformat(expiry),
                storage_temp_c=temp,
                quantity_received=qty,
                quantity_remaining=left,
                quantity_unit=qty_unit,
                notes="10 mM stock in DMSO" if conc_unit == "mM" and conc == 10 else None,
            ),
        )

    hlm = _added(
        session,
        TissueLot(
            material_type="HLM",
            species="human",
            organ_or_tissue="liver",
            tissue_fraction="microsome",
            pooled_or_individual="pooled",
            number_of_donors=10,
            vendor_or_source="Vendor A",
            catalog_number="HLM-P10",
            lot_number="HLM10-2606",
            protein_concentration=20,
            received_date=dt.date(2026, 6, 15),
            expiry_date=dt.date(2028, 6, 30),
            storage_temp_c=-80,
            quantity_remaining=3.5,
            quantity_unit="mL",
        ),
    )
    hepatocytes = _added(
        session,
        TissueLot(
            material_type="hepatocytes",
            species="human",
            organ_or_tissue="liver",
            tissue_fraction="hepatocyte",
            pooled_or_individual="pooled",
            number_of_donors=5,
            vendor_or_source="Vendor A",
            catalog_number="HEP-P5",
            lot_number="HEP5-2603",
            viability=86,
            received_date=dt.date(2026, 3, 12),
            expiry_date=dt.date(2027, 3, 31),
            storage_temp_c=-150,
            quantity_remaining=4,
            quantity_unit="vials",
        ),
    )
    for donor, sex, age, bmi in (
        ("D01", "male", 45, 24.1), ("D02", "female", 52, 27.3), ("D03", "male", 38, 22.8),
        ("D04", "female", 61, 29.5), ("D05", "male", 29, 23.4), ("D06", "female", 47, 25.9),
        ("D07", "male", 55, 30.6), ("D08", "female", 34, 22.2), ("D09", "male", 66, 28.1),
        ("D10", "female", 41, 26.4),
    ):
        session.add(
            TissueLotDonor(
                tissue_lot_id=hlm.id,
                donor_id_in_source=donor,
                sex=sex,
                age_min=age,
                age_max=age,
                bmi=bmi,
                disease_state="healthy",
                genotype_available=True,
            )
        )

    protocol = _added(
        session,
        Protocol(
            protocol_code="SOP-MET-004",
            name="HLM substrate depletion with selective chemical inhibitors",
            version="2.1",
            study_type="chemical_inhibition",
            description="Reaction phenotyping by parent depletion in pooled HLM, with and without selective CYP inhibitors.",
            created_by=pi.id,
        ),
    )
    for number, instruction, duration in (
        (1, "Thaw HLM on ice and keep on ice until use.", None),
        (2, "Dilute HLM to 0.5 mg/mL protein in 100 mM potassium phosphate, pH 7.4.", None),
        (3, "Add inhibitor (1 µM final) or vehicle, then top up DMSO so every arm contains 0.1%.", None),
        (4, "Preincubate at 37 °C.", 5),
        (5, "Add substrate to 1 µM.", None),
        (6, "Start the reaction with NADPH (1 mM final).", None),
        (7, "At 0, 5, 15, 30, 45 and 60 min, transfer 50 µL into 150 µL ice-cold acetonitrile containing internal standard.", None),
        (8, "Centrifuge at 3000 g for 15 min at 4 °C and analyze the supernatant by LC-MS/MS.", 15),
    ):
        session.add(ProtocolStep(protocol_id=protocol.id, step_number=number, instruction=instruction, duration=duration))

    phenotyping = _added(
        session,
        Experiment(
            experiment_code="WL-2026-047",
            title="Tucatinib reaction phenotyping in pooled HLM",
            protocol_id=protocol.id,
            study_type="chemical_inhibition",
            performed_by=postdoc.id,
            experiment_date=dt.date(2026, 10, 20),
            substrate_compound_id=compound["tucatinib"].id,
            substrate_reagent_lot_id=lot["TUC-26014"].id,
            tissue_lot_id=hlm.id,
            status="completed",
            objective="Estimate the CYP2C8 and CYP3A4 contributions to tucatinib depletion with selective chemical inhibitors.",
        ),
    )
    session.add_all(
        [
            ExperimentCondition(
                experiment_id=phenotyping.id,
                protein_concentration=0.5,
                incubation_temperature=37,
                incubation_time=60,
                preincubation_time=5,
                buffer="100 mM potassium phosphate",
                ph=7.40,
                solvent="DMSO",
                solvent_percentage=0.1,
                linearity_confirmed="yes",
                fu_inc=0.90,
            ),
            ExperimentCofactor(
                experiment_id=phenotyping.id,
                cofactor="NADPH",
                component_role="cofactor",
                concentration=1,
                concentration_unit="mM",
                reagent_lot_id=lot["NAD-25610"].id,
            ),
            *(
                ExperimentEnzyme(experiment_id=phenotyping.id, enzyme_id=enzyme[name].id, organ_context="hepatic", pathway_role=role)
                for name, role in (("CYP2C8", "major"), ("CYP3A4", "minor"))
            ),
        ]
    )
    phenotyping_stage = _added(
        session,
        ExperimentStage(experiment_id=phenotyping.id, stage_type="primary", sequence=1, incubation_minutes=60, protein_concentration=0.5),
    )
    phenotyping_vehicle = _vehicle(session, phenotyping_stage)
    arm_modulator = {"control": None}
    for arm, compound_name, enzyme_name, lot_number in (
        ("montelukast", "montelukast", "CYP2C8", "MTK-25092"),
        ("ketoconazole", "ketoconazole", "CYP3A4", "KTZ-25088"),
        ("quinidine", "quinidine", "CYP2D6", "QND-24402"),
    ):
        arm_modulator[arm] = _added(
            session,
            ExperimentModulator(
                experiment_id=phenotyping.id,
                stage_id=phenotyping_stage.id,
                modulator_compound_id=compound[compound_name].id,
                modulator_role="inhibitor",
                target_enzyme_id=enzyme[enzyme_name].id,
                modulator_concentration=1,
                concentration_unit="uM",
                reversible_or_time_dependent="reversible",
                preincubation_used=True,
                reagent_lot_id=lot[lot_number].id,
            ),
        ).id
    for index, m in enumerate(seed_measurements()):
        session.add(
            AssayMeasurement(
                experiment_id=phenotyping.id,
                experiment_modulator_id=arm_modulator[m.arm],
                experiment_control_id=phenotyping_vehicle.id if m.arm == "control" else None,
                stage_id=phenotyping_stage.id,
                replicate_number=m.replicate,
                well_position=f"{'ABCDEFGH'[index // 12]}{index % 12 + 1}",
                substrate_concentration=1,
                substrate_concentration_unit="uM",
                timepoint=m.time_min,
                timepoint_unit="min",
                measured_entity="parent_remaining",
                raw_value=m.area_ratio,
                raw_unit="area_ratio",
                normalized_value=m.percent_of_t0,
                normalized_unit="% of T0",
            )
        )

    hepatocyte_run = _added(
        session,
        Experiment(
            experiment_code="WL-2026-049",
            title="Tucatinib stability in pooled human hepatocytes",
            study_type="hepatocyte_stability",
            performed_by=postdoc.id,
            experiment_date=dt.date(2026, 10, 27),
            substrate_compound_id=compound["tucatinib"].id,
            substrate_reagent_lot_id=lot["TUC-26014"].id,
            tissue_lot_id=hepatocytes.id,
            status="in_progress",
            objective="Hepatocyte CLint for comparison with the HLM result.",
        ),
    )
    session.add(
        ExperimentCondition(
            experiment_id=hepatocyte_run.id,
            cell_density=0.5,
            cell_density_unit="10^6 cells/mL",
            incubation_temperature=37,
            incubation_time=120,
            solvent="DMSO",
            solvent_percentage=0.1,
        )
    )
    _vehicle(
        session,
        _added(
            session,
            ExperimentStage(
                experiment_id=hepatocyte_run.id,
                stage_type="primary",
                sequence=1,
                incubation_minutes=120,
                cell_density=0.5,
                cell_density_unit="10^6 cells/mL",
            ),
        ),
    )
    planned = _added(
        session,
        Experiment(
            experiment_code="WL-2026-051",
            title="Midazolam stability in pooled HLM",
            study_type="substrate_depletion",
            performed_by=technician.id,
            experiment_date=dt.date(2026, 11, 3),
            substrate_compound_id=compound["midazolam"].id,
            tissue_lot_id=hlm.id,
            status="planned",
            objective="CYP3A activity check on HLM10-2606 before the next phenotyping run.",
        ),
    )
    session.add(
        ExperimentCondition(
            experiment_id=planned.id,
            protein_concentration=0.5,
            incubation_temperature=37,
            incubation_time=45,
            solvent="DMSO",
            solvent_percentage=0.1,
        )
    )
    _vehicle(
        session,
        _added(
            session,
            ExperimentStage(experiment_id=planned.id, stage_type="primary", sequence=1, incubation_minutes=45, protein_concentration=0.5),
        ),
    )


def _vehicle(session: Session, stage: ExperimentStage) -> ExperimentControl:
    return _added(
        session, ExperimentControl(experiment_id=stage.experiment_id, stage_id=stage.id, control_type="vehicle", label="Vehicle control")
    )


def main() -> None:
    counts = reset(get_engine())
    print(", ".join(f"{count} {name}" for name, count in counts.items()))


if __name__ == "__main__":
    main()
