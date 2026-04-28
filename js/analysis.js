/* analysis.js — Indoor CO₂ Map data analysis page */

const DATA_URL = 'https://www.indoorco2map.com/chartdata/IndoorCO2MapData.json';

const SLOT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

// ─── State ──────────────────────────────────────────────────────────────────

let allRecords = [];
let mainChart = null;
let comparisonChart = null;
let slots = [];  // [{country,locType,brand,name,color}]
let globalDateMin = 0, globalDateMax = Infinity;

let countryMS = null, locTypeMS = null, brandMS = null;

const state = {
  countries: [],
  countryExclude: false,
  locTypes: [],
  locTypeExclude: false,
  brands: [],
  brandExclude: false,
  dateMin: 0,
  dateMax: Infinity,
  splitBy: 'none',
  timePeriod: 'month',
  limitN: 20,
  limitType: 'count',      // criterion for selecting which N make the cut
  displayOrder: 'lowest',  // how to order those N in the chart
  minEntries: 1,           // hide categories with fewer than this many locations
  minMeasPerLoc: 1,        // hide locations with fewer than this many measurements
  pointMode: 'all',  // 'none' | 'outliers' | 'all'
  showMedian: false,
  matchLocations: false,
  hours: null,     // null = all; Set of UTC hours (0-23) otherwise
  months: null,    // null = all; Set of UTC months (0=Jan…11=Dec) otherwise
  weekdays: null   // null = all; Set of UTC weekdays (0=Sun…6=Sat) otherwise
};

// ─── Data loading ────────────────────────────────────────────────────────────

