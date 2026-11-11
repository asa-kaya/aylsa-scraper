"""AYLSA Scraper (A YouTube Livestream Archive Scraper) - Flask frontend for scraper.py.

Run:  python app.py   then open http://127.0.0.1:5000
"""

from __future__ import annotations

import math
import re
import threading
import time
import traceback
import uuid
from collections import deque
from itertools import accumulate
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests
from flask import Flask, Response, abort, jsonify, render_template, request, send_file

from scraper import (CHAT_TYPES, FORMATS, ChatScraper, ChatStats, ScraperError, extract_video_id,
                     is_emoji_only, save)

DOWNLOAD_DIR = Path(__file__).resolve().parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

ROLES = ("owner", "moderator", "member", "verified")
SEARCH_FIELDS = ("author_name", "message", "header_text", "sticker_label")
MAX_PAGE = 500
DENSITY_BINS = 300
DENSITY_PEAKS = 5
WINDOW_MIN_MS = 30_000  # hot-spot graph counts chats in (at least) the next 30s
MAX_JOBS = 3  # scrapes kept in memory this session; oldest finished one is evicted
ACTIVE = ("queued", "fetching", "running", "saving")
# Image proxy (lets the page export chat cards to PNG without tainting the canvas).
IMG_HOSTS = ("ggpht.com", "googleusercontent.com", "ytimg.com", "gstatic.com", "youtube.com")
IMG_MAX_BYTES = 5 * 1024 * 1024

app = Flask(__name__)
jobs: dict[str, "Job"] = {}  # insertion order = age, oldest first
jobs_lock = threading.Lock()


def stats_for(messages: list[dict]) -> dict:
    stats = ChatStats()
    for msg in messages:
        stats.add(msg)
    return stats.to_dict()


def _csv_arg(args, name: str) -> set[str]:
    return {v for v in (args.get(name) or "").split(",") if v}


def _parse_offset(value) -> int | None:
    """'1:05:22' / '5:30' / '90' -> milliseconds; None if empty or invalid."""
    parts = (value or "").strip().split(":")
    if len(parts) > 3 or not all(p.isdigit() for p in parts):
        return None
    secs = 0
    for p in parts:
        secs = secs * 60 + int(p)
    return secs * 1000


def filter_messages(messages: list[dict], args, use_time: bool = True) -> list[dict]:
    """Filter and sort messages by the table's query params
    (types, roles, q, currency, hide_emoji, from, to, sort, order).
    use_time=False ignores the from/to stream-time range."""
    types = _csv_arg(args, "types")
    roles = _csv_arg(args, "roles") & set(ROLES)
    query = (args.get("q") or "").strip().casefold()
    currency = args.get("currency") or ""
    hide_emoji = args.get("hide_emoji") == "1"
    start, end = (_parse_offset(args.get("from")), _parse_offset(args.get("to"))) if use_time else (None, None)

    def keep(m):
        if types and m["type"] not in types:
            return False
        # Stream-time range; "to" covers the whole second shown (1:00 keeps 1:00.999).
        if start is not None or end is not None:
            off = m["video_offset_ms"]
            if off is None or (start is not None and off < start) or (end is not None and off >= end + 1000):
                return False
        # Only plain chat lines; paid messages and events stay even if emoji-only.
        if hide_emoji and m["type"] == "text_message" and is_emoji_only(m):
            return False
        if roles and not any(m[f"is_{r}"] for r in roles):
            return False
        if currency and m["currency"] != currency:
            return False
        if query and not any(query in (m[f] or "").casefold() for f in SEARCH_FIELDS):
            return False
        return True

    rows = [m for m in messages if keep(m)]
    sort = args.get("sort", "time")
    desc = args.get("order") == "desc"
    if sort == "amount":
        # Unpaid messages always go last, whichever direction.
        paid = sorted((m for m in rows if m["amount_value"] is not None),
                      key=lambda m: m["amount_value"], reverse=desc)
        rows = paid + [m for m in rows if m["amount_value"] is None]
    elif sort == "author":
        rows.sort(key=lambda m: m["author_name"].casefold(), reverse=desc)
    elif sort == "type":
        rows.sort(key=lambda m: m["type"], reverse=desc)
    elif desc:  # "time": scrape order is already chronological
        rows.reverse()
    return rows


