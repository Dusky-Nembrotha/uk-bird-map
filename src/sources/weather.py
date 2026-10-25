"""Weather fields for the animation studio, from Open-Meteo (no key needed).

Fetches a coarse grid of hourly wind, cloud cover and precipitation covering
the studio's view, and stores it as flat per-hour arrays. The studio
interpolates between grid cells and between hours, so a 1 degree grid is
enough to drive a smooth particle field - this is the same trick the big wind
maps use, and it keeps the download to a couple of megabytes rather than the
gigabytes a full reanalysis would cost.

Wind is converted from the meteorological convention (the direction wind comes
*from*) into u/v components (the direction it goes *to*), because that is what
a particle integrator needs.
"""
import json
import math

API = "https://api.open-meteo.com/v1/forecast"

# Grid over the studio view. Coarse on purpose - see the module docstring -
# and deliberately much wider than Britain: a 16:9 frame at the default
# framing shows roughly 25W to 16E, so a grid that stopped at the coastline
# left the wind and cloud covering only the middle of the picture.
GRID = {"lat0": 40.0, "lon0": -32.0, "dlat": 1.5, "dlon": 2.5,
        "rows": 19, "cols": 21}

BATCH = 40          # locations per request
HOURLY = "wind_speed_10m,wind_direction_10m,cloud_cover,precipitation"


def _cells():
    out = []
    for r in range(GRID["rows"]):
        for c in range(GRID["cols"]):
            out.append((round(GRID["lat0"] + r * GRID["dlat"], 4),
                        round(GRID["lon0"] + c * GRID["dlon"], 4)))
    return out


def fetch(days_back=None, forecast_days=1):
    from ..config import CFG, WEB_DATA
    from ..util import RateLimiter, log, request_json

    limiter = RateLimiter(0.6)
    days = CFG["days_back"] if days_back is None else days_back
    cells = _cells()
    n = len(cells)

    times = None
    u = v = cloud = precip = None

    for start in range(0, n, BATCH):
        chunk = cells[start:start + BATCH]
        params = {
            "latitude": ",".join(str(la) for la, _ in chunk),
            "longitude": ",".join(str(lo) for _, lo in chunk),
            "hourly": HOURLY,
            "past_days": min(days, 92),
            "forecast_days": forecast_days,
            "timezone": "GMT",
            "wind_speed_unit": "ms",
        }
        try:
            data = request_json("GET", API, params=params, limiter=limiter,
                                timeout=120)
        except Exception as e:  # noqa: BLE001
            log.warning("weather: grid chunk at %d failed (%s)", start, e)
            continue
        if isinstance(data, dict):
            data = [data]

        for i, loc in enumerate(data):
            h = loc.get("hourly") or {}
            if not h.get("time"):
                continue
            if times is None:
                times = h["time"]
                steps = len(times)
                u = [[0.0] * n for _ in range(steps)]
                v = [[0.0] * n for _ in range(steps)]
                cloud = [[0] * n for _ in range(steps)]
                precip = [[0.0] * n for _ in range(steps)]
            idx = start + i
            for t in range(min(len(times), len(h["time"]))):
                spd = h["wind_speed_10m"][t] or 0.0
                deg = h["wind_direction_10m"][t] or 0.0
                rad = math.radians(deg)
                # Meteorological "from" direction -> vector pointing "to".
                u[t][idx] = round(-spd * math.sin(rad), 2)
                v[t][idx] = round(-spd * math.cos(rad), 2)
                cloud[t][idx] = int(h["cloud_cover"][t] or 0)
                precip[t][idx] = round(h["precipitation"][t] or 0.0, 2)
        log.info("weather: %d/%d grid cells", min(start + BATCH, n), n)

    if times is None:
        log.warning("weather: no data fetched")
        return None

    out = {"grid": GRID, "times": times, "u": u, "v": v,
           "cloud": cloud, "precip": precip}
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA / "weather.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    log.info("weather: %d hours x %d cells -> %s (%.1f MB)",
             len(times), n, path.name, path.stat().st_size / 1e6)
    return path
