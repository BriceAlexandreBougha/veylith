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


def test_attacker_on_higher_ground_gets_bonus(game):
    attacker = add_piece(
        game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 5),
    )

    game.board.set_height(attacker.position, 2)
    game.board.set_height(defender.position, 1)

    from veylith.domain.combat import calculate_attack_force

    force = calculate_attack_force(
        game.board, attacker, defender, movement_points_spent=0
    )

    assert force == attacker.force + 1


def test_attacker_on_lower_ground_gets_penalty(game):
    attacker = add_piece(
        game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 5),
    )

    game.board.set_height(attacker.position, 1)
    game.board.set_height(defender.position, 2)

    from veylith.domain.combat import calculate_attack_force

    force = calculate_attack_force(
        game.board, attacker, defender, movement_points_spent=0
    )

    assert force == attacker.force - 1


def test_allied_support_increases_attack_force(game):
    attacker = add_piece(
        game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "defender",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        Position(4, 5),
    )
    ally = add_piece(
        game,
        "ally",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(3, 5),
    )

    from veylith.domain.combat import calculate_attack_force

    force_without_support = calculate_attack_force(
        game.board, attacker, defender, movement_points_spent=0
    )

    game.board.pieces.pop(ally.id)
    game.pieces.pop(ally.id)

    force_with_support_removed = calculate_attack_force(
        game.board, attacker, defender, movement_points_spent=0
    )

    assert force_without_support == attacker.force + ally.force
    assert force_with_support_removed == attacker.force


def test_allied_support_increases_defense(game):
    attacker = add_piece(
        game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "defender",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        Position(4, 5),
    )
    add_piece(
        game,
        "ally",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(3, 5),
    )

    from veylith.domain.combat import calculate_defense_force

    defense = calculate_defense_force(game.board, attacker, defender)

    assert defense == defender.force + 1


def test_vanguard_gets_charge_bonus_when_all_movement_is_spent(game):
    attacker = add_piece(
        game,
        "vanguard",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(4, 4),
    )
    defender = add_piece(
        game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 5),
    )

    from veylith.domain.combat import calculate_attack_force

    force_with_charge = calculate_attack_force(
        game.board,
        attacker,
        defender,
        movement_points_spent=attacker.movement_points,
    )
    force_without_charge = calculate_attack_force(
        game.board,
        attacker,
        defender,
        movement_points_spent=attacker.movement_points - 1,
    )

    assert force_with_charge == attacker.force + 1
    assert force_without_charge == attacker.force
