import { CO2DataManager } from './dataLoader.js';
import { MapManager } from './map.js';
import { createLegend } from './legend.js';
import { renderLegend } from './legend.js';
import { renderHistogram } from './histogram.js';

const dataUrl = 'https://indoorco2map.com/chartdata/IndoorCO2MapData.json.gz';

const dataManager = new CO2DataManager();
const mapManager = new MapManager();

let useIaqsScore = false;

async function initData() { 

  ensureIaqsOverlayHandlers();
  createLegend();
  renderLegend(mapManager.colorScheme, useIaqsScore);
  await dataManager.loadData(dataUrl);
  const averages = dataManager.getAverages();
  
const markerData = Object.entries(averages)
    .filter(([_, avg]) => typeof avg === 'number')
    .map(([id, avg]) => {
        const locationData = dataManager.getFilteredData()[id]; // All data for this location
        const samples = locationData.measurements; // Access measurements for the location
        const firstSample = samples[0]; // Use the first sample for coordinates and name

        // Prepare the additional data for each measurement
        const measurementData = samples.map(sample => ({
            startTime: sample.startTime || '',
            co2array: sample.co2array ? sample.co2array.split(';').map(Number) : [], 
            ventilation: sample.ventilation || '',
            openwindows: sample.openwindows || '',
            customnotes: sample.customnotes || ''
        }));

        // Return the marker data with the added measurement info
        return {
            coordinates: [firstSample.lon, firstSample.lat],
            icon: getMarkerColor(avg),
            ppmavg: avg,
            nwrname: firstSample.nwrname || '',
            countryname: locationData.countryname || '', // Include country name from the location data
            measurementData: measurementData // Add the full measurement data here
        };
    });

  mapManager.renderCO2Markers(markerData);
  // Add event listeners for the buttons




document.getElementById('centerMapBtn').addEventListener('click', centerMapOnLocation);
document.getElementById('zoomToWorldBtn').addEventListener('click', zoomToWorld);

  document.getElementById('namefilterInput').addEventListener('input', applyAllFilters);
  document.getElementById('dateFrom').addEventListener('change', applyAllFilters);
  document.getElementById('dateTo').addEventListener('change', applyAllFilters);
  document.getElementById('settings-icon').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
});
  document.getElementById('markerSizeSlider').addEventListener('input', (e) => {
  const newSize = parseFloat(e.target.value);
  mapManager.setMarkerSize(newSize);
  applyAllFilters(); // triggers re-render
});
  const markerStyleSelect = document.getElementById('markerStyleSelect');
  markerStyleSelect.addEventListener('change', async (e) => {
  const selectedStyle = e.target.value;
  mapManager.setMarkerStyle(selectedStyle);
  applyAllFilters(); // triggers re-render
});
  const colorSelect = document.getElementById('colorSchemeSelect');
  colorSelect.addEventListener('change', () => {
  mapManager.colorScheme = colorSelect.value;
  renderLegend(mapManager.colorScheme, useIaqsScore);
  applyAllFilters(); // triggers re-render
});
  const labelToggle = document.getElementById('labelToggle');
  labelToggle.addEventListener('change', () => {
  mapManager.setShowLabels(labelToggle.checked);
  applyAllFilters(); // triggers re-render
});

const countryFilter = document.getElementById('countryFilter');
countryFilter.addEventListener('change', () => {
  applyAllFilters(); // triggers re-filter and re-render
});

const locationTypeFilter = document.getElementById('locationTypeFilter');
locationTypeFilter.addEventListener('change', () => {
  applyAllFilters();
});

const labelFontSizeInput = document.getElementById('labelFontSize');
labelFontSizeInput.addEventListener("input", () => {
  mapManager.setFontSize(labelFontSizeInput.value);
  saveSettings();
  applyAllFilters();
});

const minScoreSlider = document.getElementById('minScore');
const maxScoreSlider = document.getElementById('maxScore');

minScoreSlider.addEventListener('input', () => {
  applyAllFilters();
});

maxScoreSlider.addEventListener('input', () => {
  applyAllFilters();
});

// Get elements once
const toggleButton = document.getElementById('toggleHistogram');
const histogramContainer = document.getElementById('histogramContainer');
const closeHistogramBtn = document.getElementById('closeHistogram');

// === Toggle button ===
toggleButton.addEventListener('click', function(event) {
  event.stopPropagation();

  histogramContainer.classList.toggle('hidden');

  if (!histogramContainer.classList.contains('hidden')) {
    renderHistogram(dataManager.getFilteredData());
  }
});

