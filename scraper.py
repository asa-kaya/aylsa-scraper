"""AYLSA Scraper (A YouTube Livestream Archive Scraper).

Scrape the live chat replay of an archived YouTube livestream (or premiere).

Uses the same internal "innertube" endpoints the YouTube web player uses to play
back chat, so no API key or login is needed.

CLI usage:
    python scraper.py <url> [-f json|csv] [-o output_path] [--top]
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from typing import Iterator

import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
WATCH_URL = "https://www.youtube.com/watch"
REPLAY_URL = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay"
FALLBACK_CONTEXT = {"client": {"clientName": "WEB", "clientVersion": "2.20250901.00.00", "hl": "en", "gl": "US"}}
MAX_RETRIES = 5

FORMATS = ("json", "csv")
CHAT_TYPES = ("all", "top")

VIDEO_ID_RE = re.compile(r"(?:v=|/live/|youtu\.be/|/shorts/|/embed/|/v/)([A-Za-z0-9_-]{11})")
INITIAL_DATA_RE = re.compile(r'(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*')
PLAYER_RESPONSE_RE = re.compile(r'(?:var\s+ytInitialPlayerResponse|window\["ytInitialPlayerResponse"\])\s*=\s*')
CONTEXT_RE = re.compile(r'"INNERTUBE_CONTEXT"\s*:\s*')
API_KEY_RE = re.compile(r'"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"')
AMOUNT_RE = re.compile(r"^(?P<pre>\D*?)\s*(?P<num>\d[\d,]*(?:\.\d+)?)\s*(?P<post>\D*)$")
# Non-symbol characters that appear inside emoji: ZWJ, variation selectors, keycap.
EMOJI_EXTRAS = {chr(0x200D), chr(0xFE0E), chr(0xFE0F), chr(0x20E3)}

RENDERER_TYPES = {
    "liveChatTextMessageRenderer": "text_message",
    "liveChatPaidMessageRenderer": "superchat",
    "liveChatPaidStickerRenderer": "supersticker",
    "liveChatMembershipItemRenderer": "membership",
    "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer": "gift_purchase",
    "liveChatSponsorshipsGiftRedemptionAnnouncementRenderer": "gift_redemption",
    "liveChatViewerEngagementMessageRenderer": "system",
    "liveChatModeChangeMessageRenderer": "system",
}
SKIPPED_RENDERERS = {"liveChatPlaceholderItemRenderer"}

CSV_FIELDS = [
    "id", "type", "timestamp", "time_in_video", "video_offset_ms",
    "author_name", "author_channel_id", "author_badges",
    "is_owner", "is_moderator", "is_member", "is_verified",
    "message", "amount_text", "amount_value", "currency",
    "header_text", "gift_count", "sticker_label", "sticker_url",
    "color", "author_photo", "timestamp_usec",
]


class ScraperError(Exception):
    """A problem the user should see (bad URL, no chat replay, network failure...)."""


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #

def extract_video_id(url: str) -> str:
    url = (url or "").strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    match = VIDEO_ID_RE.search(url)
    if not match:
        raise ScraperError("Could not find a YouTube video ID in that URL.")
    return match.group(1)


def _find_json(page: str, marker: re.Pattern):
    match = marker.search(page)
    if not match:
        return None
    start = page.find("{", match.end())
    if start == -1:
        return None
    try:
        obj, _ = json.JSONDecoder().raw_decode(page, start)
    except json.JSONDecodeError:
        return None
    return obj


def _find_key(obj, key):
    """Depth-first search for the first dict value stored under `key`."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if key in cur:
                return cur[key]
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return None


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _text(obj) -> str:
    """Flatten a YouTube text object (simpleText or runs, incl. emoji) to a string."""
    if not obj:
        return ""
    if "simpleText" in obj:
        return obj["simpleText"]
    parts = []
    for run in obj.get("runs", []):
        if "text" in run:
            parts.append(run["text"])
        elif "emoji" in run:
            emoji = run["emoji"]
            shortcuts = emoji.get("shortcuts") or []
            if emoji.get("isCustomEmoji"):
                parts.append(shortcuts[0] if shortcuts else emoji.get("emojiId", ""))
            else:
                parts.append(emoji.get("emojiId") or (shortcuts[0] if shortcuts else ""))
    return "".join(parts)


def _thumb(obj) -> str:
    thumbs = (obj or {}).get("thumbnails") or []
    if not thumbs:
        return ""
    url = thumbs[-1].get("url", "")
    return "https:" + url if url.startswith("//") else url


