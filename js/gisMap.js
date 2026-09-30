let maps = new Map();

export function initGisMap(elementId, options, dotNetHelper) {
    if (!window.L) return false;
    const element = document.getElementById(elementId);
    if (!element) return false;
    if (maps.has(elementId)) maps.get(elementId).map.remove();
    const center = options.center || [-15.418, 28.285];
    const map = L.map(elementId, { zoomControl: true, doubleClickZoom: false }).setView(center, options.zoom || 14);
    const tile = L.tileLayer(options.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: options.attribution || '&copy; OpenStreetMap contributors' }).addTo(map);
    const boundaryLayer = L.layerGroup().addTo(map);
    const zoneLayer = L.layerGroup().addTo(map);
    const pointLayer = L.layerGroup().addTo(map);
    const state = { map, tile, boundaryLayer, zoneLayer, pointLayer, drawing: false, vertices: [], drawingLayer: null, dotNetHelper };
    maps.set(elementId, state);
    map.on('click', event => {
        if (!state.drawing) return;
        state.vertices.push({ latitude: event.latlng.lat, longitude: event.latlng.lng });
        redrawDrawing(state);
        dotNetHelper?.invokeMethodAsync('OnZoneCoordinate', state.vertices[state.vertices.length - 1]);
    });
    map.on('dblclick', event => { if (state.drawing) { L.DomEvent.stop(event); finishDrawing(elementId); } });
    return true;
}

export function renderGisLayers(elementId, payload) {
    const state = maps.get(elementId); if (!state) return;
    state.boundaryLayer.clearLayers(); state.zoneLayer.clearLayers(); state.pointLayer.clearLayers();
    if (payload.boundary?.length) {
        const points = payload.boundary.map(p => [p.latitude, p.longitude]);
        const polygon = L.polygon(points, { color: '#16a34a', weight: 3, fillColor: '#22c55e', fillOpacity: .12 });
        polygon.bindTooltip(payload.title || 'Field boundary'); polygon.addTo(state.boundaryLayer);
        state.map.fitBounds(polygon.getBounds(), { padding: [20, 20] });
    }
    (payload.zones || []).forEach(zone => {
        if (!zone.coordinates?.length) return;
        L.polygon(zone.coordinates.map(p => [p.latitude, p.longitude]), { color: '#7c3aed', weight: 2, fillColor: '#8b5cf6', fillOpacity: .25 }).bindTooltip(zone.name).addTo(state.zoneLayer);
    });
    (payload.points || []).forEach(point => {
        const color = point.severity === 'High' ? '#dc2626' : point.severity === 'Moderate' ? '#d97706' : '#0284c7';
        const marker = L.circleMarker([point.latitude, point.longitude], { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: .95 });
        marker.bindPopup(point.label || 'Scouting observation').addTo(state.pointLayer);
    });
}

export function setGisLayerVisibility(elementId, layerName, visible) {
    const state = maps.get(elementId); if (!state) return;
    const layer = layerName === 'boundaries' ? state.boundaryLayer : layerName === 'zones' ? state.zoneLayer : state.pointLayer;
    if (visible) state.map.addLayer(layer); else state.map.removeLayer(layer);
}

export function startZoneDrawing(elementId) {
    const state = maps.get(elementId); if (!state) return;
    state.drawing = true; state.vertices = []; if (state.drawingLayer) state.map.removeLayer(state.drawingLayer);
}

export function finishZoneDrawing(elementId) {
    const state = maps.get(elementId); if (!state || state.vertices.length < 3) return false;
    state.drawing = false; redrawDrawing(state); return true;
}

export function clearZoneDrawing(elementId) {
    const state = maps.get(elementId); if (!state) return;
    state.drawing = false; state.vertices = []; if (state.drawingLayer) { state.map.removeLayer(state.drawingLayer); state.drawingLayer = null; }
}

export function startZoneEditing(elementId, zone) {
    const state = maps.get(elementId); if (!state || !zone?.coordinates?.length) return false;
    clearZoneEditing(elementId);
    state.editingZone = zone;
    state.editingMarkers = zone.coordinates.map((point, index) => {
        const marker = L.marker([point.latitude, point.longitude], { draggable: true, title: `Vertex ${index + 1}` }).addTo(state.map);
        marker.on('drag', () => redrawEditingPolygon(state));
        marker.on('dragend', event => {
            const position = event.target.getLatLng();
            state.dotNetHelper?.invokeMethodAsync('OnZoneCoordinateMoved', index, { latitude: position.lat, longitude: position.lng });
        });
        return marker;
    });
    redrawEditingPolygon(state);
    return true;
}

export function clearZoneEditing(elementId) {
    const state = maps.get(elementId); if (!state) return;
    (state.editingMarkers || []).forEach(marker => state.map.removeLayer(marker));
    state.editingMarkers = [];
    if (state.editingPolygon) { state.map.removeLayer(state.editingPolygon); state.editingPolygon = null; }
    state.editingZone = null;
}

function redrawEditingPolygon(state) {
    if (state.editingPolygon) state.map.removeLayer(state.editingPolygon);
    const points = (state.editingMarkers || []).map(marker => { const p = marker.getLatLng(); return [p.lat, p.lng]; });
    if (points.length >= 3) state.editingPolygon = L.polygon(points, { color: '#7c3aed', weight: 3, dashArray: '8 5', fillColor: '#8b5cf6', fillOpacity: .25 }).addTo(state.map);
}

function redrawDrawing(state) {
    if (state.drawingLayer) state.map.removeLayer(state.drawingLayer);
    if (state.vertices.length < 1) return;
    const points = state.vertices.map(p => [p.latitude, p.longitude]);
    state.drawingLayer = L.polygon(points, { color: '#f59e0b', weight: 3, dashArray: '6 5', fillColor: '#fbbf24', fillOpacity: .2 }).addTo(state.map);
}

export function disposeGisMap(elementId) {
    const state = maps.get(elementId); if (!state) return;
    state.map.remove(); maps.delete(elementId);
}
