import pytest

from veylith.domain.combat import CombatResult
from veylith.domain.enums import PieceType, PlayerColor
from veylith.domain.game import Game
from veylith.domain.models import Piece, Position
from veylith.domain.victory import GameStatus


@pytest.fixture
def game():
    return Game()


@pytest.fixture
def custom_game():
    game = Game()

    # Retirer les pièces placées automatiquement par Game()
    game.board.pieces.clear()
    game.pieces.clear()

    return game


def add_piece(game, piece_id, owner, piece_type, position):
    piece = Piece(
        id=piece_id,
        owner=owner,
        piece_type=piece_type,
        position=position,
    )
    game.board.add_piece(piece)
    game.pieces[piece_id] = piece
    return piece


def test_game_initializes_twelve_pieces(game):
    assert len(game.pieces) == 12
    assert len(game.board.pieces) == 12
    assert game.current_player == PlayerColor.WHITE
    assert game.turn_count == 0
    assert game.status == GameStatus.ONGOING


def test_game_initializes_six_pieces_per_player(game):
    white = [p for p in game.pieces.values() if p.owner == PlayerColor.WHITE]
    black = [p for p in game.pieces.values() if p.owner == PlayerColor.BLACK]

    assert len(white) == 6
    assert len(black) == 6


def test_game_initializes_correct_piece_types(game):
    for owner in (PlayerColor.WHITE, PlayerColor.BLACK):
        pieces = [p for p in game.pieces.values() if p.owner == owner]
        types = [p.piece_type for p in pieces]

        assert types.count(PieceType.EXPLORER) == 2
        assert types.count(PieceType.VANGUARD) == 2
        assert types.count(PieceType.SENTINEL) == 2


def test_starting_formation_is_sentinel_vanguard_explorer_symmetrically(game):
    expected = [
        PieceType.SENTINEL,
        PieceType.VANGUARD,
        PieceType.EXPLORER,
        PieceType.EXPLORER,
        PieceType.VANGUARD,
        PieceType.SENTINEL,
    ]
    for owner, row in ((PlayerColor.WHITE, 0), (PlayerColor.BLACK, 9)):
        starting_pieces = sorted(
            (piece for piece in game.pieces.values() if piece.owner == owner),
            key=lambda piece: piece.position.col,
        )
        assert [piece.piece_type for piece in starting_pieces] == expected
        assert [piece.position.col for piece in starting_pieces] == list(range(2, 8))
        assert all(piece.position.row == row for piece in starting_pieces)


def test_white_can_move_its_piece(game):
    piece = game.pieces["white_explorer_1"]
    destination = Position(1, 2)

    path = game.move_piece(piece.id, destination)

    assert piece.position == destination
    assert path.destination == destination
    assert game.current_player == PlayerColor.WHITE


def test_move_along_exact_path_applies_client_selected_route(custom_game):
    explorer = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    route = [Position(4, 5), Position(4, 6)]

    result = custom_game.move_along_path(explorer.id, route)

    assert result.path == tuple(route)
    assert explorer.position == Position(4, 6)
    assert custom_game.movement_spent[explorer.id] == 2
    assert custom_game.visited_positions[explorer.id] == {
        Position(4, 4),
        Position(4, 5),
        Position(4, 6),
    }


def test_move_along_path_rejects_a_non_legal_route(custom_game):
    explorer = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )

    with pytest.raises(ValueError, match="Trajet invalide"):
        custom_game.move_along_path(
            explorer.id,
            [Position(4, 5), Position(4, 6)],
            special="diagonal",
        )

    assert explorer.position == Position(4, 4)
    assert custom_game.movement_spent == {}


def test_cannot_move_a_second_piece_during_the_same_turn(game):
    game.move_piece("white_sentinel_5", Position(1, 2))

    with pytest.raises(ValueError, match="même pièce"):
        game.move_piece("white_vanguard_3", Position(1, 3))

    assert game.moved_piece_id == "white_sentinel_5"
    assert game.current_player == PlayerColor.WHITE
    assert game.pieces["white_sentinel_5"].position == Position(1, 2)
    assert game.pieces["white_vanguard_3"].position == Position(0, 3)
    assert game.moved_piece_ids == {"white_sentinel_5"}


def test_player_cannot_move_opponents_piece(game):
    with pytest.raises(ValueError):
        game.move_piece("black_explorer_1", Position(8, 2))


def test_cannot_move_to_occupied_square(game):
    with pytest.raises(ValueError):
        game.move_piece("white_explorer_1", Position(0, 3))


def test_cannot_exceed_movement_budget(custom_game):
    piece = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )

    custom_game.move_piece(piece.id, Position(4, 5))
    custom_game.move_piece(piece.id, Position(4, 6))
    custom_game.move_piece(piece.id, Position(4, 7))
    custom_game.move_piece(piece.id, Position(4, 8))
    custom_game.move_piece(piece.id, Position(4, 9))

    with pytest.raises(ValueError):
        custom_game.move_piece(piece.id, Position(3, 9))


