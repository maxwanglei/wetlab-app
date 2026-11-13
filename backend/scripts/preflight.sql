-- Read-only preflight for the schema revision. Every statement is a SELECT.
-- Run it as the app's database login against a copy of the lab database:
--   psql "host=127.0.0.1 port=5434 user=$APP_DB_USER dbname=wetlab_staging" -X -v ON_ERROR_STOP=1 -f backend/scripts/preflight.sql
-- By default it prints aggregate counts only, which are safe to paste into docs/wetlab-schema-map.md.
-- Add -v detail=1 for row-level output. That output can name compounds and experiments the lab
-- entered, so keep it out of the repository (docs/research/ is ignored).
\pset footer off

\echo '1. Incubation time units in use'
SELECT coalesce(incubation_time_unit, '(none)') AS unit, count(*) AS conditions
FROM lab.experiment_condition
WHERE incubation_time IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '2. Protein concentration units in use'
SELECT coalesce(protein_concentration_unit, '(none)') AS unit, count(*) AS conditions
FROM lab.experiment_condition
WHERE protein_concentration IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '3. Experiments without a conditions row'
SELECT count(*) AS experiments
FROM lab.experiment e
WHERE NOT EXISTS (SELECT 1 FROM lab.experiment_condition c WHERE c.experiment_id = e.id);

\echo '4. Modulator rows with the unused control type set'
SELECT control_type, count(*) AS rows
FROM lab.experiment_modulator
WHERE control_type IS NOT NULL
GROUP BY 1 ORDER BY 1;

-- The name pattern also flags names like "vitamin D3"; the detail output is for a person to review.
\echo '5. Modulator or cofactor rows that may be a misfiled internal standard'
WITH suspect AS (
  SELECT c.id
  FROM lab.compound c
  WHERE c.canonical_name ~* '(^|[^a-z0-9])d[0-9]{1,2}([^0-9a-z]|$)|deuter|\[2h'
     OR EXISTS (SELECT 1 FROM lab.reagent r WHERE r.compound_id = c.id AND r.reagent_type = 'internal_standard')
)
SELECT 'modulator rows' AS source, count(*) AS rows
FROM lab.experiment_modulator m
WHERE m.modulator_compound_id IN (SELECT id FROM suspect)
UNION ALL
SELECT 'cofactor rows', count(*)
FROM lab.experiment_cofactor f
WHERE f.cofactor ~* '(^|[^a-z0-9])d[0-9]{1,2}([^0-9a-z]|$)|deuter|\[2h|internal standard'
   OR EXISTS (
     SELECT 1 FROM lab.reagent_lot l JOIN lab.reagent r ON r.id = l.reagent_id
     WHERE l.id = f.reagent_lot_id AND r.reagent_type = 'internal_standard');

\echo '6. Measurements per experiment'
SELECT count(*) AS experiments, coalesce(sum(n), 0) AS measurements, min(n) AS fewest, max(n) AS most
FROM (
  SELECT e.id, count(m.id) AS n
  FROM lab.experiment e LEFT JOIN lab.assay_measurement m ON m.experiment_id = e.id
  GROUP BY e.id
) per_experiment;

\echo '7. Reagent lots missing a lot-level vendor or catalog number'
SELECT count(*) FILTER (WHERE vendor IS NULL) AS no_vendor,
       count(*) FILTER (WHERE catalog_number IS NULL) AS no_catalog_number,
       count(*) AS lots
FROM lab.reagent_lot;

\echo '8. Experiments with more than one arm on one target enzyme'
SELECT count(DISTINCT experiment_id) AS experiments
FROM (
  SELECT experiment_id, target_enzyme_id
  FROM lab.experiment_modulator
  WHERE target_enzyme_id IS NOT NULL
  GROUP BY 1, 2
  HAVING count(*) > 1
) shared_enzyme;

\echo '9. Mass-spectrometry samples with no modulator, by sample type'
SELECT sample_type, count(*) AS samples
FROM lab.lcms_sample
WHERE experiment_modulator_id IS NULL
GROUP BY 1 ORDER BY 1;

\echo '10. Saved depletion results'
SELECT count(*) AS result_rows, count(DISTINCT experiment_id) AS experiments
FROM lab.substrate_depletion_result;

\echo '11. Experiments by status'
SELECT status, count(*) AS experiments
FROM lab.experiment
GROUP BY 1 ORDER BY 1;

\if :{?detail}
\echo ''
\echo 'DETAIL. Keep this output out of the repository.'

\echo 'D1. Conditions with an incubation unit other than min, h, or s'
SELECT e.experiment_code, c.incubation_time, c.incubation_time_unit
FROM lab.experiment_condition c JOIN lab.experiment e ON e.id = c.experiment_id
WHERE c.incubation_time IS NOT NULL
  AND lower(coalesce(c.incubation_time_unit, 'min')) NOT IN ('min', 'h', 's')
ORDER BY 1;

\echo 'D2. Modulator rows with the unused control type set'
SELECT e.experiment_code, m.id AS modulator_id, cp.canonical_name, m.control_type
FROM lab.experiment_modulator m
JOIN lab.experiment e ON e.id = m.experiment_id
JOIN lab.compound cp ON cp.id = m.modulator_compound_id
WHERE m.control_type IS NOT NULL
ORDER BY 1, 2;

\echo 'D3. Possible misfiled internal standards'
SELECT e.experiment_code, m.id AS modulator_id, cp.canonical_name
FROM lab.experiment_modulator m
JOIN lab.experiment e ON e.id = m.experiment_id
JOIN lab.compound cp ON cp.id = m.modulator_compound_id
WHERE cp.canonical_name ~* '(^|[^a-z0-9])d[0-9]{1,2}([^0-9a-z]|$)|deuter|\[2h'
   OR EXISTS (SELECT 1 FROM lab.reagent r WHERE r.compound_id = cp.id AND r.reagent_type = 'internal_standard')
ORDER BY 1, 2;

\echo 'D4. Experiments with more than one arm on one target enzyme'
SELECT e.experiment_code, en.enzyme_name, count(*) AS arms
FROM lab.experiment_modulator m
JOIN lab.experiment e ON e.id = m.experiment_id
JOIN lab.enzyme en ON en.id = m.target_enzyme_id
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY 1, 2;
\endif
