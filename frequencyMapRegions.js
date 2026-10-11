// Consolidated regional frequency map.
//
// Replaces frequencymap.js (NUTS3), frequencyMapNUTS1.js, frequencyMapNUTS2.js,
// frequencyMapWorld.js and frequencyMapNorthAmerica.js. Those pages each
// re-downloaded the measurement archive and a boundary file of their own; here
// the archive is fetched once and every boundary file is fetched only when its
// button is pressed, then kept.
//
// Boundary layers are built by tools/build_region_layers.py (NUTS, world) and
// tools/build_na_geojson.py (North America).
//
// Deep links: frequencyMapRegions.html#nuts2 opens straight on that view.

const zipFile = 'chartdata/IndoorCO2MapData.zip';
const jsonFileInsideZip = 'indoorco2mapData.json';

// Served from the site itself in production. When the page is opened from a
// local checkout the chartdata folder is usually not there, so fall back to the
// published copy - the bucket answers with Access-Control-Allow-Origin: *.
const REMOTE_BASE = 'https://indoorco2map.com/';

function fetchAsset(path) {
    function remote(why) {
        return fetch(REMOTE_BASE + path).then(function (r) {
            if (!r.ok) {
                throw new Error(why + ', and HTTP ' + r.status +
                                ' for the published copy');
            }
            console.info('[regions map] ' + path + ' not available locally (' +
                         why + '), using ' + REMOTE_BASE + path);
            return r;
        });
    }
    return fetch(path).then(
        function (res) {
            return res.ok ? res : remote('HTTP ' + res.status + ' for ' + path);
        },
        function (err) { return remote(err.message); }
    );
}

// region: only re-centre the map when moving between continents, so switching
// NUTS1 -> NUTS2 keeps whatever the user was looking at.
const LAYERS = {
    nuts1: {
        label: 'NUTS1', file: 'chartdata/regions_nuts1.geojson',
        kind: 'nuts', cut: 3, describe: 'NUTS1 region',
        region: 'europe', view: [51.1657, 10.4515, 4]
    },
    nuts2: {
        label: 'NUTS2', file: 'chartdata/regions_nuts2.geojson',
        kind: 'nuts', cut: 4, describe: 'NUTS2 region',
        region: 'europe', view: [51.1657, 10.4515, 4]
    },
    nuts3: {
        label: 'NUTS3', file: 'chartdata/regions_nuts3.geojson',
        kind: 'nuts', cut: 5, describe: 'NUTS3 region',
        region: 'europe', view: [51.1657, 10.4515, 4]
    },
    world: {
        label: 'Countries (World)', file: 'chartdata/regions_world.geojson',
        kind: 'country', describe: 'Country',
        region: 'world', view: [25, 5, 2]
    },
    na4: {
        label: 'N. America: States / Provinces', file: 'chartdata/NorthAmerica_admin4.geojson',
        kind: 'na4', describe: 'State / Province',
        region: 'northamerica', view: [44, -100, 3]
    },
    na6: {
        label: 'USA: Counties', file: 'chartdata/NorthAmerica_admin6.geojson',
        kind: 'na6', describe: 'County',
        region: 'northamerica', view: [44, -100, 3]
    }
};

const NA_COUNTRIES = ['USA', 'CAN', 'MEX'];

// Local names no boundary file carries. Keyed by normalised state|name.
const ALIAS = {
    'rhode island|south county': 'washington county'
};
const SUFFIXES = [' county', ' parish', ' borough', ' census area',
                  ' city and borough', ' municipality', ' planning region',
                  ' region', ' city'];

var map = L.map('map').setView([51.1657, 10.4515], 4);

var records = [];          // the archive, loaded once
var dataReady = null;      // resolves when `records` is populated
var counts = {};           // layer key -> { regionKey: count }
var layers = {};           // layer key -> L.geoJson
var geo = {};              // layer key -> parsed GeoJSON
var stats = {};            // layer key -> { shown, outOfScope, unmatched }
var current = null;

