from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position
from veylith.domain.scoring import get_exit_score


def make_piece(piece_type: PieceType) -> Piece:
    return Piece(
        id=f"white_{piece_type.value.lower()}",
        owner=PlayerColor.WHITE,
        piece_type=piece_type,
        position=Position(5, 5),
    )


def test_explorer_exit_is_worth_one_point() -> None:
    assert get_exit_score(make_piece(PieceType.EXPLORER)) == 1


def test_vanguard_exit_is_worth_two_points() -> None:
    assert get_exit_score(make_piece(PieceType.VANGUARD)) == 2


def test_sentinel_exit_is_worth_three_points() -> None:
    assert get_exit_score(make_piece(PieceType.SENTINEL)) == 3
