# -*- coding: utf-8 -*-
"""
Build the North America GeoJSON layers for frequencyMapNorthAmerica.html.

Outputs (upload both to  <site>/chartdata/ ):
    NorthAmerica_admin4.geojson   states / provinces / estados   (USA + CAN + MEX)
    NorthAmerica_admin6.geojson   counties and county-equivalents (USA)

Why these sources
-----------------
The measurement records carry admin level names straight from OSM
('admin4' = 'California', 'admin6' = 'Santa Clara County'), not codes. The
boundary files therefore have to be joined BY NAME, and the level 6 name is
only unique inside its state - 'Montgomery County' exists in NY, OH and TX.
Every feature consequently carries both its own name and its parent.

    level 4  Natural Earth 10m admin_1 states & provinces (public domain)
             97 polygons, covers all three countries, names already match
             the OSM spelling including accents ('Quebec' is written Québec).
    level 6  US Census Bureau cartographic boundary file, 2024 vintage,
             1:20,000,000 (public domain). NAMELSAD matches the OSM spelling
             ('Santa Clara County', 'East Baton Rouge Parish') and the 2024
             vintage already carries the Connecticut Planning Regions, which
             replaced the old CT counties and do appear in our data.

Canada and Mexico are NOT in the level 6 layer. Statistics Canada blocks
automated download, Overpass times out on a country-wide admin_level=6 query,
and the geoBoundaries CAN ADM2 product is economic regions, whose names do not
match OSM census divisions. Both countries are fully covered at level 4.

Run:  python tools/build_na_geojson.py [-o OUTDIR]
"""

import argparse
import io
import json
import os
import sys
import unicodedata
import zipfile
from collections import Counter

import requests
import shapefile  # pyshp
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

NE_ADM1 = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
           "master/geojson/ne_10m_admin_1_states_provinces.geojson")
CENSUS_COUNTY = ("https://www2.census.gov/geo/tiger/GENZ2024/shp/"
                 "cb_2024_us_county_20m.zip")
COUNTRIES = ("USA", "CAN", "MEX")

# Natural Earth still carries the pre-2016 name for Mexico City.
ADM4_ALIAS = {("MEX", "Distrito Federal"): "Ciudad de México"}

# Simplification in degrees. 0.005 deg ~ 500 m at the equator; at US latitudes
# roughly 400 m east-west. Fine for a choropleth drawn at country zoom.
TOL_ADM4 = 0.005
TOL_ADM6 = 0.003
COORD_DP = 4          # ~11 m, far below the simplification tolerance


def log(*a):
    print(*a, flush=True)


def norm(s):
    """Join key: casefold, strip accents and punctuation, collapse whitespace.

    Mirrors normName() in frequencyMapNorthAmerica.js - keep the two in step.
    """
    if not s:
        return ""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace(".", " ").replace("-", " ").replace("'", "")
    s = " ".join(s.split())
    if s.startswith("saint "):
        s = "st " + s[6:]
    return s


# Mirrors ALIAS / SUFFIXES / stripSuffix() in frequencyMapNorthAmerica.js.
JS_ALIAS = {"rhode island|south county": "washington county"}
SUFFIXES = (" county", " parish", " borough", " census area",
            " city and borough", " municipality", " planning region",
            " region", " city")


def strip_suffix(n):
    for suf in SUFFIXES:
        if n.endswith(suf):
            return n[:-len(suf)]
    return n


def fetch(url, path, binary=True):
    if os.path.exists(path):
        log(f"  cached  {os.path.basename(path)}")
        return open(path, "rb").read() if binary else open(path, encoding="utf-8").read()
    log(f"  GET     {url}")
    r = requests.get(url, timeout=600,
                     headers={"User-Agent": "IndoorCO2Map-map-build/1.0"})
    r.raise_for_status()
    open(path, "wb").write(r.content)
    return r.content if binary else r.content.decode("utf-8")


def round_geom(geom, dp=COORD_DP):
    """Round every coordinate; shrinks the file by roughly a third."""
    def rc(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], dp), round(c[1], dp)]
        return [rc(x) for x in c]
    g = mapping(geom)
    g = dict(g)
    g["coordinates"] = rc(g["coordinates"])
    return g


def drop_east_of_dateline(geom, name=""):
    """Discard the parts of Alaska that sit east of the antimeridian.

    The far-western Aleutians are mapped at +172..+180 while the rest of Alaska
    sits at -179..-130. Leaflet draws such a feature as a band stretching across
    the whole world. The discarded parts are a handful of uninhabited islands
    and carry no measurements; the alternative, shifting them to -188..-180,
    would park them outside the map instead.
    """
    if geom.geom_type != "MultiPolygon":
        return geom
    minx, _, maxx, _ = geom.bounds
    if not (minx < -170 and maxx > 170):
        return geom
    keep = [g for g in geom.geoms if g.bounds[0] < 0]
    dropped = len(geom.geoms) - len(keep)
    if not keep:
        return geom
    log(f"  antimeridian: {name} - dropped {dropped} far-western part(s)")
    return unary_union(keep)


def clean(geom, tol, name=""):
    """Simplify, repair whatever that broke, and unwrap the dateline."""
    g = geom.simplify(tol, preserve_topology=True)
    if not g.is_valid:
        g = g.buffer(0)
    if g.is_empty:                      # simplified out of existence
        g = geom.buffer(0)
    return drop_east_of_dateline(g, name)


def ne_name(p):
    for k in ("name", "name_en", "gn_name", "woe_name", "name_local"):
        v = p.get(k)
        if v:
            return v
    return None


