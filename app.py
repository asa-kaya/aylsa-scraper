"""AYLSA Scraper (A YouTube Livestream Archive Scraper) - Flask frontend for scraper.py.

Run:  python app.py   then open http://127.0.0.1:5000
"""

from __future__ import annotations

import re
import threading
import time
import traceback
import uuid
from collections import deque
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

from scraper import (CHAT_TYPES, FORMATS, ChatScraper, ChatStats, ScraperError, extract_video_id,
                     is_emoji_only, save)

DOWNLOAD_DIR = Path(__file__).resolve().parent / "downloads"
DOWNLOAD_DIR.mkdir(exist_ok=True)

ROLES = ("owner", "moderator", "member", "verified")
SEARCH_FIELDS = ("author_name", "message", "header_text", "sticker_label")
MAX_PAGE = 500

app = Flask(__name__)
jobs: dict[str, "Job"] = {}


def stats_for(messages: list[dict]) -> dict:
    stats = ChatStats()
    for msg in messages:
        stats.add(msg)
    return stats.to_dict()


def _csv_arg(args, name: str) -> set[str]:
    return {v for v in (args.get(name) or "").split(",") if v}


def filter_messages(messages: list[dict], args) -> list[dict]:
    """Filter and sort messages by the table's query params
    (types, roles, q, currency, hide_emoji, sort, order)."""
    types = _csv_arg(args, "types")
    roles = _csv_arg(args, "roles") & set(ROLES)
    query = (args.get("q") or "").strip().casefold()
    currency = args.get("currency") or ""
    hide_emoji = args.get("hide_emoji") == "1"

    def keep(m):
        if types and m["type"] not in types:
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


def run_job(job: Job):
    try:
        job.scraper = ChatScraper(job.url, chat_type=job.chat_type, stop_event=job.stop_event)
        job.status = "fetching"
        job.video = job.scraper.fetch_video_info()
        job.status = "running"
        for msg in job.scraper.iter_messages():
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


@app.post("/api/jobs")
def create_job():
    data = request.get_json(silent=True) or request.form
    url = (data.get("url") or "").strip()
    fmt = data.get("format", "json")
    chat_type = data.get("chat_type", "all")
    if fmt not in FORMATS or chat_type not in CHAT_TYPES:
        return jsonify(error="Invalid format or chat type."), 400
    try:
        extract_video_id(url)
    except ScraperError as exc:
        return jsonify(error=str(exc)), 400

    job = Job(url, fmt, chat_type)
    jobs[job.id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return jsonify(id=job.id), 201


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    return jsonify(get_job(job_id).to_dict())


@app.get("/api/jobs/<job_id>/messages")
def job_messages(job_id):
    snapshot = list(get_job(job_id).messages)
    rows = filter_messages(snapshot, request.args)
    offset = max(request.args.get("offset", 0, type=int), 0)
    limit = min(max(request.args.get("limit", 100, type=int), 1), MAX_PAGE)
    return jsonify(
        total=len(rows),
        offset=offset,
        limit=limit,
        summary=stats_for(rows),
        currencies=sorted({m["currency"] for m in snapshot if m["currency"]}),
        rows=rows[offset:offset + limit],
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
