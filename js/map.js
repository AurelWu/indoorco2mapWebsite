
export class MapManager {
  constructor(containerId = 'map', styleUrl = './styles/osm-style.json') {
    this.containerId = containerId;
    this.styleUrl = styleUrl;
    this.map = null;
    this.deckOverlay = null;
    this.isHovering = false;
    this.tooltipEl = null;
    this.markerSize = 1;
    this.markerStyle = 'style1';
    this.colorScheme = 'BlueYellowRed';
    this.textLayer = null;
    this.iconLayer = null;
    this.highlightLayer = null;
    this.currentMarkerData = [];
    this.enableLabels = true;
    this.labelSize = 12;
    this.selectedMarker = null;
    this.params = this.getURLParams();

    this.center = this.params ? [this.params.lng, this.params.lat] : [10.4515, 51.1657];
    this.zoom = this.params?.zoom ?? 6;
    
  }

  getURLParams() {
        const params = new URLSearchParams(window.location.search);
        const lat = parseFloat(params.get('lat'));
        const lng = parseFloat(params.get('lng'));
        const zoom = parseFloat(params.get('zoom'), 10);
        
        if (!isNaN(lat) && !isNaN(lng)) {
            return { lat, lng, zoom: !isNaN(zoom) ? zoom : undefined };
        }
        return null;
    }

    updateURLFromMap() {
        const center = this.map.getCenter();
        const zoom = this.map.getZoom().toFixed(2);
        const newUrl = `${window.location.pathname}?lat=${center.lat.toFixed(5)}&lng=${center.lng.toFixed(5)}&zoom=${zoom}`;
        window.history.replaceState({}, '', newUrl);
    }

