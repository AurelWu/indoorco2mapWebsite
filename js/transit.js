/* transit.js — Indoor CO2 Map, public transit journey browser (transit.html).
 * Reads the same S3 export as transitanalysis.js, so a visit to either page warms the cache for the other. */

const DATA_URL = 'https://s3.eu-central-1.amazonaws.com/indoorco2map.com/chartdata/IndoorCO2MapTransitData.json';
const PAGE_SIZE = 100;

const ZONES = [
  { key: 'good',      color: '#648eff', test: v => v < 800 },
  { key: 'moderate',  color: '#ffb000', test: v => v >= 800 && v <= 1400 },
  { key: 'unhealthy', color: '#ff190c', test: v => v > 1400 },
];
const zoneOf = v => ZONES.find(z => z.test(v)) || ZONES[2];

const MODE_LABELS = {
  train: 'Train', subway: 'Metro / Subway', tram: 'Tram',
  light_rail: 'Light rail / S-Bahn', bus: 'Bus', trolleybus: 'Trolleybus',
  monorail: 'Monorail', ferry: 'Ferry', unknown: 'Unknown',
};

const OSM_TYPES = { r: 'relation', w: 'way', n: 'node' };

// ─── State ──────────────────────────────────────────────────────────────────

let journeys = [];
const byId = new Map();
let matching = [];            // filtered and sorted
let shownCount = PAGE_SIZE;
let selectedId = null;
let map = null, overviewLayer = null, selectedLayer = null, detailChart = null;

const DEFAULTS = {
  q: '', mode: '', country: '', aq: '', from: '', to: '', notes: false,
  sort: 'ts', asc: false,
};
const state = { ...DEFAULTS };
const FILTER_KEYS = ['q', 'mode', 'country', 'aq', 'from', 'to', 'notes'];

// ─── Small helpers ──────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const fmtInt = n => n.toLocaleString('en-US');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Lower-case, strip accents and turn ß into ss, so "wahringer strasse" finds "Währinger Straße".
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').toLowerCase();

const regionNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(code) {
  if (!code) return 'Unknown';
  try { return regionNames?.of(code) || code; } catch { return code; }
}

function tzAt(lat, lon) {
  if (typeof tzlookup !== 'function' || lat == null || lon == null) return undefined;
  try { return tzlookup(lat, lon); } catch { return undefined; }
}

