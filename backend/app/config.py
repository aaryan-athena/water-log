"""Settings, all overridable by environment variable. No secrets live here."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env(key: str, default: str) -> str:
    return os.getenv(key, "").strip() or default


def _float(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, "") or default)
    except ValueError:
        return default


def _int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, "") or default)
    except ValueError:
        return default


@dataclass
class Settings:
    model_path: Path = field(default_factory=lambda: Path(
        _env("WATERLOG_MODEL_PATH", str(REPO_ROOT / "models" / "waterlogging-seg.onnx"))))
    conf_threshold: float = field(default_factory=lambda: _float("WATERLOG_CONF", 0.25))
    iou_threshold: float = field(default_factory=lambda: _float("WATERLOG_IOU", 0.45))
    max_det: int = field(default_factory=lambda: _int("WATERLOG_MAX_DET", 100))
    #: Coverage % at or above which a result is flagged as an alert.
    alert_coverage_pct: float = field(default_factory=lambda: _float("WATERLOG_ALERT_COVERAGE_PCT", 8.0))
    #: Uploads are downscaled in the browser; this is a backstop. Vercel's own
    #: request limit is 4.5 MB.
    max_upload_mb: int = field(default_factory=lambda: _int("WATERLOG_MAX_UPLOAD_MB", 8))
    #: Longest image side processed. Larger inputs are downscaled first.
    max_side: int = field(default_factory=lambda: _int("WATERLOG_MAX_SIDE", 1600))
    frontend_dir: Path = field(default_factory=lambda: Path(
        _env("WATERLOG_FRONTEND_DIR", str(REPO_ROOT / "public"))))

    def public(self) -> dict:
        return {
            "conf_threshold": self.conf_threshold,
            "alert_coverage_pct": self.alert_coverage_pct,
            "max_upload_mb": self.max_upload_mb,
        }


settings = Settings()
