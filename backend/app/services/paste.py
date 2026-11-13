"""Parse a block pasted from Excel. A time course has one row per timepoint, the time in the first column, then
one column per arm and replicate in template order (every replicate of an arm, arm by arm). A single endpoint has
one row per condition, its label first, then its replicates."""

import math
import re

from app.schemas import ArmInfo, ParsedMeasurement, PastePreview, ValueKind

TIME_HEADER = "Time (min)"


def template_columns(arms: list[ArmInfo], replicates: int) -> list[str]:
    return [TIME_HEADER] + [f"{arm.label} R{r}" for arm in arms for r in range(1, replicates + 1)]


def _number(cell: str, decimal_comma: bool) -> float:
    cleaned = cell.strip().replace("%", "")
    if decimal_comma:
        cleaned = cleaned.replace(",", ".")
    value = float(cleaned)
    if not math.isfinite(value):
        raise ValueError(cell)
    return value


def parse_grid(text: str, arms: list[ArmInfo], value_kind: ValueKind) -> PastePreview:
    if not arms:
        return PastePreview(columns=[], rows=[], errors=["This experiment has no condition to paste values for."], warnings=[])
    lines = [line for line in text.replace("\r\n", "\n").split("\n") if line.strip()]
    if not lines:
        return PastePreview(columns=[], rows=[], errors=["Nothing to parse: paste a block copied from Excel."], warnings=[])
    tab_separated = "\t" in lines[0]
    cells = [line.split("\t") if tab_separated else re.split(r"\s*,\s*|\s{2,}", line.strip()) for line in lines]

    errors: list[str] = []
    warnings: list[str] = []
    header = None
    try:
        _number(cells[0][0], tab_separated)
    except ValueError:
        header, cells = cells[0], cells[1:]
    decimal_comma = tab_separated and not any("." in c for row in cells for c in row)

    width = max(len(row) for row in cells) if cells else 0
    value_columns = width - 1
    if value_columns < 1 or value_columns % len(arms):
        errors.append(
            f"Expected the time plus {len(arms)} arms x replicates columns; got {width} columns. "
            "Copy the template to see the expected order."
        )
        return PastePreview(columns=header or [], rows=[], errors=errors, warnings=warnings)
    replicates = value_columns // len(arms)
    columns = template_columns(arms, replicates)
    if header and [h.strip().lower() for h in header[1:]] != [c.lower() for c in columns[1:]]:
        warnings.append("The header row does not match the template; columns were read in template order.")

    rows: list[ParsedMeasurement] = []
    raw: dict[tuple[str, int], list[tuple[float, float]]] = {}
    seen: set[tuple[str, int, float]] = set()
    for line_number, row in enumerate(cells, start=2 if header else 1):
        try:
            time = _number(row[0], decimal_comma)
        except ValueError:
            errors.append(f"Row {line_number}: '{row[0]}' is not a time in minutes.")
            continue
        if time < 0:
            errors.append(f"Row {line_number}: time cannot be negative.")
            continue
        for index, cell in enumerate(row[1:]):
            if not cell.strip():
                continue
            arm = arms[index // replicates]
            replicate = index % replicates + 1
            try:
                value = _number(cell, decimal_comma)
            except ValueError:
                errors.append(f"Row {line_number}, {columns[index + 1]}: '{cell}' is not a number.")
                continue
            if value <= 0:
                errors.append(f"Row {line_number}, {columns[index + 1]}: values must be positive.")
                continue
            identity = (arm.key, replicate, time)
            if identity in seen:
                errors.append(f"Row {line_number}, {columns[index + 1]}: timepoint {time:g} min appears more than once for this replicate.")
                continue
            seen.add(identity)
            raw.setdefault((arm.key, replicate), []).append((time, value))

    for (arm_key, replicate), series in raw.items():
        if value_kind == "percent_of_t0":
            rows.extend(
                ParsedMeasurement(arm_key=arm_key, replicate=replicate, timepoint=t, percent_of_t0=v) for t, v in series
            )
            continue
        t0 = [v for t, v in series if t == 0]
        if not t0:
            label = next(a.label for a in arms if a.key == arm_key)
            errors.append(f"{label} R{replicate}: area ratios need a T0 value to normalize against.")
            continue
        for time, value in series:
            normalized = 100 * (value / t0[0])
            if not math.isfinite(normalized) or normalized <= 0:
                label = next(a.label for a in arms if a.key == arm_key)
                errors.append(f"{label} R{replicate} at {time:g} min: the value relative to T0 is outside the supported numeric range.")
                continue
            rows.append(
                ParsedMeasurement(
                    arm_key=arm_key, replicate=replicate, timepoint=time, raw_value=value, percent_of_t0=normalized
                )
            )
    rows.sort(key=lambda r: ([a.key for a in arms].index(r.arm_key), r.replicate, r.timepoint))
    return PastePreview(columns=columns, rows=rows, errors=errors, warnings=warnings)


CONDITION_HEADER = "Condition"


def endpoint_template_columns(arms: list[ArmInfo]) -> list[str]:
    return [CONDITION_HEADER] + [f"R{r}" for r in range(1, max((arm.replicates for arm in arms), default=1) + 1)]


def parse_endpoint_grid(text: str, arms: list[ArmInfo], minutes: float | None, metabolite: bool) -> PastePreview:
    """A block for a single endpoint: one row per condition in template order, its label first, then up to its planned
    replicates. Each value is an area ratio read at the end of the last stage, which may be 0 for a metabolite."""
    columns = endpoint_template_columns(arms)
    if not arms:
        return PastePreview(columns=[], rows=[], errors=["This experiment has no condition to paste values for."], warnings=[])
    if minutes is None:
        return PastePreview(
            columns=columns, rows=[], errors=["Give the last stage an incubation time: a single endpoint is read at its end."], warnings=[]
        )
    lines = [line for line in text.replace("\r\n", "\n").split("\n") if line.strip()]
    if not lines:
        return PastePreview(columns=columns, rows=[], errors=["Nothing to parse: paste a block copied from Excel."], warnings=[])
    tab_separated = "\t" in lines[0]
    cells = [line.split("\t") if tab_separated else re.split(r"\s*,\s*|\s{2,}", line.strip()) for line in lines]
    first_line = 1
    if cells[0][0].strip().lower() == CONDITION_HEADER.lower():
        cells, first_line = cells[1:], 2
    decimal_comma = tab_separated and not any("." in value for row in cells for value in row[1:])

    errors: list[str] = []
    if len(cells) != len(arms):
        errors.append(
            f"Expected one row for each of the {len(arms)} conditions; got {len(cells)}. Copy the template to see them in order."
        )
    rows: list[ParsedMeasurement] = []
    for line_number, (row, arm) in enumerate(zip(cells, arms), start=first_line):
        label = row[0].strip()
        if label.lower() != arm.label.strip().lower():
            errors.append(f"Row {line_number}: '{label}' is not {arm.label}. Paste the rows in the template's order.")
            continue
        for replicate, cell in enumerate(row[1:], start=1):
            if not cell.strip():
                continue
            where = f"Row {line_number}, {arm.label} R{replicate}"
            if replicate > arm.replicates:
                errors.append(f"{where}: this condition plans {arm.replicates} {'replicate' if arm.replicates == 1 else 'replicates'}.")
                continue
            try:
                value = _number(cell, decimal_comma)
            except ValueError:
                errors.append(f"{where}: '{cell.strip()}' is not a number.")
                continue
            if value < 0 or (value == 0 and not metabolite):
                errors.append(f"{where}: {'values cannot be negative' if metabolite else 'values must be positive'}.")
                continue
            rows.append(ParsedMeasurement(arm_key=arm.key, replicate=replicate, timepoint=minutes, raw_value=value))
    return PastePreview(columns=columns, rows=rows, errors=errors, warnings=[])
