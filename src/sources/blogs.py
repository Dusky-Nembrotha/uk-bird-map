"""County bird blog / news page adapter.

These pages are the richest source of UK local records and the only one with no
machine-readable format: a human writes "New Passage: 2 Mute Swan, c.130 Canada
Goose, 12 Shoveler". This module reads each blog's feed, splits posts into
lines, and walks the lines as word tokens looking for species names from the
British list, the count beside them, and the site heading they sit under.

Two deliberate constraints keep false positives down:

* A species name only counts if it is capitalised in the original text. Reports
  always capitalise bird names, so this is what stops the words "knot", "shag"
  and "swift" in ordinary prose being read as birds.
* Site names are resolved only within the blog's own county bounding box, and a
  record with no site it can place falls back to the blog's default location
  (an observatory's own site) or is dropped.

Records are marked `precision='site'` because a site centroid is the honest
resolution, and each carries the post URL so any record can be checked against
what the author actually wrote.
"""
import json
import re
import xml.etree.ElementTree as ET
from datetime import date, timedelta

from ..config import CFG
from ..gazetteer import Gazetteer, geocode_online
from ..species import load as load_species, norm
from ..util import RateLimiter, iso_now, log, parse_date, request_json, request_text, since_date

_limiter = RateLimiter(1.0)

# How far beyond the record window to still read posts: monthly
# round-up posts are edited for weeks after they are published.
POST_LOOKBACK_DAYS = 45

