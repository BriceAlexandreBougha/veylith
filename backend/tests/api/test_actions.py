from veylith.domain.enums import PlayerColor
from veylith.domain.models import Position


def test_attack_unknown_game_returns_404(client):
    response = client.post(
        "/api/games/unknown/attacks",
        json={
            "attacker_id": "white_explorer_1",
            "defender_id": "black_explorer_1",
        },
    )

    assert response.status_code == 404


def test_exit_unknown_game_returns_404(client):
    response = client.post(
        "/api/games/unknown/exit",
        json={"piece_id": "white_explorer_1"},
    )

    assert response.status_code == 404


def test_end_turn_changes_player(client, start_game):
    create_response = client.post("/api/games")
    assert create_response.status_code == 201

    game_id = create_response.json()["game_id"]
    start_game(game_id)
    initial_player = create_response.json()["current_player"]
    move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_sentinel_5", "destination": {"row": 1, "col": 2}},
    )
    assert move.status_code == 200

    response = client.post(f"/api/games/{game_id}/end-turn")

    assert response.status_code == 200
    assert response.json()["current_player"] != initial_player
    assert response.json()["turn_count"] == 1


def test_online_player_cannot_move_another_piece_during_the_same_turn(
    client, start_game
):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    first_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_sentinel_5", "destination": {"row": 1, "col": 2}},
    )
    second_move = client.post(
        f"/api/games/{game_id}/moves",
        json={"piece_id": "white_vanguard_3", "destination": {"row": 1, "col": 3}},
    )

    assert first_move.status_code == 200
    assert first_move.json()["moved_piece_id"] == "white_sentinel_5"
    assert second_move.status_code == 400
    assert "même pièce" in second_move.json()["detail"]


def test_online_player_cannot_end_turn_without_moving(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.post(f"/api/games/{game_id}/end-turn")

    assert response.status_code == 400
    assert "déplacer au moins une pièce" in response.json()["detail"]


def test_attack_missing_fields_returns_422(client):
    create_response = client.post("/api/games")
    game_id = create_response.json()["game_id"]

    response = client.post(
        f"/api/games/{game_id}/attacks",
        json={},
    )

    assert response.status_code == 422


def test_capturing_last_opponent_piece_finishes_the_persisted_game(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    state = client.app.state.test_state
    game = state["games"][game_id]["game"]
    for piece in game.pieces.values():
        if piece.owner == PlayerColor.BLACK and piece.id != "black_explorer_1":
            piece.captured = True
            piece.position = None

    game.pieces["white_sentinel_5"].position = Position(4, 4)
    game.pieces["black_explorer_1"].position = Position(4, 5)
    game.board.pieces = {
        piece.id: piece
        for piece in game.pieces.values()
        if piece.position is not None and not piece.captured and not piece.finished
    }

    response = client.post(
        f"/api/games/{game_id}/attacks",
        json={
            "attacker_id": "white_sentinel_5",
            "defender_id": "black_explorer_1",
        },
    )

    assert response.status_code == 200
    assert response.json()["game"]["lifecycle_status"] == "finished"
    assert response.json()["game"]["winner"] == "WHITE"
    assert state["games"][game_id]["status"] == "finished"
