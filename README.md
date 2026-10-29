# UK Bird Map

Recent bird records from across Europe, gathered from national APIs and county
birding blogs — shown as a living animation you can scrub through, frame on any
region, and render to video.

## Quick start

```bash
pip install -r requirements.txt     # requests + flask
./run.sh                            # fetch everything, then serve
```

- **Animation view** (the main page) — <http://localhost:8777/>
- **Tile map** — <http://localhost:8777/map.html>

To re-serve without re-fetching: `./run.sh --serve-only`.

For video export you also need ffmpeg: `sudo apt install ffmpeg`.

---

## Region

`config.json` has a `region`: `"europe"` (the default) or `"uk"`. Europe spans
25°W–45°E and 34°N–72°N; the UK setting is a far leaner dataset if you only
care about Britain. County blogs are UK-only either way.

## Where the records come from

| Source | What you get | Typical | Key |
|---|---|---|---|
| **eBird** | Birders' checklists: precise coordinates, counts, observer, plus everything flagged notable or rare | ~14,500 | free key |
| **BirdWeather** | BirdNET acoustic detections, aggregated per recorder per species | ~138,000 | none |
| **iNaturalist** | Photographed and recorded observations, mostly research-grade | ~9,700 | none |
| **County blogs** | Local sightings pages parsed into records and geocoded — **35 feeds** | ~8,700 | none |
| **County recorders** | Kent OS and Sussex OS, which publish a *position* with every record | ~190 | none |
| **Bluesky** | Birders' public posts, species and place parsed from the text | ~450 | none |
| **GBIF** | Datasets the others don't carry — chiefly the Birda app — on a two-week publication lag, so it gets a 30-day window of its own | ~37,000 | none |

About **90,000 records** across ~425 species: a fortnight from the live
sources, plus GBIF's slower-arriving month.

### The eBird key

eBird needs a free key — 30 seconds at <https://ebird.org/api/keygen>. Put it in
`config.json` (copy `config.example.json`), or set `EBIRD_API_TOKEN` in the
environment. Everything else works without one, but you lose the best source
and the hotspot gazetteer that places blog reports.

---

## The map

- **Satellite backdrop and glowing species colours** by default, so the map
  reads like the studio's clips. Backdrops: satellite, plain dark/light,
  street, terrain, ocean floor. Colour the records by species, recency,
  source, or a single tone; glow can be turned off for a flatter look.
- **A hue per species.** Four hundred species is far past what any
  colourblind-safe categorical set can carry, so those hues are decorative —
  identity comes from the pin, the legend and the species list, never the
  colour alone. The other three colour modes stay analytically honest.
- **The sidebar follows the map.** "Most reported" counts only what is in the
  current viewport, with a photo for each species, and says whether it is
  showing "in view" or "across the UK".
- **Zoom into one place and it describes it** — records, species, latest date,
  largest count, who reported it and over what span.
- **Type-ahead species search.** Start typing and matches appear ranked by
  word-start hit then abundance, with photo, scientific name and count. Arrow
  keys to move, Enter to choose. Scientific names work too.
- **Marker area is flock size**, so 200 Starlings reads as 200 Starlings.
  Acoustic records are excluded from that scale: their "count" is detections at
  a microphone, not birds.
- **Rare and unusual records** carry a red ring and a ★.
- Filter by date, source and species; search any species; every pin links back
  to the original record.
- "Show as a table" gives a readable table of whatever is on screen.
- Dark and light themes. The view, filters and theme all live in the URL, so
  any view can be bookmarked or shared.

### On a phone

The map fills the screen and the filters live in a bottom sheet. The collapsed
sheet shows the live count, so it is useful shut; tap or drag the handle to
pull it up. Picking a species closes the sheet automatically, and so does
opening a record, because both mean "show me the map".

The studio puts the preview at the top and pins **Render** to the bottom, so
neither needs hunting for. Rendering on a phone works but is slow — a 30-second
clip is 900 frames — so it is worth setting a smaller shape (720) first.

