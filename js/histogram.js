let histogramChart = null;

// Function to render the histogram chart
export function renderHistogram(filteredData) {
  if (!filteredData || typeof filteredData !== 'object') return;

  // 1. Calculate one average CO₂ value per location
  const allValues = [];
  for (const entry of Object.values(filteredData)) {
    const measurements = entry.measurements || [];
    let total = 0;
    let count = 0;

    for (const m of measurements) {
      const values = m.co2array?.split(';').map(Number).filter(n => !isNaN(n)) || [];
      total += values.reduce((sum, v) => sum + v, 0);
      count += values.length;
    }

    if (count > 0) {
      const avg = total / count;
      allValues.push(avg);
    }
  }

  // 2. Define buckets (CO₂ ranges)
  const buckets = [
    { label: '<600', min: -Infinity, max: 600 },
    { label: '600–800', min: 600, max: 800 },
    { label: '800–1000', min: 800, max: 1000 },
    { label: '1000–1200', min: 1000, max: 1200 },
    { label: '1200–1400', min: 1200, max: 1400 },
    { label: '>1400', min: 1400, max: Infinity }
  ];

  const frequencies = buckets.map(b =>
    allValues.filter(val => val > b.min && val <= b.max).length
  );

  const total = allValues.length;
  const percentages = frequencies.map(f => total > 0 ? (f / total * 100).toFixed(1) : 0);

  // 3. Get the canvas and adjust its size to fit the container
  const canvas = document.getElementById('histogramCanvas');
  const ctx = canvas.getContext('2d');

  // Get the parent container's size after it has been rendered
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;

  // Destroy previous chart to avoid memory leaks
  if (histogramChart) {
    histogramChart.destroy();
  }

  // 4. Create or update the chart
  histogramChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'Location %',
        data: percentages,
        backgroundColor: '#b2b2b2',
        datalabels: {
          anchor: 'end',
          align: 'start',
          formatter: (value, context) => {
            const count = frequencies[context.dataIndex];
            return `${count}`;
          },
          font: {
            weight: 'bold'
          }
        }
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        datalabels: {
          color: '#000'
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const count = frequencies[ctx.dataIndex];
              return `${count} locations (${ctx.formattedValue}%)`;
            }
          }
        },
        title: {
          display: true,
          text: 'CO2 Distribution of filtered Locations in ppm', // Title for the histogram
          font: {
            size: 18, // Adjust the title font size
            weight: 'bold' // Optionally make the title bold
          },
          padding: {
            bottom: 20 // Add some padding below the title for spacing
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: '% of locations'
          },
          max: 100
        },
        x: {
          title: {
            display: true,
            text: 'CO₂ Range (ppm)' // X-axis label
          }
        }
      }
    },
    plugins: [ChartDataLabels]
  });
}
