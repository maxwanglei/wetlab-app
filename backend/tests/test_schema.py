import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AssayMeasurement, Compound, Experiment, LcmsMethod, LcmsMethodAnalyte


def test_inserts_leave_identity_and_generated_column_to_the_database(session: Session) -> None:
    drug = Compound(canonical_name="test drug")
    method = LcmsMethod(name="test method")
    session.add_all([drug, method])
    session.flush()
    internal_standard = LcmsMethodAnalyte(
        method_id=method.id, analyte_label="IS", analyte_role="internal_standard"
    )
    session.add(internal_standard)
    session.flush()
    analyte = LcmsMethodAnalyte(
        method_id=method.id,
        analyte_label="drug",
        analyte_role="analyte",
        compound_id=drug.id,
        internal_standard_analyte_id=internal_standard.id,
    )
    session.add(analyte)
    session.flush()
    session.refresh(internal_standard)

    assert analyte.id > internal_standard.id > 0
    assert internal_standard.internal_standard_role == "internal_standard"


def test_an_excluded_measurement_needs_a_reason(session: Session) -> None:
    experiment = Experiment(study_type="substrate_depletion")
    session.add(experiment)
    session.flush()
    session.add(
        AssayMeasurement(
            experiment_id=experiment.id,
            timepoint=0,
            measured_entity="parent_remaining",
            is_excluded=True,
        )
    )
    with pytest.raises(IntegrityError, match="ck_assay_measurement_exclusion_reason"):
        session.flush()