async function fetchData(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normKey(s) { return (s || '').trim().toLowerCase(); }

function getMean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function filterRecords(records, opts = {}) {
  const {
    countries = [], countryExclude = false,
    locTypes = [], locTypeExclude = false,
    dateMin = 0, dateMax = Infinity,
    brands = [], brandExclude = false,
    locationName = '',
    nwrType = '', nwrId = '',
    hours    = state.hours,
    months   = state.months,
    weekdays = state.weekdays
  } = opts;
  return records.filter(r => {
    if (countries.length) {
      const m = countries.includes(r.countryName);
      if (countryExclude ? m : !m) return false;
    }
    if (locTypes.length) {
      const m = locTypes.includes(r.osmTag);
      if (locTypeExclude ? m : !m) return false;
    }
    const t = r._ts;
    if (t < dateMin || t > dateMax) return false;
    if (brands.length) {
      const rNorm = normKey(r.brand);
      const m = brands.includes(rNorm);
      if (brandExclude ? m : !m) return false;
    }
    if (locationName) {
      const n = (r.name || '').toLowerCase();
      if (!n.includes(locationName.toLowerCase())) return false;
    }
    if (nwrType && nwrId) {
      const NWR_NORM = { n: 'node', w: 'way', r: 'relation' };
      const rType = NWR_NORM[(r.nwrtype || '').toLowerCase()] || (r.nwrtype || '').toLowerCase();
      if (rType !== nwrType || String(r.nwrID) !== nwrId) return false;
    }
    if (hours    && !hours.has(new Date(r._ts).getUTCHours()))   return false;
    if (months   && !months.has(new Date(r._ts).getUTCMonth()))  return false;
    if (weekdays && !weekdays.has(new Date(r._ts).getUTCDay()))  return false;
    return true;
  });
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateByLocation(records) {
  const map = new Map();
  for (const r of records) {
    const key = `${r.nwrtype}-${r.nwrID}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        nwrtype: r.nwrtype,
        nwrID: r.nwrID,
        name: r.name || key,
        brand: r.brand || '',
        country: r.countryName,
        locType: r.osmTag,
        visits: []
      });
    }
    if (typeof r.co2readingsAvg === 'number' && !isNaN(r.co2readingsAvg)) {
      map.get(key).visits.push(r.co2readingsAvg);
    }
  }
  for (const loc of map.values()) {
    if (loc.visits.length > 0) {
      loc.avgCO2 = loc.visits.reduce((s, v) => s + v, 0) / loc.visits.length;
    } else {
      loc.avgCO2 = NaN;
    }
  }
  if (state.minMeasPerLoc > 1) {
    for (const [key, loc] of [...map]) {
      if (loc.visits.length < state.minMeasPerLoc) map.delete(key);
    }
  }
  return map;
}

function buildGroups(records, splitBy) {
  if (splitBy === 'none') {
    const locs = aggregateByLocation(records);
    const values = [...locs.values()].map(l => l.avgCO2).filter(v => !isNaN(v));
    const visitCount = records.filter(r => typeof r.co2readingsAvg === 'number').length;
    return [{ label: 'All Filtered Data', values, count: locs.size, visitCount }];
  }

  if (splitBy === 'location') {
    const locs = aggregateByLocation(records);
    return [...locs.values()]
      .map(l => ({
        label: l.name,
        values: l.visits,
        count: l.visits.length,
        visitCount: l.visits.length,
        meta: { osmId: `${l.nwrtype}/${l.nwrID}`, country: l.country, locType: l.locType, brand: l.brand }
      }))
      .filter(g => g.values.length > 0);
  }

  if (splitBy === 'time') {
    const tp = state.timePeriod;
    const pad = n => String(n).padStart(2, '0');
    const GROUP_DEFS = {
      month:        MONTH_LABELS.map((l, i) => ({ key: i, label: l })),
      weekday:      ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((l, i) => ({ key: i, label: l })),
      'weekday-2a': [{ key: 0, label: 'Weekdays (Mon–Fri)' }, { key: 1, label: 'Saturday' }],
      'weekday-2b': [{ key: 0, label: 'Weekdays (Mon–Fri)' }, { key: 1, label: 'Weekend (Sat–Sun)' }],
      'weekday-2c': [{ key: 0, label: 'Mon–Sat' },           { key: 1, label: 'Sunday' }],
      hour:         Array.from({length:24}, (_, i) => ({ key: i, label: pad(i) + ':00' })),
      hour4:        [0,1,2,3,4,5].map(i => ({ key: i, label: `${pad(i*4)}–${pad(i*4+3)}` })),
    };

    function getKey(ts) {
      const d = new Date(ts);
      const utcDay = d.getUTCDay(); // 0=Sun…6=Sat
      switch (tp) {
        case 'month':       return d.getUTCMonth();
        case 'weekday':     return utcDay === 0 ? 6 : utcDay - 1; // 0=Mon…6=Sun
        case 'weekday-2a':  return utcDay >= 1 && utcDay <= 5 ? 0 : (utcDay === 6 ? 1 : null);
        case 'weekday-2b':  return utcDay >= 1 && utcDay <= 5 ? 0 : 1;
        case 'weekday-2c':  return utcDay === 0 ? 1 : 0;
        case 'hour':        return d.getUTCHours();
        case 'hour4':       return Math.floor(d.getUTCHours() / 4);
      }
      return null;
    }

    const groups = new Map();
    for (const def of GROUP_DEFS[tp]) groups.set(def.key, { label: def.label, values: [], locs: new Set() });

    let timeRecords = records;
    if (state.minMeasPerLoc > 1) {
      const locCounts = new Map();
      for (const r of records) {
        const k = `${r.nwrtype}-${r.nwrID}`;
        locCounts.set(k, (locCounts.get(k) || 0) + 1);
      }
      timeRecords = records.filter(r => (locCounts.get(`${r.nwrtype}-${r.nwrID}`) || 0) >= state.minMeasPerLoc);
    }

    for (const r of timeRecords) {
      if (typeof r.co2readingsAvg !== 'number' || isNaN(r.co2readingsAvg)) continue;
      const key = getKey(r._ts);
      if (key === null || !groups.has(key)) continue;
      const g = groups.get(key);
      g.values.push(r.co2readingsAvg);
      g.locs.add(`${r.nwrtype}-${r.nwrID}`);
    }

    return [...groups.values()]
      .filter(g => g.values.length > 0)
      .map(g => ({ ...g, count: g.locs.size }));
  }

  // country / type / brand: group by location average first, then by category
  const locs = aggregateByLocation(records);
  const groups = new Map();

  for (const loc of locs.values()) {
    if (isNaN(loc.avgCO2)) continue;
    const rawLabel = splitBy === 'country' ? (loc.country  || 'Unknown')
                   : splitBy === 'type'    ? (loc.locType  || 'Other')
                   :                         (loc.brand    || 'Unknown / Independent');
    const key = normKey(rawLabel); // case-insensitive grouping key
    if (!groups.has(key)) groups.set(key, { label: rawLabel, values: [], visitCount: 0 });
    groups.get(key).values.push(loc.avgCO2);
    groups.get(key).visitCount += loc.visits.length;
  }

  return [...groups.values()]
    .map(g => ({ ...g, count: g.values.length }))
    .filter(g => g.values.length > 0);
}

function sortByMetric(a, b, metric) {
  if (metric === 'count')   return b.count - a.count;
  if (metric === 'highest') return getMedian(b.values) - getMedian(a.values);
  return getMedian(a.values) - getMedian(b.values); // 'lowest'
}

function applyLimit(groups, n, limitType, displayOrder) {
  // Step 1: rank all groups by limitType, keep the top N
  const ranked = [...groups].sort((a, b) => sortByMetric(a, b, limitType));
  const selected = ranked.slice(0, n);
  // Step 2: re-order those N by displayOrder for chart presentation
  selected.sort((a, b) => sortByMetric(a, b, displayOrder));
  return selected;
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function getMedian(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(sorted, p) {
  const n = sorted.length;
  if (!n) return 0;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function getDataMax(groups) {
  let max = -Infinity;
  for (const g of groups) {
    if (g.values?.length) max = Math.max(max, ...g.values);
  }
  return isFinite(max) ? max : null;
}

function getWhiskerMax(groups) {
  let max = -Infinity;
  for (const g of groups) {
    if (!g.values?.length) continue;
    const sorted = [...g.values].sort((a, b) => a - b);
    const q1 = pct(sorted, 25), q3 = pct(sorted, 75);
    const wMax = [...sorted].reverse().find(v => v <= q3 + 1.5 * (q3 - q1)) ?? sorted[sorted.length - 1];
    if (wMax > max) max = wMax;
  }
  return isFinite(max) ? max : null;
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

const medianLinePlugin = {
  id: 'medianLine',
  afterDatasetsDraw(chart) {
    if (state.pointMode !== 'all') return;
    const { ctx, scales } = chart;
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      dataset.data.forEach((vals, i) => {
        if (!Array.isArray(vals) || !vals.length) return;
        const el = meta.data[i];
        if (!el) return;
        const sorted = [...vals].filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
        if (!sorted.length) return;
        const n = sorted.length;
        const median = n % 2 === 0 ? (sorted[n/2-1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
        const yPx = scales.y.getPixelForValue(median);
        const halfW = (el.width ?? chart.scales.x.bandwidth * 0.7) / 2;
        const color = Array.isArray(dataset.borderColor) ? dataset.borderColor[i] : 'rgba(29,78,216,1)';
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(el.x - halfW, yPx);
        ctx.lineTo(el.x + halfW, yPx);
        ctx.stroke();
        ctx.restore();
      });
    });
  }
};

const medianLabelPlugin = {
  id: 'medianLabels',
  afterDatasetsDraw(chart) {
    if (!state.showMedian) return;
    const { ctx, scales } = chart;
    const fontSize = chart.options.plugins?.medianLabels?.fontSize ?? 11;
    const showBg = state.pointMode === 'all';
    chart.data.datasets.forEach((dataset, di) => {
      const meta = chart.getDatasetMeta(di);
      dataset.data.forEach((vals, i) => {
        if (!Array.isArray(vals) || vals.length === 0) return;
        const el = meta.data[i];
        if (!el) return;
        const sorted = [...vals].filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
        if (!sorted.length) return;
        const n = sorted.length;
        const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
        const yPx = scales.y.getPixelForValue(median);
        const text = String(Math.round(median));
        ctx.save();
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        if (showBg) {
          const tw = ctx.measureText(text).width;
          const pad = 2;
          ctx.fillStyle = 'rgba(255,255,255,0.88)';
          ctx.fillRect(el.x - tw / 2 - pad, yPx + 3 - pad, tw + pad * 2, fontSize + pad * 2);
        }
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.fillText(text, el.x, yPx + 3);
        ctx.restore();
      });
    });
  }
};

function renderMainChart(groups) {
  const wrap = document.getElementById('main-chart-wrap');
  const canvas = document.getElementById('main-chart');

  if (!groups || groups.length === 0) {
    wrap.innerHTML = '<div class="no-data-msg">No data matches the current filters.</div>';
    if (mainChart) { mainChart.destroy(); mainChart = null; }
    return;
  }

  if (!canvas.parentElement) {
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
  }

  const height = Math.max(500, groups.length * 38);
  wrap.style.height = height + 'px';
  canvas.style.height = height + 'px';

  if (mainChart) { mainChart.destroy(); mainChart = null; }

  const itemRadius    = state.pointMode === 'all' ? 3 : 0;
  const outlierRadius = state.pointMode !== 'none' ? 4 : 0;

  mainChart = new Chart(canvas, {
    type: 'boxplot',
    data: {
      labels: groups.map(g => `${g.label} (n=${g.count})`),
      datasets: [{
        label: 'CO₂ ppm',
        data: groups.map(g => g.values),
        backgroundColor: 'rgba(59,130,246,0.25)',
        borderColor: 'rgba(59,130,246,0.85)',
        borderWidth: 1.5,
        itemRadius,
        itemStyle: 'circle',
        itemBackgroundColor: 'rgba(59,130,246,0.45)',
        itemBorderWidth: 0,
        outlierRadius,
        outlierBackgroundColor: 'rgba(239,68,68,0.6)',
        meanBackgroundColor: 'rgba(0,0,0,0)',
        meanBorderColor:     'rgba(0,0,0,0)'
      }]
    },
    options: buildChartOptions(false, state.pointMode === 'none' ? getWhiskerMax(groups) : getDataMax(groups), state.splitBy === 'location' ? groups.map(g => g.meta || null) : null),
    plugins: [medianLinePlugin, medianLabelPlugin]
  });
}

function renderComparisonChart(slotData) {
  const wrap = document.getElementById('comparison-chart-wrap');
  const canvas = document.getElementById('comparison-chart');

  if (!slotData || slotData.length === 0) {
    wrap.innerHTML = '<div class="no-data-msg">Add at least one filter set to see the comparison.</div>';
    if (comparisonChart) { comparisonChart.destroy(); comparisonChart = null; }
    return;
  }

  if (!canvas.parentElement) {
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
  }

  wrap.style.height = '480px';
  canvas.style.height = '480px';

  if (comparisonChart) { comparisonChart.destroy(); comparisonChart = null; }

  const itemRadius    = state.pointMode === 'all' ? 3 : 0;
  const outlierRadius = state.pointMode !== 'none' ? 4 : 0;

  comparisonChart = new Chart(canvas, {
    type: 'boxplot',
    data: {
      labels: slotData.map(s => s.label + (s.values.length ? ` (n=${s.count})` : ' (no data)')),
      datasets: [{
        label: 'Comparison',
        data: slotData.map(s => s.values),
        backgroundColor: slotData.map(s => s.color + '40'),
        borderColor: slotData.map(s => s.color),
        borderWidth: 1.5,
        itemRadius,
        itemStyle: 'circle',
        itemBackgroundColor: slotData.map(s => s.color + '80'),
        itemBorderWidth: 0,
        outlierRadius,
        outlierBackgroundColor: slotData.map(s => s.color + 'AA'),
        meanBackgroundColor: slotData.map(() => 'rgba(0,0,0,0)'),
        meanBorderColor:     slotData.map(() => 'rgba(0,0,0,0)')
      }]
    },
    options: buildChartOptions(true, state.pointMode === 'none' ? getWhiskerMax(slotData) : getDataMax(slotData)),
    plugins: [medianLinePlugin, medianLabelPlugin]
  });
}

function buildChartOptions(multilineXLabels = false, dataMax = null, locMeta = null) {
  const yScale = { title: { display: true, text: 'CO₂ (ppm)', font: { size: 12 } }, ticks: { font: { size: 11 } } };
  yScale.min = 400;
  if (dataMax != null) yScale.max = Math.ceil(dataMax / 100) * 100;
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: {
        display: false
      },
      tooltip: {
        callbacks: {
          title: (items) => {
            const label = items[0]?.label || '';
            if (!locMeta) return label;
            const m = locMeta[items[0]?.dataIndex];
            if (!m) return label;
            const lines = [label];
            if (m.osmId)   lines.push(`OSM: ${m.osmId}`);
            if (m.country) lines.push(`Country: ${m.country}`);
            if (m.locType) lines.push(`Type: ${LOC_TYPE_LABELS[m.locType] || m.locType}`);
            if (m.brand)   lines.push(`Brand: ${m.brand}`);
            return lines;
          },
          label: (ctx) => {
            // ctx.raw is the original array we passed; compute stats from it
            const raw = ctx.raw;
            let values;
            if (Array.isArray(raw)) {
              values = raw.filter(v => typeof v === 'number' && !isNaN(v));
            } else if (raw && Array.isArray(raw.items)) {
              values = raw.items;
            } else if (raw && typeof raw.median === 'number') {
              // pre-computed stats object (passed as {min,q1,median,q3,max})
              const fmt = v => v != null ? Math.round(v) + ' ppm' : '—';
              return [
                `Median:    ${fmt(raw.median)}`,
                `Mean:      ${raw.mean != null ? Math.round(raw.mean) + ' ppm' : '—'}`,
                `Q1 (25%):  ${fmt(raw.q1)}`,
                `Q3 (75%):  ${fmt(raw.q3)}`,
                `Min:       ${fmt(raw.min)}`,
                `Max:       ${fmt(raw.max)}`
              ];
            } else {
              return '';
            }
            if (!values.length) return 'No data';

            const sorted = [...values].sort((a, b) => a - b);
            const n = sorted.length;
            const pct = p => {
              const idx = (p / 100) * (n - 1);
              const lo = Math.floor(idx), hi = Math.ceil(idx);
              return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
            };
            const mean = values.reduce((s, v) => s + v, 0) / n;

            return [
              `Median:    ${Math.round(pct(50))} ppm`,
              `Mean:      ${Math.round(mean)} ppm`,
              `Q1 (25%):  ${Math.round(pct(25))} ppm`,
              `Q3 (75%):  ${Math.round(pct(75))} ppm`,
              `Min:       ${Math.round(sorted[0])} ppm`,
              `Max:       ${Math.round(sorted[n - 1])} ppm`,
              `n:         ${n}`
            ];
          }
        }
      }
    },
    scales: {
      y: yScale,
      x: {
        ticks: {
          maxRotation: multilineXLabels ? 0 : 40,
          minRotation: 0,
          font: { size: 11 },
          callback: function(val) {
            const lbl = this.getLabelForValue(val);
            if (!lbl) return '';
            // Split on the · separator used in comparison slot labels → multiline
            if (lbl.includes(' · ')) return lbl.split(' · ');
            return lbl;
          }
        }
      }
    }
  };
}

// ─── Update cycle ────────────────────────────────────────────────────────────

function update() {
  const filtered = filterRecords(allRecords, {
    countries: state.countries,
    countryExclude: state.countryExclude,
    locTypes: state.locTypes,
    locTypeExclude: state.locTypeExclude,
    brands: state.brands,
    brandExclude: state.brandExclude,
    dateMin: state.dateMin,
    dateMax: state.dateMax
  });

  let groups = buildGroups(filtered, state.splitBy);
  if (state.splitBy !== 'none') {
    if (state.minEntries > 1) groups = groups.filter(g => g.count >= state.minEntries);
    if (state.splitBy !== 'time') groups = applyLimit(groups, state.limitN, state.limitType, state.displayOrder);
  }

  renderMainChart(groups);
  updateSummary(filtered, groups);
  updateLimitVisibility();

  if (slots.length > 0) updateComparisonChart();
}

function rangeStr(sortedVals, fmt) {
  if (!sortedVals.length) return '';
  const segs = [];
  let s = sortedVals[0], p = s;
  for (let i = 1; i < sortedVals.length; i++) {
    if (sortedVals[i] === p + 1) { p = sortedVals[i]; }
    else { segs.push(s === p ? fmt(s) : `${fmt(s)}–${fmt(p)}`); s = p = sortedVals[i]; }
  }
  segs.push(s === p ? fmt(s) : `${fmt(s)}–${fmt(p)}`);
  return segs.join(', ');
}

function updateSummary(filtered, groups) {
  const el = document.getElementById('chart-summary');
  const locCount = aggregateByLocation(filtered).size;
  const visitCount = filtered.length;
  const catCount = groups.length;
  const LIMIT_QUALIFIER = { count: 'most frequent', highest: 'highest median CO₂', lowest: 'lowest median CO₂' };
  const catSuffix = state.splitBy === 'time'    ? ` · ${catCount} periods`
                  : state.splitBy === 'none'    ? ''
                  : (() => {
                      const noun = state.splitBy === 'country'  ? 'countries'
                                 : state.splitBy === 'type'     ? 'location types'
                                 : state.splitBy === 'brand'    ? 'brands'
                                 : 'locations';
                      const q = LIMIT_QUALIFIER[state.limitType];
                      return ` · ${catCount} ${noun}${q ? ` (${q})` : ''}`;
                    })();

  const parts = [];

  if (state.countries.length)
    parts.push((state.countryExclude ? '≠ ' : '') + state.countries.join(', '));

  if (state.locTypes.length)
    parts.push((state.locTypeExclude ? '≠ ' : '') + state.locTypes.join(', '));

  if (state.brands.length) {
    const names = state.brands.map(v => brandMS?.getLabel(v) ?? v).join(', ');
    parts.push((state.brandExclude ? '≠ ' : '') + names);
  }

  const fmtDate = ts => new Date(ts).toLocaleDateString('en-CA');
  if (state.dateMin > globalDateMin || state.dateMax < globalDateMax)
    parts.push(`${fmtDate(state.dateMin)} – ${fmtDate(state.dateMax)}`);

  if (state.months) {
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    parts.push('Months: ' + rangeStr([...state.months].sort((a,b)=>a-b), m => MO[m]));
  }

  if (state.weekdays) {
    const ORDER = [1,2,3,4,5,6,0];
    const DNAME = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
    parts.push('Days: ' + ORDER.filter(d => state.weekdays.has(d)).map(d => DNAME[d]).join(', '));
  }

  if (state.hours)
    parts.push('Hours: ' + rangeStr([...state.hours].sort((a,b)=>a-b), h => String(h).padStart(2,'0')));

  el.innerHTML = '';
  const line1 = document.createElement('span');
  line1.textContent = `${locCount.toLocaleString()} locations · ${visitCount.toLocaleString()} visits shown${catSuffix}`;
  el.appendChild(line1);
  if (parts.length) {
    el.appendChild(document.createElement('br'));
    const line2 = document.createElement('span');
    line2.className = 'summary-filters';
    line2.textContent = parts.join(' · ');
    el.appendChild(line2);
  }
}

function updateLimitVisibility() {
  const wrap = document.getElementById('limit-row');
  wrap.style.display = (state.splitBy === 'none' || state.splitBy === 'time') ? 'none' : 'flex';
}

function updateComparisonChart() {
  // Pass 1: per-slot filtered records
  const slotFiltered = slots.map(slot => filterRecords(allRecords, {
    countries: slot.countries || [],
    countryExclude: slot.countryExclude || false,
    locTypes: slot.locTypes || [],
    locTypeExclude: slot.locTypeExclude || false,
    brands: slot.brands || [],
    brandExclude: slot.brandExclude || false,
    nwrType: slot.nwrType || '',
    nwrId:   slot.nwrId   || '',
    dateMin: state.dateMin,
    dateMax: state.dateMax,
    hours:    slot.overrideTime ? slot.hours    : state.hours,
    months:   slot.overrideTime ? slot.months   : state.months,
    weekdays: slot.overrideTime ? slot.weekdays : state.weekdays
  }));

  // Pass 2: intersect location keys across all slots when matchLocations is on
  let matchedKeys = null;
  if (state.matchLocations && slots.length > 1) {
    const sets = slotFiltered.map(recs => new Set(recs.map(r => `${r.nwrtype}-${r.nwrID}`)));
    matchedKeys = sets.reduce((a, b) => new Set([...a].filter(k => b.has(k))));
  }

  // Pass 3: aggregate
  const slotData = slots.map((slot, i) => {
    const records = matchedKeys
      ? slotFiltered[i].filter(r => matchedKeys.has(`${r.nwrtype}-${r.nwrID}`))
      : slotFiltered[i];

    // Single location selected → one boxplot, one value per measurement session
    if (slot.nwrId) {
      const values = records.map(r => r.co2readingsAvg).filter(v => typeof v === 'number' && !isNaN(v));
      const suffix = slotFilterSuffix(slot);
      const label  = suffix.length ? slot.label + ' · ' + suffix.join(' · ') : slot.label;
      return { label, values, count: values.length, color: slot.color };
    }

    const locs   = aggregateByLocation(records);
    const values = [...locs.values()].map(l => l.avgCO2).filter(v => !isNaN(v));
    const suffix = slotFilterSuffix(slot);
    const label  = suffix.length ? slot.label + ' · ' + suffix.join(' · ') : slot.label;
    return { label, values, count: locs.size, color: slot.color };
  });

  renderComparisonChart(slotData);
}

// ─── Dropdowns ───────────────────────────────────────────────────────────────

function countByLocationKey(records, keyFn) {
  const locSets = new Map();
  for (const r of records) {
    const cat = keyFn(r);
    if (!cat) continue;
    if (!locSets.has(cat)) locSets.set(cat, new Set());
    locSets.get(cat).add(`${r.nwrtype}-${r.nwrID}`);
  }
  return locSets;
}

function buildCountryOpts(records) {
  const locSets = countByLocationKey(records || allRecords, r => r.countryName);
  return [...locSets.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([country, locs]) => ({ value: country, label: `${country} (${locs.size})` }));
}

function buildLocTypeOpts(records) {
  const locSets = countByLocationKey(records || allRecords, r => r.osmTag);
  return [...locSets.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .map(([tag, locs]) => {
      const displayLabel = LOC_TYPE_LABELS[tag] || tag;
      return { value: tag, label: `${displayLabel} (${locs.size})`, displayLabel };
    });
}

function buildBrandOpts(records) {
  const brandMap = new Map();
  for (const r of (records || allRecords)) {
    const raw = (r.brand || '').trim();
    if (!raw) continue;
    const key = normKey(raw);
    if (!brandMap.has(key)) brandMap.set(key, { label: raw, locs: new Set() });
    brandMap.get(key).locs.add(`${r.nwrtype}-${r.nwrID}`);
  }
  return [...brandMap.entries()]
    .sort((a, b) => b[1].locs.size - a[1].locs.size)
    .map(([key, { label, locs }]) => ({ value: key, label: `${label} (${locs.size})`, displayLabel: label }));
}

function populateCountryDropdown(records) {
  if (!countryMS) return;
  countryMS.repopulate(buildCountryOpts(records));
  countryMS.setValues(state.countries);
}

function populateLocTypeDropdown(records) {
  if (!locTypeMS) return;
  locTypeMS.repopulate(buildLocTypeOpts(records));
  locTypeMS.setValues(state.locTypes);
}

function populateMainBrandDropdown(records) {
  if (!brandMS) return;
  brandMS.repopulate(buildBrandOpts(records));
  brandMS.setValues(state.brands);
}

// ─── Date slider ─────────────────────────────────────────────────────────────

function initDateSlider() {
  const timestamps = allRecords.map(r => r._ts).filter(t => isFinite(t));
  if (!timestamps.length) return;

  const tMin = Math.min(...timestamps);
  const tMax = Math.max(...timestamps);

  state.dateMin = tMin;
  state.dateMax = tMax;
  globalDateMin = tMin;
  globalDateMax = tMax;

  const sMin = document.getElementById('date-slider-min');
  const sMax = document.getElementById('date-slider-max');

  sMin.min = sMax.min = tMin;
  sMin.max = sMax.max = tMax;
  sMin.value = tMin;
  sMax.value = tMax;

  updateDateLabels();
  updateDateTrack();

  sMin.addEventListener('input', () => {
    if (+sMin.value > +sMax.value) sMin.value = sMax.value;
    state.dateMin = +sMin.value;
    updateDateLabels();
    updateDateTrack();
    refreshMainDropdowns();
    update();
  });

  sMax.addEventListener('input', () => {
    if (+sMax.value < +sMin.value) sMax.value = sMin.value;
    state.dateMax = +sMax.value;
    updateDateLabels();
    updateDateTrack();
    refreshMainDropdowns();
    update();
  });

  // Preset buttons
  document.getElementById('preset-all').addEventListener('click', () => setDateRange(tMin, tMax));
  document.getElementById('preset-12m').addEventListener('click', () => {
    setDateRange(tMax - 365 * 24 * 60 * 60 * 1000, tMax);
  });
  document.getElementById('preset-6m').addEventListener('click', () => {
    setDateRange(tMax - 183 * 24 * 60 * 60 * 1000, tMax);
  });
}

function setDateRange(min, max) {
  const sMin = document.getElementById('date-slider-min');
  const sMax = document.getElementById('date-slider-max');
  sMin.value = Math.max(min, +sMin.min);
  sMax.value = Math.min(max, +sMax.max);
  state.dateMin = +sMin.value;
  state.dateMax = +sMax.value;
  updateDateLabels();
  updateDateTrack();
  refreshMainDropdowns();
  update();
}

function updateDateLabels() {
  const fmt = ts => new Date(ts).toLocaleDateString('en-CA');
  document.getElementById('date-label-min').textContent = fmt(state.dateMin);
  document.getElementById('date-label-max').textContent = fmt(state.dateMax);
}

function updateDateTrack() {
  const sMin = document.getElementById('date-slider-min');
  const sMax = document.getElementById('date-slider-max');
  const track = document.getElementById('date-track');
  const lo = +sMin.min, hi = +sMin.max;
  const span = hi - lo || 1;
  const pMin = ((+sMin.value - lo) / span * 100).toFixed(1);
  const pMax = ((+sMax.value - lo) / span * 100).toFixed(1);
  track.style.background =
    `linear-gradient(to right, #ddd ${pMin}%, #3b82f6 ${pMin}%, #3b82f6 ${pMax}%, #ddd ${pMax}%)`;
}

// ─── Multi-select component ───────────────────────────────────────────────────

function makeMultiSelect({ placeholder, withSearch, onChange }) {
  let options = [];
  let selected = new Set();
  const labelRegistry = new Map(); // value → display label (persists across repopulates)

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
    searchEl.placeholder = 'Search…';
    searchEl.className = 'ms-search';
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.toLowerCase();
      list.querySelectorAll('.ms-item').forEach(item => {
        item.style.display = !q || item.dataset.label.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    panel.appendChild(searchEl);
  }

  const list = document.createElement('div');
  list.className = 'ms-list';
  panel.appendChild(list);
  wrap.appendChild(panel);

  function updateTrigger() {
    if (selected.size === 0) {
      trigger.textContent = placeholder;
      trigger.title = '';
    } else {
      const labels = [...selected].map(v => labelRegistry.get(v) || v);
      const text = labels.length <= 2 ? labels.join(', ') : `${labels.length} selected`;
      trigger.textContent = text;
      trigger.title = labels.join(', ');
    }
  }

  function repopulate(opts) {
    options = opts;
    for (const o of opts) labelRegistry.set(o.value, o.displayLabel || o.label.replace(/ \(\d+\)$/, ''));
    list.innerHTML = '';
    for (const opt of opts) {
      const lbl = document.createElement('label');
      lbl.className = 'ms-item';
      lbl.dataset.label = opt.label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt.value;
      cb.checked = selected.has(opt.value);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(opt.value);
        else selected.delete(opt.value);
        updateTrigger();
        onChange([...selected]);
      });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + opt.label));
      list.appendChild(lbl);
    }
    updateTrigger();
    if (searchEl) { searchEl.value = ''; list.querySelectorAll('.ms-item').forEach(i => i.style.display = ''); }
  }

  function getValues() { return [...selected]; }

  function setValues(vals) {
    selected = new Set(vals);
    list.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = selected.has(cb.value); });
    updateTrigger();
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = panel.style.display !== 'none';
    document.querySelectorAll('.ms-panel').forEach(p => { p.style.display = 'none'; });
    if (!isOpen) {
      panel.style.display = 'block';
      if (searchEl) { searchEl.value = ''; list.querySelectorAll('.ms-item').forEach(i => i.style.display = ''); searchEl.focus(); }
    }
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) panel.style.display = 'none';
  });

  function getLabel(v) { return labelRegistry.get(v) || v; }

  return { el: wrap, getValues, setValues, repopulate, getLabel };
}