Reach it from another device on your network at `http://<pi-address>:8777/`;
`localhost` will not work from a phone.

### Reading the records honestly

Not every record means the same thing, and each popup says which it is:

- **eBird / iNaturalist** — observations by a person, usually an exact
  position. iNaturalist blurs locations for sensitive species; those are marked.
- **BirdWeather** — machine identifications from sound, aggregated per recorder
  over the window. A garden box logging 4,324 Robin detections is one bird
  singing a lot.

  Its aggregate endpoint carries **no confidence information at all** — the
  `averageProbability` field is always null and `topSpecies` takes no
  confidence argument. Filtering by certainty therefore means reading the raw
  detections feed and folding it down here, which is what
  `birdweather.high_confidence` does: every detection at or above
  `min_confidence` (0.8), one row per recorder per species. That is ~240,000
  detections a day for the UK, so it costs a few hundred requests and several
  minutes. Across Europe it is ~900,000 a day, so the station aggregate is used
  instead and the threshold does not apply — the log says so when it happens.
- **County blogs** — parsed from prose and pinned to the *centre of the named
  place*. Every one links to the post it came from.

"Only exact locations" drops everything that isn't a precise fix.

### Marks

**Map options → Marks** swaps how the records are drawn. The default is the
grouped discs; the six alternatives come from the design study in
`web/mockups/`, ported to a Leaflet canvas layer in `web/treatments.js`.

| Marks | What it shows |
|---|---|
| **Grouped discs** | the original clusters, with a count in each |
| **Hex density field** | equal-area cells, quantile-stepped — the count belongs to the ground, not the zoom |
| **Density as relief** | a kernel surface cut into bands, isoline on each break |
| **The swell** | bands of latitude as ridges, near occluding far |
| **One mark per record** | no aggregation; waders, wildfowl and raptors by hue |
| **The recording network** | ground nearest each site — the observers, not the birds |
| **Rarities lit up** | notable records lit, the rest left as grey texture |
| **Species richness** | distinct species per cell, not records — one long checklist stops lighting a cell |
| **Site rosettes** | one spoke per species at that exact coordinate, ordered by group |
| **Coveys** | each record scattered inside a disc around its own point, so a stack reads as a stack |

The last three exist because the first six do not address the shape of this
data. 72% of records share a coordinate with another record and 7% of the
points carry 60% of the records — one eBird checklist is forty species at one
lat/lon, and Landguard Point is 419 records and 106 species on a single pixel.
Spread that over a hex grid and it is one bright cell.

The treatments draw to one canvas with no hit targets of its own, so clicking
the map opens everything logged at that coordinate — the whole stack, via the
same summary the clusters use — rather than a marker's own popup. Colour, glow and grouping belong to the discs and are disabled while a
treatment is showing. The choice is kept in the URL (`#view=hex`).

---

## The animation view

The main page. Pick a bird, a week and a frame; watch it play, then render it
to MP4 if you want to keep it.

**Suggested clips.** The app compares the last seven days against the seven
before and offers the species whose reporting rate has moved most — in late
October that is the thrushes arriving. One click sets the species and the week.

**Several species at once.** The species box is a multi-select: type to search,
pick as many as you like, and each appears as a chip with its photograph. The
selected birds are drawn into the clip itself, pictured beside the title.

**A settings drawer.** Sources, frame rate, file format, hours shown, the
world's layers, mark styling and captions all live behind the gear, so the
panel itself stays down to the handful of choices a clip actually needs.

**Most reported in view** lists what is in the current frame, with photographs,
and clicking a row adds it to the selection.

> Redwing, last two weeks, 30 seconds at 30 fps → 900 frames, each covering
> about 24 minutes of real time.

It draws its own world rather than using map tiles, so every frame is
deterministic — nothing loads mid-render, and the video carries no tile
watermark. Rendering happens on your machine; nothing is uploaded anywhere.

**Area** — ten region presets (Britain & Ireland, Scotland, Wales, the
Midlands, South West, East Anglia and so on), or frame it yourself: scroll to
zoom and drag the preview. The **Make an animation** link on the map carries
whatever you were looking at straight over, along with the species and dates.
Records outside the frame are neither drawn nor counted, so the on-screen
tally always describes what the viewer can actually see.