# Each blog: where to read it, where it covers, and how its posts are laid out.
#   strategy "sectioned"  - ALL-CAPS county headers and "Site:" sub-headings
#   strategy "title_site" - the post title names the site
#   strategy "prose"      - narrative text; sites found by scanning for names
#   strategy "site_lines" - a bare line naming the site, then its records
BLOGS = [
    {
        "key": "avon",
        "name": "Avon Birds",
        "page": "https://avonbirding.blogspot.com/",
        "feed": "https://avonbirding.blogspot.com/feeds/posts/default?alt=json",
        "region": "Avon",
        "county_hint": "Bristol",
        "bbox": (51.20, -3.10, 51.75, -2.20),
        "strategy": "sectioned",
    },
    {
        "key": "oxon",
        "name": "Oxon Birding Blog",
        "page": "https://oxonbirding.blogspot.com/",
        "feed": "https://oxonbirding.blogspot.com/feeds/posts/default?alt=json",
        "region": "Oxfordshire",
        "county_hint": "Oxfordshire",
        "bbox": (51.45, -1.75, 52.15, -0.90),
        "strategy": "title_site",
    },
    {
        "key": "dorset",
        "name": "Dorset Birds",
        "page": "https://dorsetbirds.blogspot.com/",
        "feed": "https://dorsetbirds.blogspot.com/feeds/posts/default?alt=json",
        "region": "Dorset",
        "county_hint": "Dorset",
        "bbox": (50.50, -3.00, 51.10, -1.55),
        "strategy": "prose",
    },
    {
        "key": "pembs",
        "name": "Pembrokeshire Birds",
        "page": "https://pembsbirds.blogspot.com/",
        "feed": "https://pembsbirds.blogspot.com/feeds/posts/default?alt=json",
        "region": "Pembrokeshire",
        "county_hint": "Pembrokeshire",
        "bbox": (51.55, -5.55, 52.15, -4.45),
        "strategy": "title_site",
    },
    {
        "key": "anglesey",
        "name": "Anglesey Bird News",
        "page": "https://angleseybirdnews.blogspot.com/",
        "feed": "https://angleseybirdnews.blogspot.com/feeds/posts/default?alt=json",
        "region": "Anglesey",
        "county_hint": "Anglesey",
        "bbox": (53.10, -4.80, 53.50, -4.00),
        "strategy": "prose",
    },
    {
        "key": "surrey",
        "name": "Surrey Bird Club",
        "page": "https://www.surreybirdclub.org.uk/",
        "feed": "https://www.surreybirdclub.org.uk/feed/",
        "region": "Surrey",
        "county_hint": "Surrey",
        "bbox": (51.05, -0.90, 51.50, 0.10),
        "strategy": "prose",
    },
    {
        "key": "northants",
        "name": "Northants Birds",
        "page": "https://northantsbirds.com/",
        "feed": "https://northantsbirds.com/feed/",
        "region": "Northamptonshire",
        "county_hint": "Northamptonshire",
        "bbox": (52.00, -1.40, 52.70, -0.30),
        "strategy": "prose",
    },
    {
        "key": "staffordshire",
        "name": "Staffordshire Bird News",
        "page": "https://staffordshirebirding.blogspot.com/",
        "feed": "https://staffordshirebirding.blogspot.com/feeds/posts/default?alt=json",
        "region": "Staffordshire",
        "county_hint": "Staffordshire",
        "bbox": (52.40, -2.60, 53.25, -1.55),
        "strategy": "site_lines",
    },
    {
        "key": "northantsbirding",
        "name": "Northamptonshire Birding",
        "page": "https://northamptonshirebirding.blogspot.com/",
        "feed": "https://northamptonshirebirding.blogspot.com/feeds/posts/default?alt=json",
        "region": "Northamptonshire",
        "county_hint": "Northamptonshire",
        "bbox": (52.00, -1.40, 52.70, -0.30),
        "strategy": "prose",
    },
    {
        "key": "portland",
        "name": "Portland Bird Observatory",
        "page": "https://portlandbirdobs.blogspot.com/",
        "feed": "https://portlandbirdobs.blogspot.com/feeds/posts/default?alt=json",
        "region": "Dorset",
        "county_hint": "Dorset",
        "bbox": (50.50, -2.60, 50.75, -2.30),
        "strategy": "prose",
        "default_site": {"name": "Portland Bill", "lat": 50.5167, "lon": -2.4553},
    },
    {
        "key": "dungeness",
        "name": "Dungeness Bird Observatory",
        "page": "https://dungenessbirdobs.blogspot.com/",
        "feed": "https://dungenessbirdobs.blogspot.com/feeds/posts/default?alt=json",
        "region": "Kent",
        "county_hint": "Kent",
        "bbox": (50.84, 0.50, 51.20, 1.45),
        "strategy": "prose",
        "default_site": {"name": "Dungeness", "lat": 50.9188, "lon": 0.9640},
    },
    {
        "key": "hilbre",
        "name": "Hilbre Bird Observatory",
        "page": "https://hilbrebirdobs.blogspot.com/",
        "feed": "https://hilbrebirdobs.blogspot.com/feeds/posts/default?alt=json",
        "region": "Wirral",
        "county_hint": "Merseyside",
        "bbox": (53.26, -3.45, 53.50, -2.95),
        "strategy": "prose",
        "default_site": {"name": "Hilbre Island", "lat": 53.3797, "lon": -3.2258},
    },
    {
        "key": "walney",
        "name": "Walney Bird Observatory",
        "page": "https://walneybo.blogspot.com/",
        "feed": "https://walneybo.blogspot.com/feeds/posts/default?alt=json",
        "region": "Cumbria",
        "county_hint": "Cumbria",
        "bbox": (53.92, -3.45, 54.25, -2.95),
        "strategy": "prose",
        "default_site": {"name": "South Walney", "lat": 54.0433, "lon": -3.2122},
    },
    {
        "key": "glos",
        "name": "The Gloster Birder",
        "page": "https://theglosterbirder.co.uk/",
        "feed": "https://theglosterbirder.co.uk/feed/",
        "region": "Gloucestershire", "county_hint": "Gloucestershire",
        "bbox": (51.55, -2.70, 52.12, -1.60), "strategy": "prose",
    },
    {
        "key": "cornwall",
        "name": "Cornwall Birds (CBWPS)",
        "page": "https://cbwps.org.uk/recent-sightings/",
        # The plain /feed/ carries club news; the sightings are a custom post type.
        "feed": "https://cbwps.org.uk/?feed=rss2&post_type=recent-sighting",
        "region": "Cornwall", "county_hint": "Cornwall",
        "bbox": (49.95, -5.75, 50.95, -4.15), "strategy": "sectioned",
    },
    {
        "key": "cheshire",
        "name": "Cheshire & Wirral Bird News",
        "page": "https://saturdaycatbird.blogspot.com/",
        "feed": "https://saturdaycatbird.blogspot.com/feeds/posts/default?alt=json",
        "region": "Cheshire", "county_hint": "Cheshire",
        "bbox": (52.95, -3.30, 53.45, -1.98), "strategy": "site_lines",
    },
    {
        "key": "dawlish",
        "name": "Dawlish Warren Recording Area",
        "page": "https://dawlishwarren.blogspot.com/",
        "feed": "https://dawlishwarren.blogspot.com/feeds/posts/default?alt=json",
        "region": "Devon", "county_hint": "Devon",
        "bbox": (50.20, -4.70, 51.25, -2.90), "strategy": "prose",
        "default_site": {"name": "Dawlish Warren", "lat": 50.6080, "lon": -3.4400},
    },
    {
        "key": "holme",
        "name": "Holme Bird Observatory",
        "page": "https://noa.org.uk/blog/",
        "feed": "https://noa.org.uk/feed/",
        "region": "Norfolk", "county_hint": "Norfolk",
        "bbox": (52.40, 0.20, 53.00, 1.80), "strategy": "prose",
        "default_site": {"name": "Holme Bird Observatory", "lat": 52.9739, "lon": 0.5497},
    },
    {
        "key": "landguard",
        "name": "Landguard Bird Observatory",
        "page": "https://lbobs.blogspot.com/",
        "feed": "https://lbobs.blogspot.com/feeds/posts/default?alt=json",
        "region": "Suffolk", "county_hint": "Suffolk",
        "bbox": (51.90, 0.35, 52.55, 1.80), "strategy": "prose",
        "default_site": {"name": "Landguard Point", "lat": 51.9375, "lon": 1.3350},
    },
    {
        "key": "selsey",
        "name": "Birding the Selsey Peninsula",
        "page": "https://selseybirder.blogspot.com/",
        "feed": "https://selseybirder.blogspot.com/feeds/posts/default?alt=json",
        "region": "West Sussex", "county_hint": "West Sussex",
        "bbox": (50.70, -1.00, 51.10, 0.00), "strategy": "sectioned",
        "default_site": {"name": "Selsey Bill", "lat": 50.7236, "lon": -0.7920},
    },
    {
        "key": "heysham",
        "name": "Heysham Bird Observatory",
        "page": "https://heyshamobservatory.blogspot.com/",
        "feed": "https://heyshamobservatory.blogspot.com/feeds/posts/default?alt=json",
        "region": "Lancashire", "county_hint": "Lancashire",
        "bbox": (53.55, -3.10, 54.25, -2.40), "strategy": "site_lines",
        "default_site": {"name": "Heysham Nature Reserve", "lat": 54.0330, "lon": -2.9070},
    },
    {
        "key": "bradford",
        "name": "Birding in Bradford",
        "page": "https://bradfordbirders.blogspot.com/",
        "feed": "https://bradfordbirders.blogspot.com/feeds/posts/default?alt=json",
        "region": "West Yorkshire", "county_hint": "West Yorkshire",
        "bbox": (53.70, -2.10, 53.95, -1.60), "strategy": "sectioned",
    },
    {
        "key": "filey",
        "name": "Filey Brigg Ornithological Group",
        "page": "https://www.fbog.co.uk/",
        "feed": "https://www.fbog.co.uk/feed/",
        "region": "North Yorkshire", "county_hint": "North Yorkshire",
        # Monthly round-ups only, published in the first days of the month.
        "bbox": (54.15, -0.40, 54.30, -0.15), "strategy": "prose",
        "default_site": {"name": "Filey Brigg", "lat": 54.2150, "lon": -0.2660},
    },
    {
        "key": "ogston",
        "name": "Ogston Bird Club",
        "page": "https://www.ogstonbirdclub.co.uk/",
        "feed": "https://www.ogstonbirdclub.co.uk/feed/",
        "region": "Derbyshire", "county_hint": "Derbyshire",
        "bbox": (52.85, -2.00, 53.55, -1.20), "strategy": "prose",
        "default_site": {"name": "Ogston Reservoir", "lat": 53.13782, "lon": -1.43913},
    },
    {
        "key": "cotswoldwp",
        "name": "Cotswold Water Park Bird News",
        "page": "https://cotswoldwaterpark.wordpress.com/",
        "feed": "https://cotswoldwaterpark.wordpress.com/feed/",
        "region": "Cotswold Water Park", "county_hint": "Wiltshire",
        "bbox": (51.55, -2.05, 51.75, -1.75), "strategy": "prose",
    },
    {
        "key": "cambs",
        "name": "Cambridgeshire Bird Club",
        "page": "https://cambsbirdclub.blogspot.com/",
        "feed": "https://cambsbirdclub.blogspot.com/feeds/posts/default?alt=json",
        "region": "Cambridgeshire", "county_hint": "Cambridgeshire",
        "bbox": (52.00, -0.55, 52.75, 0.55), "strategy": "prose",
    },
    {
        "key": "scilly",
        "name": "Isles of Scilly Bird Sightings",
        "page": "https://www.scilly-birding.co.uk/",
        "feed": "https://www.scilly-birding.co.uk/feed/",
        "region": "Isles of Scilly", "county_hint": "Isles of Scilly",
        "bbox": (49.85, -6.45, 49.99, -6.24), "strategy": "prose",
    },
    {
        "key": "glamorgan",
        "name": "Glamorgan Bird Club",
        "page": "https://www.glamorganbirds.org.uk/",
        "feed": "https://www.glamorganbirds.org.uk/feed/",
        "region": "Glamorgan", "county_hint": "Glamorgan",
        "bbox": (51.35, -4.35, 51.75, -3.10), "strategy": "title_site",
    },
    {
        "key": "montgomery",
        "name": "Montgomeryshire Bird Blog",
        "page": "https://montgomerybirdblog.blogspot.com/",
        "feed": "https://montgomerybirdblog.blogspot.com/feeds/posts/default?alt=json",
        "region": "Montgomeryshire", "county_hint": "Powys",
        "bbox": (52.30, -3.90, 52.90, -2.95), "strategy": "prose",
    },
    {
        "key": "radnor",
        "name": "Radnor Bird Blog",
        "page": "https://radnorshirebirds.wordpress.com/",
        "feed": "https://radnorshirebirds.wordpress.com/feed/",
        "region": "Radnorshire", "county_hint": "Powys",
        "bbox": (52.05, -3.60, 52.45, -2.95), "strategy": "prose",
    },
    {
        "key": "argyll",
        "name": "Argyll Bird Club",
        "page": "https://www.argyllbirdclub.org/",
        "feed": "https://www.argyllbirdclub.org/feed/",
        "region": "Argyll", "county_hint": "Argyll and Bute",
        "bbox": (55.30, -7.10, 56.90, -4.60), "strategy": "prose",
    },
    {
        "key": "dumfries",
        "name": "Dumfries & Galloway Bird News",
        "page": "https://dumfriesgallowaybirdnews.blogspot.com/",
        "feed": "https://dumfriesgallowaybirdnews.blogspot.com/feeds/posts/default?alt=json",
        "region": "Dumfries and Galloway", "county_hint": "Dumfries and Galloway",
        "bbox": (54.63, -5.20, 55.40, -3.00), "strategy": "prose",
    },
    {
        "key": "shetland",
        "name": "Shetland Bird News",
        "page": "https://pennyshotbirdingandlife.blogspot.com/",
        "feed": "https://pennyshotbirdingandlife.blogspot.com/feeds/posts/default?alt=json",
        "region": "Shetland", "county_hint": "Shetland",
        "bbox": (59.84, -1.80, 60.86, -0.70), "strategy": "prose",
    },
    {
        "key": "nibirds",
        "name": "Northern Ireland Bird News",
        "page": "https://nibirds.blogspot.com/",
        "feed": "https://nibirds.blogspot.com/feeds/posts/default?alt=json",
        "region": "Northern Ireland", "county_hint": "Northern Ireland",
        "bbox": (54.00, -8.20, 55.35, -5.40), "strategy": "prose",
    },
    {
        "key": "gibpoint",
        "name": "Gibraltar Point Bird Observatory",
        "page": "https://gibraltarpointbirdobservatory.blogspot.com/",
        "feed": "https://gibraltarpointbirdobservatory.blogspot.com/"
                "feeds/posts/default?alt=json",
        "region": "Lincolnshire",
        "county_hint": "Lincolnshire",
        "bbox": (52.90, 0.10, 53.20, 0.45),
        "strategy": "prose",
        "default_site": {"name": "Gibraltar Point NNR", "lat": 53.0858, "lon": 0.3375},
    },
]