function makeExcludeToggleMS(ms, initialExclude, onChange) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Toggle include / exclude';

  function syncDisabled() {
    const empty = ms.getValues().length === 0;
    btn.disabled = empty;
    if (empty && btn.classList.contains('exclude')) {
      btn.classList.remove('exclude');
      ms.el.classList.remove('exclude-mode');
      btn.textContent = '=';
      onChange(false);
    }
  }

  const startExclude = initialExclude && ms.getValues().length > 0;
  btn.className = 'filter-mode-btn' + (startExclude ? ' exclude' : '');
  btn.textContent = startExclude ? '≠' : '=';
  ms.el.classList.toggle('exclude-mode', startExclude);
  btn.disabled = ms.getValues().length === 0;

  btn.addEventListener('click', () => {
    const nowExclude = !btn.classList.contains('exclude');
    btn.classList.toggle('exclude', nowExclude);
    btn.textContent = nowExclude ? '≠' : '=';
    ms.el.classList.toggle('exclude-mode', nowExclude);
    onChange(nowExclude);
  });

  btn._sync = syncDisabled;
  return btn;
}

// ─── Collapsible panels ──────────────────────────────────────────────────────

function initCollapsiblePanels() {
  document.querySelectorAll('.an-panel-title').forEach(title => {
    title.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const panel = title.closest('.an-panel');
      panel.classList.toggle('collapsed');
      if (!panel.classList.contains('collapsed')) {
        setTimeout(() => { mainChart?.resize(); comparisonChart?.resize(); }, 50);
      }
    });
  });
}

