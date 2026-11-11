# AYLSA Scraper — A YouTube Livestream Archive Scraper

AYLSA Scraper downloads the full live chat history of an archived YouTube livestream or premiere —
regular messages, Super Chats, Super Stickers, memberships and gifted memberships — and saves it as
JSON or CSV. It runs locally as a small Flask web app (or from the command line) and needs no API key
or YouTube login.

## Features

- Full **live chat replay** (every message) or YouTube's filtered **top chat**
- Captures **Super Chats, Super Stickers, new members / milestones, gift purchases and redemptions**
- Save as **JSON** or **CSV** (you can grab the other format too after a run)
- Live progress bar, counters and paid totals per currency while scraping
- **Stop early** and still keep everything collected so far
- **Results table** with type filters, a one-click **Paid only** view, a **Hide emoji-only** toggle,
  search, role, currency and **stream time range** filters, sortable columns and paging
- **Download exactly what you filtered** as JSON or CSV
- Click any row to see the message **rendered like it looked in YouTube's chat**
- Command-line mode for scripting

## Requirements

- Python **3.10 or newer** (tested on 3.13)
- An internet connection
- No API key, no account

## Setup

Do this once. Open a terminal in the project folder (the one containing `app.py`).

### Windows (PowerShell)

```powershell
# 1. Create a virtual environment
python -m venv .venv

# 2. Activate it
.venv\Scripts\Activate.ps1

# 3. Install dependencies
pip install -r requirements.txt
```

If activation fails with *"running scripts is disabled on this system"*, either allow local scripts
once for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or skip activation and call the venv's Python directly, e.g. `.venv\Scripts\python.exe app.py`.

### macOS / Linux

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

> Each time you open a new terminal, activate the virtual environment again (step 2) before running
> the app.

## Running the web app

```bash
python app.py
```

Then open **http://127.0.0.1:5000** in your browser. Stop the server with `Ctrl+C`.

To use a different port:

```bash
flask --app app run --port 5001
```

The server only listens on your own machine (`127.0.0.1`); it is not reachable from other devices.

## Changing the frontend

