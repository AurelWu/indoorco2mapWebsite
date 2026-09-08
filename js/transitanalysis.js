/* transitanalysis.js — Indoor CO2 Map, public transit analysis page. */

if (typeof ChartDataLabels !== 'undefined') Chart.unregister(ChartDataLabels);

const DATA_URL = 'https://s3.eu-central-1.amazonaws.com/indoorco2map.com/chartdata/IndoorCO2MapTransitData.json';

const ZONES = [
  { label: 'Good (<800 ppm)',         color: '#648eff', test: v => v < 800 },
  { label: 'Moderate (800\u20131400 ppm)', color: '#ffb000', test: v => v >= 800 && v <= 1400 },
  { label: 'Unhealthy (>1400 ppm)',   color: '#ff190c', test: v => v > 1400 },
];

function co2ToScore(ppm) {
  if (typeof ppm !== 'number' || isNaN(ppm)) return null;
  if (ppm <= 537)  return 10;
  if (ppm <= 712)  return 9;
  if (ppm <= 800)  return 8;
  if (ppm <= 900)  return 7;
  if (ppm <= 1100) return 6;
  if (ppm <= 1300) return 5;
  if (ppm <= 1400) return 4;
  if (ppm <= 2000) return 3;
  if (ppm <= 3200) return 2;
  if (ppm <= 4400) return 1;
  return 0;
}

function makeHatchPattern(color, rank) {
  const sz = 10;
  const c = Object.assign(document.createElement('canvas'), { width: sz, height: sz });
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, sz, sz);
  if (rank > 0) {
    const cfgs = [null,
      { opacity: 0.25, lineWidth: 1,   spacing: 8 },
      { opacity: 0.35, lineWidth: 1.5, spacing: 5 },
      { opacity: 0.45, lineWidth: 2,   spacing: 3 },
    ];
    const cfg = cfgs[rank];
    ctx.strokeStyle = `rgba(255,255,255,${cfg.opacity})`;
    ctx.lineWidth = cfg.lineWidth;
    ctx.beginPath();
    for (let i = -sz; i < sz * 2; i += cfg.spacing) {
      ctx.moveTo(i, 0); ctx.lineTo(i + sz, sz);
    }
    ctx.stroke();
  }
  return ctx.createPattern(c, 'repeat');
}

function scoreColor(score) {
  const base = score >= 8 ? '#648eff' : score >= 4 ? '#ffb000' : '#ff190c';
  const rank  = score >= 8 ? (10 - score) : score >= 4 ? (7 - score) : (3 - score);
  return makeHatchPattern(base, rank);
}

const MODE_LABELS = {
  train: 'Train', subway: 'Metro / Subway', tram: 'Tram',
  light_rail: 'Light rail / S-Bahn', bus: 'Bus', monorail: 'Monorail',
  unknown: 'Unknown route',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ─── State ──────────────────────────────────────────────────────────────────

let journeys = [];
let routes = {};
let lineNames = new Map();   // line key → display name
let mainChart = null;
let modeMS = null, networkMS = null, lineMS = null, countryMS = null;
let lastGroups = [];
let tableSort = { col: 'n', desc: true };

const state = {
  modes: [], modeExclude: false,
  networks: [], networkExclude: false,
  lines: [], lineExclude: false,
  countries: [], countryExclude: false,
  dateFrom: null, dateTo: null,
  months: null, weekdays: null, hours: null,   // null means all
  splitBy: 'mode', timePeriod: 'year', unit: 'weightedLine',
  minN: 5, limitN: 15, limitType: 'count', displayOrder: 'lowest',
  chartType: 'stacked', stackedMode: 'zones', pointMode: 'outliers', showMedian: true,
  matchRelations: false, cmpUnit: 'weightedLine', cmpPointMode: 'all', cmpShowMedian: false,
};

const SLOT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];
let slots = [];
let comparisonChart = null;
const mCounts = new Map(), nCounts = new Map(), lCounts = new Map(), cCounts = new Map();

// ─── Small helpers ──────────────────────────────────────────────────────────

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pctile = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const wpctile = (a, w, p) => {
  if (!a.length) return null;
  if (!w) return pctile(a, p);
  const idx = a.map((_, i) => i).sort((x, y) => a[x] - a[y]);
  const tot = w.reduce((s, x) => s + x, 0);
  let c = 0;
  for (const i of idx) { c += w[i]; if (c >= p * tot) return a[i]; }
  return a[idx[idx.length - 1]];
};
const share = (a, test, w) => {
  if (!a.length) return 0;
  if (!w) return a.filter(test).length / a.length * 100;
  const tot = w.reduce((s, x) => s + x, 0);
  return a.reduce((s, v, i) => s + (test(v) ? w[i] : 0), 0) / tot * 100;
};

function boxFences(values, weights) {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = wpctile(values, weights, 0.25);
  const med = wpctile(values, weights, 0.5);
  const q3 = wpctile(values, weights, 0.75);
  const iqr = q3 - q1;
  return { sorted, q1, med, q3, lo: q1 - 1.5 * iqr, hi: q3 + 1.5 * iqr };
}

// Boxplot lib accepts precomputed stats; empty outliers/items suppress all dots,
// so whiskerMin/Max must be explicit (it would otherwise derive them from items).
function weightedBoxStats(values, weights) {
  const { sorted, q1, med, q3, lo, hi } = boxFences(values, weights);
  let wMin = sorted[0], wMax = sorted[sorted.length - 1];
  for (const v of sorted) if (v >= lo) { wMin = v; break; }
  for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] <= hi) { wMax = sorted[i]; break; }
  return {
    min: sorted[0], max: sorted[sorted.length - 1],
    q1, median: med, q3, whiskerMin: wMin, whiskerMax: wMax,
    outliers: [], items: [],
  };
}

