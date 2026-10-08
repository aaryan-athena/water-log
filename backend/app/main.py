"""Waterlogging detection API.

Stateless by design so it runs as a serverless function (Vercel): one
inference endpoint plus metadata. Video sampling, the live camera loop and
detection history all run in the browser.

Local:   uvicorn backend.app.main:app --reload --port 8000
Vercel:  api/index.py imports `app` from here.
"""
from __future__ import annotations

import asyncio
import io
import logging
import threading
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import settings
from .render import annotated_jpeg, overlay_png
from .severity import SEVERITY_BANDS, summarise, union_mask

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("waterlog")

API_VERSION = "1.0.0"
ATTRIBUTION = {
    "dataset": "Water Logging, Roboflow Universe (try-0tjxt)",
    "url": "https://universe.roboflow.com/try-0tjxt/water-logging-h74an",
    "license": "CC BY 4.0",
    "license_url": "https://creativecommons.org/licenses/by/4.0/",
}

app = FastAPI(
    title="Waterlogging Watch API",
    version=API_VERSION,
    description="Detects standing water in road and street imagery. Model trained on the "
                "Water Logging dataset by Roboflow Universe user try-0tjxt, CC BY 4.0.",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# -- model (loaded once per process, reused across warm invocations) ------
_model = None
_model_error = ""
_model_lock = threading.Lock()


def get_model():
    global _model, _model_error
    if _model is None:
        with _model_lock:
            if _model is None:
                from .onnx_seg import SegModel

                try:
                    _model = SegModel(settings.model_path)
                    log.info("Loaded %s", settings.model_path.name)
                except Exception as exc:  # noqa: BLE001
                    _model_error = str(exc)
                    raise HTTPException(503, f"Model could not be loaded: {exc}") from exc
    return _model


def _read_image(payload: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(payload))
        image = ImageOps.exif_transpose(image).convert("RGB")  # honour phone rotation
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(400, "That file could not be read as an image.") from exc
    if max(image.size) > settings.max_side:
        image.thumbnail((settings.max_side, settings.max_side), Image.BILINEAR)
    return image


# -- routes ----------------------------------------------------------------
@app.post("/api/detect")
async def detect(
    file: UploadFile = File(..., description="A JPEG/PNG/WebP image or video frame"),
    include_overlay: bool = Form(True, description="Return a transparent mask PNG"),
    include_annotated: bool = Form(False, description="Return the photo with the mask drawn in"),
):
    """Detect standing water in one image.

    Returns coverage %, a severity band, an alert flag, per-region boxes and
    confidences, and (by default) a transparent overlay PNG to draw over the
    original image.
    """
    payload = await file.read()
    if not payload:
        raise HTTPException(400, "The upload was empty.")
    if len(payload) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, f"Image exceeds {settings.max_upload_mb} MB.")

    image = _read_image(payload)
    model = get_model()
    started = time.perf_counter()
    instances = await asyncio.to_thread(
        model.predict, image, settings.conf_threshold, settings.iou_threshold, settings.max_det)
    elapsed = (time.perf_counter() - started) * 1000

    w, h = image.size
    union = union_mask(instances, h, w)
    severity = summarise(instances, union)
    body = {
        "severity": severity,
        "alert": severity["coverage_pct"] >= settings.alert_coverage_pct,
        "detections": [
            {"class_name": i.class_name, "confidence": round(i.confidence, 4),
             "bbox": [round(v, 1) for v in i.box]}
            for i in instances
        ],
        "frame": {"width": w, "height": h},
        "inference_ms": round(elapsed, 1),
    }
    if include_overlay:
        body["overlay_png"] = overlay_png(union, severity["severity_colour"])
    if include_annotated:
        body["annotated_image"] = annotated_jpeg(image, union, severity["severity_colour"])
    return JSONResponse(body)


@app.get("/api/health")
def health():
    status = "ok"
    try:
        model = get_model()
        model_info = {"loaded": True, "classes": list(model.names.values())}
    except HTTPException:
        status = "degraded"
        model_info = {"loaded": False, "error": _model_error}
    return {"status": status, "version": API_VERSION, "model": model_info}


@app.get("/api/meta")
def meta():
    return {
        "version": API_VERSION,
        "severity_bands": [{"max_coverage_pct": u, "label": l, "colour": c}
                           for u, l, c in SEVERITY_BANDS],
        "settings": settings.public(),
        "attribution": ATTRIBUTION,
    }


# Local development: serve the static site from the same origin. On Vercel the
# CDN serves public/ and this mount is never reached.
if settings.frontend_dir.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="site")