// === Prevent clicks inside container from bubbling ===
histogramContainer.addEventListener('click', function(event) {
  event.stopPropagation();
});

// === Close button (top-right X) ===
closeHistogramBtn.addEventListener('click', function(event) {
  event.stopPropagation(); // good practice
  histogramContainer.classList.add('hidden');
});
  
document.getElementById("colorSchemeSelect").addEventListener("change", saveSettings);
document.getElementById("markerStyleSelect").addEventListener("change", saveSettings);
document.getElementById("labelToggle").addEventListener("change", saveSettings);
document.getElementById("storeLocationBtn").addEventListener("click", saveCurrentViewAsDefault);


    const aboutLink = document.getElementById('iaqsAboutLink');
    if (aboutLink && !aboutLink.dataset.bound) {
        aboutLink.addEventListener('click', (e) => {
            e.stopPropagation();
            ensureIaqsOverlayHandlers();
            openIaqsOverlay();
        });
        aboutLink.dataset.bound = '1';
    }



const iaqsCheckbox = document.getElementById("useIaqsScore");
iaqsCheckbox.addEventListener("change", () => {
  useIaqsScore = iaqsCheckbox.checked;
  mapManager.setUseIaqs(useIaqsScore);
  // Update legend + markers
    saveSettings();
  renderLegend(mapManager.colorScheme, useIaqsScore);
    applyAllFilters();
});

const title = document.querySelector('#iaqs-toggle .open-iaqs-modal');
if (title) {
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    openIaqsOverlay();
  });
}


function saveSettings() {
  // Load existing settings or start with empty object
  const settings = JSON.parse(localStorage.getItem("mapSettings")) || {};

    // Update only relevant keys
  settings.useIaqsScore = document.getElementById("useIaqsScore").checked;
  settings.colorScheme = document.getElementById("colorSchemeSelect").value;
  settings.markerStyle = document.getElementById("markerStyleSelect").value;
  settings.showLabels = document.getElementById("labelToggle").checked;
  settings.labelFontSize = labelFontSizeInput.value;

  // Save back to localStorage
  localStorage.setItem("mapSettings", JSON.stringify(settings));
}

function saveCurrentViewAsDefault() {
  const center = mapManager.map.getCenter();
  const zoom = mapManager.map.getZoom();

  // Get existing settings or create new
  const settings = JSON.parse(localStorage.getItem("mapSettings")) || {};

  settings.view = {
    lat: center.lat,
    lng: center.lng,
    zoom: zoom
  };

  localStorage.setItem("mapSettings", JSON.stringify(settings));
}

  applyAllFilters();
  initializeDateRangeInputs();
  initializeCountryDropdown();
  initializeLocationTypeDropdown();

}

function applyAllFilters() {
  // Get the original dataset
  let data = dataManager.getAllProcessedData();

  // === 1. Filter by name ===
  const nameFilterValue = document.getElementById('namefilterInput').value.trim();
  if (nameFilterValue) {
    data = dataManager.filterByName(nameFilterValue, data);
  }

  // === 2. Filter by date range ===
  const fromInput = document.getElementById('dateFrom').value;
  const toInput = document.getElementById('dateTo').value;
  const fromDate = fromInput ? new Date(fromInput) : null;
  const toDate = toInput ? new Date(toInput) : null;

  if (fromDate || toDate) {
    const minDate = fromDate || new Date('2000-01-01'); // fallback
    const maxDate = toDate || new Date();               // fallback
    data = dataManager.filterByDate(minDate, maxDate, data);
  }

  // === 3. filter by country ===
  const countryFilterValue = document.getElementById('countryFilter').value;
  data = dataManager.filterByCountry(countryFilterValue, data);
  
  // 4. Filter by location type
  const locationTypeValue = document.getElementById('locationTypeFilter').value;
  data = dataManager.filterByLocationType(locationTypeValue, data);

  // === 4b. Filter by CO2 score range (slider) ===
  const minScoreValue = document.getElementById("minScore").value;
  const maxScoreValue = document.getElementById("maxScore").value;
  data = dataManager.filterByCO2ScoreRange(minScoreValue, maxScoreValue, data);

  // === 5. Get averages from filtered data ===
  const averages = dataManager.getAverages(); // now works only on filtered data
  const filteredData = dataManager.getFilteredData();

 // === 6. Prepare marker data with detailed measurements ===
const markerData = Object.entries(averages)
  .filter(([_, avg]) => typeof avg === 'number')
  .map(([id, avg]) => {
    const entry = filteredData[id];
    if (!entry || !entry.measurements || entry.measurements.length === 0) return null;

    const firstSample = entry.measurements[0]; // For metadata like ventilation, etc.
    const { lat, lon, nwrname } = firstSample || {};

    const measurementData = entry.measurements.map(sample => ({
      startTime: sample.startTime || '',
      co2array: sample.co2array?.split(';').map(Number) || [],
      ventilation: sample.ventilation || '',
      openwindows: sample.openwindows || '',
      customnotes: sample.customnotes || ''
    }));

    return {
      coordinates: [lon, lat],
      icon: getMarkerColor(avg),
      ppmavg: avg,
      nwrname: nwrname || '',
      measurementData
    };
  })
  .filter(Boolean); // Remove any nulls

  // === 7. Render markers ===
  mapManager.renderCO2Markers(markerData);
  if(dataManager.getFilteredData())
{
  renderHistogram(dataManager.getFilteredData());
}
}


