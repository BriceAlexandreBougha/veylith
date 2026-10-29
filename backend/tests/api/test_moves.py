def test_get_legal_moves_returns_paths(client, start_game):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]
    start_game(game_id)

    response = client.get(f"/api/games/{game_id}/legal-moves/white_explorer_1")

    assert response.status_code == 200
    assert isinstance(response.json(), list)

    for path in response.json():
        assert "start" in path
        assert "destination" in path
        assert "path" in path
        assert "cost" in path


def test_move_piece_updates_state(client, start_game):
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

    data = response.json()
    piece = next(p for p in data["pieces"] if p["id"] == "white_explorer_1")

    assert piece["position"] == {"row": 1, "col": 2}


def test_move_unknown_game_returns_404(client):
    response = client.post(
        "/api/games/unknown-game/moves",
        json={
            "piece_id": "white_explorer_1",
            "destination": {"row": 1, "col": 2},
        },
    )

    assert response.status_code == 404


def test_move_missing_piece_id_returns_422(client):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]

    response = client.post(
        f"/api/games/{game_id}/moves",
        json={
            "destination": {"row": 1, "col": 2},
        },
    )

    assert response.status_code == 422
