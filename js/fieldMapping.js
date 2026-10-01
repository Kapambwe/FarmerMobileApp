// Field & Farm Boundary Mapping JavaScript ES Module
let watchId = null;
let simulationTimer = null;
let bufferedTrackingTimer = null;
let bufferedTrackingPoints = [];
let bufferedTrackingHelper = null;

function flushBufferedTracking() {
    if (!bufferedTrackingHelper || bufferedTrackingPoints.length === 0) return;
    const points = bufferedTrackingPoints;
    bufferedTrackingPoints = [];
    const callback = bufferedTrackingHelper.invokeMethodAsync('OnLocationBatchUpdated', points);
    if (callback && typeof callback.catch === 'function') callback.catch(() => { });
}

export function startBufferedTracking(dotNetHelper, batchSize = 5, flushIntervalMilliseconds = 2000) {
    stopTracking();
    bufferedTrackingHelper = dotNetHelper;
    bufferedTrackingPoints = [];
    const safeBatchSize = Math.max(1, batchSize || 5);
    const safeInterval = Math.max(250, flushIntervalMilliseconds || 2000);

    if (!navigator.geolocation) {
        dotNetHelper.invokeMethodAsync('OnLocationError', 'Geolocation is not supported by your device or browser.');
        return false;
    }

    bufferedTrackingTimer = setInterval(() => flushBufferedTracking(), safeInterval);
    watchId = navigator.geolocation.watchPosition(
        position => {
            bufferedTrackingPoints.push({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy || null,
                altitude: position.coords.altitude || null,
                timestamp: new Date(position.timestamp).toISOString()
            });
            if (bufferedTrackingPoints.length >= safeBatchSize) flushBufferedTracking();
        },
        error => {
            flushBufferedTracking();
            dotNetHelper.invokeMethodAsync('OnLocationError', error.message || 'GPS acquisition failed.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
    return true;
}

export function startTracking(dotNetHelper) {
    if (!navigator.geolocation) {
        dotNetHelper.invokeMethodAsync('OnLocationError', 'Geolocation is not supported by your device or browser.');
        return false;
    }

    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }

    const options = {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
    };

    watchId = navigator.geolocation.watchPosition(
        function (position) {
            dotNetHelper.invokeMethodAsync('OnLocationUpdated', {
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracy: position.coords.accuracy || 5.0,
                altitude: position.coords.altitude || null,
                timestamp: new Date(position.timestamp).toISOString()
            });
        },
        function (error) {
            let msg = "GPS Signal error.";
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    msg = "GPS permission denied by user.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    msg = "Position unavailable. Ensure GPS is enabled.";
                    break;
                case error.TIMEOUT:
                    msg = "GPS acquisition timed out.";
                    break;
            }
            dotNetHelper.invokeMethodAsync('OnLocationError', msg);
        },
        options
    );

    return true;
}

export function stopTracking() {
    flushBufferedTracking();
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (simulationTimer !== null) {
        clearInterval(simulationTimer);
        simulationTimer = null;
    }
    if (bufferedTrackingTimer !== null) {
        clearInterval(bufferedTrackingTimer);
        bufferedTrackingTimer = null;
    }
    bufferedTrackingHelper = null;
    return true;
}

export function simulateWalkAroundField(dotNetHelper, centerLat, centerLng, radiusMeters, pointsCount) {
    stopTracking();
    centerLat = centerLat || -15.4167; // Default near Lusaka/Chongwe farm block if zero
    centerLng = centerLng || 28.2833;
    radiusMeters = radiusMeters || 120; // ~4.5 hectares
    pointsCount = pointsCount || 12;

    const earthRadius = 6378137;
    let currentStep = 0;

    // Generate polygon points around center with subtle realistic variation
    const angles = [];
    for (let i = 0; i < pointsCount; i++) {
        angles.push((i * (2 * Math.PI / pointsCount)) + (Math.random() * 0.1 - 0.05));
    }

    simulationTimer = setInterval(() => {
        if (currentStep >= pointsCount) {
            clearInterval(simulationTimer);
            simulationTimer = null;
            dotNetHelper.invokeMethodAsync('OnSimulationComplete');
            return;
        }

        const angle = angles[currentStep];
        const dist = radiusMeters * (0.9 + Math.random() * 0.2); // slight irregularity
        const dLat = (dist * Math.cos(angle)) / earthRadius * (180 / Math.PI);
        const dLng = (dist * Math.sin(angle)) / (earthRadius * Math.cos(centerLat * Math.PI / 180)) * (180 / Math.PI);

        const lat = centerLat + dLat;
        const lng = centerLng + dLng;
        const accuracy = 2.5 + Math.random() * 1.5;

        dotNetHelper.invokeMethodAsync('OnLocationUpdated', {
            latitude: lat,
            longitude: lng,
            accuracy: accuracy,
            altitude: 1250 + Math.random() * 3,
            timestamp: new Date().toISOString()
        });

        currentStep++;
    }, 1200);
}

export function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export function calculatePolygonMetrics(coordinatesJson) {
    const coords = typeof coordinatesJson === 'string' ? JSON.parse(coordinatesJson) : coordinatesJson;
    if (!coords || coords.length < 3) {
        return { hectares: 0, acres: 0, sqMeters: 0, perimeterMeters: 0, centerLat: 0, centerLng: 0 };
    }

    let totalPerimeter = 0;
    let sumLat = 0;
    let sumLng = 0;

    for (let i = 0; i < coords.length; i++) {
        sumLat += coords[i].latitude;
        sumLng += coords[i].longitude;
        const nextIdx = (i + 1) % coords.length;
        totalPerimeter += calculateDistanceMeters(
            coords[i].latitude, coords[i].longitude,
            coords[nextIdx].latitude, coords[nextIdx].longitude
        );
    }

    const centerLat = sumLat / coords.length;
    const centerLng = sumLng / coords.length;

    // Spherical Gauss Area calculation in m²
    const R = 6378137;
    let areaSqMeters = 0;

    if (coords.length > 2) {
        let areaSum = 0;
        for (let i = 0; i < coords.length; i++) {
            const p1 = coords[i];
            const p2 = coords[(i + 1) % coords.length];
            const radLat1 = p1.latitude * Math.PI / 180;
            const radLat2 = p2.latitude * Math.PI / 180;
            const radLng1 = p1.longitude * Math.PI / 180;
            const radLng2 = p2.longitude * Math.PI / 180;
            areaSum += (radLng2 - radLng1) * (2 + Math.sin(radLat1) + Math.sin(radLat2));
        }
        areaSqMeters = Math.abs(areaSum * R * R / 4.0);
    }

    const hectares = areaSqMeters / 10000;
    const acres = hectares * 2.47105;

    return {
        sqMeters: Math.round(areaSqMeters * 10) / 10,
        hectares: Math.round(hectares * 100) / 100,
        acres: Math.round(acres * 100) / 100,
        perimeterMeters: Math.round(totalPerimeter * 10) / 10,
        centerLat: centerLat,
        centerLng: centerLng
    };
}

// Performs the complete geometry analysis in one interop call. Keeping the
// coordinate traversal and metric calculation in JavaScript avoids a separate
// serialization/parsing step for each derived value.
export function analyzeBoundary(coordinates) {
    return calculatePolygonMetrics(coordinates);
}

export function renderPreviewCanvas(canvasId, coordinatesJson, titleName) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const coords = typeof coordinatesJson === 'string' ? JSON.parse(coordinatesJson) : coordinatesJson;

    const width = canvas.width = canvas.parentElement.clientWidth || 600;
    const height = canvas.height = canvas.parentElement.clientHeight || 360;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }

    if (!coords || coords.length === 0) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '500 14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Walk around boundary to record GPS coordinates...', width / 2, height / 2);
        return;
    }

    // Compute Bounding Box
    let minLat = coords[0].latitude, maxLat = coords[0].latitude;
    let minLng = coords[0].longitude, maxLng = coords[0].longitude;

    for (let i = 1; i < coords.length; i++) {
        if (coords[i].latitude < minLat) minLat = coords[i].latitude;
        if (coords[i].latitude > maxLat) maxLat = coords[i].latitude;
        if (coords[i].longitude < minLng) minLng = coords[i].longitude;
        if (coords[i].longitude > maxLng) maxLng = coords[i].longitude;
    }

    const padding = 50;
    const latRange = (maxLat - minLat) || 0.0001;
    const lngRange = (maxLng - minLng) || 0.0001;

    function toPixel(lat, lng) {
        const x = padding + ((lng - minLng) / lngRange) * (width - 2 * padding);
        const y = height - (padding + ((lat - minLat) / latRange) * (height - 2 * padding));
        return { x, y };
    }

    // Draw Polygon Path
    if (coords.length > 1) {
        ctx.beginPath();
        const startP = toPixel(coords[0].latitude, coords[0].longitude);
        ctx.moveTo(startP.x, startP.y);

        for (let i = 1; i < coords.length; i++) {
            const p = toPixel(coords[i].latitude, coords[i].longitude);
            ctx.lineTo(p.x, p.y);
        }

        if (coords.length >= 3) {
            ctx.closePath();
            ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
            ctx.fill();
        }

        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 3;
        ctx.setLineDash([]);
        ctx.stroke();
    }

    // Draw Vertex Markers & Numbers
    coords.forEach((c, idx) => {
        const p = toPixel(c.latitude, c.longitude);
        ctx.beginPath();
        ctx.arc(p.x, p.y, idx === 0 ? 8 : 5, 0, 2 * Math.PI);
        ctx.fillStyle = idx === 0 ? '#10b981' : (idx === coords.length - 1 ? '#ef4444' : '#38bdf8');
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(idx + 1, p.x, p.y - 8);
    });

    // Overlay Title & Compass
    ctx.fillStyle = '#f8fafc';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(titleName || 'Field Boundary Preview', 16, 26);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('▲ N', width - 16, 26);
}