**Backdrops** — four drawn worlds (from orbit, ink, deep teal, slate) plus real
map tiles: dark, light, satellite, terrain and ocean floor. Tiles are fetched
once and baked into an offscreen canvas before rendering starts, so frames stay
deterministic and nothing arrives mid-clip.

**Hours shown** — recording effort is overwhelmingly diurnal, so a clip running
through every hour pulses once a day: a surge at dawn, nothing overnight. That
is when people are looking, not when birds are about. *Daylight only* skips the
dark hours so the clip runs smoothly; *Night only* does the reverse for nocmig.

**Renders run in the background.** The render gets its own canvas and a frozen
copy of the records, so you can keep changing settings and playing previews
while a clip is drawn. The progress panel shows the frame count, a live
thumbnail and an ETA, and can be shrunk to a strip.

**What you can put in a clip**

- **Day and night** from the real solar position — the terminator sweeps the
  country once per simulated day, with a warm band at dawn and dusk.
- **City lights** that come on through dusk, sized by population — off by
  default, as they tend to compete with the records rather than frame them.
- **Stars** on the night side.
- **Wind flow** — a particle field driven by real hourly wind, in the style of
  the big wind maps.
- **Cloud cover** and **rain**, lit by the sun on the day side.
- **The birds**: a glow per record, sized by flock, with an optional ripple as
  each one lands, a red ring on rarities, and an optional lasting trace that
  accumulates through the clip.

**Settings** cover clip length, frame rate, aspect ratio, file format, how long records linger, dot size and glow, bird colouring, sea
palette, night depth, city glow, wind density and speed, cloud strength,
captions, and which overlays appear.

**Aspect ratios**: 1:1, 4:5, 9:16, 16:9, 3:2 and 4:3, each at a sensible
pixel size. All dimensions are even, which H.264 requires.

### Records without a time

eBird and iNaturalist records carry a time; blog and acoustic records only
carry a date. "Records without a time" decides what happens to those:

- **Spread across daylight** (default) — placed pseudo-randomly between local
  sunrise and sunset. Deterministic, so a clip re-renders identically, but it
  is a visual approximation rather than a real time.
- **All at dawn** / **All at midday** — honest and literal, but they bunch.
- **Leave them out** — only records with a real timestamp.

Acoustic (BirdWeather) records are off by default in the studio: they are
aggregates over days, so they would blink on all at once rather than flow.

They are also **excluded from the week-on-week trend** behind "Which birds are
moving?" and the species picker's ordering, for two reasons. A station total
has no date of its own - the exporter spreads those across the window using the
dated records' daily profile - so feeding them back into a trend is circular.
And the acoustic dump is both heavily recency-weighted (24,391 UK records last
week against 5,218 the week before) and biased towards vocal garden birds, so
including it ranked Dunnock, Wren and Jackdaw above every real migrant. The
trend is computed from eBird, iNaturalist, the blogs, the county recorders and
Bluesky only - and from **UK records only**, since judged across Europe the
answer came back Greater Flamingo, whose seventeen British records are all the
captive flock at WWT Slimbridge.

Finally, the trend is restricted to **genera that are migratory or irruptive in
Britain** (`SEASONAL_GENERA`). Without that the list was topped by Coal Tit,
Wren, Dunnock and House Sparrow, which were not moving anywhere - they were
simply well recorded that week. Blackbird, Song Thrush, Starling and Goldcrest
are included on purpose despite breeding here, because all four get a large
autumn influx from the continent.

**How *Spread across daylight* places an aggregate.** A BirdWeather row is a
station total stamped with the end of the fetch bucket it fell in, so tens of
thousands of them sit on a handful of days and the stamp says nothing about
when the bird actually called. Spreading them *evenly* over the clip is worse
than useless on a migration: it invents Redwing on the 10th of October, where
there were almost none, and flattens the arrival the clip exists to show.

