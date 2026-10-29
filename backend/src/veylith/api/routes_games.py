from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from veylith.api.schemas import (
    AttackRequest,
    AttackResponse,
    ExitRequest,
    GameConnectionStatusOut,
    GameCreateRequest,
    GameDrawOfferOut,
    GameDrawOfferResponse,
    GameDrawOfferResult,
    GameOut,
    GameReplayActionOut,
    GameReplayOut,
    GameSummaryOut,
    MovePathOut,
    MoveRequest,
)
from veylith.api.serialize import (
    deserialize_game_state,
    serialize_game,
    serialize_path,
)
from veylith.auth.dependencies import get_current_user
from veylith.domain.board import Board
from veylith.domain.enums import PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Position
from veylith.persistence.games import (
    GameAccessError,
    GameConflictError,
    GameNotFoundError,
    GamePersistenceError,
    find_or_create_match,
    save_game_action,
)
from veylith.persistence.games import (
    abandon_game as persist_abandon_game,
)
from veylith.persistence.games import (
    cancel_waiting_game as persist_cancel_waiting_game,
)
from veylith.persistence.games import (
    create_draw_offer as persist_draw_offer,
)
from veylith.persistence.games import (
    create_game as persist_new_game,
)
from veylith.persistence.games import (
    get_opponent_connection_status as load_opponent_connection_status,
)
from veylith.persistence.games import (
    get_pending_draw_offer as load_pending_draw_offer,
)
from veylith.persistence.games import (
    heartbeat_game_player as persist_game_heartbeat,
)
from veylith.persistence.games import (
    list_game_actions as list_persisted_game_actions,
)
from veylith.persistence.games import (
    list_games as list_persisted_games,
)
from veylith.persistence.games import (
    load_game as load_persisted_game,
)
from veylith.persistence.games import (
    respond_to_draw_offer as persist_draw_offer_response,
)

router = APIRouter(
    prefix="/games",
    tags=["Games"],
    dependencies=[Depends(get_current_user)],
)


def _load_game(game_id: str, user_id: str) -> tuple[Game, int, str, str, str, str, str]:
    try:
        return load_persisted_game(game_id, user_id)
    except GameNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Partie introuvable.") from exc
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Accès à cette partie refusé."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="La base de données est temporairement indisponible.",
        ) from exc


def _save_action(
    *,
    game_id: str,
    user_id: str,
    action_type: str,
    payload: dict[str, Any],
    game: Game,
    version: int,
) -> str:
    try:
        save_game_action(
            game_id=game_id,
            actor_id=user_id,
            action_type=action_type,
            payload=payload,
            game=game,
            expected_version=version,
        )
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="L'action n'a pas pu être enregistrée.",
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail="La partie a changé. Recharge son état puis réessaie.",
        ) from exc
    except GameAccessError as exc:
        raise HTTPException(status_code=403, detail="Ce n'est pas votre tour.") from exc
    return "finished" if game.get_victory_status().value != "ONGOING" else "ongoing"


def _require_active_player(game: Game, color: str, role: str) -> None:
    if role != "player":
        raise HTTPException(status_code=403, detail="Un spectateur ne peut pas jouer.")
    if color.lower() != game.current_player.value.lower():
        raise HTTPException(status_code=403, detail="Ce n'est pas votre tour.")


@router.post("", response_model=GameOut, status_code=status.HTTP_201_CREATED)
def create_game(
    request: GameCreateRequest = GameCreateRequest(),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    try:
        game_id, game = persist_new_game(current_user["id"], request.mode)
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="Impossible de créer la partie dans la base de données.",
        ) from exc
    lifecycle_status = "ongoing" if request.mode == "local" else "waiting"
    return serialize_game(
        game_id, game, lifecycle_status, request.mode, PlayerColor.WHITE
    )


@router.post("/matchmaking", response_model=GameOut)
def find_match(
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    try:
        game_id, game, lifecycle_status, color = find_or_create_match(
            current_user["id"]
        )
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="Impossible de rechercher une partie en ligne.",
        ) from exc
    return serialize_game(
        game_id,
        game,
        lifecycle_status,
        "online",
        PlayerColor(color.upper()),
        "public",
    )