// Must stay in step with norm() in tools/build_na_geojson.py
function normName(s) {
    if (!s) return '';
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    s = s.toLowerCase().replace(/\./g, ' ').replace(/-/g, ' ').replace(/'/g, '');
    s = s.trim().replace(/\s+/g, ' ');
    if (s.indexOf('saint ') === 0) s = 'st ' + s.slice(6);
    return s;
}

function stripSuffix(n) {
    for (var i = 0; i < SUFFIXES.length; i++) {
        if (n.endsWith(SUFFIXES[i])) return n.slice(0, -SUFFIXES[i].length);
    }
    return n;
}

// Key a polygon.
function featureKey(cfg, p) {
    switch (cfg.kind) {
        case 'nuts':    return p.id;
        case 'country': return p.id;
        case 'na4':     return p.country + '|' + normName(p.name);
        case 'na6':     return normName(p.parent) + '|' + normName(p.name);
    }
    return '';
}

// Candidate keys for a measurement, most specific first. Empty array means the
// record cannot belong to this layer at all.
function recordKeys(cfg, r) {
    if (cfg.kind === 'nuts') {
        var id = r.nuts3ID;
        return (id && id.length >= cfg.cut) ? [id.slice(0, cfg.cut)] : [];
    }
    if (cfg.kind === 'country') {
        return r.countryID ? [r.countryID] : [];
    }
    if (NA_COUNTRIES.indexOf(r.countryID) === -1) return [];
    if (cfg.kind === 'na4') {
        var a4 = normName(r.admin4);
        return a4 ? [r.countryID + '|' + a4] : [];
    }
    // na6
    var parent = normName(r.admin4), name = normName(r.admin6);
    if (!parent || !name) return [];
    name = ALIAS[parent + '|' + name] || name;
    var variants = [name, name + ' county', stripSuffix(name)], out = [], seen = {};
    for (var i = 0; i < variants.length; i++) {
        var k = parent + '|' + variants[i];
        if (!seen[k]) { seen[k] = 1; out.push(k); }
    }
    return out;
}

// Aggregate once per layer. Counting inside style() would be O(regions x
// records) - 1662 x 24000 for NUTS3 - and would stall the browser.
function buildCounts(key) {
    if (counts[key]) return;
    if (!records.length) {
        // Guard against caching an empty result. showLayer waits for dataReady,
        // so this should be unreachable; it is here because a cached empty
        // count map is invisible and permanent.
        console.warn('[regions map] buildCounts(' + key + ') with no records; skipped');
        return;
    }
    var cfg = LAYERS[key];
    var valid = {}, feats = geo[key].features;
    for (var i = 0; i < feats.length; i++) {
        valid[featureKey(cfg, feats[i].properties)] = true;
    }
    var c = {}, miss = {}, scope = 0;
    for (var j = 0; j < records.length; j++) {
        var r = records[j];
        var cands = recordKeys(cfg, r);
        if (!cands.length) { scope++; continue; }
        var hit = null;
        for (var k = 0; k < cands.length; k++) {
            if (valid[cands[k]]) { hit = cands[k]; break; }
        }
        if (hit) {
            c[hit] = (c[hit] || 0) + 1;
        } else if (cfg.kind === 'na6' && r.countryID !== 'USA') {
            // Canada and Mexico have no level 6 polygons - a known gap in the
            // boundary sources, not a failed match.
            scope++;
        } else {
            var label = cfg.kind === 'na6' ? r.admin6 + ', ' + r.admin4
                      : cfg.kind === 'na4' ? r.admin4
                      : cands[0];
            miss[label] = (miss[label] || 0) + 1;
        }
    }
    var shown = 0;
    for (var kk in c) shown += c[kk];
    counts[key] = c;
    stats[key] = { shown: shown, outOfScope: scope, unmatched: miss };
}

function getCount(key, props) {
    return counts[key][featureKey(LAYERS[key], props)] || 0;
}

// Same scale as the pages this replaces.
function getColor(d) {
    return d >= 1000 ? '#3f007d' :
           d >= 500  ? '#7a0177' :
           d >= 250  ? '#ae017e' :
           d >= 100  ? '#2b8cbe' :
           d >= 50   ? '#4eb3d3' :
           d >= 25   ? '#7bccc4' :
           d >= 1    ? '#ccece6' :
                       '#000000';
}

function styleFor(key) {
    var thin = key === 'nuts3' || key === 'na6';
    return function (feature) {
        return {
            fillColor: getColor(getCount(key, feature.properties)),
            weight: thin ? 0.4 : 1,
            opacity: 0.7,
            color: 'grey',
            dashArray: '2',
            fillOpacity: 1
        };
    };
}

function setStatus(msg) {
    var el = document.getElementById('status');
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function num(n) { return n.toLocaleString('en-US'); }

function fail(msg) {
    setStatus(msg);
    var el = document.getElementById('note');
    if (el) el.textContent = msg;
}

// The page no longer shows this text, but the figures are still worth having:
// they go to the console, and #note is written to if a page ever adds it back.
function updateNote() {
    var el = document.getElementById('note');
    var cfg = LAYERS[current], s = stats[current];
    if (!s) { if (el) el.textContent = ''; return; }

    var txt = num(s.shown) + ' of ' + num(records.length) +
              ' measurements mapped at this level.';

    if (cfg.kind === 'nuts') {
        txt += ' NUTS covers Europe only; ' + num(s.outOfScope) +
               ' measurements outside the NUTS area are not shown here.';
    } else if (cfg.kind === 'na4') {
        txt += ' This view covers the United States, Canada and Mexico.';
    } else if (cfg.kind === 'na6') {
        txt += ' This view covers the United States only, including county-equivalents ' +
               'such as parishes, boroughs and the Connecticut planning regions. ' +
               'Canadian and Mexican measurements appear on the ' +
               'N. America: States / Provinces view.';
    }

    var missTotal = 0, missList = [];
    for (var m in s.unmatched) {
        missTotal += s.unmatched[m];
        missList.push(m + ' (' + s.unmatched[m] + ')');
    }
    if (missTotal) {
        missList.sort();
        txt += ' ' + num(missTotal) + ' measurement(s) carry a region that has no ' +
               'matching boundary and are missing from the map: ' +
               missList.slice(0, 6).join('; ') +
               (missList.length > 6 ? '; and ' + (missList.length - 6) + ' more' : '') + '.';
    }
    if (el) el.textContent = txt;
    console.info('[regions map] ' + txt);
}

function setButtonsEnabled(on) {
    for (var k in LAYERS) {
        var b = document.getElementById('btn-' + k);
        if (b) b.disabled = !on;
    }
}

function markButtons() {
    for (var k in LAYERS) {
        var b = document.getElementById('btn-' + k);
        if (b) b.classList.toggle('active', k === current);
    }
}

function showLayer(key) {
    if (!LAYERS[key]) key = 'nuts1';
    var previous = current;
    current = key;
    markButtons();
    if (history.replaceState) history.replaceState(null, '', '#' + key);

    var cfg = LAYERS[key];
    var moved = !previous || LAYERS[previous].region !== cfg.region;

    for (var l in layers) {
        if (layers[l] && l !== key) map.removeLayer(layers[l]);
    }
    if (layers[key]) {
        layers[key].addTo(map);
        if (moved) map.setView([cfg.view[0], cfg.view[1]], cfg.view[2]);
        updateNote();
        renderLabels();
        return;
    }

    setStatus('Loading ' + cfg.label + ' boundaries ...');
    // Both must be in hand before counting: a boundary file is far smaller than
    // the archive and routinely wins the race.
    Promise.all([fetchAsset(cfg.file).then(function (res) { return res.json(); }),
                 dataReady])
        .then(function (both) {
            var gj = both[0];
            if (current !== key) return;      // user moved on while it loaded
            geo[key] = gj;
            buildCounts(key);
            layers[key] = L.geoJson(gj, {
                style: styleFor(key),
                onEachFeature: function (feature, layer) {
                    var p = feature.properties;
                    var n = getCount(key, p);
                    var where = (cfg.kind === 'na6' && p.parent)
                              ? p.name + ', ' + p.parent : p.name;
                    var extra = (cfg.kind === 'nuts' && p.id) ? ' (' + p.id + ')' : '';
                    // A dependency shares its sovereign's count; say so rather
                    // than implying the measurements were taken there.
                    var main = primaryIndex(key)[featureKey(cfg, p)];
                    var note = (main && main.name && main.name !== p.name)
                             ? '<br><i>counted under ' + main.name + '</i>' : '';
                    layer.bindPopup('<b>' + where + extra + '</b><br>' +
                                    cfg.describe + '<br>Measurements: ' + n + note);
                }
            }).addTo(map);
            if (moved) map.setView([cfg.view[0], cfg.view[1]], cfg.view[2]);
            // The map container is sized by CSS (and by the webfont settling),
            // so make sure Leaflet has the final dimensions.
            if (map.invalidateSize) map.invalidateSize();
            setStatus('');
            updateNote();
            renderLabels();
        })
        .catch(function (e) {
            fail('Could not load the boundaries for ' + cfg.label +
                 ' (' + cfg.file + '): ' + e.message);
            console.error(e);
        });
}

// ---------------------------------------------------------------- bootstrap
(function () {
    for (var k in LAYERS) {
        (function (key) {
            var b = document.getElementById('btn-' + key);
            if (b) b.addEventListener('click', function () { showLayer(key); });
        })(k);
    }

    setStatus('Loading measurements ...');
    setButtonsEnabled(false);
    dataReady = fetchAsset(zipFile)
        .then(function (res) { return res.arrayBuffer(); })
        .then(function (buf) { return JSZip.loadAsync(buf); })
        .then(function (zip) { return zip.file(jsonFileInsideZip).async('string'); })
        .then(function (txt) {
            records = JSON.parse(txt);
            setButtonsEnabled(true);
            return records;
        });

    dataReady
        .then(function () {
            // Do not override a layer the user already picked while the archive
            // was still in flight.
            if (current) { showLayer(current); return; }
            var want = (location.hash || '').replace('#', '');
            showLayer(LAYERS[want] ? want : 'nuts1');
        })
        .catch(function (e) {
            fail('Could not load the measurement archive (' + zipFile + '): ' +
                 e.message);
            console.error(e);
        });
})();

// ---------------------------------------------------------------- labels
// Names and counts for the busiest regions. A label is drawn inside its region
// when it fits there, otherwise it is pushed outside and joined back with a
// leader line, so a small but busy region (Berlin, San Francisco) stays legible.

var labelMode = 0;              // 0 = off, otherwise how many regions to label
var labelLayer = null;          // L.layerGroup holding the labels and leaders
var anchorCache = {};           // layerKey -> { featureIndex: [lat, lng] }
var primaryCache = {};          // layerKey -> { regionKey: {idx, area, name} }
var measureCanvas;   // undefined = untried, null = unavailable

var LABEL_FONT = '600 11px "Titillium Web", system-ui, sans-serif';

function ringArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(a / 2);
}

// Total outer-ring area of a feature, used to pick which polygon of a country
// is the "main" one.
function featureArea(geom) {
    if (geom.type === 'Polygon') return ringArea(geom.coordinates[0]);
    var a = 0;
    for (var i = 0; i < geom.coordinates.length; i++) {
        a += ringArea(geom.coordinates[i][0]);
    }
    return a;
}

// The biggest piece of a MultiPolygon, as polylabel wants it: [outer, holes...]
function largestPart(geom) {
    if (geom.type === 'Polygon') return geom.coordinates;
    var best = null, bestA = -1;
    for (var i = 0; i < geom.coordinates.length; i++) {
        var a = ringArea(geom.coordinates[i][0]);
        if (a > bestA) { bestA = a; best = geom.coordinates[i]; }
    }
    return best;
}

function segDistSq(px, py, a, b) {
    var x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
        var t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) { x = b[0]; y = b[1]; }
        else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = px - x; dy = py - y;
    return dx * dx + dy * dy;
}