class Job:
    def __init__(self, url: str, fmt: str, chat_type: str):
        self.id = uuid.uuid4().hex
        self.url = url
        self.video_id = extract_video_id(url)
        self.fmt = fmt
        self.chat_type = chat_type
        self.status = "queued"  # queued -> fetching -> running -> saving -> done | cancelled | error
        self.error = ""
        self.video: dict | None = None
        self.messages: list[dict] = []
        self.stats = ChatStats()
        self.recent: deque[dict] = deque(maxlen=30)
        self.scraper: ChatScraper | None = None
        self.stop_event = threading.Event()
        self.save_lock = threading.Lock()
        self.started = time.time()
        self.finished: float | None = None

    @property
    def base_name(self) -> str:
        title = (self.video or {}).get("title", "")
        slug = re.sub(r"[^\w\-]+", "_", title).strip("_")[:60]
        vid = (self.video or {}).get("video_id", "chat")
        return f"{vid}_{slug}_chat" if slug else f"{vid}_chat"

    def file_path(self, fmt: str, suffix: str = "") -> Path:
        return DOWNLOAD_DIR / f"{self.base_name}{suffix}.{fmt}"

    def write_file(self, fmt: str, messages: list[dict] | None = None, suffix: str = "") -> Path:
        if messages is None:
            messages, stats = self.messages, self.stats.to_dict()
        else:
            stats = stats_for(messages)
        path = self.file_path(fmt, suffix)
        with self.save_lock:
            save(path, fmt, messages, self.video, stats, partial=self.stop_event.is_set())
        return path

    @property
    def resumable(self) -> bool:
        # Stopped by the user, or failed mid-scrape (e.g. network) after collecting something.
        return self.status == "cancelled" or (self.status == "error" and bool(self.messages))

    @property
    def resume_offset(self) -> int:
        """Stream time (ms) of the last collected message; a resume continues from here."""
        offsets = (m["video_offset_ms"] for m in reversed(self.messages) if m["video_offset_ms"] is not None)
        return max(next(offsets, 0), 0)

    def summary(self) -> dict:
        return {
            "id": self.id,
            "url": self.url,
            "video_id": self.video_id,
            "chat_type": self.chat_type,
            "title": (self.video or {}).get("title", ""),
            "status": self.status,
            "total": self.stats.total,
            "resumable": self.resumable,
            "offset_ms": self.resume_offset if self.resumable else None,
        }

    def to_dict(self) -> dict:
        offset = self.scraper.offset_ms if self.scraper else 0
        duration = (self.video or {}).get("duration_seconds") or 0
        progress = min(offset / (duration * 1000), 1.0) if duration else None
        if self.status == "done":
            progress = 1.0
        return {
            "id": self.id,
            "status": self.status,
            "error": self.error,
            "format": self.fmt,
            "video": self.video,
            "stats": self.stats.to_dict(),
            "progress": progress,
            "offset_ms": offset,
            "elapsed": round((self.finished or time.time()) - self.started, 1),
            "recent": list(self.recent),
            "file": self.file_path(self.fmt).name if self.status in ("done", "cancelled") else None,
        }


def run_job(job: Job, resume_from: int | None = None):
    """Scrape into job. With resume_from (stream ms), seek there and append to the messages already collected."""
    try:
        job.scraper = ChatScraper(job.url, chat_type=job.chat_type, stop_event=job.stop_event)
        if resume_from is not None:
            job.scraper.offset_ms = resume_from  # sent as playerOffsetMs, so the first request seeks there
        job.status = "fetching"
        job.video = job.scraper.fetch_video_info()
        job.status = "running"
        seen = {m["id"] for m in job.messages} if resume_from is not None else None
        checked = resume_from is None
        for msg in job.scraper.iter_messages(seen_ids=seen):
            if not checked:
                checked = True
                off = msg["video_offset_ms"]
                if off is not None and off < resume_from - 60_000:
                    print(f"[resume] {job.video_id}: asked for {resume_from} ms, replay restarted at {off} ms "
                          "(seek ignored; already-collected messages are skipped)")
            job.messages.append(msg)
            job.stats.add(msg)
            job.recent.append(msg)
        job.status = "saving"
        job.write_file(job.fmt)
        job.status = "cancelled" if job.stop_event.is_set() else "done"
    except ScraperError as exc:
        # A cancel during a retry wait surfaces as ScraperError; keep what we have.
        if job.stop_event.is_set() and job.video:
            job.write_file(job.fmt)
            job.status = "cancelled"
        else:
            job.status, job.error = "error", str(exc)
    except Exception as exc:  # noqa: BLE001 - surface anything unexpected to the UI
        traceback.print_exc()
        job.status, job.error = "error", f"Unexpected error: {exc}"
    finally:
        job.finished = time.time()


