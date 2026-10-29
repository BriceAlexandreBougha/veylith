from veylith.api.schemas import (
    GameOut,
    MovePathOut,
    PieceOut,
    PositionOut,
)
from veylith.domain.board import Board
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Piece, Position
from veylith.domain.movement import MovementPath
from veylith.domain.victory import GameStatus


def serialize_position(
    position: Position | None,
) -> PositionOut | None:
    if position is None:
        return None

    return PositionOut(row=position.row, col=position.col)


def serialize_path(path: MovementPath) -> MovePathOut:
    return MovePathOut(
        start=serialize_position(path.start),
        destination=serialize_position(path.destination),
        path=[PositionOut(row=p.row, col=p.col) for p in path.path],
        cost=path.cost,
        special=path.special,
    )


def serialize_game(
    game_id: str,
    game: Game,
    lifecycle_status: str = "ongoing",
    mode: str = "online",
    my_color: PlayerColor | None = None,
    visibility: str = "private",
) -> GameOut:
    game_status = (
        GameStatus.DRAW
        if lifecycle_status == "finished" and game.status == GameStatus.DRAW
        else game.get_victory_status()
    )

    # En local, le même compte contrôle les deux couleurs. Refléter le côté
    # actif dans my_color après chaque changement de tour.
    if mode == "local":
        my_color = game.current_player

    winner = None
    if game_status == GameStatus.WHITE_WINS:
        winner = PlayerColor.WHITE
    elif game_status == GameStatus.BLACK_WINS:
        winner = PlayerColor.BLACK

    return GameOut(
        game_id=game_id,
        mode=mode,
        visibility=visibility,
        my_color=my_color,
        board_size=game.board.size,
        heights=game.board.heights,
        pieces=[
            PieceOut(
                id=piece.id,
                owner=piece.owner,
                piece_type=piece.piece_type.value,
                force=piece.force,
                movement_points=piece.movement_points,
                position=serialize_position(piece.position),
                captured=piece.captured,
                finished=piece.finished,
            )
            for piece in game.pieces.values()
        ],
        current_player=game.current_player,
        turn_count=game.turn_count,
        has_moved_this_turn=game.has_moved_this_turn,
        moved_piece_id=game.moved_piece_id,
        movement_spent=game.movement_spent,
        turn_start_positions={
            piece_id: PositionOut(row=position.row, col=position.col)
            for piece_id, position in game.turn_start_positions.items()
        },
        visited_positions={
            piece_id: [PositionOut(row=pos.row, col=pos.col) for pos in positions]
            for piece_id, positions in game.visited_positions.items()
        },
        scores={color.value: score for color, score in game.scores.items()},
        exited_pieces=game.exited_pieces,
        first_exit_piece_id=game.first_exit_piece_id,
        status=game_status,
        lifecycle_status=lifecycle_status,
        winner=winner,
    )


def serialize_game_state(game: Game) -> dict[str, object]:
    """Retourne un état JSON complet permettant de reprendre le moteur."""
    return {
        "schema_version": 1,
        "board": {
            "size": game.board.size,
            "heights": game.board.heights,
        },
        "pieces": [
            {
                "id": piece.id,
                "owner": piece.owner.value,
                "piece_type": piece.piece_type.value,
                "position": (
                    {"row": piece.position.row, "col": piece.position.col}
                    if piece.position is not None
                    else None
                ),
                "captured": piece.captured,
                "finished": piece.finished,
            }
            for piece in game.pieces.values()
        ],
        "scores": {color.value: score for color, score in game.scores.items()},
        "current_player": game.current_player.value,
        "turn_count": game.turn_count,
        "exited_pieces": game.exited_pieces,
        "status": game.get_victory_status().value,
        "first_exit_piece_id": game.first_exit_piece_id,
        "movement_spent": game.movement_spent,
        "turn_start_positions": {
            piece_id: {"row": pos.row, "col": pos.col}
            for piece_id, pos in game.turn_start_positions.items()
        },
        "visited_positions": {
            piece_id: [
                {"row": pos.row, "col": pos.col}
                for pos in sorted(positions, key=lambda p: (p.row, p.col))
            ]
            for piece_id, positions in game.visited_positions.items()
        },
        "moved_piece_ids": sorted(game.moved_piece_ids),
    }


def deserialize_game_state(state: dict[str, object]) -> Game:
    """Reconstruit le moteur depuis le JSON persisté dans Supabase."""
    try:
        board_data = state["board"]
        if not isinstance(board_data, dict):
            raise TypeError("Plateau absent ou invalide.")

        size = int(board_data["size"])
        heights = board_data["heights"]
        if not isinstance(heights, list):
            raise TypeError("Hauteurs absentes ou invalides.")

        pieces: dict[str, Piece] = {}
        raw_pieces = state["pieces"]
        if not isinstance(raw_pieces, list):
            raise TypeError("Pièces absentes ou invalides.")

        for item in raw_pieces:
            if not isinstance(item, dict):
                raise TypeError("Pièce invalide.")
            raw_position = item["position"]
            position = None
            if isinstance(raw_position, dict):
                position = Position(
                    row=int(raw_position["row"]),
                    col=int(raw_position["col"]),
                )
            piece = Piece(
                id=str(item["id"]),
                owner=PlayerColor(str(item["owner"])),
                piece_type=PieceType(str(item["piece_type"])),
                position=position,
                captured=bool(item["captured"]),
                finished=bool(item["finished"]),
            )
            pieces[piece.id] = piece

        board = Board(size=size, heights=heights)
        board.pieces = {
            piece.id: piece
            for piece in pieces.values()
            if piece.position is not None and not piece.captured and not piece.finished
        }

        scores_data = state["scores"]
        if not isinstance(scores_data, dict):
            raise TypeError("Scores absents ou invalides.")

        def read_position(raw: object) -> Position:
            if not isinstance(raw, dict):
                raise TypeError("Position invalide.")
            return Position(row=int(raw["row"]), col=int(raw["col"]))

        raw_start = state.get("turn_start_positions", {})
        raw_visited = state.get("visited_positions", {})
        raw_spent = state.get("movement_spent", {})
        if not all(
            isinstance(value, dict) for value in (raw_start, raw_visited, raw_spent)
        ):
            raise ValueError("État du tour invalide.")

        return Game(
            board=board,
            pieces=pieces,
            scores={
                PlayerColor.WHITE: int(scores_data[PlayerColor.WHITE.value]),
                PlayerColor.BLACK: int(scores_data[PlayerColor.BLACK.value]),
            },
            current_player=PlayerColor(str(state["current_player"])),
            turn_count=int(state["turn_count"]),
            exited_pieces=int(state["exited_pieces"]),
            status=GameStatus(str(state["status"])),
            first_exit_piece_id=(
                str(state["first_exit_piece_id"])
                if state.get("first_exit_piece_id") is not None
                else None
            ),
            movement_spent={str(key): int(value) for key, value in raw_spent.items()},
            turn_start_positions={
                str(key): read_position(value) for key, value in raw_start.items()
            },
            visited_positions={
                str(key): {read_position(pos) for pos in value}
                for key, value in raw_visited.items()
                if isinstance(value, list)
            },
            moved_piece_ids={
                str(piece_id) for piece_id in state.get("moved_piece_ids", [])
            },
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("L'état de la partie enregistré est invalide.") from exc
