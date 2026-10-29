from conftest import USER_A, USER_B


def test_waiting_search_cancellation_deletes_game_from_history(client):
    created = client.post("/api/games", json={"mode": "online"}).json()
    game_id = created["game_id"]

    cancelled = client.delete(f"/api/games/{game_id}/waiting")

    assert cancelled.status_code == 204
    assert client.get("/api/games").json() == []


def test_waiting_search_cannot_be_deleted_after_opponent_joins(client, start_game):
    created = client.post("/api/games", json={"mode": "online"}).json()
    game_id = created["game_id"]
    start_game(game_id)

    cancelled = client.delete(f"/api/games/{game_id}/waiting")

    assert cancelled.status_code == 409
    assert client.get(f"/api/games/{game_id}").status_code == 200


def test_game_presence_heartbeat_and_opponent_connection_status(
    client, as_user, start_game
):
    created = client.post("/api/games", json={"mode": "online"}).json()
    game_id = created["game_id"]
    start_game(game_id)

    heartbeat = client.put(f"/api/games/{game_id}/presence")
    assert heartbeat.status_code == 204

    as_user(USER_B)
    state = client.app.state.test_state
    state["connection_status"][(game_id, USER_A)] = "reconnecting"
    status = client.get(f"/api/games/{game_id}/connection")

    assert status.status_code == 200
    assert status.json() == {
        "opponent_id": USER_A,
        "status": "reconnecting",
        "seconds_until_forfeit": 30,
    }


def test_mutual_rematch_clicks_start_the_same_new_game(client, as_user, start_game):
    source = client.post("/api/games", json={"mode": "online"}).json()
    source_id = source["game_id"]
    start_game(source_id)
    client.app.state.test_state["games"][source_id]["status"] = "finished"

    client.put(f"/api/games/{source_id}/rematch-presence", json={"available": True})
    as_user(USER_B)
    client.put(f"/api/games/{source_id}/rematch-presence", json={"available": True})

    as_user(USER_A)
    first_offer = client.post(f"/api/games/{source_id}/rematches").json()
    as_user(USER_B)
    paired = client.post(f"/api/games/{source_id}/rematches")

    assert paired.status_code == 201
    assert paired.json()["status"] == "accepted"
    assert paired.json()["game_id"] == first_offer["game_id"]
    new_game = client.app.state.test_state["games"][paired.json()["game_id"]]
    assert new_game["status"] == "ongoing"
    assert set(new_game["players"]) == {USER_A, USER_B}

    # The newly created match can itself be used as the source for another
    # rematch, with no fixed replay limit.
    next_source_id = paired.json()["game_id"]
    new_game["status"] = "finished"
    as_user(USER_A)
    client.put(
        f"/api/games/{next_source_id}/rematch-presence", json={"available": True}
    )
    as_user(USER_B)
    client.put(
        f"/api/games/{next_source_id}/rematch-presence", json={"available": True}
    )
    as_user(USER_A)
    second_offer = client.post(f"/api/games/{next_source_id}/rematches").json()
    as_user(USER_B)
    second_pairing = client.post(f"/api/games/{next_source_id}/rematches")

    assert second_pairing.status_code == 201
    assert second_pairing.json()["status"] == "accepted"
    assert second_pairing.json()["game_id"] == second_offer["game_id"]
    second_game = client.app.state.test_state["games"][second_offer["game_id"]]
    assert second_game["status"] == "ongoing"
    assert set(second_game["players"]) == {USER_A, USER_B}