@router.get("", response_model=list[GameSummaryOut])
def list_games(
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    try:
        return list_persisted_games(current_user["id"], limit=limit, offset=offset)
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="Impossible de charger vos parties.",
        ) from exc


@router.get("/{game_id}/draw-offer", response_model=GameDrawOfferOut | None)
def get_draw_offer(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any] | None:
    _game, _version, lifecycle_status, _color, role, _mode, _visibility = _load_game(
        game_id, current_user["id"]
    )
    if role != "player":
        raise HTTPException(status_code=403, detail="Accès réservé aux joueurs.")
    if lifecycle_status != "ongoing":
        return None
    try:
        return load_pending_draw_offer(game_id=game_id)
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de charger l'égalité."
        ) from exc


@router.post("/{game_id}/draw-offers", response_model=GameDrawOfferOut)
def propose_draw(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _game, _version, lifecycle_status, _color, role, mode, _visibility = _load_game(
        game_id, current_user["id"]
    )
    if role != "player":
        raise HTTPException(
            status_code=403, detail="Un spectateur ne peut pas proposer une égalité."
        )
    if mode != "online":
        raise HTTPException(
            status_code=409,
            detail="La proposition d'égalité est réservée aux parties en ligne.",
        )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'est pas en cours.")
    try:
        return persist_draw_offer(game_id=game_id, proposer_id=current_user["id"])
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409, detail="Une proposition d'égalité est déjà en attente."
        ) from exc
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Accès à cette partie refusé."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de proposer une égalité."
        ) from exc


@router.post(
    "/{game_id}/draw-offers/{offer_id}/respond",
    response_model=GameDrawOfferResult,
)
def respond_to_draw_offer(
    game_id: str,
    offer_id: str,
    request: GameDrawOfferResponse,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _load_game(game_id, current_user["id"])
    try:
        pending_offer = load_pending_draw_offer(game_id=game_id)
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de vérifier la proposition."
        ) from exc
    if not pending_offer or str(pending_offer.get("id")) != offer_id:
        raise HTTPException(status_code=404, detail="Proposition introuvable.")
    try:
        result = persist_draw_offer_response(
            offer_id=offer_id, responder_id=current_user["id"], accept=request.accept
        )
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403,
            detail="Seul l'adversaire peut répondre à cette proposition.",
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409, detail="Cette proposition n'est plus en attente."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de répondre à la proposition."
        ) from exc

    offer = result["offer"]
    game_out = None
    if request.accept:
        game, _version, lifecycle_status, color, _role, mode, visibility = _load_game(
            game_id, current_user["id"]
        )
        game_out = serialize_game(
            game_id,
            game,
            lifecycle_status,
            mode,
            PlayerColor(color.upper()),
            visibility,
        )
    return {"offer": offer, "game": game_out}


@router.delete("/{game_id}/waiting", status_code=status.HTTP_204_NO_CONTENT)
def cancel_waiting_game(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> None:
    try:
        persist_cancel_waiting_game(game_id=game_id, user_id=current_user["id"])
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Seul le créateur peut annuler cette recherche."
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409, detail="La partie a déjà commencé."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible d’annuler la recherche."
        ) from exc


@router.put("/{game_id}/presence", status_code=status.HTTP_204_NO_CONTENT)
def heartbeat_game(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> None:
    try:
        persist_game_heartbeat(game_id=game_id, user_id=current_user["id"])
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Accès à cette partie refusé."
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409, detail="La partie n’est plus active."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible d’actualiser la connexion."
        ) from exc


@router.get("/{game_id}/connection", response_model=GameConnectionStatusOut)
def get_game_connection_status(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        return load_opponent_connection_status(
            game_id=game_id, user_id=current_user["id"]
        )
    except GameNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Partie introuvable.") from exc
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Accès à cette partie refusé."
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409, detail="Aucun adversaire dans cette partie."
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de vérifier la connexion."
        ) from exc


