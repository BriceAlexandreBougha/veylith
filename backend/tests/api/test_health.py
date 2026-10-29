def test_create_game_returns_initial_state(client):
    response = client.post("/api/games")

    assert response.status_code == 201

    data = response.json()

    assert data["game_id"]
    assert data["board_size"] == 10
    assert len(data["pieces"]) == 12
    assert data["current_player"] == "WHITE"
    assert data["status"] == "ONGOING"
    assert data["lifecycle_status"] == "waiting"
    assert isinstance(data["heights"], list)


def test_create_two_games_returns_different_ids(client):
    first = client.post("/api/games")
    second = client.post("/api/games")

    assert first.status_code == 201
    assert second.status_code == 201

    assert first.json()["game_id"] != second.json()["game_id"]


def test_get_game_returns_same_initial_state(client):
    created = client.post("/api/games")
    game_id = created.json()["game_id"]

    response = client.get(f"/api/games/{game_id}")

    assert response.status_code == 200
    assert response.json()["game_id"] == game_id
    assert response.json()["pieces"] == created.json()["pieces"]
    assert response.json()["current_player"] == "WHITE"
    assert response.json()["lifecycle_status"] == "waiting"


def test_get_unknown_game_returns_404(client):
    response = client.get("/api/games/unknown-game")

    assert response.status_code == 404
