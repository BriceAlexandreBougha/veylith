import re
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status

from veylith.api.schemas import (
    FriendRelationOut,
    FriendRequestCreate,
    GameInvitationCreate,
    GameInvitationOut,
    GameRematchPresenceUpdate,
    GameRematchStatusOut,
    UserProfileUpdate,
    UserSearchOut,
)
from veylith.api.serialize import serialize_game_state
from veylith.auth.dependencies import get_current_user
from veylith.domain.board import Board
from veylith.domain.enums import TerrainMode
from veylith.domain.game import Game
from veylith.domain.terrain import generate_terrain
from veylith.persistence.social import (
    SocialPersistenceError,
    create_friend_request,
    create_game_invitation,
    create_game_rematch_invitation,
    get_game_rematch_status,
    get_profile,
    list_friend_relations,
    list_pending_game_invitations,
    respond_friend_request,
    respond_game_invitation,
    search_profiles,
    set_game_rematch_presence,
    update_profile_username,
)

users_router = APIRouter(
    prefix="/users",
    tags=["Users"],
    dependencies=[Depends(get_current_user)],
)
friends_router = APIRouter(
    prefix="/friends",
    tags=["Friends"],
    dependencies=[Depends(get_current_user)],
)
invitations_router = APIRouter(
    prefix="/games",
    tags=["Game invitations"],
    dependencies=[Depends(get_current_user)],
)


def _handle_social_error(exc: SocialPersistenceError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@users_router.get("/search", response_model=list[UserSearchOut])
def search_users(
    q: str = Query(min_length=2, max_length=36),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    try:
        return search_profiles(q, current_user["id"])
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@users_router.get("/me", response_model=UserSearchOut)
def get_current_profile(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        profile = get_profile(current_user["id"])
        username = profile.get("username")
        email_prefix = str(current_user.get("email") or "").split("@", 1)[0]
        if (
            isinstance(username, str)
            and username.startswith("player_")
            and email_prefix
        ):
            fallback = re.sub(r"[^a-zA-Z0-9_-]", "_", email_prefix)[:24]
            if len(fallback) >= 3:
                try:
                    profile = update_profile_username(current_user["id"], fallback)
                except SocialPersistenceError as exc:
                    if exc.status_code != 409:
                        raise
        return profile
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@users_router.patch("/me", response_model=UserSearchOut)
def change_current_username(
    request: UserProfileUpdate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return update_profile_username(current_user["id"], request.username)
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@friends_router.get("", response_model=list[FriendRelationOut])
def get_friends(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    try:
        return list_friend_relations(current_user["id"], "accepted")
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@friends_router.get("/requests", response_model=list[FriendRelationOut])
def get_friend_requests(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    try:
        return list_friend_relations(current_user["id"], "pending")
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@friends_router.post(
    "/requests",
    response_model=FriendRelationOut,
    status_code=status.HTTP_201_CREATED,
)
def send_friend_request(
    request: FriendRequestCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return create_friend_request(current_user["id"], str(request.addressee_id))
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@friends_router.post("/requests/{request_id}/accept", response_model=FriendRelationOut)
def accept_friend_request(
    request_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return respond_friend_request(str(request_id), current_user["id"], "accepted")
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@friends_router.post("/requests/{request_id}/reject", response_model=FriendRelationOut)
def reject_friend_request(
    request_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return respond_friend_request(str(request_id), current_user["id"], "rejected")
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.get("/invitations", response_model=list[GameInvitationOut])
def get_game_invitations(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    try:
        return list_pending_game_invitations(current_user["id"])
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.put(
    "/{game_id}/rematch-presence", status_code=status.HTTP_204_NO_CONTENT
)
def update_rematch_presence(
    game_id: UUID,
    request: GameRematchPresenceUpdate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> None:
    try:
        set_game_rematch_presence(str(game_id), current_user["id"], request.available)
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.get(
    "/{game_id}/rematch-status", response_model=GameRematchStatusOut
)
def get_rematch_status(
    game_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return get_game_rematch_status(str(game_id), current_user["id"])
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.post(
    "/{game_id}/rematches",
    response_model=GameInvitationOut,
    status_code=status.HTTP_201_CREATED,
)
def send_rematch_invitation(
    game_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        rematch_status = get_game_rematch_status(str(game_id), current_user["id"])
        if not rematch_status["opponent_available"]:
            raise SocialPersistenceError(
                "L’adversaire n’est plus disponible pour une revanche.", 409
            )
        next_game = Game(board=Board(heights=generate_terrain(TerrainMode.RANDOM)))
        invitation = create_game_rematch_invitation(
            game_id=str(game_id),
            inviter_id=current_user["id"],
            invitee_id=rematch_status["opponent_id"],
            game_state=serialize_game_state(next_game),
        )
        invitation["inviter_username"] = get_profile(invitation["inviter_id"])[
            "username"
        ]
        return invitation
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.post(
    "/{game_id}/invitations",
    response_model=GameInvitationOut,
    status_code=status.HTTP_201_CREATED,
)
def invite_friend(
    game_id: UUID,
    request: GameInvitationCreate,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return create_game_invitation(
            str(game_id), current_user["id"], str(request.invitee_id)
        )
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.post(
    "/invitations/{invitation_id}/accept", response_model=GameInvitationOut
)
def accept_game_invitation(
    invitation_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return respond_game_invitation(
            str(invitation_id), current_user["id"], "accepted"
        )
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc


@invitations_router.post(
    "/invitations/{invitation_id}/reject", response_model=GameInvitationOut
)
def reject_game_invitation(
    invitation_id: UUID,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return respond_game_invitation(
            str(invitation_id), current_user["id"], "rejected"
        )
    except SocialPersistenceError as exc:
        raise _handle_social_error(exc) from exc
