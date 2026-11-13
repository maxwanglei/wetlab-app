"""List the experiment components that have no role, which is the collaborator's work list after migration 0006:
each row's experiment, name, lot and the lot's reagent type. Read-only. The output names lab records, so keep it
out of the repository.
    Usage: cd backend && uv run python -m scripts.report_unclassified_components
"""

from sqlalchemy import text

from app.db import get_engine

UNCLASSIFIED = """
SELECT e.experiment_code, c.cofactor, l.lot_number, r.name AS reagent, r.reagent_type
FROM lab.experiment_cofactor c
JOIN lab.experiment e ON e.id = c.experiment_id
LEFT JOIN lab.reagent_lot l ON l.id = c.reagent_lot_id
LEFT JOIN lab.reagent r ON r.id = l.reagent_id
WHERE c.component_role IS NULL
ORDER BY e.experiment_code, c.id
"""


def main() -> None:
    with get_engine().connect() as connection:
        rows = connection.execute(text(UNCLASSIFIED)).all()
    for code, component, lot, reagent, reagent_type in rows:
        source = f"lot {lot} of {reagent} ({reagent_type or 'untyped'})" if lot else "no lot"
        print(f"{code or 'no code'}\t{component}\t{source}")
    print(f"{len(rows)} component(s) without a role")


if __name__ == "__main__":
    main()
