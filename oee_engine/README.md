# OEE Improvement Engine · line L01

Hackathon Magna, task 5. Line L01, 21 morning shifts, November 2026, data from the hackathon xlsx.

## Run
Node.js 18+ → double-click `start.bat`, or `node server.js` and open http://localhost:3000.
Opening `public/index.html` directly does not work: the page loads its data from the server. Works offline (fonts and three.js are local).

The view picks itself: **3D** if `model/line_L01_stations.glb` is there, **2D** schematic if not.
Force one with `?view=2d` or `?view=3d`.

## Claude fixes ("How to fix →")
1. Copy `.env.example` to `.env`.
2. Put your key in it: `ANTHROPIC_API_KEY=...` (optional: `ANTHROPIC_MODEL=...`).
3. Restart the server. The console says `AI fixes: on`.

The key lives only in `.env` on the server. `.env` is in `.gitignore`: never commit it.
The browser never sees the key and cannot send its own prompt: it sends the topic (a code, or "restart") and the replay moment.
The server builds the prompt from `data/data.json` using only events before that moment.
Same-origin requests only, 60 Claude calls per hour, answers cached.
Without a key the same button shows rule-based steps.

## Only the past
Everything the page counts or searches uses only data before the replay moment ("now"):
- a stop is known once it started (its end and length only once it ended);
- a defect is known once its hour is over (the xlsx gives defects per hour);
- the timeline shows stops and hourly values up to now; planned pauses are shown for the whole shift;
- Losses "month to date", the tables and the issues list stop at now;
- the shift picker shows dates only (a shift's OEE is not known before it runs).

Within the running hour, produced / good / NOK counts are the hour's totals spread over its running minutes: the xlsx has nothing finer.

Pattern search: same code, same weekday, same start time, on ≥ 2 past days and ≥ 75 % of the past same weekdays at that time.
2 hits = "watch", 3+ hits = "pattern". Example: Camera 2 (ST-038) at 09:08 becomes "watch" on Wed 11 Nov 09:08 and a pattern on Wed 18 Nov.
The next expected slot comes from the calendar, not from later data.

## Screens
- Line: shift sign (clock, shift n/21, progress), timeline on 3 lanes (stops, slow minutes per hour, NOK per hour), "Line stopped" card, 3D or 2D line.
- Shift now: OEE vs 85 % goal, DETAILS pull tab with availability / performance / quality and the counts behind them, counters.
- Losses: this shift as a sum (planned − stopped − slow − defect = good parts), month to date by cause.
- Insights: lead finding with its past occurrences, "Fix first" ranked by OEE points gained.
- Table view: shifts / hours / stops / defects, sortable, extra columns under Metrics, Issues drawer.

OEE points gained: OEE = good minutes / planned minutes at the 60 s ideal cycle, so a removed stop minute is worth P × Q / planned, a slow minute Q / planned, one bad part 1 / planned.

## Controls
Line view: drag = pan, wheel = zoom (3D), click a station = details, Esc = back, Space = play/pause, ←/→ = ±5 min, click the timeline to jump.

## Data
`data/data.json` is built from `data/source.xlsx`:

    pip install openpyxl
    python tools/xlsx_to_json.py data/source.xlsx data/data.json

The script stops if its totals do not match the MESIAC row of `Kontrola_zmien`.
Mapping "error code → station" is our assumption (the xlsx has equipment type only); it is at the top of the script.

## Folders
- `server.js`: static server, `/api/data`, `/api/config`, `POST /api/fix` (no dependencies)
- `public/`: `index.html`, `style.css`, `app.js`, `fonts/` (IBM Plex, OFL), `vendor/three` (three.js r187, MIT)
- `model/line_L01_stations.glb`: the line (3D build only)
- `data/`: source xlsx and generated json
- `tools/`: xlsx → json converter
