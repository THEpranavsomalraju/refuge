"""Local build service: turns any U.S. city typed into the app into a place folder.

    places/.venv/Scripts/python -m places.server            (Windows)
    places/.venv/bin/python -m places.server                (macOS/Linux)

Listens on http://127.0.0.1:8787 (localhost only). The web dev server proxies /api here.

    GET  /api/places             featured towns (places/index.json) + built cities (data/places/index.json)
    GET  /api/suggest?query=...  size, density, and suggested rural/urban before building
    POST /api/build              {"query": "...", "area": "rural"|"urban", "max_buildings": 20000}
                                 -> {"job_id", "place_id", "status"}; "done" at once if already built
    GET  /api/build/<job_id>     {"status": "queued"|"running"|"done"|"error", "step", "error", ...}

Builds run one at a time in a background thread, using the same build_place() as the
featured towns, and write to data/places/<place_id>/ (gitignored).
"""

from __future__ import annotations

import argparse
import json
import logging
import queue
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from places.build_place import (
    DEFAULT_MAX_BUILDINGS, GENERATED_DIR, PLACES_DIR, STEPS, build_place, slugify, suggest_place,
)

log = logging.getLogger("places.server")

REPO = PLACES_DIR.parent
DEFAULT_TRAFFIC = [REPO / "ml" / "exports" / "traffic_by_hour.json", REPO / "data" / "ml_exports" / "traffic_by_hour.json"]


def read_index(folder: Path) -> list:
    path = folder / "index.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


class Builder:
    """One build at a time; jobs are kept in memory while the server runs."""

    def __init__(self, traffic: Path):
        self.traffic = traffic
        self.jobs: dict[str, dict] = {}
        self.queue: queue.Queue[str] = queue.Queue()
        self.lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True).start()

    def submit(self, query: str, area: str, max_buildings: int) -> dict:
        place_id = slugify(query)
        with self.lock:
            for job in self.jobs.values():   # same city already queued or running
                if job["place_id"] == place_id and job["status"] in ("queued", "running"):
                    return job
            job = {"job_id": uuid.uuid4().hex[:12], "place_id": place_id, "query": query, "area": area,
                   "max_buildings": max_buildings, "status": "queued", "step": None, "step_index": 0,
                   "steps": STEPS, "error": None, "started": None, "elapsed_s": 0}
            self.jobs[job["job_id"]] = job
        self.queue.put(job["job_id"])
        return job

    def status(self, job_id: str) -> dict | None:
        job = self.jobs.get(job_id)
        if job and job["status"] == "running" and job["started"]:
            job["elapsed_s"] = round(time.time() - job["started"])
        return job

    def _work(self):
        while True:
            job = self.jobs[self.queue.get()]
            job.update(status="running", started=time.time())

            def progress(step):
                job["step"] = step
                job["step_index"] = STEPS.index(step) if step in STEPS else job["step_index"]
                log.info("%s: %s", job["place_id"], step)

            try:
                build_place(job["query"], job["place_id"], job["area"], job["max_buildings"],
                            out_dir=GENERATED_DIR, traffic_path=self.traffic, progress=progress)
                job.update(status="done", step=None)
            except Exception as e:  # report every failure to the app instead of crashing the service
                log.error("build failed for %s:\n%s", job["query"], traceback.format_exc())
                job.update(status="error", error=f"{type(e).__name__}: {e}")
            job["elapsed_s"] = round(time.time() - job["started"])


def make_handler(builder: Builder):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

        def _json(self, code: int, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/api/places":
                featured = [{**e, "source": "featured"} for e in read_index(PLACES_DIR)]
                known = {e["place_id"] for e in featured}
                generated = [{**e, "source": "generated"} for e in read_index(GENERATED_DIR) if e["place_id"] not in known]
                return self._json(200, featured + generated)
            if url.path == "/api/suggest":
                query = (parse_qs(url.query).get("query") or [""])[0].strip()
                if not query:
                    return self._json(400, {"error": "Type a city, for example: Wilmington, North Carolina"})
                try:
                    return self._json(200, suggest_place(query))
                except Exception as e:
                    return self._json(404, {"error": f"Could not find {query!r}: {type(e).__name__}: {e}"})
            if url.path.startswith("/api/build/"):
                job = builder.status(url.path.rsplit("/", 1)[-1])
                return self._json(200, job) if job else self._json(404, {"error": "Unknown build job"})
            return self._json(404, {"error": "Not found"})

        def do_POST(self):
            if urlparse(self.path).path != "/api/build":
                return self._json(404, {"error": "Not found"})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "Body must be JSON"})
            query = str(body.get("query", "")).strip()
            area = body.get("area")
            max_b = int(body.get("max_buildings") or DEFAULT_MAX_BUILDINGS)
            if not query or area not in ("rural", "urban"):
                return self._json(400, {"error": 'Send {"query": "City, State", "area": "rural" or "urban"}'})
            place_id = slugify(query)
            for folder, source in ((PLACES_DIR, "featured"), (GENERATED_DIR, "generated")):
                if any(e["place_id"] == place_id for e in read_index(folder)):
                    return self._json(200, {"job_id": None, "place_id": place_id, "status": "done", "source": source})
            return self._json(202, builder.submit(query, area, max_b))

    return Handler


def main():
    p = argparse.ArgumentParser(description="Local build service for Refuge places.")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--traffic", default=None, help="traffic_by_hour.json (default ml/exports, then data/ml_exports)")
    args = p.parse_args()
    traffic = Path(args.traffic) if args.traffic else next((t for t in DEFAULT_TRAFFIC if t.exists()), None)
    if traffic is None or not traffic.exists():
        raise SystemExit("traffic_by_hour.json not found; pass --traffic PATH")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(Builder(traffic)))
    log.info("Refuge build service on http://127.0.0.1:%d (traffic: %s)", args.port, traffic)
    server.serve_forever()


if __name__ == "__main__":
    main()
