// Unique predefined colors array (for boxplot, can customize as needed)
const predefinedColors = [
    "#FF6384", "#36A2EB", "#FFCE56", "#4BC0C0", "#9966FF", "#FF9F40",
    "#FF5733", "#C70039", "#FFC300", "#DAF7A6", "#581845", "#900C3F",
    "#FFB6C1", "#D3D3D3", "#87CEFA", "#4682B4", "#32CD32", "#FFD700",
    "#FF4500", "#6A5ACD", "#7FFF00", "#FF6347", "#8A2BE2", "#ADFF2F",
    "#B22222", "#FF69B4", "#2E8B57", "#20B2AA", "#FF8C00", "#FF1493",
    "#40E0D0", "#FF7F50", "#FA8072", "#FF00FF", "#778899", "#D2691E",
    "#B8860B", "#8B008B", "#FFA07A", "#C0C0C0", "#F0E68C", "#00BFFF",
    "#1E90FF", "#FF1493", "#DB7093", "#F08080", "#7B68EE", "#6495ED",
    "#00FA9A", "#8FBC8F", "#3CB371", "#4682B4", "#DDA0DD"
];

// Fetch the JSON data from the provided URL
fetch('https://www.indoorco2map.com/chartdata/IndoorCO2MapData.json')
    .then(response => response.json())
    .then(data => {
        // Filter for locations in Germany
        const locations = data;

        // Group by unique locations and average CO2 readings
        const locationGroups = locations.reduce((acc, item) => {
            const compoundId = `${item.nwrType}-${item.nwrID}`;
            if (!acc[compoundId]) {
                acc[compoundId] = { osmTag: item.osmTag, co2readingsAvg: [] };
            }
            acc[compoundId].co2readingsAvg.push(item.co2readingsAvg);
            return acc;
        }, {});

        // Calculate averages and group by osmTag
        const averagedData = Object.values(locationGroups).map(location => {
            const avgCO2 = location.co2readingsAvg.reduce((sum, value) => sum + value, 0) / location.co2readingsAvg.length;
            return { osmTag: location.osmTag, avgCO2 };
        });

        // Group by osmTag and count unique entries
        const osmTagData = averagedData.reduce((acc, item) => {
            if (!acc[item.osmTag]) acc[item.osmTag] = { co2readings: [], count: 0 };
            acc[item.osmTag].co2readings.push(item.avgCO2);
            acc[item.osmTag].count++;
            return acc;
        }, {});

        // Filter to include only categories with at least 20 entries
        const filteredOsmTagData = Object.entries(osmTagData)
            .filter(([, { count }]) => count >= 20)
            .map(([osmTag, { co2readings }]) => ({
                osmTag,
                co2readings,
                count: co2readings.length
            }))
            .sort((a, b) => getMedian(a.co2readings) - getMedian(b.co2readings));

        const labels = filteredOsmTagData.map(({ osmTag, count }) => `${osmTag} (n=${count})`);
        const dataSet = filteredOsmTagData.map(({ co2readings }) => ({
            min: Math.min(...co2readings),
            q1: percentile(co2readings, 25),
            median: getMedian(co2readings),
            q3: percentile(co2readings, 75),
            max: Math.max(...co2readings),
            outliers: getOutliers(co2readings)
        }));

        // Create the boxplot with the averaged CO2 values
        const ctxBoxplot = document.getElementById('osmTagBoxplotChart').getContext('2d');
        new Chart(ctxBoxplot, {
            type: 'boxplot',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Average CO₂ Levels by Location Type (OSM Tag)',
                    data: dataSet,
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    outlierColor: 'rgba(255,0,0,1)'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false, // Allows for custom height adjustment
                scales: {
                    y: {
                        min: 400, // Start the y-axis at 400 ppm
                        title: {
                            display: true,
                            text: 'CO₂ ppm'
                        }
                    }
                }
            }
        });
    })
    .catch(error => console.error('Error fetching the JSON data:', error));

// Helper function to calculate percentiles
function percentile(arr, p) {
    if (!arr || arr.length === 0) return 0; // Return 0 if the array is empty
    const sorted = arr.slice().sort((a, b) => a - b);
    const index = Math.floor((p / 100) * sorted.length);
    return sorted[index];
}

// Helper function to find outliers (using 1.5 IQR rule)
function getOutliers(arr) {
    if (!arr || arr.length === 0) return []; // Return empty array if the array is empty
    const q1 = percentile(arr, 25);
    const q3 = percentile(arr, 75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    return arr.filter(value => value < lowerBound || value > upperBound);
}

// Function to get the median CO2 value
function getMedian(arr) {
    if (!arr || arr.length === 0) return 0; // Return 0 if the array is empty
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
