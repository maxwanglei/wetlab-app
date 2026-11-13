import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.exc import IntegrityError

from app.routes import auth, dashboard, experiments, inventory, members, reference, system

FRONTEND_DIST = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
log = logging.getLogger(__name__)
FETCH_HEADER = ("x-requested-with", "wetlab")

CONSTRAINT_MESSAGES = {
    "uq_lab_member_email_lower": "Another lab member already has this email.",
    "ck_assay_measurement_exclusion_reason": "An excluded point needs a reason.",
    "ck_sdr_fm_estimate": "An fm estimate must be between 0 and 1.",
    "uq_lab_expmod_arm": "That inhibitor arm already exists in this stage at that concentration and cofactor condition.",
    "assay_measurement_timepoint_check": "Timepoints cannot be negative.",
    "reagent_lot_reagent_id_lot_number_key": "That lot number already exists for this reagent.",
    "tissue_lot_vendor_or_source_lot_number_key": "That lot number already exists for this supplier.",
    "reagent_lot_check": "The amount remaining can't be more than the amount received.",
    "experiment_experiment_code_key": "That experiment code is already in use.",
    "experiment_enzyme_experiment_id_enzyme_id_key": "Each enzyme can be listed only once per experiment.",
    "experiment_condition_check": "The preincubation can't be longer than the incubation.",
    "uq_lab_expstage_type": "Each stage type can appear only once in an experiment.",
    "uq_lab_expstage_sequence": "Two stages can't share a position.",
    "ck_experiment_stage_dilution_pair": "A dilution needs both its factor and the stage it was diluted from.",
    "ck_experiment_stage_type": "A stage must be primary, secondary or tertiary.",
    "ck_experiment_stage_sequence": "A stage's position must be 1 or more.",
    "ck_experiment_stage_minutes": "A stage's incubation time can't be negative.",
    "ck_experiment_stage_protein": "A stage's protein level can't be negative.",
    "ck_experiment_stage_cell_density": "A stage's cell density can't be negative.",
    "ck_experiment_stage_dilution": "A dilution factor must be more than 0.",
    "ck_experiment_stage_not_self": "A stage can't be diluted from itself.",
    "fk_lab_expstage_diluted_from": "A stage can only be diluted from a stage of the same experiment.",
    "fk_lab_measurement_stage": "A measurement's stage must belong to its experiment.",
    "ck_experiment_control_type": "That control type is not one the app knows.",
    "ck_experiment_control_label": "A control needs a label.",
    "ck_experiment_control_solvent_percentage": "A solvent percentage must be between 0 and 100.",
    "ck_experiment_control_protein": "A control's protein level can't be negative.",
    "ck_experiment_control_omitted_only_minus_cofactor": "Only a minus-cofactor control can name an omitted cofactor.",
    "ck_experiment_control_complete_no_solvent": "A complete incubation has no added solvent.",
    "ck_experiment_control_vehicle_names_solvent": "A control with no solvent added is a complete incubation, not a vehicle.",
    "ck_experiment_control_protein_override": "Only heat-inactivated and other controls can set their own protein level.",
    "uq_lab_expcontrol_label": "Two controls in one stage can't share a label.",
    "fk_lab_expcontrol_stage": "A control's stage must belong to its experiment.",
    "fk_lab_expcontrol_omitted_cofactor": "An omitted cofactor must be one of the experiment's cofactors.",
    "ck_experiment_modulator_solvent_percentage": "A solvent percentage must be between 0 and 100.",
    "ck_experiment_modulator_omitted_requires_flag": "An arm can name an omitted cofactor only when its cofactor is omitted.",
    "fk_lab_expmod_stage": "An arm's stage must belong to its experiment.",
    "fk_lab_expmod_omitted_cofactor": "An omitted cofactor must be one of the experiment's cofactors.",
    "fk_lab_expmod_reference": "An arm's reference control must be in the arm's own stage.",
    "ck_experiment_sampling": "Sampling must be a time course or a single endpoint.",
    "ck_experiment_modulator_minutes": "An arm's time in its stage can't be negative.",
    "ck_experiment_modulator_replicates": "An arm needs at least one replicate.",
    "ck_experiment_control_minutes": "A control's time in its stage can't be negative.",
    "ck_experiment_control_replicates": "A control needs at least one replicate.",
    "ck_assay_measurement_one_subject": "A measurement belongs to an inhibitor arm or a control, not both.",
    "ck_sdr_one_subject": "A result belongs to an inhibitor arm or a control, not both.",
    "ck_mfr_one_subject": "A result belongs to an inhibitor arm or a control, not both.",
    "ck_lcms_sample_one_subject": "A sample belongs to an inhibitor arm or a control, not both.",
    "ck_lcms_sample_control_has_experiment": "A sample that names a control must name its experiment.",
    "fk_lab_measurement_control": "A measurement's control must belong to its experiment.",
    "fk_lab_sdr_control": "A result's control must belong to its experiment.",
    "fk_lab_mfr_control": "A result's control must belong to its experiment.",
    "fk_lab_lcms_sample_control": "A sample's control must belong to its experiment.",
    "fk_lab_sdr_reference": "A result's reference control must belong to its experiment.",
    "fk_lab_mfr_reference": "A result's reference control must belong to its experiment.",
    "ck_internal_standard_concentration": "The internal standard's concentration must be more than 0.",
    "ck_internal_standard_addition_step": "That step for adding the internal standard is not one the app knows.",
    "ck_internal_standard_unit": "The internal standard's concentration needs its unit.",
    "uq_lab_expis_experiment": "An experiment has one internal standard.",
    "ck_reagent_type": "That reagent type is not one the app knows.",
    "ck_experiment_cofactor_role": "A component's role must be solvent, cofactor, substrate or other.",
    "fk_lab_expcofactor_solution": "That prepared solution no longer exists. Reload the page and pick again.",
    "ck_reagent_component_name": "A component needs a name.",
    "ck_reagent_component_amount": "A component's amount can't be negative.",
    "ck_reagent_component_unit": "A component's amount needs its unit.",
    "ck_reagent_component_not_itself": "A lot can't be made from itself.",
    "ck_prepared_solution_label": "A prepared solution needs a label.",
}
MISSING_REFERENCE = "A chosen lot, protocol or person no longer exists. Reload the page and pick again."

