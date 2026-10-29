from conftest import USER_A, USER_B, USER_C


def test_current_user_can_read_and_update_username(client):
    profile = client.get("/api/users/me")
    assert profile.status_code == 200
    assert profile.json()["username"] == "alexandre"

    updated = client.patch("/api/users/me", json={"username": "joueur_test"})
    assert updated.status_code == 200
    assert updated.json()["username"] == "joueur_test"


def test_username_update_rejects_invalid_or_taken_names(client):
    invalid = client.patch("/api/users/me", json={"username": "bad name"})
    assert invalid.status_code == 422

    taken = client.patch("/api/users/me", json={"username": "amie_test"})
    assert taken.status_code == 409


def test_rematch_requires_live_opponent_and_is_cancelled_when_they_leave(
    client, as_user, start_game
):
    source = client.post("/api/games", json={"mode": "online"}).json()
    game_id = source["game_id"]
    start_game(game_id)
    state = client.app.state.test_state
    state["games"][game_id]["status"] = "finished"

    assert (
        client.put(
            f"/api/games/{game_id}/rematch-presence", json={"available": True}
        ).status_code
        == 204
    )
    as_user(USER_B)
    assert (
        client.put(
            f"/api/games/{game_id}/rematch-presence", json={"available": True}
        ).status_code
        == 204
    )

    as_user(USER_A)
    status_response = client.get(f"/api/games/{game_id}/rematch-status")
    assert status_response.status_code == 200
    assert status_response.json()["opponent_available"] is True

    invitation = client.post(f"/api/games/{game_id}/rematches")
    assert invitation.status_code == 201
    assert invitation.json()["source_game_id"] == game_id
    assert invitation.json()["status"] == "pending"

    as_user(USER_B)
    assert (
        client.put(
            f"/api/games/{game_id}/rematch-presence", json={"available": False}
        ).status_code
        == 204
    )
    as_user(USER_A)
    status_response = client.get(f"/api/games/{game_id}/rematch-status")
    assert status_response.json()["opponent_available"] is False
    assert status_response.json()["outgoing_invitation"]["status"] == "cancelled"


def test_search_users_returns_public_profile_fields_only(client):
    response = client.get("/api/users/search?q=amie")

    assert response.status_code == 200
    assert response.json() == [
        {"id": USER_B, "username": "amie_test", "avatar_url": None}
    ]
    assert "email" not in response.text


def test_search_users_accepts_an_exact_account_id(client):
    response = client.get(f"/api/users/search?q={USER_B}")

    assert response.status_code == 200
    assert response.json()[0]["id"] == USER_B


def test_friend_request_can_be_accepted_and_listed(client, as_user):
    sent = client.post("/api/friends/requests", json={"addressee_id": USER_B})
    assert sent.status_code == 201
    request_id = sent.json()["id"]

    as_user(USER_B)
    pending = client.get("/api/friends/requests")
    assert pending.status_code == 200
    assert pending.json()[0]["id"] == request_id

    accepted = client.post(f"/api/friends/requests/{request_id}/accept")
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"
    assert client.get("/api/friends").json()[0]["requester_id"] == USER_A


def test_only_addressee_can_respond_to_friend_request(client, as_user):
    sent = client.post("/api/friends/requests", json={"addressee_id": USER_B})
    request_id = sent.json()["id"]
    as_user(USER_C)

    response = client.post(f"/api/friends/requests/{request_id}/accept")

    assert response.status_code == 404


def test_friend_request_can_be_rejected(client, as_user):
    sent = client.post("/api/friends/requests", json={"addressee_id": USER_B})
    request_id = sent.json()["id"]
    as_user(USER_B)

    response = client.post(f"/api/friends/requests/{request_id}/reject")

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"


def test_friend_invitation_acceptance_assigns_black_and_starts_game(client, as_user):
    friend_request = client.post(
        "/api/friends/requests", json={"addressee_id": USER_B}
    ).json()
    as_user(USER_B)
    assert (
        client.post(f"/api/friends/requests/{friend_request['id']}/accept").status_code
        == 200
    )

    as_user(USER_A)
    game_id = client.post("/api/games").json()["game_id"]
    invite = client.post(
        f"/api/games/{game_id}/invitations",
        json={"invitee_id": USER_B},
    )
    assert invite.status_code == 201
    invitation_id = invite.json()["id"]

    as_user(USER_B)
    pending = client.get("/api/games/invitations")
    assert pending.status_code == 200
    assert pending.json()[0]["id"] == invitation_id
    accepted = client.post(f"/api/games/invitations/{invitation_id}/accept")

    assert accepted.status_code == 200
    assert accepted.json()["color"] == "black"
    assert client.get(f"/api/games/{game_id}").json()["lifecycle_status"] == "ongoing"


def test_invitation_requires_accepted_friendship(client):
    game_id = client.post("/api/games").json()["game_id"]

    response = client.post(
        f"/api/games/{game_id}/invitations", json={"invitee_id": USER_C}
    )

    assert response.status_code == 403


def test_invalid_user_search_query_is_rejected(client):
    response = client.get("/api/users/search?q=x")

    assert response.status_code == 422
