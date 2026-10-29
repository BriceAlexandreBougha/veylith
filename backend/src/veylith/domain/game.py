from dataclasses import dataclass, field

from veylith.domain.board import Board
from veylith.domain.combat import (
    CombatResult,
    calculate_attack_force,
    calculate_defense_force,
    resolve_combat,
)
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position
from veylith.domain.movement import (
    MovementPath,
    find_path,
    get_reachable_paths,
    validate_path,
)
from veylith.domain.victory import (
    GameStatus,
    VictoryState,
    evaluate_victory,
)


@dataclass
class Game:
    board: Board = field(default_factory=Board)
    pieces: dict[str, Piece] = field(default_factory=dict)
    scores: dict[PlayerColor, int] = field(
        default_factory=lambda: {
            PlayerColor.WHITE: 0,
            PlayerColor.BLACK: 0,
        }
    )
    current_player: PlayerColor = PlayerColor.WHITE
    turn_count: int = 0
    exited_pieces: int = 0
    status: GameStatus = GameStatus.ONGOING
    first_exit_piece_id: str | None = None

    movement_spent: dict[str, int] = field(default_factory=dict)
    turn_start_positions: dict[str, Position] = field(default_factory=dict)
    visited_positions: dict[str, set[Position]] = field(default_factory=dict)
    moved_piece_ids: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        if not self.pieces:
            self._setup_pieces()

    def _setup_pieces(self) -> None:
        piece_types = [
            PieceType.SENTINEL,
            PieceType.VANGUARD,
            PieceType.EXPLORER,
            PieceType.EXPLORER,
            PieceType.VANGUARD,
            PieceType.SENTINEL,
        ]
        columns = [2, 3, 4, 5, 6, 7]

        for owner, row in (
            (PlayerColor.WHITE, 0),
            (PlayerColor.BLACK, 9),
        ):
            type_counts = {piece_type: 0 for piece_type in PieceType}
            for index, piece_type in enumerate(piece_types):
                type_counts[piece_type] += 1
                id_offsets = {
                    PieceType.EXPLORER: 0,
                    PieceType.VANGUARD: 2,
                    PieceType.SENTINEL: 4,
                }
                piece_number = id_offsets[piece_type] + type_counts[piece_type]
                piece_id = (
                    f"{owner.value.lower()}_{piece_type.value.lower()}_{piece_number}"
                )
                piece = Piece(
                    id=piece_id,
                    owner=owner,
                    piece_type=piece_type,
                    position=Position(row, columns[index]),
                )
                self.board.add_piece(piece)
                self.pieces[piece_id] = piece

    def _require_ongoing(self) -> None:
        if self.get_victory_status() != GameStatus.ONGOING:
            raise ValueError("La partie est terminée.")

    @property
    def has_moved_this_turn(self) -> bool:
        return bool(self.moved_piece_ids)

    @property
    def moved_piece_id(self) -> str | None:
        return min(self.moved_piece_ids, default=None)

    def _get_current_piece(self, piece_id: str) -> Piece:
        piece = self.pieces.get(piece_id)

        if piece is None or piece.position is None or piece.captured or piece.finished:
            raise ValueError(f"Pièce inactive ou inconnue : {piece_id}")

        if piece.owner != self.current_player:
            raise ValueError("Cette pièce appartient à l'adversaire.")

        if self.moved_piece_id and piece.id != self.moved_piece_id:
            raise ValueError("Vous devez continuer avec la même pièce pendant ce tour.")

        return piece

    def _get_turn_start(self, piece: Piece) -> Position:
        return self.turn_start_positions.get(piece.id, piece.position)

    def get_legal_paths(self, piece_id: str) -> list[MovementPath]:
        self._require_ongoing()
        piece = self._get_current_piece(piece_id)

        if piece.position is None:
            return []

        remaining = piece.movement_points - self.movement_spent.get(piece.id, 0)
        if remaining <= 0:
            return []

        paths = get_reachable_paths(self.board, piece, piece.position, remaining)

        start_of_turn = self._get_turn_start(piece)
        visited = self.visited_positions.get(piece.id, {start_of_turn})

        return [
            path
            for path in paths
            if start_of_turn not in path.path
            and not any(
                position in visited and position != piece.position
                for position in path.path
            )
        ]

    def move_piece(
        self,
        piece_id: str,
        destination: Position,
        special: str | None = None,
    ) -> MovementPath:
        self._require_ongoing()
        piece = self._get_current_piece(piece_id)

        if piece.position is None:
            raise ValueError("La pièce n'est pas sur le plateau.")

        remaining = piece.movement_points - self.movement_spent.get(piece.id, 0)
        if remaining <= 0:
            raise ValueError("Cette pièce n'a plus de points de mouvement.")

        if special is None:
            path = find_path(self.board, piece, piece.position, destination, remaining)
        else:
            path = next(
                (
                    candidate
                    for candidate in self.get_legal_paths(piece_id)
                    if candidate.destination == destination
                    and candidate.special == special
                ),
                None,
            )

        if path is None:
            raise ValueError("Déplacement invalide.")

        return self._apply_movement_path(piece, path)

    def move_to_destination(
        self,
        piece_id: str,
        destination: Position,
        special: str | None = None,
    ) -> MovementPath:
        """Validate and apply a destination using one legal-path search."""
        legal_paths = self.get_legal_paths(piece_id)
        path = next(
            (
                candidate
                for candidate in legal_paths
                if candidate.destination == destination
                and (special is None or candidate.special == special)
            ),
            None,
        )
        if path is None:
            raise ValueError("Déplacement invalide.")

        piece = self._get_current_piece(piece_id)
        return self._apply_movement_path(piece, path)

    def move_along_path(
        self,
        piece_id: str,
        path: list[Position],
        special: str | None = None,
    ) -> MovementPath:
        """Apply an exact client-selected route after matching it to legal paths."""
        if not path:
            raise ValueError("Le trajet ne peut pas être vide.")

        piece = self._get_current_piece(piece_id)
        legal_path = self._validate_custom_path(piece, path, special)
        return self._apply_movement_path(piece, legal_path)

    def _validate_custom_path(
        self,
        piece: Piece,
        path: list[Position],
        special: str | None,
    ) -> MovementPath:
        if piece.position is None:
            raise ValueError("La pièce n'est pas sur le plateau.")

        remaining = piece.movement_points - self.movement_spent.get(piece.id, 0)
        if not validate_path(
            self.board,
            piece,
            piece.position,
            tuple(path),
            remaining,
            special,
        ):
            raise ValueError("Trajet invalide.")

        start = piece.position
        current = start
        cost = 0
        for destination in path:
            row_delta = abs(destination.row - current.row)
            col_delta = abs(destination.col - current.col)
            cost += (
                1
                if row_delta == 1 and col_delta == 1
                else (
                    1
                    + abs(
                        self.board.get_height(destination)
                        - self.board.get_height(current)
                    )
                )
            )
            current = destination

        # Special Explorer moves use the remaining budget, regardless of
        # their nominal one- or two-point cost.
        if special is not None:
            cost = remaining

        return MovementPath(
            start=start,
            destination=path[-1],
            path=tuple(path),
            cost=cost,
            special=special,
        )

    def _apply_movement_path(self, piece: Piece, path: MovementPath) -> MovementPath:
        if piece.position is None:
            raise ValueError("La pièce n'est pas sur le plateau.")

        start_of_turn = self._get_turn_start(piece)
        visited = self.visited_positions.setdefault(piece.id, {start_of_turn})

        if start_of_turn in path.path:
            raise ValueError("Impossible de revenir sur la case de départ.")

        if any(
            position in visited and position != piece.position for position in path.path
        ):
            raise ValueError("Impossible de repasser par une case déjà visitée.")

        old_position = piece.position
        total_spent = self.movement_spent.get(piece.id, 0)

        # Un mouvement spécial consomme tous les points restants.
        if path.special is not None:
            new_spent = piece.movement_points
        else:
            new_spent = total_spent + path.cost

        if new_spent > piece.movement_points:
            raise ValueError("Budget de mouvement dépassé.")

        self.board.move_piece(piece.id, path.destination)

        self.turn_start_positions.setdefault(piece.id, old_position)
        visited.update(path.path)
        self.movement_spent[piece.id] = new_spent
        self.moved_piece_ids.add(piece.id)

        return path

    def attack_piece(
        self,
        attacker_id: str,
        defender_id: str,
        path: list[Position] | None = None,
        special: str | None = None,
    ) -> CombatResult:
        self._require_ongoing()
        attacker = self._get_current_piece(attacker_id)
        defender = self.pieces.get(defender_id)

        if (
            defender is None
            or defender.position is None
            or defender.captured
            or defender.finished
        ):
            raise ValueError("La pièce ciblée est inactive ou inconnue.")

        if defender.owner == attacker.owner:
            raise ValueError("Impossible d'attaquer une pièce alliée.")

        selected_path: MovementPath | None = None
        if path is None:
            result = resolve_combat(
                self.board,
                attacker,
                defender,
                self.movement_spent.get(attacker_id, 0),
            )
        else:
            if not path:
                raise ValueError("Le trajet d'attaque ne peut pas être vide.")
            if defender.position is None:
                raise ValueError("La pièce ciblée n'est plus sur le plateau.")

            defender_on_board = self.board.pieces.pop(defender.id, None)
            try:
                if path[-1] == defender.position:
                    try:
                        selected_path = self._validate_custom_path(
                            attacker, path, special
                        )
                    except ValueError:
                        selected_path = None
            finally:
                if defender_on_board is not None:
                    self.board.pieces[defender.id] = defender_on_board

            if selected_path is None:
                raise ValueError("Trajet d'attaque invalide.")

            movement_spent = self.movement_spent.get(attacker_id, 0)
            if selected_path.special is not None:
                movement_spent = attacker.movement_points
            else:
                movement_spent += selected_path.cost
            attack_force = calculate_attack_force(
                self.board, attacker, defender, movement_spent
            )
            defense_force = calculate_defense_force(self.board, attacker, defender)
            result = CombatResult(
                attacker_id=attacker_id,
                defender_id=defender_id,
                attack_force=attack_force,
                defense_force=defense_force,
                success=attack_force >= defense_force,
            )
        if not result.success:
            raise ValueError(
                "Force d'attaque insuffisante : "
                f"{result.attack_force} contre {result.defense_force}."
            )

        target_position = defender.position
        self.board.remove_piece(defender.id)
        defender.captured = True
        defender.finished = False
        if selected_path is not None:
            self._apply_movement_path(attacker, selected_path)
        else:
            attacker.position = target_position

        # A direct attack counts as the player's action for this turn.
        self.moved_piece_ids.add(attacker_id)
        self.end_turn()
        return result

    def exit_piece(self, piece_id: str) -> int:
        self._require_ongoing()
        piece = self._get_current_piece(piece_id)

        if piece.position is None:
            raise ValueError("La pièce n'est pas sur le plateau.")

        expected_row = self.board.size - 1 if piece.owner == PlayerColor.WHITE else 0

        if piece.position.row != expected_row:
            raise ValueError("La pièce n'a pas atteint sa rangée de sortie.")

        del self.board.pieces[piece.id]

        piece.position = None
        piece.finished = True
        piece.captured = False
        self.moved_piece_ids.add(piece.id)

        self.scores[piece.owner] += piece.force
        self.exited_pieces += 1

        if self.first_exit_piece_id is None:
            self.first_exit_piece_id = piece.id

        if piece.piece_type == PieceType.SENTINEL:
            self.status = (
                GameStatus.WHITE_WINS
                if piece.owner == PlayerColor.WHITE
                else GameStatus.BLACK_WINS
            )
        else:
            self.get_victory_status()

        if self.status == GameStatus.ONGOING:
            self.end_turn()

        return piece.force

    def end_turn(self) -> None:
        if self.status != GameStatus.ONGOING:
            return
        if not self.has_moved_this_turn:
            raise ValueError(
                "Vous devez déplacer au moins une pièce avant de terminer votre tour."
            )

        self.current_player = (
            PlayerColor.BLACK
            if self.current_player == PlayerColor.WHITE
            else PlayerColor.WHITE
        )
        self.turn_count += 1

        self.movement_spent.clear()
        self.turn_start_positions.clear()
        self.visited_positions.clear()
        self.moved_piece_ids.clear()

        self.get_victory_status()

    def get_victory_status(self) -> GameStatus:
        self.status = evaluate_victory(
            VictoryState(
                scores=self.scores,
                exited_pieces=self.exited_pieces,
                turn_count=self.turn_count,
                pieces=tuple(self.pieces.values()),
                first_exit_piece_id=self.first_exit_piece_id,
            )
        )
        return self.status
