# OEE Improvement Engine: prototype (stage 1)

## Run
1. Install Node.js 18+ (https://nodejs.org).
2. Double-click `start.bat`, or run `node server.js` and open http://localhost:3000.

Opening `public/index.html` directly will not work: the page loads data and the model from the server.
Everything (three.js included) is local, so the demo runs without internet. Only the Google font needs it; without it a system font is used.

## Data
`data/data.json` is built from the xlsx:

    pip install openpyxl
    python tools/xlsx_to_json.py data/source.xlsx data/data.json

The script stops with an error if its totals do not match the MESIAC row of `Kontrola_zmien`.
The mapping "error code → station in the 3D model" is our assumption and lives at the top of the script.

## Folders
- `server.js`: tiny static server + `/api/data`
- `public/`: page (`index.html`, `style.css`, `app.js`) and `vendor/three` (three.js r187, MIT)
- `model/line_L01_stations.glb`: the line
- `data/`: source xlsx and generated json
- `tools/`: xlsx → json converter

## Controls
Drag = pan, wheel = zoom, click a station or its label = focus, Esc = back, Space = play/pause, ←/→ = ±5 min.
