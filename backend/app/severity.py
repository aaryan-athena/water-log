"""Coverage % and plain-language severity bands.

Coverage is the UNION of water masks over the frame, so overlapping
instances never push it past 100%.
"""
from __future__ import annotations

import numpy as np

WATER_SYNONYMS = {
    "water", "waterlogging", "water-logging", "water_logging", "waterlogged",
    "puddle", "puddles", "flood", "flooded", "flooded-road", "flooding",
    "standing-water", "stagnant-water",
}

#: (upper bound on coverage %, label, hex colour), ascending.
SEVERITY_BANDS = (
    (2.0, "none", "#2f9e6b"),
    (8.0, "minor", "#d4a72c"),
    (20.0, "moderate", "#e07b39"),
    (40.0, "severe", "#d64545"),
    (100.0, "critical", "#9b2c5a"),
)


def is_water_class(name: str) -> bool:
    return str(name).strip().lower().replace(" ", "-") in WATER_SYNONYMS


def severity_band(coverage_pct: float) -> tuple:
    for upper, label, colour in SEVERITY_BANDS:
        if coverage_pct <= upper:
            return label, colour
    return SEVERITY_BANDS[-1][1], SEVERITY_BANDS[-1][2]


def union_mask(instances: list, height: int, width: int) -> np.ndarray:
    union = np.zeros((height, width), dtype=bool)
    for inst in instances:
        if is_water_class(inst.class_name):
            union |= inst.mask
    return union


def summarise(instances: list, union: np.ndarray) -> dict:
    water = [i for i in instances if is_water_class(i.class_name)]
    coverage = 100.0 * float(union.mean()) if union.size else 0.0
    label, colour = severity_band(coverage)
    return {
        "coverage_pct": round(coverage, 2),
        "severity": label,
        "severity_colour": colour,
        "max_confidence": round(max((i.confidence for i in water), default=0.0), 4),
        "water_regions": len(water),
    }
