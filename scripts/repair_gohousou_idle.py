#!/usr/bin/env python3
"""Rebuild Gohousou side-idle cells from a grounded stationary pose."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageOps

from process_rasetsu_sprites import alpha_bbox, load_sprite_source


CELL_SIZE = 128
PADDING = 4
VISIBLE_ALPHA = 8


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


def visible_components(cell: Image.Image) -> int:
    alpha = cell.getchannel("A")
    pixels = alpha.load()
    seen: set[tuple[int, int]] = set()
    components = 0
    for y in range(CELL_SIZE):
        for x in range(CELL_SIZE):
            if pixels[x, y] < VISIBLE_ALPHA or (x, y) in seen:
                continue
            components += 1
            stack = [(x, y)]
            seen.add((x, y))
            while stack:
                px, py = stack.pop()
                for nx in range(max(0, px - 1), min(CELL_SIZE, px + 2)):
                    for ny in range(max(0, py - 1), min(CELL_SIZE, py + 2)):
                        if (
                            pixels[nx, ny] >= VISIBLE_ALPHA
                            and (nx, ny) not in seen
                        ):
                            seen.add((nx, ny))
                            stack.append((nx, ny))
    return components


def validate_side_pose(cell: Image.Image, label: str) -> None:
    left, top, right, bottom = alpha_bbox(cell)
    if min(left, top) < PADDING or max(right, bottom) > CELL_SIZE - PADDING:
        raise ValueError(f"{label} pose does not fit the safe cell padding")
    if bottom != CELL_SIZE - PADDING:
        raise ValueError(f"{label} pose is not grounded")
    if visible_components(cell) != 1:
        raise ValueError(f"{label} pose contains a detached visible fragment")


def rebuild(base: Image.Image, side_source: Path) -> Image.Image:
    if base.size != (CELL_SIZE * 4, CELL_SIZE):
        raise ValueError("base idle sheet must be a normalized 4x1 grid")

    left = normalize_side_pose(side_source)
    right = ImageOps.mirror(left)
    validate_side_pose(left, "left")
    validate_side_pose(right, "right")

    sheet = base.copy()
    sheet.paste(left, (CELL_SIZE * 2, 0))
    sheet.paste(right, (CELL_SIZE * 3, 0))

    for column in (0, 1):
        box = (column * CELL_SIZE, 0, (column + 1) * CELL_SIZE, CELL_SIZE)
        if ImageChops.difference(base.crop(box), sheet.crop(box)).getbbox() is not None:
            raise ValueError("front/rear idle frames changed unexpectedly")

    mirrored_right = ImageOps.mirror(sheet.crop((CELL_SIZE * 3, 0, CELL_SIZE * 4, CELL_SIZE)))
    if ImageChops.difference(left, mirrored_right).getbbox() is not None:
        raise ValueError("right idle pose is not an exact full-body mirror")
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