export function renderPrecisionMap(canvasId, mapJson) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const map = typeof mapJson === 'string' ? JSON.parse(mapJson) : mapJson;
    const boundary = map.boundary || [];
    const heatmap = map.heatmapValues || [];
    const points = map.points || [];
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.parentElement.clientWidth || 720;
    const height = canvas.height = canvas.parentElement.clientHeight || 420;
    ctx.fillStyle = '#0b1220'; ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(148,163,184,.12)'; ctx.lineWidth = 1;
    for (let x = 0; x < width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
    for (let y = 0; y < height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    if (!boundary.length) { ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'center'; ctx.font = '14px system-ui'; ctx.fillText('No mapped boundary is available for this field.', width / 2, height / 2); return; }
    let minLat = boundary[0].latitude, maxLat = minLat, minLng = boundary[0].longitude, maxLng = minLng;
    boundary.forEach(p => { minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude); minLng = Math.min(minLng, p.longitude); maxLng = Math.max(maxLng, p.longitude); });
    const pad = 48, latRange = (maxLat - minLat) || .0001, lngRange = (maxLng - minLng) || .0001;
    const toPixel = (lat, lng) => ({ x: pad + (lng - minLng) / lngRange * (width - 2 * pad), y: height - (pad + (lat - minLat) / latRange * (height - 2 * pad)) });
    const values = heatmap.length ? heatmap : [0.5];
    const rows = Math.max(1, Math.round(Math.sqrt(values.length))), cols = Math.max(1, Math.ceil(values.length / rows));
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const v = values[r * cols + c]; if (v === undefined) continue;
        const t = Math.max(0, Math.min(1, (v + 1) / 2));
        const red = Math.round(220 * (1 - t) + 34 * t), green = Math.round(70 * (1 - t) + 197 * t), blue = Math.round(60 * (1 - t) + 94 * t);
        const x = pad + c / cols * (width - 2 * pad), y = pad + r / rows * (height - 2 * pad);
        ctx.fillStyle = `rgba(${red},${green},${blue},.28)`; ctx.fillRect(x, y, (width - 2 * pad) / cols + 1, (height - 2 * pad) / rows + 1);
    }
    ctx.beginPath(); const first = toPixel(boundary[0].latitude, boundary[0].longitude); ctx.moveTo(first.x, first.y);
    boundary.slice(1).forEach(p => { const q = toPixel(p.latitude, p.longitude); ctx.lineTo(q.x, q.y); }); ctx.closePath();
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 3; ctx.stroke();
    points.forEach(point => { const p = toPixel(point.latitude, point.longitude); ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fillStyle = point.severity === 'High' ? '#ef4444' : point.severity === 'Moderate' ? '#f59e0b' : '#38bdf8'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); });
    ctx.fillStyle = '#f8fafc'; ctx.font = '600 13px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`${map.title || 'Precision field map'} · ${map.indexType || 'Index'}`, 16, 24);
    ctx.font = '12px system-ui'; ctx.textAlign = 'right'; ctx.fillStyle = '#cbd5e1'; ctx.fillText('Low stress', width - 100, height - 18); ctx.fillStyle = '#22c55e'; ctx.fillRect(width - 92, height - 27, 76, 8); ctx.fillStyle = '#cbd5e1'; ctx.fillText('High vigor', width - 16, height - 18);
}

