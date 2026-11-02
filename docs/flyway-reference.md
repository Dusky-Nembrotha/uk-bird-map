# Flyway reference — researched, not yet shipped

Source-backed migration references for species not yet in `SPECIES`
(`src/validate.py`). Everything here was read out of the cited source, not
recalled. Derived arithmetic is labelled. Gaps are listed rather than guessed —
**an entry nobody can trust is worse than no entry**, because the validator
reports SKIP for an unknown species and PASS for a wrongly-described one.

Current coverage: **six coastal waders.** Research on inland/upland waders,
aerial feeders and wildfowl/raptors was commissioned at the same time but was
cut off by a session limit before it could be recorded here.

---

## Master sources

| Code | Source |
|---|---|
| EAF2020 | East Atlantic Flyway Assessment 2020 (van Roomen et al., 2022), Annex 1 tables A1.31–A1.42 — <https://flyway.waddensea-worldheritage.org/sites/default/files/2022-06/2022_East%20Atlantic%20Flyway%20assessment%202020.pdf> |
| FLY2020 / FLY2023 | Simultaneous January waterbird census, national reports — the best single source for a per-region winter split — <https://www.waddensea-worldheritage.org/sites/default/files/2020_Flyway%20census%20report.pdf> and <https://www.waddensea-worldheritage.org/sites/default/files/2024_Flyway%20national%20census%202023%20reports_2.pdf> |
| WS41 | Wadden Sea Ecosystem 41, Trends of Migratory Birds to 2019/20 — <https://zenodo.org/records/8296015/files/Ecosystem%2041_Trends%20of%20Migratory%20Birds.pdf> |
| CSR7 | AEWA 1% thresholds and official seasonality windows; Güpner et al. 2020, Vogelwelt 140: 61–81 — <https://www.dda-web.de/downloads/publications/vogelwelt/140/Guepner_et_al_2020_Int_Schwellenwerte_Wasservoegel_Update_2020.pdf> |
| CSR9 | AEWA Conservation Status Report, 9th ed. (2025) — <https://www.unep-aewa.org/sites/default/files/publication/csr9_full_version_english.pdf> |
| WeBS25 | Waterbirds in the UK 2024/25 — <https://www.bto.org/sites/default/files/bto-rspb-jncc-naturescot-waterbirds-in-the-uk-webs-gsmp-report-2024-25.pdf> |
| IRE | Burke et al. 2018, *Irish Birds* 11 — <https://birdwatchireland.ie/app/uploads/2020/09/PopEstimates_2019_Irish-Birds_Burke-et-al-b-2019.pdf> |
| ISSAP | AEWA Black-tailed Godwit ISSAP, Tech. Series 37 — <https://www.unep-aewa.org/sites/default/files/document/aewa_btg_iwg_nw_inf_3.3_issap.pdf> |
| NI55 | Skarphéðinsson et al. 2016, Fjölrit 55, Náttúrufræðistofnun Íslands — <https://utgafa.ni.is/fjolrit/Fjolrit_55.pdf> |
| Svalbard | NPI Brief Report 059 — <https://nyalesundresearch.no/wp-content/uploads/2022/01/2021_NPI_Brief-report-series-no-059_Vadefugler-i-Kongsfjorden.pdf>; Birding Svalbard checklist — <https://www.svalbardbirds.com/species.html> |

---

## Two corrections to existing assumptions

- **Red Knot breeds in Svalbard** — an uncommon but annual breeder, probably
  >30 pairs, and the *only* Western Palearctic breeding site. The Svalbard cell
  must not be blank for Knot in June–July.
- **Turnstone does not breed in Iceland.** It is a passage migrant (40,000 in
  spring per NI55, 100,000 by throughput per Fuglavefur) plus a scarce winter
  visitor (1,000–2,000). Nor do Knot or Sanderling breed there. Of these six,
  only Black-tailed Godwit breeds in Iceland.

---

## The window problem

The map window is 34–72°N, 25°W–45°E. **Morocco lies almost entirely south of
34°N**, so Moroccan Atlantic wintering is outside it too. For several of these
species the majority of the flyway winters outside the window entirely, which
means `winter` regions can only describe the part still inside — and the
seasonal-share tests must be set accordingly.

| Species | Share wintering **inside** the window | Majority regions inside |
|---|---|---|
| Red Knot | ~50–55% (islandica ~99% in; canutus ~100% out) | Britain/Ireland ≫ Low Countries > France |
| Bar-tailed Godwit | ~20–30% (taymyrensis ~100% out) | Low Countries + Britain, then Ireland, France, Germany |
| Sanderling | ~25–35% | France, Britain/Ireland, Low Countries |
| Grey Plover | ~60–70% | France + Low Countries + Britain + Germany |
| Turnstone | ~25–35% (whole Palearctic population winters in W Africa) | Britain/Ireland, France, Low Countries |
| Black-tailed Godwit | ~50% | **Iberia** is the single biggest January region |

---

## Winter (January) counts by region

From FLY2020 (Jan 2020) unless noted. "est" = national winter estimate.

