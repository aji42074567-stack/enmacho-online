#!/usr/bin/env python3
"""Validate one or more individual transparent sprites for the Rinne continent."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def validate(path: Path, minimum_margin: int) -> tuple[dict[str, object], list[str]]:
    image = Image.open(path).convert("RGBA")
    width, height = image.size
    pixels = list(image.get_flattened_data())
    alpha = [pixel[3] for pixel in pixels]
    visible = [index for index, value in enumerate(alpha) if value > 8]
    errors: list[str] = []

    if not visible:
        return {"file": str(path), "size": [width, height]}, ["no visible pixels"]

    xs = [index % width for index in visible]
    ys = [index // width for index in visible]
    bbox = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
    margins = [bbox[0], bbox[1], width - bbox[2], height - bbox[3]]
    border_alpha = []
    border_alpha.extend(alpha[:width])
    border_alpha.extend(alpha[(height - 1) * width :])
    border_alpha.extend(alpha[row * width] for row in range(height))
    border_alpha.extend(alpha[row * width + width - 1] for row in range(height))

    opaque = sum(value >= 250 for value in alpha)
    partial = sum(0 < value < 250 for value in alpha)
    coverage = len(visible) / (width * height)
    magenta_residue = sum(
        1
        for red, green, blue, value in pixels
        if value > 32 and red > 170 and blue > 170 and green < 115
    )

    if image.mode != "RGBA":
        errors.append("asset is not RGBA")
    if max(border_alpha) > 0:
        errors.append("visible pixels touch the canvas edge")
    if min(margins) < minimum_margin:
        errors.append(f"minimum transparent margin is {min(margins)}px; expected {minimum_margin}px")
    if not 0.05 <= coverage <= 0.75:
        errors.append(f"visible coverage {coverage:.3f} is outside 0.05..0.75")
    if partial == 0:
        errors.append("no partially transparent edge pixels")
    if magenta_residue > max(24, len(visible) * 0.0002):
        errors.append(f"possible chroma residue: {magenta_residue} pixels")

    report: dict[str, object] = {
        "file": str(path),
        "size": [width, height],
        "alpha_bbox": bbox,
        "margins": margins,
        "visible_coverage": round(coverage, 4),
        "opaque_pixels": opaque,
        "partial_alpha_pixels": partial,
        "magenta_residue_pixels": magenta_residue,
        "status": "PASS" if not errors else "FAIL",
    }
    return report, errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("assets", nargs="+", type=Path)
    parser.add_argument("--minimum-margin", type=int, default=48)
    args = parser.parse_args()

    failed = False
    for path in args.assets:
        report, errors = validate(path, args.minimum_margin)
        if errors:
            report["errors"] = errors
            failed = True
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