// === LOADING UI FUNCTIONS ===
function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

function showLoadingError(error) {
  document.getElementById('loading-spinner').style.display = 'none';
  document.getElementById('loading-error').style.display = 'block';
  document.getElementById('loading-error-message').textContent = error.message;
}

function setupRetryHandler() {
  const retryButton = document.getElementById('retry-button');
  retryButton.addEventListener('click', () => {
    document.getElementById('loading-spinner').style.display = 'block';
    document.getElementById('loading-error').style.display = 'none';
    initData().then(hideLoadingOverlay).catch(showLoadingError);
  });
}

function getMarkerColor(ppm) {

  if (useIaqsScore) {
    // GO IAQS Score
    if (ppm < 801) return 'blue';
    if (ppm < 1401) return 'orange';
    return 'red';
  }

  // Normal scheme
  if (ppm < 600) return 'blue';
  if (ppm < 800) return 'brightblue';
  if (ppm < 1000) return 'yellow';
  if (ppm < 1200) return 'orange';
  return 'red';
}

function initializeDateRangeInputs() {
  const allData = dataManager.getAllProcessedData();

  let minDate = new Date();     // Initialize to now
  let maxDate = new Date(0);    // Initialize to epoch

  for (const entry of Object.values(allData)) {
    const measurements = entry.measurements || [];
    for (const m of measurements) {
      const d = new Date(m.startTime);
      if (!isNaN(d)) {
        if (d < minDate) minDate = d;
        if (d > maxDate) maxDate = d;
      }
    }
  }

  const dateFromInput = document.getElementById('dateFrom');
  const dateToInput = document.getElementById('dateTo');

  const formatDate = d => d.toISOString().split('T')[0];

  dateFromInput.value = formatDate(minDate);
  dateToInput.value = formatDate(maxDate); // Use max found date instead of today's date
}

function initializeCountryDropdown() {
  const allData = dataManager.getAllProcessedData();
  const countryCounts = {};

  for (const entry of Object.values(allData)) {
    const country = entry.countryname || 'Unknown';
    countryCounts[country] = (countryCounts[country] || 0) + 1;
  }

  // Sort countries by count descending
  const sortedCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1]);

  const dropdown = document.getElementById('countryFilter');
  dropdown.innerHTML = ''; // Clear existing options

  // Add default option
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'All Countries';
  dropdown.appendChild(defaultOption);

  // Add sorted country options
  for (const [country, count] of sortedCountries) {
    const option = document.createElement('option');
    option.value = country;
    option.textContent = `${country}`;
    dropdown.appendChild(option);
  }
}

function initializeLocationTypeDropdown() {
  const allData = dataManager.getAllProcessedData();
  const typeCounts = {};

  for (const entry of Object.values(allData)) {
    const type = (entry.osmkey || '') + '_' + (entry.osmtag || '');
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  // Sort descending by frequency
  const sortedTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1]);

  const dropdown = document.getElementById('locationTypeFilter');
  dropdown.innerHTML = ''; // Clear existing options

  // Add default
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'All Types';
  dropdown.appendChild(defaultOption);

  // Add sorted entries
  for (const [type, count] of sortedTypes) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = `${type.substring(0,24)}`;
    dropdown.appendChild(option);
  }
}

