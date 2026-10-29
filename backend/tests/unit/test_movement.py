import pytest

from veylith.domain.board import Board
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position
from veylith.domain.movement import get_reachable_paths


@pytest.fixture
def board():
    return Board()


@pytest.fixture
def explorer():
    return Piece(
        id="explorer_1",
        owner=PlayerColor.WHITE,
        piece_type=PieceType.EXPLORER,
        position=Position(4, 4),
    )


@pytest.fixture
def vanguard():
    return Piece(
        id="vanguard_1",
        owner=PlayerColor.WHITE,
        piece_type=PieceType.VANGUARD,
        position=Position(4, 4),
    )


@pytest.fixture
def another_piece():
    return Piece(
        id="blocker",
        owner=PlayerColor.BLACK,
        piece_type=PieceType.EXPLORER,
        position=Position(3, 4),
    )


def test_explorer_can_move_diagonally(explorer, board):
    start = Position(4, 4)
    destination = Position(3, 3)

    paths = get_reachable_paths(board, explorer, start, 5)

    assert any(
        p.destination == destination and p.special == "diagonal" for p in paths
    ), [
        (p.destination, p.path, p.cost, p.special)
        for p in paths
        if p.destination == destination
    ]


def test_explorer_can_turn_cardinally_into_a_square_diagonal_from_start(
    explorer, board
):
    start = Position(4, 4)
    destination = Position(3, 5)

    paths = get_reachable_paths(board, explorer, start, 5)

    assert any(
        path.destination == destination and path.cost == 2 and path.special is None
        for path in paths
    )


def test_explorer_can_double_jump_over_empty_square(explorer, board):
    start = Position(4, 4)
    destination = Position(2, 4)

    paths = get_reachable_paths(board, explorer, start, 5)

    assert any(
        p.destination == destination
        and p.special == "double_jump"
        and p.path == (Position(3, 4), destination)
        for p in paths
    )


def test_explorer_cannot_double_jump_over_piece(explorer, board, another_piece):
    start = Position(4, 4)
    destination = Position(2, 4)

    board.add_piece(another_piece)

    paths = get_reachable_paths(board, explorer, start, 5)

    assert not any(
        p.destination == destination and p.special == "double_jump" for p in paths
    )


def test_explorer_can_combine_normal_steps_before_special_move(explorer, board):
    paths = get_reachable_paths(board, explorer, Position(4, 4), 5)

    assert any(p.special is not None and len(p.path) > 1 for p in paths)


def test_non_explorer_cannot_use_special_moves(vanguard, board):
    paths = get_reachable_paths(board, vanguard, Position(4, 4), 4)

    assert all(p.special is None for p in paths)
