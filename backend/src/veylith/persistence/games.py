from datetime import UTC, datetime
from typing import Any

from veylith.api.serialize import deserialize_game_state, serialize_game_state
from veylith.auth.supabase import get_supabase_admin_client
from veylith.domain.board import Board
from veylith.domain.enums import TerrainMode
from veylith.domain.game import Game
from veylith.domain.terrain import generate_terrain


class GameNotFoundError(Exception):
    pass


class GameAccessError(Exception):
    pass


class GameConflictError(Exception):
    pass


class GamePersistenceError(Exception):
    pass


def create_game(owner_id: str, mode: str = "online") -> tuple[str, Game]:
    game = Game(board=Board(heights=generate_terrain(TerrainMode.RANDOM)))
    rpc_name = "create_veylith_game_v2" if mode == "local" else "create_veylith_game"
    params: dict[str, Any] = {
        "p_owner_id": owner_id,
        "p_game_state": serialize_game_state(game),
    }
    if mode == "local":
        params["p_mode"] = mode
    try:
        response = get_supabase_admin_client().rpc(rpc_name, params).execute()
    except Exception as exc:
        raise GamePersistenceError("Impossible de créer la partie.") from exc

    if not response.data:
        raise GamePersistenceError("Supabase n'a pas retourné l'identifiant de partie.")
    return str(response.data), game


def load_game(game_id: str, user_id: str) -> tuple[Game, int, str, str, str, str, str]:
    client = get_supabase_admin_client()
    try:
        game_response = (
            client.table("games")
            .select(
                "id, created_by, game_state, version, status, current_player, mode, visibility"
            )
            .eq("id", game_id)
            .maybe_single()
            .execute()
        )
        game_row = game_response.data
        if not isinstance(game_row, dict):
            raise GameNotFoundError

        membership_response = (
            client.table("game_players")
            .select("user_id, color, role")
            .eq("game_id", game_id)
            .eq("user_id", user_id)
            .maybe_single()
            .execute()
        )
        if not membership_response.data:
            raise GameAccessError

        mode = str(game_row["mode"])
        color = str(membership_response.data["color"])
        if mode == "local" and str(game_row["created_by"]) == user_id:
            color = str(game_row["current_player"])

        state: Any = game_row.get("game_state")
        if not isinstance(state, dict):
            raise GamePersistenceError("L'état de la partie est invalide.")
        return (
            deserialize_game_state(state),
            int(game_row["version"]),
            str(game_row["status"]),
            color,
            str(membership_response.data["role"]),
            mode,
            str(game_row["visibility"]),
        )
    except GameNotFoundError, GameAccessError, GamePersistenceError:
        raise
    except Exception as exc:
        raise GamePersistenceError("Impossible de charger la partie.") from exc


def list_game_actions(game_id: str) -> list[dict[str, Any]]:
    """Load a game's persisted action snapshots in chronological order."""
    try:
        rows = (
            get_supabase_admin_client()
            .table("game_actions")
            .select(
                "action_number, actor_id, action_type, payload, state_after, created_at"
            )
            .eq("game_id", game_id)
            .order("action_number")
            .execute()
        ).data
        if not isinstance(rows, list):
            raise GamePersistenceError("L'historique des actions est invalide.")
        return [row for row in rows if isinstance(row, dict)]
    except GamePersistenceError:
        raise
    except Exception as exc:
        raise GamePersistenceError("Impossible de charger l'historique.") from exc


