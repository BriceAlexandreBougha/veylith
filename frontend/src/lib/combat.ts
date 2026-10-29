import type { GameState, Piece } from "./api";
import { getLocalAttackablePieceIds } from "./movement";

export interface CombatPreview {
  attackForce: number;
  defenseForce: number;
  canCapture: boolean;
}

function isActive(piece: Piece): boolean {
  return piece.position !== null && !piece.captured && !piece.finished;
}

function areAdjacent(
  first: NonNullable<Piece["position"]>,
  second: NonNullable<Piece["position"]>,
): boolean {
  return Math.abs(first.row - second.row) + Math.abs(first.col - second.col) === 1;
}

export function getLocalCombatPreviews(
  game: GameState,
  attackerId: string,
): Map<string, CombatPreview> {
  const piecesById = new Map(game.pieces.map((piece) => [piece.id, piece]));
  const attacker = piecesById.get(attackerId);
  if (!attacker?.position) return new Map();

  const previews = new Map<string, CombatPreview>();
  for (const defenderId of getLocalAttackablePieceIds(game, attackerId)) {
    const defender = piecesById.get(defenderId);
    if (!defender?.position) continue;

    const movementSpent = game.movement_spent[attacker.id] ?? 0;
    previews.set(defenderId, getCombatPreview(game, attacker, defender, movementSpent));
  }
  return previews;
}

export function getCombatPreview(
  game: GameState,
  attacker: Piece,
  defender: Piece,
  movementSpent: number,
): CombatPreview {
  if (!attacker.position || !defender.position) {
    return { attackForce: 0, defenseForce: 0, canCapture: false };
  }

  const heightDifference =
    game.heights[attacker.position.row][attacker.position.col] -
    game.heights[defender.position.row][defender.position.col];
  const heightBonus = heightDifference > 0 ? 1 : heightDifference < 0 ? -1 : 0;
  const attackingSupport = game.pieces
    .filter(
      (piece) =>
        piece.id !== attacker.id &&
        piece.owner === attacker.owner &&
        isActive(piece) &&
        areAdjacent(piece.position!, defender.position!),
    )
    .reduce((force, piece) => force + piece.force, 0);
  const defendingSupport = game.pieces.filter(
    (piece) =>
      piece.id !== defender.id &&
      piece.owner === defender.owner &&
      isActive(piece) &&
      areAdjacent(piece.position!, defender.position!),
  ).length;
  const vanguardCharge =
    attacker.piece_type === "VANGUARD" &&
    movementSpent === attacker.movement_points
      ? 1
      : 0;
  const attackForce = attacker.force + heightBonus + attackingSupport + vanguardCharge;
  const defenseForce = defender.force + defendingSupport;

  return { attackForce, defenseForce, canCapture: attackForce >= defenseForce };
}
