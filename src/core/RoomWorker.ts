import { parentPort, workerData } from 'worker_threads';
import * as path from 'path';
import {
  PlayerState,
  RoomStateData,
  PlayerInput,
  SnapshotData,
  DeltaUpdate,
  GameConfig,
  DEFAULT_CONFIG,
  Vector2,
} from '../types';

interface BufferedInput {
  input: PlayerInput;
  receivedAt: number;
}

interface GameLogicModule {
  updatePlayerPhysics: (
    player: PlayerState,
    input: PlayerInput | undefined,
    deltaTime: number
  ) => void;
  processPlayerAction: (
    player: PlayerState,
    action: string,
    params?: any
  ) => void;
}

function loadGameLogic(): GameLogicModule {
  const gameLogicPath = path.resolve(__dirname, '../game/GameLogic.js');
  try {
    delete require.cache[require.resolve(gameLogicPath)];
    const module = require(gameLogicPath);
    console.log(`[RoomWorker] GameLogic loaded successfully`);
    return module;
  } catch (error) {
    console.error('[RoomWorker] Failed to load GameLogic, using fallback:', (error as Error).message);
    return {
      updatePlayerPhysics: (player, input, deltaTime) => {
        const speed = 0.1;
        if (input?.moveDir) {
          const length = Math.sqrt(input.moveDir.x ** 2 + input.moveDir.y ** 2);
          if (length > 0) {
            player.velocity.x = (input.moveDir.x / length) * speed * deltaTime;
            player.velocity.y = (input.moveDir.y / length) * speed * deltaTime;
          }
        }
        if (input?.action === 'jump') player.score += 1;
        player.position.x += player.velocity.x;
        player.position.y += player.velocity.y;
        player.velocity.x *= 0.9;
        player.velocity.y *= 0.9;
        player.position.x = Math.max(-100, Math.min(100, player.position.x));
        player.position.y = Math.max(-100, Math.min(100, player.position.y));
      },
      processPlayerAction: () => {},
    };
  }
}

class RoomWorker {
  private roomId: string;
  private roomName: string;
  private config: GameConfig;
  private tickCount: number = 0;
  private gamePhase: 'waiting' | 'playing' | 'finished' = 'waiting';
  private players: Map<string, PlayerState> = new Map();
  private offlinePlayers: Set<string> = new Set();

  private inputBuffer: Map<string, BufferedInput[]> = new Map();
  private pendingInputs: PlayerInput[] = [];

  private snapshots: SnapshotData[] = [];
  private lastSnapshotTick: number = 0;
  private lastDeltaTick: number = 0;
  private lastRemovedPlayers: string[] = [];

  private tickInterval: NodeJS.Timeout | null = null;
  private fixedDeltaTime: number;
  private isRunning: boolean = false;

  private tickTimeBudget: number;
  private slowTickWarningCount: number = 0;

  private gameLogic: GameLogicModule;
  private gameLogicVersion: number = 0;

  constructor(roomId: string, roomName: string, config?: Partial<GameConfig>) {
    this.roomId = roomId;
    this.roomName = roomName;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fixedDeltaTime = 1000 / this.config.tickRate;
    this.tickTimeBudget = this.fixedDeltaTime * 0.8;
    this.gameLogic = loadGameLogic();
  }