  async loadImageAsync(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  setMarkerSize(size) {
  if (size !== undefined) {
    this.markerSize = size;
  }
}

setMarkerStyle(style) {
  if (style !== undefined) {
    this.markerStyle = style;
  }
}

setShowLabels(enabled) {
  if (enabled !== undefined) {
    this.enableLabels = enabled;
  }
}

setColorScheme(scheme) {
  if (scheme !== undefined) {
    this.colorScheme = scheme;
  }
}

setFontSize(fontSize) {
  const parsed = parseInt(fontSize, 10);
  this.labelSize = isNaN(parsed) ? 12 : parsed;
  this.renderTextLabels(this.currentMarkerData);
}

showPopup(data) {
  const existingPopup = document.getElementById('marker-popup');
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement('div');
  popup.id = 'marker-popup';
  popup.className = 'marker-popup';
  document.body.appendChild(popup);

  const pageSize = 5;
  let currentPage = 0;

  const sortedMeasurements = [...data.measurementData].sort((a, b) => b.startTime - a.startTime);
  const title = `<strong>${data.nwrname}</strong> Ø: ${Math.round(data.ppmavg)} ppm CO₂`;

  function renderPage() {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    const pageData = sortedMeasurements.slice(start, end);

    const canvasId = 'co2ChartCanvas';
    const canvasHtml = `<canvas id="${canvasId}" width="370" height="285"></canvas>`;

    const hasPrev = currentPage > 0;
    const hasNext = end < sortedMeasurements.length;

    const paginationHtml = `
      <div id="pagination-controls" style="margin-top: 10px;">
        <button id="prevPageBtn" ${!hasPrev ? 'disabled' : ''}>Previous</button>
        <button id="nextPageBtn" ${!hasNext ? 'disabled' : ''}>Next</button>
      </div>
    `;

    popup.innerHTML = `
      <div class="popup-content">
        ${title}<br>
        ${canvasHtml}
      </div>
    `;

    setTimeout(() => {
      const ctx = document.getElementById(canvasId).getContext('2d');
      const maxLength = Math.max(...pageData.map(m => m.co2array.length));
      const chartData = {
        
        labels: Array.from({ length: maxLength }, (_, i) => i + 1),
        datasets: pageData.map((m, i) => {
          const avg = m.co2array.reduce((a, b) => a + b, 0) / m.co2array.length;
          const grayValue = Math.floor((i / (pageData.length - 1 || 1)) * 220);
          const color = `rgb(${grayValue}, ${grayValue}, ${grayValue})`;
          const date = new Date(Number(m.startTime));
          const formattedDate = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
          const label = `Ø ${Math.round(avg)} ppm CO₂ @ ${formattedDate}`;

          return {
            label: label,
            data: m.co2array,
            borderColor: color,
            backgroundColor: color,
            fill: false,
            tension: 0.3,
            pointRadius: 2,
            hidden: false,
            ventilation: m.ventilation,
            openwindows: m.openwindows,
            customnotes: m.customnotes
          };
        })
      };

      const chartOptions = {
        responsive: false,
        maintainAspectRatio: false,
        scales: {
          y: {
            title: { display: true, text: 'CO₂ (ppm)' },
            beginAtZero: false,
            min: 400
          },
          x: {
            title: { display: true, text: 'Minute of Measurement' }
          }
        },
        plugins: {
          legend: { display: false },
          /*tooltip: {
            mode: 'nearest',  // The mode that triggers tooltips (can be 'nearest', 'index', 'dataset', etc.)
            intersect: false, // This ensures tooltips show when hovering close to a line (even if you’re not directly over a point)
            axis: 'xy', // You can use 'x', 'y', or 'xy' depending on how you want the tooltip to interact with axis
            distance: 3 // Adjust this number to control how far you can hover from the line to trigger the tooltip
          }*/
        },
        layout: {
          padding: { right: 20 }
        }
      };

      if (window.co2Chart) {
        window.co2Chart.destroy();
      }

      const chart = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: chartOptions
      });
      window.co2Chart = chart;

      // Build legend above pagination
      const legendContainer = document.createElement('div');
      legendContainer.style.margin = '1px 0';

let activeTooltip = null;

chartData.datasets.forEach((dataset, index) => {
  const legendItem = document.createElement('div');
  legendItem.style.fontSize = '12px';
  legendItem.style.marginBottom = '4px';
  legendItem.style.cursor = 'pointer';
  legendItem.style.display = 'flex';
  legendItem.style.alignItems = 'center';

  const colorBox = document.createElement('span');
  colorBox.style.display = 'inline-block';
  colorBox.style.width = '10px';
  colorBox.style.height = '10px';
  colorBox.style.marginRight = '6px';
  colorBox.style.backgroundColor = dataset.borderColor;

  const labelSpan = document.createElement('span');
  labelSpan.textContent = dataset.label;
  labelSpan.style.marginRight = '8px';

  const infoIcon = document.createElement('span');
  infoIcon.textContent = 'ℹ'; // Unicode info symbol
  infoIcon.style.marginLeft = '6px';
  infoIcon.style.fontSize = '13px';
  infoIcon.style.cursor = 'pointer';
  
const tooltipText = `
  <strong>Open Windows:</strong> ${dataset.openwindows || 'N/A'}<br>
  <strong>Ventilation:</strong> ${dataset.ventilation || 'N/A'}<br>
  <strong>Notes:</strong> ${dataset.customnotes || 'N/A'}
`;

  const tooltip = document.createElement('div');
  tooltip.innerHTML = tooltipText;
  tooltip.style.position = 'absolute';
  tooltip.style.background = '#f0f0f0';
  tooltip.style.border = '1px solid #ccc';
  tooltip.style.padding = '6px 10px';
  tooltip.style.fontSize = '12px';
  tooltip.style.borderRadius = '5px';
  tooltip.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
  tooltip.style.zIndex = '1000';
  tooltip.style.display = 'none';

  document.body.appendChild(tooltip);

  infoIcon.addEventListener('click', (e) => {
    e.stopPropagation(); // Don't toggle the chart line

    // Hide existing tooltip
    if (activeTooltip && activeTooltip !== tooltip) {
      activeTooltip.style.display = 'none';
    }

    const rect = infoIcon.getBoundingClientRect();
    tooltip.style.left = `${rect.left}px`;
    tooltip.style.top = `${rect.bottom + window.scrollY + 4}px`;
    tooltip.style.display = 'block';

    activeTooltip = tooltip;
  });

  legendItem.appendChild(colorBox);
  legendItem.appendChild(labelSpan);
  legendItem.appendChild(infoIcon);

    // Add the click event only to the text part (labelSpan)
  labelSpan.addEventListener('click', () => {
    const meta = chart.getDatasetMeta(index);
    const isHidden = meta.hidden === null ? chart.data.datasets[index].hidden : meta.hidden;
    meta.hidden = !isHidden;
    chart.update();

    // Toggle strike-through
    labelSpan.style.textDecoration = !isHidden ? 'line-through' : 'none';
    labelSpan.style.opacity = !isHidden ? '0.5' : '1';
  });

  legendContainer.appendChild(legendItem);
});

// Global click to close tooltip
document.addEventListener('click', (e) => {
  if (activeTooltip && !activeTooltip.contains(e.target)) {
    activeTooltip.style.display = 'none';
    activeTooltip = null;
  }
}, true);

      const popupContent = popup.querySelector('.popup-content');
      popupContent.appendChild(legendContainer);
      popupContent.insertAdjacentHTML('beforeend', paginationHtml);

      document.getElementById('prevPageBtn')?.addEventListener('click', () => {
        if (currentPage > 0) {
          currentPage--;
          renderPage();
        }
      });

      document.getElementById('nextPageBtn')?.addEventListener('click', () => {
        if (currentPage < Math.ceil(sortedMeasurements.length / pageSize) - 1) {
          currentPage++;
          renderPage();
        }
      });

    }, 0);
  }