// Distance from a point to the polygon edge, positive inside and negative out.
function signedDist(px, py, rings) {
    var inside = false, minSq = Infinity;
    for (var k = 0; k < rings.length; k++) {
        var ring = rings[k];
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var a = ring[i], b = ring[j];
            if ((a[1] > py) !== (b[1] > py) &&
                px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) {
                inside = !inside;
            }
            minSq = Math.min(minSq, segDistSq(px, py, a, b));
        }
    }
    return (inside ? 1 : -1) * Math.sqrt(minSq);
}

// Pole of inaccessibility - the interior point furthest from any edge. A plain
// centroid is no good: for a concave region (a C shape, or a state wrapped
// round a bay) it lands outside the polygon and the label detaches.
//
// Implemented here rather than pulled from a CDN because polylabel publishes no
// browser bundle: 1.1.0 is CommonJS and 2.0.1 is an ES module, so the
// <script src=...polylabel...> tag these pages used to carry never defined
// anything. Coarse grid for a global maximum, then hill-climb to refine; only
// ever run for the handful of labelled regions, and cached.
function poleOfInaccessibility(rings) {
    var outer = rings[0];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < outer.length; i++) {
        var p = outer[i];
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
    }
    var w = maxX - minX, h = maxY - minY;
    if (w === 0 || h === 0) return [minX, minY];

    var N = 24, bx = minX + w / 2, by = minY + h / 2;
    var bd = signedDist(bx, by, rings);
    for (var gx = 0; gx <= N; gx++) {
        for (var gy = 0; gy <= N; gy++) {
            var x = minX + w * gx / N, y = minY + h * gy / N;
            var d = signedDist(x, y, rings);
            if (d > bd) { bd = d; bx = x; by = y; }
        }
    }
    var step = Math.max(w, h) / N;
    for (var it = 0; it < 14; it++) {
        step /= 2;
        var improved = false;
        for (var ox = -1; ox <= 1; ox++) {
            for (var oy = -1; oy <= 1; oy++) {
                if (!ox && !oy) continue;
                var nx = bx + ox * step, ny = by + oy * step;
                var nd = signedDist(nx, ny, rings);
                if (nd > bd) { bd = nd; bx = nx; by = ny; improved = true; }
            }
        }
        if (!improved && step < Math.max(w, h) / 4096) break;
    }
    return [bx, by];
}