  start(): void {
    this.isRunning = true;
    this.tickInterval = setInterval(() => this.tick(), this.fixedDeltaTime);
    console.log(`[RoomWorker ${this.roomId}] Started with ${this.config.tickRate} ticks/sec, fixed delta=${this.fixedDeltaTime.toFixed(2)}ms`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log(`[RoomWorker ${this.roomId}] Stopped`);
  }

  addPlayer(playerId: string, playerName: string): PlayerState | null {
    if (this.players.has(playerId)) {
      if (this.offlinePlayers.has(playerId)) {
        return this.reconnectPlayer(playerId);
      }
      console.warn(`[RoomWorker ${this.roomId}] Player ${playerId} already exists and online`);
      return this.players.get(playerId)!;
    }

    const player: PlayerState = {
      id: playerId,
      name: playerName,
      position: { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 },
      velocity: { x: 0, y: 0 },
      health: 100,
      score: 0,
    };
    this.players.set(playerId, player);
    this.inputBuffer.set(playerId, []);
    this.offlinePlayers.delete(playerId);

    if (this.players.size >= 1 && this.gamePhase === 'waiting') {
      this.startGame();
    }

    this.sendToParent('player_joined', { player, tickCount: this.tickCount });
    this.broadcastDeltaWithPlayer(playerId);
    return player;
  }

  reconnectPlayer(playerId: string): PlayerState | null {
    const player = this.players.get(playerId);
    if (!player) {
      console.warn(`[RoomWorker ${this.roomId}] Cannot reconnect: player ${playerId} not found`);
      return null;
    }

    this.offlinePlayers.delete(playerId);
    this.inputBuffer.set(playerId, []);

    console.log(`[RoomWorker ${this.roomId}] Player ${playerId} reconnected at tick ${this.tickCount}`);

    this.sendToParent('player_reconnected', {
      player,
      tickCount: this.tickCount,
    });

    this.broadcastDeltaWithPlayer(playerId);
    return player;
  }

  markPlayerOffline(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.offlinePlayers.add(playerId);
    this.lastRemovedPlayers.push(playerId);

    console.log(`[RoomWorker ${this.roomId}] Player ${playerId} marked offline at tick ${this.tickCount}`);

    this.sendToParent('player_offline', { playerId, tickCount: this.tickCount });
    this.broadcastDeltaImmediate();
  }

  removePlayer(playerId: string): void {
    const existed = this.players.has(playerId);
    this.players.delete(playerId);
    this.inputBuffer.delete(playerId);
    this.offlinePlayers.delete(playerId);

    if (existed) {
      this.lastRemovedPlayers.push(playerId);
    }

    if (this.players.size === 0) {
      this.gamePhase = 'waiting';
    }

    console.log(`[RoomWorker ${this.roomId}] Player ${playerId} permanently removed at tick ${this.tickCount}`);

    this.sendToParent('player_left', { playerId, tickCount: this.tickCount });
    this.broadcastDeltaImmediate();
  }

  queueInput(playerId: string, input: PlayerInput): void {
    if (!this.players.has(playerId)) return;
    if (this.offlinePlayers.has(playerId)) return;

    const buffered: BufferedInput = {
      input,
      receivedAt: Date.now(),
    };

    let buffer = this.inputBuffer.get(playerId);
    if (!buffer) {
      buffer = [];
      this.inputBuffer.set(playerId, buffer);
    }

    buffer.push(buffered);

    if (buffer.length > this.config.inputBufferSize) {
      buffer.shift();
    }
  }

  reloadGameLogic(): { success: boolean; error?: string; version: number } {
    try {
      this.gameLogic = loadGameLogic();
      this.gameLogicVersion++;
      console.log(`[RoomWorker ${this.roomId}] GameLogic reloaded, version=${this.gameLogicVersion}`);
      return { success: true, version: this.gameLogicVersion };
    } catch (error) {
      const msg = (error as Error).message;
      console.error(`[RoomWorker ${this.roomId}] GameLogic reload failed: ${msg}`);
      return { success: false, error: msg, version: this.gameLogicVersion };
    }
  }

  private tick(): void {
    if (!this.isRunning) return;

    const startTime = Date.now();

    try {
      this.processInputs();
      this.updateGameLogic(this.fixedDeltaTime);
      this.tickCount++;

      if (this.tickCount % this.config.deltaInterval === 0) {
        this.broadcastDelta();
      }

      if (this.tickCount % this.config.snapshotInterval === 0) {
        this.takeSnapshot();
      }

      const elapsed = Date.now() - startTime;

      if (elapsed > this.tickTimeBudget) {
        this.slowTickWarningCount++;
        if (this.slowTickWarningCount >= 5) {
          console.warn(
            `[RoomWorker ${this.roomId}] Slow tick! Tick ${this.tickCount} took ${elapsed}ms (budget: ${this.tickTimeBudget.toFixed(1)}ms). Slow room only affects itself.`
          );
          this.slowTickWarningCount = 0;
        }
      }
    } catch (error) {
      console.error(`[RoomWorker ${this.roomId}] Tick error (caught, room continues):`, error);
    }
  }

  private processInputs(): void {
    this.pendingInputs = [];

    for (const [playerId, buffer] of this.inputBuffer) {
      if (this.offlinePlayers.has(playerId)) continue;

      if (buffer.length > 0) {
        const buffered = buffer.shift()!;
        this.pendingInputs.push(buffered.input);
      }
    }
  }

  private updateGameLogic(deltaTime: number): void {
    if (this.gamePhase !== 'playing') return;

    for (const input of this.pendingInputs) {
      const player = this.players.get(input.playerId);
      if (!player || this.offlinePlayers.has(player.id)) continue;

      try {
        this.gameLogic.updatePlayerPhysics(player, input, deltaTime);
        if (input.action && input.action !== 'jump') {
          this.gameLogic.processPlayerAction(player, input.action);
        }
      } catch (error) {
        console.error(`[RoomWorker ${this.roomId}] GameLogic error for player ${input.playerId}:`, error);
      }
    }

    for (const player of this.players.values()) {
      if (this.offlinePlayers.has(player.id)) continue;

      try {
        this.gameLogic.updatePlayerPhysics(player, undefined, deltaTime);
      } catch (error) {
        // swallow per-player errors to not block the whole tick
      }
    }
  }

  private startGame(): void {
    this.gamePhase = 'playing';
    console.log(`[RoomWorker ${this.roomId}] Game started!`);
  }

  private takeSnapshot(): void {
    const snapshot: SnapshotData = {
      tick: this.tickCount,
      timestamp: Date.now(),
      state: this.getRoomStateData(true),
    };

    this.snapshots.push(snapshot);
    this.lastSnapshotTick = this.tickCount;

    if (this.snapshots.length > 120) {
      this.snapshots.shift();
    }

    this.sendToParent('snapshot', snapshot);
  }

  private broadcastDeltaImmediate(): void {
    this.broadcastDelta(true);
  }

  private broadcastDeltaWithPlayer(changedPlayerId: string): void {
    this.broadcastDelta(true);
  }

  private broadcastDelta(immediate: boolean = false): void {
    const prevTick = this.lastDeltaTick;
    this.lastDeltaTick = this.tickCount;

    const changedPlayers: PlayerState[] = [];

    for (const [id, player] of this.players) {
      if (this.offlinePlayers.has(id)) continue;
      changedPlayers.push({ ...player });
    }

    const removedPlayers = [...this.lastRemovedPlayers];
    this.lastRemovedPlayers = [];

    const delta: DeltaUpdate = {
      tick: this.tickCount,
      timestamp: Date.now(),
      changedPlayers,
      removedPlayers,
    };

    if (prevTick === 0 || immediate) {
      delta.phaseChanged = this.gamePhase;
    }

    this.sendToParent('delta', delta);
  }

  getSnapshotAtTick(tick: number): SnapshotData | null {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].tick <= tick) {
        return this.snapshots[i];
      }
    }
    return this.snapshots[0] || null;
  }

  getLatestSnapshot(): SnapshotData | null {
    if (this.snapshots.length > 0) {
      return this.snapshots[this.snapshots.length - 1];
    }
    return {
      tick: this.tickCount,
      timestamp: Date.now(),
      state: this.getRoomStateData(true),
    };
  }

  getCurrentState(): RoomStateData {
    return this.getRoomStateData(true);
  }

  getPlayerState(playerId: string): PlayerState | null {
    return this.players.get(playerId) || null;
  }

  getOnlinePlayerCount(): number {
    let count = 0;
    for (const id of this.players.keys()) {
      if (!this.offlinePlayers.has(id)) count++;
    }
    return count;
  }

  private getRoomStateData(includeAll: boolean = false): RoomStateData {
    const players: PlayerState[] = [];
    for (const [id, player] of this.players) {
      if (!includeAll && this.offlinePlayers.has(id)) continue;
      players.push({ ...player });
    }

    return {
      id: this.roomId,
      name: this.roomName,
      players,
      tickCount: this.tickCount,
      gamePhase: this.gamePhase,
    };
  }

  private sendToParent(type: string, payload: any): void {
    if (parentPort) {
      parentPort.postMessage({
        type,
        roomId: this.roomId,
        payload,
      });
    }
  }
}