function wireExcludeBtn(btnId, ms, stateKey) {
  const btn = document.getElementById(btnId);

  function sync() {
    const empty = ms.getValues().length === 0;
    btn.disabled = empty;
    if (empty && btn.classList.contains('exclude')) {
      btn.classList.remove('exclude');
      btn.textContent = '=';
      ms.el.classList.remove('exclude-mode');
      state[stateKey] = false;
      update();
    }
  }

  btn.addEventListener('click', () => {
    const nowExclude = !btn.classList.contains('exclude');
    btn.classList.toggle('exclude', nowExclude);
    btn.textContent = nowExclude ? '≠' : '=';
    ms.el.classList.toggle('exclude-mode', nowExclude);
    state[stateKey] = nowExclude;
    update();
  });

  btn._sync = sync;
  sync();
}

function initMainFilters() {
  countryMS = makeMultiSelect({
    placeholder: 'All Countries', withSearch: false,
    onChange: vals => {
      state.countries = vals;
      document.getElementById('country-mode')._sync?.();
      refreshMainDropdowns();
      update();
    }
  });
  document.getElementById('country-mode').after(countryMS.el);
  wireExcludeBtn('country-mode', countryMS, 'countryExclude');

  locTypeMS = makeMultiSelect({
    placeholder: 'All Location Types', withSearch: false,
    onChange: vals => {
      state.locTypes = vals;
      document.getElementById('loctype-mode')._sync?.();
      const allTime = applyTimeFilterForCounts(allRecords);
      const cf = state.countries.length ? allTime.filter(r => state.countries.includes(r.countryName)) : allTime;
      const tf = vals.length ? cf.filter(r => vals.includes(r.osmTag)) : cf;
      populateMainBrandDropdown(tf);
      document.getElementById('brand-mode')._sync?.();
      update();
    }
  });
  document.getElementById('loctype-mode').after(locTypeMS.el);
  wireExcludeBtn('loctype-mode', locTypeMS, 'locTypeExclude');

  brandMS = makeMultiSelect({
    placeholder: 'Any Brand', withSearch: true,
    onChange: vals => {
      state.brands = vals;
      document.getElementById('brand-mode')._sync?.();
      update();
    }
  });
  document.getElementById('brand-mode').after(brandMS.el);
  wireExcludeBtn('brand-mode', brandMS, 'brandExclude');
}

// ─── Comparison slots ────────────────────────────────────────────────────────

function slotLabel(slot) {
  const parts = [];
  if (slot.countries?.length) parts.push((slot.countryExclude  ? 'All except ' : '') + slot.countries.join(', '));
  if (slot.locTypes?.length)  parts.push((slot.locTypeExclude  ? 'All except ' : '') + slot.locTypes.join(', '));
  if (slot.brands?.length) {
    const names = slot.brands.map(v => slot.brandDisplayMap?.[v] || v).join(', ');
    parts.push((slot.brandExclude ? 'All except ' : '') + names);
  }
  if (slot.nwrType && slot.nwrId) parts.push(`${slot.nwrType}/${slot.nwrId}`);
  return parts.length ? parts.join(' · ') : 'All Data';
}

function slotFilterSuffix(slot) {
  const MO    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DNAME = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
  const ORDER = [1,2,3,4,5,6,0];
  const fmtH  = h => String(h).padStart(2,'0');
  const fmtD  = ts => new Date(ts).toLocaleDateString('en-CA');

  const hours    = slot.overrideTime ? slot.hours    : state.hours;
  const months   = slot.overrideTime ? slot.months   : state.months;
  const weekdays = slot.overrideTime ? slot.weekdays : state.weekdays;

  const parts = [];
  if (state.dateMin > globalDateMin || state.dateMax < globalDateMax)
    parts.push(`${fmtD(state.dateMin)}–${fmtD(state.dateMax)}`);
  if (months)
    parts.push(rangeStr([...months].sort((a,b)=>a-b), m => MO[m]));
  if (weekdays)
    parts.push(ORDER.filter(d => weekdays.has(d)).map(d => DNAME[d]).join(', '));
  if (hours)
    parts.push(rangeStr([...hours].sort((a,b)=>a-b), fmtH));
  return parts;
}

