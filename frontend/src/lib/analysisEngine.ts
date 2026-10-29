import type { GameState, MovePath, Piece, PlayerColor } from "./api";
import { getCombatPreview } from "./combat";
import { getLocalAttackPaths, getLocalLegalPaths } from "./movement";

export type AnalysisAction =
  | { type: "move"; pieceId: string; path: MovePath }
  | { type: "attack"; pieceId: string; targetId: string; path: MovePath }
  | { type: "exit"; pieceId: string }
  | { type: "end_turn" };

const otherColor = (color: PlayerColor): PlayerColor =>
  color === "WHITE" ? "BLACK" : "WHITE";

function withVictoryStatus(state: GameState): GameState {
  let status: GameState["status"] = "ONGOING";
  const firstExit = state.first_exit_piece_id
    ? state.pieces.find((piece) => piece.id === state.first_exit_piece_id)
    : undefined;

  if (firstExit?.finished && firstExit.piece_type === "SENTINEL") {
    status = firstExit.owner === "WHITE" ? "WHITE_WINS" : "BLACK_WINS";
  } else {
    for (const color of ["WHITE", "BLACK"] as const) {
      const owned = state.pieces.filter((piece) => piece.owner === color);
      if (owned.length > 0 && owned.every((piece) => piece.captured)) {
        status = color === "WHITE" ? "BLACK_WINS" : "WHITE_WINS";
        break;
      }
    }
  }

  if (status === "ONGOING" && state.exited_pieces >= 2) {
    const white = state.scores.WHITE ?? 0;
    const black = state.scores.BLACK ?? 0;
    status = white === black ? "DRAW" : white > black ? "WHITE_WINS" : "BLACK_WINS";
  }

  if (status === "ONGOING" && state.turn_count >= 200) {
    const white = state.pieces.filter((piece) =>
      piece.owner === "WHITE" && piece.position && !piece.captured && !piece.finished,
    );
    const black = state.pieces.filter((piece) =>
      piece.owner === "BLACK" && piece.position && !piece.captured && !piece.finished,
    );
    const whiteScore = state.scores.WHITE ?? 0;
    const blackScore = state.scores.BLACK ?? 0;
    if (whiteScore + blackScore > 0) {
      status = whiteScore === blackScore ? "DRAW" : whiteScore > blackScore ? "WHITE_WINS" : "BLACK_WINS";
    } else {
      const distance = (piece: Piece) => piece.position
        ? Math.abs((piece.owner === "WHITE" ? state.board_size - 1 : 0) - piece.position.row)
        : Number.MAX_SAFE_INTEGER;
      const whiteDistance = Math.min(...white.map(distance), Number.MAX_SAFE_INTEGER);
      const blackDistance = Math.min(...black.map(distance), Number.MAX_SAFE_INTEGER);
      if (whiteDistance !== blackDistance) {
        status = whiteDistance < blackDistance ? "WHITE_WINS" : "BLACK_WINS";
      } else {
        const whiteForce = Math.max(0, ...white.filter((piece) => distance(piece) === whiteDistance).map((piece) => piece.force));
        const blackForce = Math.max(0, ...black.filter((piece) => distance(piece) === blackDistance).map((piece) => piece.force));
        status = whiteForce === blackForce ? "DRAW" : whiteForce > blackForce ? "WHITE_WINS" : "BLACK_WINS";
      }
    }
  }

  return {
    ...state,
    status,
    winner: status === "WHITE_WINS" ? "WHITE" : status === "BLACK_WINS" ? "BLACK" : null,
    lifecycle_status: status === "ONGOING" ? "ongoing" : "finished",
  };
}

function finishTurn(state: GameState): GameState {
  if (state.status !== "ONGOING" || state.current_player === null) return state;
  const currentPlayer = otherColor(state.current_player);
  return withVictoryStatus({
    ...state,
    current_player: currentPlayer,
    my_color: state.mode === "local" ? currentPlayer : state.my_color,
    turn_count: state.turn_count + 1,
    has_moved_this_turn: false,
    moved_piece_id: null,
    movement_spent: {},
    turn_start_positions: {},
    visited_positions: {},
  });
}

function requirePiece(state: GameState, pieceId: string): Piece {
  const piece = state.pieces.find((candidate) => candidate.id === pieceId);
  if (!piece?.position || piece.captured || piece.finished) {
    throw new Error("Cette pièce n'est plus sur le plateau.");
  }
  if (piece.owner !== state.current_player) {
    throw new Error("Ce n'est pas le tour de cette couleur.");
  }
  if (state.moved_piece_id && state.moved_piece_id !== piece.id) {
    throw new Error("Continue avec la pièce déjà déplacée pendant ce tour.");
  }
  return piece;
}

