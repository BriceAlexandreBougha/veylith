# tests/unit/test_board.py

import pytest

from veylith.domain.board import Board
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position


def make_piece(
    piece_id: str = "white_explorer_1",
    position: Position | None = None,
) -> Piece:
    if position is None:
        position = Position(0, 4)

    return Piece(
        id=piece_id,
        owner=PlayerColor.WHITE,
        piece_type=PieceType.EXPLORER,
        position=position,
    )


def test_board_is_10_by_10() -> None:
    board = Board()

    assert board.size == 10
    assert len(board.heights) == 10
    assert all(len(row) == 10 for row in board.heights)


def test_initial_heights_are_zero() -> None:
    board = Board()

    for row in board.heights:
        assert all(height == 0 for height in row)


@pytest.mark.parametrize(
    ("position", "expected"),
    [
        (Position(0, 0), True),
        (Position(9, 9), True),
        (Position(0, 10), False),
        (Position(-1, 0), False),
        (Position(10, 0), False),
    ],
)
def test_position_validity(
    position: Position,
    expected: bool,
) -> None:
    board = Board()

    assert board.is_valid_position(position) is expected


def test_add_and_find_piece() -> None:
    board = Board()
    piece = make_piece()

    board.add_piece(piece)

    assert board.piece_at(Position(0, 4)) is piece


def test_cannot_place_two_pieces_on_same_square() -> None:
    board = Board()
    board.add_piece(make_piece())

    with pytest.raises(ValueError):
        board.add_piece(
            make_piece(
                piece_id="white_vanguard_1",
                position=Position(0, 4),
            )
        )


def test_move_piece() -> None:
    board = Board()
    board.add_piece(make_piece())

    board.move_piece("white_explorer_1", Position(1, 4))

    assert board.piece_at(Position(0, 4)) is None
    assert board.piece_at(Position(1, 4)) is not None


def test_cannot_move_to_occupied_square() -> None:
    board = Board()
    board.add_piece(make_piece())
    board.add_piece(make_piece("white_vanguard_1", Position(1, 4)))

    with pytest.raises(ValueError):
        board.move_piece("white_explorer_1", Position(1, 4))


def test_remove_piece() -> None:
    board = Board()
    board.add_piece(make_piece())

    removed = board.remove_piece("white_explorer_1")

    assert removed.captured is True
    assert removed.position is None
    assert board.piece_at(Position(0, 4)) is None


def test_set_and_get_height() -> None:
    board = Board()
    position = Position(3, 5)

    board.set_height(position, 2)

    assert board.get_height(position) == 2


def test_invalid_height_position_raises_error() -> None:
    board = Board()

    with pytest.raises(ValueError):
        board.get_height(Position(10, 0))
