#!/usr/bin/env python3
"""Crop an RGBA sprite to its alpha bounds and restore uniform transparent padding."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--padding", type=int, default=64)
    parser.add_argument("--max-edge", type=int, default=1024)
    args = parser.parse_args()

    image = Image.open(args.input).convert("RGBA")
    alpha_mask = image.getchannel("A").point(lambda value: 255 if value > 8 else 0)
    bbox = alpha_mask.getbbox()
    if bbox is None:
        raise SystemExit("asset has no visible pixels")

    subject = image.crop(bbox)
    canvas = Image.new(
        "RGBA",
        (subject.width + args.padding * 2, subject.height + args.padding * 2),
        (0, 0, 0, 0),
    )
    canvas.alpha_composite(subject, (args.padding, args.padding))

    longest = max(canvas.size)
    if longest > args.max_edge:
        scale = args.max_edge / longest
        size = (max(1, round(canvas.width * scale)), max(1, round(canvas.height * scale)))
        canvas = canvas.resize(size, Image.Resampling.LANCZOS)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_name(f".{args.output.name}.normalize.tmp")
    canvas.save(temp, format="PNG", optimize=True)
    temp.replace(args.output)
    print(f"Wrote {args.output} ({canvas.width}x{canvas.height}) from alpha bbox {bbox}")


if __name__ == "__main__":
    main()
