from flask import Flask, render_template, request, jsonify
from flask_sqlalchemy import SQLAlchemy
import requests

app = Flask(__name__)

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///routes.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)


# =====================================================================================
# DATABASE MODELS
# =====================================================================================

class Route(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100))
    stops = db.relationship('Stop', backref='route', lazy=True, cascade="all, delete-orphan")


class Stop(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100))
    lat = db.Column(db.Float)
    lon = db.Column(db.Float)
    position = db.Column(db.Integer, default=0)
    route_id = db.Column(db.Integer, db.ForeignKey('route.id'), nullable=False)


# =====================================================================================
# GEOCODING HELPER
# =====================================================================================

def geocode(place_name, city_hint="Columbus, Ohio"):
    """Geocode a place name using Nominatim. Returns (lat, lon) or (None, None)."""
    query = f"{place_name}, {city_hint}"
    url = "https://nominatim.openstreetmap.org/search"
    params = {"format": "json", "limit": 1, "q": query}
    headers = {"User-Agent": "EasyRouteApp/1.0"}
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=5)
        data = resp.json()
        if data:
            return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception as e:
        print(f"Geocode error: {e}")
    return None, None


# =====================================================================================
# BASIC ROUTES
# =====================================================================================

@app.route('/')
def home():
    return render_template('planner.html')


@app.route('/routes', methods=['GET'])
def get_routes():
    """Return all saved routes with their stops."""
    routes = Route.query.order_by(Route.id.desc()).all()
    result = []
    for route in routes:
        sorted_stops = sorted(route.stops, key=lambda s: s.position)
        result.append({
            "id": route.id,
            "name": route.name,
            "stops": [
                {"name": s.name, "lat": s.lat, "lon": s.lon}
                for s in sorted_stops
            ]
        })
    return jsonify(result)


@app.route('/routes/<int:route_id>', methods=['DELETE'])
def delete_route(route_id):
    """Delete a saved route."""
    route = Route.query.get_or_404(route_id)
    db.session.delete(route)
    db.session.commit()
    return jsonify({"success": True})


# =====================================================================================
# OPTIMIZE ROUTE  (OSRM trip API)
# =====================================================================================