const DT = {
  day:  { year: 'numeric', month: '2-digit', day: '2-digit' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  full: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};
const dtfCache = new Map();
// Formatter for a journey's own time zone; undefined tz falls back to the browser's zone.
function dtf(tz, kind) {
  const key = `${tz || ''}|${kind}`;
  let f = dtfCache.get(key);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { ...DT[kind], timeZone: tz }); }
    catch { f = new Intl.DateTimeFormat('en-GB', DT[kind]); }
    dtfCache.set(key, f);
  }
  return f;
}
function localDay(ts, tz) {
  const p = Object.fromEntries(dtf(tz, 'day').formatToParts(ts).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// OSM PTv2 names read "Tram 42: Schottentor => Antonigasse"; type and ref get their own columns.
function shortLine(name, ref) {
  const i = name.indexOf(': ');
  return ref && i > 0 && name.slice(0, i).includes(ref) ? name.slice(i + 2) : name;
}

const point = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon) ? [lat, lon] : null;

function osmLink(type, id, text) {
  const t = OSM_TYPES[type];
  if (!t || !id) return esc(text);
  return `<a href="https://www.openstreetmap.org/${t}/${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(text)}</a>`;
}

// ─── Data ───────────────────────────────────────────────────────────────────

function toJourney(m) {
  const ts = Date.parse(m.startOfMeasurement);
  const readings = Array.isArray(m.co2readings) ? m.co2readings.filter(Number.isFinite) : [];
  if (!ts || !readings.length) return null;

  // Route on the map: straight from the start to the end stop. The GPS fields are ignored: GPS was
  // unreliable, and for privacy newer app versions only copy the stop coordinates into them.
  const path = [point(m.originLatitude, m.originLongitude), point(m.destinationLatitude, m.destinationLongitude)]
    .filter(Boolean);

  const tz = path.length ? tzAt(path[0][0], path[0][1]) : undefined;
  const mode = m.lineRoute || 'unknown';
  const code = m.originCountryCode || m.destinationCountryCode || '';
  const interval = m.interval > 0 ? m.interval : null;
  const line = m.lineName || '';
  const ref = m.lineRef || '';

  const j = {
    id: m.measurementID, ts, tz, m,
    day: localDay(ts, tz),
    mode, modeLabel: MODE_LABELS[mode] || mode,
    line, ref, lineShort: shortLine(line, ref),
    network: (m.lineNetwork || '').trim(),
    operator: m.originOperator || m.destinationOperator || '',
    from: m.originName || '', to: m.destinationName || '',
    country: code || '-', countryLabel: countryName(code),
    readings, interval,
    avg: Number.isFinite(m.co2readingsAvg)
      ? m.co2readingsAvg : Math.round(readings.reduce((s, v) => s + v, 0) / readings.length),
    min: Math.min(...readings), max: Math.max(...readings),
    duration: interval ? readings.length * interval : null,
    path,
    notes: (m.customNotes || '').trim(),
    sensor: m.sensorType || '',
  };
  j.hay = fold([
    j.id, line, ref, j.network, m.originOperator, m.destinationOperator, j.from, j.to,
    j.modeLabel, mode, j.countryLabel, m.originCountry, m.destinationCountry, code, j.notes, j.sensor,
  ].filter(Boolean).join('\n'));
  return j;
}

// ─── Filtering and sorting ──────────────────────────────────────────────────

function passes(j, terms) {
  if (state.mode && j.mode !== state.mode) return false;
  if (state.country && j.country !== state.country) return false;
  if (state.aq && zoneOf(j.avg).key !== state.aq) return false;
  if (state.from && j.day < state.from) return false;
  if (state.to && j.day > state.to) return false;
  if (state.notes && !j.notes) return false;
  return terms.every(t => j.hay.includes(t));
}

const SORT_KEYS = {
  ts: j => j.ts, line: j => j.line, dur: j => j.duration ?? -1, avg: j => j.avg,
};
// Columns whose first click sorts descending; labels are [ascending, descending].
const DESC_FIRST = new Set(['ts', 'dur', 'avg']);
const SORT_LABELS = {
  ts:   ['start time', 'oldest first', 'most recent first'],
  line: ['line', 'A–Z', 'Z–A'],
  dur:  ['duration', 'shortest first', 'longest first'],
  avg:  ['average CO₂', 'lowest first', 'highest first'],
};
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function sortMatching() {
  const key = SORT_KEYS[state.sort];
  const dir = state.asc ? 1 : -1;
  matching.sort((a, b) => {
    const x = key(a), y = key(b);
    const c = typeof x === 'string' ? collator.compare(x, y) : x - y;
    return c * dir || b.ts - a.ts;
  });
}

const isFiltered = () => FILTER_KEYS.some(k => state[k] !== DEFAULTS[k]);

function refresh(fit = true) {
  const terms = fold(state.q).split(/\s+/).filter(Boolean);
  matching = journeys.filter(j => passes(j, terms));
  sortMatching();
  shownCount = PAGE_SIZE;
  render(fit);
  writeUrl();
}

function render(fit) {
  renderTable();
  renderOverview(fit);
  renderSummary();
}

// ─── Table ──────────────────────────────────────────────────────────────────

const SPARK = { w: 84, h: 22, lo: 400, hi: 1600 };

// Fixed ppm scale, so curves are comparable between rows; the faint line marks 800 ppm.
function sparkline(j) {
  const r = j.readings;
  if (r.length < 2) return '';
  const { w, h, lo, hi } = SPARK;
  const y = v => (h - 1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo) * (h - 2)).toFixed(1);
  const pts = r.map((v, i) => `${(i / (r.length - 1) * w).toFixed(1)},${y(v)}`).join(' ');
  return `<svg class="tj-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
    + `<line x1="0" x2="${w}" y1="${y(800)}" y2="${y(800)}" stroke="#e5e7eb"/>`
    + `<polyline points="${pts}" fill="none" stroke="${zoneOf(j.avg).color}" stroke-width="1.5" stroke-linejoin="round"/>`
    + '</svg>';
}

function rowHtml(j) {
  const route = j.from || j.to ? `${j.from || '?'} → ${j.to || '?'}` : '';
  const sub = [j.modeLabel, j.network, j.countryLabel].filter(Boolean).join(' · ');
  return `<tr data-id="${j.id}"${j.id === selectedId ? ' class="selected"' : ''}>
    <td class="tj-when">${esc(dtf(j.tz, 'date').format(j.ts))}<span class="tj-sub">${esc(dtf(j.tz, 'time').format(j.ts))}</span></td>
    <td class="tj-line"><span class="tj-clip" title="${esc(j.line)}">${j.ref ? `<span class="tj-ref">${esc(j.ref)}</span>` : ''}${esc(j.lineShort || 'Unknown line')}</span><span class="tj-sub tj-clip" title="${esc(sub)}">${esc(sub)}</span></td>
    <td class="tj-route"><span class="tj-clip" title="${esc(route)}">${esc(route) || '&ndash;'}</span>${j.notes ? `<span class="tj-sub tj-clip tj-note" title="${esc(j.notes)}">${esc(j.notes)}</span>` : ''}</td>
    <td class="num">${j.duration != null ? `${j.duration} min` : '&ndash;'}</td>
    <td class="num"><span class="tj-dot" style="background:${zoneOf(j.avg).color}"></span>${j.avg}<span class="tj-sub">max ${j.max}</span></td>
    <td>${sparkline(j)}</td>
  </tr>`;
}

function renderTable() {
  const rows = matching.slice(0, shownCount);
  document.querySelector('#tj-table tbody').innerHTML = rows.length
    ? rows.map(rowHtml).join('')
    : '<tr><td colspan="6" class="no-data-msg">No journeys match. Try fewer search words or reset the filters.</td></tr>';

  document.querySelectorAll('#tj-table th[data-sort]').forEach(th => {
    const on = th.dataset.sort === state.sort;
    th.classList.toggle('sorted', on);
    th.classList.toggle('asc', on && state.asc);
  });

  const rest = matching.length - rows.length;
  let more = '';
  if (rest > 0) more += `<button type="button" class="tj-btn" data-more="${PAGE_SIZE}">Show ${Math.min(PAGE_SIZE, rest)} more</button>`;
  if (rest > PAGE_SIZE) {
    more += rest <= 1000
      ? `<button type="button" class="tj-btn" data-more="${rest}">Show all ${fmtInt(matching.length)}</button>`
      : `<button type="button" class="tj-btn" data-more="1000">Show 1,000 more</button>`;
  }
  $('tj-more').innerHTML = more;
}

function renderSummary() {
  const total = journeys.length, n = matching.length;
  const shown = Math.min(shownCount, n);
  const [what, ascLabel, descLabel] = SORT_LABELS[state.sort];
  const order = state.asc ? ascLabel : descLabel;
  const defaultSort = state.sort === 'ts' && !state.asc;

  let txt;
  if (!n) txt = `No journeys match (${fmtInt(total)} in total).`;
  else {
    txt = isFiltered()
      ? `<strong>${fmtInt(n)}</strong> of ${fmtInt(total)} journeys match. `
      : `${fmtInt(total)} journeys in total. `;
    if (defaultSort && shown < n) txt += `Showing the ${fmtInt(shown)} most recent.`;
    else if (defaultSort) txt += 'Showing all, most recent first.';
    else txt += `Showing ${shown === n ? 'all' : `the first ${fmtInt(shown)}`}, sorted by ${what} (${order}).`;

    const avgs = matching.map(j => j.avg).sort((a, b) => a - b);
    const mid = avgs.length >> 1;
    const med = avgs.length % 2 ? avgs[mid] : (avgs[mid - 1] + avgs[mid]) / 2;
    const pct = key => Math.round(matching.filter(j => zoneOf(j.avg).key === key).length / n * 100);
    txt += `<br>Median journey average <strong>${Math.round(med)} ppm</strong>; `
      + `${pct('good')}% of journeys average good, ${pct('unhealthy')}% unhealthy.`;

    const offMap = matching.slice(0, shown).filter(j => !j.path.length).length;
    if (offMap) txt += ` ${fmtInt(offMap)} shown journey${offMap === 1 ? ' has' : 's have'} no location and ${offMap === 1 ? 'is' : 'are'} not on the map.`;
  }
  $('tj-summary').innerHTML = txt;
}

// ─── Map ────────────────────────────────────────────────────────────────────

function initMap() {
  map = L.map('tj-map', { preferCanvas: true, worldCopyJump: true }).setView([50, 10], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  overviewLayer = L.featureGroup().addTo(map);
  selectedLayer = L.featureGroup().addTo(map);
}

function fitTo(layer, maxZoom) {
  const b = layer.getBounds();
  if (b.isValid()) map.fitBounds(b, { padding: [24, 24], maxZoom });
}

function renderOverview(fit) {
  overviewLayer.clearLayers();
  const shown = matching.slice(0, shownCount);
  for (const j of shown) {
    if (!j.path.length) continue;
    const color = zoneOf(j.avg).color;
    const layer = j.path.length > 1
      ? L.polyline(j.path, { color, weight: 3, opacity: 0.75 })
      : L.circleMarker(j.path[0], { radius: 4, color, weight: 2, fillOpacity: 0.6 });
    layer.bindTooltip(`${esc(j.line || j.modeLabel)}<br>${j.avg} ppm average`, { sticky: true });
    layer.on('click', () => select(j.id, { scrollRow: true }));
    overviewLayer.addLayer(layer);
  }
  // One shared canvas, so the highlighted journey has to be lifted back above the redrawn overview.
  selectedLayer.eachLayer(l => l.bringToFront());
  // Keep the view on the selected journey while it is still part of the list.
  if (fit && !shown.some(j => j.id === selectedId)) fitTo(overviewLayer, 13);
}

function drawSelected(j) {
  selectedLayer.clearLayers();
  if (!j || !j.path.length) return;
  const first = j.path[0], last = j.path[j.path.length - 1];
  if (j.path.length > 1) {
    L.polyline(j.path, { interactive: false, color: '#111827', weight: 9, opacity: 0.3 }).addTo(selectedLayer);
    L.polyline(j.path, { interactive: false, color: zoneOf(j.avg).color, weight: 5, opacity: 1 }).addTo(selectedLayer);
    L.circleMarker(last, { radius: 6, color: '#fff', weight: 2, fillColor: '#111827', fillOpacity: 1 })
      .bindTooltip(`End${j.to ? ': ' + esc(j.to) : ''}`).addTo(selectedLayer);
  }
  L.circleMarker(first, { radius: 6, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 })
    .bindTooltip(`Start${j.from ? ': ' + esc(j.from) : ''}`).addTo(selectedLayer);
  fitTo(selectedLayer, 15);
}

// ─── Selected journey ───────────────────────────────────────────────────────

function select(id, { scrollRow = false, reveal = false } = {}) {
  const j = id == null ? null : byId.get(id);
  selectedId = j ? j.id : null;

  document.querySelectorAll('#tj-table tbody tr.selected').forEach(tr => tr.classList.remove('selected'));
  const tr = j && document.querySelector(`#tj-table tbody tr[data-id="${j.id}"]`);
  if (tr) {
    tr.classList.add('selected');
    if (scrollRow) tr.scrollIntoView({ block: 'nearest' });
  }

  drawSelected(j);
  renderDetail(j);
  writeUrl();

  // In the single-column layout the map sits above the table.
  if (j && reveal && matchMedia('(max-width: 1000px)').matches) $('tj-side').scrollIntoView({ behavior: 'smooth' });
}

