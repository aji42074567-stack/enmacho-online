#!/usr/bin/env python3
"""Sharpen the Gohousou male idle sheet without changing its silhouette."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter, PngImagePlugin


EXPECTED_SIZE = (512, 128)
CELL_SIZE = 128
DEFAULT_RADIUS = 0.8
DEFAULT_PERCENT = 150
DEFAULT_THRESHOLD = 2
MARKER_KEY = "enmacho_idle_sharpen"


def marker(radius: float, percent: int, threshold: int) -> str:
    return f"unsharp:r={radius}:p={percent}:t={threshold}:alpha-preserved"


def alpha_bboxes(image: Image.Image) -> list[tuple[int, int, int, int] | None]:
    alpha = image.getchannel("A")
    return [
        alpha.crop((x, 0, x + CELL_SIZE, CELL_SIZE)).getbbox()
        for x in range(0, EXPECTED_SIZE[0], CELL_SIZE)
    ]


def sharpen_idle(
    source: Image.Image,
    *,
    radius: float,
    percent: int,
    threshold: int,
) -> Image.Image:
    if source.size != EXPECTED_SIZE:
        raise ValueError(f"idle sheet must be {EXPECTED_SIZE[0]}x{EXPECTED_SIZE[1]}")

    original_alpha = source.getchannel("A")
    original_bboxes = alpha_bboxes(source)
    sharpened = source.filter(
        ImageFilter.UnsharpMask(
            radius=radius,
            percent=percent,
            threshold=threshold,
        )
    )
    # The correction is deliberately optical only: no outline, grounding, pose,
    # or direction is allowed to change.
    sharpened.putalpha(original_alpha)

    if ImageChops.difference(original_alpha, sharpened.getchannel("A")).getbbox():
        raise ValueError("alpha channel changed during idle sharpening")
    if alpha_bboxes(sharpened) != original_bboxes:
        raise ValueError("idle pose bounds changed during sharpening")
    return sharpened


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--radius", type=float, default=DEFAULT_RADIUS)
    parser.add_argument("--percent", type=int, default=DEFAULT_PERCENT)
    parser.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    args = parser.parse_args()

    expected_marker = marker(args.radius, args.percent, args.threshold)
    with Image.open(args.input) as image:
        if image.info.get(MARKER_KEY) == expected_marker:
            if args.input.resolve() != args.out.resolve():
                args.out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(args.input, args.out)
            print(f"already sharpened: {args.out}")
            return
        source = image.convert("RGBA")

    sharpened = sharpen_idle(
        source,
        radius=args.radius,
        percent=args.percent,
        threshold=args.threshold,
    )
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text(MARKER_KEY, expected_marker)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sharpened.save(args.out, optimize=True, pnginfo=metadata)
    print(args.out)


if __name__ == "__main__":
    main()
