"""Shared helpers: HTTP with retry/caching, UK coordinate checks, logging."""
import hashlib
import json
import logging
import sys
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests

from .config import AREA_BBOX, CACHE, CFG, UK_BBOX

log = logging.getLogger("uknaturemap")


def setup_logging(verbose=False):
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)


_session = None


def session():
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = CFG["user_agent"]
    return _session


class RateLimiter:
    """Minimum interval between calls, per source."""

    def __init__(self, min_interval):
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self):
        gap = time.monotonic() - self._last
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last = time.monotonic()


def request_json(method, url, *, limiter=None, retries=4, timeout=60,
                 cache_hours=0, **kw):
    """GET/POST returning parsed JSON, with retry on transient failures and an
    optional on-disk cache (used for slow-changing reference data)."""
    ck = None
    if cache_hours:
        key = hashlib.sha1(
            f"{method}{url}{json.dumps(kw.get('json'), sort_keys=True)}"
            f"{json.dumps(kw.get('params'), sort_keys=True)}".encode()
        ).hexdigest()[:20]
        ck = CACHE / f"{key}.json"
        if ck.exists() and (time.time() - ck.stat().st_mtime) < cache_hours * 3600:
            try:
                return json.loads(ck.read_text())
            except json.JSONDecodeError:
                pass

    last = None
    for attempt in range(retries):
        if limiter:
            limiter.wait()
        try:
            r = session().request(method, url, timeout=timeout, **kw)
            if r.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"HTTP {r.status_code}")
            r.raise_for_status()
            out = r.json()
            if ck:
                ck.write_text(json.dumps(out))
            return out
        except Exception as e:  # noqa: BLE001 - retry anything transient
            last = e
            if attempt < retries - 1:
                back = 2 ** attempt * 1.5
                log.debug("retry %s in %.1fs (%s)", url, back, e)
                time.sleep(back)
    raise RuntimeError(f"request failed after {retries} tries: {url}: {last}")


def request_text(url, *, limiter=None, retries=3, timeout=60, **kw):
    last = None
    for attempt in range(retries):
        if limiter:
            limiter.wait()
        try:
            r = session().get(url, timeout=timeout, **kw)
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt * 1.5)
    raise RuntimeError(f"request failed: {url}: {last}")


def _in_box(box, lat, lon):
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    return (box["south"] <= lat <= box["north"]
            and box["west"] <= lon <= box["east"])


def in_uk(lat, lon):
    """Inside the UK box - still what the blogs and gazetteer care about."""
    return _in_box(UK_BBOX, lat, lon)


def in_area(lat, lon):
    """Inside the configured collection region (the UK, or Europe)."""
    return _in_box(AREA_BBOX, lat, lon)


def since_date(days_back=None):
    days = CFG["days_back"] if days_back is None else days_back
    return date.today() - timedelta(days=days)


def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_date(value):
    """Best-effort date extraction -> 'YYYY-MM-DD' or None."""
    if not value:
        return None
    s = str(value).strip().replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s).date().isoformat()
    except ValueError:
        pass
    # RSS uses RFC 822 ("Tue, 06 Oct 2026 11:54:23 +0000").
    if "," in s[:5] or s[:3].isalpha():
        try:
            return parsedate_to_datetime(s).date().isoformat()
        except (TypeError, ValueError):
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:len(fmt)], fmt).date().isoformat()
        except ValueError:
            pass
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None
