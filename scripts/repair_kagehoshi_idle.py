#!/usr/bin/env python3
"""Rebuild Kagehoshi side-idle cells without changing front or rear poses."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

from process_rasetsu_sprites import alpha_bbox, load_sprite_source


CELL_SIZE = 128
PADDING = 4


def normalize_side_pose(source: Path) -> Image.Image:
    image = load_sprite_source(source)
    trimmed = image.crop(alpha_bbox(image))
    scale = min(
        (CELL_SIZE - PADDING * 2) / trimmed.width,
        (CELL_SIZE - PADDING * 2) / trimmed.height,
    )
    width = max(1, round(trimmed.width * scale))
    height = max(1, round(trimmed.height * scale))
    resized = trimmed.resize((width, height), Image.Resampling.LANCZOS)
    cell = Image.new("RGBA", (CELL_SIZE, CELL_SIZE), (0, 0, 0, 0))
    cell.alpha_composite(
        resized,
        ((CELL_SIZE - width) // 2, CELL_SIZE - PADDING - height),
    )
    return cell


def validate_side_pose(cell: Image.Image, label: str) -> None:
    left, top, right, bottom = alpha_bbox(cell)
    if min(left, top) < PADDING or max(right, bottom) > CELL_SIZE - PADDING:
        raise ValueError(f"{label} pose does not fit the safe cell padding")
    if bottom != CELL_SIZE - PADDING:
        raise ValueError(f"{label} pose is not grounded")

    # A stationary pose must have visible sole contact on both sides of the body.
    contact = cell.getchannel("A").crop(
        (0, CELL_SIZE - PADDING - 3, CELL_SIZE, CELL_SIZE - PADDING)
    )
    midpoint = CELL_SIZE // 2
    left_contact = sum(contact.crop((0, 0, midpoint, 3)).histogram()[32:])
    right_contact = sum(contact.crop((midpoint, 0, CELL_SIZE, 3)).histogram()[32:])
    if min(left_contact, right_contact) < 3:
        raise ValueError(f"{label} pose does not plant both feet")


def rebuild(base: Image.Image, side_source: Path) -> Image.Image:
    if base.size != (CELL_SIZE * 4, CELL_SIZE):
        raise ValueError("base idle sheet must be a normalized 4x1 grid")

    left = normalize_side_pose(side_source)
    right = ImageOps.mirror(left)
    validate_side_pose(left, "left")
    validate_side_pose(right, "right")

    sheet = Image.new("RGBA", base.size, (0, 0, 0, 0))
    for column in (0, 1):
        frame = base.crop(
            (column * CELL_SIZE, 0, (column + 1) * CELL_SIZE, CELL_SIZE)
        )
        sheet.alpha_composite(frame, (column * CELL_SIZE, 0))
    sheet.alpha_composite(left, (CELL_SIZE * 2, 0))
    sheet.alpha_composite(right, (CELL_SIZE * 3, 0))

    for column in (0, 1):
        original = base.crop(
            (column * CELL_SIZE, 0, (column + 1) * CELL_SIZE, CELL_SIZE)
        )
        repaired = sheet.crop(
            (column * CELL_SIZE, 0, (column + 1) * CELL_SIZE, CELL_SIZE)
        )
        if ImageChops.difference(original, repaired).getbbox() is not None:
            raise ValueError("front/rear idle frames changed unexpectedly")
    return sheet


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-idle", type=Path, required=True)
    parser.add_argument("--side-source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    with Image.open(args.base_idle) as image:
        repaired = rebuild(image.convert("RGBA"), args.side_source)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    repaired.save(args.out, optimize=True)
    print(args.out)


if __name__ == "__main__":
    main()