@router.get("/{game_id}", response_model=GameOut)
def get_game_state(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    game, _, lifecycle_status, color, _, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    return serialize_game(
        game_id, game, lifecycle_status, mode, PlayerColor(color.upper()), visibility
    )


@router.get("/{game_id}/actions", response_model=GameReplayOut)
def get_game_replay(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameReplayOut:
    game, _, lifecycle_status, color, _role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    try:
        rows = list_persisted_game_actions(game_id)
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503, detail="Impossible de charger l'historique des actions."
        ) from exc

    # The stored state is overwritten as a game progresses. The initial layout
    # is deterministic; the generated terrain heights remain in every snapshot.
    initial_game = Game(
        board=Board(
            size=game.board.size, heights=[row[:] for row in game.board.heights]
        )
    )
    initial_state = serialize_game(
        game_id,
        initial_game,
        "ongoing",
        mode,
        PlayerColor(color.upper()),
        visibility,
    )

    actions: list[GameReplayActionOut] = []
    for row in rows:
        raw_state = row.get("state_after")
        state_after = None
        if isinstance(raw_state, dict):
            try:
                snapshot = deserialize_game_state(raw_state)
            except ValueError as exc:
                raise HTTPException(
                    status_code=503,
                    detail="Un état de partie enregistré ne peut pas être relu.",
                ) from exc
            action_type = str(row.get("action_type", ""))
            snapshot_status = (
                "abandoned"
                if action_type in {"abandon", "disconnect_forfeit"}
                else "finished"
                if snapshot.get_victory_status().value != "ONGOING"
                else "ongoing"
            )
            state_after = serialize_game(
                game_id,
                snapshot,
                snapshot_status,
                mode,
                PlayerColor(color.upper()),
                visibility,
            )
        payload = row.get("payload")
        actions.append(
            GameReplayActionOut(
                action_number=int(row["action_number"]),
                actor_id=str(row["actor_id"]) if row.get("actor_id") else None,
                action_type=str(row["action_type"]),
                payload=payload if isinstance(payload, dict) else {},
                created_at=row["created_at"],
                state_after=state_after,
            )
        )

    return GameReplayOut(
        game_id=game_id,
        mode=mode,
        visibility=visibility,
        lifecycle_status=lifecycle_status,
        initial_state=initial_state,
        actions=actions,
    )


@router.get(
    "/{game_id}/legal-moves/{piece_id}",
    response_model=list[MovePathOut],
)
def get_legal_moves(
    game_id: str,
    piece_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> list[MovePathOut]:
    game, _, lifecycle_status, color, role, _mode, _visibility = _load_game(
        game_id, current_user["id"]
    )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'a pas commencé.")
    _require_active_player(game, color, role)
    try:
        paths = game.get_legal_paths(piece_id)
        return [serialize_path(path) for path in paths]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{game_id}/moves", response_model=GameOut)
def move_piece(
    game_id: str,
    request: MoveRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    game, version, lifecycle_status, color, role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'a pas commencé.")
    _require_active_player(game, color, role)
    row = request.destination.row
    col = request.destination.col
    board_size = game.board.size

    if not (0 <= row < board_size and 0 <= col < board_size):
        raise HTTPException(
            status_code=400, detail="La destination est hors du plateau."
        )

    if request.piece_id not in game.pieces:
        raise HTTPException(status_code=404, detail="Pièce introuvable.")
    if request.path is not None and (
        not request.path or request.path[-1] != request.destination
    ):
        raise HTTPException(
            status_code=400,
            detail="La destination doit être la dernière étape du trajet.",
        )

    try:
        path = (
            game.move_along_path(
                request.piece_id,
                [Position(row=step.row, col=step.col) for step in request.path],
                special=request.special,
            )
            if request.path is not None
            else game.move_to_destination(
                request.piece_id,
                Position(row=row, col=col),
                special=request.special,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    lifecycle_status = _save_action(
        game_id=game_id,
        user_id=current_user["id"],
        action_type="move",
        payload={
            "piece_id": request.piece_id,
            "destination": {"row": row, "col": col},
            "special": path.special,
            "path": [{"row": step.row, "col": step.col} for step in path.path],
        },
        game=game,
        version=version,
    )
    return serialize_game(
        game_id, game, lifecycle_status, mode, PlayerColor(color.upper()), visibility
    )


@router.post("/{game_id}/attacks", response_model=AttackResponse)
def attack_piece(
    game_id: str,
    request: AttackRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> AttackResponse:
    game, version, lifecycle_status, color, role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'a pas commencé.")
    _require_active_player(game, color, role)
    try:
        result = game.attack_piece(
            attacker_id=request.attacker_id,
            defender_id=request.defender_id,
            path=(
                [Position(row=step.row, col=step.col) for step in request.path]
                if request.path is not None
                else None
            ),
            special=request.special,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    lifecycle_status = _save_action(
        game_id=game_id,
        user_id=current_user["id"],
        action_type="attack",
        payload={
            "attacker_id": request.attacker_id,
            "defender_id": request.defender_id,
            "success": result.success,
            "attack_force": result.attack_force,
            "defense_force": result.defense_force,
            "path": (
                [{"row": step.row, "col": step.col} for step in request.path]
                if request.path is not None
                else None
            ),
            "special": request.special,
        },
        game=game,
        version=version,
    )
    return AttackResponse(
        game=serialize_game(
            game_id,
            game,
            lifecycle_status,
            mode,
            PlayerColor(color.upper()),
            visibility,
        ),
        success=result.success,
        attack_force=result.attack_force,
        defense_force=result.defense_force,
    )


@router.post("/{game_id}/exit", response_model=GameOut)
def exit_piece(
    game_id: str,
    request: ExitRequest,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    game, version, lifecycle_status, color, role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'a pas commencé.")
    _require_active_player(game, color, role)
    if request.piece_id not in game.pieces:
        raise HTTPException(status_code=404, detail="Pièce introuvable.")

    try:
        game.exit_piece(request.piece_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    lifecycle_status = _save_action(
        game_id=game_id,
        user_id=current_user["id"],
        action_type="exit",
        payload={"piece_id": request.piece_id},
        game=game,
        version=version,
    )
    return serialize_game(
        game_id, game, lifecycle_status, mode, PlayerColor(color.upper()), visibility
    )


@router.post("/{game_id}/end-turn", response_model=GameOut)
def end_turn(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    game, version, lifecycle_status, color, role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    if lifecycle_status != "ongoing":
        raise HTTPException(status_code=409, detail="La partie n'a pas commencé.")
    _require_active_player(game, color, role)
    try:
        game._require_ongoing()
        game.end_turn()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    lifecycle_status = _save_action(
        game_id=game_id,
        user_id=current_user["id"],
        action_type="end_turn",
        payload={},
        game=game,
        version=version,
    )
    return serialize_game(
        game_id, game, lifecycle_status, mode, PlayerColor(color.upper()), visibility
    )


@router.post("/{game_id}/abandon", response_model=GameOut)
def abandon_current_game(
    game_id: str,
    current_user: dict[str, Any] = Depends(get_current_user),
) -> GameOut:
    game, version, lifecycle_status, color, role, mode, visibility = _load_game(
        game_id, current_user["id"]
    )
    if role != "player":
        raise HTTPException(
            status_code=403, detail="Un spectateur ne peut pas abandonner."
        )
    if lifecycle_status not in ("waiting", "ongoing"):
        raise HTTPException(status_code=409, detail="La partie est déjà terminée.")
    try:
        persist_abandon_game(
            game_id=game_id,
            actor_id=current_user["id"],
            game=game,
            expected_version=version,
        )
    except GameAccessError as exc:
        raise HTTPException(
            status_code=403, detail="Accès à cette partie refusé."
        ) from exc
    except GameConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail="La partie a changé. Recharge son état puis réessaie.",
        ) from exc
    except GamePersistenceError as exc:
        raise HTTPException(
            status_code=503,
            detail="L'abandon n'a pas pu être enregistré.",
        ) from exc
    return serialize_game(
        game_id,
        game,
        "abandoned",
        mode,
        PlayerColor(color.upper()),
        visibility,
    )