# ---------------------------------------------------------------- text pieces

_BLOCK_END = re.compile(r"(?i)</?(?:br|div|p|li|tr|h[1-6])[^>]*>")
_TAG = re.compile(r"<[^>]+>")
_ENTITIES = {"&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'",
             "&lt;": "<", "&gt;": ">", "&rsquo;": "'", "&ldquo;": '"',
             "&rdquo;": '"', "&ndash;": "-", "&mdash;": "-"}

_WORD = re.compile(r"[A-Za-z][A-Za-z'’\-]*|\d[\d,.]*")
_COUNT = re.compile(r"^(?:c|c\.|ca|ca\.|approx|approx\.|~|>|<|\+)?\s*"
                    r"(\d{1,5})(?:\+|s)?$")
_ARTICLE_ONE = {"a", "an", "one", "single", "lone"}
_MAX_NGRAM = 5

# Lines that are headings or chatter rather than records.
_SKIP_LINE = re.compile(
    r"(?i)^\s*(no reports?|nothing (?:to )?report|"
    r"(?:photos?|pictures?|images?) ?:?|posted by|labels?:|"
    r"temp(?:erature)? |wind |weather)")


_TAG_SCAN = re.compile(r"<(/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>")
_EMPH_TAGS = {"b", "strong", "u", "h1", "h2", "h3", "h4", "h5", "h6"}
_BREAK_TAGS = {"br", "div", "p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
               "table", "td", "blockquote"}