They are therefore distributed in proportion to the **daily profile of the
dated records for the same selection** — eBird, iNaturalist, blog and county
records, which do carry real dates. If Redwing arrive on the 17th then the
acoustic totals land around the 17th too. Below a dozen dated records the
profile is noise rather than signal and the spread falls back to uniform.

This is still an estimate, and for some species the aggregates outnumber the
dated records several times over. **Leave them out** shows only firmly dated
records if you want the unembellished version.

### One panel, nine categories

There is no separate settings overlay any more. Everything — the subject, the
clip, the world, captions, the birds, output, export, the data sources and the
layout — is a section of the one panel, reached from a menu that lists them
with their current value beside each name, so nothing is two clicks and a
guess away. The sections are written as `details.sect` in the markup and
converted into menu + panes at boot by `buildPanelMenu()`; the HTML stays one
readable list, and the navigation is decided in one place. The panel is a drawer in the default *theatre* layout: the `≡`
button on the map opens it, the **Hide** button at the top of the panel closes
it, and `?settings=1` opens it on load.

### The URL is the save file

The address bar always describes what you are looking at, so a link can be
shared and a refresh picks up where you left off. Change the species, the
dates, the weather or the framing and the URL is rewritten in place
(`replaceState`, so a slider does not bury the back button).

```
?species=Redwing&from=2026-10-10
?group=thrushes&colour=species&duration=15&box=51.2,-1.1,52.4,0.9
```

Only settings that **differ from the page's defaults** are written, which is
what keeps the common case down to a parameter or two instead of
twenty-five — and why putting something back to its default removes it from
the link again.

One useful consequence: the end date defaults to the newest day in the data,
so a link for "Redwing since the 10th" carries no `to=` at all and shows the
recipient everything up to *their* today, not the day you sent it.

A single table (`URL_CHECKS` / `URL_VALUES` in `web/studio.js`) drives reading
and writing both, so the two cannot drift apart; a setting added to it is
shareable without further thought.

Two parameters are read but deliberately never written, because they describe
a moment rather than a view:

```
?species=Redwing&t=0.42        # freeze the preview 42% through the clip
?species=Fieldfare&autorender=1 # start a render immediately
```

Writing `t=` would churn the URL sixty times a second, and a shared link that
opens frozen on one frame is not what someone following it wants to see.

---

## Commands

```bash
python3 -m src.fetch_all                   # all sources, then export
python3 -m src.fetch_all --only ebird blogs
python3 -m src.fetch_all --days 7
python3 -m src.fetch_all --deep            # eBird per-county-per-day sweep
python3 -m src.fetch_all --rebuild         # rebuild species index + gazetteer
python3 -m src.fetch_all --no-studio       # skip the coastline/weather data
python3 -m src.export_web                  # rewrite map data from the database
python3 -m src.geodata                     # rebuild coastlines and city lights
python3 -m src.server --port 8777          # serve without fetching
```

`--deep` adds eBird's historic endpoint for every county and every day in the
window. It finds considerably more records, with counts and observer names, but
takes 20–30 minutes instead of 40 seconds.

Re-running is safe: every record has a stable id and upserts rather than
duplicating, so this works fine from cron.

```cron
30 6 * * * cd /path/to/UK\ Nature\ Map && python3 -m src.fetch_all >/dev/null 2>&1
```

---

## Publishing to GitHub Pages

```bash
./deploy.sh              # publish what is in web/
./deploy.sh --fetch      # refresh the data first, then publish
```

Live at <https://dusky-nembrotha.github.io/uk-bird-map/>.

Everything in `web/` is pushed to the `gh-pages` branch as a single commit that
replaces the one before it, so `main` stays code-only and repeated deploys do
not grow the repository — the exported JSON is rewritten each time rather than
piling up in history. Pages serves it gzipped, so the 17 MB `sightings.json`
reaches the browser as roughly 4 MB.

The published site is a snapshot, not a feed: it shows whatever was in
`web/data` when you last deployed. Run `./deploy.sh --fetch` to move it on.

