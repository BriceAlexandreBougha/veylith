import re
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from veylith.auth.supabase import get_supabase_admin_client


class SocialPersistenceError(Exception):
    def __init__(self, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


def _rpc(name: str, params: dict[str, Any]) -> dict[str, Any]:
    try:
        response = get_supabase_admin_client().rpc(name, params).execute()
        if not isinstance(response.data, dict):
            raise SocialPersistenceError("Réponse Supabase invalide.")
        return response.data
    except SocialPersistenceError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", None)
        status_code = {
            "P0002": 404,
            "42501": 403,
            "23505": 409,
            "40001": 409,
            "22023": 400,
        }.get(code, 503)
        message = "Cette opération n'a pas pu être effectuée."
        raise SocialPersistenceError(message, status_code) from exc


def search_profiles(query: str, current_user_id: str) -> list[dict[str, Any]]:
    normalized_query = query.strip()
    try:
        profile_id = str(UUID(normalized_query))
    except ValueError:
        profile_id = None

    if profile_id is None and not re.fullmatch(
        r"[a-zA-Z0-9_-]{2,24}", normalized_query
    ):
        raise SocialPersistenceError("Recherche invalide.", 400)

    try:
        request = (
            get_supabase_admin_client()
            .table("profiles")
            .select("id, username, avatar_url")
            .neq("id", current_user_id)
        )
        if profile_id:
            request = request.eq("id", profile_id)
        else:
            request = request.ilike("username", f"%{normalized_query}%")
        response = request.order("username").limit(20).execute()
        return response.data or []
    except Exception as exc:
        raise SocialPersistenceError("Impossible de rechercher les profils.") from exc


def get_profile(user_id: str) -> dict[str, Any]:
    try:
        response = (
            get_supabase_admin_client()
            .table("profiles")
            .select("id, username, avatar_url")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
        if not isinstance(response.data, dict):
            raise SocialPersistenceError("Profil introuvable.", 404)
        return response.data
    except SocialPersistenceError:
        raise
    except Exception as exc:
        raise SocialPersistenceError("Impossible de charger le profil.") from exc


def update_profile_username(user_id: str, username: str) -> dict[str, Any]:
    try:
        response = (
            get_supabase_admin_client()
            .table("profiles")
            .update({"username": username, "updated_at": datetime.now(UTC).isoformat()})
            .eq("id", user_id)
            .execute()
        )
        rows = response.data
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise SocialPersistenceError("Profil introuvable.", 404)
        return rows[0]
    except SocialPersistenceError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", None)
        if code == "23505":
            raise SocialPersistenceError(
                "Ce nom d'utilisateur est déjà utilisé.", 409
            ) from exc
        if code == "23514":
            raise SocialPersistenceError(
                "Le nom d'utilisateur n'est pas valide.", 400
            ) from exc
        raise SocialPersistenceError("Impossible de modifier le profil.") from exc


def create_friend_request(requester_id: str, addressee_id: str) -> dict[str, Any]:
    return _rpc(
        "send_veylith_friend_request",
        {"p_requester_id": requester_id, "p_addressee_id": addressee_id},
    )


def respond_friend_request(
    request_id: str,
    user_id: str,
    response: str,
) -> dict[str, Any]:
    return _rpc(
        "respond_veylith_friend_request",
        {
            "p_request_id": request_id,
            "p_user_id": user_id,
            "p_response": response,
        },
    )


def list_friend_relations(user_id: str, status: str) -> list[dict[str, Any]]:
    client = get_supabase_admin_client()
    try:
        response = (
            client.table("friends")
            .select("id, requester_id, addressee_id, status")
            .eq("status", status)
            .or_(f"requester_id.eq.{user_id},addressee_id.eq.{user_id}")
            .order("created_at", desc=True)
            .execute()
        )
        relations = response.data or []
        other_user_ids = {
            row["addressee_id"]
            if row["requester_id"] == user_id
            else row["requester_id"]
            for row in relations
        }
        usernames: dict[str, str] = {}
        if other_user_ids:
            profiles = (
                client.table("profiles")
                .select("id, username")
                .in_("id", list(other_user_ids))
                .execute()
            ).data or []
            usernames = {row["id"]: row["username"] for row in profiles}
        for relation in relations:
            other_user_id = (
                relation["addressee_id"]
                if relation["requester_id"] == user_id
                else relation["requester_id"]
            )
            relation["other_username"] = usernames.get(other_user_id)
        return relations
    except Exception as exc:
        raise SocialPersistenceError("Impossible de charger les relations.") from exc


def create_game_invitation(
    game_id: str,
    inviter_id: str,
    invitee_id: str,
) -> dict[str, Any]:
    return _rpc(
        "create_veylith_game_invitation",
        {
            "p_game_id": game_id,
            "p_inviter_id": inviter_id,
            "p_invitee_id": invitee_id,
        },
    )


def set_game_rematch_presence(game_id: str, user_id: str, available: bool) -> None:
    try:
        get_supabase_admin_client().rpc(
            "set_veylith_game_rematch_presence",
            {
                "p_game_id": game_id,
                "p_user_id": user_id,
                "p_available": available,
            },
        ).execute()
    except Exception as exc:
        code = getattr(exc, "code", None)
        status_code = {"42501": 403, "40001": 409}.get(code, 503)
        raise SocialPersistenceError(
            "Impossible de mettre à jour la disponibilité pour une revanche.",
            status_code,
        ) from exc


def get_game_rematch_status(game_id: str, user_id: str) -> dict[str, Any]:
    client = get_supabase_admin_client()
    try:
        participants = (
            client.table("game_players")
            .select("user_id")
            .eq("game_id", game_id)
            .execute()
        ).data or []
        participant_ids = [row["user_id"] for row in participants]
        if user_id not in participant_ids:
            raise SocialPersistenceError("Accès à cette partie refusé.", 403)
        opponent_ids = [
            participant_id
            for participant_id in participant_ids
            if participant_id != user_id
        ]
        if not opponent_ids:
            raise SocialPersistenceError(
                "Aucun adversaire associé à cette partie.", 409
            )
        opponent_id = opponent_ids[0]

        presence_response = (
            client.table("game_rematch_presence")
            .select("available, updated_at")
            .eq("game_id", game_id)
            .eq("user_id", opponent_id)
            .maybe_single()
            .execute()
        )
        presence = (
            presence_response.data if isinstance(presence_response.data, dict) else None
        )
        available = False
        if presence and presence.get("available") and presence.get("updated_at"):
            timestamp_value = str(presence["updated_at"])
            if timestamp_value.endswith("Z"):
                timestamp_value = f"{timestamp_value[:-1]}+00:00"
            timestamp = datetime.fromisoformat(timestamp_value)
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=UTC)
            available = (datetime.now(UTC) - timestamp).total_seconds() < 15
        if not available and presence and presence.get("available"):
            set_game_rematch_presence(game_id, opponent_id, False)

        outgoing_rows = (
            client.table("game_invitations")
            .select(
                "id, game_id, inviter_id, invitee_id, color, status, source_game_id"
            )
            .eq("source_game_id", game_id)
            .eq("inviter_id", user_id)
            .eq("invitee_id", opponent_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        ).data or []
        outgoing = outgoing_rows[0] if outgoing_rows else None
        if outgoing and outgoing["status"] == "pending" and not available:
            client.table("game_invitations").update(
                {"status": "cancelled", "updated_at": datetime.now(UTC).isoformat()}
            ).eq("id", outgoing["id"]).eq("status", "pending").execute()
            outgoing["status"] = "cancelled"
        return {
            "opponent_id": opponent_id,
            "opponent_available": available,
            "outgoing_invitation": outgoing,
        }
    except SocialPersistenceError:
        raise
    except Exception as exc:
        raise SocialPersistenceError(
            "Impossible de vérifier la disponibilité de l’adversaire."
        ) from exc


def create_game_rematch_invitation(
    *, game_id: str, inviter_id: str, invitee_id: str, game_state: dict[str, Any]
) -> dict[str, Any]:
    try:
        response = (
            get_supabase_admin_client()
            .rpc(
                "create_veylith_rematch_invitation",
                {
                    "p_source_game_id": game_id,
                    "p_inviter_id": inviter_id,
                    "p_invitee_id": invitee_id,
                    "p_game_state": game_state,
                },
            )
            .execute()
        )
        if not isinstance(response.data, dict):
            raise SocialPersistenceError("Supabase n'a pas retourné l'invitation.")
        return response.data
    except SocialPersistenceError:
        raise
    except Exception as exc:
        code = getattr(exc, "code", None)
        status_code = {"42501": 403, "40001": 409, "23505": 409}.get(code, 503)
        message = (
            "L’adversaire n’est plus disponible pour une revanche."
            if code == "40001"
            else "Impossible d’envoyer la proposition de revanche."
        )
        raise SocialPersistenceError(message, status_code) from exc


def respond_game_invitation(
    invitation_id: str,
    user_id: str,
    response: str,
) -> dict[str, Any]:
    return _rpc(
        "respond_veylith_game_invitation",
        {
            "p_invitation_id": invitation_id,
            "p_user_id": user_id,
            "p_response": response,
        },
    )


def list_pending_game_invitations(user_id: str) -> list[dict[str, Any]]:
    client = get_supabase_admin_client()
    try:
        response = (
            client.table("game_invitations")
            .select(
                "id, game_id, inviter_id, invitee_id, color, status, source_game_id"
            )
            .eq("invitee_id", user_id)
            .eq("status", "pending")
            .order("created_at", desc=True)
            .execute()
        )
        invitations = response.data or []
        inviter_ids = {row["inviter_id"] for row in invitations}
        usernames: dict[str, str] = {}
        if inviter_ids:
            profiles = (
                client.table("profiles")
                .select("id, username")
                .in_("id", list(inviter_ids))
                .execute()
            ).data or []
            usernames = {row["id"]: row["username"] for row in profiles}
        for invitation in invitations:
            invitation["inviter_username"] = usernames.get(invitation["inviter_id"])
        return invitations
    except Exception as exc:
        raise SocialPersistenceError("Impossible de charger les invitations.") from exc