def _unescape(text):
    for ent, rep in _ENTITIES.items():
        text = text.replace(ent, rep)
    return re.sub(r"&#\d+;", " ", text)


def html_to_lines(html):
    """Blogger HTML -> [(text, is_heading)], keeping the author's line breaks.

    Site and county headings on these blogs are bold and/or underlined, and
    that formatting is the only reliable signal of what is a heading versus a
    line of records. Emphasis depth is tracked across the whole document
    rather than matched per block, because these editors habitually write
    `<b><u>Site:<br /></u></b>records...` - the break falls inside the tags.
    """
    out = []
    plain_parts, emph_parts = [], []
    depth = 0
    pos = 0

    def flush():
        text = re.sub(r"[ \t ]+", " ", "".join(plain_parts)).strip()
        if text:
            emph = re.sub(r"[ \t ]+", " ", "".join(emph_parts)).strip()
            ratio = len(norm(emph)) / max(len(norm(text)), 1)
            out.append((text, bool(emph) and ratio > 0.7 and len(text) <= 80))
        plain_parts.clear()
        emph_parts.clear()

    for m in _TAG_SCAN.finditer(html or ""):
        chunk = _unescape((html or "")[pos:m.start()])
        if chunk:
            plain_parts.append(chunk)
            if depth > 0:
                emph_parts.append(chunk)
        pos = m.end()
        closing, tag = bool(m.group(1)), m.group(2).lower()
        if tag in _EMPH_TAGS:
            depth = max(0, depth - 1) if closing else depth + 1
        if tag in _BREAK_TAGS:
            flush()
    tail = _unescape((html or "")[pos:])
    if tail:
        plain_parts.append(tail)
        if depth > 0:
            emph_parts.append(tail)
    flush()
    return out


