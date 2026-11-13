import pytest

from app.schemas import ArmInfo
from app.services.paste import parse_grid


def condition(label: str = "Vehicle") -> ArmInfo:
    return ArmInfo(
        key="ctl-1", modulator_id=None, kind="control", label=label,
        target_enzyme=None, concentration=None, concentration_unit=None, lot=None,
    )


def test_small_area_ratios_keep_their_precision() -> None:
    result = parse_grid("0\t1\n10\t0.00001\n20\t0.000001", [condition()], "area_ratio")
    assert result.errors == []
    assert [row.percent_of_t0 for row in result.rows] == pytest.approx([100, 0.001, 0.0001])


@pytest.mark.parametrize("values", [("1e-308", "1e308"), ("1e308", "1e-308")])
def test_unrepresentable_normalization_is_a_validation_error(values: tuple[str, str]) -> None:
    initial, later = values
    result = parse_grid(f"0\t{initial}\n10\t{later}", [condition()], "area_ratio")
    assert result.errors == ["Vehicle R1 at 10 min: the value relative to T0 is outside the supported numeric range."]


@pytest.mark.parametrize("time", [0, 10])
def test_a_duplicate_time_for_the_same_replicate_is_rejected(time: int) -> None:
    result = parse_grid(f"0\t1\n10\t0.5\n{time}\t0.25", [condition()], "area_ratio")
    assert result.errors == [f"Row 3, Vehicle R1: timepoint {time} min appears more than once for this replicate."]


def test_same_time_in_different_replicates_is_allowed() -> None:
    result = parse_grid("0\t1\t2\n10\t0.5\t1", [condition()], "area_ratio")
    assert result.errors == []
    assert len(result.rows) == 4


def test_a_decimal_concentration_in_the_header_does_not_change_decimal_comma_parsing() -> None:
    result = parse_grid(
        "Time (min)\tKetoconazole 0.1 uM R1\n0\t1,0\n10\t0,5\n20\t0,25",
        [condition("Ketoconazole 0.1 uM")], "area_ratio",
    )
    assert result.errors == []
    assert [row.percent_of_t0 for row in result.rows] == [100, 50, 25]