// Unsnapped upper fence, so never below the whisker the library actually draws.
function whiskerCap(values, weights) {
  const { sorted, hi } = boxFences(values, weights);
  return Math.min(sorted[sorted.length - 1], hi);
}
const pad2 = n => String(n).padStart(2, '0');
const isoDay = ts => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};


// ─── Multi-select widget (same behaviour as the buildings page) ─────────────

function makeMultiSelect({ placeholder, withSearch, onChange }) {
  const selected = new Set();
  const labels = new Map();

  const wrap = document.createElement('div');
  wrap.className = 'ms-wrap';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ms-trigger';
  trigger.textContent = placeholder;
  wrap.appendChild(trigger);

  const panel = document.createElement('div');
  panel.className = 'ms-panel';
  panel.style.display = 'none';

  let searchEl = null;
  if (withSearch) {
    searchEl = document.createElement('input');
    searchEl.type = 'text';
    searchEl.placeholder = 'Search\u2026';
    searchEl.className = 'ms-search';
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.toLowerCase();
      list.querySelectorAll('.ms-item').forEach(i => {
        i.style.display = !q || i.dataset.label.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    panel.appendChild(searchEl);
  }

  const list = document.createElement('div');
  list.className = 'ms-list';
  panel.appendChild(list);
  wrap.appendChild(panel);

  function updateTrigger() {
    if (!selected.size) { trigger.textContent = placeholder; trigger.title = ''; return; }
    const l = [...selected].map(v => labels.get(v) || v);
    trigger.textContent = l.length <= 2 ? l.join(', ') : `${l.length} selected`;
    trigger.title = l.join(', ');
  }

  function repopulate(opts) {
    for (const o of opts) labels.set(o.value, o.displayLabel || o.label);
    list.innerHTML = '';
    for (const o of opts) {
      const lbl = document.createElement('label');
      lbl.className = 'ms-item';
      lbl.dataset.label = o.label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = o.value;
      cb.checked = selected.has(o.value);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(o.value); else selected.delete(o.value);
        updateTrigger();
        onChange([...selected]);
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + o.label));
      list.appendChild(lbl);
    }
    updateTrigger();
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = panel.style.display !== 'none';
    document.querySelectorAll('.ms-panel').forEach(p => { p.style.display = 'none'; });
    if (!open) {
      panel.style.display = 'block';
      if (searchEl) {
        searchEl.value = '';
        list.querySelectorAll('.ms-item').forEach(i => { i.style.display = ''; });
        searchEl.focus();
      }
    }
  });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) panel.style.display = 'none';
  });

  function setValues(vals) {
    selected.clear();
    for (const v of vals) selected.add(v);
    list.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = selected.has(cb.value); });
    updateTrigger();
  }

  return { el: wrap, repopulate, setValues, getValues: () => [...selected] };
}

// Exclude toggle for a dynamically created multi-select (slot rows).
function makeExcludeToggleMS(ms, initialExclude, onChange) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Toggle include / exclude';

  const startExclude = initialExclude && ms.getValues().length > 0;
  btn.className = 'filter-mode-btn' + (startExclude ? ' exclude' : '');
  btn.textContent = startExclude ? '≠' : '=';
  ms.el.classList.toggle('exclude-mode', startExclude);
  btn.disabled = ms.getValues().length === 0;

  btn._sync = () => {
    const empty = ms.getValues().length === 0;
    btn.disabled = empty;
    if (empty && btn.classList.contains('exclude')) {
      btn.classList.remove('exclude');
      ms.el.classList.remove('exclude-mode');
      btn.textContent = '=';
      onChange(false);
    }
  };

  btn.addEventListener('click', () => {
    const ex = !btn.classList.contains('exclude');
    btn.classList.toggle('exclude', ex);
    btn.textContent = ex ? '≠' : '=';
    ms.el.classList.toggle('exclude-mode', ex);
    onChange(ex);
  });

  return btn;
}

function wireExclude(btnId, onChange) {
  const btn = document.getElementById(btnId);
  btn.addEventListener('click', () => {
    const ex = !btn.classList.contains('exclude');
    btn.classList.toggle('exclude', ex);
    btn.textContent = ex ? '\u2260' : '=';
    onChange(ex);
  });
}

// ─── Chips ──────────────────────────────────────────────────────────────────

function buildChips(containerId, items, key) {
  const box = document.getElementById(containerId);
  box.innerHTML = '';
  items.forEach(it => {
    const c = document.createElement('span');
    c.className = 'chip active';
    c.textContent = it.label;
    c.dataset.value = it.value;
    c.addEventListener('click', () => {
      c.classList.toggle('active');
      readChips(containerId, key);
      update();
    });
    box.appendChild(c);
  });
}

function readChips(containerId, key) {
  const chips = [...document.querySelectorAll(`#${containerId} .chip`)];
  const on = chips.filter(c => c.classList.contains('active')).map(c => +c.dataset.value);
  state[key] = on.length === chips.length ? null : new Set(on);
}

function setChips(containerId, key, on) {
  document.querySelectorAll(`#${containerId} .chip`).forEach(c => c.classList.toggle('active', on));
  readChips(containerId, key);
}

// ─── Filtering ──────────────────────────────────────────────────────────────