  renderPage();
}






  getAtlasConfig() {
    const useGreen = this.colorScheme === 'GreenYellowRed';
    const suffix = useGreen ? '_green' : '';

    if (this.markerStyle === 'style2') {
      return {
        atlas: `./images/marker-atlas2${suffix}.png`,
        mapping: {
          blue: { x: 0, y: 0, width: 32, height: 32, anchorY: 32 },
          brightblue: { x: 32, y: 0, width: 32, height: 32, anchorY: 32 },
          yellow: { x: 64, y: 0, width: 32, height: 32, anchorY: 32 },
          orange: { x: 96, y: 0, width: 32, height: 32, anchorY: 32 },
          red: { x: 128, y: 0, width: 32, height: 32, anchorY: 32 }
        }
      };
    }

    // Default: style1
    return {
      atlas: `./images/marker-atlas${suffix}.png`,
      mapping: {
        blue: { x: 0, y: 0, width: 25, height: 41, anchorY: 41 },
        brightblue: { x: 25, y: 0, width: 25, height: 41, anchorY: 41 },
        yellow: { x: 50, y: 0, width: 25, height: 41, anchorY: 41 },
        orange: { x: 75, y: 0, width: 25, height: 41, anchorY: 41 },
        red: { x: 100, y: 0, width: 25, height: 41, anchorY: 41 }
      }
    };
  }

  iconNames = ['blue', 'brightblue', 'yellow', 'orange', 'red'];

  async initialize() {
    try {
      this.map = new maplibregl.Map({
        container: this.containerId,
        style: this.styleUrl,
        center: this.center,
        zoom: this.zoom,
        pitch: 0,
        bearing: 0,
        dragRotate: false
      });
    } catch (e) {
      const errorBody = JSON.parse(e.message);
      if (errorBody.type === 'webglcontextcreationerror') {
        throw new Error('This browser or device doesn\'t support WebGL');
      } else {
        throw new Error('An unknown issue occured while creating the map');
      }
    }

    this.map.dragRotate.disable();
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();    
    this.map.on('moveend', () => this.updateURLFromMap());
    this.updateURLFromMap();
   
    this.createTooltipElement();

    await new Promise(resolve => {
      this.map.on('load', () => {
        this.addDeckOverlay();
        resolve();
      });
    });

    this.map.getCanvas().addEventListener('click', () => {
  if (!this.isHovering) {
    this.tooltipEl.style.display = 'none';

    // 🔽 Also remove the popup if it exists
    const existingPopup = document.getElementById('marker-popup');
    if (existingPopup) existingPopup.remove();

    // 🔽 Clear highlighted marker
    this.selectedMarker = null;
    this.highlightedMarkerId = null;
    this.renderCO2Markers(this.currentMarkerData); // or however you reapply the Deck.gl layers
  }
});

    // ⬇️ Re-render labels on zoom
    this.map.on('zoom', () => {
      
document.fonts.ready.then(() => {
this.renderTextLabels(this.currentMarkerData);
});
    });
  }

  createTooltipElement() {
    this.tooltipEl = document.createElement('div');
    Object.assign(this.tooltipEl.style, {
      position: 'absolute',
      pointerEvents: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      color: '#fff',
      padding: '4px 8px',
      borderRadius: '4px',
      fontSize: '12px',
      zIndex: '10',
      display: 'none'
    });
    document.body.appendChild(this.tooltipEl);
  }

  addDeckOverlay() {
    this.deckOverlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
      getCursor: () => (this.isHovering ? 'pointer' : 'grab')
    });

    this.map.addControl(this.deckOverlay);
  }

  async renderCO2Markers(markerData) {
    this.currentMarkerData = markerData;

    const { atlas, mapping } = this.getAtlasConfig();

    try {
      await this.loadImageAsync(atlas);

      this.iconLayer = new deck.IconLayer({
        id: 'co2-icon-layer',
        data: markerData,
        pickable: true,
        iconAtlas: atlas,
        iconMapping: mapping,
        getIcon: d => d.icon,
        sizeScale: this.markerSize,
        getPosition: d => d.coordinates,
        getSize: 25,
        getColor: [255, 255, 255],
        onClick: ({ object }) => {
          if (object) {
            this.selectedMarker = object;
            this.updateHighlightLayer();
            this.showPopup(object);
          }
        },
        onHover: info => {
          this.isHovering = !!info.object;
        }
      });

      this.updateHighlightLayer();
      this.renderTextLabels(markerData);

    } catch (err) {
      console.error('Failed to load iconAtlas image:', atlas, err);
    }
  }

