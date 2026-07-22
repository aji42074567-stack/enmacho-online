#!/usr/bin/env python3
"""Normalize chroma-keyed Rasetsu sheets to the game's fixed sprite cells."""

from __future__ import annotations

import argparse
from pathlib import Path
from statistics import median

from PIL import Image


def _smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def remove_green_chroma(image: Image.Image) -> Image.Image:
    """Turn a green border background into a soft alpha matte with despill."""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    patch = max(1, min(width, height, 12))
    pixels = rgba.load()
    samples: list[tuple[int, int, int]] = []
    for left, top in ((0, 0), (width - patch, 0), (0, height - patch),
                      (width - patch, height - patch)):
        for y in range(top, top + patch):
            for x in range(left, left + patch):
                samples.append(pixels[x, y][:3])
    key = tuple(round(median(sample[channel] for sample in samples)) for channel in range(3))
    if key[1] - max(key[0], key[2]) < 40:
        return rgba

    for y in range(height):
        for x in range(width):
            red, green, blue, source_alpha = pixels[x, y]
            distance = max(abs(red - key[0]), abs(green - key[1]), abs(blue - key[2]))
            non_green = max(red, blue)
            dominance = green - non_green
            key_like = distance <= 32 or dominance >= 16
            if not key_like:
                continue

            if distance <= 12:
                distance_alpha = 0
            elif distance >= 96:
                distance_alpha = 255
            else:
                distance_alpha = round(255 * _smoothstep((distance - 12) / 84))
            denominator = max(1, key[1] - non_green)
            dominance_alpha = round(255 * (1 - min(1, max(0, dominance) / denominator)))
            alpha = round(min(distance_alpha, dominance_alpha) * source_alpha / 255)
            if alpha <= 8:
                pixels[x, y] = (0, 0, 0, 0)
                continue
            if alpha < 252:
                green = min(green, max(0, non_green - 1))
            pixels[x, y] = (red, green, blue, alpha)
    return rgba


def load_sprite_source(source: Path) -> Image.Image:
    with Image.open(source) as image:
        return remove_green_chroma(image)


def split_grid(image: Image.Image, columns: int, rows: int) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for row in range(rows):
        top = round(row * image.height / rows)
        bottom = round((row + 1) * image.height / rows)
        for column in range(columns):
            left = round(column * image.width / columns)
            right = round((column + 1) * image.width / columns)
            frames.append(image.crop((left, top, right, bottom)))
    return frames


def _occupied_bands(projection: list[int], empty_limit: int) -> list[tuple[int, int]]:
    """Return half-open content bands separated by nearly empty gutters."""
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for index, coverage in enumerate(projection + [0]):
        if coverage > empty_limit and start is None:
            start = index
        elif coverage <= empty_limit and start is not None:
            bands.append((start, index))
            start = None
    return bands


def split_irregular_grid(image: Image.Image, columns: int, rows: int) -> list[Image.Image]:
    """Split a layout whose rows and columns are separated by transparent gutters."""
    alpha = image.getchannel("A")
    row_projection = [
        sum(alpha.crop((0, y, image.width, y + 1)).histogram()[25:])
        for y in range(image.height)
    ]
    row_bands = _occupied_bands(row_projection, empty_limit=3)
    if len(row_bands) != rows:
        raise ValueError(f"expected {rows} sprite rows, found {len(row_bands)}")

    frames: list[Image.Image] = []
    for top, bottom in row_bands:
        column_projection = [
            sum(alpha.crop((x, top, x + 1, bottom)).histogram()[25:])
            for x in range(image.width)
        ]
        column_bands = _occupied_bands(column_projection, empty_limit=2)
        if len(column_bands) != columns:
            raise ValueError(
                f"expected {columns} sprite columns, found {len(column_bands)}"
            )
        frames.extend(image.crop((left, top, right, bottom)) for left, right in column_bands)
    return frames


def alpha_bbox(frame: Image.Image) -> tuple[int, int, int, int]:
    bbox = frame.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("sprite frame contains no opaque pixels")
    return bbox