class SpeciesMatcher:
    """Finds capitalised British bird names in a line of prose."""

    def __init__(self, idx):
        self.idx = idx
        self.alias = {}
        for rec in idx.by_key.values():
            for a in rec.get("aliases") or []:
                words = a.split()
                # Three letters is the floor: it admits Jay, and the
                # capitalisation rule is what keeps ordinary words out.
                if len(words) > _MAX_NGRAM or len(a) < 3:
                    continue
                # One-word names are the risky ones ("knot", "shag"), and are
                # allowed only because a capitalisation check follows.
                self.alias.setdefault(a, rec["species_key"])

    def find(self, line):
        """Yield (species_key, count, matched_text) for each species in line."""
        tokens = [(m.group(0), m.start(), m.end()) for m in _WORD.finditer(line)]
        n = len(tokens)
        used = [False] * n
        found = []
        i = 0
        while i < n:
            if used[i]:
                i += 1
                continue
            hit = None
            for size in range(min(_MAX_NGRAM, n - i), 0, -1):
                span = tokens[i:i + size]
                if any(used[i + k] for k in range(size)):
                    continue
                # Bird names are capitalised in reports; ordinary words are not.
                if not span[0][0][:1].isupper():
                    continue
                phrase = " ".join(t[0] for t in span)
                key = self.alias.get(norm(phrase))
                if key is None:
                    key = self.alias.get(norm(re.sub(r"s$", "", phrase)))
                if key:
                    hit = (key, i, size, phrase)
                    break
            if hit is None:
                i += 1
                continue
            key, start, size, phrase = hit
            for k in range(size):
                used[start + k] = True
            found.append((key, self._count_near(line, tokens, start, size, used),
                          phrase))
            i = start + size
        return found

    # Suffixes birders hang off a number: 10x Teal, 1w Little Gull (first
    # winter), 2cy Herring Gull (second calendar year).
    _COUNT_SUFFIX = {"x", "w", "s", "cy", "j", "m", "f", "ad", "imm", "juv"}

    @staticmethod
    def _count_near(line, tokens, start, size, used):
        """A count immediately before the name, else just after it.

        A count only belongs to a species if nothing separates them. Without
        that check "Goldeneye, 4x Ringed Plover" gives the Goldeneye a count
        of four, which is the Ringed Plover's.
        """
        def separated(a_end, b_start):
            return bool(re.search(r"[,;:/|&]|\band\b",
                                  line[a_end:b_start], re.I))

        before = start
        # Step back over a suffix like the x in "10x" or the w in "1w".
        if (before > 1 and not used[before - 1]
                and tokens[before - 1][0].lower() in SpeciesMatcher._COUNT_SUFFIX):
            before -= 1
        if before > 0 and not used[before - 1]:
            prev = tokens[before - 1]
            if not separated(prev[2], tokens[start][1]):
                m = _COUNT.match(prev[0].replace(",", ""))
                if m:
                    return int(m.group(1))
                if prev[0].lower() in _ARTICLE_ONE:
                    return 1
                if before > 1 and prev[0].lower() in {"of", "more"}:
                    m = _COUNT.match(tokens[before - 2][0].replace(",", ""))
                    if m:
                        return int(m.group(1))

        after = start + size
        if after < len(tokens) and not used[after]:
            nxt = tokens[after]
            if not separated(tokens[start + size - 1][2], nxt[1]):
                m = _COUNT.match(nxt[0].replace(",", ""))
                if m:
                    return int(m.group(1))
        return None