function renderDetail(j) {
  if (detailChart) { detailChart.destroy(); detailChart = null; }
  const panel = $('tj-detail-panel');
  if (!j) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const m = j.m;
  const rows = [
    ['Type', esc(j.modeLabel)],
    ['Line', osmLink(m.lineType, m.lineID, j.line || 'Unknown line')],
    ['Network', esc(j.network)],
    ['Operator', esc(j.operator)],
    ['From', j.from ? osmLink(m.originType, m.originID, j.from) : ''],
    ['To', j.to ? osmLink(m.destinationType, m.destinationID, j.to) : ''],
    ['Country', esc(j.countryLabel)],
    ['Start', `${esc(dtf(j.tz, 'full').format(j.ts))}${j.tz ? ` <span class="tj-sub" style="display:inline">${esc(j.tz)}</span>` : ''}`],
    ['Duration', j.duration != null
      ? `${j.duration} min <span class="tj-sub" style="display:inline">(${j.readings.length} readings, every ${j.interval} min)</span>`
      : `${j.readings.length} readings`],
    ['CO₂', `<span class="tj-dot" style="background:${zoneOf(j.avg).color}"></span>`
      + `<strong>${j.avg}</strong> ppm average &middot; ${j.min} min &middot; ${j.max} max`],
    ['Sensor', esc(j.sensor)],
    ['Notes', j.notes ? `<span class="tj-notes-full">${esc(j.notes)}</span>` : ''],
    ['ID', esc(j.id)],
  ].filter(([, v]) => v);

  $('tj-detail').innerHTML = `
    <h3>${j.ref ? `<span class="tj-ref">${esc(j.ref)}</span>` : ''}${esc(j.lineShort || 'Unknown line')}</h3>
    <div class="tj-sub">${esc([j.modeLabel, j.network].filter(Boolean).join(' · '))}</div>
    <div id="tj-detail-chart-wrap"><canvas id="tj-detail-chart"></canvas></div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="tj-detail-links">
      <button type="button" class="tj-btn" id="tj-copy-link">Copy link to this journey</button>
    </div>`;

  drawDetailChart(j);
}

