import pytest

from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Piece, Position
from veylith.domain.victory import GameStatus


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


def test_cannot_move_opponents_piece(game):
    add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(7, 2),
    )

    with pytest.raises(ValueError):
        game.move_piece("black_explorer", Position(6, 2))


def test_cannot_move_piece_after_spending_all_movement_points(game):
    explorer = add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(2, 2),
    )

    # L'explorateur dispose de 5 points.
    # Ce déplacement spécial consomme tous les points du tour.
    game.move_piece(
        "white_explorer",
        Position(3, 3),
        special="diagonal",
    )

    assert game.movement_spent["white_explorer"] == explorer.movement_points

    with pytest.raises(ValueError):
        game.move_piece("white_explorer", Position(3, 4))


def test_cannot_move_after_turn_has_ended(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 2),
    )

    game.move_piece("white_explorer", Position(7, 2))
    game.end_turn()

    with pytest.raises(ValueError):
        game.move_piece("white_explorer", Position(8, 3))


def test_cannot_move_same_piece_back_to_a_visited_position(game):
    add_piece(
        game,
        "white_vanguard",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(4, 4),
    )

    game.move_piece("white_vanguard", Position(4, 5))

    with pytest.raises(ValueError):
        game.move_piece("white_vanguard", Position(4, 4))


def test_cannot_make_actions_after_game_ends(game):
    add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(8, 4),
    )

    game.move_piece("white_sentinel", Position(9, 4))
    game.exit_piece("white_sentinel")

    assert game.status == GameStatus.WHITE_WINS

    with pytest.raises(ValueError):
        game.move_piece("white_sentinel", Position(8, 4))
