from veylith.api.serialize import deserialize_game_state, serialize_game_state
from veylith.domain.enums import PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Position
from veylith.domain.victory import GameStatus


def test_round_trip_preserves_mid_turn_state_and_legal_moves() -> None:
    game = Game()
    game.move_piece("white_explorer_1", Position(1, 2))

    restored = deserialize_game_state(serialize_game_state(game))

    assert restored.current_player == game.current_player == PlayerColor.WHITE
    assert restored.turn_count == game.turn_count
    assert restored.movement_spent == game.movement_spent
    assert restored.turn_start_positions == game.turn_start_positions
    assert restored.visited_positions == game.visited_positions
    assert restored.moved_piece_ids == game.moved_piece_ids
    assert restored.scores == game.scores
    assert restored.get_legal_paths("white_explorer_1") == game.get_legal_paths(
        "white_explorer_1"
    )


def test_round_trip_preserves_captured_and_exited_pieces() -> None:
    game = Game()
    sentinel = game.pieces["white_sentinel_5"]
    game.board.remove_piece(sentinel.id)
    sentinel.captured = True

    restored = deserialize_game_state(serialize_game_state(game))

    assert restored.pieces[sentinel.id].captured is True
    assert sentinel.id not in restored.board.pieces


def test_round_trip_preserves_tied_scores_and_draw_result() -> None:
    game = Game()
    game.scores = {PlayerColor.WHITE: 2, PlayerColor.BLACK: 2}
    game.exited_pieces = 2

    restored = deserialize_game_state(serialize_game_state(game))

    assert restored.scores == game.scores
    assert restored.get_victory_status() == GameStatus.DRAW


def test_deserializer_rejects_invalid_state() -> None:
    try:
        deserialize_game_state({"schema_version": 1})
    except ValueError as exc:
        assert "état" in str(exc)
    else:
        raise AssertionError("Un état incomplet doit être refusé.")
