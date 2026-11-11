# OEE Improvement Engine: review build (2D)

Line L01, data from the hackathon xlsx. This build shows the line as a 2D schematic; the 3D view is held back on purpose.

## Run
Node.js 18+ → double-click `start.bat`, or `node server.js` and open http://localhost:3000.
Opening `public/index.html` directly does not work: the page loads its data from the server. Works offline.

## What is in it
- Replay of any of the 21 shifts (pause, 1× / 60× / 600×), timeline of stops and defects.
- Station states from real stop events: fault (red), blocked / starved (yellow), running (green). Click a station for its history.
- Shift now: OEE, availability / performance / quality, counts. Losses: where the planned minutes went, downtime by code. Insights: recurring failures (ST-038 every Wednesday 09:08, ST-047 every Thursday 08:08), slow restart after breaks, Wednesday below target.

## Data
`data/data.json` is built from `data/source.xlsx`:

    pip install openpyxl
    python tools/xlsx_to_json.py data/source.xlsx data/data.json

The script stops if its totals do not match the MESIAC row of `Kontrola_zmien`.
Mapping "error code → station" is our assumption (the xlsx has equipment type only); it is at the top of the script.

## Not in this build yet
Table view, Claude-written fixes, login (the team's backend has it), 3D line.