def list_games(
    user_id: str, *, limit: int = 50, offset: int = 0
) -> list[dict[str, Any]]:
    client = get_supabase_admin_client()
    try:
        memberships = (
            client.table("game_players")
            .select("game_id, color, user_id")
            .eq("user_id", user_id)
            .order("joined_at", desc=True)
            .order("game_id", desc=True)
            .range(offset, offset + limit - 1)
            .execute()
        ).data or []
        game_ids = [row["game_id"] for row in memberships]
        if not game_ids:
            return []
        colors_by_game = {row["game_id"]: row["color"] for row in memberships}

        games = (
            client.table("games")
            .select(
                "id, mode, visibility, status, current_player, turn_count, created_at, started_at, finished_at, game_result:game_state->>status"
            )
            .in_("id", game_ids)
            .order("created_at", desc=True)
            .execute()
        ).data or []
        game_ids_by_id = {row["id"]: row for row in games}
        participants_by_game: dict[str, list[str]] = {
            game_id: [] for game_id in game_ids
        }
        for row in (
            client.table("game_players")
            .select("game_id, user_id")
            .in_("game_id", game_ids)
            .execute()
        ).data or []:
            if row["game_id"] in participants_by_game:
                participants_by_game[row["game_id"]].append(row["user_id"])

        opponent_ids = {
            player_id
            for game_id, player_ids in participants_by_game.items()
            if game_ids_by_id.get(game_id, {}).get("mode") == "online"
            for player_id in player_ids
            if player_id != user_id
        }
        usernames: dict[str, str] = {}
        if opponent_ids:
            profiles = (
                client.table("profiles")
                .select("id, username")
                .in_("id", list(opponent_ids))
                .execute()
            ).data or []
            usernames = {profile["id"]: profile["username"] for profile in profiles}

        abandoned_game_ids = [
            row["id"] for row in games if row["status"] == "abandoned"
        ]
        abandoned_by: dict[str, str] = {}
        if abandoned_game_ids:
            actions = (
                client.table("game_actions")
                .select("game_id, actor_id, action_type, action_number")
                .in_("game_id", abandoned_game_ids)
                .in_("action_type", ["abandon", "disconnect_forfeit"])
                .order("action_number", desc=True)
                .execute()
            ).data or []
            for action in actions:
                abandoned_by.setdefault(action["game_id"], action["actor_id"])

        def get_result(row: dict[str, Any], color: str) -> str | None:
            if row["mode"] == "local":
                return None
            if row["status"] == "abandoned":
                quitter = abandoned_by.get(row["id"])
                if quitter:
                    return "loss" if quitter == user_id else "win"
                return None
            if row["status"] != "finished":
                return None
            status_value = row.get("game_result")
            if status_value == "DRAW":
                return "draw"
            winner_color = {"WHITE_WINS": "white", "BLACK_WINS": "black"}.get(
                status_value
            )
            return (
                "win"
                if winner_color == color.lower()
                else "loss"
                if winner_color
                else None
            )

        return [
            {
                "game_id": row["id"],
                "mode": row["mode"],
                "visibility": row["visibility"],
                "my_color": colors_by_game[row["id"]].upper(),
                "lifecycle_status": row["status"],
                "current_player": (
                    row["current_player"].upper() if row["current_player"] else None
                ),
                "turn_count": row["turn_count"],
                "created_at": row["created_at"],
                "started_at": row.get("started_at"),
                "finished_at": row.get("finished_at"),
                "opponent_username": (
                    "Partie locale"
                    if row["mode"] == "local"
                    else usernames.get(
                        next(
                            (
                                pid
                                for pid in participants_by_game[row["id"]]
                                if pid != user_id
                            ),
                            "",
                        )
                    )
                ),
                "result": get_result(row, colors_by_game[row["id"]]),
            }
            for row in games
        ]
    except Exception as exc:
        raise GamePersistenceError("Impossible de charger vos parties.") from exc


def cancel_waiting_game(*, game_id: str, user_id: str) -> None:
    try:
        get_supabase_admin_client().rpc(
            "cancel_veylith_waiting_game",
            {"p_game_id": game_id, "p_user_id": user_id},
        ).execute()
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "42501":
            raise GameAccessError from exc
        if code in {"40001", "P0002"}:
            raise GameConflictError from exc
        raise GamePersistenceError("Impossible d’annuler la recherche.") from exc


