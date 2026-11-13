"""Write the API contract the frontend generates its types from: `uv run python -m scripts.export_openapi`."""

import json
from pathlib import Path

from app.main import app

target = Path(__file__).resolve().parents[2] / "frontend" / "openapi.json"
target.write_text(json.dumps(app.openapi(), indent=2) + "\n")
print(f"wrote {target}")