def get_job(job_id: str) -> Job:
    job = jobs.get(job_id)
    if job is None:
        abort(404)
    return job


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/img")
def proxy_image():
    """Fetch a YouTube CDN image same-origin, so the browser can draw it into a canvas."""
    def allowed(u: str) -> bool:
        host = (urlsplit(u).hostname or "").lower()
        return any(host == h or host.endswith("." + h) for h in IMG_HOSTS)

    parts = urlsplit(request.args.get("u", ""))
    if parts.scheme not in ("http", "https") or not allowed(parts.geturl()):
        return jsonify(error="Image host not allowed."), 400
    url = urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))
    try:
        with requests.get(url, timeout=10, stream=True) as r:
            ctype = r.headers.get("Content-Type", "")
            if r.status_code != 200 or not ctype.startswith("image/") or not allowed(r.url):
                return jsonify(error="Image fetch failed."), 502
            data = b""
            for chunk in r.iter_content(64 * 1024):
                data += chunk
                if len(data) > IMG_MAX_BYTES:
                    return jsonify(error="Image too large."), 502
    except requests.RequestException:
        return jsonify(error="Image fetch failed."), 502
    return Response(data, content_type=ctype, headers={"Cache-Control": "max-age=86400"})


@app.post("/api/jobs")
def create_job():
    data = request.get_json(silent=True) or request.form
    url = (data.get("url") or "").strip()
    fmt = data.get("format", "json")
    chat_type = data.get("chat_type", "all")
    if fmt not in FORMATS or chat_type not in CHAT_TYPES:
        return jsonify(error="Invalid format or chat type."), 400
    try:
        video_id = extract_video_id(url)
    except ScraperError as exc:
        return jsonify(error=str(exc)), 400

    with jobs_lock:
        same = [j for j in jobs.values() if j.video_id == video_id and j.chat_type == chat_type]
        for j in same:
            # Reuse a finished or still-running scrape of the same stream; failed/stopped ones get replaced.
            if j.status not in ("error", "cancelled"):
                jobs[j.id] = jobs.pop(j.id)  # mark as most recently used
                return jsonify(id=j.id, reused=True), 200
        for j in same:
            del jobs[j.id]
        if len(jobs) >= MAX_JOBS:
            oldest = next((j for j in jobs.values() if j.status not in ACTIVE), None)
            if oldest is None:
                return jsonify(error=f"{MAX_JOBS} scrapes already running. Close one first."), 409
            del jobs[oldest.id]
        job = Job(url, fmt, chat_type)
        jobs[job.id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return jsonify(id=job.id), 201


@app.post("/api/jobs/<job_id>/resume")
def resume_job(job_id):
    with jobs_lock:
        job = get_job(job_id)
        if not job.resumable:
            return jsonify(error="Only a stopped scrape can be resumed."), 409
        elapsed = (job.finished or time.time()) - job.started
        job.stop_event = threading.Event()
        job.status, job.error, job.finished = "queued", "", None
        job.started = time.time() - elapsed  # elapsed keeps counting from where it stopped
        jobs[job.id] = jobs.pop(job.id)  # mark as most recently used
        resume_from = job.resume_offset
    threading.Thread(target=run_job, args=(job, resume_from), daemon=True).start()
    return jsonify(id=job.id)


@app.get("/api/jobs")
def list_jobs():
    with jobs_lock:
        return jsonify([j.summary() for j in reversed(jobs.values())])


@app.delete("/api/jobs/<job_id>")
def delete_job(job_id):
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if job is None:
        abort(404)
    job.stop_event.set()  # a running scrape stops and saves its partial file as on cancel
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    return jsonify(get_job(job_id).to_dict())


@app.get("/api/jobs/<job_id>/messages")
def job_messages(job_id):
    snapshot = list(get_job(job_id).messages)
    rows = filter_messages(snapshot, request.args)
    offset = max(request.args.get("offset", 0, type=int), 0)
    limit = min(max(request.args.get("limit", 100, type=int), 1), MAX_PAGE)
    # "at" (stream ms, from a hot-spot graph click): return the page holding the first row at
    # that moment, and its index on the page as "focus". Assumes rows are in time order.
    focus = None
    at = request.args.get("at", type=int)
    if at is not None and rows:
        desc = request.args.get("order") == "desc"
        idx = next((i for i, m in enumerate(rows) if m["video_offset_ms"] is not None
                    and (m["video_offset_ms"] <= at if desc else m["video_offset_ms"] >= at)),
                   len(rows) - 1)
        offset = idx // limit * limit
        focus = idx - offset
    return jsonify(
        total=len(rows),
        offset=offset,
        limit=limit,
        focus=focus,
        summary=stats_for(rows),
        currencies=sorted({m["currency"] for m in snapshot if m["currency"]}),
        rows=rows[offset:offset + limit],
    )


@app.get("/api/jobs/<job_id>/density")
def job_density(job_id):
    """Chat activity over stream time for the hot-spot graph. Honors every table filter
    except the from/to range, so the graph always spans the whole stream."""
    job = get_job(job_id)
    rows = filter_messages(list(job.messages), request.args, use_time=False)
    # Pre-stream chat (negative offset) is folded into 0:00.
    offsets = [max(int(m["video_offset_ms"]), 0) for m in rows if m["video_offset_ms"] is not None]
    bins = min(max(request.args.get("bins", DENSITY_BINS, type=int), 50), 1000)
    duration_ms = ((job.video or {}).get("duration_seconds") or 0) * 1000
    span = max(duration_ms, max(offsets, default=0) + 1)
    bucket = math.ceil(span / bins)

    counts = [0] * bins
    for off in offsets:
        counts[min(off // bucket, bins - 1)] += 1
    # Forward-looking: nearby[i] = messages in the k buckets starting at bucket i, via prefix
    # sums. A spike therefore marks where a burst starts, not its middle. k >= 2 so a burst
    # straddling a bucket edge isn't split in half on long streams (coarse buckets).
    k = max(2, math.ceil(WINDOW_MIN_MS / bucket))
    prefix = list(accumulate(counts, initial=0))
    nearby = [prefix[min(i + k, bins)] - prefix[i] for i in range(bins)]

    # Top local maxima (earliest bucket of a plateau), each a full window away from any higher peak.
    candidates = sorted(
        (i for i in range(bins)
         if nearby[i] and nearby[i] >= (nearby[i - 1] if i else 0)
         and nearby[i] >= (nearby[i + 1] if i + 1 < bins else 0)),
        key=lambda i: -nearby[i])
    picked: list[int] = []
    for i in candidates:
        if all(abs(i - p) >= k for p in picked):
            picked.append(i)
            if len(picked) == DENSITY_PEAKS:
                break

    return jsonify(
        bucket_ms=bucket,
        window_ms=k * bucket,
        span_ms=span,
        counts=counts,
        nearby=nearby,
        peaks=[{"offset_ms": i * bucket, "count": nearby[i]} for i in picked],
        total=len(offsets),
    )


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id):
    get_job(job_id).stop_event.set()
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>/download")
def download(job_id):
    job = get_job(job_id)
    fmt = request.args.get("format", job.fmt)
    if fmt not in FORMATS:
        abort(400)
    if job.status not in ("done", "cancelled"):
        return jsonify(error="Scrape not finished yet."), 409
    if request.args.get("filtered"):
        path = job.write_file(fmt, filter_messages(list(job.messages), request.args), suffix="_filtered")
    else:
        path = job.file_path(fmt)
        if not path.exists():
            job.write_file(fmt)
    mimetype = "application/json" if fmt == "json" else "text/csv"
    return send_file(path, as_attachment=True, download_name=path.name, mimetype=mimetype)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
