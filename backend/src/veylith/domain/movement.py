from dataclasses import dataclass

from veylith.domain.board import Board
from veylith.domain.enums import PieceType
from veylith.domain.models import Piece, Position


@dataclass(frozen=True)
class MovementPath:
    start: Position
    destination: Position
    path: tuple[Position, ...]
    cost: int
    special: str | None = None


def _is_active(piece: Piece) -> bool:
    return piece.position is not None and not piece.captured and not piece.finished


def _neighbors(board: Board, position: Position) -> list[Position]:
    candidates = [
        Position(position.row - 1, position.col),
        Position(position.row + 1, position.col),
        Position(position.row, position.col - 1),
        Position(position.row, position.col + 1),
    ]
    return [p for p in candidates if board.is_valid_position(p)]


def _is_occupied_by_other_piece(
    board: Board,
    piece: Piece,
    position: Position,
) -> bool:
    occupant = board.piece_at(position)
    return occupant is not None and occupant.id != piece.id


def _step_cost(
    board: Board,
    start: Position,
    destination: Position,
) -> int:
    return 1 + abs(board.get_height(destination) - board.get_height(start))


def _normal_moves(
    board: Board,
    piece: Piece,
    current: Position,
) -> list[tuple[Position, int]]:
    """Return legal normal steps and their costs."""
    moves = []

    for destination in _neighbors(board, current):
        if _is_occupied_by_other_piece(board, piece, destination):
            continue

        moves.append((destination, _step_cost(board, current, destination)))

    return moves


def _explorer_special_moves(
    board: Board,
    piece: Piece,
    current: Position,
) -> list[tuple[Position, int, tuple[Position, ...], str]]:
    """Return legal Explorer special moves.

    A diagonal costs 1 point.
    A straight double jump costs 2 points.
    The intermediate square of a double jump must be empty.
    """
    if piece.piece_type != PieceType.EXPLORER:
        return []

    moves = []

    # Diagonal move: one square.
    for dr in (-1, 1):
        for dc in (-1, 1):
            destination = Position(
                current.row + dr,
                current.col + dc,
            )

            if not board.is_valid_position(destination):
                continue

            if _is_occupied_by_other_piece(board, piece, destination):
                continue

            moves.append((destination, 1, (destination,), "diagonal"))

    # Double jump: two squares in a straight line.
    for neighbor in _neighbors(board, current):
        dr = neighbor.row - current.row
        dc = neighbor.col - current.col

        destination = Position(
            current.row + 2 * dr,
            current.col + 2 * dc,
        )

        if not board.is_valid_position(destination):
            continue

        if _is_occupied_by_other_piece(board, piece, neighbor):
            continue

        if _is_occupied_by_other_piece(board, piece, destination):
            continue

        moves.append(
            (
                destination,
                2,
                (neighbor, destination),
                "double_jump",
            )
        )

    return moves


def get_reachable_paths(
    board: Board,
    piece: Piece,
    start: Position,
    budget: int,
) -> list[MovementPath]:
    """Return legal paths, including Explorer special moves.

    A special move ends the movement immediately and consumes the
    entire movement budget for the turn.
    """
    if not _is_active(piece) or budget <= 0:
        return []

    if not board.is_valid_position(start):
        return []

    if piece.position != start:
        return []

    if _is_occupied_by_other_piece(board, piece, start):
        return []

    results: dict[tuple[Position, str | None], MovementPath] = {}

    def save_path(
        destination: Position,
        path: tuple[Position, ...],
        cost: int,
        special: str | None,
    ) -> None:
        key = (destination, special)
        candidate = MovementPath(
            start=start,
            destination=destination,
            path=path,
            cost=cost,
            special=special,
        )

        previous = results.get(key)

        if previous is None or candidate.cost < previous.cost:
            results[key] = candidate

    def explore(
        current: Position,
        path: tuple[Position, ...],
        visited: frozenset[Position],
        spent: int,
    ) -> None:
        # Normal movement may continue while points remain.
        for destination, step_cost in _normal_moves(board, piece, current):
            if destination in visited or destination == start:
                continue

            new_cost = spent + step_cost

            if new_cost > budget:
                continue

            new_path = path + (destination,)
            new_visited = visited | {destination}

            save_path(
                destination,
                new_path,
                new_cost,
                None,
            )

            explore(
                destination,
                new_path,
                new_visited,
                new_cost,
            )

        # Special moves are terminal: no further movement this turn.
        for destination, minimum_cost, segment, special in _explorer_special_moves(
            board, piece, current
        ):
            if spent + minimum_cost > budget:
                continue

            if destination == start or destination in visited:
                continue

            # The intermediate square of a double jump is included
            # in the path and must not revisit a previously visited square.
            intermediate_positions = segment[:-1]

            if any(
                position == start or position in visited
                for position in intermediate_positions
            ):
                continue

            new_path = path + segment

            save_path(
                destination,
                new_path,
                budget,
                special,
            )

    explore(
        current=start,
        path=(),
        visited=frozenset({start}),
        spent=0,
    )

    return list(results.values())


