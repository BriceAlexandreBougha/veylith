import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowRight,
  ArrowLeft,
  BookOpen,
  Bot,
  Check,
  CircleAlert,
  Fingerprint,
  House,
  LoaderCircle,
  LogOut,
  RotateCcw,
  Search,
  Swords,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { ApiRequestError, apiRequest } from "../lib/api";
import { getCombatPreview, getLocalCombatPreviews, type CombatPreview } from "../lib/combat";
import { getLocalAttackPaths, getLocalLegalPaths } from "../lib/movement";

const GameBoard3D = lazy(() => import("./GameBoard3D"));
const GameAnalysis = lazy(() => import("./GameAnalysis"));
import type {
  AttackResponse,
  GameConnectionStatus,
  FriendRelation,
  GameDrawOffer,
  GameInvitation,
  GameRematchStatus,
  GameMode,
  GameState,
  GameSummary,
  MovePath,
  Piece,
  UserProfile,
} from "../lib/api";

interface DashboardProps {
  session: Session;
  onLogout: () => void;
  busy: boolean;
}

type BoardPosition = { row: number; col: number };
const GAME_HISTORY_PAGE_SIZE = 50;

function sameGameSnapshot(first: GameState, second: GameState): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function sameInvitationSnapshot(first: GameInvitation[], second: GameInvitation[]): boolean {
  return first.length === second.length && first.every((item, index) =>
    item.id === second[index].id && item.status === second[index].status,
  );
}

interface RoutePlan {
  pieceId: string;
  steps: BoardPosition[];
  attackTargetId: string | null;
}

interface RouteCandidate {
  path: MovePath;
  attackTargetId: string | null;
}

interface RouteExtension extends RouteCandidate {
  clickPosition: BoardPosition;
  appendSteps: BoardPosition[];
}

function sameBoardPosition(first: BoardPosition, second: BoardPosition): boolean {
  return first.row === second.row && first.col === second.col;
}

function pathMatchesPrefix(path: BoardPosition[], prefix: BoardPosition[]): boolean {
  return prefix.length <= path.length && prefix.every((step, index) => sameBoardPosition(step, path[index]));
}

