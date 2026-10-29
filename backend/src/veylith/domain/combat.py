from dataclasses import dataclass

from veylith.domain.board import Board
from veylith.domain.models import Piece, PieceType, Position
from veylith.domain.movement import get_reachable_paths


@dataclass(frozen=True)
class CombatResult:
    attacker_id: str
    defender_id: str
    attack_force: int
    defense_force: int
    success: bool


def _are_adjacent(first: Position, second: Position) -> bool:
    return abs(first.row - second.row) + abs(first.col - second.col) == 1


def _is_within_attack_range(
    board: Board,
    attacker: Piece,
    defender: Piece,
    movement_points_spent: int,
) -> bool:
    if attacker.position is None or defender.position is None:
        return False

    # Evaluate the target square as an empty destination while keeping all
    # other pieces as obstacles. This gives ranged attacks the same terrain,
    # path, and Explorer movement rules as ordinary movement.
    attack_board = Board(size=board.size, heights=board.heights)
    attack_board.pieces = {
        piece_id: piece
        for piece_id, piece in board.pieces.items()
        if piece_id != defender.id
    }
    # Keep adjacent combat available after a full-movement charge while
    # limiting ranged attacks to movement points that remain.
    remaining_range = max(1, attacker.movement_points - movement_points_spent)
    return any(
        path.destination == defender.position
        for path in get_reachable_paths(
            attack_board,
            attacker,
            attacker.position,
            remaining_range,
        )
    )


def _adjacent_allies(
    board: Board, piece: Piece, target_position: Position
) -> list[Piece]:
    allies: list[Piece] = []

    for other in board.pieces.values():
        if other.id == piece.id:
            continue
        if other.owner != piece.owner:
            continue
        if other.captured or other.finished or other.position is None:
            continue

        if _are_adjacent(other.position, target_position):
            allies.append(other)

    return allies


def calculate_attack_force(
    board: Board, attacker: Piece, defender: Piece, movement_points_spent: int
) -> int:
    if attacker.position is None or defender.position is None:
        raise ValueError("Les pièces doivent être présentes sur le plateau.")

    height_difference = board.get_height(attacker.position) - board.get_height(
        defender.position
    )

    if height_difference > 0:
        height_bonus = 1
    elif height_difference < 0:
        height_bonus = -1
    else:
        height_bonus = 0

    support_force = sum(
        ally.force for ally in _adjacent_allies(board, attacker, defender.position)
    )

    charge_bonus = (
        1
        if attacker.piece_type == PieceType.VANGUARD
        and movement_points_spent == attacker.movement_points
        else 0
    )

    return attacker.force + height_bonus + support_force + charge_bonus


def calculate_defense_force(board: Board, attacker: Piece, defender: Piece) -> int:
    if attacker.position is None or defender.position is None:
        raise ValueError("Les pièces doivent être présentes sur le plateau.")

    defensive_support = sum(
        1
        for ally in _adjacent_allies(board, defender, defender.position)
        if ally.id != attacker.id
    )

    return defender.force + defensive_support


def resolve_combat(
    board: Board, attacker: Piece, defender: Piece, movement_points_spent: int
) -> CombatResult:
    if attacker.owner == defender.owner:
        raise ValueError("Une pièce ne peut pas attaquer une pièce alliée.")

    if attacker.position is None or defender.position is None:
        raise ValueError("Les pièces doivent être présentes sur le plateau.")

    if not _is_within_attack_range(board, attacker, defender, movement_points_spent):
        raise ValueError("La pièce adverse est hors de portée d'attaque.")

    attack_force = calculate_attack_force(
        board, attacker, defender, movement_points_spent
    )
    defense_force = calculate_defense_force(board, attacker, defender)

    return CombatResult(
        attacker_id=attacker.id,
        defender_id=defender.id,
        attack_force=attack_force,
        defense_force=defense_force,
        success=attack_force >= defense_force,
    )
