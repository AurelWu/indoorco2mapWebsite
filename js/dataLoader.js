export class CO2DataManager {
    constructor() {
        this.rawData = [];
        this.processedData = {};
        this.filteredData = {};
        this.averagesByLocation = {};
    }

    async loadData(url) {
        this.rawData = await fetchCO2Data(url);
        this.processedData = this.processRawData(this.rawData);
        this.filteredData = this.processedData;
        this.calculateAverages();
    }


co2ToScore(ppm) {
  if (typeof ppm !== "number" || isNaN(ppm)) return null;

  if (ppm <= 537) return 10;
  if (ppm <= 712) return 9;
  if (ppm <= 800) return 8;
  if (ppm <= 900) return 7;
  if (ppm <= 1100) return 6;
  if (ppm <= 1300) return 5;
  if (ppm <= 1400) return 4;
  if (ppm <= 2000) return 3;
  if (ppm <= 3200) return 2;
  if (ppm <= 4400) return 1;
  return 0; // > 4400
}


processRawData(data) {
  const locations = {};

  data.forEach(item => {
    let measurements = JSON.parse(item.measurements);
    let locationId = item.combined_id;

    // If the location doesn't exist, initialize it with location-specific data
    if (!locations[locationId]) {
      locations[locationId] = {
        countryid: item.countryid,
        countryname: item.countryname,
        osmkey: item.osmkey,
        osmtag: item.osmtag,
        nuts3id: item.nuts3id,
        measurements: [] // Initialize the measurements array
      };
    }

    // Add the measurements to the corresponding location
    measurements.forEach(locationData => {
      locations[locationId].measurements.push(locationData);
    });
  });

  return locations;
}

calculateAverages(data = this.filteredData) {
    this.averagesByLocation = {};

    for (const [locationId, locationData] of Object.entries(data)) {
        const measurements = locationData.measurements;
        
        // Filter out measurements that have a valid ppmavg
        const validMeasurements = measurements.filter(m => typeof m.ppmavg === 'number' && !isNaN(m.ppmavg));
        
        // If there are no valid measurements, assign null to the average for this location
        if (validMeasurements.length === 0) {
            this.averagesByLocation[locationId] = null;
            continue;
        }

        // Calculate the average ppmavg
        const total = validMeasurements.reduce((sum, m) => sum + m.ppmavg, 0);
        const average = total / validMeasurements.length;

        // Store the average in averagesByLocation
        this.averagesByLocation[locationId] = average;
    }
}

filterByName(nameFilter, inputData = this.filteredData) {
    const lower = nameFilter.trim().toLowerCase();
    const filtered = {};

    for (const [locationId, locationData] of Object.entries(inputData)) {
        const measurements = locationData.measurements;
        
        if (!measurements.length) continue;
        
        // Accessing 'nwrname' from the first measurement
        const name = measurements[0].nwrname?.toLowerCase() || '';
        
        if (name.includes(lower)) {
            filtered[locationId] = locationData; // Save the entire location data, not just measurements
        }
    }

    this.filteredData = filtered;
    this.calculateAverages();
    return filtered;
}

filterByCountry(countryFilter, inputData = this.filteredData) {
  const selected = countryFilter.trim().toLowerCase();
  if (!selected) return inputData; // If "All Countries" is selected, return unfiltered

  const filtered = {};

  for (const [locationId, locationData] of Object.entries(inputData)) {
    const country = locationData.countryname?.toLowerCase() || '';

    if (country === selected) {
      filtered[locationId] = locationData;
    }
  }

  this.filteredData = filtered;
  this.calculateAverages();
  return filtered;
}

filterByLocationType(typeFilter, inputData = this.filteredData) {
  const selected = typeFilter.trim().toLowerCase();
  if (!selected) return inputData; // No filter, return everything

  const filtered = {};

  for (const [locationId, locationData] of Object.entries(inputData)) {
    const type = (locationData.osmkey || '') + '_' + (locationData.osmtag || '');
    if (type === selected) {
      filtered[locationId] = locationData;
    }
  }

  this.filteredData = filtered;
  this.calculateAverages();
  return filtered;
}

filterByDate(minDate, maxDate, inputData = this.filteredData) {
    const filtered = {};

    // Adjust maxDate to include the whole day
    const inclusiveMaxDate = new Date(maxDate);
    inclusiveMaxDate.setHours(23, 59, 59, 999);

    for (const [locationId, locationData] of Object.entries(inputData)) {
        const measurements = locationData.measurements;
        
        const filteredMeasurements = measurements.filter(m => {
            const startTime = new Date(m.startTime);
            return startTime >= minDate && startTime <= inclusiveMaxDate;
        });

        if (filteredMeasurements.length > 0) {
            filtered[locationId] = {
                ...locationData,   // Keep all the metadata
                measurements: filteredMeasurements // Only include filtered measurements
            };
        }
    }

    this.filteredData = filtered;
    this.calculateAverages();
    return filtered;
}

filterByCO2ScoreRange(minScore, maxScore, inputData = this.filteredData) {
  const minS = parseInt(minScore, 10);
  const maxS = parseInt(maxScore, 10);

  if (isNaN(minS) || isNaN(maxS)) return inputData;

  // Ensure averages reflect the current inputData
  // (because averagesByLocation might have been computed for a different filteredData)
  this.calculateAverages(inputData);

  const filtered = {};

  for (const [locationId, locationData] of Object.entries(inputData)) {
    const avg = this.averagesByLocation[locationId];
    if (typeof avg !== "number" || isNaN(avg)) continue;

    const score = this.co2ToScore(avg);
    if (score == null) continue;

    if (score >= minS && score <= maxS) {
      filtered[locationId] = locationData;
    }
  }

  this.filteredData = filtered;
  this.calculateAverages(); // keep manager state consistent
  return filtered;
}


    getFilteredData() {
        return this.filteredData;
    }

    getAllProcessedData() {
        return this.processedData;
    }

    getAverages() {
        return this.averagesByLocation;
    }
}

export async function fetchCO2Data(url) {
    const maxRetries = 3;
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.warn(`Fetch attempt ${attempts + 1} failed:`, error);
            attempts++;
            if (attempts >= maxRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}
