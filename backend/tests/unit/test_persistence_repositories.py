from types import SimpleNamespace

import pytest

from veylith.api.serialize import serialize_game_state
from veylith.domain.enums import PlayerColor
from veylith.domain.game import Game
from veylith.persistence import games, social
from veylith.persistence.games import (
    GameAccessError,
    GameConflictError,
    GameNotFoundError,
    GamePersistenceError,
)
from veylith.persistence.social import SocialPersistenceError


class FakeRpc:
    def __init__(self, data=None, error=None):
        self.data = data
        self.error = error

    def execute(self):
        if self.error:
            raise self.error
        return SimpleNamespace(data=self.data)


class FakeClient:
    def __init__(self, rpc_data=None, rpc_error=None):
        self.rpc_calls = []
        self.rpc_data = rpc_data
        self.rpc_error = rpc_error

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return FakeRpc(self.rpc_data, self.rpc_error)


class FakeDatabaseError(Exception):
    def __init__(self, code):
        super().__init__("database error")
        self.code = code


def test_create_game_uses_atomic_rpc_and_persists_initial_state(monkeypatch):
    client = FakeClient(rpc_data="00000000-0000-4000-8000-000000000011")
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    game_id, game = games.create_game("00000000-0000-4000-8000-000000000001")

    rpc_name, params = client.rpc_calls[0]
    assert rpc_name == "create_veylith_game"
    assert game_id == client.rpc_data
    assert params["p_game_state"] == serialize_game_state(game)
    assert len({value for row in game.board.heights for value in row}) > 1
    assert params["p_game_state"]["board"]["heights"] == game.board.heights
    assert "p_mode" not in params


def test_create_local_game_calls_local_mode_rpc(monkeypatch):
    client = FakeClient(rpc_data="00000000-0000-4000-8000-000000000012")
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    games.create_game("00000000-0000-4000-8000-000000000001", mode="local")

    rpc_name, params = client.rpc_calls[0]
    assert rpc_name == "create_veylith_game_v2"
    assert params["p_mode"] == "local"


def test_find_or_create_match_creates_public_waiting_game(monkeypatch):
    client = FakeClient(
        rpc_data=[
            {
                "game_id": "00000000-0000-4000-8000-000000000031",
                "lifecycle_status": "waiting",
                "player_color": "white",
            }
        ]
    )
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)
    persisted_game = Game()
    monkeypatch.setattr(
        games,
        "load_game",
        lambda _game_id, _user_id: (
            persisted_game,
            0,
            "waiting",
            "white",
            "player",
            "online",
            "public",
        ),
    )

    game_id, game, lifecycle_status, color = games.find_or_create_match("user-id")

    rpc_name, params = client.rpc_calls[0]
    assert rpc_name == "find_or_create_veylith_match"
    assert game_id == "00000000-0000-4000-8000-000000000031"
    assert lifecycle_status == "waiting"
    assert color == "white"
    assert (
        len(
            {
                value
                for row in params["p_game_state"]["board"]["heights"]
                for value in row
            }
        )
        > 1
    )
    assert game is persisted_game


def test_save_game_action_persists_snapshot_and_expected_version(monkeypatch):
    client = FakeClient(rpc_data=1)
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)
    game = Game()

    games.save_game_action(
        game_id="00000000-0000-4000-8000-000000000011",
        actor_id="00000000-0000-4000-8000-000000000001",
        action_type="move",
        payload={"piece_id": "white_explorer_1"},
        game=game,
        expected_version=4,
    )

    rpc_name, params = client.rpc_calls[0]
    assert rpc_name == "record_veylith_game_action"
    assert params["p_action_type"] == "move"
    assert params["p_expected_version"] == 4
    assert params["p_payload"] == {"piece_id": "white_explorer_1"}
    assert params["p_state_after"] == serialize_game_state(game)


def test_save_game_action_marks_elimination_win_as_finished(monkeypatch):
    client = FakeClient(rpc_data=1)
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)
    game = Game()
    for piece in game.pieces.values():
        if piece.owner == PlayerColor.BLACK:
            piece.captured = True
            piece.position = None
    game.board.pieces = {
        piece_id: piece
        for piece_id, piece in game.board.pieces.items()
        if piece.owner != PlayerColor.BLACK
    }

    games.save_game_action(
        game_id="00000000-0000-4000-8000-000000000011",
        actor_id="00000000-0000-4000-8000-000000000001",
        action_type="attack",
        payload={"defender_id": "black_explorer_1"},
        game=game,
        expected_version=4,
    )

    _, params = client.rpc_calls[0]
    assert params["p_status"] == "finished"
    assert params["p_state_after"]["status"] == "WHITE_WINS"


def test_save_game_action_translates_stale_version_to_conflict(monkeypatch):
    client = FakeClient(rpc_error=FakeDatabaseError("40001"))
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    with pytest.raises(GameConflictError):
        games.save_game_action(
            game_id="00000000-0000-4000-8000-000000000011",
            actor_id="00000000-0000-4000-8000-000000000001",
            action_type="end_turn",
            payload={},
            game=Game(),
            expected_version=0,
        )


def test_send_friend_request_uses_server_rpc(monkeypatch):
    relation = {
        "id": "00000000-0000-4000-8000-000000000021",
        "requester_id": "00000000-0000-4000-8000-000000000001",
        "addressee_id": "00000000-0000-4000-8000-000000000002",
        "status": "pending",
    }
    client = FakeClient(rpc_data=relation)
    monkeypatch.setattr(social, "get_supabase_admin_client", lambda: client)

    result = social.create_friend_request(
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
    )

    assert result == relation
    assert client.rpc_calls[0][0] == "send_veylith_friend_request"