def _color(argb) -> str:
    return f"#{argb & 0xFFFFFF:06x}" if isinstance(argb, int) else ""


def _rgba(argb) -> str:
    if not isinstance(argb, int):
        return ""
    alpha = ((argb >> 24) & 0xFF) / 255
    return f"rgba({(argb >> 16) & 0xFF},{(argb >> 8) & 0xFF},{argb & 0xFF},{alpha:.3g})"


def _runs(obj) -> list[dict]:
    """Like _text, but keeps custom emoji as images so the message can be re-rendered."""
    if not obj:
        return []
    if "simpleText" in obj:
        return [{"text": obj["simpleText"]}]
    runs = []
    for run in obj.get("runs", []):
        if "text" in run:
            runs.append({"text": run["text"]})
        elif "emoji" in run:
            emoji = run["emoji"]
            shortcuts = emoji.get("shortcuts") or []
            if emoji.get("isCustomEmoji"):
                alt = shortcuts[0] if shortcuts else emoji.get("emojiId", "")
                runs.append({"emoji": _thumb(emoji.get("image")), "alt": alt})
            else:
                runs.append({"text": emoji.get("emojiId") or (shortcuts[0] if shortcuts else "")})
    return runs


def _iso(usec) -> str:
    if usec is None:
        return ""
    return datetime.fromtimestamp(usec / 1_000_000, tz=timezone.utc).isoformat(timespec="milliseconds")


def format_offset(ms) -> str:
    if ms is None:
        return ""
    sign = "-" if ms < 0 else ""
    total = abs(int(ms)) // 1000
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{sign}{h}:{m:02d}:{s:02d}" if h else f"{sign}{m}:{s:02d}"


def parse_amount(text: str):
    """'₱1,000.00' -> ('₱', 1000.0); 'CA$5.00' -> ('CA$', 5.0)."""
    match = AMOUNT_RE.match(text.replace("\xa0", " ").strip())
    if not match:
        return "", None
    currency = (match["pre"] or match["post"]).strip()
    try:
        value = float(match["num"].replace(",", ""))
    except ValueError:
        value = None
    return currency, value


def _is_emoji_char(ch: str) -> bool:
    cp = ord(ch)
    return (unicodedata.category(ch) == "So" or ch in EMOJI_EXTRAS
            or 0x1F3FB <= cp <= 0x1F3FF      # skin tones
            or 0xE0020 <= cp <= 0xE007F)     # tag chars (subdivision flags)


def is_emoji_only(msg: dict) -> bool:
    """True if a message is made only of emoji / custom emotes (plus whitespace)."""
    runs = (msg.get("display") or {}).get("runs") or ([{"text": msg["message"]}] if msg.get("message") else [])
    found = False
    for run in runs:
        if "emoji" in run:
            found = True
            continue
        text = "".join((run.get("text") or "").split())
        if text and not all(_is_emoji_char(c) for c in text):
            return False
        found = found or bool(text)
    return found


def _badges(renderer: dict):
    """Return (badge labels, is_* flags, badge list for rendering)."""
    names, badges = [], []
    flags = {"is_owner": False, "is_moderator": False, "is_member": False, "is_verified": False}
    for badge in renderer.get("authorBadges", []):
        b = badge.get("liveChatAuthorBadgeRenderer", {})
        label = b.get("tooltip") or b.get("accessibility", {}).get("accessibilityData", {}).get("label", "")
        if label:
            names.append(label)
        icon = b.get("icon", {}).get("iconType")
        kind = None
        if icon == "OWNER":
            kind = "owner"
        elif icon == "MODERATOR":
            kind = "moderator"
        elif icon in ("VERIFIED", "CHECK_CIRCLE_THICK"):
            kind = "verified"
        if "customThumbnail" in b:
            kind = "member"
        if kind:
            flags[f"is_{kind}"] = True
            badges.append({"kind": kind, "label": label,
                           "url": _thumb(b.get("customThumbnail")) if kind == "member" else ""})
    return names, flags, badges


# --------------------------------------------------------------------------- #
# Chat item parsing
# --------------------------------------------------------------------------- #

