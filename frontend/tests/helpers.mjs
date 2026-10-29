export function makePiece(
  id,
  owner,
  pieceType,
  row,
  col,
  { force, movementPoints, captured = false, finished = false } = {},
) {
  const defaults = {
    EXPLORER: { force: 1, movementPoints: 5 },
    VANGUARD: { force: 2, movementPoints: 4 },
    SENTINEL: { force: 3, movementPoints: 3 },
  }[pieceType];

  return {
    id,
    owner,
    piece_type: pieceType,
    force: force ?? defaults.force,
    movement_points: movementPoints ?? defaults.movementPoints,
    position: row === null ? null : { row, col },
    captured,
    finished,
  };
}

export function makeGame(pieces, overrides = {}) {
  return {
    game_id: "game-test",
    mode: "online",
    visibility: "private",
    my_color: "WHITE",
    lifecycle_status: "ongoing",
    current_player: "WHITE",
    turn_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    opponent_username: "opponent",
    result: null,
    board_size: 10,
    has_moved_this_turn: false,
    moved_piece_id: null,
    movement_spent: {},
    turn_start_positions: {},
    visited_positions: {},
    heights: Array.from({ length: 10 }, () => Array(10).fill(0)),
    pieces,
    scores: { WHITE: 0, BLACK: 0 },
    exited_pieces: 0,
    first_exit_piece_id: null,
    status: "ONGOING",
    winner: null,
    ...overrides,
  };
}

export function findPath(paths, row, col, special = undefined) {
  return paths.find(
    (path) =>
      path.destination.row === row &&
      path.destination.col === col &&
      (special === undefined || path.special === special),
  );
}
