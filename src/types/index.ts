export interface Vector2 {
  x: number;
  y: number;
}

export interface PlayerState {
  id: string;
  name: string;
  position: Vector2;
  velocity: Vector2;
  health: number;
  score: number;
}

export interface RoomState {
  id: string;
  name: string;
  players: Map<string, PlayerState>;
  tickCount: number;
  gamePhase: 'waiting' | 'playing' | 'finished';
}

export interface PlayerInput {
  playerId: string;
  tickNumber: number;
  timestamp: number;
  moveDir?: Vector2;
  action?: string;
}

export interface SnapshotData {
  tick: number;
  timestamp: number;
  state: RoomStateData;
}

export interface RoomStateData {
  id: string;
  name: string;
  players: PlayerState[];
  tickCount: number;
  gamePhase: 'waiting' | 'playing' | 'finished';
}

export interface DeltaUpdate {
  tick: number;
  timestamp: number;
  changedPlayers: PlayerState[];
  removedPlayers: string[];
  phaseChanged?: 'waiting' | 'playing' | 'finished';
}

export type MessageType =
  | 'player_join'
  | 'player_leave'
  | 'player_input'
  | 'snapshot'
  | 'delta'
  | 'room_info'
  | 'reconnect_request'
  | 'reconnect_response'
  | 'error';

export interface NetworkMessage {
  type: MessageType;
  payload: any;
}

export interface JoinRoomPayload {
  roomId: string;
  playerId: string;
  playerName: string;
}

export interface InputPayload {
  roomId: string;
  input: PlayerInput;
}

export interface ReconnectPayload {
  roomId: string;
  playerId: string;
  lastKnownTick: number;
}

export interface RoomWorkerMessage {
  type: 'init' | 'player_join' | 'player_leave' | 'player_input' | 'tick' | 'shutdown';
  payload: any;
}

export interface RoomWorkerResponse {
  type: 'snapshot' | 'delta' | 'player_joined' | 'player_left' | 'error';
  roomId: string;
  payload: any;
}

export interface GameConfig {
  tickRate: number;
  maxPlayersPerRoom: number;
  snapshotInterval: number;
  deltaInterval: number;
  inputBufferSize: number;
  reconnectTimeout: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  tickRate: 30,
  maxPlayersPerRoom: 10,
  snapshotInterval: 10,
  deltaInterval: 1,
  inputBufferSize: 3,
  reconnectTimeout: 30000,
};
