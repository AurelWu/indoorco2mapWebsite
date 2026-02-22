// legend.js

const normal = {
  BlueYellowRed: {
    colors: ['#00008b', '#add8e6', '#cdc134', '#ffa500', '#ff0000'],
    labels: ['<600ppm', '600-799ppm', '800-999ppm', '1000-1199ppm', '≥1200ppm']
  },
  GreenYellowRed: {
    colors: ['#006400', '#90ee90', '#cdc134', '#ffa500', '#ff0000'],
    labels: ['<600ppm', '600-799ppm', '800-999ppm', '1000-1199ppm', '≥1200ppm']
  }
};

// IAQS mode: named categories + ppm range on a second line
const iaqs = {
  items: [
    { color: '#648eff', title: 'Good (10-8)',      sub: '≤ 800 ppm' },
    { color: '#ffb000', title: 'Moderate (7-4)',  sub: '801–1400 ppm' },
    { color: '#ff190c', title: 'Unhealthy (3-0)', sub: '> 1400 ppm' }
  ]
};

export function createLegend() {
  bindExternalIaqsTriggers();
  const toggleButton = document.getElementById('legend-toggle');
  toggleButton.addEventListener('click', () => {
    const legendContent = document.getElementById('legend-content');
    const isVisible = legendContent.style.display !== 'none';
    legendContent.style.display = isVisible ? 'none' : 'block';
    toggleButton.textContent = isVisible ? 'Legend ▶' : '▼';
  });
}

export function renderLegend(colorScheme, useIaqsMode) {
  const legendContent = document.getElementById('legend-content');
  legendContent.innerHTML = '';

  if (useIaqsMode) {
    // Optional compact header
    if (iaqs.header) {
      const header = document.createElement('div');
      header.className = 'legend-header';
      header.textContent = iaqs.header;
      legendContent.appendChild(header);
    }

    for (const item of iaqs.items) {
      const legendItem = document.createElement('div');
      legendItem.className = 'legend-item';

      const colorBox = document.createElement('span');
      colorBox.className = 'legend-color';
      colorBox.style.backgroundColor = item.color;

      const labelWrap = document.createElement('div');
      labelWrap.className = 'legend-label';

      const title = document.createElement('div');
      title.className = 'legend-title';
      title.textContent = item.title;

      const sub = document.createElement('div');
      sub.className = 'legend-sub';
      sub.textContent = item.sub;

      labelWrap.appendChild(title);
      labelWrap.appendChild(sub);

      legendItem.appendChild(colorBox);
      legendItem.appendChild(labelWrap);
      legendContent.appendChild(legendItem);
    }

    legendContent.style.display = 'block';
    
    ensureIaqsOverlayHandlers();

const aboutLink = document.createElement('div');
aboutLink.className = 'legend-about-link';
aboutLink.textContent = 'About GO IAQS';

aboutLink.addEventListener('click', (e) => {
  e.stopPropagation();
  openIaqsOverlay();
});

legendContent.appendChild(aboutLink);


    return;
  }

  // Normal mode: keep your existing compact single-line labels
  const mode = normal[colorScheme] ?? normal.BlueYellowRed;

  for (let i = 0; i < mode.labels.length; i++) {
    const legendItem = document.createElement('div');
    legendItem.className = 'legend-item';

    const colorBox = document.createElement('span');
    colorBox.className = 'legend-color';
    colorBox.style.backgroundColor = mode.colors[i];

    const label = document.createElement('span');
    label.className = 'legend-normal-label';
    label.textContent = mode.labels[i];

    legendItem.appendChild(colorBox);
    legendItem.appendChild(label);
    legendContent.appendChild(legendItem);
  }

  legendContent.style.display = 'block';
}



export function openIaqsOverlay() {
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
