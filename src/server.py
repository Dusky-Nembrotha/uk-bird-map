"""Local web server for the map, plus the video encoder behind the studio.

The studio renders every frame in the browser and posts them here one at a
time; this server writes them to a scratch directory and hands the sequence to
ffmpeg. Doing it this way (rather than MediaRecorder in the browser) is what
makes the output frame-accurate: MediaRecorder timestamps frames by wall clock,
so a slow render would come out as a slow video. ffmpeg is told the frame rate
explicitly, so a 30 s clip at 30 fps is exactly 900 frames however long the
rendering took.

Run it with ./run.sh, or:

    python3 -m src.server
"""
import gzip
import json
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from .config import DATA, ROOT
from .util import log, setup_logging

WEB_DIR = ROOT / "web"
RENDER_DIR = DATA / "renders"
JOB_RE = re.compile(r"^[a-f0-9]{16}$")
MAX_FRAMES = 20_000
JOB_TTL_SECONDS = 6 * 3600

app = Flask(__name__, static_folder=None)
_jobs = {}
_jobs_lock = threading.Lock()


# ------------------------------------------------------------------ static

@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    resp = send_from_directory(WEB_DIR, filename)
    return _maybe_gzip(resp)


def _maybe_gzip(resp):
    """Compress the data payloads. sightings.json is several megabytes of
    repetitive JSON and compresses by roughly four to one, which is the
    difference between a snappy load and a visible wait."""
    if resp.status_code != 200:
        return resp
    ctype = (resp.headers.get("Content-Type") or "").split(";")[0]
    if ctype not in ("application/json", "text/javascript", "text/css",
                     "text/html", "application/javascript"):
        return resp
    if "gzip" not in (request.headers.get("Accept-Encoding") or ""):
        return resp
    # send_from_directory streams the file, so passthrough has to be turned
    # off before the body can be read and replaced.
    resp.direct_passthrough = False
    data = resp.get_data()
    if len(data) < 4096:
        return resp
    packed = gzip.compress(data, 6)
    resp.set_data(packed)
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Content-Length"] = str(len(packed))
    resp.headers["Vary"] = "Accept-Encoding"
    return resp


# ------------------------------------------------------------- render jobs

def _job_dir(job_id):
    if not JOB_RE.match(job_id or ""):
        raise ValueError("bad job id")
    return RENDER_DIR / job_id


@app.post("/api/render/start")
def render_start():
    _sweep_old_jobs()
    job_id = secrets.token_hex(8)
    d = _job_dir(job_id)
    (d / "frames").mkdir(parents=True, exist_ok=True)
    opts = request.get_json(silent=True) or {}
    with _jobs_lock:
        _jobs[job_id] = {"state": "receiving", "frames": 0, "created": time.time(),
                         "opts": opts, "progress": 0.0, "error": None}
    (d / "opts.json").write_text(json.dumps(opts))
    log.info("render %s: started %s", job_id, opts.get("label", ""))
    return jsonify({"job": job_id})


@app.post("/api/render/frame/<job_id>/<int:n>")
def render_frame(job_id, n):
    try:
        d = _job_dir(job_id)
    except ValueError:
        return jsonify({"error": "bad job"}), 400
    if not d.exists() or n < 0 or n > MAX_FRAMES:
        return jsonify({"error": "unknown job or frame"}), 404
    data = request.get_data()
    if not data:
        return jsonify({"error": "empty frame"}), 400
    (d / "frames" / f"{n:06d}.jpg").write_bytes(data)
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job:
            job["frames"] = max(job["frames"], n + 1)
    return jsonify({"ok": True})


@app.post("/api/render/finish/<job_id>")
def render_finish(job_id):
    try:
        d = _job_dir(job_id)
    except ValueError:
        return jsonify({"error": "bad job"}), 400
    if not d.exists():
        return jsonify({"error": "unknown job"}), 404

    body = request.get_json(silent=True) or {}
    fps = int(body.get("fps", 30))
    fmt = body.get("format", "mp4")
    if fmt not in ("mp4", "webm", "gif"):
        fmt = "mp4"

    with _jobs_lock:
        job = _jobs.setdefault(job_id, {"frames": 0})
        job["state"] = "encoding"
        job["progress"] = 0.0

    t = threading.Thread(target=_encode, args=(job_id, d, fps, fmt), daemon=True)
    t.start()
    return jsonify({"ok": True})


