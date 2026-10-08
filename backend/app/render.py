"""Turn a water mask into images the browser can draw. Pillow only."""
from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

#: Longest side of the overlay PNG. The browser scales it to the photo, so a
#: full-resolution mask would only cost bandwidth.
OVERLAY_MAX_SIDE = 640
FILL_ALPHA = 110
EDGE_ALPHA = 235


def _hex_to_rgb(colour: str) -> tuple:
    colour = colour.lstrip("#")
    return tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))


def _edges(mask: np.ndarray) -> np.ndarray:
    """One-pixel boundary of a boolean mask."""
    inner = mask.copy()
    inner[1:, :] &= mask[:-1, :]
    inner[:-1, :] &= mask[1:, :]
    inner[:, 1:] &= mask[:, :-1]
    inner[:, :-1] &= mask[:, 1:]
    return mask & ~inner


def overlay_png(union: np.ndarray, colour: str) -> str:
    """Transparent PNG: tinted water fill with a solid outline, as a data URL."""
    h, w = union.shape
    scale = min(1.0, OVERLAY_MAX_SIDE / max(h, w))
    if scale < 1.0:
        size = (max(1, int(w * scale)), max(1, int(h * scale)))
        union = np.asarray(Image.fromarray(union.astype(np.uint8) * 255).resize(
            size, Image.NEAREST)) > 127
    r, g, b = _hex_to_rgb(colour)
    rgba = np.zeros((*union.shape, 4), dtype=np.uint8)
    rgba[union] = (r, g, b, FILL_ALPHA)
    rgba[_edges(union)] = (r, g, b, EDGE_ALPHA)
    buf = io.BytesIO()
    Image.fromarray(rgba).save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def annotated_jpeg(image: Image.Image, union: np.ndarray, colour: str) -> str:
    """The photo with the water overlay burned in, as a JPEG data URL."""
    base = image.convert("RGBA")
    r, g, b = _hex_to_rgb(colour)
    layer = np.zeros((*union.shape, 4), dtype=np.uint8)
    layer[union] = (r, g, b, FILL_ALPHA)
    layer[_edges(union)] = (r, g, b, EDGE_ALPHA)
    out = Image.alpha_composite(base, Image.fromarray(layer)).convert("RGB")
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