def get_possible_destinations(
    board: Board,
    piece: Piece,
    start: Position,
    budget: int,
) -> set[Position]:
    return {
        movement.destination
        for movement in get_reachable_paths(board, piece, start, budget)
    }


def find_path(
    board: Board,
    piece: Piece,
    start: Position,
    destination: Position,
    budget: int,
) -> MovementPath | None:
    """Find the cheapest legal normal path to a destination.

    Special moves must be explicitly requested by the caller.
    """
    candidates = [
        movement
        for movement in get_reachable_paths(board, piece, start, budget)
        if movement.destination == destination and movement.special is None
    ]

    if not candidates:
        return None

    return min(candidates, key=lambda movement: movement.cost)


def validate_path(
    board: Board,
    piece: Piece,
    start: Position,
    path: tuple[Position, ...],
    budget: int,
    special: str | None = None,
) -> bool:
    """Validate a submitted movement path.

    For Explorer special moves, pass special='diagonal' or
    special='double_jump'. This is important because the path of a
    double jump includes its intermediate square.
    """
    if not _is_active(piece) or budget <= 0:
        return False

    if not board.is_valid_position(start) or not path:
        return False

    if piece.position != start:
        return False

    if special not in (None, "diagonal", "double_jump"):
        return False

    if special is not None and piece.piece_type != PieceType.EXPLORER:
        return False

    current = start
    visited = {start}
    total_cost = 0

    if special == "diagonal":
        if len(path) < 1:
            return False

        # All preceding steps must be normal orthogonal steps.
        normal_path = path[:-1]
        special_destination = path[-1]

    elif special == "double_jump":
        if len(path) < 2:
            return False

        normal_path = path[:-2]
        intermediate = path[-2]
        special_destination = path[-1]

    else:
        normal_path = path
        special_destination = None

    # Validate the normal portion of the path.
    for destination in normal_path:
        if not board.is_valid_position(destination):
            return False

        if destination in visited:
            return False

        if _is_occupied_by_other_piece(board, piece, destination):
            return False

        distance = abs(destination.row - current.row) + abs(
            destination.col - current.col
        )

        if distance != 1:
            return False

        total_cost += _step_cost(board, current, destination)

        if total_cost > budget:
            return False

        visited.add(destination)
        current = destination

    # Validate a diagonal special move.
    if special == "diagonal":
        destination = special_destination

        if not board.is_valid_position(destination):
            return False

        if destination in visited:
            return False

        if _is_occupied_by_other_piece(board, piece, destination):
            return False

        if (
            abs(destination.row - current.row) != 1
            or abs(destination.col - current.col) != 1
        ):
            return False

        return not total_cost + 1 > budget

    # Validate a double jump.
    if special == "double_jump":
        destination = special_destination

        if not board.is_valid_position(intermediate):
            return False

        if not board.is_valid_position(destination):
            return False

        if intermediate in visited or destination in visited:
            return False

        if _is_occupied_by_other_piece(board, piece, intermediate):
            return False

        if _is_occupied_by_other_piece(board, piece, destination):
            return False

        dr = intermediate.row - current.row
        dc = intermediate.col - current.col

        if abs(dr) + abs(dc) != 1:
            return False

        if (
            destination.row != current.row + 2 * dr
            or destination.col != current.col + 2 * dc
        ):
            return False

        return not total_cost + 2 > budget

    return True
