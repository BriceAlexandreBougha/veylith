import pytest

from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Piece, Position
from veylith.domain.victory import GameStatus


@pytest.fixture
def game():
    """Crée une partie vide pour les scénarios d'intégration."""
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


def test_successful_move_and_attack(game):
    """Un Sentinel se déplace, capture un Explorer et termine son tour."""
    attacker = add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 7),
    )

    game.move_piece(attacker.id, Position(4, 5))

    assert attacker.position == Position(4, 5)
    assert game.current_player == PlayerColor.WHITE

    result = game.attack_piece(attacker.id, defender.id)

    assert result.success is True
    assert defender.captured is True
    assert defender.position is None
    assert attacker.position == Position(4, 7)
    assert game.current_player == PlayerColor.BLACK


def test_direct_ranged_attack_does_not_require_prior_movement(game):
    attacker = add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 7),
    )

    result = game.attack_piece(attacker.id, defender.id)

    assert result.success is True
    assert defender.captured is True
    assert attacker.position == Position(4, 7)
    assert game.current_player == PlayerColor.BLACK


def test_explorer_cannot_capture_vanguard_without_bonus_but_height_can_equalize(
    game,
):
    attacker = add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_vanguard",
        PlayerColor.BLACK,
        PieceType.VANGUARD,
        Position(4, 5),
    )

    with pytest.raises(ValueError, match="Force d'attaque insuffisante"):
        game.attack_piece(attacker.id, defender.id)

    assert game.current_player == PlayerColor.WHITE
    assert not defender.captured

    game.board.set_height(attacker.position, 1)
    result = game.attack_piece(attacker.id, defender.id)

    assert result.success
    assert defender.captured
    assert game.current_player == PlayerColor.BLACK


def test_insufficient_attack_is_rejected_and_keeps_defender(game):
    """Un Explorer ne parvient pas à capturer un Sentinel."""
    attacker = add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_sentinel",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        Position(4, 6),
    )

    game.move_piece(attacker.id, Position(4, 5))
    with pytest.raises(ValueError, match="Force d'attaque insuffisante"):
        game.attack_piece(attacker.id, defender.id)

    assert defender.captured is False
    assert defender.position == Position(4, 6)
    assert attacker.position == Position(4, 5)
    assert game.current_player == PlayerColor.WHITE
    assert game.has_moved_this_turn is True


def test_out_of_range_attack_does_not_end_the_turn(game):
    attacker = add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(9, 9),
    )

    game.move_piece(attacker.id, Position(4, 5))

    with pytest.raises(ValueError, match="hors de portée"):
        game.attack_piece(attacker.id, defender.id)

    assert game.current_player == PlayerColor.WHITE
    assert game.has_moved_this_turn is True
    assert defender.captured is False


def test_exit_awards_points_and_ends_turn(game):
    """Un Explorer sort du plateau et rapporte sa force."""
    explorer = add_piece(
        game,
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 4),
    )

    game.move_piece(explorer.id, Position(9, 4))
    game.exit_piece(explorer.id)

    assert explorer.finished is True
    assert explorer.captured is False
    assert explorer.position is None
    assert explorer.id not in game.board.pieces
    assert game.scores[PlayerColor.WHITE] == explorer.force
    assert game.current_player == PlayerColor.BLACK


def test_sentinel_exit_wins_immediately(game):
    """La sortie d'un Sentinel donne immédiatement la victoire."""
    sentinel = add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(8, 4),
    )

    game.move_piece(sentinel.id, Position(9, 4))
    game.exit_piece(sentinel.id)

    assert sentinel.finished is True
    assert game.scores[PlayerColor.WHITE] == sentinel.force
    assert game.status == GameStatus.WHITE_WINS
    assert game.current_player == PlayerColor.WHITE


def test_captured_piece_cannot_be_used_again(game):
    """Une pièce capturée ne peut plus être déplacée."""
    attacker = add_piece(
        game,
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 6),
    )

    game.move_piece(attacker.id, Position(4, 5))
    result = game.attack_piece(attacker.id, defender.id)

    assert result.success is True

    with pytest.raises(ValueError):
        game.move_piece(defender.id, Position(4, 7))
