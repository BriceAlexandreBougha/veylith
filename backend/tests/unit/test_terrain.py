from veylith.domain.enums import TerrainMode
from veylith.domain.terrain import generate_terrain


def test_random_terrain_is_variable_balanced_and_traversable():
    heights = generate_terrain(seed=42)

    assert len(heights) == 10
    assert all(len(row) == 10 for row in heights)
    assert len({height for row in heights for height in row}) > 1
    for row in range(10):
        for col in range(10):
            assert 0 <= heights[row][col] <= 5
            assert heights[row][col] == heights[9 - row][9 - col]
            for next_row, next_col in ((row + 1, col), (row, col + 1)):
                if next_row < 10 and next_col < 10:
                    assert abs(heights[row][col] - heights[next_row][next_col]) <= 2


def test_each_terrain_mode_generates_a_valid_height_map():
    for mode in TerrainMode:
        heights = generate_terrain(mode=mode, seed=7)

        assert len(heights) == 10
        assert all(len(row) == 10 for row in heights)
        assert all(0 <= height <= 5 for row in heights for height in row)
        assert all(
            heights[row][col] == heights[9 - row][9 - col]
            for row in range(10)
            for col in range(10)
        )
        assert all(
            abs(heights[row][col] - heights[next_row][next_col]) <= 2
            for row in range(10)
            for col in range(10)
            for next_row, next_col in ((row + 1, col), (row, col + 1))
            if next_row < 10 and next_col < 10
        )
