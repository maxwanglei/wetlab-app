import math

import numpy as np
import pytest

from app.science.depletion import Arm, Point, analyze, fit_arm
from app.seed.data import PLANTED_OUTLIER, seed_measurements

PROTEIN_MG_PER_ML = 0.5
FU_INC = 0.90
ARMS = {
    "control": (None, None),
    "montelukast": (1, "CYP2C8"),
    "ketoconazole": (2, "CYP3A4"),
    "quinidine": (3, "CYP2D6"),
}


def seed_arms(exclude_outlier: bool) -> list[Arm]:
    measurements = seed_measurements()
    arms = []
    for label, (modulator_id, enzyme) in ARMS.items():
        points = tuple(
            Point(
                measurement_id=index,
                replicate=m.replicate,
                time_min=m.time_min,
                percent_remaining=m.percent_of_t0,
                excluded=exclude_outlier and (m.arm, m.replicate, m.time_min) == PLANTED_OUTLIER[:3],
            )
            for index, m in enumerate(measurements)
            if m.arm == label
        )
        arms.append(Arm(modulator_id, label, enzyme, points))
    return arms


def by_label(items, label):
    return next(item for item in items if item.label == label)


def test_every_t0_reads_exactly_100_percent() -> None:
    t0 = [m.percent_of_t0 for m in seed_measurements() if m.time_min == 0]
    assert len(t0) == 12
    assert set(t0) == {100.0}


@pytest.mark.parametrize("label", ARMS)
def test_fit_matches_an_independent_polyfit(label: str) -> None:
    arm = by_label(seed_arms(exclude_outlier=True), label)
    used = [p for p in arm.points if not p.excluded]
    slope, _ = np.polyfit([p.time_min for p in used], np.log([p.percent_remaining for p in used]), 1)

    fit = fit_arm(arm, PROTEIN_MG_PER_ML, FU_INC)

    assert fit.k == pytest.approx(-slope, rel=1e-10)
    assert fit.clint_app == pytest.approx(-slope * 1000 / PROTEIN_MG_PER_ML, rel=1e-10)
    assert fit.clint_u == pytest.approx(fit.clint_app / FU_INC)


def test_the_planted_outlier_is_worth_clicking() -> None:
    with_outlier = by_label(analyze(seed_arms(False), PROTEIN_MG_PER_ML, FU_INC).fits, "control")
    without = by_label(analyze(seed_arms(True), PROTEIN_MG_PER_ML, FU_INC).fits, "control")

    generating_clint = math.log(2) / 25 * 1000 / PROTEIN_MG_PER_ML
    assert without.clint_app == pytest.approx(generating_clint, rel=0.02)
    assert with_outlier.clint_app < 0.92 * without.clint_app
    assert with_outlier.r_squared < 0.93
    assert without.r_squared > 0.99
    assert without.n_points == 17 and without.n_excluded == 1


def test_inhibition_and_fm_match_the_reviewed_values() -> None:
    analysis = analyze(seed_arms(exclude_outlier=True), PROTEIN_MG_PER_ML, FU_INC)
    montelukast = by_label(analysis.inhibitions, "montelukast")
    ketoconazole = by_label(analysis.inhibitions, "ketoconazole")
    quinidine = by_label(analysis.inhibitions, "quinidine")

    assert montelukast.percent == pytest.approx(63.9, abs=0.5)
    assert ketoconazole.percent == pytest.approx(24.7, abs=0.5)
    assert quinidine.percent == pytest.approx(2.0, abs=0.5)
    assert montelukast.significant and ketoconazole.significant
    assert not quinidine.significant
    assert montelukast.fm_apparent == pytest.approx(montelukast.percent / 100)
    assert quinidine.fm_apparent is None
    assert analysis.fm_unassigned == pytest.approx(1 - montelukast.fm_apparent - ketoconazole.fm_apparent)
    assert analysis.problems == ()


