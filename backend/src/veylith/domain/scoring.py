from veylith.domain.models import Piece


def get_exit_score(piece: Piece) -> int:
    return piece.force
