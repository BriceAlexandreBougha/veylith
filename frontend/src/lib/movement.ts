import type { GameState, MovePath, Piece } from "./api";

interface Position {
  row: number;
  col: number;
}

const keyOf = ({ row, col }: Position) => `${row}:${col}`;

function samePosition(first: Position, second: Position): boolean {
  return first.row === second.row && first.col === second.col;
}

function adjacentPositions(position: Position, size: number): Position[] {
  return [
    { row: position.row - 1, col: position.col },
    { row: position.row + 1, col: position.col },
    { row: position.row, col: position.col - 1 },
    { row: position.row, col: position.col + 1 },
  ].filter(({ row, col }) => row >= 0 && col >= 0 && row < size && col < size);
}

export function getLocalLegalPaths(game: GameState, pieceId: string): MovePath[] {
  const piece = game.pieces.find((candidate) => candidate.id === pieceId);
  if (
    !piece?.position ||
    piece.captured ||
    piece.finished ||
    piece.owner !== game.current_player ||
    (game.moved_piece_id !== null && game.moved_piece_id !== piece.id)
  ) {
    return [];
  }

  const start = piece.position;
  const startOfTurn = game.turn_start_positions[piece.id] ?? start;
  const visitedThisTurn = new Set(
    (game.visited_positions[piece.id] ?? [startOfTurn]).map(keyOf),
  );
  const remaining = piece.movement_points - (game.movement_spent[piece.id] ?? 0);
  if (remaining <= 0) return [];

  const occupied = new Map<string, Piece>();
  for (const other of game.pieces) {
    if (other.position && !other.captured && !other.finished) {
      occupied.set(keyOf(other.position), other);
    }
  }

  const heightAt = ({ row, col }: Position) => game.heights[row][col];
  const isBlocked = (position: Position) => {
    const occupant = occupied.get(keyOf(position));
    return occupant !== undefined && occupant.id !== piece.id;
  };

  const results = new Map<string, MovePath>();
  const save = (position: Position, path: Position[], cost: number, special: string | null) => {
    if (
      path.some((step) => samePosition(step, startOfTurn)) ||
      path.some((step) => visitedThisTurn.has(keyOf(step)) && !samePosition(step, piece.position!))
    ) {
      return;
    }
    // Keep every valid route, not only the cheapest route to a destination.
    // The route editor must be able to continue from the exact first step the
    // player chose; collapsing routes by destination hides valid continuations.
    const routeKey = path.map(keyOf).join(">");
    const key = `${keyOf(position)}:${special ?? "normal"}:${routeKey}`;
    results.set(key, { start, destination: position, path, cost, special });
  };

  const explore = (current: Position, path: Position[], visited: Set<string>, spent: number) => {
    for (const destination of adjacentPositions(current, game.board_size)) {
      if (isBlocked(destination)) continue;
      if (visited.has(keyOf(destination))) continue;

      const cost = 1 + Math.abs(heightAt(destination) - heightAt(current));
      const total = spent + cost;
      if (total > remaining) continue;

      const nextPath = [...path, destination];
      const nextVisited = new Set(visited).add(keyOf(destination));
      save(destination, nextPath, total, null);
      explore(destination, nextPath, nextVisited, total);
    }

    if (piece.piece_type !== "EXPLORER") return;

    for (const dr of [-1, 1]) {
      for (const dc of [-1, 1]) {
        const destination = { row: current.row + dr, col: current.col + dc };
        if (
          destination.row < 0 || destination.col < 0 ||
          destination.row >= game.board_size || destination.col >= game.board_size ||
          isBlocked(destination) || visited.has(keyOf(destination)) || spent + 1 > remaining
        ) continue;
        save(destination, [...path, destination], remaining, "diagonal");
      }
    }

    for (const middle of adjacentPositions(current, game.board_size)) {
      const dr = middle.row - current.row;
      const dc = middle.col - current.col;
      const destination = { row: current.row + 2 * dr, col: current.col + 2 * dc };
      if (
        destination.row < 0 || destination.col < 0 ||
        destination.row >= game.board_size || destination.col >= game.board_size ||
        isBlocked(middle) || isBlocked(destination) ||
        visited.has(keyOf(destination)) || visited.has(keyOf(middle)) || spent + 2 > remaining
      ) continue;
      save(destination, [...path, middle, destination], remaining, "double_jump");
    }
  };

  explore(start, [], new Set([keyOf(start)]), 0);
  return [...results.values()];
}

export function getLocalAttackablePieceIds(game: GameState, pieceId: string): Set<string> {
  if (
    game.lifecycle_status !== "ongoing" ||
    (game.moved_piece_id !== null && game.moved_piece_id !== pieceId)
  ) return new Set();
  const attacker = game.pieces.find((piece) => piece.id === pieceId);
  if (!attacker?.position || attacker.owner !== game.current_player) return new Set();

  const attackable = new Set<string>();
  for (const target of game.pieces) {
    if (
      target.owner === attacker.owner ||
      !target.position ||
      target.captured ||
      target.finished
    ) continue;

    const attackView: GameState = {
      ...game,
      movement_spent: {
        ...game.movement_spent,
        [pieceId]: Math.min(
          game.movement_spent[pieceId] ?? 0,
          attacker.movement_points - 1,
        ),
      },
      turn_start_positions: { ...game.turn_start_positions, [pieceId]: attacker.position },
      visited_positions: { ...game.visited_positions, [pieceId]: [] },
      pieces: game.pieces.map((piece) =>
        piece.id === target.id ? { ...piece, position: null } : piece,
      ),
    };
    if (
      getLocalLegalPaths(attackView, pieceId).some(
        (path) =>
          path.destination.row === target.position!.row &&
          path.destination.col === target.position!.col,
      )
    ) {
      attackable.add(target.id);
    }
  }
  return attackable;
}

export function getLocalAttackPaths(
  game: GameState,
  pieceId: string,
): Map<string, MovePath[]> {
  const attacker = game.pieces.find((piece) => piece.id === pieceId);
  if (
    game.lifecycle_status !== "ongoing" ||
    !attacker?.position ||
    attacker.owner !== game.current_player ||
    (game.moved_piece_id !== null && game.moved_piece_id !== pieceId)
  ) return new Map();

  const pathsByTarget = new Map<string, MovePath[]>();
  for (const target of game.pieces) {
    if (
      target.owner === attacker.owner ||
      !target.position ||
      target.captured ||
      target.finished
    ) continue;

    const attackView: GameState = {
      ...game,
      pieces: game.pieces.map((piece) =>
        piece.id === target.id ? { ...piece, position: null } : piece,
      ),
    };
    const paths = getLocalLegalPaths(attackView, pieceId).filter(
      (path) => path.destination.row === target.position!.row
        && path.destination.col === target.position!.col,
    );
    if (paths.length) pathsByTarget.set(target.id, paths);
  }
  return pathsByTarget;
}
