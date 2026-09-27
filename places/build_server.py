"""Local build server: turns any U.S. city into a place folder the web app can load.

    places/.venv/Scripts/python places/build_server.py      (Windows)
    places/.venv/bin/python places/build_server.py          (macOS/Linux)

Listens on http://127.0.0.1:8765 (this computer only). The demo never depends on it:
the web app hides "Build a new city" when the server isn't running.

    POST /build              {"city": "Asheville", "state": "NC"}  ->  {"job_id": "..."}
    GET  /status/<job_id>    {"state": "queued|running|done|error", "progress": 0..1,
                              "place_id": "asheville_nc", "message": "..."}
    GET  /cities             places the "Future storm" picker can offer (featured + built here)
    GET  /health             {"ok": true}

Boundary: Census TIGERweb "Incorporated Places" (by name and state), falling back to
Nominatim (User-Agent set, at most 1 request per second). The place is the boundary's
bounding box, cropped to 15 x 15 km around the polygon's centroid when larger. The build
is build_place() without flood layers (no streams, hand_m, or crossings; 3DEP ground kept)
and writes places/<city_state>/. Builds run one at a time.
"""

from __future__ import annotations

import json
import logging
import math
import queue
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if __package__ in (None, ""):  # run as a script: make `places` importable
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests  # noqa: E402
from shapely.geometry import box, shape  # noqa: E402

from places.build_place import PLACES_DIR, STEPS, build_place  # noqa: E402

log = logging.getLogger("places.build_server")

PORT = 8765
MAX_SIDE_KM = 15.0
TIGERWEB = ("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
            "Places_CouSub_ConCity_SubMCD/MapServer/4/query")   # layer 4 = Incorporated Places (current)
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "refuge-cdc2026-build-server/0.1 (student project; local use)"

STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09", "DE": "10",
    "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19",
    "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35",
    "NY": "36", "NC": "37", "ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44",
    "SC": "45", "SD": "46", "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56", "PR": "72",
}
STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
    "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
    "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
}


def state_code(state: str) -> str:
    """'NC', 'nc', or 'North Carolina' -> 'NC'."""
    s = state.strip()
    if s.upper() in STATE_FIPS:
        return s.upper()
    for code, name in STATE_NAMES.items():
        if name.lower() == s.lower():
            return code
    raise ValueError(f"Unknown state {state!r}. Use a two-letter code like NC.")


def place_id_for(city: str, state: str) -> str:
    """('Asheville', 'NC') -> 'asheville_nc'."""
    slug = "".join(ch if ch.isalnum() else "_" for ch in city.strip().lower()).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return f"{slug}_{state.lower()}"


# ---------------------------------------------------------------------------
# Boundary lookup
# ---------------------------------------------------------------------------

_nominatim_lock = threading.Lock()
_nominatim_last = 0.0


def boundary(city: str, state: str):
    """City boundary polygon (WGS84) and where it came from."""
    code = state_code(state)
    safe = city.strip().replace("'", "''")
    r = requests.get(TIGERWEB, timeout=60, headers={"User-Agent": USER_AGENT}, params={
        "where": f"UPPER(BASENAME)=UPPER('{safe}') AND STATE='{STATE_FIPS[code]}'",
        "outFields": "NAME,GEOID", "returnGeometry": "true", "outSR": "4326", "f": "geojson",
    })
    if r.ok:
        feats = (r.json() or {}).get("features") or []
        if feats:
            biggest = max(feats, key=lambda f: shape(f["geometry"]).area)
            return shape(biggest["geometry"]), f"TIGERweb {biggest['properties'].get('NAME')} ({biggest['properties'].get('GEOID')})"
    return _nominatim_boundary(city, code)


def _nominatim_boundary(city: str, code: str):
    global _nominatim_last
    with _nominatim_lock:  # Nominatim policy: at most 1 request per second
        wait = 1.0 - (time.time() - _nominatim_last)
        if wait > 0:
            time.sleep(wait)
        r = requests.get(NOMINATIM, timeout=60, headers={"User-Agent": USER_AGENT}, params={
            "city": city, "state": STATE_NAMES[code], "country": "USA",
            "format": "geojson", "polygon_geojson": 1, "limit": 1,
        })
        _nominatim_last = time.time()
    r.raise_for_status()
    feats = r.json().get("features") or []
    if not feats:
        raise LookupError(f"Could not find {city}, {code} in Census TIGERweb or OpenStreetMap.")
    return shape(feats[0]["geometry"]), f"Nominatim {feats[0]['properties'].get('display_name', '')}"