def heartbeat_game_player(*, game_id: str, user_id: str) -> None:
    try:
        get_supabase_admin_client().rpc(
            "heartbeat_veylith_game_player",
            {"p_game_id": game_id, "p_user_id": user_id},
        ).execute()
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "42501":
            raise GameAccessError from exc
        if code == "40001":
            raise GameConflictError from exc
        raise GamePersistenceError(
            "Impossible d’actualiser la connexion du joueur."
        ) from exc


def get_opponent_connection_status(*, game_id: str, user_id: str) -> dict[str, Any]:
    client = get_supabase_admin_client()
    try:
        game = (
            client.table("games")
            .select("id, status, version, started_at, created_at")
            .eq("id", game_id)
            .maybe_single()
            .execute()
        ).data
        if not isinstance(game, dict):
            raise GameNotFoundError
        members = (
            client.table("game_players")
            .select("user_id")
            .eq("game_id", game_id)
            .execute()
        ).data or []
        member_ids = [member["user_id"] for member in members]
        if user_id not in member_ids:
            raise GameAccessError
        opponents = [member_id for member_id in member_ids if member_id != user_id]
        if not opponents:
            raise GameConflictError
        opponent_id = opponents[0]

        if game["status"] == "abandoned":
            forfeits = (
                client.table("game_actions")
                .select("actor_id")
                .eq("game_id", game_id)
                .eq("action_type", "disconnect_forfeit")
                .order("action_number", desc=True)
                .limit(1)
                .execute()
            ).data or []
            if forfeits and forfeits[0]["actor_id"] == opponent_id:
                return {
                    "opponent_id": opponent_id,
                    "status": "forfeited",
                    "seconds_until_forfeit": 0,
                }
            return {
                "opponent_id": opponent_id,
                "status": "connected",
                "seconds_until_forfeit": 30,
            }

        presence = (
            client.table("game_player_presence")
            .select("last_seen_at")
            .eq("game_id", game_id)
            .eq("user_id", opponent_id)
            .maybe_single()
            .execute()
        ).data
        timestamp_value = (
            str(presence["last_seen_at"])
            if isinstance(presence, dict) and presence.get("last_seen_at")
            else str(game.get("started_at") or game["created_at"])
        )
        if timestamp_value.endswith("Z"):
            timestamp_value = f"{timestamp_value[:-1]}+00:00"
        last_seen = datetime.fromisoformat(timestamp_value)
        if last_seen.tzinfo is None:
            last_seen = last_seen.replace(tzinfo=UTC)
        elapsed = max(0, (datetime.now(UTC) - last_seen).total_seconds())

        if game["status"] == "ongoing" and elapsed >= 30:
            try:
                client.rpc(
                    "forfeit_veylith_disconnected_player",
                    {
                        "p_game_id": game_id,
                        "p_user_id": opponent_id,
                        "p_expected_version": int(game["version"]),
                    },
                ).execute()
                return {
                    "opponent_id": opponent_id,
                    "status": "forfeited",
                    "seconds_until_forfeit": 0,
                }
            except Exception as exc:
                if getattr(exc, "code", None) != "40001":
                    raise
                return get_opponent_connection_status(game_id=game_id, user_id=user_id)

        if game["status"] != "ongoing":
            return {
                "opponent_id": opponent_id,
                "status": "connected",
                "seconds_until_forfeit": 30,
            }
        status = "reconnecting" if elapsed >= 10 else "connected"
        return {
            "opponent_id": opponent_id,
            "status": status,
            "seconds_until_forfeit": max(0, int(30 - elapsed)),
        }
    except GameNotFoundError, GameAccessError, GameConflictError:
        raise
    except Exception as exc:
        raise GamePersistenceError(
            "Impossible de vérifier la connexion de l’adversaire."
        ) from exc