def test_end_turn_switches_player(game):
    game.move_piece("white_sentinel_5", Position(1, 2))

    game.end_turn()

    assert game.current_player == PlayerColor.BLACK
    assert game.turn_count == 1


def test_cannot_end_turn_without_moving_a_piece(game):
    with pytest.raises(ValueError, match="déplacer au moins une pièce"):
        game.end_turn()


def test_end_turn_resets_movement_tracking(game):
    piece = game.pieces["white_explorer_1"]
    game.move_piece(piece.id, Position(1, 2))

    assert piece.id in game.movement_spent

    game.end_turn()

    assert game.movement_spent == {}
    assert game.turn_start_positions == {}
    assert game.visited_positions == {}
    assert game.moved_piece_ids == set()


def test_direct_ranged_attack_can_be_the_turn_action(custom_game):
    attacker = add_piece(
        custom_game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    add_piece(
        custom_game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 5),
    )

    result = custom_game.attack_piece(attacker.id, "defender")

    assert result.success
    assert custom_game.current_player == PlayerColor.BLACK


def test_attack_along_exact_path_captures_at_route_endpoint(custom_game):
    attacker = add_piece(
        custom_game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        custom_game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 6),
    )
    add_piece(
        custom_game,
        "other_defender",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        Position(0, 0),
    )
    route = [Position(4, 5), Position(4, 6)]

    result = custom_game.attack_piece(attacker.id, defender.id, path=route)

    assert result.success
    assert defender.captured
    assert defender.position is None
    assert attacker.position == Position(4, 6)
    assert custom_game.movement_spent == {}
    assert custom_game.current_player == PlayerColor.BLACK


def test_successful_attack_captures_defender(custom_game, monkeypatch):
    attacker = add_piece(
        custom_game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(4, 4),
    )
    defender = add_piece(
        custom_game,
        "defender",
        PlayerColor.BLACK,
        PieceType.EXPLORER,
        Position(4, 5),
    )

    custom_game.moved_piece_ids.add(attacker.id)
    custom_game.movement_spent[attacker.id] = attacker.movement_points

    monkeypatch.setattr(
        "veylith.domain.game.resolve_combat",
        lambda *args: CombatResult(
            attacker_id="attacker",
            defender_id="defender",
            attack_force=5,
            defense_force=1,
            success=True,
        ),
    )

    result = custom_game.attack_piece(attacker.id, defender.id)

    assert result.success
    assert defender.captured
    assert defender.position is None
    assert attacker.position == Position(4, 5)
    assert custom_game.current_player == PlayerColor.BLACK


def test_insufficient_attack_is_rejected_without_ending_turn(custom_game, monkeypatch):
    attacker = add_piece(
        custom_game,
        "attacker",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    defender = add_piece(
        custom_game,
        "defender",
        PlayerColor.BLACK,
        PieceType.SENTINEL,
        Position(4, 5),
    )

    custom_game.moved_piece_ids.add(attacker.id)

    monkeypatch.setattr(
        "veylith.domain.game.resolve_combat",
        lambda *args: CombatResult(
            attacker_id="attacker",
            defender_id="defender",
            attack_force=1,
            defense_force=3,
            success=False,
        ),
    )

    with pytest.raises(ValueError, match="Force d'attaque insuffisante"):
        custom_game.attack_piece(attacker.id, defender.id)

    assert not defender.captured
    assert defender.position == Position(4, 5)
    assert attacker.position == Position(4, 4)
    assert custom_game.current_player == PlayerColor.WHITE
    assert custom_game.has_moved_this_turn


def test_exit_piece_awards_force_points(custom_game):
    piece = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(9, 4),
    )

    points = custom_game.exit_piece(piece.id)

    assert points == piece.force
    assert custom_game.scores[PlayerColor.WHITE] == piece.force
    assert piece.finished
    assert not piece.captured
    assert piece.position is None
    assert piece.id not in custom_game.board.pieces


def test_cannot_exit_before_reaching_exit_row(custom_game):
    piece = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(8, 4),
    )

    with pytest.raises(ValueError):
        custom_game.exit_piece(piece.id)


def test_sentinel_exit_wins_immediately(custom_game):
    sentinel = add_piece(
        custom_game,
        "sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(9, 4),
    )

    custom_game.exit_piece(sentinel.id)

    assert custom_game.status == GameStatus.WHITE_WINS


def test_captured_piece_cannot_move(custom_game):
    piece = add_piece(
        custom_game,
        "explorer",
        PlayerColor.WHITE,
        PieceType.EXPLORER,
        Position(4, 4),
    )
    piece.captured = True
    piece.position = None

    with pytest.raises(ValueError):
        custom_game.move_piece(piece.id, Position(4, 5))


def test_game_cannot_continue_after_victory(custom_game):
    sentinel = add_piece(
        custom_game,
        "sentinel",
        PlayerColor.WHITE,
        PieceType.SENTINEL,
        Position(9, 4),
    )
    custom_game.exit_piece(sentinel.id)

    with pytest.raises(ValueError):
        custom_game.move_piece(sentinel.id, Position(8, 4))