# ---------------------------------------------------------------- feed reading

def _fetch_feed(blog, max_posts=40):
    """Return [{id, title, html, date, url}] newest first, from any feed type."""
    feed = blog["feed"]
    try:
        if "alt=json" in feed:
            data = request_json("GET", feed, limiter=_limiter,
                                params={"max-results": max_posts}, timeout=90)
            out = []
            for e in (data.get("feed") or {}).get("entry", []) or []:
                link = next((l["href"] for l in e.get("link", [])
                             if l.get("rel") == "alternate"), blog["page"])
                out.append({
                    "id": (e.get("id") or {}).get("$t", ""),
                    "title": (e.get("title") or {}).get("$t", ""),
                    "html": (e.get("content") or e.get("summary")
                             or {}).get("$t", ""),
                    "date": parse_date((e.get("published") or {}).get("$t")),
                    "url": link,
                })
            return out
        return _fetch_xml_feed(blog, max_posts)
    except Exception as e:  # noqa: BLE001
        log.warning("blogs: %s feed failed (%s)", blog["key"], e)
        return []


def _fetch_xml_feed(blog, max_posts):
    """RSS 2.0 / Atom, for blogs that are not on Blogger."""
    text = request_text(blog["feed"], limiter=_limiter, timeout=90)
    root = ET.fromstring(text.encode("utf-8", "replace"))
    ns = {"atom": "http://www.w3.org/2005/Atom",
          "content": "http://purl.org/rss/1.0/modules/content/"}
    out = []
    items = root.findall(".//item") or root.findall(".//atom:entry", ns)
    for it in items[:max_posts]:
        def pick(*paths):
            for p in paths:
                el = it.find(p, ns)
                if el is not None and (el.text or "").strip():
                    return el.text
            return ""
        link = pick("link", "atom:link/[@rel='alternate']")
        if not link:
            el = it.find("atom:link", ns)
            link = (el.get("href") if el is not None else blog["page"])
        out.append({
            "id": pick("guid", "atom:id") or link,
            "title": pick("title", "atom:title"),
            "html": pick("content:encoded", "description", "atom:content",
                         "atom:summary"),
            "date": parse_date(pick("pubDate", "atom:published", "atom:updated")),
            "url": link,
        })
    return out


# ---------------------------------------------------------------- post parsing

_CAPS_HEADER = re.compile(r"^[A-Z][A-Z0-9 &'\-/\.]{3,40}$")
_TITLE_DATE = re.compile(
    r"(?i)"
    r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|"
    r"nov|dec)[a-z]*\b\.?\s*\d{0,4}"
    r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b\.?\s*"
    r"\d{1,2}(?:st|nd|rd|th)?\b"
    r"|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b"
    r"|\b(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b"
    r"|\b\d{1,2}(?:st|nd|rd|th)\b")


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun",
     "jul", "aug", "sep", "oct", "nov", "dec"])}

