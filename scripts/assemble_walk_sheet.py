#!/usr/bin/env python3
"""Assemble grounded four-direction walk sheets from direction strips.

Direction strips normally contain four poses; side strips may contain eight.
Front and rear views are especially prone to repeating the same leg.  With
``--mirror-opposite-legs`` the first contact/passing pair remains untouched and
the opposite pair is built by mirroring only the lower body.  The asymmetric
upper costume and weapon therefore stay on their established side.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps

from process_rasetsu_sprites import (
    alpha_bbox,
    load_sprite_source,
    split_grid,
    split_irregular_grid,
)


def keep_largest_alpha_component(frame: Image.Image) -> Image.Image:
    """Discard neighboring-frame fragments left behind by an uneven gutter."""
    alpha = frame.getchannel("A")
    width, height = frame.size
    pixels = alpha.load()
    seen = bytearray(width * height)
    components: list[list[int]] = []
    for y in range(height):
        for x in range(width):
            index = y * width + x
            if seen[index] or pixels[x, y] == 0:
                continue
            seen[index] = 1
            stack = [index]
            component: list[int] = []
            while stack:
                current = stack.pop()
                component.append(current)
                current_x = current % width
                current_y = current // width
                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if not (0 <= next_x < width and 0 <= next_y < height):
                        continue
                    next_index = next_y * width + next_x
                    if seen[next_index] or pixels[next_x, next_y] == 0:
                        continue
                    seen[next_index] = 1
                    stack.append(next_index)
            components.append(component)
    if not components:
        raise ValueError("sprite frame contains no opaque pixels")

    keep = set(max(components, key=len))
    cleaned = Image.new("RGBA", frame.size, (0, 0, 0, 0))
    source_pixels = frame.load()
    cleaned_pixels = cleaned.load()
    for index in keep:
        x = index % width
        y = index // width
        cleaned_pixels[x, y] = source_pixels[x, y]
    return cleaned


def normalized_row(
    source: Path,
    *,
    cell_size: int,
    padding: int,
    frame_count: int = 4,
) -> list[Image.Image]:
    """Split a direction strip and ground every frame on one baseline."""
    image = load_sprite_source(source)
    try:
        # Generated strips rarely place their gutters on exact quarter points.
        # Projection-based splitting prevents a sword tip from leaking into the
        # neighboring frame.
        frames = split_irregular_grid(image, columns=frame_count, rows=1)
    except ValueError:
        frames = split_grid(image, columns=frame_count, rows=1)
    frames = [keep_largest_alpha_component(frame) for frame in frames]
    boxes = [alpha_bbox(frame) for frame in frames]
    max_width = max(right - left for left, _top, right, _bottom in boxes)
    max_height = max(bottom - top for _left, top, _right, bottom in boxes)
    scale = min(
        (cell_size - padding * 2) / max_width,
        (cell_size - padding * 2) / max_height,
    )

    result: list[Image.Image] = []
    for frame, box in zip(frames, boxes, strict=True):
        trimmed = frame.crop(box)
        width = max(1, round(trimmed.width * scale))
        height = max(1, round(trimmed.height * scale))
        resized = trimmed.resize((width, height), Image.Resampling.LANCZOS)
        cell = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
        x = (cell_size - width) // 2
        y = cell_size - padding - height
        cell.alpha_composite(resized, (x, y))
        result.append(cell)
    return result


def mirror_lower_body(
    frame: Image.Image,
    *,
    cut_ratio: float,
    feather: int,
    mask_half_width: int | None,
) -> Image.Image:
    """Swap visible legs while retaining the asymmetric torso and side props."""
    _left, top, _right, bottom = alpha_bbox(frame)
    cut = round(top + (bottom - top) * cut_ratio)
    mirrored = ImageOps.mirror(frame)
    mask = Image.new("L", frame.size, 0)
    pixels = mask.load()
    start = max(0, cut - feather)
    end = min(frame.height, cut + feather + 1)
    for y in range(start, frame.height):
        if y >= end:
            value = 255
        elif end == start:
            value = 255
        else:
            value = round(255 * (y - start) / (end - start))
        for x in range(frame.width):
            if mask_half_width is None:
                horizontal = 255
            else:
                center = frame.width // 2
                left = center - mask_half_width
                right = center + mask_half_width
                edge = max(1, feather + 1)
                if x < left - edge or x > right + edge:
                    horizontal = 0
                elif x < left + edge:
                    horizontal = round(255 * (x - (left - edge)) / (edge * 2))
                elif x > right - edge:
                    horizontal = round(255 * ((right + edge) - x) / (edge * 2))
                else:
                    horizontal = 255
                horizontal = max(0, min(255, horizontal))
            pixels[x, y] = round(value * horizontal / 255)
    return Image.composite(mirrored, frame, mask)


def opposite_leg_cycle(
    frames: list[Image.Image],
    *,
    cut_ratio: float,
    feather: int,
    mask_half_width: int | None,
) -> list[Image.Image]:
    """Return contact, passing, opposite contact, opposite passing."""
    return [
        frames[0],
        frames[1],
        mirror_lower_body(
            frames[0],
            cut_ratio=cut_ratio,
            feather=feather,
            mask_half_width=mask_half_width,
        ),
        mirror_lower_body(
            frames[1],
            cut_ratio=cut_ratio,
            feather=feather,
            mask_half_width=mask_half_width,
        ),
    ]


def mirrored_direction(frames: list[Image.Image]) -> list[Image.Image]:
    """Mirror each frame without reversing animation order."""
    return [ImageOps.mirror(frame) for frame in frames]


def assemble_rows(rows: list[list[Image.Image]], cell_size: int) -> Image.Image:
    columns = max(len(frames) for frames in rows)
    sheet = Image.new(
        "RGBA", (cell_size * columns, cell_size * len(rows)), (0, 0, 0, 0)
    )
    for row_index, frames in enumerate(rows):
        for column_index, frame in enumerate(frames):
            sheet.alpha_composite(
                frame,
                (column_index * cell_size, row_index * cell_size),
            )
    return sheet


def validate_grounding(
    sheet: Image.Image,
    cell_size: int,
    padding: int,
    frame_counts: list[int],
) -> None:
    expected_bottom = cell_size - padding
    for row, frame_count in enumerate(frame_counts):
        for column in range(frame_count):
            frame = sheet.crop(
                (
                    column * cell_size,
                    row * cell_size,
                    (column + 1) * cell_size,
                    (row + 1) * cell_size,
                )
            )
            bottom = alpha_bbox(frame)[3]
            if bottom != expected_bottom:
                raise ValueError(
                    f"frame ({row}, {column}) bottom {bottom} != {expected_bottom}"
                )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--down", type=Path, required=True)
    parser.add_argument("--up", type=Path, required=True)
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--side-frames",
        type=int,
        choices=(4, 8),
        default=4,
        help="number of frames in the left/right rows",
    )
    parser.add_argument("--cell-size", type=int, default=128)
    parser.add_argument("--padding", type=int, default=4)
    # Start above the upper thigh.  A lower cut can mirror only the feet while
    # a long coat or hakama still makes every frame read as the same lead leg.
    parser.add_argument("--leg-cut-ratio", type=float, default=0.55)
    parser.add_argument("--leg-feather", type=int, default=2)
    parser.add_argument(
        "--leg-mask-half-width",
        type=int,
        help=(
            "mirror only a centered leg band this many pixels wide on each "
            "side; keeps long staffs and side props unchanged"
        ),
    )
    parser.add_argument(
        "--mirror-opposite-legs",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    args = parser.parse_args()
    if not 0.5 <= args.leg_cut_ratio <= 0.85:
        parser.error("--leg-cut-ratio must be between 0.5 and 0.85")
    if args.leg_feather < 0:
        parser.error("--leg-feather must not be negative")
    if args.leg_mask_half_width is not None and not (
        1 <= args.leg_mask_half_width <= args.cell_size // 2
    ):
        parser.error("--leg-mask-half-width must fit inside the cell")

    down = normalized_row(
        args.down, frame_count=4, cell_size=args.cell_size, padding=args.padding
    )
    up = normalized_row(
        args.up, frame_count=4, cell_size=args.cell_size, padding=args.padding
    )
    left = normalized_row(
        args.left,
        frame_count=args.side_frames,
        cell_size=args.cell_size,
        padding=args.padding,
    )
    if args.mirror_opposite_legs:
        down = opposite_leg_cycle(
            down,
            cut_ratio=args.leg_cut_ratio,
            feather=args.leg_feather,
            mask_half_width=args.leg_mask_half_width,
        )
        up = opposite_leg_cycle(
            up,
            cut_ratio=args.leg_cut_ratio,
            feather=args.leg_feather,
            mask_half_width=args.leg_mask_half_width,
        )
    right = mirrored_direction(left)
    rows = [down, up, left, right]
    sheet = assemble_rows(rows, args.cell_size)
    validate_grounding(
        sheet, args.cell_size, args.padding, [len(frames) for frames in rows]
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out, optimize=True)
    print(args.out)


if __name__ == "__main__":
    main()