function makeSlotTimePanel(slot) {
  const panel = document.createElement('div');
  panel.className = 'slot-time-panel';
  panel.style.borderLeftColor = slot.color;
  if (!slot.overrideTime) panel.style.display = 'none';

  function addGroup(label, items, groupKey, totalCount) {
    const wrap = document.createElement('div');
    wrap.className = 'time-filter-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'time-filter-label';
    labelEl.textContent = label + ' ';

    const allBtn = document.createElement('button');
    allBtn.type = 'button'; allBtn.className = 'chip-ctrl'; allBtn.textContent = 'All';
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button'; noneBtn.className = 'chip-ctrl'; noneBtn.textContent = 'None';
    labelEl.appendChild(allBtn);
    labelEl.appendChild(noneBtn);

    const chipGroup = document.createElement('div');
    chipGroup.className = 'chip-group';

    items.forEach(({l, v}) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (!slot[groupKey] || slot[groupKey].has(v) ? ' active' : '');
      chip.textContent = l;
      chip.dataset.value = v;
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        const active = [...chipGroup.querySelectorAll('.chip.active')].map(c => +c.dataset.value);
        slot[groupKey] = active.length === totalCount ? null : new Set(active);
        updateComparisonChart();
      });
      chipGroup.appendChild(chip);
    });

    allBtn.addEventListener('click', () => {
      chipGroup.querySelectorAll('.chip').forEach(c => c.classList.add('active'));
      slot[groupKey] = null;
      updateComparisonChart();
    });
    noneBtn.addEventListener('click', () => {
      chipGroup.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      slot[groupKey] = new Set();
      updateComparisonChart();
    });

    wrap.appendChild(labelEl);
    wrap.appendChild(chipGroup);
    panel.appendChild(wrap);
  }

  addGroup('Months',     MONTH_LABELS.map((l, i) => ({l, v: i})),                                    'months',   12);
  addGroup('Days',       WEEKDAY_ITEMS,                                                               'weekdays',  7);
  addGroup('Hours UTC',  Array.from({length:24}, (_, i) => ({l: String(i).padStart(2,'0'), v: i})), 'hours',    24);

  return panel;
}

function renderSlots() {
  const container = document.getElementById('slots-container');
  container.innerHTML = '';

  slots.forEach((slot, slotIdx) => {
    const slotWrap = document.createElement('div');
    slotWrap.className = 'slot-wrap';

    const row = document.createElement('div');
    row.className = 'slot-row' + (slot.overrideTime ? ' has-time-panel' : '');
    row.style.borderLeftColor = slot.color;

    const labelEl = document.createElement('div');
    labelEl.className = 'slot-label';
    labelEl.textContent = slotLabel(slot);

    function cfForSlot() {
      return slot.countries.length ? allRecords.filter(r => slot.countries.includes(r.countryName)) : allRecords;
    }
    function tfForSlot(cf) {
      return slot.locTypes.length ? cf.filter(r => slot.locTypes.includes(r.osmTag)) : cf;
    }

    function repopulateLocType() {
      const opts = buildLocTypeOpts(cfForSlot());
      tMS.repopulate(opts);
      tMS.setValues(slot.locTypes);
      tToggle._sync();
    }
    function repopulateBrand() {
      const opts = buildBrandOpts(tfForSlot(cfForSlot()));
      opts.forEach(o => { slot.brandDisplayMap[o.value] = o.displayLabel; });
      bMS.repopulate(opts);
      bMS.setValues(slot.brands);
      bToggle._sync();
    }

    // Country MS
    const cMS = makeMultiSelect({
      placeholder: 'All Countries', withSearch: false,
      onChange: vals => {
        slot.countries = vals;
        cToggle._sync();
        repopulateLocType();
        repopulateBrand();
        slot.label = slotLabel(slot); labelEl.textContent = slot.label;
        updateComparisonChart();
      }
    });
    cMS.repopulate(buildCountryOpts());
    cMS.setValues(slot.countries);
    const cToggle = makeExcludeToggleMS(cMS, slot.countryExclude, v => {
      slot.countryExclude = v; slot.label = slotLabel(slot); labelEl.textContent = slot.label; updateComparisonChart();
    });

    // LocType MS
    const tMS = makeMultiSelect({
      placeholder: 'All Types', withSearch: false,
      onChange: vals => {
        slot.locTypes = vals;
        tToggle._sync();
        repopulateBrand();
        slot.label = slotLabel(slot); labelEl.textContent = slot.label;
        updateComparisonChart();
      }
    });
    tMS.repopulate(buildLocTypeOpts(cfForSlot()));
    tMS.setValues(slot.locTypes);
    const tToggle = makeExcludeToggleMS(tMS, slot.locTypeExclude, v => {
      slot.locTypeExclude = v; slot.label = slotLabel(slot); labelEl.textContent = slot.label; updateComparisonChart();
    });

    // Brand MS
    const bMS = makeMultiSelect({
      placeholder: 'Any Brand', withSearch: true,
      onChange: vals => {
        slot.brands = vals;
        bToggle._sync();
        slot.label = slotLabel(slot); labelEl.textContent = slot.label;
        updateComparisonChart();
      }
    });
    const initBrandOpts = buildBrandOpts(tfForSlot(cfForSlot()));
    initBrandOpts.forEach(o => { slot.brandDisplayMap[o.value] = o.displayLabel; });
    bMS.repopulate(initBrandOpts);
    bMS.setValues(slot.brands);
    const bToggle = makeExcludeToggleMS(bMS, slot.brandExclude, v => {
      slot.brandExclude = v; slot.label = slotLabel(slot); labelEl.textContent = slot.label; updateComparisonChart();
    });

    // OSM element filter (nwrType + nwrId)
    const nwrSel = document.createElement('select');
    nwrSel.style.width = '88px';
    nwrSel.innerHTML = '<option value="">OSM type…</option><option value="node">Node</option><option value="way">Way</option><option value="relation">Relation</option>';
    nwrSel.value = slot.nwrType || '';
    const nwrInp = document.createElement('input');
    nwrInp.type = 'text';
    nwrInp.placeholder = 'OSM ID…';
    nwrInp.value = slot.nwrId || '';
    nwrInp.style.width = '80px';
    nwrInp.pattern = '[0-9]*';
    function onNwrChange() {
      slot.nwrType = nwrSel.value;
      slot.nwrId   = nwrInp.value.trim();
      slot.label   = slotLabel(slot); labelEl.textContent = slot.label;
      updateComparisonChart();
    }
    nwrSel.addEventListener('change', onNwrChange);
    nwrInp.addEventListener('input',  onNwrChange);

    // Color dot
    const dot = document.createElement('span');
    dot.className = 'slot-color-dot';
    dot.style.background = slot.color;

    // Move up/down buttons
    const moveWrap = document.createElement('div');
    moveWrap.className = 'slot-move-wrap';
    const upBtn = document.createElement('button');
    upBtn.type = 'button'; upBtn.className = 'slot-move'; upBtn.title = 'Move up'; upBtn.textContent = '▲';
    upBtn.disabled = slotIdx === 0;
    upBtn.addEventListener('click', () => {
      [slots[slotIdx - 1], slots[slotIdx]] = [slots[slotIdx], slots[slotIdx - 1]];
      renderSlots(); updateComparisonChart();
    });
    const downBtn = document.createElement('button');
    downBtn.type = 'button'; downBtn.className = 'slot-move'; downBtn.title = 'Move down'; downBtn.textContent = '▼';
    downBtn.disabled = slotIdx === slots.length - 1;
    downBtn.addEventListener('click', () => {
      [slots[slotIdx + 1], slots[slotIdx]] = [slots[slotIdx], slots[slotIdx + 1]];
      renderSlots(); updateComparisonChart();
    });
    moveWrap.appendChild(upBtn);
    moveWrap.appendChild(downBtn);

    // Time override toggle
    const timePanel = makeSlotTimePanel(slot);
    const timeToggleBtn = document.createElement('button');
    timeToggleBtn.type = 'button';
    timeToggleBtn.className = 'slot-time-toggle' + (slot.overrideTime ? ' active' : '');
    timeToggleBtn.title = 'Override time filters for this slot';
    timeToggleBtn.textContent = '⏱';
    timeToggleBtn.addEventListener('click', () => {
      slot.overrideTime = !slot.overrideTime;
      timeToggleBtn.classList.toggle('active', slot.overrideTime);
      timePanel.style.display = slot.overrideTime ? 'block' : 'none';
      row.classList.toggle('has-time-panel', slot.overrideTime);
      updateComparisonChart();
    });

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'slot-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => { slots.splice(slotIdx, 1); renderSlots(); updateAddSlotBtn(); updateComparisonChart(); });

    row.appendChild(dot);
    row.appendChild(moveWrap);
    row.appendChild(cToggle); row.appendChild(cMS.el);
    row.appendChild(tToggle); row.appendChild(tMS.el);
    row.appendChild(bToggle); row.appendChild(bMS.el);
    row.appendChild(nwrSel);
    row.appendChild(nwrInp);
    row.appendChild(timeToggleBtn);
    row.appendChild(removeBtn);
    row.appendChild(labelEl);
    slotWrap.appendChild(row);
    slotWrap.appendChild(timePanel);
    container.appendChild(slotWrap);
  });

  const wrap = document.getElementById('comparison-chart-wrap');
  if (!document.getElementById('comparison-chart')) {
    const c = document.createElement('canvas');
    c.id = 'comparison-chart';
    wrap.appendChild(c);
  }
}

function addSlot() {
  if (slots.length >= 5) return;
  slots.push({
    countries: [], countryExclude: false,
    locTypes: [],  locTypeExclude: false,
    brands: [],    brandExclude: false,
    brandDisplayMap: {},
    nwrType: '', nwrId: '',
    overrideTime: false,
    hours: null, months: null, weekdays: null,
    color: SLOT_COLORS[slots.length],
    label: 'All Data'
  });
  renderSlots();
  updateAddSlotBtn();
  updateComparisonChart();
}