function gameDuration(game: GameSummary): string {
  const start = new Date(game.started_at ?? game.created_at).getTime();
  const end = game.finished_at ? new Date(game.finished_at).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

function GameHistoryRow({ game, onOpen, focused = false }: { game: GameSummary; onOpen: () => void; focused?: boolean }) {
  const resultLabel = game.result === "win"
    ? "Victoire"
    : game.result === "loss"
      ? "Défaite"
      : game.result === "draw"
        ? "Égalité"
        : "En cours";
  return (
    <button id={`history-game-${game.game_id}`} className={`history-row ${focused ? "history-row-focused" : ""}`} onClick={onOpen}>
      <i className={`history-result ${game.result || "pending"}`} aria-label={resultLabel} />
      <span className="history-main">
        <b>Contre {game.opponent_username || (game.mode === "local" ? "Partie locale" : "Adversaire")}</b>
        <small>
          {game.mode === "local" ? "Partie locale" : "Partie en ligne"} · {game.my_color === "WHITE" ? "Ivoire" : "Obsidienne"} · {game.lifecycle_status} · tour {game.turn_count}
        </small>
      </span>
      <span className="history-duration">
        <b>{gameDuration(game)}</b>
        <small>{game.lifecycle_status === "ongoing" || game.lifecycle_status === "waiting" ? "En cours" : "Durée"}</small>
      </span>
      <ArrowRight size={16} />
    </button>
  );
}

export default function Dashboard({ session, onLogout, busy }: DashboardProps) {
  const [view, setView] = useState<"home" | "search" | "friends" | "tutorial" | "profile" | "history" | "analysis" | "waiting" | "game-transition" | "game">("home");
  const [tutorialSlide, setTutorialSlide] = useState(0);
  const [games, setGames] = useState<GameSummary[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);
  const [reviewGameId, setReviewGameId] = useState<string | null>(null);
  const [reviewSummary, setReviewSummary] = useState<GameSummary | null>(null);
  const [analysisReturnView, setAnalysisReturnView] = useState<"home" | "history" | "game">("history");
  const [friends, setFriends] = useState<FriendRelation[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRelation[]>([]);
  const [processingFriendRequests, setProcessingFriendRequests] = useState<Set<string>>(new Set());
  const [invitations, setInvitations] = useState<GameInvitation[]>([]);
  const [game, setGame] = useState<GameState | null>(null);
  const [myProfile, setMyProfile] = useState<UserProfile | null>(null);
  const [usernameDraft, setUsernameDraft] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [waitingForUsername, setWaitingForUsername] = useState("");
  const [invitationToast, setInvitationToast] = useState<GameInvitation | null>(null);
  const [opponentRematchAvailable, setOpponentRematchAvailable] = useState(false);
  const [outgoingRematch, setOutgoingRematch] = useState<GameInvitation | null>(null);
  const [rematchSending, setRematchSending] = useState(false);
  const [opponentConnectionStatus, setOpponentConnectionStatus] = useState<GameConnectionStatus["status"]>("connected");
  const [drawOffer, setDrawOffer] = useState<GameDrawOffer | null>(null);
  const [gameDialog, setGameDialog] = useState<"leave" | "draw-offer" | "draw-incoming" | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [userSearchDone, setUserSearchDone] = useState(false);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null);
  const [legalPaths, setLegalPaths] = useState<MovePath[]>([]);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [pendingRouteAnimation, setPendingRouteAnimation] = useState<{
    pieceId: string;
    path: BoardPosition[];
    special: string | null;
  } | null>(null);
  const [searchingMatch, setSearchingMatch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gameActionPending, setGameActionPending] = useState(false);
  const gameActionPendingRef = useRef(false);
  const seenInvitationIds = useRef(new Set<string>());
  const invitationToastTimer = useRef<number | null>(null);
  const gameTransitionTimer = useRef<number | null>(null);

  const piecesAt = useMemo(() => {
    const positions = new Map<string, Piece>();
    for (const piece of game?.pieces ?? []) {
      if (piece.position && !piece.captured && !piece.finished) {
        positions.set(`${piece.position.row}:${piece.position.col}`, piece);
      }
    }
    return positions;
  }, [game]);

  const legalDestinations = useMemo(
    () => new Set(legalPaths.map((path) => `${path.destination.row}:${path.destination.col}`)),
    [legalPaths],
  );
  const combatPreviews = useMemo(() => {
    if (!game || !selectedPieceId) return new Map<string, CombatPreview>();
    return getLocalCombatPreviews(game, selectedPieceId);
  }, [game, selectedPieceId]);
  const { attackablePieceIds, insufficientAttackPieceIds } = useMemo(() => {
    const attackable = new Set<string>();
    const insufficient = new Set<string>();
    for (const [pieceId, preview] of combatPreviews) {
      (preview.canCapture ? attackable : insufficient).add(pieceId);
    }
    return { attackablePieceIds: attackable, insufficientAttackPieceIds: insufficient };
  }, [combatPreviews]);
  const attackPathsByTarget = useMemo(
    () => game && selectedPieceId ? getLocalAttackPaths(game, selectedPieceId) : new Map<string, MovePath[]>(),
    [game, selectedPieceId],
  );
  const routeCandidates = useMemo<RouteCandidate[]>(() => [
    ...legalPaths.map((path) => ({ path, attackTargetId: null })),
    ...[...attackPathsByTarget].flatMap(([attackTargetId, paths]) =>
      paths.map((path) => ({ path, attackTargetId })),
    ),
  ], [legalPaths, attackPathsByTarget]);
  const routeExtensions = useMemo<RouteExtension[]>(() => {
    if (!routePlan) return [];
    const extensions: RouteExtension[] = [];
    for (const candidate of routeCandidates) {
      const path = candidate.path.path;
      if (!pathMatchesPrefix(path, routePlan.steps) || routePlan.steps.length >= path.length) continue;
      // Offer every reachable destination. A click adds that destination as
      // the next route leg, while retaining the legal tile-by-tile path for
      // animation and server validation.
      const appendSteps = path.slice(routePlan.steps.length);
      extensions.push({
        ...candidate,
        clickPosition: candidate.path.destination,
        appendSteps,
      });
    }
    return extensions;
  }, [routeCandidates, routePlan]);
  const routeNextCells = useMemo(() => new Set(
    routeExtensions.map(({ clickPosition }) => `${clickPosition.row}:${clickPosition.col}`),
  ), [routeExtensions]);
  const routeAttackableIds = useMemo(() => new Set(
    routeExtensions.filter(({ attackTargetId, clickPosition }) => {
      if (!attackTargetId) return false;
      const target = game?.pieces.find((piece) => piece.id === attackTargetId);
      return target?.position && sameBoardPosition(target.position, clickPosition);
    }).map(({ attackTargetId }) => attackTargetId as string),
  ), [game, routeExtensions]);
  const routeInsufficientAttackIds = useMemo(() => new Set(
    routeExtensions.filter(({ attackTargetId, clickPosition }) => {
      if (!attackTargetId || combatPreviews.get(attackTargetId)?.canCapture) return false;
      const target = game?.pieces.find((piece) => piece.id === attackTargetId);
      return target?.position && sameBoardPosition(target.position, clickPosition);
    }).map(({ attackTargetId }) => attackTargetId as string),
  ), [combatPreviews, game, routeExtensions]);
  const exactRouteCandidates = routePlan
    ? routeCandidates.filter(({ path, attackTargetId }) =>
      attackTargetId === routePlan.attackTargetId &&
      path.path.length === routePlan.steps.length &&
      pathMatchesPrefix(path.path, routePlan.steps),
    )
    : [];
  const selectedRouteCandidate = exactRouteCandidates.find(({ path }) => path.special === null)
    ?? exactRouteCandidates[0]
    ?? null;
  const selectedRouteAttackPreview = (() => {
    if (!game || !routePlan?.attackTargetId || !selectedRouteCandidate) return null;
    const attacker = game.pieces.find((piece) => piece.id === routePlan.pieceId);
    const defender = game.pieces.find((piece) => piece.id === routePlan.attackTargetId);
    if (!attacker || !defender) return null;
    const spentBeforeRoute = game.movement_spent[attacker.id] ?? 0;
    const movementSpent = selectedRouteCandidate.path.special
      ? attacker.movement_points
      : spentBeforeRoute + selectedRouteCandidate.path.cost;
    return getCombatPreview(game, attacker, defender, movementSpent);
  })();
  const routeRemainingPoints = (() => {
    if (!game || !routePlan) return 0;
    const piece = game.pieces.find((candidate) => candidate.id === routePlan.pieceId);
    if (!piece) return 0;
    const remainingBeforeRoute = piece.movement_points - (game.movement_spent[piece.id] ?? 0);
    if (selectedRouteCandidate?.path.special) return 0;
    let cost = 0;
    let previous = piece.position;
    for (const step of routePlan.steps) {
      if (!previous) break;
      const rowDelta = Math.abs(step.row - previous.row);
      const colDelta = Math.abs(step.col - previous.col);
      cost += rowDelta === 1 && colDelta === 1
        ? 1
        : 1 + Math.abs(game.heights[step.row][step.col] - game.heights[previous.row][previous.col]);
      previous = step;
    }
    return Math.max(0, remainingBeforeRoute - cost);
  })();
  const interactiveCells = useMemo(() => {
    const cells = new Set<string>();
    if (!game) return cells;
    const selectablePieces = game.pieces.filter((piece) =>
      piece.position && !piece.captured && !piece.finished &&
      piece.owner === game.current_player &&
      (game.mode !== "online" || piece.owner === game.my_color) &&
      (!game.moved_piece_id || piece.id === game.moved_piece_id),
    );
    for (const piece of selectablePieces) {
      cells.add(`${piece.position!.row}:${piece.position!.col}`);
    }
    if (selectedPieceId) {
      for (const destination of routePlan ? routeNextCells : legalDestinations) cells.add(destination);
    }
    if (selectedPieceId) {
      for (const pieceId of routePlan ? routeAttackableIds : combatPreviews.keys()) {
        const target = game.pieces.find((piece) => piece.id === pieceId);
        if (target?.position) cells.add(`${target.position.row}:${target.position.col}`);
      }
    }
    if (routePlan) {
      for (let row = 0; row < game.board_size; row += 1) {
        for (let col = 0; col < game.board_size; col += 1) cells.add(`${row}:${col}`);
      }
    }
    return cells;
  }, [game, selectedPieceId, legalDestinations, combatPreviews, routePlan, routeNextCells, routeAttackableIds]);

  async function refreshDashboard(): Promise<GameSummary[] | null> {
    setLoading(true);
    setError(null);
    try {
      const [nextGames, nextFriends, nextRequests, nextInvitations, nextProfile] = await Promise.all([
        apiRequest<GameSummary[]>("/games"),
        apiRequest<FriendRelation[]>("/friends"),
        apiRequest<FriendRelation[]>("/friends/requests"),
        apiRequest<GameInvitation[]>("/games/invitations"),
        apiRequest<UserProfile>("/users/me"),
      ]);
      setGames(nextGames);
      setHistoryHasMore(nextGames.length === GAME_HISTORY_PAGE_SIZE);
      setFriends(nextFriends);
      setFriendRequests(nextRequests);
      setInvitations(nextInvitations);
      setMyProfile(nextProfile);
      setUsernameDraft((current) => current || nextProfile.username);
      return nextGames;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger les données.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreHistory() {
    if (loadingMoreHistory || !historyHasMore) return;
    setLoadingMoreHistory(true);
    try {
      const nextPage = await apiRequest<GameSummary[]>(
        `/games?limit=${GAME_HISTORY_PAGE_SIZE}&offset=${games.length}`,
      );
      setGames((current) => {
        const existing = new Set(current.map((item) => item.game_id));
        return [...current, ...nextPage.filter((item) => !existing.has(item.game_id))];
      });
      setHistoryHasMore(nextPage.length === GAME_HISTORY_PAGE_SIZE);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de charger la suite de l’historique.");
    } finally {
      setLoadingMoreHistory(false);
    }
  }

  useEffect(() => {
    let active = true;
    void refreshDashboard().then(async (nextGames) => {
      if (!active || !nextGames) return;
      const resumableGame = nextGames.find(
        (item) => item.mode === "online" && item.lifecycle_status === "ongoing",
      );
      if (!resumableGame) return;
      try {
        const restoredGame = await apiRequest<GameState>(`/games/${resumableGame.game_id}`);
        if (!active || restoredGame.lifecycle_status !== "ongoing") return;
        setGame(restoredGame);
        setSearchingMatch(false);
        setSelectedPieceId(null);
        setLegalPaths([]);
        setView("game");
      } catch {
        // Keep the dashboard available if a game ended while the session was restoring.
      }
    });
    return () => { active = false; };
    // Initial load is tied to the authenticated account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.user.id]);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const pollInvitations = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const pending = await apiRequest<GameInvitation[]>("/games/invitations");
        if (!active) return;
        setInvitations((current) => sameInvitationSnapshot(current, pending) ? current : pending);
        const incoming = pending.find((item) => !seenInvitationIds.current.has(item.id));
        for (const item of pending) seenInvitationIds.current.add(item.id);
        if (incoming) {
          setInvitationToast(incoming);
          if (invitationToastTimer.current !== null) window.clearTimeout(invitationToastTimer.current);
          invitationToastTimer.current = window.setTimeout(() => {
            setInvitationToast((current) => current?.id === incoming.id ? null : current);
            invitationToastTimer.current = null;
          }, incoming.source_game_id ? 2000 : 6000);
        }
      } catch {
        // La page d'accueil et les actions de jeu restent disponibles en cas de panne temporaire.
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void pollInvitations(); };
    void pollInvitations();
    const timer = window.setInterval(() => void pollInvitations(), 5000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (invitationToastTimer.current !== null) window.clearTimeout(invitationToastTimer.current);
      if (gameTransitionTimer.current !== null) window.clearTimeout(gameTransitionTimer.current);
    };
  }, [session.user.id]);

  function transitionIntoGame(nextGame: GameState) {
    setGame(nextGame);
    setSearchingMatch(false);
    setSelectedPieceId(null);
    setLegalPaths([]);
    void apiRequest<GameSummary[]>(`/games?limit=${GAME_HISTORY_PAGE_SIZE}&offset=0`).then((items) => {
      setGames(items);
      setHistoryHasMore(items.length === GAME_HISTORY_PAGE_SIZE);
    }).catch(() => undefined);
    setView("game-transition");
    if (gameTransitionTimer.current !== null) window.clearTimeout(gameTransitionTimer.current);
    gameTransitionTimer.current = window.setTimeout(() => {
      setView("game");
      gameTransitionTimer.current = null;
    }, 1050);
  }

  function openAnalysis(summary: GameSummary, returnView: "home" | "history" | "game") {
    setReviewGameId(summary.game_id);
    setReviewSummary(summary);
    setAnalysisReturnView(returnView);
    setView("analysis");
  }

  async function findOnlineMatch() {
    if (loading) return;
    setView("search");
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const queuedGame = await apiRequest<GameState>("/games/matchmaking", { method: "POST" });
      setGame(queuedGame);
      setSearchingMatch(queuedGame.lifecycle_status === "waiting");
      setView("waiting");
      if (queuedGame.lifecycle_status !== "waiting") {
        gameTransitionTimer.current = window.setTimeout(() => transitionIntoGame(queuedGame), 850);
      }
      void refreshDashboard();
      setNotice(queuedGame.lifecycle_status === "waiting" ? "En recherche d’un adversaire…" : "Adversaire trouvé !");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Recherche de partie impossible.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!game?.game_id || game.lifecycle_status !== "waiting") return;
    const gameId = game.game_id;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const updatedGame = await apiRequest<GameState>(`/games/${gameId}`);
        if (cancelled) return;
        setNotice((current) => current?.startsWith("Connexion instable") ? null : current);
        setGame(updatedGame);
        if (updatedGame.lifecycle_status !== "waiting") {
          setSearchingMatch(false);
          transitionIntoGame(updatedGame);
          setNotice("Adversaire trouvé ! La partie commence.");
          void refreshDashboard();
        }
      } catch (requestError) {
        if (cancelled) return;
        setNotice(requestError instanceof Error
          ? `Connexion instable ; la recherche continue. ${requestError.message}`
          : "Connexion instable ; la recherche continue.");
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void poll(); };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // Poll only while this particular queue game is waiting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchingMatch, game?.game_id, game?.lifecycle_status]);

  useEffect(() => {
    if (
      !game?.game_id ||
      game.mode !== "online" ||
      game.lifecycle_status !== "ongoing" ||
      searchingMatch
    ) return;

    const gameId = game.game_id;
    let cancelled = false;
    let inFlight = false;
    let failures = 0;
    let timer: number | undefined;
    const scheduleSync = (delay: number) => {
      if (!cancelled) timer = window.setTimeout(() => void syncGame(), delay);
    };
    const syncGame = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === "hidden") {
        scheduleSync(5000);
        return;
      }
      if (gameActionPendingRef.current) {
        scheduleSync(300);
        return;
      }
      inFlight = true;
      try {
        const latestGame = await apiRequest<GameState>(`/games/${gameId}`);
        failures = 0;
        if (!cancelled && !gameActionPendingRef.current) {
          setGame((current) => current && sameGameSnapshot(current, latestGame) ? current : latestGame);
        }
      } catch {
        failures += 1;
      } finally {
        inFlight = false;
        scheduleSync(Math.min(1500 * 2 ** failures, 15000));
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncGame();
    };
    void syncGame();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [game?.game_id, game?.lifecycle_status, game?.mode, searchingMatch]);

  useEffect(() => {
    if (view !== "game" || !game?.game_id || game.mode !== "online" || game.lifecycle_status !== "ongoing") return;
    const gameId = game.game_id;
    let active = true;
    let checking = false;
    const heartbeat = () => {
      if (document.visibilityState === "hidden") return;
      void apiRequest<void>(`/games/${gameId}/presence`, { method: "PUT" }).catch(() => undefined);
    };
    const checkConnection = async () => {
      if (!active || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const connection = await apiRequest<GameConnectionStatus>(`/games/${gameId}/connection`);
        if (!active) return;
        setOpponentConnectionStatus(connection.status);
        if (connection.status === "forfeited") {
          const endedGame = await apiRequest<GameState>(`/games/${gameId}`);
          if (active) setGame(endedGame);
        }
      } catch {
        // A failed status request is temporary; heartbeat and normal game sync retry.
      } finally {
        checking = false;
      }
    };
    heartbeat();
    void checkConnection();
    const heartbeatTimer = window.setInterval(heartbeat, 10000);
    const connectionTimer = window.setInterval(() => void checkConnection(), 4000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        heartbeat();
        void checkConnection();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(heartbeatTimer);
      window.clearInterval(connectionTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      setOpponentConnectionStatus("connected");
    };
  }, [view, game?.game_id, game?.lifecycle_status, game?.mode]);

  async function createGame(mode: GameMode) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiRequest<GameState>("/games", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      setGame(created);
      setSearchingMatch(false);
      setSelectedPieceId(null);
      setLegalPaths([]);
      setView(created.lifecycle_status === "waiting" ? "waiting" : "game");
      await refreshDashboard();
      setNotice(mode === "local" ? "Partie locale créée." : "Partie en ligne créée. Invite un ami pour commencer.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de créer la partie.");
    } finally {
      setLoading(false);
    }
  }

  async function searchUsers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSearchingUsers(true);
    setUserSearchDone(false);
    try {
      const found = await apiRequest<UserProfile[]>(`/users/search?q=${encodeURIComponent(searchText.trim())}`);
      setSearchResults(found);
      setUserSearchDone(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Recherche impossible.");
    } finally {
      setSearchingUsers(false);
    }
  }

  async function sendFriendRequest(user: UserProfile) {
    setError(null);
    try {
      await apiRequest<FriendRelation>("/friends/requests", {
        method: "POST",
        body: JSON.stringify({ addressee_id: user.id }),
      });
      setNotice(`Demande envoyée à ${user.username}.`);
      setSearchResults((results) => results.filter((item) => item.id !== user.id));
      void refreshDashboard();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Demande impossible.");
    }
  }

  async function answerFriendRequest(requestId: string, answer: "accept" | "reject") {
    if (processingFriendRequests.has(requestId)) return;
    setProcessingFriendRequests((current) => new Set(current).add(requestId));
    setError(null);
    try {
      await apiRequest<FriendRelation>(`/friends/requests/${requestId}/${answer}`, { method: "POST" });
      setFriendRequests((current) => current.filter((request) => request.id !== requestId));
      setNotice(answer === "accept" ? "Demande acceptée." : "Demande refusée.");
      void refreshDashboard();
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 404) {
        setFriendRequests((current) => current.filter((request) => request.id !== requestId));
        setNotice("Cette demande a déjà été traitée. La liste va être actualisée.");
        void refreshDashboard();
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "Impossible de traiter la demande.");
    } finally {
      setProcessingFriendRequests((current) => {
        const updated = new Set(current);
        updated.delete(requestId);
        return updated;
      });
    }
  }

  async function inviteFriendToGame(friend: UserProfile) {
    if (loading) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiRequest<GameState>("/games", {
        method: "POST",
        body: JSON.stringify({ mode: "online" }),
      });
      await apiRequest<GameInvitation>(`/games/${created.game_id}/invitations`, {
        method: "POST",
        body: JSON.stringify({ invitee_id: friend.id }),
      });
      setGame(created);
      setWaitingForUsername(friend.username);
      setSearchingMatch(false);
      setView("waiting");
      setNotice(`Invitation envoyée à ${friend.username}.`);
      await refreshDashboard();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Invitation impossible.");
    } finally {
      setLoading(false);
    }
  }

  async function answerInvitation(invitation: GameInvitation, answer: "accept" | "reject") {
    setError(null);
    setInvitationToast((current) => current?.id === invitation.id ? null : current);
    try {
      await apiRequest<GameInvitation>(`/games/invitations/${invitation.id}/${answer}`, { method: "POST" });
      setNotice(answer === "accept" ? "Invitation acceptée. La partie est prête." : "Invitation refusée.");
      await refreshDashboard();
      if (answer === "accept") {
        const invitedGame = await apiRequest<GameState>(`/games/${invitation.game_id}`);
        transitionIntoGame(invitedGame);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de traiter l'invitation.");
    }
  }

  async function saveUsername(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingProfile(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await apiRequest<UserProfile>("/users/me", {
        method: "PATCH",
        body: JSON.stringify({ username: usernameDraft.trim() }),
      });
      setMyProfile(updated);
      setUsernameDraft(updated.username);
      setNotice("Nom d’utilisateur mis à jour.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de modifier le profil.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function selectPiece(piece: Piece) {
    if (!game || game.lifecycle_status !== "ongoing") return;
    if (game.moved_piece_id && game.moved_piece_id !== piece.id) {
      setNotice("Tu ne peux jouer qu’une seule pièce pendant ce tour.");
      return;
    }
    if (game.mode === "online" && piece.owner !== game.my_color) return;
    if (piece.owner !== game.current_player) return;
    setSelectedPieceId(piece.id);
    setError(null);
    setNotice(null);
    setLegalPaths(getLocalLegalPaths(game, piece.id));
  }

  async function movePiece(
    row: number,
    col: number,
    special: string | null = null,
    customPath?: MovePath,
  ) {
    if (!game || !selectedPieceId || gameActionPendingRef.current) return;
    const selectedPath = customPath ?? legalPaths.find((path) =>
      path.destination.row === row && path.destination.col === col && path.special === special,
    ) ?? legalPaths.find((path) => path.destination.row === row && path.destination.col === col);
    if (!selectedPath) return;
    const previousGame = game;
    const optimisticGame: GameState = {
      ...game,
      pieces: game.pieces.map((piece) => piece.id === selectedPieceId
        ? { ...piece, position: { row, col } }
        : piece),
    };
    setError(null);
    gameActionPendingRef.current = true;
    setGameActionPending(true);
    setPendingRouteAnimation({
      pieceId: selectedPieceId,
      path: selectedPath.path,
      special: selectedPath.special,
    });
    setGame(optimisticGame);
    try {
      const nextGame = await apiRequest<GameState>(`/games/${game.game_id}/moves`, {
        method: "POST",
        body: JSON.stringify({
          piece_id: selectedPieceId,
          destination: { row, col },
          special: selectedPath.special,
          path: selectedPath.path,
        }),
      });
      setGame(nextGame);
      setLegalPaths([]);
      setSelectedPieceId(null);
    } catch (requestError) {
      setGame(previousGame);
      setPendingRouteAnimation(null);
      setError(requestError instanceof Error ? requestError.message : "Déplacement impossible.");
    } finally {
      setPendingRouteAnimation(null);
      gameActionPendingRef.current = false;
      setGameActionPending(false);
    }
  }

  async function attackPiece(defender: Piece, customPath?: MovePath) {
    if (!game || !selectedPieceId) return;
    const previousGame = game;
    setError(null);
    gameActionPendingRef.current = true;
    setGameActionPending(true);
    if (customPath && defender.position) {
      const nextPlayer = game.current_player === "WHITE" ? "BLACK" : "WHITE";
      setPendingRouteAnimation({ pieceId: selectedPieceId, path: customPath.path, special: customPath.special });
      setGame({
        ...game,
        current_player: nextPlayer,
        my_color: game.mode === "local" ? nextPlayer : game.my_color,
        turn_count: game.turn_count + 1,
        has_moved_this_turn: false,
        moved_piece_id: null,
        movement_spent: {},
        turn_start_positions: {},
        visited_positions: {},
        pieces: game.pieces.map((piece) =>
          piece.id === defender.id
            ? { ...piece, position: null, captured: true }
            : piece.id === selectedPieceId
              ? { ...piece, position: defender.position }
              : piece,
        ),
      });
    }
    try {
      const result = await apiRequest<AttackResponse>(`/games/${game.game_id}/attacks`, {
        method: "POST",
        body: JSON.stringify({
          attacker_id: selectedPieceId,
          defender_id: defender.id,
          ...(customPath ? { path: customPath.path, special: customPath.special } : {}),
        }),
      });
      setGame(result.game);
      setLegalPaths([]);
      setSelectedPieceId(null);
      setNotice(
        `Capture réussie : ${result.attack_force} contre ${result.defense_force}. Le tour passe à l’adversaire.`,
      );
    } catch (requestError) {
      if (customPath) setGame(previousGame);
      setPendingRouteAnimation(null);
      setError(requestError instanceof Error ? requestError.message : "Attaque impossible.");
    } finally {
      setPendingRouteAnimation(null);
      gameActionPendingRef.current = false;
      setGameActionPending(false);
    }
  }

  function beginRoute(piece: Piece) {
    if (!game || gameActionPending || gameActionPendingRef.current) return;
    if (piece.owner !== game.current_player || (game.mode === "online" && piece.owner !== game.my_color)) return;
    if (game.moved_piece_id && game.moved_piece_id !== piece.id) {
      setNotice("Tu ne peux jouer qu’une seule pièce pendant ce tour.");
      return;
    }
    setSelectedPieceId(piece.id);
    setLegalPaths(getLocalLegalPaths(game, piece.id));
    setRoutePlan({ pieceId: piece.id, steps: [], attackTargetId: null });
    setError(null);
    setNotice(null);
  }

  function handleRouteCellClick(row: number, col: number) {
    if (!game || gameActionPending || gameActionPendingRef.current) return;
    const key = `${row}:${col}`;
    const piece = piecesAt.get(key);
    if (!routePlan) {
      if (piece) beginRoute(piece);
      return;
    }
    if (piece && piece.owner === game.current_player) {
      if (piece.id === routePlan.pieceId) {
        setRoutePlan({ ...routePlan, steps: [], attackTargetId: null });
      } else {
        beginRoute(piece);
      }
      return;
    }
    const previousStepIndex = routePlan.steps.findIndex((step) => step.row === row && step.col === col);
    if (previousStepIndex >= 0) {
      const steps = routePlan.steps.slice(0, previousStepIndex + 1);
      const completedAttack = routeCandidates.find(({ path, attackTargetId }) =>
        attackTargetId !== null &&
        path.path.length === steps.length &&
        pathMatchesPrefix(path.path, steps),
      );
      setRoutePlan({
        ...routePlan,
        steps,
        attackTargetId: completedAttack?.attackTargetId ?? null,
      });
      return;
    }
    const extension = routeExtensions.find(({ clickPosition }) => sameBoardPosition(clickPosition, { row, col }));
    if (!extension) return;
    const steps = [...routePlan.steps, ...extension.appendSteps];
    const completesPath = extension.path.path.length === steps.length;
    setRoutePlan({
      ...routePlan,
      steps,
      attackTargetId: completesPath ? extension.attackTargetId : null,
    });
  }

  function handleBoardContextMenu(row: number, col: number) {
    handleRouteCellClick(row, col);
  }

  function handleBoardCellClick(row: number, col: number, input: "mouse" | "touch") {
    if (!game || gameActionPending || gameActionPendingRef.current) return;
    if (input === "touch") {
      if (routePlan) {
        handleRouteCellClick(row, col);
        return;
      }
      const touchedPiece = piecesAt.get(`${row}:${col}`);
      if (touchedPiece && touchedPiece.owner === game.current_player) {
        beginRoute(touchedPiece);
        return;
      }
    } else if (routePlan) {
      setRoutePlan(null);
      return;
    }
    const key = `${row}:${col}`;
    const piece = piecesAt.get(key);
    if (legalDestinations.has(key)) {
      const path = legalPaths.find(
        (candidate) => candidate.destination.row === row && candidate.destination.col === col,
      );
      void movePiece(row, col, path?.special ?? null);
    } else if (piece && selectedPieceId && piece.owner !== game.current_player) {
      const preview = combatPreviews.get(piece.id);
      if (!preview) setNotice("Cette pièce est hors de portée.");
      else if (!preview.canCapture) {
        setNotice(`Attaque impossible : force ${preview.attackForce}, défense ${preview.defenseForce}.`);
      } else {
        void attackPiece(piece);
      }
    } else if (piece) {
      void selectPiece(piece);
    }
  }

  function submitRoute() {
    if (!game || !routePlan || !selectedRouteCandidate || gameActionPendingRef.current) return;
    const path = selectedRouteCandidate.path;
    if (routePlan.attackTargetId) {
      const target = game.pieces.find((piece) => piece.id === routePlan.attackTargetId);
      const preview = selectedRouteAttackPreview;
      if (!target || !preview?.canCapture) return;
      setRoutePlan(null);
      void attackPiece(target, path);
      return;
    }
    const destination = path.destination;
    setRoutePlan(null);
    void movePiece(destination.row, destination.col, path.special, path);
  }

  async function performGameAction(action: "end-turn" | "abandon" | "exit") {
    if (!game) return;
    const path = action === "exit"
      ? `/games/${game.game_id}/exit`
      : `/games/${game.game_id}/${action}`;
    const body = action === "exit" ? { piece_id: selectedPieceId } : undefined;
    setError(null);
    gameActionPendingRef.current = true;
    setGameActionPending(true);
    try {
      const nextGame = await apiRequest<GameState>(path, {
        method: "POST",
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setGame(nextGame);
      if (action === "abandon") setGameDialog(null);
      setSelectedPieceId(null);
      setLegalPaths([]);
      setNotice(action === "abandon" ? "Partie abandonnée." : null);
      if (action === "abandon") {
        setSearchingMatch(false);
      }
    } catch (requestError) {
      if (action === "end-turn" && requestError instanceof ApiRequestError && requestError.status === 409) {
        try {
          const latestGame = await apiRequest<GameState>(`/games/${game.game_id}`);
          setGame(latestGame);
          setError("La partie avait changé depuis son dernier chargement. Son état a été actualisé ; réessaie de terminer le tour.");
          return;
        } catch {
          // Keep the original action error visible if the refresh also fails.
        }
      }
      setError(requestError instanceof Error ? requestError.message : "Action impossible.");
    } finally {
      gameActionPendingRef.current = false;
      setGameActionPending(false);
    }
  }

  async function cancelWaitingSearch() {
    if (!game) return;
    setError(null);
    setGameActionPending(true);
    try {
      await apiRequest<void>(`/games/${game.game_id}/waiting`, { method: "DELETE" });
      setGame(null);
      setSearchingMatch(false);
      setWaitingForUsername("");
      setGameDialog(null);
      setView("search");
      setNotice("Recherche annulée.");
      void refreshDashboard();
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 409) {
        try {
          const latestGame = await apiRequest<GameState>(`/games/${game.game_id}`);
          if (latestGame.lifecycle_status !== "waiting") {
            setGameDialog(null);
            transitionIntoGame(latestGame);
            return;
          }
        } catch {
          // Keep the cancellation error visible if refreshing the queue also fails.
        }
      }
      setError(requestError instanceof Error ? requestError.message : "Impossible d’annuler la recherche.");
    } finally {
      setGameActionPending(false);
    }
  }

  async function proposeDraw() {
    if (!game) return;
    setError(null);
    try {
      const offer = await apiRequest<GameDrawOffer>(`/games/${game.game_id}/draw-offers`, { method: "POST" });
      setDrawOffer(offer);
      setGameDialog("draw-offer");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de proposer une égalité.");
    }
  }

  async function answerDrawOffer(accept: boolean) {
    if (!game || !drawOffer) return;
    setError(null);
    try {
      const result = await apiRequest<{ offer: GameDrawOffer; game: GameState | null }>(
        `/games/${game.game_id}/draw-offers/${drawOffer.id}/respond`,
        { method: "POST", body: JSON.stringify({ accept }) },
      );
      setDrawOffer(result.offer.status === "pending" ? result.offer : null);
      if (result.game) {
        setGame(result.game);
        setView("game");
      }
      setGameDialog(null);
      setNotice(accept ? "La partie se termine sur une égalité." : "La proposition d’égalité a été refusée.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Impossible de répondre à la proposition.");
    }
  }

  useEffect(() => {
    if (view !== "game" || !game?.game_id || game.mode !== "online" || game.lifecycle_status !== "ongoing") return;
    let cancelled = false;
    let inFlight = false;
    const refreshOffer = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const offer = await apiRequest<GameDrawOffer | null>(`/games/${game.game_id}/draw-offer`);
        if (cancelled) return;
        setDrawOffer((current) => current?.id === offer?.id && current?.status === offer?.status ? current : offer);
        if (offer?.status === "pending" && offer.proposer_id !== session.user.id) setGameDialog("draw-incoming");
        if (!offer) setGameDialog((current) => {
          if (current === "draw-offer" || current === "draw-incoming") return null;
          return current;
        });
      } catch {
        // The game itself remains playable if draw offers are temporarily unavailable.
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void refreshOffer(); };
    void refreshOffer();
    const timer = window.setInterval(() => void refreshOffer(), 5000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [view, game?.game_id, game?.lifecycle_status, game?.mode, session.user.id]);

  useEffect(() => {
    if (!game?.game_id || !["finished", "abandoned"].includes(game.lifecycle_status)) return;
    let active = true;
    void apiRequest<GameSummary[]>("/games")
      .then((latestGames) => {
        if (!active) return;
        setGames(latestGames);
        setHistoryHasMore(latestGames.length === GAME_HISTORY_PAGE_SIZE);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [game?.game_id, game?.lifecycle_status]);

  useEffect(() => {
    if (
      view !== "game" || !game?.game_id || game.mode !== "online" ||
      !["finished", "abandoned"].includes(game.lifecycle_status)
    ) return;
    const sourceGameId = game.game_id;
    let active = true;
    let inFlight = false;
    const syncRematch = async () => {
      if (!active || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        await apiRequest<void>(`/games/${sourceGameId}/rematch-presence`, {
          method: "PUT",
          body: JSON.stringify({ available: true }),
        });
        const state = await apiRequest<GameRematchStatus>(`/games/${sourceGameId}/rematch-status`);
        if (!active) return;
        setOpponentRematchAvailable(state.opponent_available);
        if (state.outgoing_invitation?.status === "pending") {
          setOutgoingRematch(state.outgoing_invitation);
        } else {
          setOutgoingRematch(null);
        }
        if (state.outgoing_invitation?.status === "accepted") {
          const nextGame = await apiRequest<GameState>(`/games/${state.outgoing_invitation.game_id}`);
          if (active) transitionIntoGame(nextGame);
        }
      } catch {
        if (active) setOpponentRematchAvailable(false);
      } finally {
        inFlight = false;
      }
    };
    void syncRematch();
    const onVisibilityChange = () => { if (document.visibilityState === "visible") void syncRematch(); };
    const timer = window.setInterval(() => void syncRematch(), 4000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void apiRequest<void>(`/games/${sourceGameId}/rematch-presence`, {
        method: "PUT",
        body: JSON.stringify({ available: false }),
      }).catch(() => undefined);
    };
  }, [view, game?.game_id, game?.lifecycle_status, game?.mode]);

  const selectedPiece = game?.pieces.find((piece) => piece.id === selectedPieceId) ?? null;
  const recentGames = useMemo(
    () => [...games]
      .sort((a, b) => Date.parse(b.finished_at ?? b.started_at ?? b.created_at) - Date.parse(a.finished_at ?? a.started_at ?? a.created_at))
      .slice(0, 3),
    [games],
  );
  const selectedAtExit = Boolean(
    game && selectedPiece?.position &&
    ((selectedPiece.owner === "WHITE" && selectedPiece.position.row === game.board_size - 1) ||
      (selectedPiece.owner === "BLACK" && selectedPiece.position.row === 0)),
  );
  const finishedGameSummary = game ? games.find((item) => item.game_id === game.game_id) : undefined;
  const finishedGameOpponentName = finishedGameSummary?.opponent_username || "l’adversaire";
  const finishedOutcome = finishedGameSummary?.result
    ?? (game?.status === "DRAW" ? "draw" : game?.winner ? game.winner === game.my_color ? "win" : "loss" : null);
  const finishedWinnerColor = finishedOutcome === "win"
    ? game?.my_color
    : finishedOutcome === "loss"
      ? game?.my_color === "WHITE" ? "BLACK" : "WHITE"
      : game?.winner;

  async function rematchFinishedGame() {
    if (!game || game.mode !== "online" || !opponentRematchAvailable || outgoingRematch) return;
    setRematchSending(true);
    setError(null);
    try {
      const invitation = await apiRequest<GameInvitation>(`/games/${game.game_id}/rematches`, { method: "POST" });
      if (invitation.status === "accepted") {
        const nextGame = await apiRequest<GameState>(`/games/${invitation.game_id}`);
        transitionIntoGame(nextGame);
      } else {
        setOutgoingRematch(invitation);
        setNotice(`Proposition de revanche envoyée à ${finishedGameOpponentName}.`);
      }
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 409) {
        setOpponentRematchAvailable(false);
      }
      setError(requestError instanceof Error ? requestError.message : "Impossible de proposer une revanche.");
    } finally {
      setRematchSending(false);
    }
  }

  async function findDifferentOpponent() {
    if (!game) return;
    if (game.mode === "online") {
      await apiRequest<void>(`/games/${game.game_id}/rematch-presence`, {
        method: "PUT",
        body: JSON.stringify({ available: false }),
      }).catch(() => undefined);
      setOpponentRematchAvailable(false);
    }
    await findOnlineMatch();
  }

  function reviewFinishedGame() {
    if (!game) return;
    openAnalysis(finishedGameSummary ?? game, "game");
  }

  useEffect(() => {
    if (view !== "game") return;
    const handleGameShortcut = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || gameDialog) return;
      const target = event.target;
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest("input, textarea, select, button, [role='dialog']")
      )) return;
      if (!game || gameActionPendingRef.current || !game.has_moved_this_turn) return;
      if (game.mode === "online" && game.my_color !== game.current_player) return;
      event.preventDefault();
      void performGameAction("end-turn");
    };
    window.addEventListener("keydown", handleGameShortcut);
    return () => window.removeEventListener("keydown", handleGameShortcut);
  }, [view, game?.game_id, game?.current_player, game?.my_color, game?.mode, game?.has_moved_this_turn, gameDialog]);

  return (
    <div className={`dashboard dashboard-${view}`}>
      {(error || notice) && <div className={`dashboard-alert ${error ? "dashboard-alert-error" : "dashboard-alert-ok"}`} role={error ? "alert" : "status"}>{error ? <CircleAlert size={16}/> : <Check size={16}/>}<span>{error || notice}</span><button onClick={() => {setError(null);setNotice(null)}} aria-label="Fermer"><X size={15}/></button></div>}
      {view === "analysis" && reviewGameId ? (
        <Suspense fallback={<main className="analysis-page"><div className="analysis-loading">Ouverture de l’analyse…</div></main>}><GameAnalysis gameId={reviewGameId} summary={reviewSummary} onBack={() => setView(analysisReturnView)} /></Suspense>
      ) : view === "game-transition" ? (
        <main className="launch-transition game-transition" aria-live="polite"><div className="launch-mark"><i/><i/><i/><i/></div><span className="card-kicker">VEYLITH · PRÉPARATION DU TERRAIN</span><h1>La traversée commence</h1><p>La partie est prête.</p><div className="launch-line"><i/></div></main>
      ) : view === "game" && game ? (
      <main
        className="game-screen"
        onPointerDownCapture={(event) => {
          if (
            routePlan && event.pointerType !== "touch" && event.button === 0 &&
            !(event.target instanceof Element && event.target.closest(".move-route-popup button"))
          ) {
            setRoutePlan(null);
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
          <header className="game-toolbar">
            <div className="game-turn-indicator"><span className={`turn-light ${game.current_player === game.my_color ? "turn-light-mine" : ""}`} /><strong>{game.mode === "local" || game.current_player === game.my_color ? "À vous de jouer" : "Tour adverse"}</strong><span>Tour {game.turn_count} · {game.my_color === "WHITE" ? "Ivoire" : "Obsidienne"}</span></div>
            <span className="game-label">{game.mode === "local" ? "Partie locale" : "Partie en ligne"}</span>
            <div className="game-toolbar-actions"><button className="outline-button" onClick={() => setNotice("Sélectionne une pièce pour afficher ses déplacements. Une seule pièce peut jouer par tour.")}><BookOpen size={15} />Comment jouer</button>{selectedAtExit && <button className="outline-button" onClick={() => void performGameAction("exit")} disabled={gameActionPending}>Sortir la pièce</button>}<button className="primary-button game-end-turn" onClick={() => void performGameAction("end-turn")} disabled={gameActionPending || !game.has_moved_this_turn || (game.mode === "online" && game.my_color !== game.current_player)} title="Raccourci : Entrée" aria-keyshortcuts="Enter">{gameActionPending ? "Enregistrement…" : "Terminer le tour"}<kbd>Entrée</kbd><ArrowRight size={16}/></button><button className="icon-button" onClick={() => setGameDialog("leave")} title="Quitter la partie">✕</button></div>
          </header>
          {game.lifecycle_status === "ongoing" ? <div className="game-layout">
            <aside className="player-column">
              {([game.my_color, game.my_color === "WHITE" ? "BLACK" : "WHITE"] as const).map((color) => <article className={`player-card ${game.current_player === color ? "player-card-active" : ""}`} key={color}><div className="player-card-head"><span className={`player-avatar ${color === "WHITE" ? "avatar-ivory" : "avatar-dark"}`}>{color === "WHITE" ? "JV" : "AD"}</span><span><strong>{color === game.my_color ? "Vous" : games.find((summary)=>summary.game_id===game.game_id)?.opponent_username || "Adversaire"}</strong><small>Pièces {color === "WHITE" ? "ivoire" : "obsidienne"}</small>{color !== game.my_color && opponentConnectionStatus === "reconnecting" && <em className="connection-status">Reconnexion en cours…</em>}</span></div><div className="player-points"><b>{game.scores[color] ?? 0}</b><span>points</span></div><div className="piece-counts">Explorateurs · {game.pieces.filter((p) => p.owner === color && p.piece_type === "EXPLORER" && !p.captured && !p.finished).length}<br/>Avant-gardes · {game.pieces.filter((p) => p.owner === color && p.piece_type === "VANGUARD" && !p.captured && !p.finished).length}<br/>Sentinelles · {game.pieces.filter((p) => p.owner === color && p.piece_type === "SENTINEL" && !p.captured && !p.finished).length}</div></article>)}
            </aside>
            <section className="board-stage">
              <Suspense fallback={<div className="game-board-loading">Préparation du plateau 3D…</div>}>
                <GameBoard3D
                  game={game}
                  disabled={gameActionPending}
                  hideIndicators={gameActionPending}
                  selectedPieceId={selectedPieceId}
                  legalDestinations={routePlan ? routeNextCells : legalDestinations}
                  attackablePieceIds={routePlan ? routeAttackableIds : attackablePieceIds}
                  insufficientAttackPieceIds={routePlan ? routeInsufficientAttackIds : insufficientAttackPieceIds}
                  interactiveCells={interactiveCells}
                  routePath={routePlan?.steps ?? []}
                  routeIsAttack={Boolean(routePlan?.attackTargetId)}
                  movementPathOverride={pendingRouteAnimation}
                  onCellClick={handleBoardCellClick}
                  onCellContextMenu={handleBoardContextMenu}
                />
              </Suspense>
              {routePlan && selectedPiece && <section className="move-route-popup" aria-live="polite">
                <div className="move-route-status">
                  <span className="card-kicker">TRAJET PERSONNALISÉ</span>
                  <strong>{routePlan.attackTargetId ? "Attaque préparée" : "Mouvement restant"}</strong>
                  <small>{routeRemainingPoints} / {selectedPiece.movement_points - (game.movement_spent[selectedPiece.id] ?? 0)} points disponibles</small>
                  {routePlan.attackTargetId && selectedRouteAttackPreview && <small>Force {selectedRouteAttackPreview.attackForce} · défense {selectedRouteAttackPreview.defenseForce}</small>}
                </div>
                <button
                  className="primary-button"
                  onClick={submitRoute}
                  disabled={!selectedRouteCandidate || gameActionPending || Boolean(routePlan.attackTargetId && !selectedRouteAttackPreview?.canCapture)}
                >
                  {routePlan.attackTargetId ? "Attaquer" : "Valider le trajet"}
                </button>
                <button className="outline-button" onClick={() => setRoutePlan(null)} disabled={gameActionPending}>Annuler</button>
              </section>}
            </section>
            <aside className="turn-panel"><h3>État du tour</h3><div><span>Pièce active</span><b>{selectedPiece?.piece_type ?? "—"}</b></div><div><span>Mouvement restant</span><b>{selectedPiece ? selectedPiece.movement_points : "—"}</b></div><div><span>Attaque</span><b>{game.has_moved_this_turn ? "Utilisée / tour terminé" : "Disponible"}</b></div><h4>Hauteur des cases</h4><div className="height-bars"><i/><i/><i/><i/></div><small>Le terrain est assemblé en blocs d’une unité.</small></aside>
          </div> : <section className="game-result"><span className="card-kicker">PARTIE TERMINÉE</span><h1>{finishedOutcome === "draw" ? "Égalité" : finishedOutcome === "win" ? "Victoire" : finishedOutcome === "loss" ? "Défaite" : "Partie terminée"}</h1><p className="game-result-subtitle">{game.mode === "local" ? "Partie locale" : `Partie en ligne · contre ${finishedGameSummary?.opponent_username || "Adversaire"}`} · durée {finishedGameSummary ? gameDuration(finishedGameSummary) : "chargement…"}</p><div className="game-result-details"><article><small>IVOIRE · BLANCS</small><b>{game.mode === "local" ? "Joueur ivoire" : game.my_color === "WHITE" ? `Vous · ${myProfile?.username || "Joueur"}` : finishedGameSummary?.opponent_username || "Adversaire"}</b><strong>{game.scores.WHITE ?? 0} points</strong></article><article><small>OBSIDIENNE · NOIRS</small><b>{game.mode === "local" ? "Joueur obsidienne" : game.my_color === "BLACK" ? `Vous · ${myProfile?.username || "Joueur"}` : finishedGameSummary?.opponent_username || "Adversaire"}</b><strong>{game.scores.BLACK ?? 0} points</strong></article><article className="game-result-winner"><small>RÉSULTAT</small><b>{finishedOutcome === "draw" ? "Égalité" : finishedWinnerColor === "WHITE" ? `Victoire · ${game.mode === "local" ? "Joueur ivoire" : game.my_color === "WHITE" ? "Vous" : finishedGameSummary?.opponent_username || "Adversaire"}` : finishedWinnerColor === "BLACK" ? `Victoire · ${game.mode === "local" ? "Joueur obsidienne" : game.my_color === "BLACK" ? "Vous" : finishedGameSummary?.opponent_username || "Adversaire"}` : game.lifecycle_status === "abandoned" ? "Abandon" : "Résultat indisponible"}</b></article></div><div className="game-result-actions">{game.mode === "local" ? <button className="primary-button" onClick={()=>void createGame("local")} disabled={loading}>{loading?<LoaderCircle className="spin" size={16}/>:<Swords size={16}/>} Nouvelle partie locale</button> : <><button className={`primary-button rematch-button ${!opponentRematchAvailable ? "rematch-unavailable" : ""}`} onClick={()=>void rematchFinishedGame()} disabled={!opponentRematchAvailable||Boolean(outgoingRematch)||rematchSending||loading}>{rematchSending||outgoingRematch?.status === "pending" ? <LoaderCircle className="spin" size={16}/> : <Swords size={16}/>} {rematchSending||outgoingRematch?.status === "pending" ? "En attente de réponse…" : `Rejouer contre ${finishedGameOpponentName}`}</button><button className="outline-button" onClick={()=>void findDifferentOpponent()} disabled={loading}><Search size={16}/>Trouver un autre adversaire</button></>}<button className="outline-button game-result-quit" onClick={()=>setView("home")}>Quitter · accueil</button><button className="outline-button" onClick={reviewFinishedGame}><RotateCcw size={16}/>Revoir la partie</button></div></section>}
          {gameDialog && <GameDecisionDialog mode={gameDialog} allowDraw={game.mode==="online"&&game.lifecycle_status==="ongoing"} onClose={()=>setGameDialog(null)} onAbandon={()=>void performGameAction("abandon")} onProposeDraw={()=>void proposeDraw()} onAnswerDraw={answerDrawOffer} />}
        </main>
      ) : view === "waiting" && game ? (
        <main className="waiting-screen"><div className="waiting-content"><div className="waiting-board-art">{Array.from({length:49},(_,i)=><i key={i} className={(Math.floor(i/7)+i%7)%3===0?"raised":""}/>)}</div><span className="card-kicker">{game.lifecycle_status !== "waiting" ? "ADVERSAIRE TROUVÉ" : searchingMatch || game.visibility === "public" ? "RECHERCHE EN LIGNE" : "PARTIE PRIVÉE"}</span><h1>{game.lifecycle_status !== "waiting" ? "Adversaire trouvé" : searchingMatch || game.visibility === "public" ? "Recherche d’un adversaire" : `En attente de ${waitingForUsername || "ton ami"}`}</h1><p>{game.lifecycle_status !== "waiting" ? "Préparation du plateau…" : searchingMatch || game.visibility === "public" ? "Nous cherchons un joueur disponible pour te rejoindre." : `Invitation envoyée. La partie commencera lorsque ${waitingForUsername || "ton ami"} aura rejoint.`}</p><div className="waiting-progress"><i/><i/><i/></div><button className="primary-button waiting-cancel" onClick={()=>setGameDialog("leave")}><X size={17}/>{searchingMatch||game.visibility==="public"?"Annuler la recherche":"Annuler et quitter"}</button>{gameDialog&&<GameDecisionDialog mode="leave" allowDraw={false} onClose={()=>setGameDialog(null)} onAbandon={()=>void cancelWaitingSearch()} onProposeDraw={()=>void proposeDraw()} onAnswerDraw={answerDrawOffer}/>}</div></main>
      ) : (
        <div className="app-frame">
          <header className="app-topbar"><a className="app-wordmark" href="#accueil" onClick={(event)=>{event.preventDefault();setView("home")}}>VEYLITH<span>STRATÉGIE · TERRAIN · EXPLORATION</span></a><nav className="top-navigation"><button className={view==="home"?"nav-active":""} onClick={()=>setView("home")}>Accueil</button><button className={view==="search"?"nav-active":""} onClick={()=>setView("search")}>Recherche de partie</button><button className={view==="tutorial"?"nav-active":""} onClick={()=>setView("tutorial")}>Tutoriel</button></nav><div className="app-account"><span className="player-avatar avatar-ivory">{(session.user.email?.[0]||"J").toUpperCase()}</span><span><b>{myProfile?.username||session.user.email?.split("@")[0]||"Joueur"}</b><small>En ligne</small></span><button className="icon-button" onClick={onLogout} disabled={busy} title="Se déconnecter"><LogOut size={17}/></button></div></header>
          <div className="app-body"><aside className="side-navigation"><span className="side-label">MENU</span><button className={view==="home"?"side-active":""} onClick={()=>setView("home")}><House size={18}/>Accueil</button><button className={view==="search"?"side-active":""} onClick={()=>setView("search")}><Swords size={18}/>Jouer</button><button className={view==="tutorial"?"side-active":""} onClick={()=>setView("tutorial")}><BookOpen size={18}/>Tutoriel</button><button className={view==="friends"?"side-active":""} onClick={()=>setView("friends")}><Users size={18}/>Amis{friendRequests.some((item)=>item.addressee_id===session.user.id)&&<i className="notification-dot"/>}</button><button className={view==="history"?"side-active":""} onClick={()=>setView("history")}><RotateCcw size={18}/>Historique</button><div className="side-bottom"><div className="server-status"><i/>Serveurs disponibles</div><button className={view==="profile"?"side-active":""} onClick={()=>setView("profile")}><Fingerprint size={18}/>Mon profil</button><button className="side-logout" onClick={onLogout} disabled={busy}><LogOut size={18}/>Déconnexion</button></div></aside>
            <main className="page-content">
              {view==="home"&&<><section className="home-hero"><div className="hero-copy"><span className="card-kicker">UN JEU DE STRATÉGIE EN RELIEF</span><span className="gold-kicker">CHAQUE TERRAIN CHANGE LA TRAVERSÉE</span><h1>Prenez de la hauteur.<br/><em>Tracez votre route.</em></h1><p>Déplacez vos pièces sur un plateau de pierre vivant. L’altitude, la position et le bon moment font basculer chaque partie.</p><div className="hero-actions"><button className="primary-button" onClick={()=>setView("search")}><Swords size={17}/>Trouver une partie</button><button className="outline-button" onClick={()=>setView("tutorial")}><BookOpen size={17}/>Suivre le tutoriel</button></div></div><TerrainIllustration className="hero-terrain"/></section><section className="home-lower"><div className="terrain-note"><span className="square-icon"><span className="mountain-icon">⌃</span></span><div><b>Un terrain à lire</b><p>Des cases empilées par unités de hauteur. Chaque relief devient une décision tactique.</p></div><span className="board-size">10 × 10</span></div><button className="quick-play" onClick={()=>setView("search")}><span className="player-avatar avatar-ivory">VS</span><span><b>Prêt pour une nouvelle partie ?</b><small>En ligne · partie rapide</small></span><span className="quick-link">Jouer →</span></button></section><section className="home-invitations">{invitations.map((invitation)=><article className="home-invitation" key={invitation.id}><span><b>{invitation.source_game_id ? `${invitation.inviter_username || "Un joueur"} vous propose une revanche` : `${invitation.inviter_username || "Un joueur"} vous invite`}</b><small>{invitation.source_game_id ? "Rejouer ensemble" : "Rejoindre sa partie en ligne"}</small></span><button className="small-primary" onClick={()=>void answerInvitation(invitation,"accept")}>Accepter</button><button className="outline-button" onClick={()=>void answerInvitation(invitation,"reject")}>Refuser</button></article>)}</section><section className="home-resume"><div className="section-heading"><div><span className="card-kicker">HISTORIQUE</span><h2>Dernières parties</h2></div><button className="text-button" onClick={()=>setView("history")}>Tout l’historique <ArrowRight size={15}/></button></div>{recentGames.map((item)=><GameHistoryRow key={item.game_id} game={item} onOpen={()=>openAnalysis(item,"home")}/>)}{recentGames.length===0&&<p className="muted-copy">Aucune partie jouée pour l’instant.</p>}</section></>}
              {view==="search"&&<><section className="page-heading"><span className="gold-kicker">PARTIES EN LIGNE</span><h1>Trouvez votre adversaire</h1><p>Lancez une recherche en ligne ou choisissez une partie locale sur cet ordinateur.</p></section><section className="search-layout"><article className="feature-panel"><span className="card-kicker">RECHERCHE AUTOMATIQUE</span><h2>Partie rapide</h2><p>Mise en relation avec un joueur disponible, sans invitation préalable.</p><div className="mode-choice"><span className="square-icon"><ZapIcon/></span><span><b>Partie amicale</b><small>Jouez sans enjeu de classement</small></span><i className="radio-selected"/></div><button className="primary-button search-submit" onClick={()=>void findOnlineMatch()} disabled={loading||searchingMatch}>{loading?<LoaderCircle className="spin" size={16}/>:<Search size={16}/>}Rechercher un adversaire</button><p className="center-note">Recherche ouverte aux joueurs en ligne</p><p className="friend-hint search-friend-hint"><UserPlus size={18}/><span><b>Vous jouez avec un ami ?</b> Envoyez-lui une invitation depuis la page Amis.</span></p></article><article className="feature-panel local-games"><span className="card-kicker">SUR LE MÊME ORDINATEUR</span><h2>Partie locale</h2><p>Jouez à deux sur cet ordinateur, en vous passant le clavier et la souris à chaque tour.</p><div className="local-mode-option"><span className="square-icon"><Users size={20}/></span><span><b>Deux joueurs en local</b><small>Un seul écran · chacun son tour</small></span></div><button className="primary-button full-button" onClick={()=>void createGame("local")} disabled={loading}>{loading?<LoaderCircle className="spin" size={16}/>:<Swords size={16}/>}Créer une partie à deux</button><div className="panel-divider"/><div className="local-mode-option local-mode-unavailable"><span className="square-icon"><Bot size={20}/></span><span><b>Jouer contre un bot</b><small>Adversaire contrôlé par l’intelligence artificielle</small></span></div><button className="outline-button full-button local-bot-button" type="button" disabled title="Le mode contre un bot n’est pas encore disponible">Jouer contre un bot · bientôt disponible</button></article></section></>}
              {view==="tutorial"&&<TutorialCarousel slide={tutorialSlide} onSlideChange={setTutorialSlide} onPlay={()=>setView("search")}/>}
              {view==="friends"&&<><section className="page-heading"><span className="gold-kicker">COMMUNAUTÉ VEYLITH</span><h1>Amis et invitations</h1><p>Trouvez vos amis, gérez les demandes et invitez-les à votre table.</p></section><section className="friends-layout"><article className="feature-panel"><h2>Rechercher un joueur</h2><form className="search-row" onSubmit={searchUsers}><Search size={17}/><input value={searchText} onChange={(event)=>{setSearchText(event.target.value);setUserSearchDone(false)}} placeholder="Nom d’utilisateur ou identifiant" minLength={2}/><button type="submit" disabled={searchText.trim().length<2||searchingUsers}>{searchingUsers?"Recherche…":"Chercher"}</button></form>{searchResults.map((user)=><div className="social-row" key={user.id}><span><b>{user.username}</b><small>{user.id}</small></span><button className="small-primary" onClick={()=>void sendFriendRequest(user)}>Ajouter</button></div>)}{userSearchDone&&searchResults.length===0&&<p className="muted-copy">Aucun joueur trouvé.</p>}<h3>Mes amis · {friends.length}</h3>{friends.map((friend)=><div className="social-row" key={friend.id}><span><b>{friend.other_username||"Ami"}</b><small>En ligne avec VEYLITH</small></span><button className="outline-button" disabled={loading} onClick={()=>{const id=friend.requester_id===session.user.id?friend.addressee_id:friend.requester_id;void inviteFriendToGame({id,username:friend.other_username||"Ami",avatar_url:null})}}><Swords size={15}/>Inviter</button></div>)}{friends.length===0&&<p className="muted-copy">Ajoutez un ami pour jouer ensemble.</p>}</article><article className="feature-panel"><h2>Demandes reçues</h2>{friendRequests.filter((item)=>item.addressee_id===session.user.id).map((request)=><div className="social-row" key={request.id}><span><b>{request.other_username||request.requester_id.slice(0,8)}</b><small>Demande d’ami</small></span><span className="row-actions"><button onClick={()=>void answerFriendRequest(request.id,"accept")} aria-label="Accepter"><Check size={16}/></button><button onClick={()=>void answerFriendRequest(request.id,"reject")} aria-label="Refuser"><X size={16}/></button></span></div>)}{friendRequests.filter((item)=>item.addressee_id===session.user.id).length===0&&<p className="muted-copy">Aucune demande reçue.</p>}<h3>Demandes envoyées</h3>{friendRequests.filter((item)=>item.requester_id===session.user.id).map((request)=><div className="social-row" key={request.id}><span><b>{request.other_username||request.addressee_id.slice(0,8)}</b><small>En attente de réponse</small></span></div>)}<h3>Invitations de partie</h3>{invitations.map((invitation)=><div className="social-row" key={invitation.id}><span><b>{invitation.inviter_username||"Un ami"}</b><small>Partie {invitation.game_id.slice(0,8)}</small></span><span className="row-actions"><button onClick={()=>void answerInvitation(invitation,"accept")} aria-label="Accepter"><Check size={16}/></button><button onClick={()=>void answerInvitation(invitation,"reject")} aria-label="Refuser"><X size={16}/></button></span></div>)}{invitations.length===0&&<p className="muted-copy">Aucune invitation en attente.</p>}</article></section></>}
              {view==="history"&&<><section className="page-heading"><span className="gold-kicker">VOTRE PARCOURS</span><h1>Historique des parties</h1><p>Retrouvez les parties enregistrées sur votre compte.</p></section><section className="history-list">{games.map((item)=><GameHistoryRow key={item.game_id} game={item} onOpen={()=>openAnalysis(item,"history")}/>)}{games.length===0&&<p className="muted-copy">Votre historique apparaîtra ici après votre première partie.</p>}</section>{historyHasMore&&<button className="outline-button history-load-more" onClick={()=>void loadMoreHistory()} disabled={loadingMoreHistory}>{loadingMoreHistory?<LoaderCircle className="spin" size={16}/>:null}{loadingMoreHistory?"Chargement…":"Charger les parties précédentes"}</button>}</>}
              {view==="profile"&&<><section className="page-heading"><span className="gold-kicker">COMPTE VEYLITH</span><h1>Mon profil</h1><p>Informations de votre session et progression.</p></section><section className="feature-panel profile-card"><span className="profile-avatar">{(session.user.email?.[0]||"J").toUpperCase()}</span><div><h2>{myProfile?.username||session.user.email?.split("@")[0]||"Joueur"}</h2><p>{session.user.email}</p><small>ID · {session.user.id}</small></div></section><form className="feature-panel profile-edit" onSubmit={saveUsername}><label htmlFor="profile-username">Nom d’utilisateur</label><input id="profile-username" value={usernameDraft} onChange={(event)=>setUsernameDraft(event.target.value)} minLength={3} maxLength={24} pattern="[a-zA-Z0-9_-]+" required/><small>3 à 24 caractères : lettres, chiffres, tiret ou tiret bas.</small><button className="primary-button" disabled={savingProfile}>{savingProfile?<LoaderCircle className="spin" size={16}/>:null}Enregistrer</button></form><button className="outline-button profile-logout" onClick={onLogout} disabled={busy}><LogOut size={15}/>Se déconnecter</button></>}
            </main></div>
        </div>
      )}
      {invitationToast && <div className="invitation-toast" role="dialog" aria-live="assertive" onClick={() => setInvitationToast(null)}><button className="invitation-toast-close" onClick={() => setInvitationToast(null)} aria-label="Fermer">×</button><span className="card-kicker">{invitationToast.source_game_id ? "REVANCHE · 2 S" : "INVITATION DE PARTIE · 6 S"}</span><b>{invitationToast.source_game_id ? `${invitationToast.inviter_username || "Un joueur"} veut rejouer contre toi` : `${invitationToast.inviter_username || "Un joueur"} t’invite à jouer`}</b><div><button className="primary-button" onClick={() => void answerInvitation(invitationToast, "accept")}>{invitationToast.source_game_id ? "Accepter la revanche" : "Accepter"}</button><button className="outline-button" onClick={() => void answerInvitation(invitationToast, "reject")}>Refuser</button></div></div>}
    </div>
  );
}

const tutorialSlides = [
  {
    eyebrow: "AVANT DE JOUER",
    title: "Commandes et interface",
    description: "Choisis une pièce pour afficher ses coups, puis sélectionne une destination ou une cible d’attaque.",
    points: [
      "Clic gauche : sélectionne une pièce, puis une case cyan pour un déplacement direct ou une cible rouge pour attaquer.",
      "Trajet souris : clic droit sur ta pièce, puis clic droit sur chaque case suivante pour tracer le chemin. Les cases possibles se recalculent à chaque étape.",
      "Clic droit sur une étape déjà tracée revient à cette étape et efface la suite. Un clic gauche hors des commandes du trajet annule le tracé.",
      "Trajet tactile : sélectionne ta pièce, puis touche chaque case du chemin. La fenêtre affiche les points restants et permet de valider ou d’annuler.",
      "Rotation : maintiens le bouton central de la souris et glisse. Zoom : roulette.",
      "Écran tactile : fais glisser deux doigts pour tourner ; pince pour zoomer ou dézoomer.",
      "Entrée termine le tour après une action. Le raccourci est inactif pendant le tour adverse.",
    ],
    variant: "controls" as const,
  },
  {
    eyebrow: "01 · OBJECTIF ET PIÈCES",
    title: "Traverse le plateau",
    description: "Le plateau fait 10 × 10 cases. Chaque camp dispose de six pièces : deux de chaque type.",
    points: [
      "Explorateur : 5 mouvements · force 1 · rapporte 1 point à l’arrivée.",
      "Avant-garde : 4 mouvements · force 2 · rapporte 2 points à l’arrivée.",
      "Sentinelle : 3 mouvements · force 3 · rapporte 3 points à l’arrivée.",
      "Les pièces ivoire partent en haut et sortent en bas ; les obsidiennes font l’inverse.",
    ],
    variant: "pieces" as const,
  },
  {
    eyebrow: "02 · RELIEF ET DÉPLACEMENT",
    title: "Lis la hauteur des cases",
    description: "Les déplacements ordinaires se font d’une case à la suivante, horizontalement ou verticalement. Les cases occupées bloquent le passage.",
    points: [
      "Coût par pas : 1 + différence de hauteur. Monter ou descendre de 2 niveaux coûte 3 points.",
      "Tu dois déplacer au moins une pièce et conserver la même pièce pendant le tour ; tu peux t’arrêter avant d’épuiser ses points.",
      "Un Explorateur peut aller en diagonale d’une case ou sauter de deux cases en ligne droite si la case intermédiaire est libre.",
      "Ces coups spéciaux terminent son déplacement pour le tour. Aucun retour sur la case de départ ni passage répété.",
    ],
    variant: "terrain" as const,
  },
  {
    eyebrow: "03 · COMBAT",
    title: "Choisis tes attaques",
    description: "Une pièce peut attaquer une cible ennemie à portée de son mouvement restant. L’attaque est calculée immédiatement et capture la cible si elle réussit.",
    points: [
      "Attaque = force de base, +1 depuis une case plus haute ou −1 depuis une case plus basse, puis la force des alliés adjacents à la cible.",
      "Avant-garde : +1 si tous ses points de mouvement sont dépensés. À hauteur égale, aucun bonus de terrain.",
      "Défense = force de la cible +1 par allié adjacent à elle.",
      "Attaque ≥ défense : capture et fin immédiate du tour. Une seule attaque par tour.",
    ],
    variant: "combat" as const,
  },
  {
    eyebrow: "04 · SCORE ET VICTOIRE",
    title: "Marque des points pour gagner",
    description: "Quand une pièce atteint sa rangée de sortie, utilise « Sortir la pièce » : elle quitte le plateau et ajoute sa force au score.",
    points: [
      "La première Sentinelle à sortir fait gagner immédiatement son camp.",
      "Après deux sorties, le score le plus élevé gagne ; un score égal donne une égalité.",
      "Au 200e tour, le score départage s’il est non nul ; sinon, on compare la progression vers la sortie, puis la force des pièces les plus avancées. Égalité si tout reste égal.",
    ],
    variant: "score" as const,
  },
];

function TutorialCarousel({slide,onSlideChange,onPlay}:{slide:number;onSlideChange:(index:number)=>void;onPlay:()=>void}) {
  const previous = () => onSlideChange(Math.max(0, slide - 1));
  const next = () => onSlideChange(Math.min(tutorialSlides.length - 1, slide + 1));
  return <>
    <section className="page-heading tutorial-heading"><span className="gold-kicker">APPRENDRE EN JOUANT</span><h1>Les bases de la traversée</h1></section>
    <section className="tutorial-carousel" aria-label="Tutoriel Traversal">
      <div className="tutorial-viewport"><div className="tutorial-track" style={{ transform: `translateX(-${slide * 100}%)` }}>
        {tutorialSlides.map((item,index)=><article className="tutorial-slide" aria-hidden={index!==slide} key={item.eyebrow}>
          <div className="tutorial-art-panel"><TutorialIllustration variant={item.variant}/><span>RÈGLES · {String(index+1).padStart(2,"0")}/{tutorialSlides.length}</span></div>
          <div className="tutorial-copy"><span className="gold-kicker">{item.eyebrow}</span><h2>{item.title}</h2><p>{item.description}</p><ul>{item.points.map((point)=><li key={point}>{point}</li>)}</ul></div>
        </article>)}
      </div></div>
      <footer className="tutorial-controls"><button className="outline-button tutorial-nav" onClick={previous} disabled={slide===0} aria-label="Page précédente"><ArrowLeft size={16}/>Précédent</button><div className="tutorial-progress" aria-label={`Page ${slide+1} sur ${tutorialSlides.length}`}>{tutorialSlides.map((item,index)=><button key={item.eyebrow} className={index===slide?"tutorial-dot tutorial-dot-active":"tutorial-dot"} onClick={()=>onSlideChange(index)} aria-label={`Aller à la page ${index+1}`} aria-current={index===slide?"step":undefined}/>)}</div>{slide<tutorialSlides.length-1?<button className="primary-button tutorial-nav" onClick={next}>Suivant<ArrowRight size={16}/></button>:<button className="primary-button tutorial-nav" onClick={onPlay}>Voir une partie<ArrowRight size={16}/></button>}</footer>
    </section>
  </>;
}

function TutorialIllustration({variant}:{variant:"controls"|"pieces"|"terrain"|"combat"|"score"}) {
  const tile=24, left=24, top=26;
  const heightAt=(row:number,col:number)=>Math.max(0,5-Math.floor((Math.abs(row-4.5)+Math.abs(col-4.5))*0.65));
  const board=Array.from({length:100},(_,index)=>{
    const row=Math.floor(index/10),col=index%10,x=left+col*tile,y=top+row*tile;
    const height=heightAt(row,col);
    const selected=variant==="controls"&&row===6&&col===4;
    const destination=variant==="controls"&&((row===6&&col===5)||(row===5&&col===4)||(row===5&&col===5));
    const exit=variant==="score"&&(row===0||row===9);
    const fill=destination?"#507e91":selected?"#b7a776":exit?"#766b54":(row+col)%2===0?"#d4c6aa":"#a99b82";
    return <g key={index}><rect x={x} y={y} width={tile} height={tile} fill={fill} stroke="#5c574d" strokeWidth=".8"/>{variant==="terrain"&&<text x={x+tile/2} y={y+16} textAnchor="middle" fill="#282a2a" fontSize="10" fontWeight="700">{height}</text>}</g>;
  });
  const piece=(row:number,col:number,color:"ivory"|"dark",type:"explorer"|"vanguard"|"sentinel"="explorer")=>{
    const cx=left+col*tile+tile/2,cy=top+row*tile+tile/2;
    const stone=color==="ivory"?"#eee2c9":"#333638",edge=color==="ivory"?"#8a7f69":"#111415";
    return <g key={`${row}-${col}-${color}-${type}`} transform={`translate(${cx} ${cy})`}>
      <ellipse cy="5" rx="8" ry="3.2" fill={edge}/><ellipse cy="3" rx="7" ry="2.6" fill={stone} stroke={edge} strokeWidth=".8"/>
      {type==="sentinel"?<><path d="M-4 2V-8L-6-12 0-15 6-12 4-8V2Z" fill={stone} stroke={edge} strokeWidth=".8"/><path d="M-5-12 0-15 5-12 0-9Z" fill={color==="ivory"?"#f5e9d1":"#4c5052"} stroke={edge} strokeWidth=".6"/></>:type==="vanguard"?<path d="M-5 2 -4-6 -7-10 0-14 7-10 4-6 5 2Z" fill={stone} stroke={edge} strokeWidth=".8"/>:<path d="M-4 2 -5-5 0-15 5-5 4 2Z" fill={stone} stroke={edge} strokeWidth=".8"/>}
    </g>;
  };
  return <svg className={`tutorial-diagram tutorial-diagram-${variant}`} viewBox="0 0 560 340" role="img" aria-label={`Schéma des règles : ${variant}`}>
    {variant!=="pieces"&&variant!=="combat"&&<g>{board}</g>}
    {variant==="controls"&&<>
      {piece(6,4,"ivory")}<path d={`M${left+4*tile+tile/2} ${top+6*tile+tile/2} L${left+5*tile+tile/2} ${top+6*tile+tile/2}`} stroke="#eaf8ff" strokeWidth="2.5" strokeDasharray="4 3"/>
      <text x="300" y="80" fill="#9ad9f2" fontSize="15" fontWeight="700">CASES CYAN</text><text x="300" y="102" fill="#d4d2ca" fontSize="12">Destinations autorisées</text>
      <rect x="300" y="130" width="205" height="54" rx="4" fill="#202731" stroke="#ffffff30"/><text x="318" y="153" fill="#e9dfc8" fontSize="12" fontWeight="700">ENTRÉE</text><text x="318" y="171" fill="#d4d2ca" fontSize="11">Terminer après une action</text>
      <text x="300" y="220" fill="#d4d2ca" fontSize="11">Rouge : cible attaquable</text><rect x="300" y="230" width="12" height="12" fill="#b65e4d"/>
      <text x="24" y="286" fill="#bfc4c5" fontSize="10">Exemple de cases possibles — les coups affichés dépendent de la pièce et du relief.</text>
    </>}
    {variant==="pieces"&&<>
      {[{x:95,label:"EXPLORATEUR",move:"MOUV. 5",force:"FORCE 1",type:"explorer" as const},{x:280,label:"AVANT-GARDE",move:"MOUV. 4",force:"FORCE 2",type:"vanguard" as const},{x:465,label:"SENTINELLE",move:"MOUV. 3",force:"FORCE 3",type:"sentinel" as const}].map(item=><g key={item.label}>
        <rect x={item.x-78} y="45" width="156" height="245" rx="5" fill="#252b33" stroke="#ffffff28"/><ellipse cx={item.x} cy="141" rx="37" ry="10" fill="#111519"/><ellipse cx={item.x} cy="137" rx="32" ry="9" fill="#d3c5a7" stroke="#766d5e"/>
        {item.type==="explorer"?<path d={`M${item.x-19} 134 ${item.x-14} 85 ${item.x} 55 ${item.x+14} 85 ${item.x+19} 134Z`} fill="#e7dcc5" stroke="#8c8069" strokeWidth="2"/>:item.type==="vanguard"?<path d={`M${item.x-22} 134 ${item.x-18} 91 ${item.x-28} 74 ${item.x} 57 ${item.x+28} 74 ${item.x+18} 91 ${item.x+22} 134Z`} fill="#d9cbae" stroke="#8c8069" strokeWidth="2"/>:<><path d={`M${item.x-19} 133V89L${item.x-26} 73 ${item.x} 58 ${item.x+26} 73 ${item.x+19} 89V133Z`} fill="#e7dcc5" stroke="#8c8069" strokeWidth="2"/><path d={`M${item.x-25} 73 ${item.x} 58 ${item.x+25} 73 ${item.x} 87Z`} fill="#f0e5d0" stroke="#8c8069" strokeWidth="1.5"/></>}
        <text x={item.x} y="183" textAnchor="middle" fill="#e7ddc8" fontSize="12" fontWeight="700">{item.label}</text><text x={item.x} y="216" textAnchor="middle" fill="#bdc2c4" fontSize="12">{item.move}</text><text x={item.x} y="239" textAnchor="middle" fill="#bdc2c4" fontSize="12">{item.force}</text><text x={item.x} y="268" textAnchor="middle" fill="#c9b889" fontSize="11">2 par joueur</text>
      </g>)}
    </>}
    {variant==="terrain"&&<>
      <rect x="286" y="42" width="240" height="64" rx="4" fill="#202731" stroke="#ffffff30"/><text x="304" y="67" fill="#e7ddc8" fontSize="13" fontWeight="700">COÛT D’UN PAS</text><text x="304" y="91" fill="#b9dff0" fontSize="14">1 + |hauteur arrivée − départ|</text>
      <rect x="286" y="125" width="240" height="64" rx="4" fill="#202731" stroke="#ffffff30"/><text x="304" y="150" fill="#c8c5bb" fontSize="12">Exemple : niveau 2 → niveau 4</text><text x="304" y="174" fill="#e7ddc8" fontSize="14" fontWeight="700">1 + |4 − 2| = 3 points</text>
      <text x="286" y="226" fill="#c8c5bb" fontSize="11">Chiffres sur le plateau : niveau</text><text x="286" y="247" fill="#c8c5bb" fontSize="11">de chaque case (0 à 5 dans le moteur).</text>
      <text x="24" y="286" fill="#bfc4c5" fontSize="10">Vue de dessus du plateau 10 × 10 · les cases occupées bloquent le trajet.</text>
    </>}
    {variant==="combat"&&<>
      <text x="28" y="50" fill="#d7c799" fontSize="13" fontWeight="700">FORCE D’ATTAQUE</text>
      <rect x="28" y="67" width="235" height="177" rx="5" fill="#252b33" stroke="#ffffff28"/>
      <text x="48" y="98" fill="#eee2c9" fontSize="13">Avant-garde</text><text x="242" y="98" textAnchor="end" fill="#eee2c9" fontSize="13">2</text>
      <text x="48" y="128" fill="#d3c6a9" fontSize="12">Terrain plus haut</text><text x="242" y="128" textAnchor="end" fill="#9ad9f2" fontSize="13">+1</text>
      <text x="48" y="158" fill="#d3c6a9" fontSize="12">Charge · mouvement complet</text><text x="242" y="158" textAnchor="end" fill="#9ad9f2" fontSize="13">+1</text>
      <path d="M48 174H242" stroke="#ffffff30"/><text x="48" y="207" fill="#eee2c9" fontSize="14" fontWeight="700">Attaque totale</text><text x="242" y="207" textAnchor="end" fill="#e4d5b9" fontSize="16" fontWeight="700">4</text>
      <text x="293" y="50" fill="#d7c799" fontSize="13" fontWeight="700">FORCE DE DÉFENSE</text>
      <rect x="293" y="67" width="235" height="177" rx="5" fill="#252b33" stroke="#ffffff28"/>
      <text x="313" y="98" fill="#eee2c9" fontSize="13">Sentinelle</text><text x="507" y="98" textAnchor="end" fill="#eee2c9" fontSize="13">3</text>
      <text x="313" y="128" fill="#d3c6a9" fontSize="12">1 allié adjacent</text><text x="507" y="128" textAnchor="end" fill="#9ad9f2" fontSize="13">+1</text>
      <path d="M313 174H507" stroke="#ffffff30"/><text x="313" y="207" fill="#eee2c9" fontSize="14" fontWeight="700">Défense totale</text><text x="507" y="207" textAnchor="end" fill="#e4d5b9" fontSize="16" fontWeight="700">4</text>
      <text x="280" y="278" textAnchor="middle" fill="#df9a81" fontSize="14" fontWeight="700">4 ≥ 4 : la cible est capturée</text><text x="280" y="302" textAnchor="middle" fill="#c1c4c3" fontSize="11">L’attaque doit aussi être à portée du mouvement restant.</text>
    </>}
    {variant==="score"&&<>
      {piece(8,4,"ivory","vanguard")}<path d={`M${left+4*tile+tile/2} ${top+8*tile+tile/2} V${top+9*tile+tile/2-3}`} stroke="#e9ddc1" strokeWidth="2" strokeDasharray="4 3"/>
      <text x="300" y="48" fill="#d7c799" fontSize="12" fontWeight="700">RANGÉE DE SORTIE</text><text x="300" y="70" fill="#eee2c9" fontSize="12">Blancs : dernière rangée</text><text x="300" y="90" fill="#eee2c9" fontSize="12">Noirs : première rangée</text>
      <rect x="300" y="119" width="220" height="65" rx="4" fill="#252b33" stroke="#ffffff28"/><text x="316" y="145" fill="#d3c6a9" fontSize="12">Avant-garde sortie</text><text x="316" y="168" fill="#e4d5b9" fontSize="14" fontWeight="700">+2 points</text>
      <text x="300" y="218" fill="#c9b889" fontSize="12" fontWeight="700">SENTINELLE</text><text x="300" y="238" fill="#d3d4cf" fontSize="11">Sa première sortie gagne</text><text x="300" y="255" fill="#d3d4cf" fontSize="11">immédiatement.</text>
      <text x="24" y="286" fill="#bfc4c5" fontSize="10">Les deux premières sorties terminent la partie au score, sauf victoire immédiate d’une Sentinelle.</text>
    </>}
  </svg>;
}

function TerrainIllustration({className=""}:{className?:string}){return <div className={`terrain-illustration ${className}`} aria-hidden="true"><div className="terrain-orbit"/><div className="mini-terrain">{Array.from({length:36},(_,index)=>{const row=Math.floor(index/6);const col=index%6;const level=Math.max(0,3-Math.floor((Math.abs(row-2.5)+Math.abs(col-2.5))/1.7));return <i key={index} style={{"--tile-x":`${(col-row)*26}px`,"--tile-y":`${(col+row)*13-level*11}px`,"--level":level} as CSSProperties}/>})}</div><span className="terrain-caption">RELIEF GÉNÉRÉ POUR CHAQUE PARTIE</span></div>}
function ZapIcon(){return <span className="zap-glyph">ϟ</span>}

function GameDecisionDialog({mode,allowDraw,onClose,onAbandon,onProposeDraw,onAnswerDraw}:{mode:"leave"|"draw-offer"|"draw-incoming";allowDraw:boolean;onClose:()=>void;onAbandon:()=>void;onProposeDraw:()=>void;onAnswerDraw:(accept:boolean)=>void}){
  if(mode==="draw-incoming")return <div className="dialog-scrim" role="presentation"><section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="game-dialog-title"><span className="dialog-icon">＝</span><span className="card-kicker">PROPOSITION REÇUE</span><h2 id="game-dialog-title">Votre adversaire propose une égalité</h2><p>La partie se terminera en match nul si vous acceptez.</p><div className="dialog-actions"><button className="outline-button" onClick={()=>void onAnswerDraw(false)}>Refuser</button><button className="primary-button" onClick={()=>void onAnswerDraw(true)}>Accepter l’égalité</button></div></section></div>;
  if(mode==="draw-offer")return <div className="dialog-scrim" role="presentation"><section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="game-dialog-title"><span className="dialog-icon">…</span><span className="card-kicker">PROPOSITION ENVOYÉE</span><h2 id="game-dialog-title">En attente de réponse</h2><p>Votre adversaire doit accepter pour terminer la partie en égalité.</p><div className="dialog-actions"><button className="primary-button" onClick={onClose}>Continuer la partie</button></div></section></div>;
  return <div className="dialog-scrim" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose()}}><section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="game-dialog-title"><button className="dialog-close" onClick={onClose} aria-label="Fermer">×</button><span className="dialog-icon"><Swords size={21}/></span><span className="card-kicker">OPTIONS DE PARTIE</span><h2 id="game-dialog-title">Que souhaites-tu faire ?</h2><p>{allowDraw?"Tu peux mettre fin à la partie par abandon ou proposer une égalité à l’adversaire.":"Cette partie est en attente. Tu peux annuler la recherche ou quitter la table."}</p><div className="dialog-actions dialog-actions-stacked">{allowDraw&&<button className="outline-button" onClick={onProposeDraw}>Proposer une égalité</button>}<button className="danger-button" onClick={onAbandon}>{allowDraw?"Abandonner la partie":"Annuler et quitter"}</button><button className="dialog-cancel" onClick={onClose}>{allowDraw?"Continuer la partie":"Rester ici"}</button></div></section></div>;
}
