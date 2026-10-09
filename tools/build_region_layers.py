# -*- coding: utf-8 -*-
"""
Build the NUTS and world layers for frequencyMapRegions.html.

Outputs (upload all four to  <site>/chartdata/ ):
    regions_nuts1.geojson    134 NUTS level 1 regions
    regions_nuts2.geojson    364 NUTS level 2 regions
    regions_nuts3.geojson   1662 NUTS level 3 regions
    regions_world.geojson    258 countries

Why rebuild what is already on the server
-----------------------------------------
The old pages each pulled a whole file and threw most of it away:

    NUTS_RG_10M_2024_4326.geojson   5.24 MB, all four NUTS levels in one file.
                                    frequencyMapNUTS1.js downloaded all of it
                                    and then filtered to LEVL_CODE === 1, so a
                                    NUTS1 view cost 5.24 MB to draw 134 shapes.
    custom.geojson                 22.38 MB for 258 countries - Natural Earth
                                    with all 170-odd attribute columns kept,
                                    including every translated country name.
                                    The map reads exactly one of them.

Splitting by level and dropping the unused columns cuts the default view from
5.24 MB to 0.89 MB and the world view from 22.38 MB to well under a megabyte.

The join keys are kept identical to the old pages, so the behaviour does not
change: NUTS by NUTS_ID prefix, world by adm0_iso against countryID.

Run:  python tools/build_region_layers.py
"""

import argparse
import json
import os
import sys
from collections import Counter

import requests
from shapely.geometry import shape, mapping

NUTS_URL = "https://indoorco2map.com/chartdata/NUTS_RG_10M_2024_4326.geojson"
WORLD_URL = "https://indoorco2map.com/chartdata/custom.geojson"

TOL_NUTS = {1: 0.004, 2: 0.003, 3: 0.002}
TOL_WORLD = 0.02
COORD_DP = 4


def log(*a):
    print(*a, flush=True)


def fetch(url, path):
    if os.path.exists(path):
        log(f"  cached  {os.path.basename(path)} "
            f"({os.path.getsize(path)/1e6:.2f} MB)")
        return open(path, "rb").read()
    log(f"  GET     {url}")
    r = requests.get(url, timeout=900,
                     headers={"User-Agent": "IndoorCO2Map-map-build/1.0"})
    r.raise_for_status()
    open(path, "wb").write(r.content)
    return r.content


def round_geom(geom, dp=COORD_DP):
    def rc(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], dp), round(c[1], dp)]
        return [rc(x) for x in c]
    g = dict(mapping(geom))
    g["coordinates"] = rc(g["coordinates"])
    return g


def clean(geom, tol):
    g = geom.simplify(tol, preserve_topology=True)
    if not g.is_valid:
        g = g.buffer(0)
    if g.is_empty:
        g = geom.buffer(0)
    return g


def write(fc, path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"  wrote {path}  {os.path.getsize(path)/1e6:.2f} MB  "
        f"({len(fc['features'])} features)")


def build_nuts(cache, outdir):
    raw = fetch(NUTS_URL, os.path.join(cache, "NUTS.geojson"))
    d = json.loads(raw.decode("utf-8"))
    log(f"  source: {len(d['features'])} features, "
        f"{Counter(f['properties'].get('LEVL_CODE') for f in d['features'])}")

    for lvl in (1, 2, 3):
        feats = []
        for f in d["features"]:
            p = f["properties"]
            if p.get("LEVL_CODE") != lvl:
                continue
            g = clean(shape(f["geometry"]), TOL_NUTS[lvl])
            feats.append({
                "type": "Feature",
                "properties": {
                    "id": p["NUTS_ID"],
                    # NUTS_NAME is in the local script (Враца); NAME_LATN is the
                    # transliteration. Keep both, the popup prefers the local one
                    # exactly as the old pages did.
                    "name": p.get("NUTS_NAME") or p.get("NAME_LATN") or p["NUTS_ID"],
                    "nameLatn": p.get("NAME_LATN") or "",
                    "cntr": p.get("CNTR_CODE") or "",
                },
                "geometry": round_geom(g),
            })
        write({"type": "FeatureCollection", "features": feats},
              os.path.join(outdir, f"regions_nuts{lvl}.geojson"))


def build_world(cache, outdir):
    raw = fetch(WORLD_URL, os.path.join(cache, "custom.geojson"))
    d = json.loads(raw.decode("utf-8"))
    log(f"  source: {len(d['features'])} features, "
        f"{len(d['features'][0]['properties'])} attribute columns")

    feats, noiso = [], 0
    for f in d["features"]:
        p = f["properties"]
        iso = p.get("adm0_iso") or p.get("adm0_a3") or p.get("iso_a3") or ""
        if not iso or iso == "-99":
            noiso += 1
        g = clean(shape(f["geometry"]), TOL_WORLD)
        feats.append({
            "type": "Feature",
            "properties": {
                "id": iso,                                   # join key: countryID
                "name": p.get("name_en") or p.get("name") or iso,
            },
            "geometry": round_geom(g),
        })
    if noiso:
        log(f"  note: {noiso} feature(s) without a usable ISO code "
            f"(they simply never match a measurement)")
    write({"type": "FeatureCollection", "features": feats},
          os.path.join(outdir, "regions_world.geojson"))


def validate(outdir, cache):
    """Check the join keys against the live dataset."""
    import io
    import zipfile
    log("\nValidating against the live dataset ...")
    try:
        blob = fetch("https://indoorco2map.com/chartdata/IndoorCO2MapData.zip",
                     os.path.join(cache, "IndoorCO2MapData.zip"))
        data = json.loads(zipfile.ZipFile(io.BytesIO(blob))
                          .read("indoorco2mapData.json").decode("utf-8"))
    except Exception as e:
        log(f"  skipped, could not fetch dataset: {e}")
        return

    # world: countryID -> id
    w = json.load(open(os.path.join(outdir, "regions_world.geojson"),
                       encoding="utf-8"))
    ids = {f["properties"]["id"] for f in w["features"]}
    cc = Counter(r["countryID"] for r in data if r["countryID"])
    hit = sum(n for c, n in cc.items() if c in ids)
    missing = sorted(c for c in cc if c not in ids)
    log(f"  world: {hit}/{sum(cc.values())} measurements fall in a country "
        f"polygon; unmatched codes: {missing if missing else 'none'}")

    # nuts: nuts3ID prefix -> id
    for lvl, cut in ((1, 3), (2, 4), (3, 5)):
        g = json.load(open(os.path.join(outdir, f"regions_nuts{lvl}.geojson"),
                           encoding="utf-8"))
        have = {f["properties"]["id"] for f in g["features"]}
        want = Counter(r["nuts3ID"][:cut] for r in data
                       if r.get("nuts3ID") and len(r["nuts3ID"]) >= cut)
        miss = sorted(k for k in want if k not in have)
        log(f"  NUTS{lvl}: {sum(n for k, n in want.items() if k in have)}"
            f"/{sum(want.values())} measurements matched"
            + (f"; unmatched ids: {miss[:8]}" if miss else ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--outdir", default="chartdata")
    ap.add_argument("--cache", default=os.path.join("tools", "_cache"))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)

    log("Building NUTS levels 1-3 ...")
    build_nuts(a.cache, a.outdir)
    log("Building world ...")
    build_world(a.cache, a.outdir)
    validate(a.outdir, a.cache)


if __name__ == "__main__":
    sys.exit(main())
