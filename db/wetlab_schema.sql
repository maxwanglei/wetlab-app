-- =============================================================================
-- Jackson Lab In Vitro Metabolism + LC-MS/MS Schema (combined setup script)
-- Target: PostgreSQL 14+ (Cloud SQL for PostgreSQL / AlloyDB)
--
-- Part 1 (sections A-H): in vitro metabolism experiments
-- Part 2 (sections I-R): LC-MS/MS analytical extension
--
-- Runs in a single transaction: if any statement fails, nothing is created.
-- =============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS lab;


-- =============================================================================
-- SECTION A. PEOPLE + PROTOCOLS (for lab management / provenance)
-- =============================================================================

CREATE TABLE lab.lab_member (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    full_name  TEXT NOT NULL,
    email      TEXT UNIQUE,
    role       TEXT,                              -- PI, postdoc, research assistant, technician, etc.
    is_active  BOOLEAN NOT NULL DEFAULT TRUE
);

-- A reusable SOP. `study_type` uses the curation template's section-C vocabulary, should be defined by the lab's SOPs. The protocol is the root of the experiment provenance tree, so it is linked to each experiment.

CREATE TABLE lab.protocol (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    protocol_code TEXT,                           -- internal SOP reference
    name          TEXT NOT NULL,
    version       TEXT NOT NULL DEFAULT '1.0',
    study_type    TEXT CHECK (study_type IN (
                      'substrate_depletion','metabolite_formation',
                      'recombinant_enzyme','chemical_inhibition',
                      'antibody_inhibition','hepatocyte_stability',
                      'S9_metabolism','cytosol_metabolism')),
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    BIGINT REFERENCES lab.lab_member(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (protocol_code, version)
);

-- Ordered steps of a protocol
CREATE TABLE lab.protocol_step (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    protocol_id   BIGINT NOT NULL REFERENCES lab.protocol(id) ON DELETE CASCADE,
    step_number   INTEGER NOT NULL,
    instruction   TEXT NOT NULL,
    duration      NUMERIC,
    duration_unit TEXT DEFAULT 'min',
    UNIQUE (protocol_id, step_number)
);


-- =============================================================================
-- LOCAL REFERENCE TABLES
-- =============================================================================

-- Minimal local references keep the lab schema deployable in its own database.
CREATE TABLE lab.compound (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    canonical_name   TEXT NOT NULL UNIQUE,
    source_system    TEXT,
    source_record_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_system, source_record_id)
);

CREATE TABLE lab.enzyme (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    enzyme_name      TEXT NOT NULL UNIQUE,
    gene_symbol      TEXT,
    source_system    TEXT,
    source_record_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_system, source_record_id)
);

CREATE TABLE lab.metabolite (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_compound_id BIGINT NOT NULL REFERENCES lab.compound(id) ON DELETE RESTRICT,
    compound_id        BIGINT REFERENCES lab.compound(id) ON DELETE RESTRICT,
    metabolite_name    TEXT,
    metabolite_label   TEXT,
    reaction_type      TEXT,
    source_system      TEXT,
    source_record_id   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (parent_compound_id, metabolite_label),
    UNIQUE (source_system, source_record_id)
);


-- =============================================================================
-- SECTION B. REAGENT INVENTORY  (requirement: "reagents & lots")
-- =============================================================================

-- A catalog reagent (metadata). Link to lab.compound for catalogued chemicals;
-- leave NULL for generic bench reagents such as buffers or solvents.
CREATE TABLE lab.reagent (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           TEXT NOT NULL,
    reagent_type   TEXT CHECK (reagent_type IN
                       ('substrate','inhibitor','inducer','probe_substrate',
                        'cofactor','solvent','buffer','internal_standard','other')),
    compound_id    BIGINT REFERENCES lab.compound(id) ON DELETE RESTRICT,
    vendor         TEXT,
    catalog_number TEXT,
    notes          TEXT
);

-- A physical lot of a reagent. The unit experiments consume.
CREATE TABLE lab.reagent_lot (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    reagent_id         BIGINT NOT NULL REFERENCES lab.reagent(id) ON DELETE CASCADE,
    lot_number         TEXT NOT NULL,
    vendor             TEXT,                       -- may override reagent.vendor
    catalog_number     TEXT,
    concentration      NUMERIC CHECK (concentration IS NULL OR concentration >= 0),
    concentration_unit TEXT,
    received_date      DATE,
    expiry_date        DATE,
    storage_temp_c     NUMERIC,
    quantity_received  NUMERIC CHECK (quantity_received IS NULL OR quantity_received >= 0),
    quantity_remaining NUMERIC CHECK (quantity_remaining IS NULL OR quantity_remaining >= 0),
    quantity_unit      TEXT,
    coa_reference      TEXT,                       -- certificate of analysis
    is_depleted        BOOLEAN NOT NULL DEFAULT FALSE,
    notes              TEXT,
    CHECK (
        quantity_received IS NULL
        OR quantity_remaining IS NULL
        OR quantity_remaining <= quantity_received
    ),
    UNIQUE (reagent_id, lot_number)
);


