import assert from "node:assert/strict";
import test from "node:test";

import { getCombatPreview, getLocalCombatPreviews } from "../src/lib/combat.ts";
import { makeGame, makePiece } from "./helpers.mjs";

test("height advantage and support contribute to attack force", () => {
  const attacker = makePiece("w-vanguard", "WHITE", "VANGUARD", 4, 4);
  const support = makePiece("w-explorer", "WHITE", "EXPLORER", 4, 5);
  const defender = makePiece("b-sentinel", "BLACK", "SENTINEL", 4, 6);
  const game = makeGame([attacker, support, defender]);
  game.heights[4][4] = 2;

  const preview = getCombatPreview(game, attacker, defender, 0);

  assert.equal(preview.attackForce, 4);
  assert.equal(preview.defenseForce, 3);
  assert.equal(preview.canCapture, true);
});

test("defensive allies add one defense force each", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 4, 4);
  const defender = makePiece("b-explorer", "BLACK", "EXPLORER", 4, 5);
  const defenderAlly = makePiece("b-vanguard", "BLACK", "VANGUARD", 3, 5);
  const game = makeGame([attacker, defender, defenderAlly]);

  const preview = getCombatPreview(game, attacker, defender, 0);

  assert.equal(preview.attackForce, 3);
  assert.equal(preview.defenseForce, 2);
  assert.equal(preview.canCapture, true);
});

test("a fully charged vanguard gets its bonus, but an incomplete charge does not", () => {
  const vanguard = makePiece("w-vanguard", "WHITE", "VANGUARD", 4, 4);
  const defender = makePiece("b-sentinel", "BLACK", "SENTINEL", 4, 5);
  const game = makeGame([vanguard, defender]);

  assert.equal(getCombatPreview(game, vanguard, defender, 3).attackForce, 2);
  assert.equal(getCombatPreview(game, vanguard, defender, 4).attackForce, 3);
});

test("combat previews are limited by movement reach and remaining points", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 5, 5);
  const reachable = makePiece("b-explorer-near", "BLACK", "EXPLORER", 5, 7);
  const tooFar = makePiece("b-explorer-far", "BLACK", "EXPLORER", 5, 9);
  const game = makeGame([attacker, reachable, tooFar]);

  assert.deepEqual([...getLocalCombatPreviews(game, attacker.id).keys()], [reachable.id]);
  game.movement_spent[attacker.id] = 2;
  assert.equal(getLocalCombatPreviews(game, attacker.id).size, 0);
});

test("inactive pieces cannot support combat", () => {
  const attacker = makePiece("w-sentinel", "WHITE", "SENTINEL", 4, 4);
  const defender = makePiece("b-sentinel", "BLACK", "SENTINEL", 4, 5);
  const inactiveAlly = makePiece("w-vanguard", "WHITE", "VANGUARD", 3, 5, {
    captured: true,
  });
  const game = makeGame([attacker, defender, inactiveAlly]);

  const preview = getCombatPreview(game, attacker, defender, 0);
  assert.equal(preview.attackForce, 3);
  assert.equal(preview.defenseForce, 3);
  assert.equal(preview.canCapture, true);
});
