from dataclasses import dataclass, field

from veylith.domain.models import Piece, Position

BOARD_SIZE = 10


@dataclass
class Board:
    size: int = BOARD_SIZE
    heights: list[list[int]] = field(default_factory=list)
    pieces: dict[str, Piece] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.size <= 0:
            raise ValueError("La taille du plateau doit être positive.")

        if not self.heights:
            self.heights = [[0 for _ in range(self.size)] for _ in range(self.size)]

        self._validate_heights()

    def _validate_heights(self) -> None:
        if len(self.heights) != self.size:
            raise ValueError("Nombre de lignes invalide.")

        for row in self.heights:
            if len(row) != self.size:
                raise ValueError("Nombre de colonnes invalide.")

            if any(not isinstance(height, int) for height in row):
                raise ValueError("Les hauteurs doivent être des entiers.")

    def is_valid_position(self, position: Position) -> bool:
        return 0 <= position.row < self.size and 0 <= position.col < self.size

    def get_height(self, position: Position) -> int:
        self._require_valid_position(position)

        return self.heights[position.row][position.col]

    def set_height(self, position: Position, height: int) -> None:
        self._require_valid_position(position)

        if not isinstance(height, int):
            raise TypeError("La hauteur doit être un entier.")

        self.heights[position.row][position.col] = height

    def piece_at(self, position: Position) -> Piece | None:
        self._require_valid_position(position)

        for piece in self.pieces.values():
            if piece.position == position:
                return piece
        return None

    def add_piece(self, piece: Piece) -> None:
        if piece.id in self.pieces:
            raise ValueError(f"identifiant de pièce déjà utilisé : {piece.id}")

        if piece.position is None:
            raise ValueError("Une pièce doit avoir une position pour être placée.")

        self._require_valid_position(piece.position)

        if piece.captured or piece.finished:
            raise ValueError("Une pièce capturé ou sortie ne peut pas être placée.")

        if self.piece_at(piece.position) is not None:
            raise ValueError("Cette case est déjà occupée.")

        self.pieces[piece.id] = piece

    def move_piece(self, piece_id: str, destination: Position) -> None:
        piece = self._get_active_piece(piece_id)
        self._require_valid_position(destination)

        if self.piece_at(destination) is not None:
            raise ValueError("La destination est déja occupée.")

        piece.position = destination

    def remove_piece(self, piece_id: str) -> Piece:
        piece = self._get_active_piece(piece_id)

        piece.position = None
        piece.captured = True

        return piece

    def _require_valid_position(self, position: Position) -> None:
        if not self.is_valid_position(position):
            raise ValueError(f"Position hors plateau : {position}")

    def _get_active_piece(self, piece_id: str) -> Piece:
        piece = self.pieces.get(piece_id)

        if piece is None or piece.captured or piece.finished:
            raise ValueError(f"Pièce inactive ou inconnue : {piece_id}")

        if piece.position is None:
            raise ValueError(f"La pièce {piece_id} n'est pas sur le plateau.")

        return piece