updateHighlightLayer() {
  if (!this.selectedMarker) {
    this.highlightLayer = null;
  } else {
    const highlightIcon = {
      ...this.selectedMarker // same icon, coordinates, etc.
    };

    this.highlightLayer = new deck.IconLayer({
      id: 'highlight-layer',
      data: [highlightIcon],
      iconAtlas: this.getAtlasConfig().atlas,
      iconMapping: this.getAtlasConfig().mapping,
      getIcon: d => d.icon,
      getPosition: d => d.coordinates,
      sizeScale: this.markerSize * 1.3, // slightly larger
      getSize: 25,
      pickable: false,
      parameters: {
        depthTest: false, // render on top
        blendEquation: 32774 // GL.FUNC_ADD
      }
    });
  }

  const layers = [this.iconLayer];
if (this.textLayer) layers.push(this.textLayer);         // Optional label
if (this.highlightLayer) layers.push(this.highlightLayer); // Draw highlight last

  this.deckOverlay.setProps({ layers });
}

  renderTextLabels(markerData) {
    const zoom = this.map.getZoom();
    const showLabels = this.enableLabels && this.map.getZoom() >= 15;
    const fontSize = this.labelSize;
    this.textLayer = showLabels ? new deck.TextLayer({
      id: 'text-layer',
      data: markerData,
      collisionEnabled: true,
      getPosition: d => d.coordinates,
      getText: d => d.nwrname || '',
      getSize: fontSize,
      getColor: [0, 0, 0, 255],
      getAngle: 0,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      fontFamily: '"Segoe UI", Roboto, "Helvetica Neue", "Arial", "sans-serif"',
      characterSet: 'auto',
      background: true,
  backgroundPadding: [3, 1], // [horizontal, vertical]
  getBackgroundColor: [255, 255, 255, 255] // light background with some transparency
    }) : null;

    const layers = [this.iconLayer];
    if (this.textLayer) layers.push(this.textLayer);
    if(this.deckOverlay)
{
    this.deckOverlay.setProps({ layers });
}



  }
}