Two things differ from running locally, because Pages serves static files and
has no Python behind them:

- **Video export** falls back to in-browser WebM capture. The studio detects
  this by itself (`/api/capabilities` is absent) and hides the mp4 and gif
  options. Browser capture timestamps frames by wall clock, so a heavy render
  comes out slower than the frame rate asks for — for a frame-accurate mp4,
  render locally with ffmpeg installed.
- **Species photos** are fetched straight from iNaturalist rather than through
  the `/api/photo` proxy. The photos on their CORS-enabled host appear as
  normal; those on the host that sends no CORS header do not load, which is
  deliberate — loading them would taint the canvas and break frame export.

Note that a Pages site is public even if its repository is private: private
Pages is a GitHub Enterprise feature.

---

## Adding a county blog

Most UK county sightings pages are on Blogger or WordPress and have a feed. Add
an entry to `BLOGS` in `src/sources/blogs.py`:

```python
{
    "key": "wilts",
    "name": "Wiltshire Birds",
    "page": "https://example.blogspot.com/",
    "feed": "https://example.blogspot.com/feeds/posts/default?alt=json",
    "region": "Wiltshire",
    "county_hint": "Wiltshire",
    "bbox": (51.0, -2.4, 51.7, -1.5),      # south, west, north, east
    "strategy": "sectioned",                # or "title_site" / "prose"
}
```

The `bbox` matters: site names only resolve inside it, which is what stops a
"Severn Beach" in one county landing in another.

Pick the strategy that matches how the blog is written:

- `sectioned` — bold/underlined site headings with lists under them
  (`Snuff Mills: 5 Mallard, 2 Cormorant…`)
- `title_site` — the post title is the site, the body is the records
- `prose` — narrative text; site names found by scanning the sentences

RSS and Atom feeds work too — just give the feed URL.

Currently configured: **35 feeds** covering roughly 38 recording areas —
Avon, Cambridgeshire, Cheshire, Cornwall, Derbyshire, Devon, Dorset,
Gloucestershire, Kent, Lancashire, Norfolk, Northamptonshire, Oxfordshire,
Scilly, Staffordshire, Suffolk, Surrey, Sussex, Wiltshire, Yorkshire;
Anglesey, Glamorgan, Montgomeryshire, Pembrokeshire, Radnorshire; Argyll,
Dumfries & Galloway, Shetland; all six Northern Ireland counties; plus the
Portland, Gibraltar Point, Dungeness, Hilbre, Walney, Holme, Landguard,
Heysham and Filey observatories.

### County recorders

Two counties publish coordinates rather than prose, which makes them the most
precise non-checklist data here:

- **Kent OS** gives an Ordnance Survey grid reference per visit, plus the time
  window, weather, observer and a count for every species. `src/osgrid.py`
  converts the reference properly — inverting the transverse Mercator
  projection on the Airy 1830 ellipsoid, *and* applying the OSGB36→WGS84
  Helmert transformation, which is the step that is easy to skip and would put
  every record about 100 m out. Checked against the Ordnance Survey's own
  published worked example: **0.7 m**.
- **Sussex OS** gives decimal latitude and longitude for any record whose
  submitter dropped a map pin. Records without one are left out rather than
  guessed at.

### How blog parsing works

Blogs are the only source with no machine-readable format, so two rules keep
the error rate down:

1. **A bird name only counts if it's capitalised in the original.** Reports
   always capitalise species, so this is what stops the words "knot", "shag"
   and "swift" in ordinary prose being read as birds.
2. **Site names resolve only within the blog's own county.** Names come from
   eBird's hotspot register (the places birders actually go, under the names
   they use), GeoNames, locations already seen in collected records, and
   finally a cached Nominatim lookup.

Dates written inside a post ("Wednesday 21st", "October 23rd") re-date
everything below them, because several blogs keep one post per month and edit
it daily.