| Region | Knot | Sanderling | Bar-t Godwit | Black-t Godwit | Grey Plover | Turnstone |
|---|---|---|---|---|---|---|
| Britain (UK) | 209,915 (est 210,000) | 8,250 (est 18,000) | 35,762 (est 42,000) | est ~54,000 | 24,068 (est 29,000) | 10,941 (est 36,000) |
| Ireland | 5,652 | 1,945 | 5,324 | 10,356 | 971 | 1,286 |
| Low Countries | 51,644 | 10,642 | 45,867 | ~11 | 28,992 | 7,979 |
| Denmark | 6,400 | 800 | 800 | — | 1,900 | 100 |
| Norway/Sweden | 1 | 0 | 0 | 0 | 1 | 69 |
| Finland/Baltic | ~0 | ~0 | ~0 | ~0 | ~0 | ~1 |
| Germany | 7,855 (est 26,000) | 1,886 (est 3,700) | 761 (est 9,000) | — | 8,636 (est 19,000) | 1,190 (est 2,100) |
| Poland | 0 | 0 | 0 | 0 | 0 | 0 |
| France | 31,117 (2023) | 23,464 | 7,658 | 27,354 (2018) | 37,665 | 22,980 |
| Iberia (PT 2019) | 63 | 1,677 | 2,273 | 35,837 | 7,017 | 423 |
| Mediterranean (Italy) | ~150 | ~550 | ~34 | ~123 | ~5,529 | ~218 |
| Iceland | no January census exists | — | — | — | — | 1,000–2,000 |
| Svalbard / Arctic Russia | 0 (frozen) | 0 | 0 | 0 | 0 | 0 |

Poland's national January count (558 sites, 943,388 birds) records **no waders
at all** — it is a duck/goose/gull scheme. Absence there is a survey artefact,
not biology.

**Turnstone and Sanderling are badly under-counted in January** — both are
rocky/non-estuarine species. GB counted 10,941 Turnstone against a GB estimate
of 36,000–38,000 (3.5×). Treat January counts as a floor, never as a share.

---

## Summer

- **Knot** — breeds inside the window in **Svalbard only**. Main population
  breeds NE Canada/Greenland (islandica) and Taimyr (canutus), both outside.
- **Sanderling** — **Svalbard only**, rare: 20–100 pairs, W/NW Spitsbergen,
  red-listed VU there.
- **Turnstone** — Svalbard 50–500 pairs, plus Norway/Sweden, Finland/Baltic and
  Arctic Russia.
- **Bar-tailed Godwit** — Norway/Sweden, Finland and Arctic Russia west to the
  Kanin peninsula. European breeding total 3,700–9,000 pairs (BirdLife 2015).
- **Grey Plover** — **essentially none.** Breeds in Siberian tundra *east* of
  the Kanin peninsula (~45°E), so only the extreme western fringe of the window
  could hold any.
- **Black-tailed Godwit** — the only one breeding widely inside the window.
  Iceland (islandica): 19,000 pairs (mark–resight) to 67,600 (habitat model) — a
  genuine 3.5× disagreement, cite both. limosa: Netherlands 25,000–29,000 pairs,
  **80–87% of the whole West European flyway**.

**June–August is dominated by return passage, not breeding** for all of these
except Black-tailed Godwit, which is the opposite — limosa leaves the breeding
grounds in late June/July and most Dutch adults fly non-stop to West Africa. Its
verified Dutch peak is **March**, not July–August.

---

## Britain: variability and residents

WeBS UK annual indices 2010/11–2024/25 (2020/21 missing, COVID):

| Species | range | max/min | CV |
|---|---|---|---|
| Knot | 78–118 | 1.51× | 12.0% |
| Sanderling | 68–116 | 1.71× | 14.9% |
| Bar-tailed Godwit | 96–169 | 1.76× | 18.5% |
| Black-tailed Godwit | 61–100 | 1.64× | 12.1% (a near-monotonic increase, not noise) |
| Grey Plover | 94–137 | 1.46× | 12.3% |
| Turnstone | 86–118 | 1.37× | 8.4% |

**Verdict: moderate.** Nothing swings more than ~1.8× across 15 years, so
nothing here would swamp a seasonal signal — unlike Waxwing, where the choice of
year is everything (3,949 British records in winter 2023–24 against 19 in
2024–25).

**No resident British breeding population** for any of the six. Black-tailed
Godwit is the only breeder at all (53 pairs; 46 limosa, 7 islandica) and is
fully migratory. There is, however, a small year-round non-breeding presence of
Turnstone, Grey Plover, Bar-tailed Godwit and Knot on larger estuaries, which
puts a non-zero floor under June–August counts.

---

## Draft `SPECIES` entries

**Unvalidated.** Each still needs `python3 -m src.validate` to pass, and a
`FLIGHT` group adding in `src/migration.py` (all six are `wader`).

