import pytest

from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Piece, Position


@pytest.fixture
def game():
    instance = Game()
    instance.board.pieces.clear()
    instance.pieces.clear()
    return instance


def add_piece(game, piece_id, owner, piece_type, position):
    piece = Piece(
        id=piece_id,
        owner=owner,
        piece_type=piece_type,
        position=position,
    )
    game.board.add_piece(piece)
    game.pieces[piece_id] = piece
    return piece


def test_explorer_can_move_one_square_diagonally(game):
    explorer = add_piece(
        game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )

    game.move_piece("explorer", Position(3, 3), special="diagonal")

    assert explorer.position == Position(3, 3)


def test_explorer_can_jump_two_squares_straight(game):
    explorer = add_piece(
        game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )

    game.move_piece("explorer", Position(4, 2), special="double_jump")

    assert explorer.position == Position(4, 2)


def test_explorer_cannot_jump_over_an_occupied_square(game):
    add_piece(
        game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )
    add_piece(
        game,
        "blocker",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(3, 2),
    )

    with pytest.raises(ValueError):
        game.move_piece("explorer", Position(4, 2), special="jump")


def test_non_explorer_cannot_use_special_move(game):
    add_piece(
        game,
        "vanguard",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(2, 2),
    )

    with pytest.raises(ValueError):
        game.move_piece("vanguard", Position(3, 3), special="diagonal")


def test_explorer_cannot_move_diagonally_without_special(game):
    add_piece(
        game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )

    with pytest.raises(ValueError):
        game.move_piece("explorer", Position(3, 3))


def test_explorer_special_move_uses_all_remaining_movement(game):
    explorer = add_piece(
        game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )

    game.move_piece("explorer", Position(3, 3), special="diagonal")

    assert game.movement_spent["explorer"] == explorer.movement_points