@app.route('/optimize', methods=['POST'])
def optimize():
    """
    Accepts a list of stops with lat/lon (and optional name).
    Optionally accepts a route_name to save the route.
    Returns the optimized stop order, polyline geometry, distance, duration,
    and human-readable turn-by-turn steps.
    """
    data = request.get_json(silent=True) or {}
    stops = data.get('stops', [])
    route_name = data.get('route_name', 'My Route').strip() or 'My Route'
    save = data.get('save', False)

    # Build coordinate string for OSRM
    coords = []
    valid_stops = []
    for stop in stops:
        lat = stop.get("lat")
        lon = stop.get("lon")
        if lat is None or lon is None:
            continue
        coords.append(f"{lon},{lat}")
        valid_stops.append(stop)

    if len(coords) < 2:
        return jsonify({"error": "Need at least 2 valid stops with coordinates."}), 400

    coord_string = ";".join(coords)
    osrm_url = (
        f"http://router.project-osrm.org/trip/v1/driving/{coord_string}"
        "?overview=full&geometries=geojson&steps=true&annotations=false"
    )

    try:
        resp = requests.get(osrm_url, headers={"User-Agent": "EasyRouteApp"}, timeout=10)
    except requests.exceptions.Timeout:
        return jsonify({"error": "Route optimization timed out. Try again."}), 504
    except Exception as e:
        return jsonify({"error": f"Could not reach routing service: {str(e)}"}), 502

    if resp.status_code != 200:
        return jsonify({"error": "Routing service returned an error."}), 502

    try:
        route_res = resp.json()
    except Exception:
        return jsonify({"error": "Invalid response from routing service."}), 502

    if route_res.get("code") != "Ok":
        return jsonify({"error": f"OSRM error: {route_res.get('message', 'Unknown')}"}), 400

    # Re-order stops by OSRM's optimized waypoint order
    waypoints = route_res["waypoints"]
    optimized_stops = [valid_stops[wp["waypoint_index"]] for wp in waypoints]

    trip = route_res["trips"][0]
    geometry = trip["geometry"]["coordinates"]  # [[lon, lat], ...]

    # Build human-readable turn-by-turn directions from OSRM steps
    steps = []
    for leg_idx, leg in enumerate(trip["legs"]):
        from_name = optimized_stops[leg_idx].get("name", f"Stop {leg_idx + 1}")
        to_name = optimized_stops[(leg_idx + 1) % len(optimized_stops)].get("name", f"Stop {leg_idx + 2}")
        leg_steps = []
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})
            maneuver_type = maneuver.get("type", "")
            modifier = maneuver.get("modifier", "")
            road_name = step.get("name", "")
            distance_m = step.get("distance", 0)

            # Skip trivial steps
            if distance_m < 10 and maneuver_type not in ("depart", "arrive"):
                continue

            dist_str = _format_distance(distance_m)

            if maneuver_type == "depart":
                instruction = f"Head {modifier} on {road_name}" if road_name else "Depart"
            elif maneuver_type == "arrive":
                instruction = f"Arrive at {to_name}"
            elif maneuver_type == "turn":
                direction = modifier.capitalize() if modifier else ""
                instruction = f"Turn {direction} onto {road_name}" if road_name else f"Turn {direction}"
            elif maneuver_type == "new name":
                instruction = f"Continue onto {road_name}" if road_name else "Continue"
            elif maneuver_type in ("merge", "on ramp", "off ramp"):
                instruction = f"Take the ramp onto {road_name}" if road_name else maneuver_type.replace("_", " ").capitalize()
            elif maneuver_type == "roundabout":
                exit_num = maneuver.get("exit", "")
                instruction = f"Take exit {exit_num} at the roundabout" if exit_num else "Navigate the roundabout"
            elif maneuver_type == "fork":
                instruction = f"Keep {modifier} at the fork" if modifier else "Keep straight at the fork"
            else:
                instruction = f"{maneuver_type.replace('_', ' ').capitalize()} {road_name}".strip()

            if dist_str and maneuver_type not in ("arrive",):
                instruction += f" ({dist_str})"

            leg_steps.append(instruction)

        steps.append({
            "from": from_name,
            "to": to_name,
            "leg_distance": _format_distance(leg.get("distance", 0)),
            "leg_duration": _format_duration(leg.get("duration", 0)),
            "instructions": leg_steps
        })

    # Optionally save the route
    saved_id = None
    if save:
        new_route = Route(name=route_name)
        db.session.add(new_route)
        db.session.commit()
        for i, stop in enumerate(optimized_stops):
            db.session.add(Stop(
                name=stop.get("name", f"Stop {i+1}"),
                lat=stop.get("lat"),
                lon=stop.get("lon"),
                position=i,
                route_id=new_route.id
            ))
        db.session.commit()
        saved_id = new_route.id

    return jsonify({
        "optimized_stops": optimized_stops,
        "route_geometry": geometry,
        "distance_m": trip["distance"],
        "duration_s": trip["duration"],
        "distance_label": _format_distance(trip["distance"]),
        "duration_label": _format_duration(trip["duration"]),
        "steps": steps,
        "saved_id": saved_id
    })


# =====================================================================================
# GEOCODE ENDPOINT  (used by the frontend for Start / End / Add Stop)
# =====================================================================================

@app.route('/geocode', methods=['POST'])
def geocode_endpoint():
    """Geocode a single place name. Returns lat/lon or an error."""
    data = request.get_json(silent=True) or {}
    place = data.get('place', '').strip()
    city = data.get('city', 'Columbus, Ohio').strip()

    if not place:
        return jsonify({"error": "No place provided."}), 400

    lat, lon = geocode(place, city_hint=city)
    if lat is None:
        return jsonify({"error": f"Could not find '{place}'."}), 404

    return jsonify({"lat": lat, "lon": lon, "name": place})


# =====================================================================================
# HELPERS
# =====================================================================================

def _format_distance(meters):
    miles = meters / 1609.344
    if miles < 0.1:
        feet = meters * 3.281
        return f"{int(feet)} ft"
    return f"{miles:.1f} mi"


def _format_duration(seconds):
    minutes = int(seconds / 60)
    if minutes < 60:
        return f"{minutes} min"
    hours = minutes // 60
    mins = minutes % 60
    return f"{hours}h {mins}m"


# =====================================================================================
# RUN APP
# =====================================================================================

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    app.run(debug=True)