import assert from "node:assert/strict";
import test from "node:test";

import { applyAnalysisAction } from "../src/lib/analysisEngine.ts";
import { findPath, makeGame, makePiece } from "./helpers.mjs";
import { getLocalAttackPaths, getLocalLegalPaths } from "../src/lib/movement.ts";

test("analysis move applies a legal route without mutating the source snapshot", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const initial = makeGame([explorer]);
  const path = findPath(getLocalLegalPaths(initial, explorer.id), 5, 6);

  const next = applyAnalysisAction(initial, { type: "move", pieceId: explorer.id, path });

  assert.deepEqual(next.pieces[0].position, { row: 5, col: 6 });
  assert.equal(next.moved_piece_id, explorer.id);
  assert.deepEqual(initial.pieces[0].position, { row: 5, col: 5 });
});

test("analysis rejects an illegal path and an action by the inactive color", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const initial = makeGame([explorer]);

  assert.throws(
    () => applyAnalysisAction(initial, {
      type: "move",
      pieceId: explorer.id,
      path: {
        start: { row: 5, col: 5 },
        destination: { row: 2, col: 2 },
        path: [{ row: 2, col: 2 }],
        cost: 1,
        special: null,
      },
    }),
    /trajet n'est pas légal/,
  );
  assert.throws(
    () => applyAnalysisAction(initial, { type: "move", pieceId: "b-missing", path: {} }),
    /n'est plus sur le plateau/,
  );
});

test("analysis switches turns and resets per-turn movement data", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const initial = makeGame([explorer]);
  const path = findPath(getLocalLegalPaths(initial, explorer.id), 5, 6);
  const moved = applyAnalysisAction(initial, { type: "move", pieceId: explorer.id, path });
  const next = applyAnalysisAction(moved, { type: "end_turn" });

  assert.equal(next.current_player, "BLACK");
  assert.equal(next.turn_count, 1);
  assert.equal(next.moved_piece_id, null);
  assert.deepEqual(next.movement_spent, {});
  assert.throws(
    () => applyAnalysisAction(initial, { type: "end_turn" }),
    /au moins un déplacement/,
  );
});

test("analysis resolves a legal ranged capture and records elimination victory", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 4, 4);
  const defender = makePiece("b-explorer", "BLACK", "EXPLORER", 4, 6);
  const initial = makeGame([attacker, defender]);
  const path = getLocalAttackPaths(initial, attacker.id).get(defender.id)[0];

  const result = applyAnalysisAction(initial, {
    type: "attack",
    pieceId: attacker.id,
    targetId: defender.id,
    path,
  });

  assert.equal(result.pieces.find((piece) => piece.id === defender.id).captured, true);
  assert.equal(result.pieces.find((piece) => piece.id === attacker.id).position.col, 6);
  assert.equal(result.status, "WHITE_WINS");
  assert.equal(result.lifecycle_status, "finished");
});

test("analysis refuses an attack whose force is too low", () => {
  const attacker = makePiece("w-explorer", "WHITE", "EXPLORER", 4, 4);
  const defender = makePiece("b-vanguard", "BLACK", "VANGUARD", 4, 5);
  const initial = makeGame([attacker, defender]);
  const path = getLocalAttackPaths(initial, attacker.id).get(defender.id)[0];

  assert.throws(
    () => applyAnalysisAction(initial, {
      type: "attack",
      pieceId: attacker.id,
      targetId: defender.id,
      path,
    }),
    /Force insuffisante/,
  );
  assert.equal(defender.captured, false);
  assert.equal(initial.current_player, "WHITE");
});

test("sentinel exit ends analysis immediately and awards its force", () => {
  const sentinel = makePiece("w-sentinel", "WHITE", "SENTINEL", 9, 4);
  const enemy = makePiece("b-explorer", "BLACK", "EXPLORER", 0, 4);
  const initial = makeGame([sentinel, enemy]);

  const result = applyAnalysisAction(initial, { type: "exit", pieceId: sentinel.id });

  assert.equal(result.status, "WHITE_WINS");
  assert.equal(result.winner, "WHITE");
  assert.equal(result.scores.WHITE, 3);
  assert.equal(result.pieces.find((piece) => piece.id === sentinel.id).finished, true);
});

test("two explorer exits resolve by score and can finish in a draw", () => {
  const white = makePiece("w-explorer", "WHITE", "EXPLORER", 9, 4);
  const black = makePiece("b-explorer", "BLACK", "EXPLORER", 0, 4);
  const initial = makeGame([white, black]);
  const afterWhite = applyAnalysisAction(initial, { type: "exit", pieceId: white.id });
  const afterBlack = applyAnalysisAction(afterWhite, { type: "exit", pieceId: black.id });

  assert.equal(afterWhite.current_player, "BLACK");
  assert.equal(afterWhite.scores.WHITE, 1);
  assert.equal(afterBlack.status, "DRAW");
  assert.equal(afterBlack.lifecycle_status, "finished");
});

test("turn limit picks the closest side, then force when distances tie", () => {
  const white = makePiece("w-sentinel", "WHITE", "SENTINEL", 8, 4);
  const black = makePiece("b-explorer", "BLACK", "EXPLORER", 2, 4);
  const closest = makeGame([white, black], {
    turn_count: 199,
    has_moved_this_turn: true,
    moved_piece_id: white.id,
  });
  assert.equal(
    applyAnalysisAction(closest, { type: "end_turn" }).winner,
    "WHITE",
  );

  const tiedWhite = makePiece("w-sentinel", "WHITE", "SENTINEL", 7, 4);
  const tiedBlack = makePiece("b-explorer", "BLACK", "EXPLORER", 2, 4);
  const forceTieBreak = makeGame([tiedWhite, tiedBlack], {
    turn_count: 199,
    has_moved_this_turn: true,
    moved_piece_id: tiedWhite.id,
  });
  assert.equal(
    applyAnalysisAction(forceTieBreak, { type: "end_turn" }).winner,
    "WHITE",
  );
});

test("analysis rejects an exit away from the owning side's edge", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 8, 4);
  const initial = makeGame([explorer]);

  assert.throws(
    () => applyAnalysisAction(initial, { type: "exit", pieceId: explorer.id }),
    /n'a pas atteint sa rangée de sortie/,
  );
});

test("local analysis keeps the local color synchronized after a normal turn", () => {
  const white = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const black = makePiece("b-explorer", "BLACK", "EXPLORER", 2, 2);
  const initial = makeGame([white, black], { mode: "local" });
  const path = findPath(getLocalLegalPaths(initial, white.id), 5, 6);
  const moved = applyAnalysisAction(initial, { type: "move", pieceId: white.id, path });
  const next = applyAnalysisAction(moved, { type: "end_turn" });

  assert.equal(next.current_player, "BLACK");
  assert.equal(next.my_color, "BLACK");
});
