const colorsBlue = ['#00008b', '#add8e6', '#cdc134', '#ffa500', '#ff0000'];
const colorsGreen = ['#006400', '#90ee90', '#cdc134', '#ffa500', '#ff0000'];
const categories = ['<600ppm', '600-799ppm', '800-999ppm', '1000-1199ppm', '>=1200ppm'];

let colorBoxes = [];

export function createLegend(initialColorScheme = 'BlueYellowRed') {
    const legendContent = document.getElementById('legend-content');
    const toggleButton = document.getElementById('legend-toggle');

    // Build legend items
    const colors = initialColorScheme === 'GreenYellowRed' ? colorsGreen : colorsBlue;

    for (let i = 0; i < categories.length; i++) {
        const legendItem = document.createElement('div');
        legendItem.className = 'legend-item';

        const colorBox = document.createElement('span');
        colorBox.style.backgroundColor = colors[i];
        colorBox.style.width = '25px';
        colorBox.style.height = '8px';
        colorBox.style.borderRadius = '3px';
        colorBox.style.display = 'inline-block';
        colorBox.style.marginRight = '5px';

        colorBoxes.push(colorBox); // Save reference for later updates

        const label = document.createElement('span');
        label.textContent = categories[i];

        legendItem.appendChild(colorBox);
        legendItem.appendChild(label);
        legendContent.appendChild(legendItem);
    }

    // Handle toggle
    toggleButton.addEventListener('click', () => {
        const isVisible = legendContent.style.display !== 'none';
        legendContent.style.display = isVisible ? 'none' : 'block';
        toggleButton.textContent = `${isVisible ? 'Legend ▶' : '▼'}`;
    });

    // Default to visible
    legendContent.style.display = 'block';
}

export function updateLegendColors(colorScheme) {
    const colors = colorScheme === 'GreenYellowRed' ? colorsGreen : colorsBlue;
    for (let i = 0; i < colorBoxes.length; i++) {
        colorBoxes[i].style.backgroundColor = colors[i];
    }
}
