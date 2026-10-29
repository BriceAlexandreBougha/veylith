import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Swords,
  X,
} from "lucide-react";
import { apiRequest } from "../lib/api";
import type { GameReplay, GameReplayAction, GameState, GameSummary, MovePath, Piece } from "../lib/api";
import { applyAnalysisAction, type AnalysisAction } from "../lib/analysisEngine";
import { getCombatPreview } from "../lib/combat";
import { getLocalAttackPaths, getLocalLegalPaths } from "../lib/movement";

const GameBoard3D = lazy(() => import("./GameBoard3D"));

type Position = { row: number; col: number };

interface RouteCandidate {
  path: MovePath;
  attackTargetId: string | null;
}

interface ReviewNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  mainline: boolean;
  turn: number;
  action: GameReplayAction | null;
  state: GameState;
}

interface RoutePlan {
  pieceId: string;
  steps: Position[];
  attackTargetId: string | null;
}

interface GameAnalysisProps {
  gameId: string;
  summary: GameSummary | null;
  onBack: () => void;
}

const pieceName: Record<Piece["piece_type"], string> = {
  EXPLORER: "Explorateur",
  VANGUARD: "Avant-garde",
  SENTINEL: "Sentinelle",
};

const colorName = (color: string | null) => color === "WHITE" ? "Ivoire" : color === "BLACK" ? "Obsidienne" : "—";
const positionKey = (position: Position) => `${position.row}:${position.col}`;
const samePosition = (a: Position, b: Position) => a.row === b.row && a.col === b.col;
const pathHasPrefix = (path: Position[], prefix: Position[]) =>
  prefix.length <= path.length && prefix.every((step, index) => samePosition(step, path[index]));

function actionTitle(action: GameReplayAction, before: GameState, after: GameState): string {
  const payload = action.payload;
  const id = typeof payload.piece_id === "string"
    ? payload.piece_id
    : typeof payload.attacker_id === "string" ? payload.attacker_id : null;
  const piece = id ? before.pieces.find((candidate) => candidate.id === id) : null;
  const name = piece ? pieceName[piece.piece_type] : "Pièce";
  switch (action.action_type) {
    case "move": {
      const to = typeof payload.destination === "object" && payload.destination !== null
        ? payload.destination as Position
        : null;
      return `${name} · ${to ? `case ${to.row + 1}, ${to.col + 1}` : "déplacement"}`;
    }
    case "attack": {
      const targetId = typeof payload.defender_id === "string" ? payload.defender_id : "";
      const target = before.pieces.find((candidate) => candidate.id === targetId);
      return `${name} attaque ${target ? pieceName[target.piece_type] : "une pièce"}`;
    }
    case "exit":
      return `${name} · sortie du plateau`;
    case "abandon":
    case "disconnect_forfeit":
      return "Fin de partie · abandon";
    default:
      return `${action.action_type} · tour ${after.turn_count}`;
  }
}

function buildReviewNodes(replay: GameReplay): { nodes: ReviewNode[]; mainline: string[] } {
  const root: ReviewNode = {
    id: "main-0",
    parentId: null,
    childIds: [],
    mainline: true,
    turn: 0,
    action: null,
    state: replay.initial_state,
  };
  const nodes = new Map<string, ReviewNode>([[root.id, root]]);
  const mainline = [root.id];
  let parent = root;

  for (const action of replay.actions) {
    const actionType = action.action_type.toLowerCase();
    if (actionType === "end_turn") {
      if (action.state_after) parent.state = action.state_after;
      continue;
    }
    const state = action.state_after ?? parent.state;
    const node: ReviewNode = {
      id: `main-${action.action_number}`,
      parentId: parent.id,
      childIds: [],
      mainline: true,
      turn: parent.state.turn_count,
      action,
      state,
    };
    parent.childIds.push(node.id);
    nodes.set(node.id, node);
    mainline.push(node.id);
    parent = node;
  }
  return { nodes: [...nodes.values()], mainline };
}