function duplicateLastSlot() {
  if (slots.length === 0 || slots.length >= 5) return;
  const src = slots[slots.length - 1];
  slots.push({
    countries:       [...src.countries],
    countryExclude:  src.countryExclude,
    locTypes:        [...src.locTypes],
    locTypeExclude:  src.locTypeExclude,
    brands:          [...src.brands],
    brandExclude:    src.brandExclude,
    brandDisplayMap: { ...src.brandDisplayMap },
    nwrType:         src.nwrType,
    nwrId:           src.nwrId,
    overrideTime:    src.overrideTime,
    hours:           src.hours    ? new Set(src.hours)    : null,
    months:          src.months   ? new Set(src.months)   : null,
    weekdays:        src.weekdays ? new Set(src.weekdays) : null,
    dateMin:         src.dateMin,
    dateMax:         src.dateMax,
    color:           SLOT_COLORS[slots.length],
    label:           src.label,
  });
  renderSlots();
  updateAddSlotBtn();
  updateComparisonChart();
}

function updateAddSlotBtn() {
  document.getElementById('add-slot-btn').disabled = slots.length >= 5;
  document.getElementById('duplicate-slot-btn').disabled = slots.length === 0 || slots.length >= 5;
}

// ─── Time filters ────────────────────────────────────────────────────────────

const MONTH_LABELS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAY_ITEMS  = [{l:'Mon',v:1},{l:'Tue',v:2},{l:'Wed',v:3},{l:'Thu',v:4},{l:'Fri',v:5},{l:'Sat',v:6},{l:'Sun',v:0}];

function buildChipGroup(containerId, items, groupKey, totalCount) {
  const container = document.getElementById(containerId);
  items.forEach(({l, v}) => {
    const chip = document.createElement('span');
    chip.className = 'chip active';
    chip.textContent = l;
    chip.dataset.value = v;
    chip.addEventListener('click', () => {
      chip.classList.toggle('active');
      syncTimeState(groupKey, containerId, totalCount);
      refreshMainDropdowns();
      update();
    });
    container.appendChild(chip);
  });
}

function syncTimeState(groupKey, containerId, totalCount) {
  const chips = [...document.querySelectorAll(`#${containerId} .chip`)];
  const active = chips.filter(c => c.classList.contains('active')).map(c => +c.dataset.value);
  state[groupKey] = active.length === totalCount ? null : new Set(active);
}

function setChipGroup(containerId, groupKey, totalCount, active) {
  document.querySelectorAll(`#${containerId} .chip`).forEach(c => {
    c.classList.toggle('active', active);
  });
  syncTimeState(groupKey, containerId, totalCount);
}

function initTimeFilters() {
  buildChipGroup('month-chips',   MONTH_LABELS.map((l, i) => ({l, v: i})),  'months',   12);
  buildChipGroup('weekday-chips', WEEKDAY_ITEMS,                              'weekdays',  7);
  buildChipGroup('hour-chips',    Array.from({length:24}, (_, i) => ({l: String(i).padStart(2,'0'), v: i})), 'hours', 24);

  document.querySelectorAll('.chip-ctrl').forEach(btn => {
    btn.addEventListener('click', () => {
      const group   = btn.dataset.group;
      const action  = btn.dataset.action;
      const idMap   = {months:'month-chips', weekdays:'weekday-chips', hours:'hour-chips'};
      const totals  = {months:12, weekdays:7, hours:24};
      setChipGroup(idMap[group], group, totals[group], action === 'all');
      refreshMainDropdowns();
      update();
      if (slots.length > 0) updateComparisonChart();
    });
  });
}

function applyTimeFilter(records) {
  return records.filter(r => {
    if (r._ts < state.dateMin || r._ts > state.dateMax) return false;
    if (state.hours    && !state.hours.has(new Date(r._ts).getUTCHours()))   return false;
    if (state.months   && !state.months.has(new Date(r._ts).getUTCMonth()))  return false;
    if (state.weekdays && !state.weekdays.has(new Date(r._ts).getUTCDay()))  return false;
    return true;
  });
}

function applyTimeFilterForCounts(records) {
  return records.filter(r => {
    if (r._ts < state.dateMin || r._ts > state.dateMax) return false;
    if (state.hours?.size    && !state.hours.has(new Date(r._ts).getUTCHours()))   return false;
    if (state.months?.size   && !state.months.has(new Date(r._ts).getUTCMonth()))  return false;
    if (state.weekdays?.size && !state.weekdays.has(new Date(r._ts).getUTCDay()))  return false;
    return true;
  });
}

function refreshMainDropdowns() {
  const allTime = applyTimeFilterForCounts(allRecords);
  populateCountryDropdown(allTime);
  document.getElementById('country-mode')._sync?.();

  const cf = state.countries.length ? allTime.filter(r => state.countries.includes(r.countryName)) : allTime;
  populateLocTypeDropdown(cf);
  document.getElementById('loctype-mode')._sync?.();

  const tf = state.locTypes.length ? cf.filter(r => state.locTypes.includes(r.osmTag)) : cf;
  populateMainBrandDropdown(tf);
  document.getElementById('brand-mode')._sync?.();
}

// ─── Social media export ──────────────────────────────────────────────────────

let _logoPromise = null;
function loadCardLogo() {
  if (!_logoPromise) {
    _logoPromise = fetch('images/icon512_512.png')
      .then(r => r.blob())
      .then(blob => new Promise(r => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          // Sample corner pixel to extract the logo's exact background color
          try {
            const tmp = document.createElement('canvas');
            tmp.width = tmp.height = 8;
            tmp.getContext('2d').drawImage(img, 0, 0, 8, 8);
            const [rv, gv, bv] = tmp.getContext('2d').getImageData(1, 1, 1, 1).data;
            r({ img, bgColor: `rgb(${rv},${gv},${bv})` });
          } catch(e) {
            r({ img, bgColor: '#1e40af' });
          }
        };
        img.onerror = () => { URL.revokeObjectURL(url); r(null); };
        img.src = url;
      }))
      .catch(() => null);
  }
  return _logoPromise;
}

function drawExportMedianLines(canvas, chart) {
  if (state.pointMode !== 'all') return;
  const ctx2d = canvas.getContext('2d');
  const { scales, chartArea } = chart;
  chart.data.datasets.forEach((dataset, di) => {
    const meta = chart.getDatasetMeta(di);
    const nBars = dataset.data.length;
    const barSlotW = (chartArea.right - chartArea.left) / Math.max(nBars, 1);
    dataset.data.forEach((vals, i) => {
      if (!Array.isArray(vals) || !vals.length) return;
      const sorted = [...vals].filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
      if (!sorted.length) return;
      const n = sorted.length;
      const median = n % 2 === 0 ? (sorted[n/2-1] + sorted[n/2]) / 2 : sorted[Math.floor(n/2)];
      const yPx = scales.y.getPixelForValue(median);
      const el = meta.data[i];
      const barX = (el && typeof el.x === 'number') ? el.x : scales.x.getPixelForValue(i);
      const halfW = (el && el.width > 0) ? el.width / 2 : barSlotW * 0.36;
      const color = Array.isArray(dataset.borderColor) ? dataset.borderColor[i] : 'rgba(29,78,216,1)';
      ctx2d.save();
      ctx2d.strokeStyle = color;
      ctx2d.lineWidth = 3;
      ctx2d.beginPath();
      ctx2d.moveTo(barX - halfW, yPx);
      ctx2d.lineTo(barX + halfW, yPx);
      ctx2d.stroke();
      ctx2d.restore();
    });
  });
}