def test_a_half_life_beyond_the_last_timepoint_is_flagged() -> None:
    fits = analyze(seed_arms(exclude_outlier=True), PROTEIN_MG_PER_ML, FU_INC).fits
    montelukast = by_label(fits, "montelukast")
    control = by_label(fits, "control")

    assert montelukast.half_life_min == pytest.approx(68.8, abs=1.0)
    assert montelukast.half_life_extrapolated
    assert control.half_life_min == pytest.approx(25, abs=1.0)
    assert not control.half_life_extrapolated


def test_fewer_than_three_timepoints_gives_no_rate() -> None:
    arm = Arm(None, "control", None, (Point(1, 1, 0, 100, False), Point(2, 1, 5, 90, False)))
    fit = fit_arm(arm, PROTEIN_MG_PER_ML, FU_INC)
    assert fit.k is None
    assert fit.problem == "fewer than 3 usable timepoints"


def test_without_a_vehicle_control_there_is_no_inhibition() -> None:
    arms = [arm for arm in seed_arms(exclude_outlier=True) if arm.modulator_id is not None]
    analysis = analyze(arms, PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.inhibitions == ()
    assert "no vehicle control arm, so no % inhibition or fm" in analysis.problems


def test_negative_inhibition_is_reported_not_clamped() -> None:
    control = by_label(seed_arms(exclude_outlier=True), "control")
    faster = Arm(
        9,
        "inducer-like",
        "CYP3A4",
        tuple(
            Point(100 + i, rep, t, 100 * math.exp(-0.05 * t), False)
            for i, (rep, t) in enumerate((r, t) for r in (1, 2, 3) for t in (0, 5, 15, 30, 45, 60))
        ),
    )
    result = by_label(analyze([control, faster], PROTEIN_MG_PER_ML, FU_INC).inhibitions, "inducer-like")
    assert result.percent < -50
    assert result.fm_apparent is None


def _series(key: str, label: str, values: dict[float, float], **fields) -> Arm:
    points = tuple(
        Point(abs(hash((key, replicate, time))) % 10**9, replicate, time, value, False)
        for replicate in (1, 2, 3)
        for time, value in values.items()
    )
    return Arm(fields.pop("modulator_id", None), label, fields.pop("target_enzyme", None), points, key=key, **fields)


def _decay(rate: float, times=(0, 5, 15, 30, 45, 60)) -> dict[float, float]:
    return {t: 100 * math.exp(-rate * t) for t in times}


VEHICLE = _series("ctl-1", "Vehicle control", _decay(0.03), role="reference")


def _negative(values: dict[float, float], **fields) -> Arm:
    return _series("ctl-2", "Minus NADPH", values, role="negative", reference_key="ctl-1", **fields)


def _check(analysis):
    return analysis.negatives[0]


@pytest.mark.parametrize(
    "values",
    [
        {0: 100, 15: 100, 30: 100, 60: 100},
        {0: 100, 15: 100.5, 30: 101, 60: 102},
        {0: 100, 30: 103, 60: 104},
        {0: 100, 60: 95},
    ],
    ids=["flat", "rising slightly", "above 100%", "two timepoints"],
)
def test_a_negative_control_with_little_or_no_loss_passes_without_clint_or_a_problem(values) -> None:
    analysis = analyze([VEHICLE, _negative(values)], PROTEIN_MG_PER_ML, FU_INC)
    fit = by_label(analysis.fits, "Minus NADPH")
    assert _check(analysis).verdict == "pass"
    assert fit.clint_app is None and fit.half_life_min is None and fit.problem is None
    assert analysis.problems == () and analysis.checks == ()


def test_a_negative_control_losing_parent_is_flagged_as_a_check_not_a_problem() -> None:
    analysis = analyze([VEHICLE, _negative({0: 100, 15: 90, 30: 80, 60: 70})], PROTEIN_MG_PER_ML, FU_INC)
    check = _check(analysis)
    assert (check.verdict, check.percent_remaining_last, check.last_time_min, check.n_at_last) == ("flag", 70, 60, 3)
    assert analysis.checks == ("Minus NADPH: 70% remaining at 60 min (threshold 80%)",)
    assert analysis.problems == ()


def test_a_negative_without_a_point_after_t0_is_not_judged() -> None:
    check = _check(analyze([VEHICLE, _negative({0: 100})], PROTEIN_MG_PER_ML, FU_INC))
    assert (check.verdict, check.reason) == ("not_judged", "no timepoint after T0")


def test_a_negative_read_after_its_omission_ended_is_a_baseline_not_a_verdict() -> None:
    check = _check(analyze([VEHICLE, _negative({0: 100, 30: 50, 60: 25}, judge=False)], PROTEIN_MG_PER_ML, FU_INC))
    assert (check.verdict, check.reason) == ("not_judged", "omission ends before the sampled stage; used as baseline")


def test_a_negative_reports_its_rate_against_its_reference() -> None:
    analysis = analyze([VEHICLE, _negative(_decay(0.006))], PROTEIN_MG_PER_ML, FU_INC)
    check = _check(analysis)
    assert check.k_ratio == pytest.approx(0.2, rel=1e-6)
    assert check.k_ratio_se is not None and check.k_ratio_se < 0.01
    assert analysis.method.endswith("at its last timepoint, or no measurable loss.")


def _inhibitor(key: str, label: str, rate: float, enzyme: str, **fields) -> Arm:
    return _series(key, label, _decay(rate), role="test", reference_key="ctl-1", target_enzyme=enzyme, **fields)


def test_a_concentration_series_counts_its_enzyme_once_at_the_highest_concentration() -> None:
    series = [
        _inhibitor(f"arm-{n}", f"gemfibrozil glucuronide {c} uM", rate, "CYP2C8", modulator_id=n, group_key="g", concentration=c)
        for n, (c, rate) in enumerate(((1, 0.02), (10, 0.012), (100, 0.006)), start=1)
    ]
    analysis = analyze([VEHICLE, *series], PROTEIN_MG_PER_ML, FU_INC)
    counted = [i for i in analysis.inhibitions if i.fm_counted]
    assert [i.label for i in counted] == ["gemfibrozil glucuronide 100 uM"]
    assert analysis.fm_total == pytest.approx(counted[0].fm_apparent)
    notes = {i.label: i.fm_note for i in analysis.inhibitions if not i.fm_counted}
    assert notes == {
        "gemfibrozil glucuronide 1 uM": "CYP2C8 counted by gemfibrozil glucuronide 100 uM",
        "gemfibrozil glucuronide 10 uM": "CYP2C8 counted by gemfibrozil glucuronide 100 uM",
    }


def test_a_nonsignificant_highest_concentration_does_not_substitute_a_lower_dose() -> None:
    analysis = analyze([
        VEHICLE,
        _inhibitor("arm-1", "Low dose", 0.012, "CYP2C8", modulator_id=1, group_key="g", concentration=1),
        _inhibitor("arm-2", "High dose", 0.03, "CYP2C8", modulator_id=2, group_key="g", concentration=100),
    ], PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.fm_total is None
    assert not any(item.fm_counted for item in analysis.inhibitions)
    low = by_label(analysis.inhibitions, "Low dose")
    assert low.significant and low.fm_apparent == pytest.approx(0.6)
    assert low.fm_note == "highest concentration High dose has no attributable fm, so this series is not counted"


def test_multi_target_inhibition_is_measured_without_assigning_individual_fm() -> None:
    arm = _inhibitor(
        "arm-1", "Ketoconazole", 0.006, "CYP3A4", modulator_id=1,
        target_enzymes=("CYP3A4", "CYP3A5"),
    )
    analysis = analyze([VEHICLE, arm], PROTEIN_MG_PER_ML, FU_INC)
    (inhibition,) = analysis.inhibitions
    assert inhibition.percent == pytest.approx(80)
    assert inhibition.significant
    assert inhibition.fm_apparent is None and not inhibition.fm_counted
    assert "CYP3A4, CYP3A5" in inhibition.fm_note
    assert "individual fm cannot be determined" in inhibition.fm_note
    assert analysis.fm_total is None


def test_ambiguous_cofactor_twins_withhold_correction_regardless_of_order() -> None:
    present = _inhibitor("arm-1", "Inhibitor", 0.012, "CYP3A4", modulator_id=1, group_key="g", concentration=10)
    references = [
        _series("ctl-2", "Minus NADPH", _decay(0.01), role="reference"),
        _series("ctl-3", "Minus UDPGA", _decay(0.02), role="reference"),
    ]
    twins = [
        _series(
            f"arm-{index}", label, _decay(rate), modulator_id=index, role="test",
            reference_key=reference.key, target_enzyme="CYP3A4", group_key="g", concentration=10, cofactor_omitted=True,
        )
        for index, label, rate, reference in [
            (2, "Inhibitor minus NADPH", 0.009, references[0]),
            (3, "Inhibitor minus UDPGA", 0.005, references[1]),
        ]
    ]
    for ordered in (twins, list(reversed(twins))):
        analysis = analyze([VEHICLE, *references, present, *ordered], PROTEIN_MG_PER_ML, FU_INC)
        assert analysis.corrections == ()
        assert analysis.checks == (
            "Inhibitor: cofactor correction withheld because more than one run without cofactor matches "
            "(Inhibitor minus NADPH; Inhibitor minus UDPGA)",
        )


def test_two_inhibitors_of_one_enzyme_count_the_larger_fm() -> None:
    analysis = analyze(
        [
            VEHICLE,
            _inhibitor("arm-1", "montelukast", 0.012, "CYP2C8", modulator_id=1, group_key="a"),
            _inhibitor("arm-2", "gemfibrozil glucuronide", 0.006, "CYP2C8", modulator_id=2, group_key="b"),
        ],
        PROTEIN_MG_PER_ML,
        FU_INC,
    )
    assert [i.label for i in analysis.inhibitions if i.fm_counted] == ["gemfibrozil glucuronide"]


def test_a_cofactor_omitted_twin_is_never_counted_and_corrects_its_partner() -> None:
    minus_vehicle = _series("ctl-3", "Minus NADPH vehicle", _decay(0.01), role="reference")
    present = _inhibitor("arm-2", "gemfibrozil glucuronide", 0.012, "CYP2C8", modulator_id=2, group_key="g", concentration=10)
    twin = _series(
        "arm-1",
        "gemfibrozil glucuronide minus NADPH",
        _decay(0.009),
        role="test",
        reference_key="ctl-3",
        target_enzyme="CYP2C8",
        modulator_id=1,
        group_key="g",
        concentration=10,
        cofactor_omitted=True,
    )
    analysis = analyze([VEHICLE, minus_vehicle, present, twin], PROTEIN_MG_PER_ML, FU_INC)
    assert [i.label for i in analysis.inhibitions if i.fm_counted] == ["gemfibrozil glucuronide"]
    assert by_label(analysis.inhibitions, "gemfibrozil glucuronide minus NADPH").fm_note == "run without its cofactor, so not counted"
    (correction,) = analysis.corrections
    k = {fit.key: fit.k for fit in analysis.fits}
    assert correction.twin_key == "arm-1"
    assert correction.remaining_activity == pytest.approx((k["arm-2"] / k["ctl-1"]) / (k["arm-1"] / k["ctl-3"]), rel=1e-12)


def test_a_design_with_no_inhibitor_arms_has_no_missing_vehicle_line() -> None:
    analysis = analyze([VEHICLE, _negative({0: 100, 60: 99})], PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.problems == () and analysis.inhibitions == ()


def test_with_several_references_an_unusable_one_is_named() -> None:
    flat = _series("ctl-9", "Vehicle control (acetonitrile)", {0: 100, 30: 100, 60: 100}, role="reference")
    arm = _inhibitor("arm-1", "ketoconazole", 0.01, "CYP3A4", modulator_id=1)
    arm = Arm(**{**arm.__dict__, "reference_key": "ctl-9"})
    analysis = analyze([VEHICLE, flat, arm], PROTEIN_MG_PER_ML, FU_INC)
    assert (
        "Vehicle control (acetonitrile): the control arm has no usable depletion rate, so no % inhibition or fm"
        in analysis.problems
    )


def test_two_inhibitors_of_one_enzyme_with_equal_fm_count_the_one_added_first() -> None:
    analysis = analyze(
        [
            VEHICLE,
            _inhibitor("arm-7", "montelukast", 0.012, "CYP2C8", modulator_id=7, group_key="a"),
            _inhibitor("arm-3", "gemfibrozil glucuronide", 0.012, "CYP2C8", modulator_id=3, group_key="b"),
        ],
        PROTEIN_MG_PER_ML,
        FU_INC,
    )
    assert [i.label for i in analysis.inhibitions if i.fm_counted] == ["gemfibrozil glucuronide"]


def _scattered(key: str, label: str, rate: float, spread: float, **fields) -> Arm:
    """Three replicates around a first-order decay, each off by its own factor, so the fit has a standard error."""
    points = tuple(
        Point(abs(hash((key, replicate, time))) % 10**9, replicate, time, 100 * math.exp(-rate * time) * (1 + spread * (replicate - 2) * time / 60), False)
        for replicate in (1, 2, 3)
        for time in (0, 5, 15, 30, 45, 60)
    )
    return Arm(fields.pop("modulator_id", None), label, fields.pop("target_enzyme", None), points, key=key, **fields)


def test_a_negative_whose_fit_does_not_fall_passes_even_with_a_low_last_point() -> None:
    values = {0: 50, 10: 110, 20: 120, 30: 125, 60: 78}
    check = _check(analyze([VEHICLE, _negative(values)], PROTEIN_MG_PER_ML, FU_INC))
    assert check.percent_remaining_last == pytest.approx(78)
    assert check.verdict == "pass"


def test_a_negative_exactly_at_the_threshold_passes() -> None:
    assert _check(analyze([VEHICLE, _negative({0: 100, 30: 90, 60: 80})], PROTEIN_MG_PER_ML, FU_INC)).verdict == "pass"


def test_a_check_line_never_rounds_a_failure_up_to_the_threshold() -> None:
    analysis = analyze([VEHICLE, _negative({0: 100, 30: 90, 60: 79.96})], PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.checks == ("Minus NADPH: 79.9% remaining at 60 min (threshold 80%)",)


def test_a_negative_read_after_its_omission_keeps_its_numbers_as_a_baseline() -> None:
    check = _check(analyze([VEHICLE, _negative({0: 100, 30: 50, 60: 25}, judge=False)], PROTEIN_MG_PER_ML, FU_INC))
    assert (check.verdict, check.percent_remaining_last, check.last_time_min, check.n_at_last) == ("not_judged", 25, 60, 3)
    assert check.k_ratio is not None


def test_a_flat_negative_still_reports_its_rate_against_its_reference() -> None:
    check = _check(analyze([VEHICLE, _negative({0: 100, 30: 100, 60: 100})], PROTEIN_MG_PER_ML, FU_INC))
    assert check.k_ratio == pytest.approx(0, abs=1e-9)


def test_the_negative_rate_ratio_error_follows_the_delta_method() -> None:
    reference = _scattered("ctl-1", "Vehicle control", 0.03, 0.2, role="reference")
    negative = _scattered("ctl-2", "Minus NADPH", 0.006, 0.3, role="negative", reference_key="ctl-1")
    analysis = analyze([reference, negative], PROTEIN_MG_PER_ML, FU_INC)
    fits = {fit.key: fit for fit in analysis.fits}
    k_n, se_n, k_r, se_r = fits["ctl-2"].k, fits["ctl-2"].k_se, fits["ctl-1"].k, fits["ctl-1"].k_se
    assert se_n > 0 and se_r > 0
    ratio = k_n / k_r
    check = _check(analysis)
    assert check.k_ratio == pytest.approx(ratio, rel=1e-12)
    assert check.k_ratio_se == pytest.approx(math.sqrt(se_n**2 + ratio**2 * se_r**2) / k_r, rel=1e-12)


def test_the_cofactor_correction_error_follows_the_delta_method() -> None:
    arms = [
        _scattered("ctl-1", "Vehicle control", 0.03, 0.2, role="reference"),
        _scattered("ctl-3", "Minus NADPH vehicle", 0.01, 0.25, role="reference"),
        _scattered("arm-2", "gemfibrozil glucuronide", 0.012, 0.15, role="test", reference_key="ctl-1", modulator_id=2, group_key="g", concentration=10),
        _scattered(
            "arm-1", "gemfibrozil glucuronide minus NADPH", 0.009, 0.1,
            role="test", reference_key="ctl-3", modulator_id=1, group_key="g", concentration=10, cofactor_omitted=True,
        ),
    ]
    analysis = analyze(arms, PROTEIN_MG_PER_ML, FU_INC)
    fits = {fit.key: fit for fit in analysis.fits}
    rates = [fits[key] for key in ("arm-2", "ctl-1", "arm-1", "ctl-3")]
    value = (rates[0].k / rates[1].k) / (rates[2].k / rates[3].k)
    (correction,) = analysis.corrections
    assert correction.remaining_activity == pytest.approx(value, rel=1e-12)
    assert correction.se == pytest.approx(value * math.sqrt(sum((f.k_se / f.k) ** 2 for f in rates)), rel=1e-12)


def test_a_twin_whose_minus_cofactor_reference_is_flat_gets_a_check_not_a_problem() -> None:
    flat = _series("ctl-3", "Minus NADPH", {0: 100, 30: 100, 60: 100}, role="negative", reference_key="ctl-1")
    twin = _series(
        "arm-1", "ketoconazole minus NADPH", {0: 100, 30: 100, 60: 100},
        role="test", reference_key="ctl-3", modulator_id=1, cofactor_omitted=True,
    )
    analysis = analyze([VEHICLE, flat, twin], PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.problems == ()
    assert analysis.checks == ("ketoconazole minus NADPH: Minus NADPH shows no loss, so this run without cofactor has no rate to compare with",)


def test_a_series_in_mixed_units_counts_the_highest_molar_concentration() -> None:
    from app.science.design import comparable_concentration

    series = [
        _inhibitor(f"arm-{n}", f"gemfibrozil glucuronide {c} {u}", rate, "CYP2C8", modulator_id=n, group_key="g", concentration=comparable_concentration(c, u))
        for n, (c, u, rate) in enumerate(((100, "nM", 0.028), (1, "uM", 0.02), (10, "uM", 0.006)), start=1)
    ]
    analysis = analyze([VEHICLE, *series], PROTEIN_MG_PER_ML, FU_INC)
    assert [i.label for i in analysis.inhibitions if i.fm_counted] == ["gemfibrozil glucuronide 10 uM"]


def test_a_twin_whose_minus_cofactor_reference_has_too_few_points_says_so() -> None:
    sparse = _series("ctl-3", "Minus NADPH", {0: 100, 60: 90}, role="negative", reference_key="ctl-1")
    sparse = Arm(**{**sparse.__dict__, "points": tuple(p for p in sparse.points if p.replicate == 1)})
    twin = _series(
        "arm-1", "ketoconazole minus NADPH", {0: 100, 30: 95, 60: 90},
        role="test", reference_key="ctl-3", modulator_id=1, cofactor_omitted=True,
    )
    analysis = analyze([VEHICLE, sparse, twin], PROTEIN_MG_PER_ML, FU_INC)
    assert analysis.checks[-1] == "ketoconazole minus NADPH: Minus NADPH has no usable rate, so this run without cofactor has no rate to compare with"