Species names are matched against a 1,300-entry index that reconciles the
sources' different vernaculars — eBird's "Eurasian Blackbird", iNaturalist's
taxonomy and a blog's "Blackbird" all resolve to *Turdus merula*, and British
names are used for display. Birder shorthand ("GBB Gull", "RNP", "Med Gull") is
understood.

---

## Other sources considered

Surveyed and rejected, so the next person does not have to repeat the work:

| Source | Verdict |
|---|---|
| **NBN Atlas** | Works, no key, 199M records — but its most recent bird record is about a month old (October was empty; September held 10,611). Only useful with a 60-day window, which would dilute "recent". `records-ws.nbnatlas.org/occurrences/search?q=class:Aves` |
| **Xeno-canto** | Sound recordings with coordinates — genuinely additive. API v3 needs a free key, the same deal as eBird. Worth adding if you want ringers' and nocmig recordings. |
| **Observation.org** | ~~401~~ **This entry was wrong.** Re-checked 2026-10-24: `/api/v1/observations/?species_group=1&country=GB` answers **200 unauthenticated** (32,311 GB bird records, newest the same day, exact coordinates with a metre accuracy figure). Only `/api/v1/locations/` still 401s, which is probably what was tested before. Not yet used: responses take 10-16 s, and `/api/docs/` returns 403 saying access is limited to approved applications — so it is open in practice but approval-only by policy, and could close without notice. Worth applying for. |
| **Trektellen** | Visible-migration counts, which would suit the migration theme well, but the API requires a login. |
| **Rare Bird Alert / BirdGuides** | Commercial subscription services with no open API. Scraping them would not be appropriate. |
| **BTO BirdTrack** | No public API. Its records reach us indirectly through GBIF and NBN, on their lags. |

The cheapest remaining win is more county blogs — the framework takes a new one
in about six lines, and a sweep of candidate Blogger and WordPress feeds turns
up live ones regularly.

## Output files

| Path | What |
|---|---|
| `data/sightings.db` | SQLite: every record, the species index, the gazetteer |
| `data/sightings.geojson` | The whole dataset for QGIS or any GIS |
| `web/data/sightings.json` | Compact payload the map loads (~3 MB for 55k records) |
| `web/data/geo.json` | Coastlines the studio draws |
| `web/data/cities.json` | Populated places, for city lights |
| `web/data/weather.json` | Hourly wind, cloud and rain grid |
| `data/renders/` | Render scratch and finished clips (swept after 6 hours) |

The SQLite database is the source of truth; everything else is regenerated
from it.

---

## Layout

```
src/
  config.py       settings and paths
  db.py           SQLite schema and upserts
  species.py      species index, British names, birder shorthand
  gazetteer.py    site name -> coordinates
  geodata.py      coastlines and city lights for the studio
  fetch_all.py    orchestrator (CLI)
  export_web.py   database -> map payload + GeoJSON
  server.py       local web server + ffmpeg video encoder
  sources/        one adapter per source, plus weather.py
web/
  index.html  app.js          the map
  studio.html studio.js       the animation studio
  style.css   studio.css
```

---

## Notes and limits

- Records older than the window are pruned on each run, so the database stays
  about a fortnight deep. `--no-prune` keeps them and the window grows.
- eBird's recent endpoints only reach back 30 days.
- GBIF publishes in bulk drops a fortnight or more behind. With the project's
  usual 14-day window it returns literally nothing, so it is given a 30-day
  window of its own (`gbif.days_back`) and the prune respects the widest
  window. That is why the map's full range is about a month rather than a
  fortnight; the date presets still open on the last three days.
- Times in the studio are treated as UTC. British Summer Time is an hour out
  until late October; the terminator is unaffected.
- Weather is a 1°×1.5° grid — enough to drive a smooth field, not a forecast.
- Please keep the rate limits in `src/util.py` as they are. They are set to
  each API's stated policy, and Nominatim's (1 request/second) is a condition
  of use.
- Data credit belongs to eBird, iNaturalist, BirdWeather, GBIF, Open-Meteo,
  GeoNames, Natural Earth, OpenStreetMap and the county blog authors — the
  studio burns that credit line into clips by default. Please leave it on.
