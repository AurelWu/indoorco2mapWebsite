/* analysis.js — Indoor CO₂ Map data analysis page */

const DATA_URL = 'https://www.indoorco2map.com/chartdata/IndoorCO2MapData.json';

const SLOT_COLORS = ['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6'];

// ─── State ──────────────────────────────────────────────────────────────────

let allRecords = [];
let mainChart = null;
let comparisonChart = null;
let slots = [];  // [{country,locType,brand,name,color}]

const state = {
  country: '',
  locType: '',
  dateMin: 0,
  dateMax: Infinity,
  splitBy: 'none',
  limitN: 20,
  limitType: 'count',      // criterion for selecting which N make the cut
  displayOrder: 'lowest',  // how to order those N in the chart
  showItems: true
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
  const { country = '', locType = '', dateMin = 0, dateMax = Infinity, brand = '', locationName = '' } = opts;
  const brandNorm = normKey(brand);
  return records.filter(r => {
    if (country && r.countryName !== country) return false;
    if (locType && r.osmTag !== locType) return false;
    const t = r._ts;
    if (t < dateMin || t > dateMax) return false;
    if (brand && normKey(r.brand) !== brandNorm) return false;
    if (locationName) {
      const n = (r.name || '').toLowerCase();
      if (!n.includes(locationName.toLowerCase())) return false;
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

  const itemRadius = state.showItems ? 3 : 0;

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
        outlierRadius: itemRadius > 0 ? 4 : 0,
        outlierBackgroundColor: 'rgba(239,68,68,0.6)'
      }]
    },
    options: buildChartOptions('CO₂ Distribution')
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

  const itemRadius = state.showItems ? 3 : 0;

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
        outlierRadius: itemRadius > 0 ? 4 : 0,
        outlierBackgroundColor: slotData.map(s => s.color + 'AA')
      }]
    },
    options: buildChartOptions('Comparison')
  });
}

function buildChartOptions(titleText) {
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
      y: {
        min: 400,
        title: { display: true, text: 'CO₂ (ppm)', font: { size: 12 } },
        ticks: { font: { size: 11 } }
      },
      x: {
        ticks: {
          maxRotation: 40,
          font: { size: 11 },
          callback: function(val, idx) {
            const lbl = this.getLabelForValue(val);
            return lbl.length > 30 ? lbl.slice(0, 28) + '…' : lbl;
          }
        }
      }
    }
  };
}

// ─── Update cycle ────────────────────────────────────────────────────────────

