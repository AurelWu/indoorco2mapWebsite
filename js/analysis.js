/* analysis.js — Indoor CO₂ Map data analysis page */

const DATA_URL = 'https://www.indoorco2map.com/chartdata/IndoorCO2MapData.json';

const SLOT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

// ─── State ──────────────────────────────────────────────────────────────────

let allRecords = [];
let mainChart = null;
let comparisonChart = null;
let slots = [];  // [{country,locType,brand,name,color}]

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
  showItems: true,
  showOutliers: true,
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
    locationName = ''
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
    // Global time-of-day / month / weekday filters (applied to all views incl. comparison)
    if (state.hours || state.months || state.weekdays) {
      const d = new Date(r._ts);
      if (state.hours    && !state.hours.has(d.getUTCHours()))   return false;
      if (state.months   && !state.months.has(d.getUTCMonth()))  return false;
      if (state.weekdays && !state.weekdays.has(d.getUTCDay()))  return false;
    }
    return true;
  });
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateByLocation(records) {
  const map = new Map();
  for (const r of records) {
    const key = `${r.nwrType}-${r.nwrID}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
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
      .map(l => ({ label: l.name, values: l.visits, count: l.visits.length, visitCount: l.visits.length }))
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
    for (const def of GROUP_DEFS[tp]) groups.set(def.key, { label: def.label, values: [], count: 0 });

    for (const r of records) {
      if (typeof r.co2readingsAvg !== 'number' || isNaN(r.co2readingsAvg)) continue;
      const key = getKey(r._ts);
      if (key === null || !groups.has(key)) continue;
      const g = groups.get(key);
      g.values.push(r.co2readingsAvg);
      g.count++;
    }

    return [...groups.values()].filter(g => g.values.length > 0);
  }

  // type or brand: group by location average first, then by category
  const locs = aggregateByLocation(records);
  const groups = new Map();

  for (const loc of locs.values()) {
    if (isNaN(loc.avgCO2)) continue;
    const rawLabel = splitBy === 'type' ? (loc.locType || 'Other') : (loc.brand || 'Unknown / Independent');
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

function getWhiskerBounds(groups) {
  let yMin = Infinity, yMax = -Infinity;
  for (const g of groups) {
    if (!g.values || !g.values.length) continue;
    const sorted = [...g.values].sort((a, b) => a - b);
    const q1 = pct(sorted, 25), q3 = pct(sorted, 75);
    const fence = 1.5 * (q3 - q1);
    const wMin = sorted.find(v => v >= q1 - fence) ?? sorted[0];
    const wMax = [...sorted].reverse().find(v => v <= q3 + fence) ?? sorted[sorted.length - 1];
    if (wMin < yMin) yMin = wMin;
    if (wMax > yMax) yMax = wMax;
  }
  return isFinite(yMin) ? { yMin, yMax } : null;
}

// ─── Chart rendering ─────────────────────────────────────────────────────────

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

  const itemRadius    = state.showItems ? 3 : 0;
  const outlierRadius = (state.showItems && state.showOutliers) ? 4 : 0;
  const yBounds       = outlierRadius === 0 ? getWhiskerBounds(groups) : null;

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
        outlierBackgroundColor: 'rgba(239,68,68,0.6)'
      }]
    },
    options: buildChartOptions(false, yBounds)
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

  const itemRadius    = state.showItems ? 3 : 0;
  const outlierRadius = (state.showItems && state.showOutliers) ? 4 : 0;
  const yBounds       = outlierRadius === 0 ? getWhiskerBounds(slotData) : null;

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
        outlierBackgroundColor: slotData.map(s => s.color + 'AA')
      }]
    },
    options: buildChartOptions(true, yBounds)
  });
}

function buildChartOptions(multilineXLabels = false, yBounds = null) {
  const yScale = { title: { display: true, text: 'CO₂ (ppm)', font: { size: 12 } }, ticks: { font: { size: 11 } } };
  if (yBounds) {
    const pad = Math.max(30, (yBounds.yMax - yBounds.yMin) * 0.04);
    yScale.min = Math.max(400, Math.floor(yBounds.yMin - pad));
    yScale.max = Math.ceil(yBounds.yMax + pad);
  } else {
    yScale.min = 400;
  }
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
          title: (items) => items[0]?.label || '',
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
  if (state.splitBy !== 'none' && state.splitBy !== 'time') {
    groups = applyLimit(groups, state.limitN, state.limitType, state.displayOrder);
  }

  renderMainChart(groups);
  updateSummary(filtered, groups);
  updateLimitVisibility();

  if (slots.length > 0) updateComparisonChart();
}

function updateSummary(filtered, groups) {
  const el = document.getElementById('chart-summary');
  const locCount = aggregateByLocation(filtered).size;
  const visitCount = filtered.length;
  const catCount = groups.length;
  const catSuffix = state.splitBy === 'time'     ? ` · ${catCount} periods`
                  : state.splitBy !== 'none'    ? ` · ${catCount} categories`
                  : '';
  el.textContent = `${locCount.toLocaleString()} locations · ${visitCount.toLocaleString()} visits shown${catSuffix}`;
}

function updateLimitVisibility() {
  const wrap = document.getElementById('limit-row');
  wrap.style.display = (state.splitBy === 'none' || state.splitBy === 'time') ? 'none' : 'flex';
}

function updateComparisonChart() {
  const slotData = slots.map(slot => {
    const filtered = filterRecords(allRecords, {
      countries: slot.countries || [],
      countryExclude: slot.countryExclude || false,
      locTypes: slot.locTypes || [],
      locTypeExclude: slot.locTypeExclude || false,
      brands: slot.brands || [],
      brandExclude: slot.brandExclude || false,
      locationName: slot.locationName,
      dateMin: state.dateMin,
      dateMax: state.dateMax
    });
    const locs = aggregateByLocation(filtered);
    const values = [...locs.values()].map(l => l.avgCO2).filter(v => !isNaN(v));
    return { label: slot.label, values, count: locs.size, color: slot.color };
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
    locSets.get(cat).add(`${r.nwrType}-${r.nwrID}`);
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
    .map(([tag, locs]) => ({ value: tag, label: `${tag} (${locs.size})` }));
}

function buildBrandOpts(records) {
  const brandMap = new Map();
  for (const r of (records || allRecords)) {
    const raw = (r.brand || '').trim();
    if (!raw) continue;
    const key = normKey(raw);
    if (!brandMap.has(key)) brandMap.set(key, { label: raw, locs: new Set() });
    brandMap.get(key).locs.add(`${r.nwrType}-${r.nwrID}`);
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

  return { el: wrap, getValues, setValues, repopulate };
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
  if (slot.countries?.length) parts.push((slot.countryExclude  ? 'NOT ' : '') + slot.countries.join(', '));
  if (slot.locTypes?.length)  parts.push((slot.locTypeExclude  ? 'NOT ' : '') + slot.locTypes.join(', '));
  if (slot.brands?.length) {
    const names = slot.brands.map(v => slot.brandDisplayMap?.[v] || v).join(', ');
    parts.push((slot.brandExclude ? 'NOT ' : '') + names);
  }
  if (slot.locationName) parts.push(slot.locationName);
  return parts.length ? parts.join(' · ') : 'All Data';
}

function renderSlots() {
  const container = document.getElementById('slots-container');
  container.innerHTML = '';

  slots.forEach((slot, slotIdx) => {
    const row = document.createElement('div');
    row.className = 'slot-row';
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

    // Name input
    const nInp = document.createElement('input');
    nInp.type = 'text';
    nInp.placeholder = 'Name search…';
    nInp.value = slot.locationName || '';
    nInp.style.width = '110px';
    nInp.addEventListener('input', () => {
      slot.locationName = nInp.value;
      slot.label = slotLabel(slot); labelEl.textContent = slot.label;
      updateComparisonChart();
    });

    // Color dot + remove button
    const dot = document.createElement('span');
    dot.className = 'slot-color-dot';
    dot.style.background = slot.color;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'slot-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => { slots.splice(slotIdx, 1); renderSlots(); updateAddSlotBtn(); updateComparisonChart(); });

    row.appendChild(dot);
    row.appendChild(cToggle); row.appendChild(cMS.el);
    row.appendChild(tToggle); row.appendChild(tMS.el);
    row.appendChild(bToggle); row.appendChild(bMS.el);
    row.appendChild(nInp);
    row.appendChild(removeBtn);
    row.appendChild(labelEl);
    container.appendChild(row);
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
    locationName: '',
    color: SLOT_COLORS[slots.length],
    label: 'All Data'
  });
  renderSlots();
  updateAddSlotBtn();
  updateComparisonChart();
}

function updateAddSlotBtn() {
  document.getElementById('add-slot-btn').disabled = slots.length >= 5;
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

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireEvents() {
  document.querySelectorAll('input[name="split"]').forEach(radio => {
    radio.addEventListener('change', e => {
      state.splitBy = e.target.value;
      document.getElementById('time-period-wrap').style.display = state.splitBy === 'time' ? 'flex' : 'none';
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

  function applyShowItems(val) {
    state.showItems = val;
    document.getElementById('show-items').checked = val;
    document.getElementById('show-items-cmp').checked = val;
    update();
    if (slots.length > 0) updateComparisonChart();
  }
  function applyShowOutliers(val) {
    state.showOutliers = val;
    document.getElementById('show-outliers').checked = val;
    document.getElementById('show-outliers-cmp').checked = val;
    update();
    if (slots.length > 0) updateComparisonChart();
  }
  document.getElementById('show-items').addEventListener('change', e => applyShowItems(e.target.checked));
  document.getElementById('show-items-cmp').addEventListener('change', e => applyShowItems(e.target.checked));
  document.getElementById('show-outliers').addEventListener('change', e => applyShowOutliers(e.target.checked));
  document.getElementById('show-outliers-cmp').addEventListener('change', e => applyShowOutliers(e.target.checked));

  document.getElementById('toggle-comparison').addEventListener('click', () => {
    const body = document.getElementById('comparison-body');
    const btn = document.getElementById('toggle-comparison');
    body.classList.toggle('hidden');
    btn.textContent = body.classList.contains('hidden') ? 'Show' : 'Hide';
  });

  document.getElementById('add-slot-btn').addEventListener('click', addSlot);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const loading = document.getElementById('an-loading');
  const errorEl = document.getElementById('an-error');
  const retryBtn = document.getElementById('an-retry-btn');

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
