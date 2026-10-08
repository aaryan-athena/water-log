"""YOLOv8-seg inference on ONNX Runtime, using only numpy and Pillow.

Why not ultralytics: torch + ultralytics + OpenCV unpack to well over the
250 MB limit of a Vercel Python function. This module reproduces the parts of
the Ultralytics pipeline needed at inference time -- letterbox, decode, NMS
and native-resolution mask assembly -- so the deployed bundle only needs
onnxruntime, numpy and Pillow.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

PAD_VALUE = 114  # Ultralytics letterbox fill


@dataclass
class Instance:
    class_id: int
    class_name: str
    confidence: float
    box: tuple  # x1, y1, x2, y2 in original-image pixels
    mask: np.ndarray  # bool, original-image resolution


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> list:
    """Greedy non-maximum suppression. boxes: (n, 4) xyxy."""
    order = scores.argsort()[::-1]
    areas = (boxes[:, 2] - boxes[:, 0]).clip(0) * (boxes[:, 3] - boxes[:, 1]).clip(0)
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        rest = order[1:]
        xx1 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = (xx2 - xx1).clip(0) * (yy2 - yy1).clip(0)
        overlap = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[overlap <= iou]
    return keep


def _resize_linear(img: np.ndarray, width: int, height: int) -> np.ndarray:
    """Bilinear resize matching OpenCV's INTER_LINEAR (no antialiasing).

    The model was trained on cv2-resized letterbox inputs. Pillow's bilinear
    filter antialiases when downscaling, which shifts confidences by a few
    points on large photos; this keeps inference inputs identical to training.
    """
    h, w = img.shape[:2]
    if (h, w) == (height, width):
        return img.astype(np.float32)
    ys = ((np.arange(height) + 0.5) * (h / height) - 0.5).clip(0, h - 1)
    xs = ((np.arange(width) + 0.5) * (w / width) - 0.5).clip(0, w - 1)
    y0 = np.floor(ys).astype(np.int64); x0 = np.floor(xs).astype(np.int64)
    y1 = np.minimum(y0 + 1, h - 1); x1 = np.minimum(x0 + 1, w - 1)
    wy = (ys - y0)[:, None, None]; wx = (xs - x0)[None, :, None]
    src = img.astype(np.float32)
    if src.ndim == 2:
        src = src[:, :, None]
    top = src[y0][:, x0] * (1 - wx) + src[y0][:, x1] * wx
    bottom = src[y1][:, x0] * (1 - wx) + src[y1][:, x1] * wx
    out = top * (1 - wy) + bottom * wy
    return out[:, :, 0] if img.ndim == 2 else out


def _resize_float(arr: np.ndarray, width: int, height: int) -> np.ndarray:
    """Bilinear resize of a 2-D float32 array."""
    return np.asarray(
        Image.fromarray(arr.astype(np.float32)).resize((width, height), Image.BILINEAR)
    )


class SegModel:
    def __init__(self, path: Path | str, threads: int = 0) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        if threads:
            options.intra_op_num_threads = threads
        self.session = ort.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        meta = self.session.get_modelmeta().custom_metadata_map
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        self.imgsz = int(shape[2]) if isinstance(shape[2], int) else 640
        try:
            names = ast.literal_eval(meta.get("names", "{}"))
        except (ValueError, SyntaxError):
            names = {}
        self.names = {int(k): str(v) for k, v in names.items()} or {0: "waterlogging"}

    # -- preprocessing ---------------------------------------------------
    def _letterbox(self, image: Image.Image) -> tuple:
        w, h = image.size
        size = self.imgsz
        r = min(size / h, size / w)
        new_w, new_h = int(round(w * r)), int(round(h * r))
        dw, dh = (size - new_w) / 2, (size - new_h) / 2
        left, top = int(round(dw - 0.1)), int(round(dh - 0.1))
        canvas = np.full((size, size, 3), PAD_VALUE, dtype=np.float32)
        resized = np.round(_resize_linear(np.asarray(image), new_w, new_h)).clip(0, 255)
        canvas[top:top + new_h, left:left + new_w] = resized
        tensor = canvas.transpose(2, 0, 1)[None] / 255.0
        return np.ascontiguousarray(tensor), r, left, top, new_w, new_h

    # -- inference -------------------------------------------------------
    def predict(self, image: Image.Image, conf: float = 0.25, iou: float = 0.45,
                max_det: int = 100) -> list:
        image = image.convert("RGB")
        w, h = image.size
        tensor, r, left, top, new_w, new_h = self._letterbox(image)
        pred, proto = self.session.run(None, {self.input_name: tensor})

        nc = len(self.names)
        pred = pred[0].T  # (anchors, 4 + nc + 32)
        cls_scores = pred[:, 4:4 + nc]
        scores = cls_scores.max(axis=1)
        keep = scores > conf
        if not keep.any():
            return []
        pred, scores = pred[keep], scores[keep]
        class_ids = cls_scores[keep].argmax(axis=1)

        cx, cy, bw, bh = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
        # Offset per class so NMS never suppresses across classes.
        offsets = class_ids[:, None].astype(np.float32) * 4096.0
        selected = _nms(boxes + offsets, scores, iou)[:max_det]
        if not selected:
            return []
        boxes, scores, class_ids = boxes[selected], scores[selected], class_ids[selected]
        coefs = pred[selected, 4 + nc:]

        # Mask prototypes -> per-instance masks at proto resolution.
        _, mh, mw = proto[0].shape
        masks = _sigmoid(coefs @ proto[0].reshape(32, -1)).reshape(-1, mh, mw)

        # Strip the letterbox padding (in proto space), then upsample to the
        # original image -- Ultralytics' "retina" path, so edges stay sharp.
        sx, sy = mw / self.imgsz, mh / self.imgsz
        x0, y0 = int(round(left * sx)), int(round(top * sy))
        x1, y1 = int(round((left + new_w) * sx)), int(round((top + new_h) * sy))

        # Boxes back to original pixels.
        boxes[:, [0, 2]] = ((boxes[:, [0, 2]] - left) / r).clip(0, w)
        boxes[:, [1, 3]] = ((boxes[:, [1, 3]] - top) / r).clip(0, h)

        cols, rows = np.arange(w)[None, :], np.arange(h)[:, None]
        instances = []
        for k in range(len(selected)):
            full = _resize_float(masks[k, y0:y1, x0:x1], w, h)
            bx1, by1, bx2, by2 = boxes[k]
            inside = (cols >= bx1) & (cols < bx2) & (rows >= by1) & (rows < by2)
            binary = (full > 0.5) & inside
            if not binary.any():
                continue
            cid = int(class_ids[k])
            instances.append(Instance(
                class_id=cid,
                class_name=self.names.get(cid, str(cid)),
                confidence=float(scores[k]),
                box=tuple(float(v) for v in boxes[k]),
                mask=binary,
            ))
        return instances
