from dataclasses import dataclass
from enum import Enum

from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece


class GameStatus(str, Enum):
    ONGOING = "ONGOING"
    WHITE_WINS = "WHITE_WINS"
    BLACK_WINS = "BLACK_WINS"
    DRAW = "DRAW"


@dataclass(frozen=True)
class VictoryState:
    scores: dict[PlayerColor, int]
    exited_pieces: int
    turn_count: int
    pieces: tuple[Piece, ...]
    first_exit_piece_id: str | None = None


def _game_winner_from_scores(scores: dict[PlayerColor, int]) -> GameStatus:
    white_score = scores[PlayerColor.WHITE]
    black_score = scores[PlayerColor.BLACK]

    if white_score > black_score:
        return GameStatus.WHITE_WINS
    elif black_score > white_score:
        return GameStatus.BLACK_WINS
    else:
        return GameStatus.DRAW


def _get_exit_row(piece: Piece) -> int:
    return 9 if piece.owner == PlayerColor.WHITE else 0


def _distance_to_exit(piece: Piece) -> int:
    if piece.position is None:
        return 10**9
    return abs(_get_exit_row(piece) - piece.position.row)


def evaluate_victory(state: VictoryState) -> GameStatus:
    for piece in state.pieces:
        if state.first_exit_piece_id is not None:
            first_exit_piece = next(
                (
                    piece
                    for piece in state.pieces
                    if piece.id == state.first_exit_piece_id
                ),
                None,
            )

            if (
                first_exit_piece is not None
                and first_exit_piece.finished
                and first_exit_piece.piece_type == PieceType.SENTINEL
            ):
                return (
                    GameStatus.WHITE_WINS
                    if first_exit_piece.owner == PlayerColor.WHITE
                    else GameStatus.BLACK_WINS
                )

    for owner in PlayerColor:
        owned_pieces = [piece for piece in state.pieces if piece.owner == owner]
        if owned_pieces and all(piece.captured for piece in owned_pieces):
            return (
                GameStatus.BLACK_WINS
                if owner == PlayerColor.WHITE
                else GameStatus.WHITE_WINS
            )

    if state.exited_pieces >= 2:
        return _game_winner_from_scores(state.scores)

    if state.turn_count >= 200:
        if sum(state.scores.values()) > 0:
            return _game_winner_from_scores(state.scores)

        active_pieces = [
            piece
            for piece in state.pieces
            if not piece.captured and not piece.finished and piece.position is not None
        ]

        if not active_pieces:
            return GameStatus.DRAW

        white_pieces = [
            piece for piece in active_pieces if piece.owner == PlayerColor.WHITE
        ]

        black_pieces = [
            piece for piece in active_pieces if piece.owner == PlayerColor.BLACK
        ]

        white_best = min(
            (_distance_to_exit(piece) for piece in white_pieces), default=10**9
        )

        black_best = min(
            (_distance_to_exit(piece) for piece in black_pieces), default=10**9
        )

        if white_best < black_best:
            return GameStatus.WHITE_WINS
        if black_best < white_best:
            return GameStatus.BLACK_WINS

        white_advanced = [
            piece for piece in white_pieces if _distance_to_exit(piece) == white_best
        ]
        black_advanced = [
            piece for piece in black_pieces if _distance_to_exit(piece) == black_best
        ]

        white_force = max(
            (piece.force for piece in white_advanced),
            default=0,
        )
        black_force = max(
            (piece.force for piece in black_advanced),
            default=0,
        )
        if white_force > black_force:
            return GameStatus.WHITE_WINS
        if black_force > white_force:
            return GameStatus.BLACK_WINS

        return GameStatus.DRAW
    return GameStatus.ONGOING