def parse_chat_item(item: dict, offset_ms):
    if not item:
        return None
    kind, r = next(iter(item.items()))
    if kind in SKIPPED_RENDERERS or not isinstance(r, dict):
        return None

    msg_type = RENDERER_TYPES.get(kind) or re.sub(r"^liveChat|Renderer$", "", kind)
    author_src = r
    if kind == "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer":
        author_src = r.get("header", {}).get("liveChatSponsorshipsHeaderRenderer", {})

    badges, flags, badge_list = _badges(author_src)
    ts_usec = _to_int(r.get("timestampUsec"))
    msg = {
        "id": r.get("id", ""),
        "type": msg_type,
        "timestamp": _iso(ts_usec),
        "timestamp_usec": ts_usec,
        "time_in_video": _text(r.get("timestampText")) or format_offset(offset_ms),
        "video_offset_ms": offset_ms,
        "author_name": _text(author_src.get("authorName")),
        "author_channel_id": r.get("authorExternalChannelId", ""),
        "author_photo": _thumb(author_src.get("authorPhoto")),
        "author_badges": badges,
        **flags,
        "message": _text(r.get("message")) or _text(r.get("text")),
        "amount_text": "",
        "amount_value": None,
        "currency": "",
        "header_text": "",
        "gift_count": None,
        "sticker_label": "",
        "sticker_url": "",
        "color": "",
        # Extra data for re-drawing the message like YouTube does (JSON only, not CSV).
        "display": {
            "runs": _runs(r.get("message")) or _runs(r.get("text")),
            "badges": badge_list,
            "header_bg": "", "header_text": "", "body_bg": "", "body_text": "", "author_text": "",
        },
    }
    display = msg["display"]

    if msg_type in ("superchat", "supersticker"):
        msg["amount_text"] = _text(r.get("purchaseAmountText"))
        msg["currency"], msg["amount_value"] = parse_amount(msg["amount_text"])
        msg["color"] = _color(r.get("bodyBackgroundColor") or r.get("backgroundColor")
                              or r.get("moneyChipBackgroundColor"))
    if msg_type == "supersticker":
        sticker = r.get("sticker", {})
        msg["sticker_label"] = sticker.get("accessibility", {}).get("accessibilityData", {}).get("label", "")
        msg["sticker_url"] = _thumb(sticker)
    elif msg_type == "membership":
        parts = [_text(r.get("headerPrimaryText")), _text(r.get("headerSubtext"))]
        msg["header_text"] = " | ".join(p for p in parts if p)
    elif msg_type == "gift_purchase":
        msg["header_text"] = _text(author_src.get("primaryText"))
        count = re.search(r"\d[\d,]*", msg["header_text"])
        msg["gift_count"] = int(count.group().replace(",", "")) if count else None
    elif msg_type == "system" and r.get("subtext"):
        msg["header_text"] = _text(r.get("subtext"))

    if msg_type == "superchat":
        display.update(
            header_bg=_rgba(r.get("headerBackgroundColor")), header_text=_rgba(r.get("headerTextColor")),
            body_bg=_rgba(r.get("bodyBackgroundColor")), body_text=_rgba(r.get("bodyTextColor")),
            author_text=_rgba(r.get("authorNameTextColor")),
        )
    elif msg_type == "supersticker":
        display.update(
            body_bg=_rgba(r.get("backgroundColor")), author_text=_rgba(r.get("authorNameTextColor")),
            header_bg=_rgba(r.get("moneyChipBackgroundColor")), header_text=_rgba(r.get("moneyChipTextColor")),
        )
    elif msg_type == "membership":
        display["header_primary"] = _text(r.get("headerPrimaryText"))
        display["header_sub"] = _text(r.get("headerSubtext"))
    elif msg_type == "gift_purchase":
        display["gift_image"] = _thumb(author_src.get("image"))

    if not msg["id"]:
        msg["id"] = f"{msg_type}-{ts_usec or offset_ms}-{msg['author_channel_id']}"
    return msg


class ChatStats:
    """Running totals, updated one message at a time."""

    def __init__(self):
        self.total = 0
        self.by_type: dict[str, int] = {}
        self.money: dict[str, float] = {}
        self.gifted_memberships = 0
        self._authors: set[str] = set()

    def add(self, msg: dict):
        self.total += 1
        self.by_type[msg["type"]] = self.by_type.get(msg["type"], 0) + 1
        if msg["author_channel_id"]:
            self._authors.add(msg["author_channel_id"])
        if msg["amount_value"] is not None:
            cur = msg["currency"] or "?"
            self.money[cur] = round(self.money.get(cur, 0) + msg["amount_value"], 2)
        if msg["gift_count"]:
            self.gifted_memberships += msg["gift_count"]

    def to_dict(self) -> dict:
        return {
            "total_messages": self.total,
            "by_type": dict(self.by_type),
            "unique_authors": len(self._authors),
            "paid_totals_by_currency": dict(self.money),
            "gifted_memberships": self.gifted_memberships,
        }


