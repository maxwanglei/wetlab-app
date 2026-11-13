"""Columns the demo saves: why a point was excluded, and the fit and fm behind each result."""

from alembic import op

revision = "0002_demo_essentials"
down_revision = "0001_baseline"


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE lab.assay_measurement
            ADD COLUMN exclusion_reason TEXT,
            ADD CONSTRAINT ck_assay_measurement_exclusion_reason
                CHECK (NOT is_excluded OR exclusion_reason IS NOT NULL)
        """
    )
    op.execute(
        """
        ALTER TABLE lab.substrate_depletion_result
            ADD COLUMN fm_estimate NUMERIC
                CONSTRAINT ck_sdr_fm_estimate CHECK (fm_estimate IS NULL OR fm_estimate BETWEEN 0 AND 1),
            ADD COLUMN fm_basis TEXT,
            ADD COLUMN r_squared NUMERIC
                CONSTRAINT ck_sdr_r_squared CHECK (r_squared IS NULL OR r_squared BETWEEN 0 AND 1),
            ADD COLUMN n_points_used INTEGER
                CONSTRAINT ck_sdr_n_points_used CHECK (n_points_used IS NULL OR n_points_used >= 0)
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE lab.substrate_depletion_result "
        "DROP COLUMN n_points_used, DROP COLUMN r_squared, DROP COLUMN fm_basis, DROP COLUMN fm_estimate"
    )
    op.execute(
        "ALTER TABLE lab.assay_measurement "
        "DROP CONSTRAINT ck_assay_measurement_exclusion_reason, DROP COLUMN exclusion_reason"
    )
