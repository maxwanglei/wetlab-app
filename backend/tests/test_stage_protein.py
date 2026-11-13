import pytest

from app.models import ExperimentStage
from app.services.stages import effective_protein, outputs


def test_protein_is_derived_through_more_than_one_dilution() -> None:
    rows = [
        ExperimentStage(id=1, experiment_id=1, stage_type="primary", sequence=1, protein_concentration=0.5),
        ExperimentStage(id=2, experiment_id=1, stage_type="secondary", sequence=2,
                        dilution_factor=10, diluted_from_stage_id=1),
        ExperimentStage(id=3, experiment_id=1, stage_type="tertiary", sequence=3,
                        dilution_factor=10, diluted_from_stage_id=2),
    ]
    by_id = {row.id: row for row in rows}
    assert [effective_protein(row, by_id) for row in rows] == pytest.approx([0.5, 0.05, 0.005])
    shown, warnings = outputs(rows)
    assert shown[-1].derived_protein_concentration == pytest.approx(0.005)
    assert warnings == []


def test_an_entered_zero_is_preserved_instead_of_using_the_dilution() -> None:
    source = ExperimentStage(id=1, experiment_id=1, stage_type="primary", sequence=1, protein_concentration=0.5)
    target = ExperimentStage(id=2, experiment_id=1, stage_type="secondary", sequence=2,
                             protein_concentration=0, dilution_factor=10, diluted_from_stage_id=1)
    assert effective_protein(target, {1: source, 2: target}) == 0
