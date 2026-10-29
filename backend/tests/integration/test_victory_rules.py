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


def test_explorer_exit_awards_one_point(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 2),
    )

    game.move_piece("white_explorer", Position(9, 2))
    game.exit_piece("white_explorer")

    assert game.scores[PlayerColor.WHITE] == 1


def test_vanguard_exit_awards_two_points(game):
    add_piece(
        game,
        "white_vanguard",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(8, 2),
    )

    game.move_piece("white_vanguard", Position(9, 2))
    game.exit_piece("white_vanguard")

    assert game.scores[PlayerColor.WHITE] == 2


def test_sentinel_exit_awards_three_points_and_wins(game):
    add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(8, 2),
    )

    game.move_piece("white_sentinel", Position(9, 2))
    game.exit_piece("white_sentinel")

    assert game.scores[PlayerColor.WHITE] == 3
    assert game.status == GameStatus.WHITE_WINS


def test_exited_piece_is_not_captured(game):
    sentinel = add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(8, 2),
    )

    game.move_piece("white_sentinel", Position(9, 2))
    game.exit_piece("white_sentinel")

    assert sentinel.finished is True
    assert sentinel.captured is False
    assert sentinel.position is None


def test_cannot_exit_from_wrong_row(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 2),
    )

    with pytest.raises(ValueError):
        game.exit_piece("white_explorer")


def test_second_piece_exit_ends_game(game):
    add_piece(
        game,
        "white_explorer_1",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 1),
    )
    add_piece(
        game,
        "white_explorer_2",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 3),
    )

    game.move_piece("white_explorer_1", Position(9, 1))
    game.exit_piece("white_explorer_1")

    # Le tour passe aux Noirs. On revient ensuite aux Blancs.
    add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(0, 0),
    )
    game.move_piece("black_explorer", Position(1, 0))
    game.end_turn()

    game.move_piece("white_explorer_2", Position(9, 3))
    game.exit_piece("white_explorer_2")

    assert game.scores[PlayerColor.WHITE] == 2
    assert game.status == GameStatus.WHITE_WINS
