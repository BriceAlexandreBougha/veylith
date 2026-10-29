def test_legal_moves_for_unknown_game_returns_404(client):
    response = client.get("/api/games/unknown-game/legal-moves/white_explorer_1")

    assert response.status_code == 404


def test_move_outside_board_is_rejected(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.post(
        f"/api/games/{game_id}/moves",
        json={
            "piece_id": "white_explorer_1",
            "destination": {"row": -1, "col": -1},
        },
    )
    assert response.status_code == 400


def test_move_with_empty_piece_id_returns_422(client):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]

    response = client.post(
        f"/api/games/{game_id}/moves",
        json={
            "piece_id": "",
            "destination": {"row": 1, "col": 2},
        },
    )

    assert response.status_code == 422