function centerMapOnLocation() {
    if (navigator.geolocation) {
        // Requesting current position
        navigator.geolocation.getCurrentPosition(function(position) {
            var lat = position.coords.latitude;
            var lng = position.coords.longitude;

            // Get current zoom level
            var currentZoom = mapManager.map.getZoom();

            // Set zoom level to 13 if current zoom is lower, otherwise keep the current zoom
            var zoomLevel = currentZoom > 13 ? currentZoom : 13;

            // Center the map using mapManager
            mapManager.map.flyTo({
                center: [lng, lat],
                zoom: zoomLevel,  // Use the calculated zoom level
                essential: true // Ensures the animation is essential for accessibility
            });
        }, function(error) {
            // Handle different error cases
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    alert('Geolocation permission denied. Please enable location services.');
                    break;
                case error.POSITION_UNAVAILABLE:
                    alert('Location information is unavailable. Please check your connection.');
                    break;
                case error.TIMEOUT:
                    alert('The request to get user location timed out.');
                    break;
                default:
                    alert('An unknown error occurred while retrieving your location.');
                    break;
            }
        });
    } else {
        alert('Geolocation is not supported by this browser.');
    }
}



function zoomToWorld() {
    // Define the bounds that include all continents except Antarctica, and enough of the northern regions to include Alaska
    var bounds = [
        [-170, -55], // Southwest corner: Southern tip of South America, near New Zealand
        [179, 72]    // Northeast corner: Just above Alaska, excluding most of the Arctic
    ];

    // Fit the map using mapManager
    mapManager.map.fitBounds(bounds, {
        padding: {top: 10, bottom: 10, left: 10, right: 10} // Optional padding for better visibility
    });
}

function isDefaultViewInUrl() {
  const params = new URLSearchParams(window.location.search);
  const lat = parseFloat(params.get("lat"));
  const lng = parseFloat(params.get("lng"));
  const zoom = parseFloat(params.get("zoom"));

  return (
    lat === 51.16570 &&
    lng === 10.45150 &&
    zoom === 6.00
  );
}


// === INIT APP ===

   window.addEventListener("DOMContentLoaded", () => {
  const savedSettings = localStorage.getItem("mapSettings");
  if (savedSettings) {
      const { colorScheme, markerStyle, showLabels, labelFontSize, view, useIaqsScore: savedIaqs } = JSON.parse(savedSettings);
    document.getElementById("colorSchemeSelect").value = colorScheme ?? "BlueYellowRed";    
    document.getElementById("markerStyleSelect").value = markerStyle ?? "style1";
    document.getElementById("labelToggle").checked = showLabels ?? true;
      document.getElementById("labelFontSize").value = labelFontSize || 11;
      
      const iaqsCheckbox = document.getElementById("useIaqsScore");
      const iaqsEnabled = savedIaqs ?? false;
      iaqsCheckbox.checked = iaqsEnabled;
      useIaqsScore = iaqsEnabled;
      mapManager.setUseIaqs(useIaqsScore);

    mapManager.setMarkerStyle(markerStyle);
    mapManager.setColorScheme(colorScheme);
    mapManager.setShowLabels(showLabels);
    mapManager.setFontSize(labelFontSize);

    if (view && isDefaultViewInUrl()) {
      mapManager.map.setCenter([view.lng, view.lat]);
      mapManager.map.setZoom(view.zoom);
    }

  }
});

setupRetryHandler();
await mapManager.initialize()
  .then(() => initData())
  .then(hideLoadingOverlay)
  .catch(error => {
    console.error('Initialization failed:', error);
    showLoadingError(error);
  });


function openIaqsOverlay() {
    const overlay = document.getElementById('iaqsOverlay');
    if (!overlay) return;

    overlay.classList.remove('hidden');

    // Close when clicking outside the card
    overlay.addEventListener('click', onOverlayClick);
}

function closeIaqsOverlay() {
    const overlay = document.getElementById('iaqsOverlay');
    if (!overlay) return;

    overlay.classList.add('hidden');
    overlay.removeEventListener('click', onOverlayClick);
}

function onOverlayClick(e) {
    // click on the dark background closes; click inside card doesn't
    if (e.target && e.target.id === 'iaqsOverlay') {
        closeIaqsOverlay();
    }
}

function ensureIaqsOverlayHandlers() {
    const closeBtn = document.getElementById('closeIaqsOverlay');
    if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.addEventListener('click', closeIaqsOverlay);
        closeBtn.dataset.bound = '1';
    }
}

function bindExternalIaqsTriggers() {
    document.querySelectorAll('.open-iaqs-modal').forEach(el => {
        if (el.dataset.bound) return;
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            ensureIaqsOverlayHandlers();
            openIaqsOverlay();
        });
        el.dataset.bound = '1';
    });
}

