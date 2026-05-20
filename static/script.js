// =====================================================================================
// STATE
// =====================================================================================

let stops = [];          // { name, lat, lon }
let startPoint = null;   // { name, lat, lon }
let endPoint = null;     // { name, lat, lon }

let map;
let routeLine = null;
let markers = [];        // Leaflet marker refs, indexed to stops[]
let startMarker = null;
let endMarker = null;

// =====================================================================================
// INIT
// =====================================================================================

window.onload = function () {
    map = L.map('map').setView([39.9612, -82.9988], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
};

// =====================================================================================
// GEOCODING (server-side via /geocode endpoint)
// =====================================================================================

async function geocodePlace(name) {
    const res = await fetch('/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ place: name })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Location not found');
    }
    return res.json(); // { name, lat, lon }
}

// =====================================================================================
// SET START / END POINTS
// =====================================================================================

async function setEndpoint(type) {
    const input = document.getElementById(type);
    const value = input.value.trim();
    if (!value) { showToast('Enter an address first.', 'warn'); return; }

    setLoading(true, `Finding ${type} point…`);
    try {
        const place = await geocodePlace(value);
        if (type === 'start') {
            startPoint = place;
            if (startMarker) map.removeLayer(startMarker);
            startMarker = L.marker([place.lat, place.lon], {
                icon: colorIcon('green'),
                title: 'Start: ' + place.name
            }).addTo(map).bindPopup(`<b>Start:</b> ${place.name}`);
        } else {
            endPoint = place;
            if (endMarker) map.removeLayer(endMarker);
            endMarker = L.marker([place.lat, place.lon], {
                icon: colorIcon('red'),
                title: 'End: ' + place.name
            }).addTo(map).bindPopup(`<b>End:</b> ${place.name}`);
        }
        map.setView([place.lat, place.lon], 13);
        showToast(`${type.charAt(0).toUpperCase() + type.slice(1)} set: ${place.name}`, 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        setLoading(false);
    }
}

// =====================================================================================
// ADD STOP
// =====================================================================================

async function addStop() {
    const input = document.getElementById('newStop');
    const value = input.value.trim();
    if (!value) { showToast('Enter a stop name.', 'warn'); return; }

    setLoading(true, `Finding "${value}"…`);
    try {
        const place = await geocodePlace(value);

        stops.push(place);

        const markerRef = L.marker([place.lat, place.lon], {
            icon: stopIcon(stops.length),
            title: place.name
        }).addTo(map).bindPopup(`<b>Stop ${stops.length}:</b> ${place.name}`);

        markers.push(markerRef);
        map.setView([place.lat, place.lon], 13);
        input.value = '';
        renderStops();
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        setLoading(false);
    }
}

// =====================================================================================
// REMOVE / CLEAR STOPS
// =====================================================================================

function removeStop(index) {
    map.removeLayer(markers[index]);
    markers.splice(index, 1);
    stops.splice(index, 1);
    // Re-number remaining markers
    rebuildMarkers();
    renderStops();
}

function clearAll() {
    stops = [];
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    renderStops();
    document.getElementById('result').innerHTML = '';
}

function rebuildMarkers() {
    markers.forEach(m => map.removeLayer(m));
    markers = stops.map((stop, i) => {
        return L.marker([stop.lat, stop.lon], {
            icon: stopIcon(i + 1),
            title: stop.name
        }).addTo(map).bindPopup(`<b>Stop ${i + 1}:</b> ${stop.name}`);
    });
}

// =====================================================================================
// RENDER STOP LIST
// =====================================================================================

function renderStops() {
    const list = document.getElementById('stopList');
    const countEl = document.getElementById('stopCount');
    countEl.textContent = stops.length;

    if (stops.length === 0) {
        list.innerHTML = '<div class="empty-state">No stops added yet</div>';
        return;
    }

    list.innerHTML = stops.map((stop, i) => `
        <div class="stop-item" draggable="true" data-index="${i}"
             ondragstart="dragStart(event,${i})" ondragover="dragOver(event)"
             ondrop="dragDrop(event,${i})">
            <span class="stop-num">${i + 1}</span>
            <span class="stop-name">${stop.name}</span>
            <button class="remove-btn" onclick="removeStop(${i})" title="Remove">✕</button>
        </div>
    `).join('');
}

// =====================================================================================
// DRAG-TO-REORDER
// =====================================================================================

let dragSrcIndex = null;

function dragStart(e, index) {
    dragSrcIndex = index;
    e.dataTransfer.effectAllowed = 'move';
}

function dragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function dragDrop(e, index) {
    e.preventDefault();
    if (dragSrcIndex === null || dragSrcIndex === index) return;

    const moved = stops.splice(dragSrcIndex, 1)[0];
    stops.splice(index, 0, moved);
    dragSrcIndex = null;

    rebuildMarkers();
    renderStops();
}

// =====================================================================================
// OPTIMIZE ROUTE
// =====================================================================================

async function optimizeRoute() {
    const allStops = buildFullStopList();

    if (allStops.length < 2) {
        showToast('Add at least 2 stops to optimize.', 'warn');
        return;
    }

    setLoading(true, 'Optimizing route…');
    clearRoute();

    try {
        const res = await fetch('/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stops: allStops })
        });

        const data = await res.json();

        if (!res.ok || data.error) {
            showToast(data.error || 'Optimization failed.', 'error');
            return;
        }

        // Re-sync local stops (without start/end which stay fixed)
        const innerStops = data.optimized_stops.filter(s =>
            !(startPoint && s.name === startPoint.name) &&
            !(endPoint && s.name === endPoint.name)
        );
        stops = innerStops;
        rebuildMarkers();
        renderStops();

        // Draw polyline
        const latlngs = data.route_geometry.map(c => [c[1], c[0]]);
        routeLine = L.polyline(latlngs, { color: '#3b6fd4', weight: 5, opacity: 0.85 }).addTo(map);
        map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });

        renderResult(data);
    } catch (e) {
        showToast('Network error. Is Flask running?', 'error');
    } finally {
        setLoading(false);
    }
}

