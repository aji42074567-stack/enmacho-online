#!/usr/bin/env python3
"""Build the male Gohousou walk sheet with an eight-frame side cycle."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

from assemble_walk_sheet import (
    assemble_rows,
    mirrored_direction,
    normalized_row,
    opposite_leg_cycle,
    validate_grounding,
)


def tint_polygon(
    frame: Image.Image,
    points: list[tuple[int, int]],
    *,
    tone: str,
) -> Image.Image:
    """Retint one ankle-wrap area while retaining its painted texture."""
    result = frame.copy()
    mask = Image.new("L", frame.size, 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    source = frame.load()
    target = result.load()
    selected = mask.load()
    for y in range(frame.height):
        for x in range(frame.width):
            if not selected[x, y]:
                continue
            red, green, blue, alpha = source[x, y]
            if alpha < 16:
                continue
            luminance = round(red * 0.30 + green * 0.59 + blue * 0.11)
            if luminance < 28:  # retain the inked outline
                continue
            if tone == "brown":
                value = max(42, min(142, luminance))
                tint = (round(value * 1.08), round(value * 0.72), round(value * 0.42))
            elif tone == "white":
                value = max(125, min(232, round(luminance * 1.48)))
                tint = (value, round(value * 0.94), round(value * 0.82))
            else:
                raise ValueError(f"unknown wrap tone: {tone}")
            mix = 0.74
            target[x, y] = (
                round(red * (1 - mix) + tint[0] * mix),
                round(green * (1 - mix) + tint[1] * mix),
                round(blue * (1 - mix) + tint[2] * mix),
                alpha,
            )
    return result


def repair_far_step(frames: list[Image.Image]) -> list[Image.Image]:
    """Make the far-step contact and return frames read unambiguously."""
    if len(frames) != 4:
        raise ValueError(f"far-step strip must contain 4 frames, got {len(frames)}")
    repaired = [frame.copy() for frame in frames]
    # Frame 5: brown far leg contacts forward-left.  Do not brighten the rear
    # leg here: its wrap is partly hidden by the robe and a broad lightening
    # mask would bleach the painted hem at runtime size.
    repaired[0] = tint_polygon(
        repaired[0], [(22, 87), (47, 87), (57, 111), (47, 120), (20, 115)], tone="brown"
    )
    # Frame 8: the white near leg swings forward while the brown far leg supports.
    repaired[3] = tint_polygon(
        repaired[3], [(79, 84), (98, 84), (109, 115), (99, 123), (80, 109)], tone="brown"
    )
    return repaired


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--down", type=Path, required=True)
    parser.add_argument("--up", type=Path, required=True)
    parser.add_argument("--near-step", type=Path, required=True)
    parser.add_argument("--far-step", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cell-size", type=int, default=128)
    parser.add_argument("--padding", type=int, default=4)
    parser.add_argument("--leg-cut-ratio", type=float, default=0.55)
    parser.add_argument("--leg-feather", type=int, default=1)
    parser.add_argument("--leg-mask-half-width", type=int, default=18)
    args = parser.parse_args()

    def normalize(source: Path) -> list[Image.Image]:
        return normalized_row(
            source, frame_count=4, cell_size=args.cell_size, padding=args.padding
        )

    down = opposite_leg_cycle(
        normalize(args.down),
        cut_ratio=args.leg_cut_ratio,
        feather=args.leg_feather,
        mask_half_width=args.leg_mask_half_width,
    )
    up = opposite_leg_cycle(
        normalize(args.up),
        cut_ratio=args.leg_cut_ratio,
        feather=args.leg_feather,
        mask_half_width=args.leg_mask_half_width,
    )
    left = normalize(args.near_step) + repair_far_step(normalize(args.far_step))
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