def find_or_create_match(user_id: str) -> tuple[str, Game, str, str]:
    game = Game(board=Board(heights=generate_terrain(TerrainMode.RANDOM)))
    try:
        response = (
            get_supabase_admin_client()
            .rpc(
                "find_or_create_veylith_match",
                {
                    "p_user_id": user_id,
                    "p_game_state": serialize_game_state(game),
                },
            )
            .execute()
        )
    except Exception as exc:
        raise GamePersistenceError("Impossible de chercher une partie.") from exc

    rows = response.data
    if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
        raise GamePersistenceError(
            "Supabase n'a pas retourné le résultat de recherche."
        )

    match = rows[0]
    game_id = str(match["game_id"])
    game, _, lifecycle_status, player_color, _, _, _ = load_game(game_id, user_id)

    return game_id, game, lifecycle_status, player_color


def save_game_action(
    *,
    game_id: str,
    actor_id: str,
    action_type: str,
    payload: dict[str, Any],
    game: Game,
    expected_version: int,
) -> None:
    status = game.get_victory_status()
    database_status = "ongoing" if status.value == "ONGOING" else "finished"
    try:
        get_supabase_admin_client().rpc(
            "record_veylith_game_action",
            {
                "p_game_id": game_id,
                "p_actor_id": actor_id,
                "p_action_type": action_type,
                "p_payload": payload,
                "p_state_after": serialize_game_state(game),
                "p_current_player": game.current_player.value.lower(),
                "p_turn_count": game.turn_count,
                "p_status": database_status,
                "p_expected_version": expected_version,
            },
        ).execute()
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "42501":
            raise GameAccessError from exc
        if code == "40001":
            raise GameConflictError from exc
        raise GamePersistenceError("Impossible d'enregistrer l'action.") from exc


def create_draw_offer(*, game_id: str, proposer_id: str) -> dict[str, Any]:
    try:
        response = (
            get_supabase_admin_client()
            .table("game_draw_offers")
            .insert({"game_id": game_id, "proposer_id": proposer_id})
            .execute()
        )
        rows = response.data
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise GamePersistenceError("Supabase n'a pas retourné la proposition.")
        return rows[0]
    except GamePersistenceError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "23505":
            raise GameConflictError(
                "Une proposition d'égalité est déjà en attente."
            ) from exc
        raise GamePersistenceError("Impossible de proposer une égalité.") from exc


def get_pending_draw_offer(*, game_id: str) -> dict[str, Any] | None:
    try:
        response = (
            get_supabase_admin_client()
            .table("game_draw_offers")
            .select("id, game_id, proposer_id, status")
            .eq("game_id", game_id)
            .eq("status", "pending")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = response.data or []
        return rows[0] if rows and isinstance(rows[0], dict) else None
    except Exception as exc:
        raise GamePersistenceError(
            "Impossible de charger la proposition d'égalité."
        ) from exc


def respond_to_draw_offer(
    *, offer_id: str, responder_id: str, accept: bool
) -> dict[str, Any]:
    try:
        response = (
            get_supabase_admin_client()
            .rpc(
                "respond_veylith_draw_offer",
                {
                    "p_offer_id": offer_id,
                    "p_responder_id": responder_id,
                    "p_accept": accept,
                },
            )
            .execute()
        )
        if not isinstance(response.data, dict) or not isinstance(
            response.data.get("offer"), dict
        ):
            raise GamePersistenceError("Supabase n'a pas retourné la réponse.")
        return response.data
    except GamePersistenceError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "42501":
            raise GameAccessError from exc
        if code in {"40001", "P0002"}:
            raise GameConflictError from exc
        raise GamePersistenceError("Impossible de répondre à l'égalité.") from exc


def abandon_game(
    *,
    game_id: str,
    actor_id: str,
    game: Game,
    expected_version: int,
) -> None:
    try:
        get_supabase_admin_client().rpc(
            "abandon_veylith_game",
            {
                "p_game_id": game_id,
                "p_actor_id": actor_id,
                "p_state_after": serialize_game_state(game),
                "p_expected_version": expected_version,
            },
        ).execute()
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "42501":
            raise GameAccessError from exc
        if code == "40001":
            raise GameConflictError from exc
        raise GamePersistenceError("Impossible d'abandonner la partie.") from exc