function passesFilters(j, f = state) {
  if (f.modes.length) {
    const m = f.modes.includes(j.mode);
    if (f.modeExclude ? m : !m) return false;
  }
  if (f.networks.length) {
    const m = j.networks.some(n => f.networks.includes(n));
    if (f.networkExclude ? m : !m) return false;
  }
  if (f.lines.length) {
    const m = f.lines.includes(j.lineKey);
    if (f.lineExclude ? m : !m) return false;
  }
  if (f.countries.length) {
    const m = f.countries.includes(j.country);
    if (f.countryExclude ? m : !m) return false;
  }
  if (f.dateFrom != null && j.ts < f.dateFrom) return false;
  if (f.dateTo != null && j.ts > f.dateTo) return false;
  if (f.months && !f.months.has(j.month)) return false;
  if (f.weekdays && !f.weekdays.has(j.weekday)) return false;
  if (f.hours && !f.hours.has(j.hour)) return false;
  return true;
}

// Turn journeys into chart values honouring the "One data point per" setting.
function valuesForUnit(js, unit = state.unit) {
  if (unit === 'line' || unit === 'weightedLine') {
    const perLine = new Map();
    for (const j of js) {
      if (!perLine.has(j.lineKey)) perLine.set(j.lineKey, []);
      perLine.get(j.lineKey).push(j.ppmAvg);
    }
    if (unit === 'line') {
      return { values: [...perLine.values()].map(v => v.reduce((s, x) => s + x, 0) / v.length), weights: null };
    }
    const values = [], weights = [];
    for (const lineVals of perLine.values()) {
      const w = 1 / lineVals.length;
      for (const v of lineVals) { values.push(v); weights.push(w); }
    }
    return { values, weights };
  }
  return { values: js.map(j => j.ppmAvg), weights: null };
}

// ─── Grouping ───────────────────────────────────────────────────────────────

function timeKey(j) {
  switch (state.timePeriod) {
    case 'year':    return String(j.year);
    case 'month':   return MONTHS[j.month];
    case 'weekday': return WEEKDAYS[j.weekday];
    case 'weekend': return (j.weekday === 0 || j.weekday === 6) ? 'Weekend' : 'Mon\u2013Fri';
    case 'hour4': {
      const b = Math.floor(j.hour / 4) * 4;
      return `${pad2(b)}:00\u2013${pad2(b + 3)}:59`;
    }
    default: return 'All';
  }
}

const NATURAL_ORDER = {
  month: MONTHS,
  weekday: WEEKDAYS,
  weekend: ['Mon\u2013Fri', 'Weekend'],
};

function groupKeys(j) {
  switch (state.splitBy) {
    case 'mode':    return [j.mode];
    case 'network': return j.networks.length ? j.networks : ['\u2014'];
    case 'country': return [j.country || 'Unknown'];
    case 'line':    return [j.lineKey];
    case 'time':    return [timeKey(j)];
    default:        return ['All journeys'];
  }
}

function labelFor(key) {
  if (state.splitBy === 'mode') return MODE_LABELS[key] || key;
  if (state.splitBy === 'line') return lineNames.get(key) || key;
  return key;
}

function buildGroups(recs) {
  const byKey = new Map();
  for (const j of recs) {
    for (const k of groupKeys(j)) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(j);
    }
  }

  let groups = [];
  for (const [key, js] of byKey) {
    if (js.length < state.minN) continue;
    const { values, weights } = valuesForUnit(js);
    if (!values.length) continue;
    groups.push({
      key, label: labelFor(key), values, weights,
      n: js.length,
      lines: new Set(js.map(j => j.lineKey)).size,
      median: weights ? wpctile(values, weights, 0.5) : median(values),
      p90: weights ? wpctile(values, weights, 0.9) : pctile(values, 0.9),
      good: share(values, v => v < 800, weights),
      bad: share(values, v => v > 1400, weights),
    });
  }

  const natural = state.splitBy === 'time' ? NATURAL_ORDER[state.timePeriod] : null;
  const by = {
    count:   (a, b) => b.n - a.n,
    highest: (a, b) => b.median - a.median,
    lowest:  (a, b) => a.median - b.median,
    natural: (a, b) => natural
      ? natural.indexOf(a.key) - natural.indexOf(b.key)
      : String(a.key).localeCompare(String(b.key), undefined, { numeric: true }),
  };

  groups.sort(by[state.limitType] || by.count);
  groups = groups.slice(0, state.limitN);
  groups.sort(by[state.displayOrder] || by.lowest);
  return groups;
}

// ─── Charts ─────────────────────────────────────────────────────────────────

// Draws median value labels on the horizontal boxplot (value axis = x).
const medianLabelPlugin = {
  id: 'transitMedianLabels',
  afterDatasetsDraw(chart) {
    if (!state.showMedian) return;
    const { ctx, scales } = chart;
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      dataset.data.forEach((vals, i) => {
        const el = meta.data[i];
        if (!el) return;
        let med;
        if (Array.isArray(vals)) {
          const sorted = vals.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
          if (!sorted.length) return;
          const n = sorted.length;
          med = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
        } else if (vals && typeof vals.median === 'number') {
          med = vals.median;
        } else return;
        const xPx = scales.x.getPixelForValue(med);
        const text = String(Math.round(med));
        ctx.save();
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillText(text, xPx, el.y);
        ctx.restore();
      });
    });
  },
};

