import assert from "node:assert/strict";
import test from "node:test";

import { getLocalAttackPaths, getLocalLegalPaths } from "../src/lib/movement.ts";
import { findPath, makeGame, makePiece } from "./helpers.mjs";

test("a piece can follow cardinal paths up to its movement budget", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const game = makeGame([explorer]);

  const paths = getLocalLegalPaths(game, explorer.id);

  assert.ok(findPath(paths, 5, 8));
  assert.ok(findPath(paths, 2, 5));
  assert.ok(paths.every((path) => path.cost <= explorer.movement_points));
});

test("the explorer retains its diagonal special move", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const paths = getLocalLegalPaths(makeGame([explorer]), explorer.id);

  const diagonal = findPath(paths, 4, 6, "diagonal");
  assert.ok(diagonal);
  assert.equal(diagonal.cost, explorer.movement_points);
  assert.equal(diagonal.path.length, 5);
});

test("the explorer double jump records its intermediate square", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 5);
  const paths = getLocalLegalPaths(makeGame([explorer]), explorer.id);
  const jump = findPath(paths, 5, 7, "double_jump");

  assert.ok(jump);
  assert.deepEqual(jump.path, [{ row: 5, col: 6 }, { row: 5, col: 7 }]);
  assert.equal(jump.cost, explorer.movement_points);
});

test("ordinary pieces cannot move diagonally or use explorer jumps", () => {
  const sentinel = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const paths = getLocalLegalPaths(makeGame([sentinel]), sentinel.id);

  assert.equal(
    paths.some(
      (path) =>
        path.destination.row === 4 &&
        path.destination.col === 6 &&
        (path.path.length === 1 || path.special !== null),
    ),
    false,
  );
  assert.equal(paths.some((path) => path.special !== null), false);
});

test("occupied squares block both destinations and routes through them", () => {
  const sentinel = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const blocker = makePiece("b-explorer", "BLACK", "EXPLORER", 5, 6);
  const paths = getLocalLegalPaths(makeGame([sentinel, blocker]), sentinel.id);

  assert.equal(findPath(paths, 5, 6), undefined);
  assert.equal(paths.some((path) => path.path.some((step) => step.row === 5 && step.col === 6)), false);
});

test("height changes consume movement points and constrain remaining reach", () => {
  const sentinel = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const game = makeGame([sentinel]);
  game.heights[5][6] = 3;

  let paths = getLocalLegalPaths(game, sentinel.id);
  assert.equal(findPath(paths, 5, 6), undefined);

  game.heights[5][6] = 1;
  paths = getLocalLegalPaths(game, sentinel.id);
  assert.equal(findPath(paths, 5, 6).cost, 2);
  game.movement_spent[sentinel.id] = 2;
  paths = getLocalLegalPaths(game, sentinel.id);
  assert.equal(findPath(paths, 5, 6), undefined);
});

test("a piece that has moved cannot switch pieces or revisit its turn start", () => {
  const explorer = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 6);
  const sentinel = makePiece("w-sentinel", "WHITE", "SENTINEL", 1, 1);
  const game = makeGame([explorer, sentinel], {
    moved_piece_id: explorer.id,
    has_moved_this_turn: true,
    turn_start_positions: { [explorer.id]: { row: 5, col: 5 } },
    visited_positions: { [explorer.id]: [{ row: 5, col: 5 }, { row: 5, col: 6 }] },
    movement_spent: { [explorer.id]: 1 },
  });

  assert.deepEqual(getLocalLegalPaths(game, sentinel.id), []);
  const paths = getLocalLegalPaths(game, explorer.id);
  assert.equal(findPath(paths, 5, 5), undefined);
});

test("a ranged attack destination is offered only when reachable with remaining movement", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const target = makePiece("b-explorer", "BLACK", "EXPLORER", 5, 8);
  const game = makeGame([attacker, target]);

  assert.ok(getLocalAttackPaths(game, attacker.id).has(target.id));
  game.movement_spent[attacker.id] = 2;
  assert.equal(getLocalAttackPaths(game, attacker.id).has(target.id), false);
});

test("ranged attack paths cannot pass through another piece", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const blocker = makePiece("w-explorer", "WHITE", "EXPLORER", 5, 6);
  const target = makePiece("b-explorer", "BLACK", "EXPLORER", 5, 7);
  const paths = getLocalAttackPaths(makeGame([attacker, blocker, target]), attacker.id);

  assert.equal(paths.has(target.id), false);
});
