# Waterlogging Watch

Detects standing water on roads and streets from photos, videos and a live camera,
and reports **how much of the view is under water** as a coverage percentage with a
plain-language severity band — *none, minor, moderate, severe, critical*.

A FastAPI app that serves both the website and the detection API, so it deploys to
Vercel as a single function.

## Features

- **Analyze** — drop a photo or video. Photos return a highlighted water overlay,
  coverage % and severity. Videos are sampled in the browser and return a timeline,
  the worst moment, and grouped "water seen" events you can jump to.
- **Live** — point any camera at the street; detected water is outlined in real time.
- **History** — every saved check, with thumbnails, filters and a detail view. Stored
  in the browser (IndexedDB), so it persists across visits on that device.
- **Alerts** — results at or above a coverage threshold (default 8%) are flagged.
- Light and dark themes, responsive down to small phones.

## How it works

```
Browser (web/)                                 FastAPI function (api/index.py -> backend/)
 photo / video frame / camera frame  --JPEG-->  POST /api/detect
 overlay drawn on the original      <--JSON---  coverage %, severity, alert,
 history saved in IndexedDB                     transparent mask PNG
```

- **Inference** runs on ONNX Runtime with numpy and Pillow — no PyTorch or OpenCV —
  which keeps the function bundle at about 165 MB (measured), under Vercel's 250 MB limit.
- **Videos are never uploaded whole.** The browser seeks through the file and sends
  one small frame at a time, so requests stay far below Vercel's 4.5 MB body limit and
  no single request runs long.
- **The live view uses plain HTTP**, one frame in flight at a time, because Vercel
  functions don't support WebSockets. Slow responses skip frames instead of queuing.
- **The API is stateless.** Nothing is written server-side; history lives on the
  device that created it.

## Deploy to Vercel

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project** and import the repository.
3. Keep the defaults. `vercel.json` pins the **FastAPI** preset; Vercel installs
   `requirements.txt` and runs `api/index.py`, which serves the API under `/api/` and
   the website from `web/` at every other path.
4. Deploy.

> The website lives in `web/`, **not** `public/`. On Vercel's FastAPI preset a
> `public/` folder is left out of the function, so the site would 404. Don't add URL
> rewrites to `vercel.json` either: on this preset they change the path the app sees.

Or from the command line: `npm i -g vercel`, then `vercel` (preview) or
`vercel --prod`. `.vercelignore` limits the upload to the files the app needs.

Optional settings go in **Project → Settings → Environment Variables**; see
[`.env.example`](.env.example). None are required and none are secrets.

> The live camera needs HTTPS, which Vercel provides. Browsers block camera access on
> plain `http://` except for `localhost`.

## Run locally

```bash
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt uvicorn
uvicorn backend.app.main:app --reload --port 8000
```

Open <http://localhost:8000>. The same app serves the site and the API, locally and
on Vercel.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/detect` | Multipart `file` (an image). Returns coverage %, severity, alert flag, detected regions, and `overlay_png`. Pass `include_annotated=true` to also get the photo with the overlay drawn in. |
| `GET` | `/api/health` | Service and model status. |
| `GET` | `/api/meta` | Severity bands, public settings, dataset attribution. |
| `GET` | `/api/docs` | Interactive API docs. |

```bash
curl -F "file=@road.jpg" https://<your-app>.vercel.app/api/detect
```

## Project layout

```
api/index.py          Vercel entrypoint (exposes the FastAPI app)
backend/app/          API: ONNX inference, severity, overlay rendering, settings
web/                  The website: HTML, CSS, JS modules (no build step)
models/               waterlogging-seg.onnx — the trained segmentation model
requirements.txt      Python dependencies for the API
vercel.json           Pins Vercel's FastAPI preset
```

## Severity bands

| Coverage of the view | Band |
|---|---|
| up to 2% | none |
| up to 8% | minor |
| up to 20% | moderate |
| up to 40% | severe |
| above 40% | critical |

Coverage is the union of all detected water regions, so overlapping regions never
count twice.

## Limitations

- **A screening aid, not a safety system.** Coverage measures surface area, not depth;
  never use it to decide whether a road is safe to drive or wade through.
- Coverage is measured in the camera's view, so the same puddle reads larger from a
  low angle than from above. Compare a camera against its own history rather than
  across cameras.
- Expect weaker results at night, in heavy rain, and on surfaces that resemble water
  (wet asphalt, shadows, reflections).

## Attribution

Model trained on the **Water Logging** dataset by Roboflow Universe user *try-0tjxt*,
<https://universe.roboflow.com/try-0tjxt/water-logging-h74an>, licensed
**[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**. Attribution is shown in
the app footer and returned by `/api/meta`; keep it wherever the app or its results are
shown publicly.