function drawChart(groups) {
  if (mainChart) { mainChart.destroy(); mainChart = null; }
  const summary = document.getElementById('chart-summary');
  const ctx = document.getElementById('main-chart');

  if (!groups.length) {
    summary.innerHTML = '<div class="no-data-msg">No journeys match these filters.</div>';
    return;
  }

  document.getElementById('main-chart-wrap').style.height =
    Math.max(300, 70 + groups.length * 34) + 'px';

  const labels = groups.map(g => `${g.label} (n=${g.n})`);
  const font = { family: '"Titillium Web", system-ui, sans-serif' };

  if (state.chartType === 'stacked') {
    const scoreMode = state.stackedMode === 'score';
    const catDefs = scoreMode
      ? [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(s => ({
          label: `Score ${s}`,
          color: scoreColor(s),
          test: v => co2ToScore(v) === s,
        }))
      : ZONES;

    mainChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: catDefs.map(z => ({
          label: z.label,
          backgroundColor: z.color,
          data: groups.map(g => share(g.values, z.test, g.weights)),
          datalabels: {
            display: ctx => ctx.dataset.data[ctx.dataIndex] >= 5,
            color: '#fff',
            font: { size: 12, weight: 'bold', family: '"Titillium Web", system-ui, sans-serif' },
            formatter: v => Math.round(v) + '%',
          },
        })),
      },
      options: {
        indexAxis: 'y', maintainAspectRatio: false,
        scales: {
          x: { stacked: true, max: 100, title: { display: true,
               text: state.unit === 'weightedLine' ? '% (line-weighted)' : '% of data points', font } },
          y: { stacked: true, ticks: { font } },
        },
        plugins: {
          datalabels: {},
          legend: { position: 'bottom', labels: { font } },
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.raw.toFixed(1)}%` } },
        },
      },
      plugins: [ChartDataLabels],
    });
  } else {
    // No dots on screen means nothing lives past the whiskers, so tighten the axis.
    const noDots = state.unit === 'weightedLine' || state.pointMode === 'none';
    const xMax = noDots
      ? Math.round(Math.max(...groups.map(g => whiskerCap(g.values, g.weights))) * 1.05)
      : undefined;

    mainChart = new Chart(ctx, {
      type: 'boxplot',
      data: {
        labels,
        datasets: [{
          label: 'CO2 (ppm)',
          data: groups.map(g => g.weights ? weightedBoxStats(g.values, g.weights) : g.values),
          backgroundColor: 'rgba(59,130,246,0.25)',
          borderColor: '#3B82F6',
          itemRadius: state.unit === 'weightedLine' ? 0 : (state.pointMode === 'all' ? 2 : 0),
          outlierRadius: state.unit === 'weightedLine' ? 0 : (state.pointMode === 'none' ? 0 : 3),
        }],
      },
      options: {
        indexAxis: 'y', maintainAspectRatio: false,
        scales: {
          x: { min: 400, max: xMax, title: { display: true, text: 'CO\u2082 (ppm)', font } },
          y: { ticks: { font } },
        },
        plugins: { legend: { display: false } },
      },
      plugins: [medianLabelPlugin],
    });
  }

  const all = groups.flatMap(g => g.values);
  const allW = groups.some(g => g.weights)
    ? groups.flatMap(g => g.weights ?? g.values.map(() => 1))
    : null;
  const unit = state.unit === 'line' ? 'line averages'
    : state.unit === 'weightedLine' ? 'journeys (line-weighted)'
    : 'journeys';
  summary.innerHTML =
    `<strong>${all.length}</strong> ${unit} in <strong>${groups.length}</strong> groups, ` +
    `overall median <strong>${Math.round(wpctile(all, allW, 0.5))} ppm</strong>`;
}

function drawTable(groups) {
  const tb = document.querySelector('#tr-table tbody');
  document.querySelectorAll('#tr-table th').forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === tableSort.col);
    th.classList.toggle('asc', th.dataset.sort === tableSort.col && !tableSort.desc);
  });

  const rows = [...groups].sort((a, b) => {
    const c = tableSort.col;
    const va = c === 'label' ? a.label : a[c];
    const vb = c === 'label' ? b.label : b[c];
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return tableSort.desc ? -cmp : cmp;
  });

  tb.innerHTML = rows.map(g => `
    <tr>
      <td>${g.label}</td>
      <td>${g.n}</td>
      <td>${g.lines}</td>
      <td>${Math.round(g.median)}</td>
      <td>${Math.round(g.p90)}</td>
      <td>${g.good.toFixed(0)}%</td>
      <td>${g.bad.toFixed(0)}%</td>
    </tr>`).join('');
}

// ─── Filter option lists ────────────────────────────────────────────────────

function populateFilters() {
  mCounts.clear(); nCounts.clear(); lCounts.clear(); cCounts.clear();
  for (const j of journeys) {
    mCounts.set(j.mode, (mCounts.get(j.mode) || 0) + 1);
    for (const n of j.networks) nCounts.set(n, (nCounts.get(n) || 0) + 1);
    lCounts.set(j.lineKey, (lCounts.get(j.lineKey) || 0) + 1);
    const c = j.country || 'Unknown';
    cCounts.set(c, (cCounts.get(c) || 0) + 1);
  }
  const opts = (map, lab) => [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v, n]) => ({ value: v, label: `${lab(v)} (${n})`, displayLabel: lab(v) }));

  modeMS.repopulate(opts(mCounts, v => MODE_LABELS[v] || v));
  networkMS.repopulate(opts(nCounts, v => v));
  lineMS.repopulate(opts(lCounts, v => lineNames.get(v) || v));
  countryMS.repopulate(opts(cCounts, v => v));
}

function updateCoverage() {
  const noMeta = journeys.filter(j => j.mode === 'unknown').length;
  const days = new Set(journeys.map(j => isoDay(j.ts))).size;
  const first = isoDay(Math.min(...journeys.map(j => j.ts)));
  const last = isoDay(Math.max(...journeys.map(j => j.ts)));
  document.getElementById('coverage-body').innerHTML = `
    <div>Journeys loaded: <strong>${journeys.length}</strong>, on
      <strong>${new Set(journeys.map(j => j.lineKey)).size}</strong> distinct lines.</div>
    <div>Measured on <strong>${days}</strong> separate days, from <strong>${first}</strong> to <strong>${last}</strong>.</div>
    <div>Journeys without a vehicle type or network: <strong>${noMeta}</strong>
      (${(noMeta / journeys.length * 100).toFixed(0)}%). These are grouped as &ldquo;Unknown route&rdquo;.</div>`;
}

// ─── Comparison slots ───────────────────────────────────────────────────────

function newSlot() {
  return {
    modes: [], modeExclude: false,
    networks: [], networkExclude: false,
    lines: [], lineExclude: false,
    countries: [], countryExclude: false,
    overrideTime: false,
    months: null, weekdays: null, hours: null,
    color: SLOT_COLORS[slots.length],
    label: 'All journeys',
  };
}

function slotLabel(slot) {
  const parts = [];
  const add = (vals, exclude, fmt) => {
    if (vals.length) parts.push((exclude ? 'All except ' : '') + vals.map(fmt).join(', '));
  };
  add(slot.modes, slot.modeExclude, v => MODE_LABELS[v] || v);
  add(slot.networks, slot.networkExclude, v => v);
  add(slot.lines, slot.lineExclude, v => lineNames.get(v) || v);
  add(slot.countries, slot.countryExclude, v => v);
  return parts.length ? parts.join(' · ') : 'All journeys';
}

// Slot inherits the page-level time filters unless it overrides them.
function slotFilter(slot) {
  return {
    modes: slot.modes, modeExclude: slot.modeExclude,
    networks: slot.networks, networkExclude: slot.networkExclude,
    lines: slot.lines, lineExclude: slot.lineExclude,
    countries: slot.countries, countryExclude: slot.countryExclude,
    dateFrom: state.dateFrom, dateTo: state.dateTo,
    months:   slot.overrideTime ? slot.months   : state.months,
    weekdays: slot.overrideTime ? slot.weekdays : state.weekdays,
    hours:    slot.overrideTime ? slot.hours    : state.hours,
  };
}

function makeSlotTimePanel(slot) {
  const panel = document.createElement('div');
  panel.className = 'slot-time-panel';
  panel.style.borderLeftColor = slot.color;
  if (!slot.overrideTime) panel.style.display = 'none';

  const addGroup = (label, items, key, total) => {
    const wrap = document.createElement('div');
    wrap.className = 'time-filter-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'time-filter-label';
    labelEl.textContent = label + ' ';

    const chipGroup = document.createElement('div');
    chipGroup.className = 'chip-group';

    const mkBtn = (text, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip-ctrl'; b.textContent = text;
      b.addEventListener('click', fn);
      labelEl.appendChild(b);
    };
    mkBtn('All', () => {
      chipGroup.querySelectorAll('.chip').forEach(c => c.classList.add('active'));
      slot[key] = null; updateComparisonChart();
    });
    mkBtn('None', () => {
      chipGroup.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      slot[key] = new Set(); updateComparisonChart();
    });

    items.forEach(({ l, v }) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (!slot[key] || slot[key].has(v) ? ' active' : '');
      chip.textContent = l;
      chip.dataset.value = v;
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        const active = [...chipGroup.querySelectorAll('.chip.active')].map(c => +c.dataset.value);
        slot[key] = active.length === total ? null : new Set(active);
        updateComparisonChart();
      });
      chipGroup.appendChild(chip);
    });

    wrap.appendChild(labelEl);
    wrap.appendChild(chipGroup);
    panel.appendChild(wrap);
  };

  addGroup('Months', MONTHS.map((l, i) => ({ l, v: i })), 'months', 12);
  addGroup('Days', WEEKDAYS.map((l, i) => ({ l, v: i })), 'weekdays', 7);
  addGroup('Hours UTC', Array.from({ length: 24 }, (_, i) => ({ l: pad2(i), v: i })), 'hours', 24);
  return panel;
}

function renderSlots() {
  const container = document.getElementById('slots-container');
  container.innerHTML = '';

  slots.forEach((slot, idx) => {
    const slotWrap = document.createElement('div');
    slotWrap.className = 'slot-wrap';

    const row = document.createElement('div');
    row.className = 'slot-row' + (slot.overrideTime ? ' has-time-panel' : '');
    row.style.borderLeftColor = slot.color;

    const dot = document.createElement('span');
    dot.className = 'slot-color-dot';
    dot.style.background = slot.color;

    const labelEl = document.createElement('div');
    labelEl.className = 'slot-label';
    labelEl.textContent = slot.label;

    const relabel = () => { slot.label = slotLabel(slot); labelEl.textContent = slot.label; };

    row.appendChild(dot);
    row.appendChild(labelEl);

    // One multi-select + exclude toggle per filter, mirroring the page filters.
    const FIELDS = [
      { key: 'modes',     ex: 'modeExclude',    ph: 'All types',     search: false, src: () => mCounts,  fmt: v => MODE_LABELS[v] || v },
      { key: 'networks',  ex: 'networkExclude', ph: 'All networks',  search: true,  src: () => nCounts,  fmt: v => v },
      { key: 'lines',     ex: 'lineExclude',    ph: 'All lines',     search: true,  src: () => lCounts,  fmt: v => lineNames.get(v) || v },
      { key: 'countries', ex: 'countryExclude', ph: 'All countries', search: true,  src: () => cCounts,  fmt: v => v },
    ];

    for (const f of FIELDS) {
      const wrap = document.createElement('div');
      wrap.className = 'filter-mode-wrap';
      const ms = makeMultiSelect({
        placeholder: f.ph, withSearch: f.search,
        onChange: vals => { slot[f.key] = vals; toggle._sync(); relabel(); updateComparisonChart(); },
      });
      ms.repopulate([...f.src().entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([v, n]) => ({ value: v, label: `${f.fmt(v)} (${n})`, displayLabel: f.fmt(v) })));
      ms.setValues(slot[f.key]);
      const toggle = makeExcludeToggleMS(ms, slot[f.ex], v => { slot[f.ex] = v; relabel(); updateComparisonChart(); });
      wrap.appendChild(toggle);
      wrap.appendChild(ms.el);
      row.appendChild(wrap);
    }

    const timePanel = makeSlotTimePanel(slot);

    const timeBtn = document.createElement('button');
    timeBtn.type = 'button';
    timeBtn.className = 'slot-time-toggle' + (slot.overrideTime ? ' active' : '');
    timeBtn.textContent = '⏱';
    timeBtn.title = 'Override time filters for this group';
    timeBtn.addEventListener('click', () => {
      slot.overrideTime = !slot.overrideTime;
      timeBtn.classList.toggle('active', slot.overrideTime);
      row.classList.toggle('has-time-panel', slot.overrideTime);
      timePanel.style.display = slot.overrideTime ? '' : 'none';
      updateComparisonChart();
    });
    row.appendChild(timeBtn);

    const moveWrap = document.createElement('div');
    moveWrap.className = 'slot-move-wrap';
    const mkMove = (text, delta, disabled) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'slot-move'; b.textContent = text; b.disabled = disabled;
      b.addEventListener('click', () => {
        const t = slots[idx + delta];
        slots[idx + delta] = slots[idx];
        slots[idx] = t;
        slots.forEach((s, i) => { s.color = SLOT_COLORS[i]; });
        renderSlots(); updateComparisonChart();
      });
      moveWrap.appendChild(b);
    };
    mkMove('▲', -1, idx === 0);
    mkMove('▼', 1, idx === slots.length - 1);
    row.appendChild(moveWrap);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'slot-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove this group';
    removeBtn.addEventListener('click', () => {
      slots.splice(idx, 1);
      slots.forEach((s, i) => { s.color = SLOT_COLORS[i]; });
      renderSlots(); updateAddSlotBtn(); updateComparisonChart();
    });
    row.appendChild(removeBtn);

    slotWrap.appendChild(row);
    slotWrap.appendChild(timePanel);
    container.appendChild(slotWrap);
  });
}

function updateAddSlotBtn() {
  document.getElementById('add-slot-btn').disabled = slots.length >= 5;
  document.getElementById('duplicate-slot-btn').disabled = slots.length === 0 || slots.length >= 5;
}

function addSlot() {
  if (slots.length >= 5) return;
  slots.push(newSlot());
  renderSlots(); updateAddSlotBtn(); updateComparisonChart();
}

function duplicateLastSlot() {
  if (!slots.length || slots.length >= 5) return;
  const s = slots[slots.length - 1];
  slots.push({
    ...s,
    modes: [...s.modes], networks: [...s.networks],
    lines: [...s.lines], countries: [...s.countries],
    months:   s.months   ? new Set(s.months)   : null,
    weekdays: s.weekdays ? new Set(s.weekdays) : null,
    hours:    s.hours    ? new Set(s.hours)    : null,
    color: SLOT_COLORS[slots.length],
  });
  renderSlots(); updateAddSlotBtn(); updateComparisonChart();
}

function updateComparisonChart() {
  // Weighted mode draws no individual points, so those options do not apply.
  document.getElementById('cmp-point-mode-opts').style.display =
    state.cmpUnit === 'weightedLine' ? 'none' : 'contents';

  const perSlot = slots.map(s => journeys.filter(j => passesFilters(j, slotFilter(s))));

  // Relation matching: keep only lines present in every group, so the groups
  // describe the same set of lines rather than different ones.
  let matched = null;
  if (state.matchRelations && slots.length > 1) {
    const sets = perSlot.map(recs => new Set(recs.map(j => j.lineKey)));
    matched = sets.reduce((a, b) => new Set([...a].filter(k => b.has(k))));
  }

  const slotData = slots.map((slot, i) => {
    const recs = matched ? perSlot[i].filter(j => matched.has(j.lineKey)) : perSlot[i];
    const { values, weights } = valuesForUnit(recs, state.cmpUnit);
    return {
      label: slot.label, color: slot.color, values, weights,
      count: values.length, lines: new Set(recs.map(j => j.lineKey)).size,
    };
  });

  renderComparisonChart(slotData, matched);
}

function renderComparisonChart(slotData, matched) {
  const wrap = document.getElementById('comparison-chart-wrap');
  const note = document.getElementById('comparison-note');

  if (comparisonChart) { comparisonChart.destroy(); comparisonChart = null; }

  if (!slotData.length) {
    wrap.innerHTML = '<div class="no-data-msg">Add at least one filter set to see the comparison.</div>';
    note.textContent = '';
    return;
  }

  let canvas = document.getElementById('comparison-chart');
  if (!canvas || !canvas.parentElement) {
    wrap.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.id = 'comparison-chart';
    wrap.appendChild(canvas);
  }

  const withData = slotData.filter(s => s.values.length);
  if (!withData.length) {
    wrap.innerHTML = '<div class="no-data-msg">No journeys match these filter sets.</div>';
    note.textContent = matched ? 'No transit lines appear in every group.' : '';
    return;
  }

  const font = { family: '"Titillium Web", system-ui, sans-serif' };
  const noDots = state.cmpUnit === 'weightedLine' || state.cmpPointMode === 'none';
  const xMax = noDots
    ? Math.round(Math.max(...withData.map(s => whiskerCap(s.values, s.weights))) * 1.05)
    : undefined;

  comparisonChart = new Chart(canvas, {
    type: 'boxplot',
    data: {
      labels: slotData.map(s => s.values.length ? `${s.label} (n=${s.count})` : `${s.label} (no data)`),
      datasets: [{
        label: 'Comparison',
        data: slotData.map(s => s.weights ? weightedBoxStats(s.values, s.weights) : s.values),
        backgroundColor: slotData.map(s => s.color + '40'),
        borderColor: slotData.map(s => s.color),
        borderWidth: 1.5,
        itemRadius: noDots ? 0 : (state.cmpPointMode === 'all' ? 3 : 0),
        itemStyle: 'circle',
        itemBackgroundColor: slotData.map(s => s.color + '80'),
        itemBorderWidth: 0,
        outlierRadius: noDots ? 0 : 4,
        outlierBackgroundColor: slotData.map(s => s.color + 'AA'),
      }],
    },
    options: {
      indexAxis: 'y', maintainAspectRatio: false,
      scales: {
        x: { min: 400, max: xMax, title: { display: true, text: 'CO₂ (ppm)', font } },
        y: { ticks: { font } },
      },
      plugins: { legend: { display: false } },
    },
    plugins: [cmpMedianLabelPlugin],
  });

  note.textContent = matched
    ? `Matched on ${matched.size} transit line${matched.size === 1 ? '' : 's'} present in every group.`
    : '';
}

const cmpMedianLabelPlugin = {
  id: 'cmpMedianLabels',
  afterDatasetsDraw(chart) {
    if (!state.cmpShowMedian) return;
    const { ctx, scales } = chart;
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      dataset.data.forEach((vals, i) => {
        const el = meta.data[i];
        if (!el) return;
        let med;
        if (Array.isArray(vals)) {
          const sorted = vals.filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
          if (!sorted.length) return;
          const n = sorted.length;
          med = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
        } else if (vals && typeof vals.median === 'number') {
          med = vals.median;
        } else return;
        ctx.save();
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillText(String(Math.round(med)), scales.x.getPixelForValue(med), el.y);
        ctx.restore();
      });
    });
  },
};

// ─── Wiring ─────────────────────────────────────────────────────────────────

function update() {
  document.getElementById('limit-row').style.display = state.splitBy === 'none' ? 'none' : '';
  document.getElementById('time-period-wrap').style.display = state.splitBy === 'time' ? 'flex' : 'none';
  document.getElementById('box-points').style.display = state.chartType === 'boxplot' ? '' : 'none';
  document.getElementById('point-mode-opts').style.display =
    state.unit === 'weightedLine' ? 'none' : 'contents';
  document.getElementById('stacked-mode-wrap').style.display = state.chartType === 'stacked' ? 'flex' : 'none';
  const trLegend = document.getElementById('tr-legend');
  if (trLegend) trLegend.style.display = (state.chartType === 'stacked' && state.stackedMode === 'zones') ? '' : 'none';

  lastGroups = buildGroups(journeys.filter(j => passesFilters(j)));
  drawChart(lastGroups);
  drawTable(lastGroups);
  if (slots.length) updateComparisonChart();
}

function wireEvents() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(e => e.addEventListener(ev, fn));

  on('input[name=split]', 'change', e => { state.splitBy = e.target.value; update(); });
  on('input[name=unit]', 'change', e => { state.unit = e.target.value; update(); });
  on('input[name=chart-type]', 'change', e => { state.chartType = e.target.value; update(); });
  on('input[name=point-mode]', 'change', e => { state.pointMode = e.target.value; update(); });
  on('input[name=show-median]', 'change', e => { state.showMedian = e.target.checked; update(); });
  on('input[name=stacked-mode]', 'change', e => { state.stackedMode = e.target.value; update(); });

  on('input[name=unit-cmp]', 'change', e => { state.cmpUnit = e.target.value; updateComparisonChart(); });
  on('input[name=point-mode-cmp]', 'change', e => { state.cmpPointMode = e.target.value; updateComparisonChart(); });
  document.getElementById('match-relations').addEventListener('change', e => {
    state.matchRelations = e.target.checked;
    updateComparisonChart();
  });
  document.getElementById('show-median-cmp').addEventListener('change', e => {
    state.cmpShowMedian = e.target.checked;
    updateComparisonChart();
  });
  document.getElementById('add-slot-btn').addEventListener('click', addSlot);
  document.getElementById('duplicate-slot-btn').addEventListener('click', duplicateLastSlot);
  document.getElementById('toggle-comparison').addEventListener('click', () => {
    const body = document.getElementById('comparison-body');
    const btn = document.getElementById('toggle-comparison');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    btn.textContent = hidden ? 'Hide' : 'Show';
    if (hidden) comparisonChart?.resize();
  });
  updateAddSlotBtn();

  document.getElementById('time-period-select').addEventListener('change', e => {
    state.timePeriod = e.target.value;
    document.getElementById('display-order').value = 'natural';
    state.displayOrder = 'natural';
    update();
  });

  document.getElementById('min-n').addEventListener('input', e => { state.minN = +e.target.value || 1; update(); });
  document.getElementById('limit-n').addEventListener('input', e => { state.limitN = +e.target.value || 10; update(); });
  document.getElementById('limit-type').addEventListener('change', e => { state.limitType = e.target.value; update(); });
  document.getElementById('display-order').addEventListener('change', e => { state.displayOrder = e.target.value; update(); });

  const dFrom = document.getElementById('date-from');
  const dTo = document.getElementById('date-to');
  dFrom.addEventListener('change', () => {
    state.dateFrom = dFrom.value ? Date.parse(dFrom.value + 'T00:00:00Z') : null; update();
  });
  dTo.addEventListener('change', () => {
    state.dateTo = dTo.value ? Date.parse(dTo.value + 'T23:59:59Z') : null; update();
  });

  const setRange = months => {
    const max = Math.max(...journeys.map(j => j.ts));
    const from = months ? max - months * 30.44 * 864e5 : Math.min(...journeys.map(j => j.ts));
    dFrom.value = isoDay(from);
    dTo.value = isoDay(max);
    state.dateFrom = months ? from : null;
    state.dateTo = null;
    update();
  };
  document.getElementById('preset-all').addEventListener('click', () => setRange(0));
  document.getElementById('preset-12m').addEventListener('click', () => setRange(12));
  document.getElementById('preset-6m').addEventListener('click', () => setRange(6));

  document.querySelectorAll('.chip-ctrl').forEach(btn => {
    btn.addEventListener('click', () => {
      const map = { months: 'month-chips', weekdays: 'weekday-chips', hours: 'hour-chips' };
      setChips(map[btn.dataset.group], btn.dataset.group, btn.dataset.action === 'all');
      update();
    });
  });

  document.querySelectorAll('#tr-table th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      tableSort = { col, desc: tableSort.col === col ? !tableSort.desc : true };
      drawTable(lastGroups);
    });
  });

  document.querySelectorAll('.an-panel-title').forEach(t => {
    t.addEventListener('click', e => {
      if (e.target.closest('.an-panel-title-actions')) return;
      t.parentElement.classList.toggle('collapsed');
    });
  });
}

/** Navbar dropdown. Wired here rather than with an inline onclick attribute,
 *  so the page contains no inline script and works under a strict CSP. */
function wireNavbar() {
  const btn = document.getElementById('menu-btn');
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
  const loading = document.getElementById('an-loading');
  const errorEl = document.getElementById('an-error');
  const retryBtn = document.getElementById('an-retry-btn');

  wireNavbar();

  modeMS = makeMultiSelect({
    placeholder: 'All types', withSearch: false,
    onChange: v => { state.modes = v; update(); },
  });
  networkMS = makeMultiSelect({
    placeholder: 'All networks', withSearch: true,
    onChange: v => { state.networks = v; update(); },
  });
  lineMS = makeMultiSelect({
    placeholder: 'All lines', withSearch: true,
    onChange: v => { state.lines = v; update(); },
  });
  countryMS = makeMultiSelect({
    placeholder: 'All countries', withSearch: true,
    onChange: v => { state.countries = v; update(); },
  });
  document.getElementById('mode-mode').parentElement.appendChild(modeMS.el);
  document.getElementById('network-mode').parentElement.appendChild(networkMS.el);
  document.getElementById('line-mode').parentElement.appendChild(lineMS.el);
  document.getElementById('country-mode').parentElement.appendChild(countryMS.el);
  wireExclude('mode-mode',    v => { state.modeExclude = v; update(); });
  wireExclude('network-mode', v => { state.networkExclude = v; update(); });
  wireExclude('line-mode',    v => { state.lineExclude = v; update(); });
  wireExclude('country-mode', v => { state.countryExclude = v; update(); });

  buildChips('month-chips', MONTHS.map((m, i) => ({ label: m, value: i })), 'months');
  buildChips('weekday-chips', WEEKDAYS.map((d, i) => ({ label: d, value: i })), 'weekdays');
  buildChips('hour-chips', Array.from({ length: 24 }, (_, h) => ({ label: pad2(h), value: h })), 'hours');

  async function load() {
    loading.style.display = 'flex';
    errorEl.style.display = 'none';
    retryBtn.style.display = 'none';
    try {
      const data = await fetch(DATA_URL).then(r => r.json());

      routes = {};
      lineNames = new Map();
      journeys = [];

      for (const m of data) {
        const ts = Date.parse(m.startOfMeasurement);
        const ppm = m.co2readingsAvg;
        if (!ts || !isFinite(ppm)) continue;

        const key = `${m.lineType || ''}_${m.lineID || ''}`;
        const mode = m.lineRoute || 'unknown';
        const network = (m.lineNetwork || '').trim();
        const networks = network ? [network] : [];
        const name = m.lineName || key;

        if (!lineNames.has(key)) lineNames.set(key, name);
        if (!routes[key]) routes[key] = { name, mode, ref: m.lineRef || '', networks };

        const d = new Date(ts);
        journeys.push({
          ts,
          ppmAvg: ppm,
          lineKey: key,
          mode,
          networks,
          country: m.originCountry || m.destinationCountry || null,
          originLat: m.originLatitude ?? null,
          originLon: m.originLongitude ?? null,
          destLat: m.destinationLatitude ?? null,
          destLon: m.destinationLongitude ?? null,
          year: d.getUTCFullYear(),
          month: d.getUTCMonth(),
          weekday: d.getUTCDay(),
          hour: d.getUTCHours(),
        });
      }

      const dFrom = document.getElementById('date-from');
      const dTo = document.getElementById('date-to');
      dFrom.value = isoDay(Math.min(...journeys.map(j => j.ts)));
      dTo.value = isoDay(Math.max(...journeys.map(j => j.ts)));

      populateFilters();
      wireEvents();
      updateCoverage();
      update();
      updateComparisonChart();
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
