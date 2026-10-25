"""Bluesky adapter.

Birders post sightings to Bluesky constantly, and unlike X it has a public
read API that needs no key and no account. The posts are prose, so this reuses
the county-blog machinery: the same capitalised-species-name rule, and the
same gazetteer - except that a post carries no county to constrain the lookup,
so the place has to be found in the text itself.

That makes these the least certain records in the project, and they are marked
accordingly: `precision='site'`, a low confidence, and a link back to the post
so any of them can be checked in one click. A post with no recognisable place
in it is discarded rather than guessed at.

X/Twitter has no equivalent: its search API is paid-only and returns 401
without a bearer token, so there is nothing to read.
"""
import re
from datetime import datetime, timezone

from ..config import CFG, UK_BBOX
from ..gazetteer import Gazetteer
from ..species import load as load_species
from ..util import RateLimiter, in_uk, iso_now, log, parse_date, request_json, since_date

# The public AppView. `public.api.bsky.app` is the documented host but refuses
# some networks; this one answers unauthenticated requests reliably.
SEARCH = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts"

# What to look for. Hashtags first, then the phrasings birders actually use.
QUERIES = (
    "#UKBirding", "#ukbirds", "#BirdsOfBluesky UK", "#BirdWatchingUK",
    "#NorfolkBirding", "#ScottishBirding", "#WelshBirding", "#YorkshireBirding",
    "#DevonBirding", "#KentBirding", "#SussexBirding", "#SuffolkBirding",
    "birding reservoir UK", "birding RSPB", "patch birding UK",
    "#nocmig UK", "birds NNR UK",
)

PER_QUERY = 100
_limiter = RateLimiter(1.2)   # unauthenticated: be gentle

# Posts that are plainly not a sighting report.
_SKIP = re.compile(r"(?i)\b(for sale|print|canvas|giveaway|sweepstake|"
                   r"follow me|giclee|merch)\b")


def _post_url(uri, handle):
    """at://did/app.bsky.feed.post/rkey -> a link a person can open."""
    rkey = uri.rsplit("/", 1)[-1] if uri else ""
    return f"https://bsky.app/profile/{handle}/post/{rkey}" if rkey else ""


def fetch(days_back=None, queries=None):
    idx = load_species()
    gaz = Gazetteer.load()
    from .blogs import SpeciesMatcher          # the same matcher the blogs use
    matcher = SpeciesMatcher(idx)

    cutoff = since_date(days_back)
    bbox = (UK_BBOX["south"], UK_BBOX["west"], UK_BBOX["north"], UK_BBOX["east"])
    rows = {}
    seen_posts = 0

    for q in (queries or QUERIES):
        # One page per query: the public AppView accepts the first request
        # but refuses a cursor without authentication, so paging is not
        # available. More queries is the way to get more coverage.
        for _ in range(1):
            params = {"q": q, "limit": PER_QUERY, "lang": "en"}
            try:
                data = request_json("GET", SEARCH, params=params,
                                    limiter=_limiter, timeout=60)
            except Exception as e:  # noqa: BLE001
                log.warning("bluesky: '%s' failed (%s)", q, e)
                break

            posts = data.get("posts") or []
            for post in posts:
                seen_posts += 1
                _read_post(post, matcher, idx, gaz, bbox, cutoff, rows)
            break

    log.info("bluesky: %d records from %d posts", len(rows), seen_posts)
    return list(rows.values())


def _read_post(post, matcher, idx, gaz, bbox, cutoff, rows):
    record = post.get("record") or {}
    text = (record.get("text") or "").strip()
    if not text or _SKIP.search(text):
        return

    day = parse_date(record.get("createdAt") or post.get("indexedAt"))
    if not day:
        return
    try:
        if datetime.fromisoformat(day).date() < cutoff:
            return
    except ValueError:
        return

    # Hashtags are where species names get mangled into one word, so the
    # matcher is run on the prose with the tags stripped out.
    prose = re.sub(r"#\w+", " ", text)
    found = matcher.find(prose)
    if not found:
        return

    place = gaz.find_in_text(prose, bbox)
    if not place or not in_uk(place["lat"], place["lon"]):
        return

    author = (post.get("author") or {})
    handle = author.get("handle") or ""
    url = _post_url(post.get("uri"), handle)
    uri_key = (post.get("uri") or url)[-32:]

    for key, count, _phrase in found:
        rec = idx.by_key.get(key)
        if rec is None:
            continue
        uid = f"bsky:{uri_key}:{key}"
        prev = rows.get(uid)
        if prev and (prev["count"] or 0) >= (count or 0):
            continue
        rows[uid] = {
            "uid": uid,
            "source": "bluesky",
            "common": rec["common"],
            "sci": rec["sci"],
            "species_key": key,
            "count": count,
            "obs_date": day,
            "obs_time": (record.get("createdAt") or "")[11:16] or None,
            "lat": place["lat"],
            "lon": place["lon"],
            "precision": "site",
            "site": place["name"],
            "region": None,
            "observer": f"@{handle}" if handle else None,
            "url": url,
            "confidence": None,
            "notable": 0,
            "extra": {"network": "bluesky",
                      "snippet": text[:220],
                      "geocoded_by": "post text",
                      "display_name": author.get("displayName")},
            "fetched_at": iso_now(),
        }
