#!/usr/bin/env python3
"""Rebuild Jugonshi idle and side-walk sprites from reviewed source strips."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops

from assemble_walk_sheet import (
    mirrored_direction,
    normalized_row,
    opposite_leg_cycle,
    validate_grounding,
)
from process_rasetsu_sprites import alpha_bbox


CELL_SIZE = 128
PADDING = 4


def crop_row(sheet: Image.Image, row: int) -> list[Image.Image]:
    return [
        sheet.crop(
            (
                column * CELL_SIZE,
                row * CELL_SIZE,
                (column + 1) * CELL_SIZE,
                (row + 1) * CELL_SIZE,
            )
        )
        for column in range(4)
    ]


def assemble_walk(base: Image.Image, left: list[Image.Image]) -> Image.Image:
    if base.size != (CELL_SIZE * 4, CELL_SIZE * 4):
        raise ValueError("base walk sheet must be a normalized 4x4 grid")
    right = mirrored_direction(left)
    rows = [crop_row(base, 0), crop_row(base, 1), left, right]
    sheet = Image.new(
        "RGBA", (CELL_SIZE * 4, CELL_SIZE * 4), (0, 0, 0, 0)
    )
    for row, frames in enumerate(rows):
        for column, frame in enumerate(frames):
            sheet.alpha_composite(frame, (column * CELL_SIZE, row * CELL_SIZE))
    validate_grounding(sheet, CELL_SIZE, PADDING)
    return sheet


def assemble_idle(frames: list[Image.Image]) -> Image.Image:
    sheet = Image.new("RGBA", (CELL_SIZE * 4, CELL_SIZE), (0, 0, 0, 0))
    for column, frame in enumerate(frames):
        sheet.alpha_composite(frame, (column * CELL_SIZE, 0))
        if alpha_bbox(frame)[3] != CELL_SIZE - PADDING:
            raise ValueError(f"idle frame {column} is not grounded")
    return sheet


def validate_side_cycle(frames: list[Image.Image]) -> None:
    """Reject the former contact/passing/contact/same-passing two-pose loop."""
    passing_difference = ImageChops.difference(
        frames[1].getchannel("A"), frames[3].getchannel("A")
    )
    changed_pixels = sum(
        1 for value in passing_difference.get_flattened_data() if value
    )
    if changed_pixels < 200:
        raise ValueError(
            "side passing frames are too similar to read as opposite legs"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-walk", type=Path, required=True)
    parser.add_argument("--side-source", type=Path, required=True)
    parser.add_argument("--idle-source", type=Path, required=True)
    parser.add_argument("--walk-out", type=Path, required=True)
    parser.add_argument("--idle-out", type=Path, required=True)
    parser.add_argument("--leg-cut-ratio", type=float, default=0.62)
    parser.add_argument("--leg-feather", type=int, default=2)
    parser.add_argument("--leg-mask-half-width", type=int)
    args = parser.parse_args()

    base = Image.open(args.base_walk).convert("RGBA")
    side = normalized_row(
        args.side_source, cell_size=CELL_SIZE, padding=PADDING
    )
    side = opposite_leg_cycle(
        side,
        cut_ratio=args.leg_cut_ratio,
        feather=args.leg_feather,
        mask_half_width=args.leg_mask_half_width,
    )
    validate_side_cycle(side)
    walk = assemble_walk(base, side)

    idle_frames = normalized_row(
        args.idle_source, cell_size=CELL_SIZE, padding=PADDING
    )
    idle = assemble_idle(idle_frames)

    args.walk_out.parent.mkdir(parents=True, exist_ok=True)
    args.idle_out.parent.mkdir(parents=True, exist_ok=True)
    walk.save(args.walk_out, optimize=True)
    idle.save(args.idle_out, optimize=True)
    print(args.walk_out)
    print(args.idle_out)


if __name__ == "__main__":
    main()