def _encode(job_id, d, fps, fmt):
    frames = sorted((d / "frames").glob("*.jpg"))
    out = d / f"sightings.{fmt}"
    try:
        if not frames:
            raise RuntimeError("no frames were received")

        common = ["ffmpeg", "-y", "-framerate", str(fps),
                  "-i", str(d / "frames" / "%06d.jpg")]
        if fmt == "mp4":
            # yuv420p and even dimensions keep it playable everywhere social
            # media will take it.
            cmd = common + [
                "-c:v", "libx264", "-preset", "medium", "-crf", "19",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                str(out)]
        elif fmt == "webm":
            cmd = common + ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0",
                            "-pix_fmt", "yuv420p", str(out)]
        else:
            palette = d / "palette.png"
            subprocess.run(common + ["-vf", "fps=%d,scale=640:-1:flags=lanczos,"
                                     "palettegen" % min(fps, 20), str(palette)],
                           check=True, capture_output=True, timeout=1800)
            cmd = common + ["-i", str(palette),
                            "-lavfi", "fps=%d,scale=640:-1:flags=lanczos[x];"
                                      "[x][1:v]paletteuse" % min(fps, 20),
                            str(out)]

        log.info("render %s: encoding %d frames at %d fps -> %s",
                 job_id, len(frames), fps, fmt)
        proc = subprocess.run(cmd, capture_output=True, timeout=3600)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", "replace")[-600:])

        size = out.stat().st_size
        with _jobs_lock:
            _jobs[job_id].update(state="done", progress=1.0,
                                 file=out.name, size=size)
        log.info("render %s: done, %.1f MB", job_id, size / 1e6)
        shutil.rmtree(d / "frames", ignore_errors=True)
    except Exception as e:  # noqa: BLE001
        log.warning("render %s failed: %s", job_id, e)
        with _jobs_lock:
            _jobs[job_id].update(state="error", error=str(e)[:600])


@app.get("/api/render/status/<job_id>")
def render_status(job_id):
    with _jobs_lock:
        job = dict(_jobs.get(job_id) or {})
    if not job:
        return jsonify({"error": "unknown job"}), 404
    job.pop("opts", None)
    if job.get("state") == "done":
        job["url"] = f"/api/render/download/{job_id}"
    return jsonify(job)


@app.get("/api/render/download/<job_id>")
def render_download(job_id):
    try:
        d = _job_dir(job_id)
    except ValueError:
        return jsonify({"error": "bad job"}), 400
    with _jobs_lock:
        job = _jobs.get(job_id) or {}
    name = job.get("file")
    if not name or not (d / name).exists():
        return jsonify({"error": "not ready"}), 404
    label = (job.get("opts") or {}).get("label") or "uk-bird-sightings"
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", label).strip("-")[:60] or "clip"
    ext = name.rsplit(".", 1)[-1]
    return send_from_directory(d, name, as_attachment=True,
                               download_name=f"{safe}.{ext}")


@app.post("/api/render/cancel/<job_id>")
def render_cancel(job_id):
    try:
        d = _job_dir(job_id)
    except ValueError:
        return jsonify({"error": "bad job"}), 400
    shutil.rmtree(d, ignore_errors=True)
    with _jobs_lock:
        _jobs.pop(job_id, None)
    return jsonify({"ok": True})


def _sweep_old_jobs():
    """Delete render scratch older than the TTL, so the disk does not fill."""
    if not RENDER_DIR.exists():
        return
    now = time.time()
    for d in RENDER_DIR.iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > JOB_TTL_SECONDS:
                shutil.rmtree(d, ignore_errors=True)
                with _jobs_lock:
                    _jobs.pop(d.name, None)
        except OSError:
            pass


# Species photos come from two iNaturalist hosts, only one of which sends
# CORS headers. Drawing a non-CORS image into the studio's canvas taints it
# and makes the frame export throw, so photos are fetched through here
# instead - same origin, no tainting, and cached on disk so a render does not
# hammer iNaturalist once per frame.
PHOTO_HOSTS = ("inaturalist-open-data.s3.amazonaws.com",
               "static.inaturalist.org", "inaturalist-open-data.s3.us-east-1.amazonaws.com")
PHOTO_CACHE = DATA / "photos"


@app.get("/api/photo")
def photo_proxy():
    import hashlib
    import urllib.parse
    url = request.args.get("u", "")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc not in PHOTO_HOSTS:
        return jsonify({"error": "not an allowed photo host"}), 400

    PHOTO_CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(url.encode()).hexdigest()[:24]
    ext = ".jpg" if ".jpg" in parsed.path.lower() else ".jpeg"
    path = PHOTO_CACHE / (key + ext)

    if not path.exists():
        try:
            import requests as _rq
            r = _rq.get(url, timeout=30,
                        headers={"User-Agent": "UK-Nature-Map/1.0"})
            r.raise_for_status()
            if not r.headers.get("Content-Type", "").startswith("image/"):
                return jsonify({"error": "not an image"}), 400
            path.write_bytes(r.content)
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": str(e)[:120]}), 502

    resp = send_from_directory(PHOTO_CACHE, path.name)
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@app.get("/api/capabilities")
def capabilities():
    """What the studio can offer: without ffmpeg, only in-browser capture."""
    return jsonify({
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "formats": ["mp4", "webm", "gif"] if shutil.which("ffmpeg") else [],
    })


def main(host="0.0.0.0", port=8777):
    setup_logging()
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    if not shutil.which("ffmpeg"):
        log.warning("ffmpeg not found - the studio will fall back to "
                    "in-browser WebM capture")
    log.info("UK Bird Sightings on http://localhost:%d/", port)
    app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--host", default="0.0.0.0")
    main(**vars(ap.parse_args()))