// Dashed guides at the GO IAQS 800 / 1400 ppm boundaries.
const thresholdPlugin = {
  id: 'tjThresholds',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales: { y } } = chart;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    for (const [v, c] of [[800, '#ffb000'], [1400, '#ff190c']]) {
      if (v < y.min || v > y.max) continue;
      const py = y.getPixelForValue(v);
      ctx.strokeStyle = c;
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke();
    }
    ctx.restore();
  },
};

function drawDetailChart(j) {
  const wrap = $('tj-detail-chart-wrap');
  if (typeof Chart === 'undefined' || j.readings.length < 2) { wrap.style.display = 'none'; return; }
  const step = j.interval || 1;
  detailChart = new Chart($('tj-detail-chart'), {
    type: 'line',
    data: {
      labels: j.readings.map((_, i) => i * step),
      datasets: [{
        data: j.readings,
        borderWidth: 2,
        tension: 0.2,
        pointRadius: j.readings.length > 60 ? 0 : 2,
        pointHoverRadius: 4,
        pointBackgroundColor: j.readings.map(v => zoneOf(v).color),
        pointBorderWidth: 0,
        segment: { borderColor: c => zoneOf((c.p0.parsed.y + c.p1.parsed.y) / 2).color },
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: it => j.interval ? `${it[0].label} min` : `Reading ${it[0].dataIndex + 1}`,
            label: it => `${it.parsed.y} ppm`,
          },
        },
      },
      scales: {
        x: { title: { display: true, text: j.interval ? 'minutes since start' : 'reading' },
             ticks: { maxTicksLimit: 8 }, grid: { display: false } },
        y: { suggestedMin: 400, suggestedMax: 1000, title: { display: true, text: 'CO₂ (ppm)' } },
      },
    },
    plugins: [thresholdPlugin],
  });
}