let roomWorker: RoomWorker | null = null;

if (parentPort) {
  parentPort.on('message', (message) => {
    const { type, payload } = message;

    try {
      switch (type) {
        case 'init':
          roomWorker = new RoomWorker(payload.roomId, payload.roomName, payload.config);
          roomWorker.start();
          break;

        case 'player_join':
          roomWorker?.addPlayer(payload.playerId, payload.playerName);
          break;

        case 'player_reconnect':
          roomWorker?.reconnectPlayer(payload.playerId);
          break;

        case 'player_offline':
          roomWorker?.markPlayerOffline(payload.playerId);
          break;

        case 'player_leave':
          roomWorker?.removePlayer(payload.playerId);
          break;

        case 'player_input':
          roomWorker?.queueInput(payload.playerId, payload.input);
          break;

        case 'get_snapshot': {
          const snapshot = roomWorker?.getLatestSnapshot();
          if (parentPort) {
            parentPort.postMessage({
              type: 'snapshot_response',
              roomId: roomWorker ? (roomWorker as any).roomId : '',
              payload: { snapshot, requestId: payload.requestId },
            });
          }
          break;
        }

        case 'get_player_count': {
          const count = roomWorker?.getOnlinePlayerCount() || 0;
          if (parentPort) {
            parentPort.postMessage({
              type: 'player_count_response',
              roomId: roomWorker ? (roomWorker as any).roomId : '',
              payload: { count, requestId: payload.requestId },
            });
          }
          break;
        }

        case 'hot_reload': {
          const result = roomWorker?.reloadGameLogic() || { success: false, error: 'worker_not_ready', version: 0 };
          if (parentPort) {
            parentPort.postMessage({
              type: 'hot_reload_response',
              roomId: roomWorker ? (roomWorker as any).roomId : '',
              payload: { ...result, requestId: payload.requestId },
            });
          }
          break;
        }

        case 'shutdown':
          roomWorker?.stop();
          process.exit(0);
          break;

        default:
          console.warn('[RoomWorker] Unknown message type:', type);
      }
    } catch (error) {
      console.error('[RoomWorker] Error handling message:', error);
      if (parentPort) {
        parentPort.postMessage({
          type: 'worker_error',
          roomId: roomWorker ? (roomWorker as any).roomId : '',
          payload: { error: (error as Error).message, messageType: type },
        });
      }
    }
  });
}

export { RoomWorker };
