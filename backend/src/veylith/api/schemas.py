from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from veylith.domain.enums import PlayerColor
from veylith.domain.victory import GameStatus


class PositionOut(BaseModel):
    row: int
    col: int


class PieceOut(BaseModel):
    id: str
    owner: PlayerColor
    piece_type: str
    force: int
    movement_points: int
    position: PositionOut | None
    captured: bool
    finished: bool


class GameOut(BaseModel):
    game_id: str
    mode: Literal["online", "local"]
    visibility: Literal["public", "private"] = "private"
    my_color: PlayerColor | None = None
    board_size: int
    heights: list[list[int]]
    pieces: list[PieceOut]
    current_player: PlayerColor
    turn_count: int
    has_moved_this_turn: bool
    moved_piece_id: str | None
    movement_spent: dict[str, int]
    turn_start_positions: dict[str, PositionOut]
    visited_positions: dict[str, list[PositionOut]]
    scores: dict[str, int]
    exited_pieces: int
    first_exit_piece_id: str | None = None
    status: GameStatus
    lifecycle_status: Literal["waiting", "ongoing", "finished", "abandoned"] = "ongoing"
    winner: PlayerColor | None


class GameSummaryOut(BaseModel):
    game_id: str
    mode: Literal["online", "local"]
    visibility: Literal["public", "private"] = "private"
    my_color: PlayerColor
    lifecycle_status: Literal["waiting", "ongoing", "finished", "abandoned"]
    current_player: PlayerColor | None
    turn_count: int
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    opponent_username: str | None = None
    result: Literal["win", "loss", "draw"] | None = None


class GameReplayActionOut(BaseModel):
    action_number: int
    actor_id: str | None
    action_type: str
    payload: dict[str, object]
    created_at: datetime
    state_after: GameOut | None = None


class GameReplayOut(BaseModel):
    game_id: str
    mode: Literal["online", "local"]
    visibility: Literal["public", "private"]
    lifecycle_status: Literal["waiting", "ongoing", "finished", "abandoned"]
    initial_state: GameOut
    actions: list[GameReplayActionOut]


class GameCreateRequest(BaseModel):
    mode: Literal["online", "local"] = "online"


class MoveRequest(BaseModel):
    piece_id: str = Field(min_length=1)
    destination: PositionOut
    special: str | None = None
    path: list[PositionOut] | None = None


class AttackRequest(BaseModel):
    attacker_id: str = Field(min_length=1)
    defender_id: str = Field(min_length=1)
    path: list[PositionOut] | None = None
    special: str | None = None


class AttackResponse(BaseModel):
    game: GameOut
    success: bool
    attack_force: int
    defense_force: int


class ExitRequest(BaseModel):
    piece_id: str = Field(min_length=1)


class MovePathOut(BaseModel):
    start: PositionOut
    destination: PositionOut
    path: list[PositionOut]
    cost: int
    special: str | None


class FriendRequestCreate(BaseModel):
    addressee_id: UUID


class FriendRelationOut(BaseModel):
    id: str
    requester_id: str
    addressee_id: str
    status: Literal["pending", "accepted", "rejected", "blocked"]
    other_username: str | None = None


class GameInvitationCreate(BaseModel):
    invitee_id: UUID


class GameInvitationOut(BaseModel):
    id: str
    game_id: str
    inviter_id: str
    invitee_id: str
    color: Literal["white", "black"]
    status: Literal["pending", "accepted", "rejected", "cancelled"]
    inviter_username: str | None = None
    source_game_id: str | None = None


class GameRematchPresenceUpdate(BaseModel):
    available: bool


class GameRematchStatusOut(BaseModel):
    opponent_id: str
    opponent_available: bool
    outgoing_invitation: GameInvitationOut | None = None


class GameConnectionStatusOut(BaseModel):
    opponent_id: UUID
    status: Literal["connected", "reconnecting", "forfeited"]
    seconds_until_forfeit: int


class GameDrawOfferOut(BaseModel):
    id: str
    game_id: str
    proposer_id: str
    status: Literal["pending", "accepted", "rejected", "cancelled"]


class GameDrawOfferResponse(BaseModel):
    accept: bool


class GameDrawOfferResult(BaseModel):
    offer: GameDrawOfferOut
    game: GameOut | None = None


class UserSearchOut(BaseModel):
    id: UUID
    username: str
    avatar_url: str | None


class UserProfileUpdate(BaseModel):
    username: str = Field(min_length=3, max_length=24, pattern=r"^[a-zA-Z0-9_-]+$")