# --------------------------------------------------------------------------- #
# Scraper
# --------------------------------------------------------------------------- #

class ChatScraper:
    def __init__(self, url: str, chat_type: str = "all", stop_event: threading.Event | None = None):
        if chat_type not in CHAT_TYPES:
            raise ScraperError(f"chat_type must be one of {CHAT_TYPES}")
        self.video_id = extract_video_id(url)
        self.chat_type = chat_type
        self.stop_event = stop_event or threading.Event()
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"})
        # Skip the EU cookie-consent interstitial.
        self.session.cookies.set("SOCS", "CAI", domain=".youtube.com")
        self.session.cookies.set("CONSENT", "YES+cb", domain=".youtube.com")
        self.info: dict | None = None
        self.offset_ms = 0
        self._context = FALLBACK_CONTEXT
        self._api_key = None
        self._continuation = None

    # -- networking -----------------------------------------------------------

    def _request(self, method: str, url: str, **kwargs) -> requests.Response:
        last_error = None
        for attempt in range(MAX_RETRIES):
            if self.stop_event.is_set():
                raise ScraperError("Cancelled.")
            try:
                resp = self.session.request(method, url, timeout=30, **kwargs)
            except requests.RequestException as exc:
                last_error = exc
            else:
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_error = f"HTTP {resp.status_code}"
                elif resp.status_code >= 400:
                    raise ScraperError(f"YouTube returned HTTP {resp.status_code}.")
                else:
                    return resp
            self.stop_event.wait(min(2 ** attempt, 30))
        raise ScraperError(f"Network error after {MAX_RETRIES} attempts: {last_error}")

    # -- video page -----------------------------------------------------------

    def fetch_video_info(self) -> dict:
        page = self._request("GET", WATCH_URL, params={"v": self.video_id, "hl": "en", "gl": "US"}).text

        data = _find_json(page, INITIAL_DATA_RE)
        player = _find_json(page, PLAYER_RESPONSE_RE) or {}
        if data is None:
            raise ScraperError("Could not read the video page (video unavailable or YouTube blocked the request).")

        playability = player.get("playabilityStatus", {})
        if playability.get("status") not in (None, "OK"):
            reason = playability.get("reason") or playability.get("status")
            raise ScraperError(f"Video not playable: {reason}")

        context = _find_json(page, CONTEXT_RE)
        if context and "client" in context:
            context["client"].update({"hl": "en", "gl": "US"})
            self._context = context
        key = API_KEY_RE.search(page)
        self._api_key = key.group(1) if key else None

        details = player.get("videoDetails", {})
        micro = player.get("microformat", {}).get("playerMicroformatRenderer", {})
        broadcast = micro.get("liveBroadcastDetails", {})
        if broadcast.get("isLiveNow"):
            raise ScraperError("This stream is still live. Chat replay is only available after it ends.")

        conversation = data.get("contents", {}).get("twoColumnWatchNextResults", {}).get("conversationBar", {})
        chat = conversation.get("liveChatRenderer") or _find_key(data, "liveChatRenderer")
        if not chat:
            raise ScraperError("No chat replay found. The video may not be a past livestream/premiere, "
                               "or its chat replay is disabled.")
        self._continuation = self._pick_continuation(chat)

        self.info = {
            "video_id": self.video_id,
            "url": f"https://www.youtube.com/watch?v={self.video_id}",
            "title": details.get("title", ""),
            "channel": details.get("author", ""),
            "channel_id": details.get("channelId", ""),
            "duration_seconds": _to_int(details.get("lengthSeconds")),
            "stream_start": broadcast.get("startTimestamp", ""),
            "stream_end": broadcast.get("endTimestamp", ""),
            "thumbnail": f"https://i.ytimg.com/vi/{self.video_id}/hqdefault.jpg",
            "chat_type": "Live chat replay (all messages)" if self.chat_type == "all" else "Top chat replay",
        }
        return self.info

    @staticmethod
    def _pick_continuation(chat: dict) -> str:
        # The watch page's view-selector tokens are short stubs the API rejects;
        # only the default (top chat) reload token is complete. iter_messages
        # swaps it for the wanted view using the selector in the first response.
        for cont in chat.get("continuations", []):
            token = cont.get("reloadContinuationData", {}).get("continuation")
            if token:
                return token
        raise ScraperError("Chat replay exists but no continuation token was found.")

    def _select_view(self, response: dict):
        """Return the full token for the wanted chat view from a replay response, if present."""
        items = _find_key(response, "subMenuItems") or []
        options = []
        for item in items:
            token = item.get("continuation", {}).get("reloadContinuationData", {}).get("continuation")
            if token:
                options.append((str(item.get("title", "")).lower(), token))
        if not options:
            return None
        wanted = "live chat" if self.chat_type == "all" else "top chat"
        for title, token in options:
            if wanted in title:
                return token
        # YouTube lists [Top chat, Live chat]
        return options[-1][1] if self.chat_type == "all" else options[0][1]

    # -- chat replay ----------------------------------------------------------

    def iter_messages(self, seen_ids: set[str] | None = None) -> Iterator[dict]:
        """Yield chat messages from self.offset_ms on (set it before calling to resume mid-stream),
        skipping ids in seen_ids."""
        if self.info is None:
            self.fetch_video_info()

        params = {"prettyPrint": "false"}
        if self._api_key:
            params["key"] = self._api_key
        def fetch(token):
            body = {
                "context": self._context,
                "continuation": token,
                "currentPlayerState": {"playerOffsetMs": str(max(self.offset_ms, 0))},
            }
            return self._request("POST", REPLAY_URL, params=params, json=body).json()

        # Bootstrap with the page's default token, then switch to the wanted view.
        token = self._continuation
        first = fetch(token)
        view_token = self._select_view(first)
        if view_token and view_token != token:
            token, first = view_token, None

        used_tokens = set()
        seen_ids = set(seen_ids or ())

        while token and token not in used_tokens and not self.stop_event.is_set():
            used_tokens.add(token)
            data = first if first is not None else fetch(token)
            first = None
            cont = data.get("continuationContents", {}).get("liveChatContinuation")
            if cont is None:
                break  # end of replay

            for action in cont.get("actions", []):
                replay = action.get("replayChatItemAction")
                if not replay:
                    continue
                offset = _to_int(replay.get("videoOffsetTimeMsec"))
                if offset is not None:
                    self.offset_ms = max(self.offset_ms, offset)
                for inner in replay.get("actions", []):
                    msg = parse_chat_item(inner.get("addChatItemAction", {}).get("item"), offset)
                    if msg is None or msg["id"] in seen_ids:
                        continue
                    seen_ids.add(msg["id"])
                    yield msg

            token = None
            for c in cont.get("continuations", []):
                token = c.get("liveChatReplayContinuationData", {}).get("continuation")
                if token:
                    break


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #

def save_json(path, messages: list[dict], video: dict | None = None, stats: dict | None = None, partial=False):
    payload = {
        "video": video,
        "scraped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "complete": not partial,
        "summary": stats,
        "messages": messages,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def save_csv(path, messages: list[dict]):
    # utf-8-sig so Excel shows emoji / non-latin names correctly
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for msg in messages:
            writer.writerow({**msg, "author_badges": "; ".join(msg["author_badges"])})


def save(path, fmt: str, messages: list[dict], video=None, stats=None, partial=False):
    if fmt == "json":
        save_json(path, messages, video, stats, partial)
    elif fmt == "csv":
        save_csv(path, messages)
    else:
        raise ValueError(f"Unknown format {fmt!r}")


def main():
    parser = argparse.ArgumentParser(
        prog="AYLSA Scraper",
        description="A YouTube Livestream Archive Scraper: download the chat replay of an archived livestream.",
    )
    parser.add_argument("url")
    parser.add_argument("-f", "--format", choices=FORMATS, default="json")
    parser.add_argument("-o", "--output")
    parser.add_argument("--top", action="store_true", help="Top chat replay instead of all messages")
    args = parser.parse_args()

    scraper = ChatScraper(args.url, chat_type="top" if args.top else "all")
    info = scraper.fetch_video_info()
    print(f"{info['title']} — {info['channel']}")
    messages, stats = [], ChatStats()
    started = time.time()
    partial = False
    try:
        for msg in scraper.iter_messages():
            messages.append(msg)
            stats.add(msg)
            if stats.total % 1000 == 0:
                print(f"  {stats.total} messages ({format_offset(scraper.offset_ms)})", flush=True)
    except KeyboardInterrupt:
        partial = True
        print("Interrupted — saving what was collected.")
    out = args.output or f"{info['video_id']}_chat.{args.format}"
    save(out, args.format, messages, info, stats.to_dict(), partial)
    print(f"Saved {len(messages)} messages to {out} in {time.time() - started:.1f}s")
    print(json.dumps(stats.to_dict(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