export default function GameAnalysis({ gameId, summary, onBack }: GameAnalysisProps) {
  const [replay, setReplay] = useState<GameReplay | null>(null);
  const [nodes, setNodes] = useState<ReviewNode[]>([]);
  const [mainline, setMainline] = useState<string[]>([]);
  const [currentNodeId, setCurrentNodeId] = useState("main-0");
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [playDelay, setPlayDelay] = useState(1200);
  const [animation, setAnimation] = useState<{ pieceId: string; path: Position[]; special: string | null } | null>(null);
  const branchNumber = useRef(1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    apiRequest<GameReplay>(`/games/${gameId}/actions`)
      .then((data) => {
        if (!active) return;
        const built = buildReviewNodes(data);
        setReplay(data);
        setNodes(built.nodes);
        setMainline(built.mainline);
        setCurrentNodeId(built.mainline[0]);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "Impossible de charger la relecture.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [gameId]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const currentNode = nodeById.get(currentNodeId) ?? nodes[0];
  const game = currentNode?.state ?? replay?.initial_state ?? null;
  const selectedPiece = game?.pieces.find((piece) => piece.id === selectedPieceId) ?? null;
  const legalPaths = useMemo(
    () => game && selectedPieceId ? getLocalLegalPaths(game, selectedPieceId) : [],
    [game, selectedPieceId],
  );
  const attackPaths = useMemo(
    () => game && selectedPieceId ? getLocalAttackPaths(game, selectedPieceId) : new Map<string, MovePath[]>(),
    [game, selectedPieceId],
  );
  const candidates = useMemo<RouteCandidate[]>(() => [
    ...legalPaths.map((path) => ({ path, attackTargetId: null })),
    ...[...attackPaths].flatMap(([attackTargetId, paths]) => paths.map((path) => ({ path, attackTargetId }))),
  ], [attackPaths, legalPaths]);
  const routeExtensions = routePlan ? candidates.filter(({ path }) =>
    pathHasPrefix(path.path, routePlan.steps) && path.path.length > routePlan.steps.length,
  ).map((candidate) => ({
    ...candidate,
    clickPosition: candidate.path.destination,
    appendSteps: candidate.path.path.slice(routePlan.steps.length),
  })) : [];
  const routeDestinations = new Set(routeExtensions.map(({ clickPosition }) => positionKey(clickPosition)));
  const { attackableIds, insufficientAttackIds } = useMemo(() => {
    const attackable = new Set<string>();
    const insufficient = new Set<string>();
    if (!game || !selectedPieceId) {
      return { attackableIds: attackable, insufficientAttackIds: insufficient };
    }

    const attacker = game.pieces.find((piece) => piece.id === selectedPieceId);
    if (!attacker) return { attackableIds: attackable, insufficientAttackIds: insufficient };

    const piecesById = new Map(game.pieces.map((piece) => [piece.id, piece]));
    for (const [targetId, paths] of attackPaths) {
      const target = piecesById.get(targetId);
      if (!target) continue;
      const canCapture = paths.some((path) => getCombatPreview(
        game,
        attacker,
        target,
        path.special ? attacker.movement_points : (game.movement_spent[attacker.id] ?? 0) + path.cost,
      ).canCapture);
      (canCapture ? attackable : insufficient).add(targetId);
    }

    return { attackableIds: attackable, insufficientAttackIds: insufficient };
  }, [attackPaths, game, selectedPieceId]);

  const routeExact = routePlan
    ? candidates.filter(({ path, attackTargetId }) =>
      attackTargetId === routePlan.attackTargetId && path.path.length === routePlan.steps.length &&
      pathHasPrefix(path.path, routePlan.steps),
    )
    : [];
  const selectedRoute = routeExact.find(({ path }) => path.special === null) ?? routeExact[0] ?? null;
  const createVariation = useCallback((action: AnalysisAction, nextState: GameState) => {
    if (!currentNode) return;
    const id = `variation-${branchNumber.current++}`;
    const piece = action.type === "move" || action.type === "attack" || action.type === "exit"
      ? currentNode.state.pieces.find((candidate) => candidate.id === action.pieceId)
      : undefined;
    const destination = action.type === "move" || action.type === "attack" ? action.path.destination : null;
    const description = action.type === "move"
      ? `${piece ? pieceName[piece.piece_type] : "Pièce"} · ${destination ? `${destination.row + 1}, ${destination.col + 1}` : "déplacement"}`
      : action.type === "attack"
        ? `${piece ? pieceName[piece.piece_type] : "Pièce"} · attaque`
        : action.type === "exit"
          ? `${piece ? pieceName[piece.piece_type] : "Pièce"} · sortie`
          : "Fin du tour";
    const variationAction: GameReplayAction = {
      action_number: branchNumber.current,
      actor_id: null,
      action_type: `variation:${action.type}`,
      payload: { description },
      created_at: new Date().toISOString(),
      state_after: nextState,
    };
    const node: ReviewNode = {
      id,
      parentId: currentNode.id,
      childIds: [],
      mainline: false,
      turn: currentNode.state.turn_count,
      action: variationAction,
      state: nextState,
    };
    setNodes((previous) => previous.map((item) => item.id === currentNode.id
      ? { ...item, childIds: [...item.childIds, id] }
      : item).concat(node));
    setCurrentNodeId(id);
    setSelectedPieceId(null);
    setRoutePlan(null);
    setError(null);
  }, [currentNode]);

  const runAction = useCallback((action: AnalysisAction) => {
    if (!game) return;
    try {
      const next = applyAnalysisAction(game, action);
      if (action.type === "move" || action.type === "attack") {
        setAnimation({ pieceId: action.pieceId, path: action.path.path, special: action.path.special });
        window.setTimeout(() => setAnimation(null), 1600);
      } else {
        setAnimation(null);
      }
      createVariation(action, next);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action illégale dans cette variante.");
    }
  }, [createVariation, game]);

  const chooseNode = useCallback((id: string) => {
    setCurrentNodeId(id);
    setSelectedPieceId(null);
    setRoutePlan(null);
    setAnimation(null);
    setError(null);
  }, []);

  const stepForward = useCallback(() => {
    const node = nodeById.get(currentNodeId);
    if (!node || node.childIds.length === 0) return;
    const next = node.childIds.map((id) => nodeById.get(id)).find((child) => child?.mainline)
      ?? nodeById.get(node.childIds[0]);
    if (next) chooseNode(next.id);
  }, [chooseNode, currentNodeId, nodeById]);

  const stepBackward = useCallback(() => {
    const parentId = nodeById.get(currentNodeId)?.parentId;
    if (parentId) chooseNode(parentId);
  }, [chooseNode, currentNodeId, nodeById]);

  const seekEnd = useCallback(() => {
    let node = nodeById.get(currentNodeId) ?? nodes[0];
    if (!node) return;
    while (node.childIds.length) {
      node = node.childIds.map((id) => nodeById.get(id)).find((child) => child?.mainline)
        ?? nodeById.get(node.childIds[0])!;
    }
    chooseNode(node.id);
  }, [chooseNode, currentNodeId, nodeById, nodes]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const node = nodeById.get(currentNodeId);
      if (!node?.childIds.length) {
        setPlaying(false);
        return;
      }
      const next = node.childIds.map((id) => nodeById.get(id)).find((child) => child?.mainline)
        ?? nodeById.get(node.childIds[0]);
      if (next) {
        setCurrentNodeId(next.id);
        setSelectedPieceId(null);
        setRoutePlan(null);
      }
    }, playDelay);
    return () => window.clearInterval(timer);
  }, [currentNodeId, nodeById, playDelay, playing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("button, input, select, textarea")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); stepBackward(); }
      else if (event.key === "ArrowRight") { event.preventDefault(); stepForward(); }
      else if (event.key === "Home") { event.preventDefault(); chooseNode(mainline[0] ?? "main-0"); }
      else if (event.key === "End") { event.preventDefault(); seekEnd(); }
      else return;
      setPlaying(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseNode, mainline, seekEnd, stepBackward, stepForward]);

  const beginRoute = (piece: Piece) => {
    if (!game || game.status !== "ONGOING" || piece.owner !== game.current_player) return;
    if (game.moved_piece_id && game.moved_piece_id !== piece.id) {
      setNotice("Continue avec la pièce déjà déplacée pendant ce tour.");
      return;
    }
    setSelectedPieceId(piece.id);
    setRoutePlan({ pieceId: piece.id, steps: [], attackTargetId: null });
    setNotice(null);
    setError(null);
  };

  const handleRouteCell = (row: number, col: number) => {
    if (!game || !routePlan) return;
    const position = { row, col };
    const previousIndex = routePlan.steps.findIndex((step) => samePosition(step, position));
    if (previousIndex >= 0) {
      const steps = routePlan.steps.slice(0, previousIndex + 1);
      const completedAttack = candidates.find(({ path, attackTargetId }) =>
        attackTargetId !== null && path.path.length === steps.length && pathHasPrefix(path.path, steps),
      );
      setRoutePlan({ ...routePlan, steps, attackTargetId: completedAttack?.attackTargetId ?? null });
      return;
    }
    const extension = routeExtensions.find((candidate) => samePosition(candidate.clickPosition, position));
    if (!extension) return;
    const steps = [...routePlan.steps, ...extension.appendSteps];
    setRoutePlan({
      ...routePlan,
      steps,
      attackTargetId: extension.path.path.length === steps.length ? extension.attackTargetId : null,
    });
  };

  const handleCellClick = (row: number, col: number, input: "mouse" | "touch") => {
    if (!game) return;
    if (input === "touch" && routePlan) { handleRouteCell(row, col); return; }
    if (input === "touch" && !routePlan) {
      const ownPiece = game.pieces.find((piece) => piece.position?.row === row && piece.position.col === col);
      if (ownPiece?.owner === game.current_player) { beginRoute(ownPiece); return; }
    }
    if (input === "mouse" && routePlan) { setRoutePlan(null); return; }

    const piece = game.pieces.find((candidate) => candidate.position?.row === row && candidate.position.col === col);
    if (piece?.owner === game.current_player) {
      setSelectedPieceId(piece.id);
      setError(null);
      return;
    }
    if (!selectedPieceId) return;
    const move = legalPaths.find((path) => path.destination.row === row && path.destination.col === col);
    if (move) { runAction({ type: "move", pieceId: selectedPieceId, path: move }); return; }
    if (piece && piece.owner !== game.current_player) {
      const attacker = game.pieces.find((candidate) => candidate.id === selectedPieceId);
      if (!attacker) return;
      const path = attackPaths.get(piece.id)?.find((candidate) => getCombatPreview(
        game,
        attacker,
        piece,
        candidate.special
          ? attacker.movement_points
          : (game.movement_spent[attacker.id] ?? 0) + candidate.cost,
      ).canCapture);
      if (!path) { setNotice("La cible est hors de portée ou sa force dépasse la tienne."); return; }
      runAction({ type: "attack", pieceId: selectedPieceId, targetId: piece.id, path });
      return;
    }
  };

  const handleContextMenu = (row: number, col: number) => {
    if (!game) return;
    const piece = game.pieces.find((candidate) => candidate.position?.row === row && candidate.position.col === col);
    if (!routePlan) {
      if (piece?.owner === game.current_player) beginRoute(piece);
      return;
    }
    if (piece?.owner === game.current_player && piece.id !== routePlan.pieceId) {
      beginRoute(piece);
      return;
    }
    handleRouteCell(row, col);
  };

  const submitRoute = () => {
    if (!game || !routePlan || !selectedRoute) return;
    if (routePlan.attackTargetId) {
      runAction({ type: "attack", pieceId: routePlan.pieceId, targetId: routePlan.attackTargetId, path: selectedRoute.path });
    } else {
      runAction({ type: "move", pieceId: routePlan.pieceId, path: selectedRoute.path });
    }
  };

  const interactiveCells = useMemo(() => {
    const cells = new Set<string>();
    if (!game) return cells;
    for (let row = 0; row < game.board_size; row += 1) {
      for (let col = 0; col < game.board_size; col += 1) cells.add(`${row}:${col}`);
    }
    return cells;
  }, [game]);
  const legalDestinations = routePlan
    ? routeDestinations
    : new Set(legalPaths.map((path) => positionKey(path.destination)));
  const selectedRouteAttack = selectedRoute;
  const routeTarget = routePlan?.attackTargetId ? game?.pieces.find((piece) => piece.id === routePlan.attackTargetId) : null;
  const selectedRouteCombat = (() => {
    const attacker = routePlan && game?.pieces.find((piece) => piece.id === routePlan.pieceId);
    if (!game || !attacker || !routeTarget || !selectedRouteAttack) return null;
    const spent = selectedRouteAttack.path.special
      ? attacker.movement_points
      : (game.movement_spent[attacker.id] ?? 0) + selectedRouteAttack.path.cost;
    return getCombatPreview(game, attacker, routeTarget, spent);
  })();
  const mainlineGroups = useMemo(() => {
    const groups = new Map<number, ReviewNode[]>();
    for (const id of mainline.slice(1)) {
      const node = nodeById.get(id);
      if (!node) continue;
      const group = groups.get(node.turn) ?? [];
      group.push(node);
      groups.set(node.turn, group);
    }
    return [...groups.entries()];
  }, [mainline, nodeById]);
  const variations = nodes.filter((node) => !node.mainline);

  if (loading) return <main className="analysis-page"><div className="analysis-loading">Chargement de la partie…</div></main>;
  if (!replay || !game) return <main className="analysis-page"><header className="analysis-header"><button className="outline-button" onClick={onBack}><ArrowLeft size={16}/>Retour</button><h1>Self Analysis</h1></header><p className="analysis-error">{error || "Cette partie ne contient pas de chronologie exploitable."}</p></main>;

  const playerName = (color: string | null) => replay.mode === "local"
    ? colorName(color)
    : color === replay.initial_state.my_color
      ? "Vous"
      : summary?.opponent_username || "Adversaire";

  return (
    <main className="analysis-page">
      <header className="analysis-header">
        <button className="outline-button" onClick={onBack}><ArrowLeft size={16}/>Historique</button>
        <div className="analysis-title"><span className="card-kicker">SELF ANALYSIS · {replay.mode === "local" ? "PARTIE LOCALE" : "PARTIE EN LIGNE"}</span><h1>{summary?.opponent_username ? `Contre ${summary.opponent_username}` : "Relecture de partie"}</h1></div>
        <span className="analysis-turn">Tour {game.turn_count} · {playerName(game.current_player)}{game.lifecycle_status !== "ongoing" ? " · Partie terminée" : ""}</span>
      </header>
      {(error || notice) && <div className={`analysis-toast ${error ? "analysis-toast-error" : ""}`} role="status">{error || notice}<button onClick={() => { setError(null); setNotice(null); }} aria-label="Fermer"><X size={14}/></button></div>}
      <section className="analysis-workspace">
        <div className="analysis-board-column">
          <div className="analysis-board-stage">
            <Suspense fallback={<div className="game-board-loading">Préparation du plateau 3D…</div>}>
              <GameBoard3D
                game={game}
                disabled={false}
                hideIndicators={false}
                selectedPieceId={selectedPieceId}
                legalDestinations={legalDestinations}
                attackablePieceIds={routePlan ? new Set(routeExtensions.filter((item) => item.attackTargetId).map((item) => item.attackTargetId!)) : attackableIds}
                insufficientAttackPieceIds={insufficientAttackIds}
                interactiveCells={interactiveCells}
                routePath={routePlan?.steps ?? []}
                routeIsAttack={Boolean(routePlan?.attackTargetId)}
                movementPathOverride={animation}
                onCellClick={handleCellClick}
                onCellContextMenu={handleContextMenu}
              />
            </Suspense>
            {routePlan && <section className="move-route-popup analysis-route-popup" aria-live="polite">
              <div className="move-route-status"><span className="card-kicker">VARIANTE LOCALE</span><strong>{routePlan.attackTargetId ? "Confirmer l’attaque" : "Confirmer le trajet"}</strong><small>{routePlan.steps.length} case(s) · {routePlan.attackTargetId ? `force ${selectedRouteCombat?.attackForce ?? "—"} / défense ${selectedRouteCombat?.defenseForce ?? "—"}` : "l’action ne modifie pas la partie sauvegardée"}</small></div>
              <button className="primary-button" onClick={submitRoute} disabled={!selectedRoute || Boolean(routePlan.attackTargetId && !selectedRouteCombat?.canCapture)}>{routePlan.attackTargetId ? "Attaquer" : "Jouer le trajet"}</button>
              <button className="outline-button" onClick={() => setRoutePlan(null)}>Annuler</button>
            </section>}
          </div>
          <div className="analysis-transport">
            <button className="outline-button" onClick={() => { setPlaying(false); chooseNode(mainline[0]); }} title="Début"><SkipBack size={16}/></button>
            <button className="outline-button" onClick={() => { setPlaying(false); stepBackward(); }} title="Précédent"><ArrowLeft size={16}/></button>
            <button className="primary-button" onClick={() => setPlaying((value) => !value)} title={playing ? "Pause" : "Lecture"}>{playing ? <Pause size={16}/> : <Play size={16}/>}</button>
            <button className="outline-button" onClick={() => { setPlaying(false); stepForward(); }} title="Suivant"><ArrowRight size={16}/></button>
            <button className="outline-button" onClick={() => { setPlaying(false); seekEnd(); }} title="Fin"><SkipForward size={16}/></button>
            <label className="analysis-speed">Vitesse<select value={playDelay} onChange={(event) => setPlayDelay(Number(event.target.value))}><option value={2200}>Lente</option><option value={1200}>Normale</option><option value={650}>Rapide</option></select></label>
            <span className="analysis-position-count">{mainline.indexOf(currentNodeId) >= 0 ? mainline.indexOf(currentNodeId) : "V"} / {mainline.length - 1}</span>
          </div>
          <div className="analysis-shortcuts">← → naviguer · Home début · End fin · clic gauche déplacer · clic droit tracer une variante</div>
        </div>
        <aside className="analysis-sidebar">
          <section className="analysis-state-card">
            <div className="analysis-state-head"><div><span className="card-kicker">POSITION</span><h2>{currentNode?.mainline ? `Tour ${currentNode.turn}` : "Variante"}</h2></div><span className={`analysis-status ${game.status === "ONGOING" && game.lifecycle_status === "ongoing" ? "" : "analysis-status-finished"}`}>{game.lifecycle_status === "abandoned" ? "Abandon" : game.status === "ONGOING" ? colorName(game.current_player) : game.status === "DRAW" ? "Égalité" : `${colorName(game.winner)} gagne`}</span></div>
            <div className="analysis-score-row"><span><i className="avatar-ivory"/>Ivoire <b>{game.scores.WHITE ?? 0}</b></span><span><i className="avatar-dark"/>Obsidienne <b>{game.scores.BLACK ?? 0}</b></span></div>
            <div className="analysis-piece-state">{(["WHITE", "BLACK"] as const).map((color) => <div key={color}><b>{colorName(color)}</b><small>{game.pieces.filter((piece) => piece.owner === color && piece.captured).length} capturées · {game.pieces.filter((piece) => piece.owner === color && piece.finished).length} sorties · {game.pieces.filter((piece) => piece.owner === color && piece.position && !piece.captured && !piece.finished).length} sur le plateau</small></div>)}</div>
          </section>
          <section className="analysis-action-panel">
            <div className="analysis-panel-heading"><div><span className="card-kicker">CHRONOLOGIE</span><h2>Actions</h2></div><button className="analysis-end-turn" onClick={() => runAction({ type: "end_turn" })} disabled={!game.has_moved_this_turn || game.lifecycle_status !== "ongoing"}>Terminer le tour</button></div>
            {mainlineGroups.length === 0 ? <p className="analysis-empty">Aucune action enregistrée pour cette partie.</p> : mainlineGroups.map(([turn, items]) => <div className="analysis-turn-group" key={turn}><h3>Tour {turn + 1}</h3>{items.map((node) => {
              const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
              const label = node.action && parent ? actionTitle(node.action, parent.state, node.state) : "Action";
              return <button key={node.id} className={`analysis-action-row ${currentNodeId === node.id ? "analysis-action-active" : ""}`} onClick={() => chooseNode(node.id)}><span className="analysis-action-color">{parent ? colorName(parent.state.current_player) : "—"}</span><span className="analysis-action-label"><b>{label}</b>{node.action?.action_type === "move" && Array.isArray(node.action.payload.path) && <small>{(node.action.payload.path as Position[]).map((position) => `${position.row + 1},${position.col + 1}`).join(" → ")}</small>}{node.action?.action_type === "attack" && <small>Attaque · {String(node.action.payload.attack_force ?? "?")} contre {String(node.action.payload.defense_force ?? "?")}</small>}</span><span className="analysis-action-turn">{node.action?.action_number}</span></button>;
            })}</div>)}
          </section>
          <section className="analysis-variation-panel"><div className="analysis-panel-heading"><div><span className="card-kicker">EXPLORATION LOCALE</span><h2>Variantes · {variations.length}</h2></div><div className="analysis-branch-controls">{!currentNode?.mainline && <button className="analysis-end-turn" onClick={() => { let ancestor = currentNode; while (!ancestor.mainline && ancestor.parentId) ancestor = nodeById.get(ancestor.parentId) ?? ancestor; chooseNode(ancestor.id); }}>Ligne principale</button>}<button className="outline-button" onClick={() => { setSelectedPieceId(null); setRoutePlan(null); setError(null); }} title="Désélectionner"><X size={14}/></button></div></div>{variations.length === 0 ? <p className="analysis-empty">Sélectionne une pièce et joue un coup pour créer une branche indépendante.</p> : variations.map((node) => { const parent = node.parentId ? nodeById.get(node.parentId) : undefined; const label = node.action?.payload.description ?? "Action simulée"; return <button className={`analysis-variation-row ${currentNodeId === node.id ? "analysis-action-active" : ""}`} key={node.id} onClick={() => chooseNode(node.id)}><span>↳</span><span><b>{String(label)}</b><small>Depuis {parent?.mainline ? `l’action ${parent.action?.action_number ?? "initiale"}` : "la variante"}</small></span><ArrowRight size={14}/></button>; })}</section>
        </aside>
      </section>
      {selectedPiece && !routePlan && <div className="analysis-selection-toast"><Swords size={15}/>{pieceName[selectedPiece.piece_type]} sélectionné · choisis une case brillante ou trace un trajet au clic droit<button onClick={() => setSelectedPieceId(null)} aria-label="Désélectionner"><X size={14}/></button></div>}
    </main>
  );
}