The web UI is a React + TypeScript app in `frontend/`. Its built files are committed in
`static/app/`, so running the app needs only Python. To change the UI you need
[Node.js](https://nodejs.org/) (20.19+ or 22.12+):

```bash
cd frontend
npm install        # first time only
npm run dev        # hot-reloading dev server; run `python app.py` alongside it for the API
npm run build      # type-check and rebuild static/app/ (commit the result)
```

`npm run dev` prints a local URL (http://localhost:5173/static/app/) and forwards `/api` requests to
Flask on port 5000. If Flask runs on another port, set `FLASK_URL`, e.g.
`FLASK_URL=http://127.0.0.1:5001 npm run dev`.

## Using the web app

1. **Paste the stream URL.** Any of these work:
   - `https://www.youtube.com/watch?v=VIDEO_ID`
   - `https://www.youtube.com/live/VIDEO_ID`
   - `https://youtu.be/VIDEO_ID`
   - just the 11-character `VIDEO_ID`
2. **Pick the chat mode.**
   - *All messages* — the complete chat (recommended for archiving).
   - *Top chat only* — YouTube's default view, which hides messages it considers spam or low quality.
3. **Pick the format** — JSON or CSV.
4. **Start scraping.** You'll see the video, a progress bar (position in the stream vs. its length),
   counters and a live feed of the latest messages. *Stop & keep what's collected* ends the run early
   and saves a partial file.
5. **Download** the file when it finishes. A second link lets you download the other format as well.
   Files are also saved to the `downloads/` folder.
6. **Explore the results table** that appears after the run:
   - The **hot-spot graph** above the table shows how many chats arrive in the ~30 seconds
     after each moment of the stream, so busy stretches stand out as spikes that mark where a burst starts (the top 5 are marked). It follows every filter
     except the time range, so searching `lol` shows where the lols are. Hover for time and count,
     **click** to clear the time filter and jump the table to that moment (the table switches to time
     order if needed), **drag** across a spike to set From / To, or click a peak dot to zoom the table
     to it.
   - Toggle message-type chips (Text, Super Chat, Super Sticker, Membership, Gift purchase,
     Gift redemption, System).
   - **$ Paid only** shows Super Chats + Super Stickers, highest amount first. **Reset** clears filters.
   - **Hide emoji-only** hides text messages made only of emoji and channel emotes (e.g. `😂😂` or
     `:_emote:`). Super Chats, memberships and other events are never hidden.
   - Search by author or message text; filter by Owner / Moderator / Member / Verified; filter by currency.
   - **From / To** limits results to a stretch of the stream, by stream time (the Time column). Use
     `1:05:22`, `5:30` or plain seconds like `90`; leave either side empty for no limit. `To` includes
     that whole second. Invalid entries turn red and are ignored.
   - Click the **Time, Type, Author or Amount** headers to sort (click again to reverse).
   - 100 rows per page, with Prev / Next.
   - **Download filtered JSON / CSV** exports only the rows matching your filters, in the current sort order.
7. **Click any row** to open a YouTube-style preview of that message, with its send time, stream time,
   a link to that moment in the stream, and a link to the author's channel.
   Use `←` / `→` to step through rows, `Esc` to close.

## Command line

The scraper also works without the web UI:

```bash
python scraper.py URL [-f json|csv] [-o OUTPUT_FILE] [--top]
```

| Option | Meaning |
|---|---|
| `-f`, `--format` | `json` (default) or `csv` |
| `-o`, `--output` | Output path (default: `<video_id>_chat.<format>` in the current folder) |
| `--top` | Scrape top chat instead of all messages |

Examples:

```bash
# Full chat as JSON
python scraper.py https://www.youtube.com/watch?v=VIDEO_ID

# Full chat as CSV to a specific file
python scraper.py https://youtu.be/VIDEO_ID -f csv -o my_stream_chat.csv

# Top chat only
python scraper.py VIDEO_ID --top
```

Progress is printed every 1,000 messages. Press `Ctrl+C` to stop early; whatever was collected is saved.

## Output

### JSON

```jsonc
{
  "video": { "video_id": "...", "title": "...", "channel": "...", "duration_seconds": 4824, ... },
  "scraped_at": "2026-09-11T02:36:25+00:00",
  "complete": true,            // false if the run was stopped early
  "summary": {
    "total_messages": 23320,
    "by_type": { "text_message": 23307, "superchat": 4, ... },
    "unique_authors": 2243,
    "paid_totals_by_currency": { "¥": 1540.0 },
    "gifted_memberships": 5
  },
  "messages": [ { ...one object per message, same fields as the CSV columns below... } ]
}
```

In JSON, `author_badges` is a list, and each message also has a `display` object (colours, emoji
images, badge images) used to redraw it YouTube-style.

### CSV

UTF-8 with BOM, so it opens correctly in Excel (including emoji and non-Latin names). One row per message:

| Column | Description |
|---|---|
| `id` | YouTube's message ID |
| `type` | Message type (see below) |
| `timestamp` | When it was sent (ISO 8601, UTC) |
| `time_in_video` | Position in the stream, e.g. `1:05:22` (negative = before the stream started) |
| `video_offset_ms` | Same, in milliseconds |
| `author_name`, `author_channel_id` | Who sent it |
| `author_badges` | Badge labels, separated by `; ` |
| `is_owner`, `is_moderator`, `is_member`, `is_verified` | Author role flags |
| `message` | Message text (custom emoji as `:shortcut:`) |
| `amount_text` | Paid amount as shown, e.g. `₱1,000.00` |
| `amount_value`, `currency` | Parsed amount and currency symbol, e.g. `1000.0` and `₱` |
| `header_text` | Membership / gift / system header, e.g. `Sent 5 … gift memberships` |
| `gift_count` | Number of gifted memberships (gift purchases) |
| `sticker_label`, `sticker_url` | Super Sticker name and image |
| `color` | Super Chat / Sticker tier colour (hex) |
| `author_photo` | Author avatar URL |
| `timestamp_usec` | Send time in microseconds since epoch |

### Message types

| `type` | What it is |
|---|---|
| `text_message` | Regular chat message |
| `superchat` | Super Chat (paid message) |
| `supersticker` | Super Sticker (paid sticker) |
| `membership` | New member or membership milestone |
| `gift_purchase` | Someone gifted memberships |
| `gift_redemption` | Someone received a gifted membership |
| `system` | Chat notices (e.g. "Live chat replay is on") |

## Troubleshooting & limitations

- **"This stream is still live"** — chat replay only exists after the stream ends.
- **"No chat replay found"** — the video isn't a past livestream/premiere, or the creator disabled chat replay.
- **"Video not playable"** — members-only, private, age-restricted or region-blocked videos aren't supported
  (the tool doesn't log in).
- **Scrapes of long streams take a while** — the whole chat has to be paged through (roughly 500
  messages/second). Filters are applied afterwards, so "Paid only" isn't faster to scrape.
- **Results disappeared after restarting the server** — jobs are kept in memory only. Files already saved
  in `downloads/` are kept.
- **Changes don't show up / old version still running (Windows)** — Windows can let two servers share
  port 5000, and requests keep going to the older one. Close every terminal running `app.py` and start
  it again.
- **Temporary network errors / rate limiting** are retried automatically (up to 5 times with backoff).
- **It suddenly stopped working** — the tool uses YouTube's internal web endpoints, which can change
  without notice. The scraper will need an update when that happens.

## Project structure

```
.
├── app.py               # Flask web app: jobs, results API, downloads
├── scraper.py           # Chat replay scraper, parser, JSON/CSV writers, CLI
├── templates/
│   └── index.html       # The web UI
├── static/
│   ├── ytchat.css       # YouTube-style message card styles
│   └── ytchat.js        # Renders a message as a YouTube-style card
├── requirements.txt     # Pinned Python dependencies
└── downloads/           # Created on first run; saved chat files
```

## Disclaimer

AYLSA Scraper is an unofficial tool and is not affiliated with YouTube or Google. It reads the same
public chat replay data the YouTube web player loads. Use it responsibly and in line with YouTube's
Terms of Service, and respect the privacy of chat participants and the rights of creators.
