"""Balanced, traversable height maps for new Traversal games."""

from __future__ import annotations

import math
import random

from veylith.domain.enums import TerrainMode

MIN_HEIGHT = 0
MAX_HEIGHT = 5
MAX_ADJACENT_HEIGHT_DELTA = 2


def generate_terrain(
    mode: TerrainMode = TerrainMode.RANDOM,
    size: int = 10,
    seed: int | None = None,
) -> list[list[int]]:
    """Generate a 180-degree symmetric map with no untraversable cliffs."""
    if size < 2:
        raise ValueError("La taille du plateau doit être au moins de 2.")

    rng = random.Random(seed)
    if mode == TerrainMode.MOUNTAINS:
        baseline = 0.7
    elif mode == TerrainMode.VALLEYS:
        baseline = 4.2
    elif mode == TerrainMode.HIGHLANDS:
        baseline = 1.6
    elif mode == TerrainMode.WOODS:
        baseline = 1.7
    elif mode == TerrainMode.DESERT:
        baseline = 0.5
    else:
        baseline = 2.0

    centers: list[tuple[float, float, float, float]] = []
    if mode == TerrainMode.MOUNTAINS:
        centers = [(size / 2, size / 2, 2.8, max(1.7, size / 4))]
    elif mode == TerrainMode.VALLEYS:
        centers = [(size / 2, size / 2, -3.0, max(1.8, size / 4))]
    elif mode == TerrainMode.HIGHLANDS:
        centers = [
            (size * 0.35, size * 0.5, 1.8, size / 3),
            (size * 0.35, size * 0.5, -1.4, size / 5),
        ]
    elif mode == TerrainMode.WOODS:
        for _ in range(5):
            centers.append(
                (
                    rng.uniform(1, size - 2),
                    rng.uniform(1, size - 2),
                    rng.uniform(-0.9, 1.0),
                    rng.uniform(1.8, 3.2),
                )
            )
    elif mode == TerrainMode.DESERT:
        for _ in range(3):
            centers.append(
                (
                    rng.uniform(1, size - 2),
                    rng.uniform(1, size - 2),
                    rng.uniform(1.4, 2.2),
                    rng.uniform(1.2, 1.8),
                )
            )
    else:
        for _ in range(5):
            centers.append(
                (
                    rng.uniform(1, size - 2),
                    rng.uniform(1, size - 2),
                    rng.uniform(-2.0, 2.3),
                    rng.uniform(1.6, 3.1),
                )
            )

    symmetric_centers: list[tuple[float, float, float, float]] = []
    for row, col, amplitude, spread in centers:
        symmetric_centers.append((row, col, amplitude, spread))
        mirrored = (size - 1 - row, size - 1 - col, amplitude, spread)
        if (row, col) != mirrored[:2]:
            symmetric_centers.append(mirrored)

    field = [[baseline for _ in range(size)] for _ in range(size)]
    noise: dict[tuple[int, int], float] = {}
    for row in range(size):
        for col in range(size):
            position = min((row, col), (size - 1 - row, size - 1 - col))
            if position not in noise:
                noise[position] = rng.uniform(-0.45, 0.45)
            value = baseline + noise[position]
            for center_row, center_col, amplitude, spread in symmetric_centers:
                distance_squared = (row - center_row) ** 2 + (col - center_col) ** 2
                value += amplitude * math.exp(-distance_squared / (2 * spread**2))
            field[row][col] = min(MAX_HEIGHT, max(MIN_HEIGHT, round(value)))

    _enforce_symmetric_slope_limit(field)
    return field


def _enforce_symmetric_slope_limit(heights: list[list[int]]) -> None:
    size = len(heights)

    def set_height(row: int, col: int, value: int) -> None:
        heights[row][col] = value
        heights[size - 1 - row][size - 1 - col] = value

    changed = True
    while changed:
        changed = False
        for row in range(size):
            for col in range(size):
                for next_row, next_col in ((row + 1, col), (row, col + 1)):
                    if next_row >= size or next_col >= size:
                        continue
                    first = heights[row][col]
                    second = heights[next_row][next_col]
                    if first > second + MAX_ADJACENT_HEIGHT_DELTA:
                        set_height(row, col, second + MAX_ADJACENT_HEIGHT_DELTA)
                        changed = True
                    elif second > first + MAX_ADJACENT_HEIGHT_DELTA:
                        set_height(
                            next_row,
                            next_col,
                            first + MAX_ADJACENT_HEIGHT_DELTA,
                        )
                        changed = True