// ─── URL state ──────────────────────────────────────────────────────────────

const URL_TEXT_KEYS = ['q', 'mode', 'country', 'aq', 'from', 'to'];

function readUrl() {
  const p = new URLSearchParams(location.search);
  for (const k of URL_TEXT_KEYS) if (p.has(k)) state[k] = p.get(k).trim();
  for (const k of ['from', 'to']) if (!/^\d{4}-\d{2}-\d{2}$/.test(state[k])) state[k] = '';
  state.notes = p.get('notes') === '1';
  const sort = p.get('sort');
  if (SORT_KEYS[sort]) {
    state.sort = sort;
    state.asc = p.has('dir') ? p.get('dir') === 'asc' : !DESC_FIRST.has(sort);
  }
  const id = parseInt(p.get('id'), 10);
  return Number.isFinite(id) ? id : null;
}

function writeUrl() {
  const p = new URLSearchParams();
  for (const k of URL_TEXT_KEYS) if (state[k]) p.set(k, state[k]);
  if (state.notes) p.set('notes', '1');
  if (state.sort !== DEFAULTS.sort || state.asc !== DEFAULTS.asc) {
    p.set('sort', state.sort);
    p.set('dir', state.asc ? 'asc' : 'desc');
  }
  if (selectedId != null) p.set('id', selectedId);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

function fillSelect(id, entries) {
  const sel = $(id);
  const first = sel.options[0];
  sel.replaceChildren(first, ...entries.map(([value, label]) => new Option(label, value)));
}

function populateSelects() {
  const counted = keyFn => {
    const c = new Map();
    for (const j of journeys) { const k = keyFn(j); c.set(k, (c.get(k) || 0) + 1); }
    return [...c].sort((a, b) => b[1] - a[1]);
  };
  fillSelect('tj-mode', counted(j => j.mode)
    .map(([v, n]) => [v, `${MODE_LABELS[v] || v} (${fmtInt(n)})`]));
  const names = new Map(journeys.map(j => [j.country, j.countryLabel]));
  fillSelect('tj-country', counted(j => j.country)
    .map(([v, n]) => [v, `${names.get(v)} (${fmtInt(n)})`]));

  const days = journeys.map(j => j.day).sort();
  for (const id of ['tj-from', 'tj-to']) { $(id).min = days[0]; $(id).max = days[days.length - 1]; }
}

function applyStateToInputs() {
  $('tj-search').value = state.q;
  for (const [id, key] of [['tj-mode', 'mode'], ['tj-country', 'country'], ['tj-aq', 'aq'],
                           ['tj-from', 'from'], ['tj-to', 'to']]) {
    $(id).value = state[key];
    state[key] = $(id).value;   // drops values (e.g. from an old link) the inputs don't offer
  }
  $('tj-notes').checked = state.notes;
}

function wireInputs() {
  let timer = null;
  $('tj-search').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value.trim(); refresh(); }, 200);
  });
  for (const [id, key] of [['tj-mode', 'mode'], ['tj-country', 'country'], ['tj-aq', 'aq'],
                           ['tj-from', 'from'], ['tj-to', 'to']]) {
    $(id).addEventListener('change', e => { state[key] = e.target.value; refresh(); });
  }
  $('tj-notes').addEventListener('change', e => { state.notes = e.target.checked; refresh(); });
  $('tj-reset').addEventListener('click', () => {
    Object.assign(state, DEFAULTS);
    applyStateToInputs();
    refresh();
  });

  document.querySelectorAll('#tj-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sort === col) state.asc = !state.asc;
      else { state.sort = col; state.asc = !DESC_FIRST.has(col); }
      refresh();
    });
  });

  document.querySelector('#tj-table tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    select(id === selectedId ? null : id, { reveal: true });
  });

  $('tj-more').addEventListener('click', e => {
    const btn = e.target.closest('button[data-more]');
    if (!btn) return;
    shownCount += Number(btn.dataset.more);
    render(false);
  });

  $('tj-close').addEventListener('click', () => select(null));

  $('tj-detail').addEventListener('click', async e => {
    const btn = e.target.closest('#tj-copy-link');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Link copied';
    } catch {
      prompt('Copy this link:', location.href);
    }
  });

  document.querySelectorAll('.an-panel-title').forEach(t => {
    t.addEventListener('click', e => {
      if (e.target.closest('.an-panel-title-actions')) return;
      t.parentElement.classList.toggle('collapsed');
      map?.invalidateSize();
    });
  });
}