function anchorFor(key, idx, feature) {
    var cache = anchorCache[key] || (anchorCache[key] = {});
    if (cache[idx]) return cache[idx];
    var p = poleOfInaccessibility(largestPart(feature.geometry));
    cache[idx] = [p[1], p[0]];                  // GeoJSON is [lng, lat]
    return cache[idx];
}

function measure(text) {
    if (measureCanvas === null) {               // tried once, not available
        return text.length * 6.2;
    }
    if (!measureCanvas) {
        try {
            var c = document.createElement('canvas');
            measureCanvas = (c && c.getContext) ? c.getContext('2d') : null;
        } catch (e) { measureCanvas = null; }
        if (!measureCanvas) { measureCanvas = null; return text.length * 6.2; }
    }
    measureCanvas.font = LABEL_FONT;
    return measureCanvas.measureText(text).width;
}

// Which polygon is the main one for each region key. Natural Earth splits a
// country into several features that share an ISO code - France also appears as
// Clipperton Island, Serbia as Kosovo, Australia as three island territories -
// and every one of them matches the country's full count. Without this, each
// would claim its own label showing the whole country's total.
function primaryIndex(key) {
    if (primaryCache[key]) return primaryCache[key];
    var cfg = LAYERS[key], feats = geo[key].features, best = {};
    for (var i = 0; i < feats.length; i++) {
        var k = featureKey(cfg, feats[i].properties);
        var a = featureArea(feats[i].geometry);
        if (!best[k] || a > best[k].area) {
            best[k] = { idx: i, area: a, name: feats[i].properties.name || k };
        }
    }
    primaryCache[key] = best;
    return best;
}

