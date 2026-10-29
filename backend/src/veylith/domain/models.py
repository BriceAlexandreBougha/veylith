from dataclasses import dataclass

from veylith.domain.enums import PieceType, PlayerColor


@dataclass(frozen=True)
class Position:
    row: int
    col: int


@dataclass
class Piece:
    id: str
    owner: PlayerColor
    piece_type: PieceType
    position: Position | None
    captured: bool = False
    finished: bool = False

    @property
    def force(self) -> int:
        return {
            PieceType.EXPLORER: 1,
            PieceType.VANGUARD: 2,
            PieceType.SENTINEL: 3,
        }[self.piece_type]

    @property
    def movement_points(self) -> int:
        return 6 - self.force