async function renderExportChartImage(W, H) {
  const srcDs = mainChart.data.datasets[0];
  const yMin  = mainChart.scales?.y?.min ?? 400;
  const yMax  = mainChart.scales?.y?.max;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.style.cssText = 'position:fixed;left:-9999px;visibility:hidden';
  document.body.appendChild(cv);

  const FONT = 18;
  const yScale = {
    title: { display: true, text: 'CO₂ (ppm)', font: { size: FONT } },
    ticks: { font: { size: FONT } },
    min: yMin
  };
  if (yMax != null) yScale.max = yMax;

  const chart = new Chart(cv, {
    type: 'boxplot',
    data: {
      labels: mainChart.data.labels,
      datasets: [{ ...srcDs }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: false,
      devicePixelRatio: 1,
      plugins: { legend: { display: false }, title: { display: false }, tooltip: { enabled: false }, medianLabels: { fontSize: FONT } },
      scales: {
        y: yScale,
        x: {
          ticks: {
            font: { size: FONT },
            maxRotation: 40,
            minRotation: 0,
            callback: function(val) {
              const lbl = this.getLabelForValue(val);
              if (!lbl) return '';
              if (lbl.includes(' · ')) return lbl.split(' · ');
              return lbl;
            }
          }
        }
      }
    },
    plugins: [medianLabelPlugin]
  });

  drawExportMedianLines(cv, chart);
  const dataUrl = chart.toBase64Image('image/png', 1);
  chart.destroy();
  document.body.removeChild(cv);
  return dataUrl;
}

function drawLegendLine(ctx, text, x, y, fontSize) {
  const LABEL_COLOR = '#1f2937';
  const TEXT_COLOR  = '#374151';
  const segments = text.split(' · ');
  let curX = x;
  segments.forEach((seg, si) => {
    if (si > 0) {
      ctx.font = `${fontSize}px "Titillium Web", system-ui, sans-serif`;
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(' · ', curX, y);
      curX += ctx.measureText(' · ').width;
    }
    const colonPos = seg.indexOf(': ');
    const equalsPos = seg.indexOf(' = ');
    if (colonPos !== -1 || equalsPos !== -1) {
      const useColon = colonPos !== -1 && (equalsPos === -1 || colonPos < equalsPos);
      const boldPart   = useColon ? seg.slice(0, colonPos + 1) : seg.slice(0, equalsPos + 2);
      const normalPart = useColon ? seg.slice(colonPos + 1)    : seg.slice(equalsPos + 2);
      ctx.font = `bold ${fontSize}px "Titillium Web", system-ui, sans-serif`;
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(boldPart, curX, y);
      curX += ctx.measureText(boldPart).width;
      ctx.font = `${fontSize}px "Titillium Web", system-ui, sans-serif`;
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(normalPart, curX, y);
      curX += ctx.measureText(normalPart).width;
    } else {
      ctx.font = `${fontSize}px "Titillium Web", system-ui, sans-serif`;
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(seg, curX, y);
      curX += ctx.measureText(seg).width;
    }
  });
}

async function generateSocialCard() {
  if (!mainChart) return null;
  await document.fonts.ready;
  const logoData = await loadCardLogo();
  const logo = logoData?.img ?? null;
  const headerColor = logoData?.bgColor ?? '#1e40af';

  // Use CSS (logical) dimensions for aspect ratio to undo DPR scaling
  const cssW = mainChart.canvas.offsetWidth || mainChart.canvas.width;
  const cssH = mainChart.canvas.offsetHeight || mainChart.canvas.height;

  const W = 1200;
  const HEADER_H = 70;   // blue bar
  const TITLE_H  = 155;  // title + stats + filter desc + padding

  // ── Pre-compute legend lines to size the canvas correctly ──
  const nLabel = state.splitBy === 'location' ? 'number of visits' : 'number of locations';
  const legendBase = `Box: 25th–75th percentile · Center line: median · Whiskers: most extreme value within 1.5× IQR (box height) · Dots beyond whiskers: outliers · n = ${nLabel}`;
  const dotsNote = state.pointMode === 'all'
    ? "Individual dots: each dot is one location's avg CO₂, scattered horizontally; dots beyond whiskers are outliers centered above/below the box."
    : state.pointMode === 'outliers'
    ? 'Outlier dots: individual location averages that fall outside the whiskers, shown at their value on the y-axis.'
    : null;
  const _mCtx = document.createElement('canvas').getContext('2d');
  _mCtx.font = '13px "Titillium Web", system-ui, sans-serif';
  const _lParts = legendBase.split(' · ');
  const _lMid = Math.ceil(_lParts.length / 2);
  const legendLines = _mCtx.measureText(legendBase).width > W - 64
    ? [_lParts.slice(0, _lMid).join(' · '), _lParts.slice(_lMid).join(' · ')]
    : [legendBase];
  const LEGEND_H = (legendLines.length + (dotsNote ? 1 : 0)) * 17 + 20;

  // Scale chart to fill export width, preserving on-screen CSS aspect ratio
  const chartDispH = Math.round((cssH / cssW) * W);
  const H = HEADER_H + TITLE_H + chartDispH + LEGEND_H;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // ── Header bar ──────────────────────────────────────────
  ctx.fillStyle = headerColor;
  ctx.fillRect(0, 0, W, HEADER_H);

  const LOGO_SIZE = 62;
  const logoX = 7;
  if (logo) {
    ctx.fillStyle = headerColor;
    ctx.fillRect(logoX, (HEADER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.drawImage(logo, logoX, (HEADER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE);
  }
  const textX = logo ? logoX + LOGO_SIZE + 10 : 32;

  ctx.font = 'bold 22px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText('indoorco2map.com', textX, HEADER_H / 2);

  const dateStr = new Date().toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
  ctx.font = '18px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.textAlign = 'right';
  ctx.fillText(dateStr, W - 32, HEADER_H / 2);
  ctx.textAlign = 'left';

  // ── Title + stats + filter description ──────────────────
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const splitSuffix = {
    none: '', country: ' by Country', type: ' by Location Type',
    brand: ' by Brand', location: ' — Individual Locations', time: ' by Time Period',
  };
  let titleContext = '';
  if (state.splitBy !== 'type' && state.locTypes.length === 1 && !state.locTypeExclude)
    titleContext = ' in ' + cap(locTypeMS?.getLabel(state.locTypes[0]) || state.locTypes[0]);
  else if (state.splitBy !== 'country' && state.countries.length === 1 && !state.countryExclude)
    titleContext = ' in ' + cap(countryMS?.getLabel(state.countries[0]) || state.countries[0]);
  const cardTitle = 'Indoor CO₂ Levels' + titleContext + (splitSuffix[state.splitBy] ?? '');

  const summaryEl = document.getElementById('chart-summary');
  const statsLine = (summaryEl.innerText || '').trim().split('\n').map(s => s.trim()).filter(Boolean)[0] || '';

  const fmtTs = ts => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  const countryDesc = state.countries.length === 0 ? 'All countries'
    : (state.countryExclude ? 'Excl. ' : '') + state.countries.map(v => countryMS?.getLabel(v) || v).join(', ');
  const typeDesc = state.locTypes.length === 0 ? 'All location types'
    : (state.locTypeExclude ? 'Excl. ' : '') + state.locTypes.map(v => locTypeMS?.getLabel(v) || v).join(', ');
  const brandDesc = state.brands.length > 0
    ? (state.brandExclude ? 'Excl. ' : '') + state.brands.map(v => brandMS?.getLabel(v) || v).join(', ')
    : null;
  const dateDesc = fmtTs(Math.max(state.dateMin, globalDateMin)) + '–' + fmtTs(Math.min(state.dateMax, globalDateMax));
  const filterDesc = [countryDesc, typeDesc, brandDesc, dateDesc].filter(Boolean).join(' · ');

  ctx.textBaseline = 'top';

  ctx.font = 'bold 40px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.fillText(cardTitle, 32, HEADER_H + 16);

  ctx.font = '24px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(filterDesc.slice(0, 130), 32, HEADER_H + 16 + 46);

  ctx.font = '20px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(statsLine.slice(0, 100), 32, HEADER_H + 16 + 46 + 30);

  // ── Chart — rendered fresh at export size with large fonts ──
  const chartDataUrl = await renderExportChartImage(W, chartDispH);
  const chartImg = new Image();
  await new Promise(resolve => { chartImg.onload = resolve; chartImg.src = chartDataUrl; });

  const chartY = HEADER_H + TITLE_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, chartY, W, chartDispH);
  ctx.drawImage(chartImg, 0, chartY, W, chartDispH);

  // ── Legend below chart ───────────────────────────────────
  const legendY = chartY + chartDispH + 10;
  legendLines.forEach((line, i) => drawLegendLine(ctx, line, 32, legendY + i * 17, 13));
  if (dotsNote) drawLegendLine(ctx, dotsNote, 32, legendY + legendLines.length * 17, 13);

  return cv;
}

async function renderExportComparisonChartImage(W, H) {
  const srcDs = comparisonChart.data.datasets[0];
  const yMin = comparisonChart.scales?.y?.min ?? 400;
  const yMax = comparisonChart.scales?.y?.max;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.style.cssText = 'position:fixed;left:-9999px;visibility:hidden';
  document.body.appendChild(cv);

  const FONT = 18;
  const yScale = { title: { display: true, text: 'CO₂ (ppm)', font: { size: FONT } }, ticks: { font: { size: FONT } }, min: yMin };
  if (yMax != null) yScale.max = yMax;

  const chart = new Chart(cv, {
    type: 'boxplot',
    data: { labels: comparisonChart.data.labels, datasets: [{ ...srcDs }] },
    options: {
      responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 1,
      plugins: { legend: { display: false }, title: { display: false }, tooltip: { enabled: false }, medianLabels: { fontSize: FONT } },
      scales: {
        y: yScale,
        x: { ticks: { font: { size: FONT }, maxRotation: 0, minRotation: 0,
          callback: function(val) {
            const lbl = this.getLabelForValue(val);
            if (!lbl) return '';
            return lbl.includes(' · ') ? lbl.split(' · ') : lbl;
          }
        }}
      }
    },
    plugins: [medianLabelPlugin]
  });

  drawExportMedianLines(cv, chart);
  const dataUrl = chart.toBase64Image('image/png', 1);
  chart.destroy();
  document.body.removeChild(cv);
  return dataUrl;
}

async function generateComparisonSocialCard() {
  if (!comparisonChart) return null;
  await document.fonts.ready;
  const logoData = await loadCardLogo();
  const logo = logoData?.img ?? null;
  const headerColor = logoData?.bgColor ?? '#1e40af';

  const cssW = comparisonChart.canvas.offsetWidth || comparisonChart.canvas.width;
  const cssH = comparisonChart.canvas.offsetHeight || comparisonChart.canvas.height;

  const W = 1200;
  const HEADER_H = 70;
  const TITLE_H  = 155;

  // ── Pre-compute legend lines ──
  const legendBaseCmp = 'Box: 25th–75th percentile · Center line: median · Whiskers: most extreme value within 1.5× IQR (box height) · Dots beyond whiskers: outliers · n = number of locations';
  const dotsNoteCmp = state.pointMode === 'all'
    ? "Individual dots: each dot is one location's avg CO₂, scattered horizontally; dots beyond whiskers are outliers centered above/below the box."
    : state.pointMode === 'outliers'
    ? 'Outlier dots: individual location averages that fall outside the whiskers, shown at their value on the y-axis.'
    : null;
  const _mCtxCmp = document.createElement('canvas').getContext('2d');
  _mCtxCmp.font = '13px "Titillium Web", system-ui, sans-serif';
  const _lPartsCmp = legendBaseCmp.split(' · ');
  const _lMidCmp = Math.ceil(_lPartsCmp.length / 2);
  const legendLinesCmp = _mCtxCmp.measureText(legendBaseCmp).width > W - 64
    ? [_lPartsCmp.slice(0, _lMidCmp).join(' · '), _lPartsCmp.slice(_lMidCmp).join(' · ')]
    : [legendBaseCmp];
  const LEGEND_H_CMP = (legendLinesCmp.length + (dotsNoteCmp ? 1 : 0)) * 17 + 20;

  const chartDispH = Math.round((cssH / cssW) * W);
  const H = HEADER_H + TITLE_H + chartDispH + LEGEND_H_CMP;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = headerColor;
  ctx.fillRect(0, 0, W, HEADER_H);

  const LOGO_SIZE = 62;
  const logoX = 7;
  if (logo) {
    ctx.fillStyle = headerColor;
    ctx.fillRect(logoX, (HEADER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE);
    ctx.drawImage(logo, logoX, (HEADER_H - LOGO_SIZE) / 2, LOGO_SIZE, LOGO_SIZE);
  }
  const textX = logo ? logoX + LOGO_SIZE + 10 : 32;

  ctx.font = 'bold 22px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText('indoorco2map.com', textX, HEADER_H / 2);

  const dateStr = new Date().toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' });
  ctx.font = '18px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.textAlign = 'right';
  ctx.fillText(dateStr, W - 32, HEADER_H / 2);
  ctx.textAlign = 'left';

  // Title area — derive from common slot filters
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const allSameLocType = slots.length > 0
    && slots[0].locTypes.length === 1 && !slots[0].locTypeExclude
    && slots.every(s => !s.locTypeExclude && s.locTypes.length === 1 && s.locTypes[0] === slots[0].locTypes[0]);
  const allSameCountry = slots.length > 0
    && slots[0].countries.length === 1 && !slots[0].countryExclude
    && slots.every(s => !s.countryExclude && s.countries.length === 1 && s.countries[0] === slots[0].countries[0]);

  let compTitle = 'Indoor CO₂ Levels';
  if (allSameLocType)
    compTitle += ' in ' + cap(locTypeMS?.getLabel(slots[0].locTypes[0]) || slots[0].locTypes[0]);
  else if (allSameCountry)
    compTitle += ' in ' + cap(countryMS?.getLabel(slots[0].countries[0]) || slots[0].countries[0]);
  else
    compTitle += ' — Comparison';

  const fmtTsCmp = ts => new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateDescCmp = fmtTsCmp(Math.max(state.dateMin, globalDateMin)) + ' – ' + fmtTsCmp(Math.min(state.dateMax, globalDateMax));
  const statsLine = `${slots.length} comparison group${slots.length !== 1 ? 's' : ''} · ${dateDescCmp}`;

  ctx.textBaseline = 'top';
  ctx.font = 'bold 40px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#111827';
  ctx.fillText(compTitle, 32, HEADER_H + 16);

  ctx.font = '20px "Titillium Web", system-ui, sans-serif';
  ctx.fillStyle = '#9ca3af';
  ctx.fillText(statsLine, 32, HEADER_H + 16 + 46);

  // Chart
  const chartDataUrl = await renderExportComparisonChartImage(W, chartDispH);
  const chartImg = new Image();
  await new Promise(resolve => { chartImg.onload = resolve; chartImg.src = chartDataUrl; });

  const chartY = HEADER_H + TITLE_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, chartY, W, chartDispH);
  ctx.drawImage(chartImg, 0, chartY, W, chartDispH);

  // ── Legend below chart ───────────────────────────────────
  const legendYCmp = chartY + chartDispH + 10;
  legendLinesCmp.forEach((line, i) => drawLegendLine(ctx, line, 32, legendYCmp + i * 17, 13));
  if (dotsNoteCmp) drawLegendLine(ctx, dotsNoteCmp, 32, legendYCmp + legendLinesCmp.length * 17, 13);

  return cv;
}

function showExportModal(canvas) {
  document.getElementById('export-modal')?.remove();
  const dataUrl = canvas.toDataURL('image/png');

  const modal = document.createElement('div');
  modal.id = 'export-modal';
  modal.innerHTML = `
    <div id="export-modal-box">
      <div id="export-modal-head">
        <span>Social Media Card &mdash; 1200 &times; 630 px</span>
        <button id="export-close-btn">✕</button>
      </div>
      <div id="export-preview-area">
        <img id="export-preview-img" src="${dataUrl}" alt="Export preview">
      </div>
      <div id="export-modal-foot">
        <button id="export-copy-btn" class="export-action-btn primary">Copy image</button>
        <button id="export-dl-btn" class="export-action-btn">Download PNG</button>
        <span id="export-msg"></span>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  document.getElementById('export-close-btn').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  document.getElementById('export-copy-btn').onclick = async () => {
    const msg = document.getElementById('export-msg');
    try {
      const blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      msg.textContent = '✓ Copied to clipboard';
      msg.style.color = '#16a34a';
    } catch {
      msg.textContent = 'Copy not supported — use Download';
      msg.style.color = '#dc2626';
    }
    setTimeout(() => { msg.textContent = ''; }, 3000);
  };

  document.getElementById('export-dl-btn').onclick = () => {
    const a = document.createElement('a');
    a.download = `indoor-co2-map-${Date.now()}.png`;
    a.href = dataUrl;
    a.click();
  };
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireEvents() {
  document.getElementById('export-social-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-social-btn');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const canvas = await generateSocialCard();
      if (canvas) showExportModal(canvas);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Share';
    }
  });

  document.getElementById('export-comparison-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-comparison-btn');
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const canvas = await generateComparisonSocialCard();
      if (canvas) showExportModal(canvas);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Share';
    }
  });

  function updateLegendNText() {
    const el = document.getElementById('legend-n-text');
    if (el) el.textContent = state.splitBy === 'location' ? 'number of visits to that location' : 'number of locations';
  }

  document.querySelectorAll('input[name="split"]').forEach(radio => {
    radio.addEventListener('change', e => {
      state.splitBy = e.target.value;
      document.getElementById('time-period-wrap').style.display = state.splitBy === 'time' ? 'flex' : 'none';
      updateLegendNText();
      update();
    });
  });

  document.getElementById('time-period-select').addEventListener('change', e => {
    state.timePeriod = e.target.value;
    update();
  });

  document.getElementById('limit-n').addEventListener('input', e => {
    const n = parseInt(e.target.value, 10);
    if (n > 0) { state.limitN = n; update(); }
  });

  document.getElementById('limit-type').addEventListener('change', e => {
    state.limitType = e.target.value;
    update();
  });

  document.getElementById('display-order').addEventListener('change', e => {
    state.displayOrder = e.target.value;
    update();
  });

  document.getElementById('min-entries').addEventListener('input', e => {
    const n = parseInt(e.target.value, 10);
    if (n >= 1) { state.minEntries = n; update(); }
  });

  document.getElementById('min-meas-per-loc').addEventListener('input', e => {
    const n = parseInt(e.target.value, 10);
    if (n >= 1) { state.minMeasPerLoc = n; update(); }
  });

  function updateDotsNote() {
    const el = document.getElementById('legend-dots-note');
    if (!el) return;
    if (state.pointMode === 'all') {
      el.textContent = 'Individual dots: each dot is one location\'s average CO₂, positioned on the y-axis at its value and scattered horizontally within the bar for readability. Dots beyond the whiskers are outliers and appear centered above or below the box.';
      el.style.display = '';
    } else if (state.pointMode === 'outliers') {
      el.textContent = 'Outlier dots: individual location averages that fall outside the whiskers, shown at their value on the y-axis.';
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  }

  const POINT_MODE_SEL = 'input[name="point-mode"], input[name="point-mode-cmp"]';
  function applyPointMode(val) {
    state.pointMode = val;
    document.querySelectorAll(POINT_MODE_SEL).forEach(r => { r.checked = r.value === val; });
    updateDotsNote();
    update();
    if (slots.length > 0) updateComparisonChart();
  }
  document.querySelectorAll(POINT_MODE_SEL).forEach(r => {
    r.addEventListener('change', e => { if (e.target.checked) applyPointMode(e.target.value); });
  });

  function applyShowMedian(val) {
    state.showMedian = val;
    document.getElementById('show-median').checked = val;
    document.getElementById('show-median-cmp').checked = val;
    update();
    if (slots.length > 0) updateComparisonChart();
  }
  document.getElementById('show-median').addEventListener('change', e => applyShowMedian(e.target.checked));
  document.getElementById('show-median-cmp').addEventListener('change', e => applyShowMedian(e.target.checked));

  document.getElementById('match-locations').addEventListener('change', e => {
    state.matchLocations = e.target.checked;
    if (slots.length > 0) updateComparisonChart();
  });

  document.getElementById('toggle-comparison').addEventListener('click', () => {
    const body = document.getElementById('comparison-body');
    const btn = document.getElementById('toggle-comparison');
    body.classList.toggle('hidden');
    btn.textContent = body.classList.contains('hidden') ? 'Show' : 'Hide';
  });

  document.getElementById('add-slot-btn').addEventListener('click', addSlot);
  document.getElementById('duplicate-slot-btn').addEventListener('click', duplicateLastSlot);

  updateDotsNote();
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const loading = document.getElementById('an-loading');
  const errorEl = document.getElementById('an-error');
  const retryBtn = document.getElementById('an-retry-btn');

  initCollapsiblePanels();

  async function load() {
    loading.style.display = 'flex';
    errorEl.style.display = 'none';
    retryBtn.style.display = 'none';

    try {
      const raw = await fetchData(DATA_URL);

      // Pre-compute timestamp for each record
      allRecords = raw.map(r => ({
        ...r,
        _ts: new Date(r.startOfMeasurement).getTime()
      }));

      loading.style.display = 'none';

      initMainFilters();
      populateCountryDropdown(allRecords);
      populateLocTypeDropdown(allRecords);
      populateMainBrandDropdown(allRecords);
      initDateSlider();
      initTimeFilters();
      wireEvents();
      update();

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