# ----------------------------------------------------------------- level 4
def build_adm4(cache):
    raw = fetch(NE_ADM1, os.path.join(cache, "ne_10m_admin_1.geojson"))
    d = json.loads(raw.decode("utf-8"))

    feats = []
    for f in d["features"]:
        p = f["properties"]
        iso3 = p.get("adm0_a3")
        if iso3 not in COUNTRIES:
            continue
        name = ne_name(p)
        if not name:
            log(f"  WARN level4 feature without name, iso_3166_2="
                f"{p.get('iso_3166_2')!r} - skipped")
            continue
        name = ADM4_ALIAS.get((iso3, name), name)
        g = clean(shape(f["geometry"]), TOL_ADM4, name)
        feats.append({
            "type": "Feature",
            "properties": {"country": iso3, "name": name,
                           "code": p.get("iso_3166_2") or ""},
            "geometry": round_geom(g),
        })
    log(f"  level 4: {len(feats)} features "
        f"({Counter(f['properties']['country'] for f in feats)})")
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------- level 6
def build_adm6(cache):
    blob = fetch(CENSUS_COUNTY, os.path.join(cache, "cb_2024_us_county_20m.zip"))
    z = zipfile.ZipFile(io.BytesIO(blob))
    stem = "cb_2024_us_county_20m"
    sf = shapefile.Reader(shp=io.BytesIO(z.read(stem + ".shp")),
                          dbf=io.BytesIO(z.read(stem + ".dbf")),
                          shx=io.BytesIO(z.read(stem + ".shx")))
    flds = [f[0] for f in sf.fields[1:]]

    feats = []
    for sr in sf.shapeRecords():
        rec = dict(zip(flds, sr.record))
        g = clean(shape(sr.shape.__geo_interface__), TOL_ADM6,
                  rec["NAMELSAD"])
        feats.append({
            "type": "Feature",
            "properties": {
                "country": "USA",
                "name": rec["NAMELSAD"],      # 'Santa Clara County'
                "parent": rec["STATE_NAME"],  # 'California'
                "code": rec["GEOID"],         # 5-digit FIPS, stable id
            },
            "geometry": round_geom(g),
        })
    log(f"  level 6: {len(feats)} features (USA)")
    return {"type": "FeatureCollection", "features": feats}


# ----------------------------------------------------------------- validate
def validate(adm4, adm6, cache):
    """Join the freshly built layers against the live dataset and report."""
    log("\nValidating against the live dataset ...")
    try:
        blob = fetch("https://indoorco2map.com/chartdata/IndoorCO2MapData.zip",
                     os.path.join(cache, "IndoorCO2MapData.zip"))
        data = json.loads(zipfile.ZipFile(io.BytesIO(blob))
                          .read("indoorco2mapData.json").decode("utf-8"))
    except Exception as e:                      # offline - not fatal
        log(f"  skipped, could not fetch dataset: {e}")
        return

    na = [r for r in data if r.get("countryID") in COUNTRIES]
    log(f"  North America records: {len(na)} "
        f"({Counter(r['countryID'] for r in na)})")

    have4 = {(f["properties"]["country"], norm(f["properties"]["name"]))
             for f in adm4["features"]}
    want4 = {(r["countryID"], r["admin4"]) for r in na if r["admin4"]}
    miss4 = sorted(w for w in want4 if (w[0], norm(w[1])) not in have4)
    log(f"  level 4: {len(want4) - len(miss4)}/{len(want4)} regions matched")
    for m in miss4:
        log(f"     UNMATCHED {m}")

    have6 = {(norm(f["properties"]["parent"]), norm(f["properties"]["name"]))
             for f in adm6["features"]}
    want6 = {(r["admin4"], r["admin6"]) for r in na
             if r["countryID"] == "USA" and r["admin4"] and r["admin6"]}

    exact, fallback, miss6 = [], [], []
    for w in sorted(want6):
        pk, nk = norm(w[0]), norm(w[1])
        nk = JS_ALIAS.get(pk + "|" + nk, nk)
        if (pk, nk) in have6:
            exact.append(w)
        elif any((pk, v) in have6 for v in (nk + " county", strip_suffix(nk))):
            fallback.append(w)
        else:
            miss6.append(w)
    log(f"  level 6 (USA): {len(exact) + len(fallback)}/{len(want6)} regions "
        f"matched ({len(exact)} exact, {len(fallback)} via the fallback rules "
        f"in frequencyMapNorthAmerica.js)")
    for m in fallback:
        log(f"     fallback  {m}")
    for m in miss6:
        n = sum(1 for r in na if (r["admin4"], r["admin6"]) == m)
        log(f"     UNMATCHED {m}  ({n} records) - add an alias to ALIAS in "
            f"frequencyMapNorthAmerica.js and to JS_ALIAS here")

    out = sum(1 for r in na if r["countryID"] in ("CAN", "MEX") and r["admin6"])
    log(f"  level 6: {out} Canadian/Mexican records have an admin6 value but "
        f"no polygon in this layer (see module docstring); they are covered "
        f"at level 4.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--outdir", default="chartdata")
    ap.add_argument("--cache", default=os.path.join("tools", "_cache"))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)

    log("Building level 4 (states / provinces / estados) ...")
    adm4 = build_adm4(a.cache)
    log("Building level 6 (counties and county-equivalents) ...")
    adm6 = build_adm6(a.cache)

    for name, fc in (("NorthAmerica_admin4.geojson", adm4),
                     ("NorthAmerica_admin6.geojson", adm6)):
        p = os.path.join(a.outdir, name)
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(fc, fh, ensure_ascii=False, separators=(",", ":"))
        log(f"  wrote {p}  {os.path.getsize(p)/1e6:.2f} MB")

    validate(adm4, adm6, a.cache)


if __name__ == "__main__":
    sys.exit(main())
