import { supabase } from "./supabase";

const apiBaseUrl =
  (import.meta.env.VITE_API_URL as string | undefined) || "http://127.0.0.1:8000";

export class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = supabase.auth
      .refreshSession()
      .then(({ data, error }) => (error ? null : data.session?.access_token ?? null))
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

function fetchApi(path: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${apiBaseUrl.replace(/\/$/, "")}/api${path}`, { ...init, headers });
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("Session expirée. Reconnecte-toi pour continuer.");

  let response = await fetchApi(path, init, accessToken);
  if (response.status === 401) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) response = await fetchApi(path, init, refreshedToken);
  }
  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : `Erreur HTTP ${response.status}`;
    throw new ApiRequestError(detail, response.status);
  }
  return body as T;
}

export type GameMode = "online" | "local";
export type LifecycleStatus = "waiting" | "ongoing" | "finished" | "abandoned";
export type PlayerColor = "WHITE" | "BLACK";

export interface GameSummary {
  game_id: string;
  mode: GameMode;
  visibility: "public" | "private";
  my_color: PlayerColor;
  lifecycle_status: LifecycleStatus;
  current_player: PlayerColor | null;
  turn_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  opponent_username: string | null;
  result: "win" | "loss" | "draw" | null;
}

export interface GameReplayAction {
  action_number: number;
  actor_id: string | null;
  action_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  state_after: GameState | null;
}

export interface GameReplay {
  game_id: string;
  mode: GameMode;
  visibility: "public" | "private";
  lifecycle_status: LifecycleStatus;
  initial_state: GameState;
  actions: GameReplayAction[];
}

export interface GameState extends GameSummary {
  board_size: number;
  has_moved_this_turn: boolean;
  moved_piece_id: string | null;
  movement_spent: Record<string, number>;
  turn_start_positions: Record<string, { row: number; col: number }>;
  visited_positions: Record<string, { row: number; col: number }[]>;
  heights: number[][];
  pieces: Piece[];
  scores: Record<string, number>;
  exited_pieces: number;
  first_exit_piece_id: string | null;
  status: "ONGOING" | "WHITE_WINS" | "BLACK_WINS" | "DRAW";
  winner: PlayerColor | null;
}

export interface Piece {
  id: string;
  owner: PlayerColor;
  piece_type: "EXPLORER" | "VANGUARD" | "SENTINEL";
  force: number;
  movement_points: number;
  position: { row: number; col: number } | null;
  captured: boolean;
  finished: boolean;
}

export interface FriendRelation {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: "pending" | "accepted" | "rejected" | "blocked";
  other_username: string | null;
}

export interface UserProfile {
  id: string;
  username: string;
  avatar_url: string | null;
}

export interface GameInvitation {
  id: string;
  game_id: string;
  inviter_id: string;
  inviter_username: string | null;
  invitee_id: string;
  color: "white" | "black";
  status: "pending" | "accepted" | "rejected" | "cancelled";
  source_game_id?: string | null;
}

export interface GameRematchStatus {
  opponent_id: string;
  opponent_available: boolean;
  outgoing_invitation: GameInvitation | null;
}

export interface GameConnectionStatus {
  opponent_id: string;
  status: "connected" | "reconnecting" | "forfeited";
  seconds_until_forfeit: number;
}

export interface GameDrawOffer {
  id: string;
  game_id: string;
  proposer_id: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
}

export interface MovePath {
  start: { row: number; col: number };
  destination: { row: number; col: number };
  path: { row: number; col: number }[];
  cost: number;
  special: string | null;
}

export interface AttackResponse {
  game: GameState;
  success: boolean;
  attack_force: number;
  defense_force: number;
}