function update() {
  const filtered = filterRecords(allRecords, {
    country: state.country,
    locType: state.locType,
    dateMin: state.dateMin,
    dateMax: state.dateMax
  });

  let groups = buildGroups(filtered, state.splitBy);
  if (state.splitBy !== 'none') {
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
  el.textContent = `${locCount.toLocaleString()} locations · ${visitCount.toLocaleString()} visits shown` +
    (state.splitBy !== 'none' ? ` · ${catCount} categories displayed` : '');
}

function updateLimitVisibility() {
  const wrap = document.getElementById('limit-row');
  wrap.style.display = state.splitBy === 'none' ? 'none' : 'flex';
}

function updateComparisonChart() {
  const slotData = slots.map(slot => {
    const filtered = filterRecords(allRecords, {
      country: slot.country,
      locType: slot.locType,
      brand: slot.brand,
      locationName: slot.locationName
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

function populateCountryDropdown() {
  const locSets = countByLocationKey(allRecords, r => r.countryName);
  const sorted = [...locSets.entries()].sort((a, b) => b[1].size - a[1].size);
  const sel = document.getElementById('country-select');
  sel.innerHTML = '<option value="">All Countries</option>';
  sorted.forEach(([country, locs]) => {
    const opt = document.createElement('option');
    opt.value = country;
    opt.textContent = `${country} (${locs.size})`;
    sel.appendChild(opt);
  });
}

function populateLocTypeDropdown() {
  const locSets = countByLocationKey(allRecords, r => r.osmTag);
  const sorted = [...locSets.entries()].sort((a, b) => b[1].size - a[1].size);
  const sel = document.getElementById('loctype-select');
  sel.innerHTML = '<option value="">All Location Types</option>';
  sorted.forEach(([tag, locs]) => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = `${tag} (${locs.size})`;
    sel.appendChild(opt);
  });
}

function populateSlotBrandDropdown(selectEl, records) {
  // Group by normalized key; store the first-seen original form as display label
  const brandMap = new Map(); // normKey -> { label, locs: Set }
  for (const r of records) {
    const raw = (r.brand || '').trim();
    if (!raw) continue;
    const key = normKey(raw);
    if (!brandMap.has(key)) brandMap.set(key, { label: raw, locs: new Set() });
    brandMap.get(key).locs.add(`${r.nwrType}-${r.nwrID}`);
  }
  const sorted = [...brandMap.entries()].sort((a, b) => b[1].locs.size - a[1].locs.size);
  selectEl.innerHTML = '<option value="">Any Brand</option>';
  sorted.forEach(([key, { label, locs }]) => {
    const opt = document.createElement('option');
    opt.value = key; // normalized — matches what filterRecords expects
    opt.textContent = `${label} (${locs.size})`;
    selectEl.appendChild(opt);
  });
}

function populateSlotLocTypeDropdown(selectEl, records) {
  const locSets = countByLocationKey(records, r => r.osmTag);
  const sorted = [...locSets.entries()].sort((a, b) => b[1].size - a[1].size);
  selectEl.innerHTML = '<option value="">Any Type</option>';
  sorted.forEach(([tag, locs]) => {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = `${tag} (${locs.size})`;
    selectEl.appendChild(opt);
  });
}

function populateSlotCountryDropdown(selectEl) {
  const locSets = countByLocationKey(allRecords, r => r.countryName);
  const sorted = [...locSets.entries()].sort((a, b) => b[1].size - a[1].size);
  selectEl.innerHTML = '<option value="">Any Country</option>';
  sorted.forEach(([country, locs]) => {
    const opt = document.createElement('option');
    opt.value = country;
    opt.textContent = `${country} (${locs.size})`;
    selectEl.appendChild(opt);
  });
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
    update();
  });

  sMax.addEventListener('input', () => {
    if (+sMax.value < +sMin.value) sMax.value = sMin.value;
    state.dateMax = +sMax.value;
    updateDateLabels();
    updateDateTrack();
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
  const tMin = allRecords.length ? Math.min(...allRecords.map(r => r._ts).filter(isFinite)) : 0;
  const tMax = allRecords.length ? Math.max(...allRecords.map(r => r._ts).filter(isFinite)) : Infinity;
  const sMin = document.getElementById('date-slider-min');
  const sMax = document.getElementById('date-slider-max');
  sMin.value = Math.max(min, +sMin.min);
  sMax.value = Math.min(max, +sMax.max);
  state.dateMin = +sMin.value;
  state.dateMax = +sMax.value;
  updateDateLabels();
  updateDateTrack();
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

// ─── Comparison slots ────────────────────────────────────────────────────────

function slotLabel(slot) {
  // Use brandDisplay (original casing) for label, not the normalized key
  const parts = [slot.country, slot.locType, slot.brandDisplay || slot.brand, slot.locationName].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'All Data';
}

function renderSlots() {
  const container = document.getElementById('slots-container');
  container.innerHTML = '';

  slots.forEach((slot, idx) => {
    const row = document.createElement('div');
    row.className = 'slot-row';
    row.style.borderLeftColor = slot.color;

    // Country select
    const cSel = document.createElement('select');
    cSel.title = 'Country';
    populateSlotCountryDropdown(cSel);
    cSel.value = slot.country;

    // LocType select (populated by country filter)
    const tSel = document.createElement('select');
    tSel.title = 'Location Type';
    const countryFiltered = slot.country ? allRecords.filter(r => r.countryName === slot.country) : allRecords;
    populateSlotLocTypeDropdown(tSel, countryFiltered);
    tSel.value = slot.locType;

    // Brand select (populated by country + locType)
    const bSel = document.createElement('select');
    bSel.title = 'Brand';
    const typeFiltered = countryFiltered.filter(r => !slot.locType || r.osmTag === slot.locType);
    populateSlotBrandDropdown(bSel, typeFiltered);
    bSel.value = slot.brand;

    // Name text input
    const nInp = document.createElement('input');
    nInp.type = 'text';
    nInp.placeholder = 'Name search…';
    nInp.value = slot.locationName || '';
    nInp.style.width = '120px';

    // Color dot
    const dot = document.createElement('span');
    dot.className = 'slot-color-dot';
    dot.style.background = slot.color;

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'slot-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => { slots.splice(idx, 1); renderSlots(); updateAddSlotBtn(); updateComparisonChart(); });

    // Label
    const labelEl = document.createElement('div');
    labelEl.className = 'slot-label';
    labelEl.textContent = slotLabel(slot);

    // Event: country changes → repopulate locType + brand
    cSel.addEventListener('change', () => {
      slot.country = cSel.value;
      const cf = slot.country ? allRecords.filter(r => r.countryName === slot.country) : allRecords;
      populateSlotLocTypeDropdown(tSel, cf);
      slot.locType = '';
      tSel.value = '';
      const tf = cf.filter(r => !slot.locType || r.osmTag === slot.locType);
      populateSlotBrandDropdown(bSel, tf);
      slot.brand = '';
      bSel.value = '';
      slot.label = slotLabel(slot);
      labelEl.textContent = slot.label;
      updateComparisonChart();
    });

    tSel.addEventListener('change', () => {
      slot.locType = tSel.value;
      const cf = slot.country ? allRecords.filter(r => r.countryName === slot.country) : allRecords;
      const tf = cf.filter(r => !slot.locType || r.osmTag === slot.locType);
      populateSlotBrandDropdown(bSel, tf);
      slot.brand = '';
      bSel.value = '';
      slot.label = slotLabel(slot);
      labelEl.textContent = slot.label;
      updateComparisonChart();
    });

    bSel.addEventListener('change', () => {
      slot.brand = bSel.value; // normalized key
      const selOpt = bSel.options[bSel.selectedIndex];
      slot.brandDisplay = selOpt.value ? selOpt.text.replace(/ \(\d+\)$/, '') : '';
      slot.label = slotLabel(slot);
      labelEl.textContent = slot.label;
      updateComparisonChart();
    });

    nInp.addEventListener('input', () => {
      slot.locationName = nInp.value;
      slot.label = slotLabel(slot);
      labelEl.textContent = slot.label;
      updateComparisonChart();
    });

    row.appendChild(dot);
    row.appendChild(cSel);
    row.appendChild(tSel);
    row.appendChild(bSel);
    row.appendChild(nInp);
    row.appendChild(removeBtn);
    row.appendChild(labelEl);
    container.appendChild(row);
  });

  // Ensure comparison chart canvas is in its wrapper
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
    country: '',
    locType: '',
    brand: '',
    brandDisplay: '',
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

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireEvents() {
  document.getElementById('country-select').addEventListener('change', e => {
    state.country = e.target.value;
    update();
  });

  document.getElementById('loctype-select').addEventListener('change', e => {
    state.locType = e.target.value;
    update();
  });

  document.querySelectorAll('input[name="split"]').forEach(radio => {
    radio.addEventListener('change', e => {
      state.splitBy = e.target.value;
      update();
    });
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

  document.getElementById('show-items').addEventListener('change', e => {
    state.showItems = e.target.checked;
    update();
    if (slots.length > 0) updateComparisonChart();
  });

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

      populateCountryDropdown();
      populateLocTypeDropdown();
      initDateSlider();
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