# No public API explorer: the contract reaches the frontend through scripts/export_openapi.py.
app = FastAPI(title="Wet Lab API", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def require_fetch_for_mutations(request: Request, call_next):
    # Browsers send the session cookie on top-level cross-site form posts, so a forged one would carry it.
    # A custom header plus a JSON body can only come from our own page.
    if request.method in MUTATING_METHODS and request.url.path.startswith("/api/"):
        name, value = FETCH_HEADER
        if request.headers.get(name) != value or not request.headers.get("content-type", "").startswith(
            "application/json"
        ):
            return JSONResponse({"detail": "Changes need a JSON body and the X-Requested-With: wetlab header."}, 403)
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
    # Report where and what, never the rejected input: it may not be JSON-encodable (inf, nan).
    details = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", "Invalid value.")} for e in error.errors()]
    return JSONResponse({"detail": details}, 422)


@app.exception_handler(IntegrityError)
async def integrity_error(request: Request, error: IntegrityError) -> JSONResponse:
    constraint = getattr(getattr(error.orig, "diag", None), "constraint_name", None)
    log.warning("integrity error on %s %s: constraint %s", request.method, request.url.path, constraint)
    message = CONSTRAINT_MESSAGES.get(constraint) or (
        MISSING_REFERENCE
        if constraint and constraint.endswith("_fkey")
        else "The database rejected this change because it breaks a data rule."
    )
    return JSONResponse({"detail": message}, 409)


app.include_router(system.router)
app.include_router(auth.router)
app.include_router(members.router)
app.include_router(dashboard.router)
app.include_router(experiments.router)
app.include_router(inventory.router)
app.include_router(reference.router)


if FRONTEND_DIST.is_dir():

    @app.get("/{path:path}", include_in_schema=False)
    def single_page_app(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(404, "not found")
        root = FRONTEND_DIST.resolve()
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html")
