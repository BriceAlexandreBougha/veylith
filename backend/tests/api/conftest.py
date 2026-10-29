from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from veylith.api import routes_games, routes_social
from veylith.api.app import app
from veylith.auth.dependencies import get_current_user
from veylith.domain.game import Game
from veylith.domain.victory import GameStatus
from veylith.persistence.games import (
    GameAccessError,
    GameConflictError,
    GameNotFoundError,
)
from veylith.persistence.social import SocialPersistenceError

USER_A = "00000000-0000-4000-8000-000000000001"
USER_B = "00000000-0000-4000-8000-000000000002"
USER_C = "00000000-0000-4000-8000-000000000003"


@pytest.fixture
def client(monkeypatch):
    state = {
        "user_id": USER_A,
        "games": {},
        "friends": [],
        "invitations": [],
        "rematch_presence": {},
        "connection_status": {},
        "draw_offers": [],
        "actions": {},
        "profiles": [
            {"id": USER_A, "username": "alexandre", "avatar_url": None},
            {"id": USER_B, "username": "amie_test", "avatar_url": None},
            {"id": USER_C, "username": "autre_test", "avatar_url": None},
        ],
    }

    def fake_current_user() -> dict[str, str]:
        return {"id": state["user_id"], "email": "test@example.com"}

    def fake_create_game(owner_id: str, mode: str = "online") -> tuple[str, Game]:
        game_id = str(uuid4())
        game = Game()
        state["games"][game_id] = {
            "game": deepcopy(game),
            "version": 0,
            "status": "ongoing" if mode == "local" else "waiting",
            "mode": mode,
            "players": {owner_id: ("white", "player")},
        }
        state["actions"][game_id] = []
        return game_id, game

    def fake_list_games(user_id: str, *, limit: int = 50, offset: int = 0):
        games = [
            {
                "game_id": game_id,
                "lifecycle_status": row["status"],
                "mode": row["mode"],
                "visibility": row.get("visibility", "private"),
                "my_color": "WHITE",
                "current_player": row["game"].current_player.value,
                "turn_count": row["game"].turn_count,
                "created_at": "2026-01-01T00:00:00Z",
            }
            for game_id, row in state["games"].items()
            if user_id in row["players"]
        ]
        return games[offset : offset + limit]

    def fake_load_game(game_id: str, user_id: str):
        row = state["games"].get(game_id)
        if row is None:
            raise GameNotFoundError
        player = row["players"].get(user_id)
        if player is None:
            raise GameAccessError
        color, role = player
        if row["mode"] == "local":
            color = row["game"].current_player.value.lower()
        return (
            deepcopy(row["game"]),
            row["version"],
            row["status"],
            color,
            role,
            row["mode"],
            row.get("visibility", "private"),
        )

    def fake_save_game_action(
        *,
        game_id: str,
        actor_id: str,
        action_type: str,
        payload: dict,
        game: Game,
        expected_version: int,
    ) -> None:
        row = state["games"].get(game_id)
        if row is None:
            raise GameNotFoundError
        player = row["players"].get(actor_id)
        if player is None or (
            row["mode"] != "local"
            and player[0].upper() != row["game"].current_player.value
        ):
            raise GameAccessError
        if row["version"] != expected_version:
            raise GameConflictError
        row["game"] = deepcopy(game)
        row["version"] += 1
        state["actions"][game_id].append(
            {"actor_id": actor_id, "action_type": action_type, "payload": payload}
        )
        if game.get_victory_status().value != "ONGOING":
            row["status"] = "finished"

    def fake_abandon_game(*, game_id, actor_id, game, expected_version) -> None:
        row = state["games"].get(game_id)
        if row is None:
            raise GameNotFoundError
        player = row["players"].get(actor_id)
        if player is None or player[1] != "player":
            raise GameAccessError
        if row["version"] != expected_version:
            raise GameConflictError
        row["game"] = deepcopy(game)
        row["version"] += 1
        row["status"] = "abandoned"
        state["actions"][game_id].append(
            {"actor_id": actor_id, "action_type": "abandon", "payload": {}}
        )

    def fake_create_draw_offer(*, game_id: str, proposer_id: str):
        row = state["games"].get(game_id)
        if row is None or proposer_id not in row["players"]:
            raise GameAccessError
        if row["status"] != "ongoing":
            raise GameConflictError
        existing = next(
            (
                item
                for item in state["draw_offers"]
                if item["game_id"] == game_id and item["status"] == "pending"
            ),
            None,
        )
        if existing:
            raise GameConflictError
        offer = {
            "id": str(uuid4()),
            "game_id": game_id,
            "proposer_id": proposer_id,
            "status": "pending",
        }
        state["draw_offers"].append(offer)
        return offer.copy()

    def fake_pending_draw_offer(*, game_id: str):
        return next(
            (
                item.copy()
                for item in reversed(state["draw_offers"])
                if item["game_id"] == game_id and item["status"] == "pending"
            ),
            None,
        )

    def fake_respond_draw_offer(*, offer_id: str, responder_id: str, accept: bool):
        offer = next(
            (item for item in state["draw_offers"] if item["id"] == offer_id), None
        )
        if offer is None or offer["status"] != "pending":
            raise GameConflictError
        row = state["games"].get(offer["game_id"])
        if row is None or responder_id == offer["proposer_id"]:
            raise GameAccessError
        player = row["players"].get(responder_id)
        if player is None or player[1] != "player":
            raise GameAccessError
        offer["status"] = "accepted" if accept else "rejected"
        if accept:
            row["game"].status = GameStatus.DRAW
            row["status"] = "finished"
            state["actions"][offer["game_id"]].append(
                {
                    "actor_id": responder_id,
                    "action_type": "draw_agreed",
                    "payload": {"offer_id": offer_id},
                }
            )
        return {"offer": offer.copy(), "accepted": accept}

    def fake_search_profiles(query: str, current_user_id: str):
        normalized = query.lower()
        return [
            profile.copy()
            for profile in state["profiles"]
            if profile["id"] != current_user_id
            and (
                normalized == profile["id"].lower()
                or normalized in profile["username"].lower()
            )
        ]

    def fake_get_profile(user_id: str):
        profile = next(
            (item for item in state["profiles"] if item["id"] == user_id), None
        )
        if profile is None:
            raise SocialPersistenceError("Profile not found", 404)
        return profile.copy()

    def fake_update_profile_username(user_id: str, username: str):
        profile = next(
            (item for item in state["profiles"] if item["id"] == user_id), None
        )
        if profile is None:
            raise SocialPersistenceError("Profile not found", 404)
        if any(
            item["id"] != user_id and item["username"].lower() == username.lower()
            for item in state["profiles"]
        ):
            raise SocialPersistenceError("Username already used", 409)
        profile["username"] = username
        return profile.copy()

    def fake_create_friend_request(requester_id: str, addressee_id: str):
        if requester_id == addressee_id:
            raise SocialPersistenceError("Self friend request", 400)
        if not any(p["id"] == addressee_id for p in state["profiles"]):
            raise SocialPersistenceError("Profile not found", 404)
        if any(
            {r["requester_id"], r["addressee_id"]} == {requester_id, addressee_id}
            for r in state["friends"]
        ):
            raise SocialPersistenceError("Relationship already exists", 409)
        relation = {
            "id": str(uuid4()),
            "requester_id": requester_id,
            "addressee_id": addressee_id,
            "status": "pending",
        }
        state["friends"].append(relation)
        return relation.copy()

    def fake_respond_friend_request(request_id: str, user_id: str, response: str):
        relation = next((r for r in state["friends"] if r["id"] == request_id), None)
        if relation is None or relation["addressee_id"] != user_id:
            raise SocialPersistenceError("Request not found", 404)
        if relation["status"] != "pending":
            raise SocialPersistenceError("Request already handled", 409)
        relation["status"] = response
        return relation.copy()

    def fake_list_friend_relations(user_id: str, relation_status: str):
        return [
            relation.copy()
            for relation in state["friends"]
            if relation["status"] == relation_status
            and user_id in (relation["requester_id"], relation["addressee_id"])
        ]

    def fake_create_invitation(game_id: str, inviter_id: str, invitee_id: str):
        game = state["games"].get(game_id)
        if game is None or game["status"] != "waiting":
            raise SocialPersistenceError("Game unavailable", 409)
        if (
            inviter_id not in game["players"]
            or game["players"][inviter_id][0] != "white"
        ):
            raise SocialPersistenceError("Not game owner", 403)
        if not any(
            relation["status"] == "accepted"
            and {relation["requester_id"], relation["addressee_id"]}
            == {inviter_id, invitee_id}
            for relation in state["friends"]
        ):
            raise SocialPersistenceError("Players are not friends", 403)
        invitation = {
            "id": str(uuid4()),
            "game_id": game_id,
            "inviter_id": inviter_id,
            "invitee_id": invitee_id,
            "color": "black",
            "status": "pending",
        }
        state["invitations"].append(invitation)
        return invitation.copy()

    def fake_respond_invitation(invitation_id: str, user_id: str, response: str):
        invitation = next(
            (item for item in state["invitations"] if item["id"] == invitation_id),
            None,
        )
        if invitation is None or invitation["invitee_id"] != user_id:
            raise SocialPersistenceError("Invitation not found", 404)
        if invitation["status"] != "pending":
            raise SocialPersistenceError("Invitation already handled", 409)
        invitation["status"] = response
        if response == "accepted":
            game = state["games"][invitation["game_id"]]
            game["players"][user_id] = (invitation["color"], "player")
            game["status"] = "ongoing"
        return invitation.copy()

    def fake_pending_invitations(user_id: str):
        return [
            item.copy()
            for item in state["invitations"]
            if item["invitee_id"] == user_id and item["status"] == "pending"
        ]

    def fake_set_rematch_presence(game_id: str, user_id: str, available: bool):
        game = state["games"].get(game_id)
        if game is None or user_id not in game["players"]:
            raise SocialPersistenceError("Not a game participant", 403)
        if game["status"] not in ("finished", "abandoned"):
            raise SocialPersistenceError("Game is not finished", 409)
        state["rematch_presence"][(game_id, user_id)] = available
        if not available:
            for invitation in state["invitations"]:
                if (
                    invitation.get("source_game_id") == game_id
                    and invitation["status"] == "pending"
                    and user_id in (invitation["inviter_id"], invitation["invitee_id"])
                ):
                    invitation["status"] = "cancelled"

    def fake_get_rematch_status(game_id: str, user_id: str):
        game = state["games"].get(game_id)
        if game is None or user_id not in game["players"]:
            raise SocialPersistenceError("Not a game participant", 403)
        opponent_id = next(
            player_id for player_id in game["players"] if player_id != user_id
        )
        outgoing = next(
            (
                item.copy()
                for item in reversed(state["invitations"])
                if item.get("source_game_id") == game_id
                and item["inviter_id"] == user_id
                and item["invitee_id"] == opponent_id
            ),
            None,
        )
        return {
            "opponent_id": opponent_id,
            "opponent_available": state["rematch_presence"].get(
                (game_id, opponent_id), False
            ),
            "outgoing_invitation": outgoing,
        }

    def fake_create_rematch_invitation(*, game_id, inviter_id, invitee_id, game_state):
        game = state["games"].get(game_id)
        if (
            game is None
            or game["status"] not in ("finished", "abandoned")
            or inviter_id not in game["players"]
            or invitee_id not in game["players"]
            or not state["rematch_presence"].get((game_id, invitee_id), False)
        ):
            raise SocialPersistenceError("Opponent unavailable", 409)
        reverse = next(
            (
                item
                for item in reversed(state["invitations"])
                if item.get("source_game_id") == game_id
                and item["inviter_id"] == invitee_id
                and item["invitee_id"] == inviter_id
                and item["status"] == "pending"
            ),
            None,
        )
        if reverse:
            rematch = state["games"][reverse["game_id"]]
            rematch["players"][inviter_id] = ("black", "player")
            rematch["status"] = "ongoing"
            reverse["status"] = "accepted"
            return reverse.copy()
        new_game_id = str(uuid4())
        state["games"][new_game_id] = {
            "game": Game(),
            "version": 0,
            "status": "waiting",
            "mode": "online",
            "players": {inviter_id: ("white", "player")},
        }
        invitation = {
            "id": str(uuid4()),
            "game_id": new_game_id,
            "inviter_id": inviter_id,
            "invitee_id": invitee_id,
            "color": "black",
            "status": "pending",
            "source_game_id": game_id,
        }
        state["invitations"].append(invitation)
        return invitation.copy()

    def fake_cancel_waiting_game(*, game_id, user_id):
        game = state["games"].get(game_id)
        if game is None or user_id != next(iter(game["players"])):
            raise GameAccessError
        if game["status"] != "waiting" or len(game["players"]) != 1:
            raise GameConflictError
        del state["games"][game_id]
        state["actions"].pop(game_id, None)
        state["invitations"] = [
            item for item in state["invitations"] if item["game_id"] != game_id
        ]

    def fake_game_heartbeat(*, game_id, user_id):
        game = state["games"].get(game_id)
        if game is None or user_id not in game["players"]:
            raise GameAccessError
        if game["status"] != "ongoing":
            raise GameConflictError
        state["connection_status"][(game_id, user_id)] = "connected"

    def fake_opponent_connection(*, game_id, user_id):
        game = state["games"].get(game_id)
        if game is None or user_id not in game["players"]:
            raise GameAccessError
        opponent_id = next(
            player_id for player_id in game["players"] if player_id != user_id
        )
        return {
            "opponent_id": opponent_id,
            "status": state["connection_status"].get(
                (game_id, opponent_id), "connected"
            ),
            "seconds_until_forfeit": 30,
        }

    monkeypatch.setattr(routes_games, "persist_new_game", fake_create_game)
    monkeypatch.setattr(routes_games, "list_persisted_games", fake_list_games)
    monkeypatch.setattr(routes_games, "load_persisted_game", fake_load_game)
    monkeypatch.setattr(routes_games, "save_game_action", fake_save_game_action)
    monkeypatch.setattr(routes_games, "persist_abandon_game", fake_abandon_game)
    monkeypatch.setattr(
        routes_games, "persist_cancel_waiting_game", fake_cancel_waiting_game
    )
    monkeypatch.setattr(routes_games, "persist_game_heartbeat", fake_game_heartbeat)
    monkeypatch.setattr(
        routes_games, "load_opponent_connection_status", fake_opponent_connection
    )
    monkeypatch.setattr(routes_games, "persist_draw_offer", fake_create_draw_offer)
    monkeypatch.setattr(
        routes_games, "load_pending_draw_offer", fake_pending_draw_offer
    )
    monkeypatch.setattr(
        routes_games, "persist_draw_offer_response", fake_respond_draw_offer
    )
    monkeypatch.setattr(routes_social, "search_profiles", fake_search_profiles)
    monkeypatch.setattr(routes_social, "get_profile", fake_get_profile)
    monkeypatch.setattr(
        routes_social, "update_profile_username", fake_update_profile_username
    )
    monkeypatch.setattr(
        routes_social, "create_friend_request", fake_create_friend_request
    )
    monkeypatch.setattr(
        routes_social, "respond_friend_request", fake_respond_friend_request
    )
    monkeypatch.setattr(
        routes_social, "list_friend_relations", fake_list_friend_relations
    )
    monkeypatch.setattr(routes_social, "create_game_invitation", fake_create_invitation)
    monkeypatch.setattr(
        routes_social, "respond_game_invitation", fake_respond_invitation
    )
    monkeypatch.setattr(
        routes_social, "list_pending_game_invitations", fake_pending_invitations
    )
    monkeypatch.setattr(
        routes_social, "set_game_rematch_presence", fake_set_rematch_presence
    )
    monkeypatch.setattr(
        routes_social, "get_game_rematch_status", fake_get_rematch_status
    )
    monkeypatch.setattr(
        routes_social, "create_game_rematch_invitation", fake_create_rematch_invitation
    )

    app.dependency_overrides.clear()
    app.dependency_overrides[get_current_user] = fake_current_user
    app.state.test_state = state

    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        del app.state.test_state


@pytest.fixture
def as_user(client):
    def switch_user(user_id: str) -> None:
        client.app.state.test_state["user_id"] = user_id

    return switch_user


@pytest.fixture
def start_game(client, as_user):
    def start(game_id: str) -> None:
        state = client.app.state.test_state
        state["games"][game_id]["players"][USER_B] = ("black", "player")
        state["games"][game_id]["status"] = "ongoing"
        as_user(USER_A)

    return start