-- =============================================================================
-- SECTION C. TISSUE / ENZYME-SOURCE INVENTORY
-- (HLM, S9, cytosol, hepatocytes, donor metadata 
-- =============================================================================

CREATE TABLE lab.tissue_lot (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_type             TEXT CHECK (material_type IN
                                  ('HLM','S9','cytosol','hepatocytes',
                                   'intestinal_microsomes','liver_tissue')),
    species                   TEXT,               -- human, mouse, rat, dog, monkey
    organ_or_tissue           TEXT,               -- liver, intestine
    tissue_fraction           TEXT,               -- microsome, cytosol, S9, hepatocyte
    pooled_or_individual      TEXT CHECK (pooled_or_individual IN ('pooled','individual')),
    number_of_donors          INTEGER CHECK (number_of_donors IS NULL OR number_of_donors >= 1),
    vendor_or_source          TEXT,               -- BioIVT, in-house tissue bank, ...
    catalog_number            TEXT,
    lot_number                TEXT,
    protein_concentration      NUMERIC CHECK (protein_concentration IS NULL OR protein_concentration >= 0),
    protein_concentration_unit TEXT DEFAULT 'mg/mL',
    viability                  NUMERIC CHECK (viability IS NULL OR viability >= 0),
    received_date              DATE,
    expiry_date                DATE,
    storage_temp_c             NUMERIC,
    quantity_remaining         NUMERIC CHECK (quantity_remaining IS NULL OR quantity_remaining >= 0),
    quantity_unit              TEXT,
    is_depleted                BOOLEAN NOT NULL DEFAULT FALSE,
    notes                      TEXT,
    UNIQUE (vendor_or_source, lot_number)
);

-- Donor detail for a lot (template section E). Pooled lots -> many rows;
-- individual-donor lots -> one row. Populated from the vendor donor sheet.
CREATE TABLE lab.tissue_lot_donor (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tissue_lot_id             BIGINT NOT NULL REFERENCES lab.tissue_lot(id) ON DELETE CASCADE,
    donor_id_in_source        TEXT,               -- vendor's de-identified donor ID
    sex                       TEXT CHECK (sex IN ('male','female','other','not_reported')),
    age_min                   NUMERIC,
    age_max                   NUMERIC,
    age_unit                  TEXT DEFAULT 'years',
    ancestry                  TEXT,
    race                      TEXT,
    ethnicity                 TEXT,
    bmi                       NUMERIC,
    disease_state             TEXT,               -- healthy, hepatic_impairment, ...
    tissue_quality            TEXT,
    genotype_available        BOOLEAN,
    proteomics_available      BOOLEAN,
    enzyme_activity_available BOOLEAN
);


-- =============================================================================
-- SECTION D. EXPERIMENT & CONDITIONS
-- =============================================================================

-- One physical bench run. Analogue of the curation schema's `study`, grounded in operator/date/protocol/notebook instead of a publication.
CREATE TABLE lab.experiment (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_code          TEXT UNIQUE,         -- ELN / lab-notebook reference
    title                    TEXT,
    protocol_id              BIGINT REFERENCES lab.protocol(id),
    study_type               TEXT NOT NULL CHECK (study_type IN (
                                 'substrate_depletion','metabolite_formation',
                                 'recombinant_enzyme','chemical_inhibition',
                                 'antibody_inhibition','hepatocyte_stability',
                                 'S9_metabolism','cytosol_metabolism')),
    performed_by             BIGINT REFERENCES lab.lab_member(id),
    experiment_date          DATE,
    substrate_compound_id    BIGINT REFERENCES lab.compound(id) ON DELETE RESTRICT,
    substrate_reagent_lot_id BIGINT REFERENCES lab.reagent_lot(id),   -- physical substrate lot
    tissue_lot_id            BIGINT REFERENCES lab.tissue_lot(id),     -- enzyme source used
    status                   TEXT NOT NULL DEFAULT 'planned'
                                 CHECK (status IN ('planned','in_progress','completed',
                                                   'failed','qc_passed','qc_failed')),
    objective                TEXT,
    notes                    TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which enzyme pathway(s) the experiment probes 
CREATE TABLE lab.experiment_enzyme (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    enzyme_id     BIGINT NOT NULL REFERENCES lab.enzyme(id) ON DELETE RESTRICT,
    organ_context TEXT CHECK (organ_context IN ('hepatic','intestinal','renal','plasma')),
    pathway_role  TEXT CHECK (pathway_role IN ('major','minor','unknown')),
    UNIQUE (experiment_id, enzyme_id)
);

-- Incubation conditions actually used (run-level subset; may deviate from the protocol default). 
CREATE TABLE lab.experiment_condition (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id               BIGINT NOT NULL UNIQUE
                                    REFERENCES lab.experiment(id) ON DELETE CASCADE,
    protein_concentration       NUMERIC CHECK (protein_concentration IS NULL OR protein_concentration >= 0),
    protein_concentration_unit  TEXT DEFAULT 'mg/mL',
    cell_density                NUMERIC CHECK (cell_density IS NULL OR cell_density >= 0),
    cell_density_unit           TEXT,
    incubation_temperature      NUMERIC,
    incubation_temperature_unit TEXT DEFAULT 'C',
    incubation_time             NUMERIC CHECK (incubation_time IS NULL OR incubation_time >= 0),
    incubation_time_unit        TEXT DEFAULT 'min',
    preincubation_time          NUMERIC CHECK (preincubation_time IS NULL OR preincubation_time >= 0),
    preincubation_time_unit     TEXT DEFAULT 'min',
    buffer                      TEXT,             -- phosphate, Tris, ...
    ph                          NUMERIC(4,2) CHECK (ph IS NULL OR ph BETWEEN 0 AND 14),
    solvent                     TEXT,             -- DMSO, methanol, acetonitrile
    solvent_percentage          NUMERIC CHECK (solvent_percentage IS NULL OR solvent_percentage BETWEEN 0 AND 100),
    linearity_confirmed         TEXT CHECK (linearity_confirmed IN ('yes','no','not_reported')),
    fu_inc                      NUMERIC CHECK (fu_inc IS NULL OR fu_inc BETWEEN 0 AND 1),
    CHECK (
        preincubation_time IS NULL
        OR incubation_time IS NULL
        OR preincubation_time <= incubation_time
    )
);

-- Cofactors used, each tied to the physical lot consumed.
CREATE TABLE lab.experiment_cofactor (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id      BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    cofactor           TEXT NOT NULL,             -- NADPH, UDPGA, PAPS, acetyl-CoA, GSH
    concentration      NUMERIC,
    concentration_unit TEXT,
    reagent_lot_id     BIGINT REFERENCES lab.reagent_lot(id)   -- which lot was used
);


-- =============================================================================
-- SECTION E. MODULATOR ARM 
-- =============================================================================

-- An inhibitor/inducer/probe arm within an experiment. The "control" arm is the
-- absence of any modulator row; result/measurement rows reference the treatment
-- they were run under (NULL = control). The physical inhibitor lot is linked.
CREATE TABLE lab.experiment_modulator (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id             BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    modulator_compound_id     BIGINT NOT NULL REFERENCES lab.compound(id) ON DELETE RESTRICT,
    modulator_role            TEXT CHECK (modulator_role IN
                                  ('inhibitor','inducer','probe_substrate','antibody_inhibitor')),
    target_enzyme_id          BIGINT REFERENCES lab.enzyme(id) ON DELETE RESTRICT,
    modulator_concentration   NUMERIC,
    concentration_unit        TEXT,               -- uM, mM
    ki                        NUMERIC,            -- if determined in-house
    ic50                      NUMERIC,            -- if determined in-house
    fu                        NUMERIC,
    reversible_or_time_dependent TEXT CHECK (reversible_or_time_dependent IN
                                  ('reversible','TDI','mixed','unknown')),
    preincubation_used        BOOLEAN,
    control_type              TEXT CHECK (control_type IN
                                  ('vehicle','no_cofactor','heat_inactivated')),
    reagent_lot_id            BIGINT REFERENCES lab.reagent_lot(id)   -- physical inhibitor lot
);


-- =============================================================================
-- SECTION F. RAW BENCH DATA
-- (per replicate x timepoint -- the actual measured data the summaries derive
--  from.)
-- =============================================================================

CREATE TABLE lab.assay_measurement (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id               BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    experiment_modulator_id     BIGINT REFERENCES lab.experiment_modulator(id),  -- NULL = control arm
    replicate_number            INTEGER NOT NULL DEFAULT 1 CHECK (replicate_number >= 1),
    well_position               TEXT,             -- e.g. plate/well, if applicable
    substrate_concentration     NUMERIC CHECK (substrate_concentration IS NULL OR substrate_concentration >= 0),
    substrate_concentration_unit TEXT,
    timepoint                   NUMERIC NOT NULL CHECK (timepoint >= 0), -- incubation time sampled
    timepoint_unit              TEXT DEFAULT 'min',
    measured_entity             TEXT NOT NULL CHECK (measured_entity IN
                                    ('parent_remaining','metabolite_formation')),
    metabolite_id               BIGINT REFERENCES lab.metabolite(id) ON DELETE RESTRICT,
    raw_value                   NUMERIC,          -- peak area / concentration as measured
    raw_unit                    TEXT,             -- peak_area, uM, ng/mL, ...
    normalized_value            NUMERIC,          -- e.g. % of T0, or pmol/min/mg
    normalized_unit             TEXT,
    is_excluded                 BOOLEAN NOT NULL DEFAULT FALSE,   -- outlier flag
    qc_flag                     TEXT,
    notes                       TEXT,
    measured_at                 TIMESTAMPTZ
);


-- =============================================================================
-- SECTION G.  SUMMARY RESULTS

-- =============================================================================

-- substrate depletion summary (one row per experiment x arm).
CREATE TABLE lab.substrate_depletion_result (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id               BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    experiment_modulator_id     BIGINT REFERENCES lab.experiment_modulator(id),  -- NULL = control
    substrate_concentration     NUMERIC,
    concentration_unit          TEXT,
    control_depletion_rate      NUMERIC,
    inhibited_depletion_rate    NUMERIC,
    control_clint               NUMERIC,
    inhibited_clint             NUMERIC,
    depletion_half_life         NUMERIC,          -- t1/2
    percent_inhibition_calculated NUMERIC,
    mean_value                  NUMERIC,
    sd                          NUMERIC,
    se                          NUMERIC,
    ci_lower                    NUMERIC,
    ci_upper                    NUMERIC,
    n_replicates                INTEGER,
    value_unit                  TEXT,
    calculation_method          TEXT,             -- e.g. log-linear regression of % remaining
    computed_by                 BIGINT REFERENCES lab.lab_member(id),
    computed_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- metabolite formation summary (one row per experiment x metabolite x arm).
CREATE TABLE lab.metabolite_formation_result (
    id                              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id                   BIGINT NOT NULL REFERENCES lab.experiment(id) ON DELETE CASCADE,
    metabolite_id                   BIGINT NOT NULL REFERENCES lab.metabolite(id) ON DELETE RESTRICT,
    experiment_modulator_id         BIGINT REFERENCES lab.experiment_modulator(id),
    control_formation_rate          NUMERIC,
    inhibited_formation_rate        NUMERIC,
    formation_rate_unit             TEXT,         -- pmol/min/mg protein, ...
    relative_metabolite_contribution NUMERIC,     -- percent of total metabolism
    percent_of_total_metabolite_signal NUMERIC,
    percent_inhibition_calculated   NUMERIC,
    km                              NUMERIC,
    vmax                            NUMERIC,
    vmax_km                         NUMERIC,       -- intrinsic clearance
    mean_value                      NUMERIC,
    sd                              NUMERIC,
    se                              NUMERIC,
    n_replicates                    INTEGER,
    calculation_method              TEXT,
    computed_by                     BIGINT REFERENCES lab.lab_member(id),
    computed_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =============================================================================
-- SECTION H. INDEXES
-- =============================================================================

CREATE INDEX idx_lab_protocol_created_by   ON lab.protocol (created_by);
CREATE INDEX idx_lab_protocolstep_protocol ON lab.protocol_step (protocol_id);

CREATE INDEX idx_lab_metabolite_parent_compound ON lab.metabolite (parent_compound_id);
CREATE INDEX idx_lab_metabolite_compound        ON lab.metabolite (compound_id);

CREATE INDEX idx_lab_reagent_compound      ON lab.reagent (compound_id);
CREATE INDEX idx_lab_reagentlot_reagent    ON lab.reagent_lot (reagent_id);
CREATE INDEX idx_lab_reagentlot_expiry     ON lab.reagent_lot (expiry_date);

CREATE INDEX idx_lab_tissuelot_material    ON lab.tissue_lot (material_type);
CREATE INDEX idx_lab_tissuelotdonor_lot    ON lab.tissue_lot_donor (tissue_lot_id);

CREATE INDEX idx_lab_experiment_protocol   ON lab.experiment (protocol_id);
CREATE INDEX idx_lab_experiment_operator   ON lab.experiment (performed_by);
CREATE INDEX idx_lab_experiment_substrate  ON lab.experiment (substrate_compound_id);
CREATE INDEX idx_lab_experiment_tissue     ON lab.experiment (tissue_lot_id);
CREATE INDEX idx_lab_experiment_date       ON lab.experiment (experiment_date);

CREATE INDEX idx_lab_expenzyme_experiment  ON lab.experiment_enzyme (experiment_id);
CREATE INDEX idx_lab_expenzyme_enzyme      ON lab.experiment_enzyme (enzyme_id);
CREATE INDEX idx_lab_expcond_experiment    ON lab.experiment_condition (experiment_id);
CREATE INDEX idx_lab_expcofactor_experiment ON lab.experiment_cofactor (experiment_id);
CREATE INDEX idx_lab_expcofactor_lot       ON lab.experiment_cofactor (reagent_lot_id);

CREATE INDEX idx_lab_expmod_experiment     ON lab.experiment_modulator (experiment_id);
CREATE INDEX idx_lab_expmod_compound       ON lab.experiment_modulator (modulator_compound_id);
CREATE INDEX idx_lab_expmod_lot            ON lab.experiment_modulator (reagent_lot_id);
CREATE UNIQUE INDEX uq_lab_expmod_arm
    ON lab.experiment_modulator (
        experiment_id,
        modulator_compound_id,
        COALESCE(modulator_role, ''),
        COALESCE(target_enzyme_id, -1),
        COALESCE(modulator_concentration, -1),
        COALESCE(concentration_unit, ''),
        COALESCE(reagent_lot_id, -1)
    );

CREATE INDEX idx_lab_measurement_experiment ON lab.assay_measurement (experiment_id);
CREATE INDEX idx_lab_measurement_modulator  ON lab.assay_measurement (experiment_modulator_id);
CREATE INDEX idx_lab_measurement_metabolite ON lab.assay_measurement (metabolite_id);

CREATE INDEX idx_lab_sdr_experiment        ON lab.substrate_depletion_result (experiment_id);
CREATE INDEX idx_lab_mfr_experiment        ON lab.metabolite_formation_result (experiment_id);
CREATE INDEX idx_lab_mfr_metabolite        ON lab.metabolite_formation_result (metabolite_id);


-- =============================================================================
-- PART 2. LC-MS/MS ANALYTICAL EXTENSION
--
-- Design intent
-- -------------
-- The existing schema stops at `lab.assay_measurement`, which already holds a
-- number ("peak area", "uM") without saying how that number was produced. This
-- extension adds the analytical layer underneath it:
--
--     method (what was set up)  ->  batch/sequence (what was run)
--     ->  sample (what was prepared)  ->  injection (what was acquired)
--     ->  peak (what was integrated)  ->  concentration (what was calculated)
--
-- The separation is deliberate and mirrors the curation-side distinction
-- between an observation and a derived quantity: `lcms_peak.peak_area` is
-- measured, `lcms_peak.calculated_concentration` is derived from a specific
-- `lcms_calibration_curve`, and `lab.assay_measurement` remains the bench-level
-- value that the summary tables (substrate_depletion_result,
-- metabolite_formation_result) are computed from. A peak points forward to the
-- assay_measurement row it feeds, so any reported CLint can be traced back to a
-- raw acquisition file.
-- =============================================================================


-- =============================================================================
-- SECTION I. LC-MS/MS METHOD DEFINITION
-- (the acquisition method as configured; versioned like lab.protocol)
-- =============================================================================

CREATE TABLE lab.lcms_method (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_code            TEXT,
    name                   TEXT NOT NULL,
    version                TEXT NOT NULL DEFAULT '1.0',
    protocol_id            BIGINT REFERENCES lab.protocol(id),  -- bioanalytical SOP, if separate
    instrument_description TEXT,                   -- free text, e.g. "Sciex QTRAP 6500+, ACQUITY UPLC I-Class"
    
    mass_analyzer          TEXT CHECK (mass_analyzer IN
                               ('triple_quadrupole','QTrap','QTOF','Orbitrap',
                                'ion_trap','single_quadrupole','other')),
    ionization_source      TEXT CHECK (ionization_source IN ('ESI','APCI','APPI','other')),
    acquisition_software   TEXT,                   -- Analyst, MassLynx, Xcalibur, ...
    acquisition_mode       TEXT CHECK (acquisition_mode IN
                               ('MRM','SRM','SIM','PRM','full_scan','DDA','DIA')),
    polarity               TEXT CHECK (polarity IN ('positive','negative','switching')),
    -- chromatography
    lc_column              TEXT,                   -- e.g. ACQUITY BEH C18
    column_dimensions      TEXT,                   -- e.g. 2.1 x 50 mm
    particle_size_um       NUMERIC,
    guard_column           TEXT,
    column_temperature_c   NUMERIC,
    mobile_phase_a         TEXT,                   -- e.g. 0.1% formic acid in water
    mobile_phase_b         TEXT,                   -- e.g. 0.1% formic acid in acetonitrile
    flow_rate              NUMERIC CHECK (flow_rate IS NULL OR flow_rate >= 0),
    flow_rate_unit         TEXT DEFAULT 'mL/min',
    injection_volume       NUMERIC CHECK (injection_volume IS NULL OR injection_volume >= 0),
    injection_volume_unit  TEXT DEFAULT 'uL',
    run_time               NUMERIC CHECK (run_time IS NULL OR run_time >= 0),
    run_time_unit          TEXT DEFAULT 'min',
    -- source conditions
    source_temperature_c   NUMERIC,
    capillary_voltage_kv   NUMERIC,
    gas_settings           TEXT,                   -- curtain/nebulizer/desolvation, free text
    -- sample handling defaults (may be overridden per lab.lcms_sample)
    default_quench_solvent TEXT,                   -- e.g. ice-cold ACN with IS
    default_extraction     TEXT,
    method_file_reference  TEXT,                   -- path/name of the instrument method file
    is_validated           BOOLEAN NOT NULL DEFAULT FALSE,
    validation_reference   TEXT,                   -- report ID for the validation package
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    notes                  TEXT,
    created_by             BIGINT REFERENCES lab.lab_member(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (method_code, version)
);

-- Ordered LC gradient program (parallel to lab.protocol_step).
CREATE TABLE lab.lcms_gradient_step (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_id      BIGINT NOT NULL REFERENCES lab.lcms_method(id) ON DELETE CASCADE,
    step_number    INTEGER NOT NULL CHECK (step_number >= 1),
    time_min       NUMERIC NOT NULL CHECK (time_min >= 0),
    percent_a      NUMERIC CHECK (percent_a IS NULL OR percent_a BETWEEN 0 AND 100),
    percent_b      NUMERIC CHECK (percent_b IS NULL OR percent_b BETWEEN 0 AND 100),
    flow_rate      NUMERIC CHECK (flow_rate IS NULL OR flow_rate >= 0),
    flow_rate_unit TEXT DEFAULT 'mL/min',
    curve_profile  TEXT,                           -- linear, step, instrument curve number
    UNIQUE (method_id, step_number)
);

-- One analyte channel in a method. Links the instrument-side label to the
-- domain entity: a parent drug (compound_id), a metabolite (metabolite_id)
CREATE TABLE lab.lcms_method_analyte (
    id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_id               BIGINT NOT NULL REFERENCES lab.lcms_method(id) ON DELETE CASCADE,
    analyte_label           TEXT NOT NULL,         -- name as it appears in the acquisition method
    analyte_role            TEXT NOT NULL CHECK (analyte_role IN
                                ('analyte','internal_standard','surrogate_analyte',
                                 'system_suitability')),
    compound_id             BIGINT REFERENCES lab.compound(id) ON DELETE RESTRICT,
    metabolite_id           BIGINT REFERENCES lab.metabolite(id) ON DELETE RESTRICT,
    internal_standard_analyte_id BIGINT,           -- FK below; the IS normalizing this channel
    is_stable_label         BOOLEAN,               -- d4-, 13C6-, ... (for IS rows)
    expected_retention_time NUMERIC CHECK (expected_retention_time IS NULL OR expected_retention_time >= 0),
    retention_time_window   NUMERIC,
    retention_time_unit     TEXT DEFAULT 'min',
    lloq                    NUMERIC CHECK (lloq IS NULL OR lloq >= 0),
    uloq                    NUMERIC CHECK (uloq IS NULL OR uloq >= 0),
    concentration_unit      TEXT,                  -- uM, ng/mL, nM
    quantification_basis    TEXT CHECK (quantification_basis IN
                                ('calibration_curve','area_ratio','peak_area_only',
                                 'percent_of_t0','relative_only')),
    default_calibration_model TEXT CHECK (default_calibration_model IN
                                ('linear','linear_through_zero','quadratic','power','log_linear')),
    default_weighting       TEXT CHECK (default_weighting IN ('none','1/x','1/x2','1/y','1/y2')),
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    notes                   TEXT,
    internal_standard_role  TEXT GENERATED ALWAYS AS ('internal_standard') STORED,  -- constant; lets the FK below require the referenced channel to be an IS
    -- an internal standard channel does not itself get an internal standard
    CHECK (internal_standard_analyte_id IS NULL OR analyte_role <> 'internal_standard'),
    -- a quantified channel must resolve to a domain entity; IS rows need not
    CHECK (analyte_role <> 'analyte' OR compound_id IS NOT NULL OR metabolite_id IS NOT NULL),
    CHECK (lloq IS NULL OR uloq IS NULL OR lloq <= uloq),
    UNIQUE (method_id, analyte_label),
    UNIQUE (id, method_id, analyte_role)           -- target for the composite FK below
);


ALTER TABLE lab.lcms_method_analyte
    ADD CONSTRAINT fk_lcms_analyte_internal_standard
        FOREIGN KEY (internal_standard_analyte_id, method_id, internal_standard_role)
        REFERENCES lab.lcms_method_analyte (id, method_id, analyte_role);

-- MRM/SRM transitions (or SIM/accurate-mass channels) for an analyte.
CREATE TABLE lab.lcms_transition (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    method_analyte_id         BIGINT NOT NULL REFERENCES lab.lcms_method_analyte(id) ON DELETE CASCADE,
    transition_role           TEXT NOT NULL DEFAULT 'quantifier'
                                  CHECK (transition_role IN ('quantifier','qualifier')),
    precursor_mz              NUMERIC NOT NULL CHECK (precursor_mz > 0),
    product_mz                NUMERIC CHECK (product_mz IS NULL OR product_mz > 0),
    polarity                  TEXT CHECK (polarity IN ('positive','negative')),
    adduct                    TEXT,                -- [M+H]+, [M-H]-, [M+NH4]+
    collision_energy          NUMERIC,
    declustering_or_cone_voltage NUMERIC,
    collision_cell_exit_potential NUMERIC,
    dwell_time_ms             NUMERIC CHECK (dwell_time_ms IS NULL OR dwell_time_ms > 0),
    expected_ion_ratio        NUMERIC,             -- qualifier / quantifier response
    ion_ratio_tolerance_pct   NUMERIC,
    notes                     TEXT,
    UNIQUE (method_analyte_id, precursor_mz, product_mz)
);

-- Exactly one quantifier transition per analyte channel.
CREATE UNIQUE INDEX uq_lab_lcms_transition_quantifier
    ON lab.lcms_transition (method_analyte_id)
    WHERE transition_role = 'quantifier';


-- =============================================================================
-- SECTION J. ANALYTICAL BATCH (the instrument sequence / run)
-- =============================================================================

CREATE TABLE lab.lcms_batch (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_code                TEXT UNIQUE,         -- sequence / worklist name
    method_id                 BIGINT NOT NULL REFERENCES lab.lcms_method(id) ON DELETE RESTRICT,
    run_date                  DATE,
    started_at                TIMESTAMPTZ,
    completed_at              TIMESTAMPTZ,
    operator_id               BIGINT REFERENCES lab.lab_member(id),
    sequence_file_reference   TEXT,
    data_directory            TEXT,                -- where the .wiff/.raw files live
    lc_column_lot             TEXT,
    mobile_phase_a_lot_id     BIGINT REFERENCES lab.reagent_lot(id),
    mobile_phase_b_lot_id     BIGINT REFERENCES lab.reagent_lot(id),
    internal_standard_lot_id  BIGINT REFERENCES lab.reagent_lot(id),
    system_suitability_passed BOOLEAN,
    batch_status              TEXT NOT NULL DEFAULT 'planned' CHECK (batch_status IN
                                  ('planned','acquiring','acquired','processed',
                                   'qc_passed','qc_failed','rejected')),
    reviewed_by               BIGINT REFERENCES lab.lab_member(id),
    reviewed_at               TIMESTAMPTZ,
    notes                     TEXT,
    CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);


-- =============================================================================
-- SECTION K. PREPARED SAMPLES
-- (study samples come from an incubation arm)
-- =============================================================================

CREATE TABLE lab.lcms_sample (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sample_code                 TEXT UNIQUE,       -- vial/tube label
    sample_type                 TEXT NOT NULL CHECK (sample_type IN
                                    ('study','calibrator','qc','blank','double_blank',
                                     'matrix_blank','solvent_blank','zero_sample',
                                     'system_suitability','stability','recovery')),
    -- incubation provenance (study samples): identifies the aliquot, matching the
    -- grain of lab.assay_measurement minus the analyte dimension
    experiment_id               BIGINT REFERENCES lab.experiment(id) ON DELETE RESTRICT,
    experiment_modulator_id     BIGINT REFERENCES lab.experiment_modulator(id),  -- NULL = control arm
    replicate_number            INTEGER CHECK (replicate_number IS NULL OR replicate_number >= 1),
    timepoint                   NUMERIC CHECK (timepoint IS NULL OR timepoint >= 0),
    timepoint_unit              TEXT DEFAULT 'min',
    substrate_concentration     NUMERIC CHECK (substrate_concentration IS NULL OR substrate_concentration >= 0),
    substrate_concentration_unit TEXT,
    -- calibrator / QC identity
    nominal_concentration       NUMERIC CHECK (nominal_concentration IS NULL OR nominal_concentration >= 0),
    nominal_concentration_unit  TEXT,
    qc_level                    TEXT CHECK (qc_level IN ('LLOQ','low','mid','high','ULOQ','dilution')),
    calibrator_level            INTEGER CHECK (calibrator_level IS NULL OR calibrator_level >= 1),
    -- preparation
    matrix                      TEXT,              -- HLM incubation matrix, buffer, blank matrix
    prepared_by                 BIGINT REFERENCES lab.lab_member(id),
    prepared_at                 TIMESTAMPTZ,
    quench_solvent              TEXT,
    quench_ratio                TEXT,              -- e.g. 3:1 solvent:incubate
    internal_standard_lot_id    BIGINT REFERENCES lab.reagent_lot(id),
    extraction_method           TEXT CHECK (extraction_method IN
                                    ('protein_precipitation','liquid_liquid','SPE',
                                     'dilute_and_shoot','other')),
    dilution_factor             NUMERIC NOT NULL DEFAULT 1 CHECK (dilution_factor > 0),
    reconstitution_solvent      TEXT,
    storage_temp_c              NUMERIC,
    freeze_thaw_cycles          INTEGER CHECK (freeze_thaw_cycles IS NULL OR freeze_thaw_cycles >= 0),
    is_excluded                 BOOLEAN NOT NULL DEFAULT FALSE,
    exclusion_reason            TEXT,
    notes                       TEXT,
    -- a study sample must be traceable to an incubation; calibrators/QC need a nominal value
    CHECK (sample_type <> 'study' OR experiment_id IS NOT NULL),
    CHECK (sample_type NOT IN ('calibrator','qc') OR nominal_concentration IS NOT NULL),
    CHECK (sample_type <> 'qc' OR qc_level IS NOT NULL)
);


-- =============================================================================
-- SECTION L. INJECTIONS
-- (a sample can be injected more than once: reinjection, dilution rerun)
-- =============================================================================

CREATE TABLE lab.lcms_injection (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id              BIGINT NOT NULL REFERENCES lab.lcms_batch(id) ON DELETE CASCADE,
    sample_id             BIGINT NOT NULL REFERENCES lab.lcms_sample(id) ON DELETE RESTRICT,
    injection_order       INTEGER NOT NULL CHECK (injection_order >= 1),
    vial_position         TEXT,                    -- plate/well or rack position
    injection_volume      NUMERIC CHECK (injection_volume IS NULL OR injection_volume >= 0),
    injection_volume_unit TEXT DEFAULT 'uL',
    acquisition_file      TEXT UNIQUE,             -- raw data file name (.wiff, .raw, .d)
    acquired_at           TIMESTAMPTZ,
    is_reinjection        BOOLEAN NOT NULL DEFAULT FALSE,
    injection_status      TEXT NOT NULL DEFAULT 'planned' CHECK (injection_status IN
                              ('planned','acquired','failed','excluded')),
    exclusion_reason      TEXT,
    notes                 TEXT,
    UNIQUE (batch_id, injection_order),
    UNIQUE (id, batch_id)                          -- target for composite FKs
);


-- =============================================================================
-- SECTION M. CALIBRATION
-- (defined before peaks: a peak cites the curve used to convert it)
-- =============================================================================

CREATE TABLE lab.lcms_calibration_curve (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id              BIGINT NOT NULL REFERENCES lab.lcms_batch(id) ON DELETE CASCADE,
    method_analyte_id     BIGINT NOT NULL REFERENCES lab.lcms_method_analyte(id) ON DELETE RESTRICT,
    curve_label           TEXT NOT NULL DEFAULT 'primary',  -- 'opening'/'closing' for bracketed runs
    regression_model      TEXT CHECK (regression_model IN
                              ('linear','linear_through_zero','quadratic','power','log_linear')),
    weighting             TEXT CHECK (weighting IN ('none','1/x','1/x2','1/y','1/y2')),
    response_type         TEXT CHECK (response_type IN
                              ('peak_area','area_ratio','peak_height','height_ratio')),
    slope                 NUMERIC,
    intercept             NUMERIC,
    quadratic_coefficient NUMERIC,
    r_squared             NUMERIC CHECK (r_squared IS NULL OR r_squared BETWEEN 0 AND 1),
    lloq                  NUMERIC CHECK (lloq IS NULL OR lloq >= 0),
    uloq                  NUMERIC CHECK (uloq IS NULL OR uloq >= 0),
    concentration_unit    TEXT,
    n_points_included     INTEGER CHECK (n_points_included IS NULL OR n_points_included >= 0),
    is_accepted           BOOLEAN,
    acceptance_criteria   TEXT,                    -- e.g. 75% of levels within +/-15%, +/-20% at LLOQ
    processing_software   TEXT,
    fitted_by             BIGINT REFERENCES lab.lab_member(id),
    fitted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                 TEXT,
    CHECK (lloq IS NULL OR uloq IS NULL OR lloq <= uloq),
    UNIQUE (batch_id, method_analyte_id, curve_label),
    UNIQUE (id, method_analyte_id)                 -- target for the composite FK below
);


-- =============================================================================
-- SECTION N. PEAKS  (the integrated measurement -- one row per injection x analyte)
-- =============================================================================

CREATE TABLE lab.lcms_peak (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    injection_id              BIGINT NOT NULL REFERENCES lab.lcms_injection(id) ON DELETE CASCADE,
    method_analyte_id         BIGINT NOT NULL REFERENCES lab.lcms_method_analyte(id) ON DELETE RESTRICT,
    transition_id             BIGINT REFERENCES lab.lcms_transition(id),  -- NULL = quantifier/summed
    -- observed
    retention_time            NUMERIC CHECK (retention_time IS NULL OR retention_time >= 0),
    retention_time_unit       TEXT DEFAULT 'min',
    peak_area                 NUMERIC CHECK (peak_area IS NULL OR peak_area >= 0),
    peak_height               NUMERIC CHECK (peak_height IS NULL OR peak_height >= 0),
    peak_width                NUMERIC,
    signal_to_noise           NUMERIC CHECK (signal_to_noise IS NULL OR signal_to_noise >= 0),
    internal_standard_peak_id BIGINT,              -- FK below: the IS peak in the same injection
    area_ratio                NUMERIC,             -- analyte area / IS area
    observed_ion_ratio        NUMERIC,             -- qualifier / quantifier, for confirmation
    -- derived
    calibration_curve_id      BIGINT,              -- FK below (composite: same analyte)
    calculated_concentration  NUMERIC,
    concentration_unit        TEXT,
    dilution_corrected_concentration NUMERIC,      -- calculated x lcms_sample.dilution_factor
    accuracy_percent          NUMERIC,             -- calibrators/QC: measured vs nominal
    is_below_lloq             BOOLEAN,
    is_above_uloq             BOOLEAN,
    -- processing provenance
    integration_type          TEXT NOT NULL DEFAULT 'automatic' CHECK (integration_type IN
                                  ('automatic','manual','reintegrated')),
    integration_reason        TEXT,                -- required in practice for manual integration
    processing_software       TEXT,
    integrated_by             BIGINT REFERENCES lab.lab_member(id),
    integrated_at             TIMESTAMPTZ,
    qc_flag                   TEXT,
    is_excluded               BOOLEAN NOT NULL DEFAULT FALSE,
    exclusion_reason          TEXT,
    -- bridge to the bench layer: the assay_measurement row this peak produced
    assay_measurement_id      BIGINT REFERENCES lab.assay_measurement(id) ON DELETE SET NULL,
    notes                     TEXT,
    CHECK (integration_type = 'automatic' OR integration_reason IS NOT NULL),
    UNIQUE (id, injection_id),                     -- target for the IS composite FK
    UNIQUE (id, method_analyte_id)
);

-- The internal-standard peak must come from the SAME injection.
ALTER TABLE lab.lcms_peak
    ADD CONSTRAINT fk_lcms_peak_internal_standard
        FOREIGN KEY (internal_standard_peak_id, injection_id)
        REFERENCES lab.lcms_peak (id, injection_id);

-- The curve used must have been fit for the SAME analyte channel.
ALTER TABLE lab.lcms_peak
    ADD CONSTRAINT fk_lcms_peak_calibration_curve
        FOREIGN KEY (calibration_curve_id, method_analyte_id)
        REFERENCES lab.lcms_calibration_curve (id, method_analyte_id);

-- One row per injection x analyte x transition (NULL transition = the summed/
-- quantifier row). COALESCE index because NULLs are distinct in a plain UNIQUE.
CREATE UNIQUE INDEX uq_lab_lcms_peak_channel
    ON lab.lcms_peak (injection_id, method_analyte_id, COALESCE(transition_id, -1));

-- A given assay_measurement is fed by at most one peak.
CREATE UNIQUE INDEX uq_lab_lcms_peak_assay_measurement
    ON lab.lcms_peak (assay_measurement_id)
    WHERE assay_measurement_id IS NOT NULL;

-- Which calibrator peaks went into a curve, and which were dropped.
CREATE TABLE lab.lcms_calibration_point (
    id                            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    calibration_curve_id          BIGINT NOT NULL REFERENCES lab.lcms_calibration_curve(id) ON DELETE CASCADE,
    peak_id                       BIGINT NOT NULL REFERENCES lab.lcms_peak(id) ON DELETE CASCADE,
    nominal_concentration         NUMERIC NOT NULL CHECK (nominal_concentration >= 0),
    concentration_unit            TEXT,
    response                      NUMERIC,         -- area or area ratio actually regressed
    back_calculated_concentration NUMERIC,
    bias_percent                  NUMERIC,
    is_included                   BOOLEAN NOT NULL DEFAULT TRUE,
    exclusion_reason              TEXT,
    UNIQUE (calibration_curve_id, peak_id),
    CHECK (is_included OR exclusion_reason IS NOT NULL)
);


-- =============================================================================
-- SECTION O. BATCH QC ACCEPTANCE
-- (roll-up over QC sample peaks; kept explicit so a batch's pass/fail decision
--  and its criteria are recorded, not recomputed later from memory)
-- =============================================================================

CREATE TABLE lab.lcms_qc_evaluation (
    id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id                    BIGINT NOT NULL REFERENCES lab.lcms_batch(id) ON DELETE CASCADE,
    method_analyte_id           BIGINT NOT NULL REFERENCES lab.lcms_method_analyte(id) ON DELETE RESTRICT,
    qc_level                    TEXT NOT NULL CHECK (qc_level IN
                                    ('LLOQ','low','mid','high','ULOQ','dilution')),
    n_replicates                INTEGER CHECK (n_replicates IS NULL OR n_replicates >= 1),
    nominal_concentration       NUMERIC,
    mean_measured_concentration NUMERIC,
    concentration_unit          TEXT,
    accuracy_percent            NUMERIC,           -- mean measured / nominal x 100
    precision_cv_percent        NUMERIC CHECK (precision_cv_percent IS NULL OR precision_cv_percent >= 0),
    is_within_acceptance        BOOLEAN,
    acceptance_criteria         TEXT,
    evaluated_by                BIGINT REFERENCES lab.lab_member(id),
    evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                       TEXT,
    UNIQUE (batch_id, method_analyte_id, qc_level)
);


-- =============================================================================
-- SECTION P. METABOLITE IDENTIFICATION EVIDENCE  (optional, for HRMS work)
-- Keeps structural assignment separate from quantification: a peak can be
-- measured without its structure being confirmed, and the confidence level
-- records how far the assignment actually goes.
-- =============================================================================

CREATE TABLE lab.lcms_identification (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    peak_id                   BIGINT REFERENCES lab.lcms_peak(id) ON DELETE SET NULL,
    injection_id              BIGINT NOT NULL REFERENCES lab.lcms_injection(id) ON DELETE CASCADE,
    metabolite_id             BIGINT REFERENCES lab.metabolite(id) ON DELETE RESTRICT,
    proposed_formula          TEXT,
    biotransformation         TEXT,                -- +O, -H2, glucuronide, GSH conjugate
    adduct                    TEXT,
    measured_mz               NUMERIC CHECK (measured_mz IS NULL OR measured_mz > 0),
    theoretical_mz            NUMERIC CHECK (theoretical_mz IS NULL OR theoretical_mz > 0),
    mass_error_ppm            NUMERIC,
    isotope_pattern_score     NUMERIC,
    ms2_fragments             JSONB,               -- [{"mz":..,"intensity":..,"assignment":".."}]
    fragment_interpretation   TEXT,
    identification_confidence TEXT CHECK (identification_confidence IN
                                  ('level1_reference_standard','level2_library_match',
                                   'level3_tentative_structure','level4_molecular_formula',
                                   'level5_exact_mass')),
    reference_standard_lot_id BIGINT REFERENCES lab.reagent_lot(id),
    spectral_library          TEXT,
    assigned_by               BIGINT REFERENCES lab.lab_member(id),
    assigned_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                     TEXT
);


-- =============================================================================
-- SECTION Q. INDEXES
-- =============================================================================

CREATE INDEX idx_lab_lcmsgradient_method       ON lab.lcms_gradient_step (method_id);

CREATE INDEX idx_lab_lcmsanalyte_method        ON lab.lcms_method_analyte (method_id);
CREATE INDEX idx_lab_lcmsanalyte_compound      ON lab.lcms_method_analyte (compound_id);
CREATE INDEX idx_lab_lcmsanalyte_metabolite    ON lab.lcms_method_analyte (metabolite_id);
CREATE INDEX idx_lab_lcmsanalyte_is            ON lab.lcms_method_analyte (internal_standard_analyte_id);
CREATE INDEX idx_lab_lcmstransition_analyte    ON lab.lcms_transition (method_analyte_id);

CREATE INDEX idx_lab_lcmsbatch_method          ON lab.lcms_batch (method_id);
CREATE INDEX idx_lab_lcmsbatch_run_date        ON lab.lcms_batch (run_date);
CREATE INDEX idx_lab_lcmsbatch_operator        ON lab.lcms_batch (operator_id);
CREATE INDEX idx_lab_lcmsbatch_status          ON lab.lcms_batch (batch_status);

CREATE INDEX idx_lab_lcmssample_experiment     ON lab.lcms_sample (experiment_id);
CREATE INDEX idx_lab_lcmssample_modulator      ON lab.lcms_sample (experiment_modulator_id);
CREATE INDEX idx_lab_lcmssample_type           ON lab.lcms_sample (sample_type);
CREATE INDEX idx_lab_lcmssample_aliquot        ON lab.lcms_sample (experiment_id, replicate_number, timepoint);

CREATE INDEX idx_lab_lcmsinjection_batch       ON lab.lcms_injection (batch_id);
CREATE INDEX idx_lab_lcmsinjection_sample      ON lab.lcms_injection (sample_id);
CREATE INDEX idx_lab_lcmsinjection_acquired    ON lab.lcms_injection (acquired_at);

CREATE INDEX idx_lab_lcmscurve_batch           ON lab.lcms_calibration_curve (batch_id);
CREATE INDEX idx_lab_lcmscurve_analyte         ON lab.lcms_calibration_curve (method_analyte_id);

CREATE INDEX idx_lab_lcmspeak_injection        ON lab.lcms_peak (injection_id);
CREATE INDEX idx_lab_lcmspeak_analyte          ON lab.lcms_peak (method_analyte_id);
CREATE INDEX idx_lab_lcmspeak_curve            ON lab.lcms_peak (calibration_curve_id);
CREATE INDEX idx_lab_lcmspeak_is_peak          ON lab.lcms_peak (internal_standard_peak_id);

CREATE INDEX idx_lab_lcmscalpoint_curve        ON lab.lcms_calibration_point (calibration_curve_id);
CREATE INDEX idx_lab_lcmscalpoint_peak         ON lab.lcms_calibration_point (peak_id);

CREATE INDEX idx_lab_lcmsqc_batch              ON lab.lcms_qc_evaluation (batch_id);
CREATE INDEX idx_lab_lcmsident_injection       ON lab.lcms_identification (injection_id);
CREATE INDEX idx_lab_lcmsident_metabolite      ON lab.lcms_identification (metabolite_id);


-- =============================================================================
-- SECTION R. VIEWS
-- =============================================================================

-- Flattened analytical result for study samples: one row per measured analyte
-- per incubation aliquot, with full instrument provenance attached. This is the
-- view to load into pandas for CLint / formation-rate fitting.
CREATE VIEW lab.v_lcms_study_result AS
SELECT
    e.id                        AS experiment_id,
    e.experiment_code,
    e.study_type,
    s.experiment_modulator_id,
    s.replicate_number,
    s.timepoint,
    s.timepoint_unit,
    s.substrate_concentration,
    s.substrate_concentration_unit,
    ma.analyte_label,
    ma.analyte_role,
    ma.compound_id,
    ma.metabolite_id,
    p.peak_area,
    p.area_ratio,
    p.calculated_concentration,
    p.dilution_corrected_concentration,
    p.concentration_unit,
    p.retention_time,
    p.signal_to_noise,
    p.is_below_lloq,
    p.integration_type,
    p.is_excluded                AS peak_excluded,
    s.is_excluded                AS sample_excluded,
    p.assay_measurement_id,
    i.acquisition_file,
    i.acquired_at,
    b.batch_code,
    b.batch_status,
    m.method_code,
    m.version                    AS method_version
FROM lab.lcms_peak p
JOIN lab.lcms_injection i        ON i.id = p.injection_id
JOIN lab.lcms_batch b            ON b.id = i.batch_id
JOIN lab.lcms_method m           ON m.id = b.method_id
JOIN lab.lcms_method_analyte ma  ON ma.id = p.method_analyte_id
JOIN lab.lcms_sample s           ON s.id = i.sample_id
JOIN lab.experiment e            ON e.id = s.experiment_id
WHERE s.sample_type = 'study';

-- Batch-level QC dashboard: curve fit plus QC acceptance per analyte.
CREATE VIEW lab.v_lcms_batch_qc AS
SELECT
    b.id                AS batch_id,
    b.batch_code,
    b.run_date,
    b.batch_status,
    ma.analyte_label,
    c.regression_model,
    c.weighting,
    c.r_squared,
    c.n_points_included,
    c.is_accepted       AS curve_accepted,
    q.qc_level,
    q.accuracy_percent,
    q.precision_cv_percent,
    q.is_within_acceptance
FROM lab.lcms_batch b
JOIN lab.lcms_method_analyte ma      ON ma.method_id = b.method_id
LEFT JOIN lab.lcms_calibration_curve c
       ON c.batch_id = b.id AND c.method_analyte_id = ma.id
LEFT JOIN lab.lcms_qc_evaluation q
       ON q.batch_id = b.id AND q.method_analyte_id = ma.id
WHERE ma.analyte_role <> 'internal_standard';   -- curves/QC are not fit for IS channels

COMMIT;