function applyMove(state: GameState, pieceId: string, selectedPath: MovePath): GameState {
  const piece = requirePiece(state, pieceId);
  const legal = getLocalLegalPaths(state, pieceId).some((path) =>
    path.special === selectedPath.special &&
    path.path.length === selectedPath.path.length &&
    path.path.every((step, index) =>
      step.row === selectedPath.path[index].row && step.col === selectedPath.path[index].col,
    ),
  );
  if (!legal) throw new Error("Ce trajet n'est pas légal dans cette position.");

  const start = piece.position!;
  const currentSpent = state.movement_spent[piece.id] ?? 0;
  const movementSpent = selectedPath.special
    ? piece.movement_points
    : currentSpent + selectedPath.cost;
  const visited = new Map(Object.entries(state.visited_positions));
  const positions = new Map<string, { row: number; col: number }>();
  for (const position of visited.get(piece.id) ?? [state.turn_start_positions[piece.id] ?? start]) {
    positions.set(`${position.row}:${position.col}`, position);
  }
  for (const position of selectedPath.path) positions.set(`${position.row}:${position.col}`, position);
  visited.set(piece.id, [...positions.values()]);

  return {
    ...state,
    pieces: state.pieces.map((candidate) => candidate.id === piece.id
      ? { ...candidate, position: selectedPath.destination }
      : candidate),
    has_moved_this_turn: true,
    moved_piece_id: piece.id,
    movement_spent: { ...state.movement_spent, [piece.id]: movementSpent },
    turn_start_positions: { ...state.turn_start_positions, [piece.id]: state.turn_start_positions[piece.id] ?? start },
    visited_positions: Object.fromEntries(visited),
  };
}

function applyAttack(
  state: GameState,
  pieceId: string,
  targetId: string,
  selectedPath: MovePath,
): GameState {
  const attacker = requirePiece(state, pieceId);
  const defender = state.pieces.find((piece) => piece.id === targetId);
  if (!defender?.position || defender.captured || defender.finished || defender.owner === attacker.owner) {
    throw new Error("La cible n'est pas une pièce adverse active.");
  }
  const legalPath = getLocalAttackPaths(state, pieceId).get(targetId)?.find((path) =>
    path.special === selectedPath.special &&
    path.path.length === selectedPath.path.length &&
    path.path.every((step, index) =>
      step.row === selectedPath.path[index].row && step.col === selectedPath.path[index].col,
    ),
  );
  if (!legalPath) throw new Error("Cette attaque n'est pas à portée.");
  const movementSpent = legalPath.special
    ? attacker.movement_points
    : (state.movement_spent[attacker.id] ?? 0) + legalPath.cost;
  const preview = getCombatPreview(state, attacker, defender, movementSpent);
  if (!preview.canCapture) {
    throw new Error(`Force insuffisante : ${preview.attackForce} contre ${preview.defenseForce}.`);
  }

  const attacked = {
    ...state,
    pieces: state.pieces.map((piece) => piece.id === defender.id
      ? { ...piece, position: null, captured: true }
      : piece.id === attacker.id
        ? { ...piece, position: defender.position }
        : piece),
    has_moved_this_turn: true,
    moved_piece_id: attacker.id,
  };
  return finishTurn(withVictoryStatus(attacked));
}

function applyExit(state: GameState, pieceId: string): GameState {
  const piece = requirePiece(state, pieceId);
  const exitRow = piece.owner === "WHITE" ? state.board_size - 1 : 0;
  if (piece.position!.row !== exitRow) throw new Error("La pièce n'a pas atteint sa rangée de sortie.");
  const exited: GameState = {
    ...state,
    pieces: state.pieces.map((candidate) => candidate.id === piece.id
      ? { ...candidate, position: null, finished: true, captured: false }
      : candidate),
    scores: { ...state.scores, [piece.owner]: (state.scores[piece.owner] ?? 0) + piece.force },
    exited_pieces: state.exited_pieces + 1,
    first_exit_piece_id: state.first_exit_piece_id ?? piece.id,
    has_moved_this_turn: true,
    moved_piece_id: piece.id,
  };
  const finished = withVictoryStatus(exited);
  return finished.status === "ONGOING" ? finishTurn(finished) : finished;
}

export function applyAnalysisAction(state: GameState, action: AnalysisAction): GameState {
  if (state.lifecycle_status !== "ongoing" || state.status !== "ONGOING") {
    throw new Error("La partie est déjà terminée dans cette variante.");
  }
  switch (action.type) {
    case "move":
      return applyMove(state, action.pieceId, action.path);
    case "attack":
      return applyAttack(state, action.pieceId, action.targetId, action.path);
    case "exit":
      return applyExit(state, action.pieceId);
    case "end_turn":
      if (!state.has_moved_this_turn) throw new Error("Effectue au moins un déplacement avant de terminer le tour.");
      return finishTurn(state);
  }
}