def crop_box(poly, max_km: float = MAX_SIDE_KM):
    """Bounding box of `poly`; any side longer than max_km is cut to max_km around the centroid."""
    min_lon, min_lat, max_lon, max_lat = poly.bounds
    c = poly.centroid
    km_lon = 111.32 * math.cos(math.radians(c.y))
    km_lat = 110.9
    w = (max_lon - min_lon) * km_lon
    h = (max_lat - min_lat) * km_lat
    if w > max_km:
        half = max_km / 2 / km_lon
        min_lon, max_lon = c.x - half, c.x + half
    if h > max_km:
        half = max_km / 2 / km_lat
        min_lat, max_lat = c.y - half, c.y + half
    return (min_lon, min_lat, max_lon, max_lat), (round(w, 1), round(h, 1)), (w > max_km or h > max_km)


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def read_index() -> list:
    path = PLACES_DIR / "index.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


class Builder:
    """Runs one build at a time; job states live in memory while the server runs."""

    def __init__(self):
        self.jobs: dict[str, dict] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True).start()

    def submit(self, city: str, state: str) -> dict:
        code = state_code(state)
        pid = place_id_for(city, code)
        with self.lock:
            for job in self.jobs.values():
                if job["place_id"] == pid and job["state"] in ("queued", "running"):
                    return job
            job = {"job_id": uuid.uuid4().hex[:12], "place_id": pid, "city": city.strip(), "state_code": code,
                   "state": "queued", "progress": 0.0, "message": "Waiting for another build"}
            if any(e["place_id"] == pid for e in read_index()):
                job.update(state="done", progress=1.0, message="Already built")
                self.jobs[job["job_id"]] = job
                return job
            self.jobs[job["job_id"]] = job
        self.queue.put(job["job_id"])
        return job

    def _work(self):
        while True:
            job = self.jobs[self.queue.get()]
            started = time.time()
            job.update(state="running", progress=0.02, message="Looking up the city boundary")
            try:
                poly, source = boundary(job["city"], job["state_code"])
                bbox, (w, h), cropped = crop_box(poly)
                log.info("%s: %s, %.1f x %.1f km%s", job["place_id"], source, w, h, " (cropped to 15 x 15 km)" if cropped else "")

                def progress(step):
                    i = STEPS.index(step) if step in STEPS else 0
                    job.update(progress=round(0.05 + 0.9 * i / len(STEPS), 2), message=step.capitalize())

                name = f"{job['city']}, {STATE_NAMES[job['state_code']]}, USA"
                build_place(name, job["place_id"], out_dir=PLACES_DIR, progress=progress,
                            bbox=bbox, flood=False, kind="generated")
                job.update(state="done", progress=1.0,
                           message=f"Built in {time.time() - started:.0f} s" + (" (cropped to 15 x 15 km)" if cropped else ""))
            except Exception as e:  # report every failure to the app instead of crashing the server
                log.error("build failed for %s:\n%s", job["place_id"], traceback.format_exc())
                job.update(state="error", message=f"{type(e).__name__}: {e}")


def make_handler(builder: Builder):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

        def _send(self, code: int, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")   # the web dev server runs on another port
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?")[0].rstrip("/")
            if path == "/health":
                return self._send(200, {"ok": True})
            if path == "/cities":
                building = {j["place_id"] for j in builder.jobs.values() if j["state"] in ("queued", "running")}
                cities = [{"place_id": e["place_id"], "name": (e.get("name") or e["place_id"]).replace(", USA", ""),
                           "kind": e.get("kind", "featured"), "status": "ready"}
                          for e in read_index() if e.get("kind", "featured") != "past_event"]
                ready = {c["place_id"] for c in cities}
                cities += [{"place_id": j["place_id"], "name": f"{j['city']}, {j['state_code']}", "kind": "generated",
                            "status": "building"} for j in builder.jobs.values() if j["place_id"] in building - ready]
                return self._send(200, cities)
            if path.startswith("/status/"):
                job = builder.jobs.get(path.rsplit("/", 1)[-1])
                if not job:
                    return self._send(404, {"state": "error", "progress": 0, "place_id": None, "message": "Unknown job"})
                return self._send(200, {k: job[k] for k in ("state", "progress", "place_id", "message")})
            return self._send(404, {"message": "Not found"})

        def do_POST(self):
            if self.path.split("?")[0].rstrip("/") != "/build":
                return self._send(404, {"message": "Not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                city, state = str(body.get("city", "")).strip(), str(body.get("state", "")).strip()
                if not city or not state:
                    raise ValueError('Send {"city": "Asheville", "state": "NC"}')
                job = builder.submit(city, state)
            except (ValueError, json.JSONDecodeError) as e:
                return self._send(400, {"message": str(e)})
            return self._send(202, {"job_id": job["job_id"]})

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), make_handler(Builder()))
    log.info("Refuge build server on http://127.0.0.1:%d", PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