// =====================================================================================
// SAVE ROUTE
// =====================================================================================

async function saveRoute() {
    const allStops = buildFullStopList();
    if (allStops.length < 2) { showToast('Add stops before saving.', 'warn'); return; }

    const routeName = document.getElementById('routeName').value.trim() || 'My Route';
    setLoading(true, 'Saving route…');

    try {
        const res = await fetch('/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stops: allStops, route_name: routeName, save: true })
        });
        const data = await res.json();
        if (data.saved_id) {
            showToast(`Route saved! (ID #${data.saved_id})`, 'success');
        } else {
            showToast(data.error || 'Save failed.', 'error');
        }
    } catch (e) {
        showToast('Could not save route.', 'error');
    } finally {
        setLoading(false);
    }
}

// =====================================================================================
// SHOW SAVED ROUTES
// =====================================================================================

async function showSavedRoutes() {
    setLoading(true, 'Loading saved routes…');
    try {
        const res = await fetch('/routes');
        const data = await res.json();

        if (!data.length) {
            document.getElementById('result').innerHTML = '<p class="empty-state">No saved routes yet.</p>';
            return;
        }

        let html = '<div class="result-title">Saved Routes</div>';
        data.forEach(route => {
            html += `
                <div class="saved-route">
                    <div class="saved-route-header">
                        <b>${route.name}</b> <span class="badge">#${route.id}</span>
                        <button class="text-btn danger small" onclick="deleteRoute(${route.id})">Delete</button>
                    </div>
                    <ol class="saved-stops">
                        ${route.stops.map(s => `<li>${s.name}</li>`).join('')}
                    </ol>
                    <button class="text-btn" onclick="loadRoute(${JSON.stringify(route.stops).replace(/"/g, '&quot;')})">Load on map</button>
                </div>
            `;
        });

        document.getElementById('result').innerHTML = html;
    } catch (e) {
        showToast('Could not load routes.', 'error');
    } finally {
        setLoading(false);
    }
}

async function deleteRoute(id) {
    if (!confirm('Delete this route?')) return;
    await fetch(`/routes/${id}`, { method: 'DELETE' });
    showSavedRoutes();
}

function loadRoute(stopsArr) {
    clearAll();
    stopsArr.forEach(async (s) => {
        document.getElementById('newStop').value = s.name;
        await addStop();
    });
}

// =====================================================================================
// RENDER RESULT PANEL
// =====================================================================================

function renderResult(data) {
    let html = `
        <div class="result-title">Optimized Route</div>
        <div class="stats-row">
            <div class="stat"><span class="stat-val">${data.distance_label}</span><span class="stat-lbl">Distance</span></div>
            <div class="stat"><span class="stat-val">${data.duration_label}</span><span class="stat-lbl">Est. Time</span></div>
            <div class="stat"><span class="stat-val">${data.optimized_stops.length}</span><span class="stat-lbl">Stops</span></div>
        </div>
    `;

    if (data.steps && data.steps.length) {
        html += '<div class="directions">';
        data.steps.forEach((leg, i) => {
            html += `
                <div class="leg">
                    <div class="leg-header">
                        <span class="leg-num">${i + 1}</span>
                        <span class="leg-route">${leg.from} → ${leg.to}</span>
                        <span class="leg-meta">${leg.leg_distance} · ${leg.leg_duration}</span>
                    </div>
                    <ul class="leg-steps">
                        ${leg.instructions.map(s => `<li>${s}</li>`).join('')}
                    </ul>
                </div>
            `;
        });
        html += '</div>';
    }

    document.getElementById('result').innerHTML = html;
}

// =====================================================================================
// HELPERS
// =====================================================================================

function buildFullStopList() {
    const all = [];
    if (startPoint) all.push(startPoint);
    all.push(...stops);
    if (endPoint) all.push(endPoint);
    return all;
}

function clearRoute() {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
}

function setLoading(active, msg = '') {
    const el = document.getElementById('loading');
    const msgEl = document.getElementById('loadingMsg');
    if (active) {
        msgEl.textContent = msg;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function showToast(msg, type = 'info') {
    const existing = document.getElementById('toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('toast-show'), 10);
    setTimeout(() => { toast.classList.remove('toast-show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function colorIcon(color) {
    const colors = { green: '#22c55e', red: '#ef4444' };
    const c = colors[color] || '#3b82f6';
    return L.divIcon({
        className: '',
        html: `<div style="
            width:18px;height:18px;border-radius:50%;
            background:${c};border:3px solid white;
            box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });
}

function stopIcon(num) {
    return L.divIcon({
        className: '',
        html: `<div style="
            width:28px;height:28px;border-radius:50%;
            background:#3b6fd4;border:3px solid white;
            box-shadow:0 2px 8px rgba(0,0,0,.3);
            display:flex;align-items:center;justify-content:center;
            color:white;font-size:11px;font-weight:700;font-family:sans-serif">${num}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });
}