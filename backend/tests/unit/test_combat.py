import pytest

from veylith.domain.board import Board
from veylith.domain.combat import (
    calculate_attack_force,
    calculate_defense_force,
    resolve_combat,
)
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position


def make_piece(
    piece_id: str,
    owner: PlayerColor,
    piece_type: PieceType,
    position: Position,
) -> Piece:
    return Piece(
        id=piece_id,
        owner=owner,
        piece_type=piece_type,
        position=position,
    )


def make_combat_board(
    attacker_type: PieceType = PieceType.EXPLORER,
    defender_type: PieceType = PieceType.EXPLORER,
) -> tuple[Board, Piece, Piece]:
    board = Board()

    attacker = make_piece(
        "attacker",
        PlayerColor.WHITE,
        attacker_type,
        Position(4, 4),
    )
    defender = make_piece(
        "defender",
        PlayerColor.BLACK,
        defender_type,
        Position(4, 5),
    )

    board.add_piece(attacker)
    board.add_piece(defender)

    return board, attacker, defender


def test_equal_force_attack_succeeds() -> None:
    board, attacker, defender = make_combat_board()

    result = resolve_combat(board, attacker, defender, 1)

    assert result.attack_force == 1
    assert result.defense_force == 1
    assert result.success is True


def test_weaker_attack_fails() -> None:
    board, attacker, defender = make_combat_board(
        PieceType.EXPLORER,
        PieceType.SENTINEL,
    )

    result = resolve_combat(board, attacker, defender, 1)

    assert result.attack_force == 1
    assert result.defense_force == 3
    assert result.success is False


def test_higher_attacker_gets_bonus() -> None:
    board, attacker, defender = make_combat_board()

    board.set_height(attacker.position, 2)
    board.set_height(defender.position, 1)

    assert calculate_attack_force(board, attacker, defender, 1) == 2


def test_lower_attacker_gets_penalty() -> None:
    board, attacker, defender = make_combat_board()

    board.set_height(attacker.position, 1)
    board.set_height(defender.position, 2)

    assert calculate_attack_force(board, attacker, defender, 1) == 0


def test_equal_height_has_no_modifier() -> None:
    board, attacker, defender = make_combat_board()

    assert calculate_attack_force(board, attacker, defender, 1) == 1


def test_attacking_support_adds_ally_force() -> None:
    board, attacker, defender = make_combat_board()

    ally = make_piece(
        "ally",
        PlayerColor.WHITE,
        PieceType.VANGUARD,
        Position(3, 5),
    )
    board.add_piece(ally)

    assert calculate_attack_force(board, attacker, defender, 1) == 3


def test_defending_support_adds_one_per_ally() -> None:
    board, attacker, defender = make_combat_board()

    ally = make_piece(
        "defender_ally",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(3, 5),
    )
    board.add_piece(ally)

    assert calculate_defense_force(board, attacker, defender) == 2


def test_vanguard_gets_charge_bonus_when_all_points_spent() -> None:
    board, attacker, defender = make_combat_board(
        PieceType.VANGUARD,
        PieceType.EXPLORER,
    )

    result = resolve_combat(
        board,
        attacker,
        defender,
        attacker.movement_points,
    )

    assert result.attack_force == 3
    assert result.success is True


def test_vanguard_does_not_get_charge_bonus_when_not_all_points_spent() -> None:
    board, attacker, defender = make_combat_board(
        PieceType.VANGUARD,
        PieceType.EXPLORER,
    )

    result = resolve_combat(
        board,
        attacker,
        defender,
        attacker.movement_points - 1,
    )

    assert result.attack_force == 2


def test_cannot_attack_an_ally() -> None:
    board, attacker, defender = make_combat_board()
    defender.owner = PlayerColor.WHITE

    with pytest.raises(ValueError, match="alliée"):
        resolve_combat(board, attacker, defender, 1)


def test_can_attack_a_non_adjacent_piece_within_movement_range() -> None:
    board, attacker, defender = make_combat_board()
    board.move_piece(defender.id, Position(4, 7))

    result = resolve_combat(board, attacker, defender, 1)

    assert result.success is True


def test_cannot_attack_a_piece_outside_movement_range() -> None:
    board, attacker, defender = make_combat_board()
    board.move_piece(defender.id, Position(9, 9))

    with pytest.raises(ValueError, match="hors de portée"):
        resolve_combat(board, attacker, defender, 1)


def test_attack_range_uses_remaining_movement_points() -> None:
    board, attacker, defender = make_combat_board()
    board.move_piece(defender.id, Position(4, 9))

    with pytest.raises(ValueError, match="hors de portée"):
        resolve_combat(board, attacker, defender, movement_points_spent=1)

    assert resolve_combat(board, attacker, defender, movement_points_spent=0).success


def test_combat_evaluation_does_not_modify_board() -> None:
    board, attacker, defender = make_combat_board()

    attacker_position = attacker.position
    defender_position = defender.position

    resolve_combat(board, attacker, defender, 1)

    assert attacker.position == attacker_position
    assert defender.position == defender_position
    assert board.piece_at(attacker_position) is attacker
    assert board.piece_at(defender_position) is defender