export function exportBoundaryGeoJson(boundaryName, boundaryType, hectares, coordinatesJson) {
    const coords = typeof coordinatesJson === 'string' ? JSON.parse(coordinatesJson) : coordinatesJson;
    const geoJsonCoordinates = coords.map(c => [c.longitude, c.latitude]);
    if (geoJsonCoordinates.length > 0) {
        geoJsonCoordinates.push([coords[0].longitude, coords[0].latitude]);
    }

    const geoJson = {
        type: "FeatureCollection",
        features: [{
            type: "Feature",
            properties: {
                name: boundaryName || "Farm Boundary",
                type: boundaryType || "Crop Field",
                hectares: hectares || 0,
                mappedDate: new Date().toISOString()
            },
            geometry: {
                type: "Polygon",
                coordinates: [geoJsonCoordinates]
            }
        }]
    };

    downloadFile(`${(boundaryName || 'boundary').toLowerCase().replace(/\s+/g, '_')}.geojson`, 'application/json', JSON.stringify(geoJson, null, 2));
}

export function exportBoundaryKml(boundaryName, boundaryType, coordinatesJson) {
    const coords = typeof coordinatesJson === 'string' ? JSON.parse(coordinatesJson) : coordinatesJson;
    let kmlCoords = coords.map(c => `${c.longitude},${c.latitude},${c.altitude || 0}`).join(' ');
    if (coords.length > 0) {
        kmlCoords += ` ${coords[0].longitude},${coords[0].latitude},${coords[0].altitude || 0}`;
    }

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${boundaryName || 'Farm Boundary'}</name>
    <Placemark>
      <name>${boundaryName || 'Farm Boundary'}</name>
      <description>Type: ${boundaryType || 'Farm Land'}</description>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${kmlCoords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>`;

    downloadFile(`${(boundaryName || 'boundary').toLowerCase().replace(/\s+/g, '_')}.kml`, 'application/vnd.google-earth.kml+xml', kml);
}

export function exportBoundaryCsv(boundaryName, coordinatesJson) {
    const coords = typeof coordinatesJson === 'string' ? JSON.parse(coordinatesJson) : coordinatesJson;
    let csv = "PointIndex,Latitude,Longitude,AccuracyMeters,AltitudeMeters,Timestamp\n";
    coords.forEach((c, idx) => {
        csv += `${idx + 1},${c.latitude},${c.longitude},${c.accuracy || ''},${c.altitude || ''},${c.timestamp || ''}\n`;
    });

    downloadFile(`${(boundaryName || 'boundary').toLowerCase().replace(/\s+/g, '_')}_coordinates.csv`, 'text/csv', csv);
}

function downloadFile(filename, mimeType, textContent) {
    const blob = new Blob([textContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Global namespace fallback
window.fieldMapper = {
    startTracking,
    stopTracking,
    simulateWalkAroundField,
    calculateDistanceMeters,
    calculatePolygonMetrics,
    renderPreviewCanvas,
    exportBoundaryGeoJson,
    exportBoundaryKml,
    exportBoundaryCsv
};