_WEEKDAY_DAY = re.compile(
    r"(?i)^\s*(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)[a-z]*\.?\s*"
    r"(\d{1,2})(?:st|nd|rd|th)?\s*[:.\-]?\s*$")
_MONTH_DAY = re.compile(
    r"(?i)^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+"
    r"(\d{1,2})(?:st|nd|rd|th)?\b")
_DAY_MONTH = re.compile(
    r"(?i)^\s*(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b")


def _resolve_day(day, month, max_back=60):
    """Most recent date on or before today matching day (and month).

    Several blogs post a month of records in one entry and date each day
    inside the text ("Wednesday 21st", "October 23rd"); those entries belong
    to their own day. Resolution is anchored on today rather than on the
    post's own date, because these posts are edited daily while the feed keeps
    reporting the date the post was first published.
    """
    today = date.today()
    for back in range(0, max_back + 1):
        cand = today - timedelta(days=back)
        if cand.day != day:
            continue
        if month is not None and cand.month != month:
            continue
        return cand.isoformat()
    return None


def _date_in_line(line):
    """A date written at the start of a line, or None."""
    if len(line) > 90:
        return None
    m = _WEEKDAY_DAY.match(line)
    if m:
        return _resolve_day(int(m.group(1)), None)
    m = _MONTH_DAY.match(line)
    if m:
        return _resolve_day(int(m.group(2)), _MONTHS[m.group(1).lower()[:3]])
    m = _DAY_MONTH.match(line)
    if m:
        return _resolve_day(int(m.group(1)), _MONTHS[m.group(2).lower()[:3]])
    return None


def _title_site(title):
    """Strip dates and weekday names from a post title to leave the site."""
    t = _TITLE_DATE.sub(" ", title or "")
    t = re.sub(r"[–—\-,]+\s*$", " ", t)
    t = re.sub(r"\s+", " ", t).strip(" -,–—:")
    return t if len(t) >= 4 else ""


