"""Fictitious demo data for experiment WL-2026-047: tucatinib in pooled HLM with selective
inhibitors. The % remaining table is the research seed, generated from k_ctrl = ln2/25 per min,
fm CYP2C8 0.70 and CYP3A4 0.25, inhibitor efficiency 90% (montelukast), 95% (ketoconazole) and
2% (quinidine), with 4% multiplicative noise. A DMPK reviewer reproduced its fits to the digit."""

from dataclasses import dataclass

TIMEPOINTS_MIN = (0, 5, 15, 30, 45, 60)

# Rows follow TIMEPOINTS_MIN; each row holds replicates 1, 2 and 3.
PERCENT_REMAINING = {
    "control": (
        (97.5, 103.4, 96.5), (88.0, 83.6, 86.8), (68.6, 66.7, 67.2),
        (43.6, 43.1, 48.0), (27.3, 28.9, 30.9), (18.1, 18.4, 18.7),
    ),
    "montelukast": (
        (96.3, 99.5, 101.0), (94.7, 90.9, 99.1), (82.2, 83.1, 85.9),
        (71.3, 77.0, 68.0), (65.2, 63.5, 61.4), (55.7, 52.4, 53.6),
    ),
    "ketoconazole": (
        (95.1, 93.4, 106.9), (86.9, 91.1, 95.8), (73.4, 68.9, 71.7),
        (51.5, 53.3, 51.5), (37.5, 38.2, 38.2), (28.1, 27.4, 29.9),
    ),
    "quinidine": (
        (99.6, 106.5, 101.7), (82.8, 85.6, 85.6), (59.7, 67.2, 69.9),
        (44.0, 39.6, 46.0), (27.4, 28.8, 30.2), (19.9, 20.0, 18.7),
    ),
}

AREA_RATIO_AT_100_PERCENT = 1.85

# Replicate 3 of the control at 60 min reads as if from carryover, so the demo has one
# high-leverage point worth excluding: CLint,app moves from about 49 to about 56 when it goes.
PLANTED_OUTLIER = ("control", 3, 60, 41.0)


@dataclass(frozen=True)
class SeedMeasurement:
    arm: str
    replicate: int
    time_min: int
    area_ratio: float
    percent_of_t0: float


def seed_measurements() -> list[SeedMeasurement]:
    """Area ratios scaled from the table, normalized to each replicate's own T0 so T0 is 100.0."""
    rows = []
    for arm, by_time in PERCENT_REMAINING.items():
        for rep_index in range(3):
            replicate = rep_index + 1
            t0_ratio = round(AREA_RATIO_AT_100_PERCENT * by_time[0][rep_index] / 100, 4)
            for time_min, values in zip(TIMEPOINTS_MIN, by_time, strict=True):
                if (arm, replicate, time_min) == PLANTED_OUTLIER[:3]:
                    percent = PLANTED_OUTLIER[3]
                    ratio = round(t0_ratio * percent / 100, 4)
                else:
                    ratio = round(AREA_RATIO_AT_100_PERCENT * values[rep_index] / 100, 4)
                    percent = round(100 * ratio / t0_ratio, 2)
                rows.append(SeedMeasurement(arm, replicate, time_min, ratio, percent))
    return rows
