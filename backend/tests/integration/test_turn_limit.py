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


def test_turn_limit_awards_victory_to_higher_score(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 2),
    )
    add_piece(
        game,
        "black_vanguard",
        PlayerColor.BLACK,
        PieceType.VANGUARD,
        Position(5, 2),
    )

    game.scores[PlayerColor.WHITE] = 3
    game.scores[PlayerColor.BLACK] = 1
    game.turn_count = 199

    game.move_piece("white_explorer", Position(4, 1))
    game.end_turn()

    assert game.status == GameStatus.WHITE_WINS


def test_turn_limit_awards_black_if_black_has_higher_score(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 2),
    )
    add_piece(
        game,
        "black_vanguard",
        PlayerColor.BLACK,
        PieceType.VANGUARD,
        Position(5, 2),
    )

    game.scores[PlayerColor.WHITE] = 1
    game.scores[PlayerColor.BLACK] = 3
    game.turn_count = 199

    game.move_piece("white_explorer", Position(4, 1))
    game.end_turn()

    assert game.status == GameStatus.BLACK_WINS


def test_turn_limit_draw_when_scores_and_progress_are_equal(game):
    add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 2),
    )
    add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(5, 2),
    )

    game.scores[PlayerColor.WHITE] = 2
    game.scores[PlayerColor.BLACK] = 2
    game.turn_count = 199

    game.move_piece("white_explorer", Position(4, 1))
    game.end_turn()

    assert game.status == GameStatus.DRAW