// The n busiest regions of a layer, ranked, one entry per region.
function topRegions(key, n) {
    if (!geo[key] || !counts[key]) return [];
    var cfg = LAYERS[key], c = counts[key], feats = geo[key].features;
    var main = primaryIndex(key), out = [];
    for (var k in main) {
        var v = c[k] || 0;
        if (v <= 0) continue;
        var idx = main[k].idx;
        out.push({ idx: idx, name: main[k].name, count: v, feature: feats[idx] });
    }
    out.sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
    return out.slice(0, n);
}

function renderLabels() {
    if (!map.latLngToContainerPoint) return;    // headless: nothing to draw into
    if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
    if (!labelMode || !current || !counts[current]) return;

    var items = topRegions(current, labelMode);
    if (!items.length) return;

    var group = L.layerGroup();
    var size = map.getSize();
    var placed = [];
    // inside first, then push outward in 8 directions at growing distance
    var DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    var RADII = [0, 22, 36, 54, 76, 102];

    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var ll = anchorFor(current, it.idx, it.feature);
        var anchor = map.latLngToContainerPoint(ll);
        if (anchor.x < -200 || anchor.y < -200 ||
            anchor.x > size.x + 200 || anchor.y > size.y + 200) continue;

        var text = it.name + '  ' + num(it.count);
        var w = Math.ceil(measure(text)) + 12, h = 18;

        var spot = null, usedRadius = 0;
        for (var r = 0; r < RADII.length && !spot; r++) {
            var dirs = RADII[r] === 0 ? [[0, 0]] : DIRS;
            for (var d = 0; d < dirs.length; d++) {
                var cx = anchor.x + dirs[d][0] * (RADII[r] + w / 2);
                var cy = anchor.y + dirs[d][1] * (RADII[r] + h / 2);
                var rect = { l: cx - w / 2, r: cx + w / 2, t: cy - h / 2, b: cy + h / 2 };
                if (rect.l < 2 || rect.t < 2 || rect.r > size.x - 2 || rect.b > size.y - 2) continue;
                var clash = false;
                for (var q = 0; q < placed.length; q++) {
                    var o = placed[q];
                    if (!(rect.r < o.l || o.r < rect.l || rect.b < o.t || o.b < rect.t)) {
                        clash = true; break;
                    }
                }
                if (!clash) { spot = { x: cx, y: cy, rect: rect }; usedRadius = RADII[r]; break; }
            }
        }
        if (!spot) continue;                    // no room: omit rather than overlap
        placed.push(spot.rect);

        var at = map.containerPointToLatLng(L.point(spot.x, spot.y));
        if (usedRadius > 0) {                   // joined back to its region
            L.polyline([ll, at], {
                color: '#1f2937', weight: 1, opacity: 0.8, interactive: false
            }).addTo(group);
            L.circleMarker(ll, {
                radius: 2, color: '#1f2937', fillColor: '#1f2937',
                fillOpacity: 1, weight: 0, interactive: false
            }).addTo(group);
        }
        L.marker(at, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
                className: 'region-label',
                html: '<span>' + it.name + '</span><b>' + num(it.count) + '</b>',
                iconSize: [w, h],
                iconAnchor: [w / 2, h / 2]
            })
        }).addTo(group);
    }

    labelLayer = group.addTo(map);
}