def test_friend_request_duplicate_maps_to_conflict(monkeypatch):
    client = FakeClient(rpc_error=FakeDatabaseError("23505"))
    monkeypatch.setattr(social, "get_supabase_admin_client", lambda: client)

    with pytest.raises(SocialPersistenceError) as error:
        social.create_friend_request("user-a", "user-b")

    assert error.value.status_code == 409


def test_game_action_history_returns_rows_in_chronological_order(monkeypatch):
    expected = [
        {"action_number": 1, "action_type": "move", "payload": {"n": 1}},
        {"action_number": 2, "action_type": "end_turn", "payload": {}},
    ]

    class ActionQuery:
        def __init__(self):
            self.operations = []

        def select(self, columns):
            self.operations.append(("select", columns))
            return self

        def eq(self, key, value):
            self.operations.append(("eq", key, value))
            return self

        def order(self, key):
            self.operations.append(("order", key))
            return self

        def execute(self):
            return SimpleNamespace(data=expected)

    query = ActionQuery()
    client = SimpleNamespace(table=lambda name: query)
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    assert games.list_game_actions("game-id") == expected
    assert ("eq", "game_id", "game-id") in query.operations
    assert ("order", "action_number") in query.operations


@pytest.mark.parametrize("result", [None, {"action_number": 1}])
def test_game_action_history_rejects_invalid_database_payload(monkeypatch, result):
    class Query:
        def select(self, _columns):
            return self

        def eq(self, _key, _value):
            return self

        def order(self, _key):
            return self

        def execute(self):
            return SimpleNamespace(data=result)

    monkeypatch.setattr(
        games,
        "get_supabase_admin_client",
        lambda: SimpleNamespace(table=lambda _name: Query()),
    )

    with pytest.raises(GamePersistenceError, match="historique"):
        games.list_game_actions("game-id")


class FakeQuery:
    def __init__(self, result):
        self.result = result
        self.filters = {}

    def select(self, _columns):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def maybe_single(self):
        return self

    def execute(self):
        return SimpleNamespace(data=self.result)


class FakeTableClient:
    def __init__(self, responses):
        self.responses = responses
        self.tables = []

    def table(self, name):
        self.tables.append(name)
        return FakeQuery(self.responses.get(name))


class FakeListQuery:
    def __init__(self, result):
        self.result = result

    def select(self, _columns):
        return self

    def eq(self, _key, _value):
        return self

    def in_(self, _key, _values):
        return self

    def order(self, _key, desc=False):
        return self

    def range(self, _start, _end):
        return self

    def execute(self):
        return SimpleNamespace(data=self.result)


class FakeGameListClient:
    def __init__(self):
        self.calls = 0

    def table(self, name):
        self.calls += 1
        if name == "game_players":
            if self.calls == 1:
                return FakeListQuery(
                    [{"game_id": "game-id", "color": "white", "user_id": "user-id"}]
                )
            return FakeListQuery(
                [
                    {"game_id": "game-id", "user_id": "user-id"},
                    {"game_id": "game-id", "user_id": "opponent-id"},
                ]
            )
        if name == "profiles":
            return FakeListQuery([{"id": "opponent-id", "username": "adversaire"}])
        return FakeListQuery(
            [
                {
                    "id": "game-id",
                    "mode": "online",
                    "visibility": "public",
                    "status": "ongoing",
                    "current_player": "white",
                    "turn_count": 3,
                    "created_at": "2026-10-26T12:00:00Z",
                    "started_at": "2026-10-26T12:01:00Z",
                    "finished_at": None,
                    "game_state": {"status": "ONGOING"},
                }
            ]
        )


def test_list_games_normalizes_database_color_for_api_schema(monkeypatch):
    client = FakeGameListClient()
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    result = games.list_games("user-id")

    assert result[0]["my_color"] == "WHITE"
    assert result[0]["current_player"] == "WHITE"
    assert result[0]["visibility"] == "public"
    assert result[0]["opponent_username"] == "adversaire"
    assert result[0]["started_at"] == "2026-10-26T12:01:00Z"
    assert result[0]["result"] is None


def test_load_game_checks_membership_and_restores_the_engine(monkeypatch):
    game = Game()
    client = FakeTableClient(
        {
            "games": {
                "id": "00000000-0000-4000-8000-000000000011",
                "created_by": "00000000-0000-4000-8000-000000000001",
                "game_state": serialize_game_state(game),
                "version": 2,
                "status": "ongoing",
                "current_player": "white",
                "mode": "online",
                "visibility": "private",
            },
            "game_players": {
                "user_id": "00000000-0000-4000-8000-000000000001",
                "color": "white",
                "role": "player",
            },
        }
    )
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    restored, version, lifecycle, color, role, mode, visibility = games.load_game(
        "game-id", "user-id"
    )

    assert restored.current_player == game.current_player
    assert version == 2
    assert lifecycle == "ongoing"
    assert color == "white"
    assert role == "player"
    assert mode == "online"
    assert visibility == "private"
    assert client.tables == ["games", "game_players"]


def test_load_game_denies_non_participant(monkeypatch):
    game = Game()
    client = FakeTableClient(
        {
            "games": {
                "id": "game-id",
                "game_state": serialize_game_state(game),
                "version": 0,
                "status": "waiting",
                "current_player": "white",
                "mode": "online",
                "visibility": "private",
            },
            "game_players": None,
        }
    )
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    with pytest.raises(GameAccessError):
        games.load_game("game-id", "outsider")


def test_load_game_returns_not_found_for_unknown_id(monkeypatch):
    client = FakeTableClient({"games": None})
    monkeypatch.setattr(games, "get_supabase_admin_client", lambda: client)

    with pytest.raises(GameNotFoundError):
        games.load_game("missing", "user-id")
