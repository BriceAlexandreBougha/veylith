import pytest

from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.models import Piece, Position
from veylith.domain.victory import (
    GameStatus,
    VictoryState,
    evaluate_victory,
)


def make_piece(
    piece_id: str,
    owner: PlayerColor,
    piece_type: PieceType = PieceType.EXPLORER,
    row: int = 5,
    finished: bool = False,
    captured: bool = False,
) -> Piece:
    return Piece(
        id=piece_id,
        owner=owner,
        piece_type=piece_type,
        position=None if finished or captured else Position(row, 5),
        finished=finished,
        captured=captured,
    )


def make_state(
    pieces: tuple[Piece, ...] = (),
    white_score: int = 0,
    black_score: int = 0,
    exited_pieces: int = 0,
    turn_count: int = 0,
    first_exit_piece_id: str | None = None,
) -> VictoryState:
    return VictoryState(
        scores={
            PlayerColor.WHITE: white_score,
            PlayerColor.BLACK: black_score,
        },
        exited_pieces=exited_pieces,
        turn_count=turn_count,
        pieces=pieces,
        first_exit_piece_id=first_exit_piece_id,
    )


def test_game_is_ongoing_at_start() -> None:
    state = make_state()
    assert evaluate_victory(state) == GameStatus.ONGOING


def test_first_sentinel_to_exit_wins_immediately() -> None:
    sentinel = make_piece(
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        finished=True,
    )
    state = make_state(
        pieces=(sentinel,),
        exited_pieces=1,
        first_exit_piece_id=sentinel.id,
    )

    assert evaluate_victory(state) == GameStatus.WHITE_WINS


def test_sentinel_exiting_second_does_not_win_immediately() -> None:
    first = make_piece(
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        finished=True,
    )
    second = make_piece(
        "black_sentinel",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        finished=True,
    )
    state = make_state(
        pieces=(first, second),
        white_score=1,
        black_score=3,
        exited_pieces=2,
        first_exit_piece_id=first.id,
    )

    assert evaluate_victory(state) == GameStatus.BLACK_WINS


@pytest.mark.parametrize(
    ("eliminated_owner", "expected"),
    [
        (PlayerColor.WHITE, GameStatus.BLACK_WINS),
        (PlayerColor.BLACK, GameStatus.WHITE_WINS),
    ],
)
def test_capturing_all_opponent_pieces_wins(
    eliminated_owner: PlayerColor,
    expected: GameStatus,
) -> None:
    surviving_owner = (
        PlayerColor.BLACK
        if eliminated_owner == PlayerColor.WHITE
        else PlayerColor.WHITE
    )
    eliminated_pieces = tuple(
        make_piece(
            f"{eliminated_owner.value.lower()}_{piece_type.value.lower()}_{index}",
            eliminated_owner,
            piece_type,
            captured=True,
        )
        for index, piece_type in enumerate(
            [
                PieceType.EXPLORER,
                PieceType.EXPLORER,
                PieceType.VANGUARD,
                PieceType.VANGUARD,
                PieceType.SENTINEL,
                PieceType.SENTINEL,
            ]
        )
    )
    survivor = make_piece("survivor", surviving_owner)

    assert (
        evaluate_victory(make_state(pieces=(*eliminated_pieces, survivor))) == expected
    )


def test_exited_piece_does_not_count_as_captured_for_elimination() -> None:
    pieces = (
        make_piece("black_explorer_1", PlayerColor.BLACK, finished=True),
        make_piece("black_explorer_2", PlayerColor.BLACK, captured=True),
        make_piece("white_explorer_1", PlayerColor.WHITE),
    )

    assert (
        evaluate_victory(make_state(pieces=pieces, exited_pieces=1))
        == GameStatus.ONGOING
    )


@pytest.mark.parametrize(
    ("white_score", "black_score", "expected"),
    [
        (3, 1, GameStatus.WHITE_WINS),
        (1, 3, GameStatus.BLACK_WINS),
        (2, 2, GameStatus.DRAW),
    ],
)
def test_second_exit_resolves_by_score(
    white_score: int,
    black_score: int,
    expected: GameStatus,
) -> None:
    state = make_state(
        white_score=white_score,
        black_score=black_score,
        exited_pieces=2,
    )

    assert evaluate_victory(state) == expected


def test_turn_limit_uses_distance_when_no_one_scored() -> None:
    white = make_piece(
        "white_explorer",
        PlayerColor.WHITE,
        row=7,
    )
    black = make_piece(
        "black_explorer",
        PlayerColor.BLACK,
        row=3,
    )
    state = make_state(
        pieces=(white, black),
        turn_count=200,
    )

    assert evaluate_victory(state) == GameStatus.WHITE_WINS


def test_turn_limit_uses_force_when_distance_is_tied() -> None:
    white = make_piece(
        "white_sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        row=8,
    )
    black = make_piece(
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        row=1,
    )
    state = make_state(
        pieces=(white, black),
        turn_count=200,
    )

    assert evaluate_victory(state) == GameStatus.WHITE_WINS


def test_turn_limit_draw_when_distance_and_force_are_tied() -> None:
    white = make_piece(
        "white_explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        row=8,
    )
    black = make_piece(
        "black_explorer",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        row=1,
    )
    state = make_state(
        pieces=(white, black),
        turn_count=200,
    )

    assert evaluate_victory(state) == GameStatus.DRAW