/** Navbar dropdown. Wired here rather than with an inline onclick attribute,
 *  so the page contains no inline script and works under a strict CSP. */
function wireNavbar() {
  const btn = $('menu-btn');
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    btn.nextElementSibling.classList.toggle('show');
  });
  document.addEventListener('click', e => {
    document.querySelectorAll('.dropdown-content.show').forEach(d => {
      if (!d.previousElementSibling.contains(e.target)) d.classList.remove('show');
    });
  });
}

// ─── Load ───────────────────────────────────────────────────────────────────

async function init() {
  const loading = $('an-loading');
  const errorEl = $('an-error');
  const retryBtn = $('an-retry-btn');

  wireNavbar();
  wireInputs();
  initMap();

  async function load() {
    loading.style.display = 'flex';
    errorEl.style.display = 'none';
    retryBtn.style.display = 'none';
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      journeys = data.map(toJourney).filter(Boolean);
      byId.clear();
      for (const j of journeys) byId.set(j.id, j);

      populateSelects();
      // A linked journey gets the map's only fit; Leaflet drops a second fitBounds while the first animates.
      const urlId = readUrl();
      const linked = byId.has(urlId);
      applyStateToInputs();
      refresh(!linked);
      if (linked) select(urlId, { scrollRow: true });
      loading.style.display = 'none';
    } catch (err) {
      console.error(err);
      errorEl.textContent = `Failed to load data: ${err.message}`;
      errorEl.style.display = 'block';
      retryBtn.style.display = 'inline-block';
    }
  }

  retryBtn.addEventListener('click', load);
  await load();
}

document.addEventListener('DOMContentLoaded', init);
