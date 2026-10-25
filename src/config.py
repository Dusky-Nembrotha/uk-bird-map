"""Configuration loading. The eBird token is read from config.json (or the
EBIRD_API_TOKEN environment variable, which takes precedence)."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
WEB_DATA = ROOT / "web" / "data"
DB_PATH = DATA / "sightings.db"

_DEFAULTS = {
    "days_back": 14,
    "sources": {"ebird": True, "inaturalist": True, "birdweather": True,
                "gbif": True, "blogs": True, "bluesky": True,
                "countyrecorders": True},
    "birdweather": {"high_confidence": True, "min_confidence": 0.8,
                    "max_species_per_station": 60, "max_pages": 2000},
    "inaturalist": {"max_pages": 320, "quality_grade": "research,needs_id"},
    "gbif": {"max_records": 60000, "max_pages": 400, "days_back": 30},
    "region": "europe",
    "user_agent": "UK-Nature-Map/1.0",
    "ebird_api_token": "",
}


def _merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load():
    cfg = dict(_DEFAULTS)
    path = ROOT / "config.json"
    if path.exists():
        cfg = _merge(cfg, json.loads(path.read_text()))
    from_env = os.environ.get("EBIRD_API_TOKEN")
    if from_env:
        cfg["ebird_api_token"] = from_env
    if cfg.get("ebird_api_token", "").startswith("PUT_YOUR"):
        cfg["ebird_api_token"] = ""
    for d in (DATA, CACHE, WEB_DATA):
        d.mkdir(parents=True, exist_ok=True)
    return cfg


CFG = load()

# Great Britain + Northern Ireland + surrounding seas. Still used for the
# county blogs and the gazetteer, which are UK-only by nature.
UK_BBOX = {"south": 49.80, "west": -8.70, "north": 61.10, "east": 2.10}

# Europe, from Iceland and the Azores edge across to the Urals' foothills.
EUROPE_BBOX = {"south": 34.0, "west": -25.0, "north": 72.0, "east": 45.0}

REGIONS = {"uk": UK_BBOX, "europe": EUROPE_BBOX}


def region_bbox(cfg=None):
    """The bounding box the fetchers collect within."""
    cfg = cfg or CFG
    return REGIONS.get(cfg.get("region", "uk"), UK_BBOX)


AREA_BBOX = region_bbox()