class BlogParser:
    def __init__(self, blog, idx, gaz, matcher):
        self.blog = blog
        self.idx = idx
        self.gaz = gaz
        self.matcher = matcher
        self.bbox = blog["bbox"]
        self._site_names = None

    def site_names(self):
        """Gazetteer names inside this blog's county, longest first."""
        if self._site_names is None:
            self._site_names = self.gaz.names_in_box(self.bbox, min_len=6)
        return self._site_names

    def resolve_site(self, raw, allow_online=False):
        """Site name -> coordinates, within this county only."""
        raw = (raw or "").strip().rstrip(":").strip()
        if len(raw) < 4:
            return None
        hit = self.gaz.lookup(raw, self.bbox)
        if hit:
            return {"name": hit["name"], "lat": hit["lat"], "lon": hit["lon"],
                    "how": hit.get("origin") or hit.get("kind")}
        # Nominatim is only worth asking about things that read like a place
        # name, and only for text the author marked up as a heading.
        if (allow_online and len(raw.split()) <= 6
                and CFG.get("blogs", {}).get("online_geocode", True)):
            hit = geocode_online(raw, self.blog.get("county_hint"), self.bbox)
            if hit:
                return {"name": hit["name"], "lat": hit["lat"],
                        "lon": hit["lon"], "how": "nominatim"}
        return None

    def find_site_in_line(self, line):
        """A known site named anywhere in a line of prose."""
        low = norm(line)
        if len(low) < 6:
            return None
        for key, entry in self.site_names():
            if key in low:
                return {"name": entry["name"], "lat": entry["lat"],
                        "lon": entry["lon"], "how": "prose"}
        return None

    def parse_post(self, post):
        """Yield record dicts for one post."""
        lines = html_to_lines(post["html"])
        strategy = self.blog["strategy"]
        default_site = self.blog.get("default_site")
        if default_site:
            default_site = dict(default_site, how="blog_default")

        title_site = None
        if strategy == "title_site":
            title_site = self.resolve_site(_title_site(post["title"]),
                                           allow_online=True)
        site = title_site or default_site

        records = {}
        section = None
        cur_date = post["date"]

        for line, is_heading in lines:
            if _SKIP_LINE.match(line):
                continue

            # "Wednesday 21st" / "October 23rd" re-dates everything below it.
            in_line_date = _date_in_line(line)
            if in_line_date:
                cur_date = in_line_date
                if len(line) <= 30:
                    continue

            # An ALL-CAPS line is a county/area heading, not a record.
            if (is_heading and _CAPS_HEADER.match(line)
                    and not any(ch.isdigit() for ch in line)):
                section = line.title()
                hit = self.resolve_site(line)
                site = hit or title_site or default_site
                continue

            body = line
            if is_heading:
                head, _, rest = line.partition(":")
                # "Snuff Mills (Frome Valley Walkway):" is a heading;
                # "Rock Pipit: 2 on the causeway" is a record in bold.
                if not self.matcher.find(head):
                    hit = self.resolve_site(head, allow_online=True)
                    # A heading that cannot be placed must not inherit the
                    # previous site, or its records land in the wrong place.
                    site = hit or title_site or default_site
                    body = rest.strip()
            elif strategy != "prose":
                # Several counties write "Site - records" rather than
                # "Site: records", so both separators are tried.
                head, sep, rest = line.partition(":")
                if not sep:
                    m = re.search(r"\s+[-\u2013\u2014]\s+", line)
                    if m and m.start() <= 60:
                        head, sep, rest = line[:m.start()], "-", line[m.end():]
                if sep and len(head) <= 60 and not self.matcher.find(head):
                    # An inline "Site: records" head is as much a place name as
                    # a bold heading is, so it gets the same online fallback.
                    hit = self.resolve_site(head, allow_online=True)
                    if hit:
                        site = hit
                        body = rest.strip()

            if not body:
                continue

            line_site = site
            if strategy == "prose":
                found_here = self.find_site_in_line(body)
                if found_here:
                    line_site = found_here
                    site = found_here

            for key, count, phrase in self.matcher.find(body):
                rec = self.idx.by_key.get(key)
                if rec is None or line_site is None:
                    continue
                uid = (f"blog:{self.blog['key']}:{post['id'][-24:]}:{cur_date}:"
                       f"{norm(line_site['name'])[:40]}:{key}")
                prev = records.get(uid)
                if prev and (prev["count"] or 0) >= (count or 0):
                    continue
                records[uid] = {
                    "uid": uid,
                    "source": "blog",
                    "common": rec["common"],
                    "sci": rec["sci"],
                    "species_key": key,
                    "count": count,
                    "obs_date": cur_date,
                    "obs_time": None,
                    "lat": line_site["lat"],
                    "lon": line_site["lon"],
                    "precision": "site",
                    "site": line_site["name"],
                    "region": section or self.blog["region"],
                    "observer": self.blog["name"],
                    "url": post["url"],
                    "confidence": None,
                    "notable": 0,
                    "extra": {"blog": self.blog["key"],
                              "blog_name": self.blog["name"],
                              "post_title": post["title"][:120],
                              "matched_text": phrase,
                              "snippet": body[:200],
                              "geocoded_by": line_site.get("how")},
                    "fetched_at": iso_now(),
                }
        return list(records.values())


def fetch(days_back=None, max_posts=40, only=None):
    idx = load_species()
    gaz = Gazetteer.load()
    matcher = SpeciesMatcher(idx)
    cutoff = since_date(days_back)
    post_cutoff = cutoff - timedelta(days=POST_LOOKBACK_DAYS)
    today = date.today().isoformat()
    rows = {}

    for blog in BLOGS:
        if only and blog["key"] not in only:
            continue
        posts = _fetch_feed(blog, max_posts=max_posts)
        parser = BlogParser(blog, idx, gaz, matcher)
        kept = used_posts = 0
        for post in posts:
            if not post.get("date"):
                continue
            if date.fromisoformat(post["date"]) < post_cutoff:
                continue
            used_posts += 1
            for r in parser.parse_post(post):
                # In-post dates mean a post can carry records from several
                # days, so the window is applied per record.
                if not r["obs_date"] or r["obs_date"] < cutoff.isoformat():
                    continue
                if r["obs_date"] > today:
                    continue
                rows[r["uid"]] = r
                kept += 1
        log.info("blogs: %-10s %2d posts in window -> %4d records",
                 blog["key"], used_posts, kept)

    log.info("blogs: %d records from %d blogs", len(rows),
             len(only or BLOGS))
    return list(rows.values())
