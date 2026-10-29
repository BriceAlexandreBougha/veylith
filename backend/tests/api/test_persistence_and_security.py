from conftest import USER_A, USER_B, USER_C

from veylith.api import routes_games
from veylith.domain.game import Game


def test_waiting_game_is_readable_but_cannot_be_played(client):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]

    response = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_explorer_1", "destination": {"row": 1, "col": 2}},
    )

    assert response.status_code == 409


def test_local_game_lets_one_user_control_both_colors(client):
    created = client.post("/api/games", json={"mode": "local"})
    assert created.status_code == 201
    game_id = created.json()["game_id"]
    assert created.json()["mode"] == "local"
    assert created.json()["lifecycle_status"] == "ongoing"

    first_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_sentinel_5", "destination": {"row": 1, "col": 2}},
    )
    assert first_move.status_code == 200
    first_turn = client.post(f"/api/games/{game_id}/end-turn")
    assert first_turn.status_code == 200
    assert first_turn.json()["current_player"] == "BLACK"
    assert first_turn.json()["my_color"] == "BLACK"
    black_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "black_sentinel_5", "destination": {"row": 8, "col": 2}},
    )
    assert black_move.status_code == 200
    second_turn = client.post(f"/api/games/{game_id}/end-turn")

    assert first_turn.status_code == 200
    assert first_turn.json()["current_player"] == "BLACK"
    assert second_turn.status_code == 200
    assert second_turn.json()["current_player"] == "WHITE"
    assert second_turn.json()["my_color"] == "WHITE"


def test_online_second_player_can_take_turn_after_first_player_finishes(
    client, start_game, as_user
):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    white_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_sentinel_5", "destination": {"row": 1, "col": 2}},
    )
    assert white_move.status_code == 200
    first_turn = client.post(f"/api/games/{game_id}/end-turn")
    assert first_turn.status_code == 200
    assert first_turn.json()["current_player"] == "BLACK"

    as_user(USER_B)
    black_state = client.get(f"/api/games/{game_id}")
    assert black_state.status_code == 200
    assert black_state.json()["current_player"] == "BLACK"
    assert black_state.json()["my_color"] == "BLACK"

    black_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "black_sentinel_5", "destination": {"row": 8, "col": 2}},
    )
    assert black_move.status_code == 200
    second_turn = client.post(f"/api/games/{game_id}/end-turn")
    assert second_turn.status_code == 200
    assert second_turn.json()["current_player"] == "WHITE"


def test_non_participant_cannot_read_private_game(client, as_user):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    as_user(USER_C)

    response = client.get(f"/api/games/{game_id}")

    assert response.status_code == 403


def test_game_list_only_contains_participant_games(client, as_user):
    owned_game = client.post("/api/games").json()["game_id"]
    as_user(USER_B)
    other_game = client.post("/api/games").json()["game_id"]

    as_user(USER_A)
    response = client.get("/api/games")

    assert response.status_code == 200
    assert [game["game_id"] for game in response.json()] == [owned_game]
    assert other_game not in response.text


def test_game_list_supports_limit_and_offset(client):
    first_game = client.post("/api/games").json()["game_id"]
    second_game = client.post("/api/games").json()["game_id"]

    response = client.get("/api/games?limit=1&offset=1")

    assert response.status_code == 200
    assert [game["game_id"] for game in response.json()] == [second_game]
    assert first_game not in response.text


def test_matchmaking_route_returns_a_public_waiting_game(client, monkeypatch):
    game_id = "00000000-0000-4000-8000-000000000031"
    monkeypatch.setattr(
        routes_games,
        "find_or_create_match",
        lambda _user_id: (game_id, Game(), "waiting", "white"),
    )

    response = client.post("/api/games/matchmaking")

    assert response.status_code == 200
    assert response.json()["game_id"] == game_id
    assert response.json()["visibility"] == "public"
    assert response.json()["lifecycle_status"] == "waiting"


def test_only_active_color_can_make_a_move(client, start_game, as_user):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)
    moved = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_sentinel_5", "destination": {"row": 1, "col": 2}},
    )
    assert moved.status_code == 200
    client.post(f"/api/games/{game_id}/end-turn")

    response = client.post(
        f"/api/games/{game_id}/end-turn",
    )

    assert response.status_code == 403
    as_user(USER_B)
    moved = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "black_sentinel_5", "destination": {"row": 8, "col": 2}},
    )
    assert moved.status_code == 200
    response = client.post(f"/api/games/{game_id}/end-turn")
    assert response.status_code == 200


def test_action_is_saved_to_history(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.post(
        f"/api/games/{game_id}/moves",
        json={
            "piece_id": "white_explorer_1",
            "destination": {"row": 1, "col": 2},
        },
    )

    assert response.status_code == 200
    actions = client.app.state.test_state["actions"][game_id]
    assert len(actions) == 1
    assert actions[0]["action_type"] == "move"
    assert actions[0]["actor_id"] == USER_A


def test_abandonment_is_explicit_and_recorded(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.post(f"/api/games/{game_id}/abandon")

    assert response.status_code == 200
    assert response.json()["lifecycle_status"] == "abandoned"
    assert response.json()["scores"] == {"WHITE": 0, "BLACK": 0}
    assert (
        client.app.state.test_state["actions"][game_id][-1]["action_type"] == "abandon"
    )


def test_read_after_interruption_does_not_mark_game_abandoned(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.get(f"/api/games/{game_id}")

    assert response.status_code == 200
    assert response.json()["lifecycle_status"] == "ongoing"
    assert response.json()["lifecycle_status"] != "abandoned"