```python
"Calidris canutus": dict(
    name="Red Knot", lat=(34, 81), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["Britain/Ireland", "Low Countries", "France", "Germany/Poland"],
    summer=["Svalbard"], unwatched=["Svalbard"],
    absent=[], shift=3.0,
    note="islandica from NE Canada/Greenland winters here, almost entirely "
         "inside the window; canutus from Taimyr passes through to W Africa. "
         "Breeds in Svalbard, >30 pairs - the only WP site. Britain alone "
         "holds ~65-70% of islandica."),

"Calidris alba": dict(
    name="Sanderling", lat=(34, 81), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["France", "Britain/Ireland", "Low Countries"],
    summer=["Svalbard"], unwatched=["Svalbard"],
    absent=[], shift=2.0,
    note="Only ~25-35% of the flyway winters inside the window; the rest is "
         "Mauritania south to Namibia. Rare Svalbard breeder, 20-100 pairs. "
         "January counts are a floor - non-estuarine and under-counted."),

"Limosa lapponica": dict(
    name="Bar-tailed Godwit", lat=(34, 75), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["Low Countries", "Britain/Ireland", "France", "Germany/Poland"],
    summer=["Norway/Sweden", "Finland/Baltic", "Arctic Russia"],
    unwatched=["Arctic Russia"],
    absent=[], shift=4.0,
    note="lapponica breeds N Fennoscandia east to Kanin and winters here; "
         "taymyrensis passes through to W Africa almost entirely. ~70-80% of "
         "the combined flyway winters outside the window."),

"Limosa limosa": dict(
    name="Black-tailed Godwit", lat=(34, 68), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["Iberia", "Britain/Ireland", "France"],
    summer=["Iceland", "Low Countries", "Germany/Poland", "Finland/Baltic"],
    absent=[], shift=3.0,
    note="Two populations: islandica breeds Iceland and winters Britain, "
         "Ireland, France; limosa breeds the Netherlands (80-87% of its "
         "flyway) and winters Iberian rice fields and W Africa. Iberia is the "
         "biggest January region inside the window. Not covered by EAF2020."),

"Pluvialis squatarola": dict(
    name="Grey Plover", lat=(34, 75), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["France", "Low Countries", "Britain/Ireland", "Germany/Poland"],
    summer=["Arctic Russia"], unwatched=["Arctic Russia"],
    absent=[], shift=3.0,
    note="Breeds in Siberian tundra EAST of the Kanin peninsula, so there is "
         "almost no breeding presence inside the window - a summer signal here "
         "is passage or non-breeders. ~60-70% winters inside the window."),

"Arenaria interpres": dict(
    name="Ruddy Turnstone", lat=(34, 81), lon=(-25, 45),
    autumn="s", spring="n",
    winter=["Britain/Ireland", "France", "Low Countries"],
    summer=["Svalbard", "Norway/Sweden", "Finland/Baltic", "Arctic Russia"],
    unwatched=["Svalbard", "Arctic Russia"],
    absent=[], shift=3.0,
    note="Nearctic birds winter in W Europe; the whole Palearctic population "
         "winters in W Africa. Does NOT breed in Iceland - passage (40,000 in "
         "spring) plus 1,000-2,000 wintering. Heavily under-counted in "
         "January: GB count 10,941 against a GB estimate of 36,000."),
```

Note that `absent` is empty for all six: **no region among the twelve is one
where any of these genuinely never occurs.** Leaving it empty is the honest
choice; filling it to make a test stricter would encode a falsehood.

---

## Known conflicts between sources

- **Knot islandica**: EAF2020 310,000–360,000 vs AEWA CSR7 ~500,000–565,000 —
  a ~60% discrepancy, the largest in the set. EAF2020's is the one derived from
  actual January counts.
- **Turnstone Nearctic**: EAF2020 200,000–260,000 vs CSR7 ~140,000.
- **Grey Plover**: 200,000 (CSR7/EAF) vs 250,000 (WPE5).
- **Black-tailed Godwit in Iceland**: 19,000 pairs vs 67,600 — 3.5×.
- **Turnstone in Iceland**: 40,000 (survey) vs 100,000 (throughput).
- **Iberian Black-tailed Godwit trend**: ISSAP has Spain decreasing 1990–2001;
  Lourenço & Piersma 2008 say Iberia now holds more. Unresolved.

## Explicit gaps

1. Current Wetlands International WPE population sizes — the portal is a
   JavaScript-only app. All CSR7 sizes above are arithmetic from 1% thresholds.
2. Spain — no national January totals for Knot, Bar-tailed Godwit, Grey Plover
   or Turnstone; Spain submitted no species data to the Jan 2023 census.
3. Iceland — no January totals for any of the six; outside the EAF series.
4. Iceland status for Grey Plover and Bar-tailed Godwit — only negative evidence
   (absent from both national species lists).
5. Greece, Croatia, Albania, Egypt, Libya — no usable source.
6. Poland — the national scheme counts no waders.
7. Switzerland, Austria, Czechia — no per-country status found.
8. Post-2010 Black-tailed Godwit breeding numbers for Germany, Poland, Denmark,
   France, Belarus — use EEA Article 12 / EBBA2.
9. Numerical Iberia vs W Africa split for limosa.
10. Per-country Scandinavian/Baltic Turnstone breeding pairs; modern
    Fennoscandian Bar-tailed Godwit pairs.
