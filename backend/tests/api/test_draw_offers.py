from conftest import USER_A, USER_B, USER_C


def test_online_draw_offer_requires_and_records_opponent_acceptance(
    client, start_game, as_user
):
    game_id = client.post("/api/games").json()["game_id"]
    start_game(game_id)

    proposal = client.post(f"/api/games/{game_id}/draw-offers")

    assert proposal.status_code == 200
    assert proposal.json()["proposer_id"] == USER_A
    assert proposal.json()["status"] == "pending"

    as_user(USER_B)
    pending = client.get(f"/api/games/{game_id}/draw-offer")
    assert pending.status_code == 200
    assert pending.json()["id"] == proposal.json()["id"]

    answer = client.post(
        f"/api/games/{game_id}/draw-offers/{proposal.json()['id']}/respond",
        json={"accept": True},
    )

    assert answer.status_code == 200
    assert answer.json()["offer"]["status"] == "accepted"
    assert answer.json()["game"]["status"] == "DRAW"
    assert answer.json()["game"]["lifecycle_status"] == "finished"
    assert (
        client.app.state.test_state["actions"][game_id][-1]["action_type"]
        == "draw_agreed"
    )


def test_only_the_other_player_can_respond_to_a_draw_offer(client, start_game):
    game_id = client.post("/api/games").json()["game_id"]
    start_game(game_id)
    proposal = client.post(f"/api/games/{game_id}/draw-offers").json()

    response = client.post(
        f"/api/games/{game_id}/draw-offers/{proposal['id']}/respond",
        json={"accept": True},
    )

    assert response.status_code == 403


def test_draw_offer_is_not_available_to_spectators(client, start_game, as_user):
    game_id = client.post("/api/games").json()["game_id"]
    start_game(game_id)
    as_user(USER_C)

    response = client.post(f"/api/games/{game_id}/draw-offers")

    assert response.status_code == 403


def test_local_game_does_not_allow_draw_offers(client):
    game_id = client.post("/api/games", json={"mode": "local"}).json()["game_id"]

    response = client.post(f"/api/games/{game_id}/draw-offers")

    assert response.status_code == 409