function setLabelMode(n) {
    labelMode = n;
    for (var i = 0; i < LABEL_BUTTONS.length; i++) {
        var b = document.getElementById(LABEL_BUTTONS[i][0]);
        if (b) b.classList.toggle('active', LABEL_BUTTONS[i][1] === n);
    }
    renderLabels();
}

var LABEL_BUTTONS = [['btn-lbl-off', 0], ['btn-lbl-10', 10], ['btn-lbl-25', 25]];

// Wired here, not in the bootstrap block: that runs earlier in the file, when
// LABEL_BUTTONS is still hoisted-but-undefined.
for (var li = 0; li < LABEL_BUTTONS.length; li++) {
    (function (id, n) {
        var b = document.getElementById(id);
        if (b) b.addEventListener('click', function () { setLabelMode(n); });
    })(LABEL_BUTTONS[li][0], LABEL_BUTTONS[li][1]);
}

// Label placement is computed in screen space, so it has to be redone whenever
// the view changes.
if (map.on) map.on('moveend zoomend', renderLabels);

// ---------------------------------------------------------------- legend
var legend = L.control({ position: 'bottomright' });
legend.onAdd = function () {
    var div = L.DomUtil.create('div', 'info legend'),
        grades = [1, 25, 50, 100, 250, 500, 1000];
    div.style.backgroundColor = '#fff';
    div.style.padding = '5px';
    div.style.borderRadius = '5px';
    div.style.boxShadow = '0 0 10px rgba(0,0,0,0.1)';
    for (var i = 0; i < grades.length; i++) {
        var from = grades[i], to = grades[i + 1];
        div.innerHTML +=
            '<i style="background:' + getColor(from) +
            '; width: 18px; height: 18px; display: inline-block; margin-right: 6px;"></i> ' +
            from + (to ? '&ndash;' + (to - 1) : '+') + '<br>';
    }
    return div;
};
legend.addTo(map);