def split_pair_at_alpha_valley(image: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Split two unevenly sized poses at the empty column nearest the center."""
    alpha = image.getchannel("A")
    low = round(image.width * 0.35)
    high = round(image.width * 0.65)
    column_coverage = []
    for x in range(low, high):
        column = alpha.crop((x, 0, x + 1, image.height))
        column_coverage.append((column.getbbox() is not None, x))
    empty = [x for occupied, x in column_coverage if not occupied]
    separator = min(empty, key=lambda x: abs(x - image.width / 2)) if empty else image.width // 2
    return image.crop((0, 0, separator, image.height)), image.crop(
        (separator, 0, image.width, image.height)
    )


def normalize_grid(
    source: Path,
    columns: int,
    rows: int,
    cell_size: int,
    padding: int,
) -> Image.Image:
    image = load_sprite_source(source)
    frames = split_grid(image, columns, rows)
    return normalize_frames(frames, columns, rows, cell_size, padding)


def normalize_irregular_grid(
    source: Path,
    columns: int,
    rows: int,
    cell_size: int,
    padding: int,
) -> Image.Image:
    image = load_sprite_source(source)
    frames = split_irregular_grid(image, columns, rows)
    return normalize_frames(frames, columns, rows, cell_size, padding)


def normalize_frames(
    frames: list[Image.Image],
    columns: int,
    rows: int,
    cell_size: int,
    padding: int,
) -> Image.Image:
    bboxes = [alpha_bbox(frame) for frame in frames]
    max_width = max(box[2] - box[0] for box in bboxes)
    max_height = max(box[3] - box[1] for box in bboxes)
    scale = min(
        (cell_size - padding * 2) / max_width,
        (cell_size - padding * 2) / max_height,
    )

    sheet = Image.new("RGBA", (columns * cell_size, rows * cell_size), (0, 0, 0, 0))
    for index, (frame, bbox) in enumerate(zip(frames, bboxes, strict=True)):
        trimmed = frame.crop(bbox)
        width = max(1, round(trimmed.width * scale))
        height = max(1, round(trimmed.height * scale))
        resized = trimmed.resize((width, height), Image.Resampling.LANCZOS)
        column = index % columns
        row = index // columns
        x = column * cell_size + (cell_size - width) // 2
        y = row * cell_size + cell_size - padding - height
        sheet.alpha_composite(resized, (x, y))
    return sheet


def stand_from_walk(walk: Image.Image, cell_size: int = 128) -> Image.Image:
    """Build one idle frame per direction from a normalized 4x4 walk sheet."""
    if walk.size != (cell_size * 4, cell_size * 4):
        raise ValueError("walk sheet must be a normalized 4x4 grid")
    sheet = Image.new("RGBA", (cell_size * 4, cell_size), (0, 0, 0, 0))
    # The first walking frame has the most neutral weight distribution in the
    # supplied Rasetsu sheets. Rows and idle columns both use down/up/left/right.
    for row in range(4):
        frame = walk.crop((0, row * cell_size, cell_size, (row + 1) * cell_size))
        sheet.alpha_composite(frame, (row * cell_size, 0))
    return sheet


def save(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, optimize=True)
    print(destination)


def main() -> None:
    parser = argparse.ArgumentParser()
    stand_group = parser.add_mutually_exclusive_group(required=True)
    stand_group.add_argument("--stand", type=Path)
    stand_group.add_argument("--stand-from-walk", action="store_true")
    parser.add_argument("--walk", type=Path, required=True)
    parser.add_argument("--walk-irregular-grid", action="store_true")
    parser.add_argument("--attack", type=Path, required=True)
    parser.add_argument("--attack-irregular-grid", action="store_true")
    parser.add_argument("--hitdeath", type=Path)
    parser.add_argument("--hit", type=Path)
    parser.add_argument("--death", type=Path)
    parser.add_argument("--gender", choices=("m", "f"), default="m")
    parser.add_argument("--out-dir", type=Path, required=True)
    # 職ごとの出力名(例: char_kagehoshi)。既定は従来どおり羅刹
    parser.add_argument("--prefix", default="char_rasetsu")
    args = parser.parse_args()
    if not args.hitdeath and not (args.hit and args.death):
        parser.error("use --hitdeath or both --hit and --death")
    if args.hitdeath and (args.hit or args.death):
        parser.error("--hitdeath cannot be combined with --hit or --death")
    prefix = f"{args.prefix}_{args.gender}"

    walk_normalizer = (
        normalize_irregular_grid if args.walk_irregular_grid else normalize_grid
    )
    walk = walk_normalizer(args.walk, columns=4, rows=4, cell_size=128, padding=4)
    if args.stand_from_walk:
        stand = stand_from_walk(walk)
    else:
        stand = normalize_grid(args.stand, columns=4, rows=1, cell_size=128, padding=4)
    save(stand, args.out_dir / f"{prefix}.png")
    save(walk, args.out_dir / f"{prefix}_walk.png")
    attack_normalizer = (
        normalize_irregular_grid if args.attack_irregular_grid else normalize_grid
    )
    save(
        attack_normalizer(args.attack, columns=3, rows=4, cell_size=160, padding=6),
        args.out_dir / f"{prefix}_attack.png",
    )

    temporary = args.out_dir / ".rasetsu-frame.png"
    try:
        if args.hitdeath:
            hitdeath = load_sprite_source(args.hitdeath)
            hit_frame, death_frame = split_pair_at_alpha_valley(hitdeath)
        else:
            hit_frame = load_sprite_source(args.hit)
            death_frame = load_sprite_source(args.death)
        hit_frame.save(temporary)
        save(
            normalize_grid(temporary, columns=1, rows=1, cell_size=128, padding=4),
            args.out_dir / f"{prefix}_hit.png",
        )
        death_frame.save(temporary)
        save(
            normalize_grid(temporary, columns=1, rows=1, cell_size=128, padding=4),
            args.out_dir / f"{prefix}_death.png",
        )
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
