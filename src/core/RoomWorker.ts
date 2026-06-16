import { parentPort, workerData } from 'worker_threads';
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

class RoomWorker {
  private roomId: string;
  private roomName: string;
  private config: GameConfig;
  private tickCount: number = 0;
  private gamePhase: 'waiting' | 'playing' | 'finished' = 'waiting';
  private players: Map<string, PlayerState> = new Map();

  private inputBuffer: Map<string, BufferedInput[]> = new Map();
  private pendingInputs: PlayerInput[] = [];

  private snapshots: SnapshotData[] = [];
  private lastSnapshotTick: number = 0;
  private lastDeltaTick: number = 0;

  private tickInterval: NodeJS.Timeout | null = null;
  private tickDuration: number;
  private isRunning: boolean = false;

  private lastFrameTime: number = 0;
  private tickTimeBudget: number;
  private slowTickWarningCount: number = 0;

  constructor(roomId: string, roomName: string, config?: Partial<GameConfig>) {
    this.roomId = roomId;
    this.roomName = roomName;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tickDuration = 1000 / this.config.tickRate;
    this.tickTimeBudget = this.tickDuration * 0.8;
  }

  start(): void {
    this.isRunning = true;
    this.lastFrameTime = Date.now();
    this.tickInterval = setInterval(() => this.tick(), this.tickDuration);
    console.log(`[RoomWorker ${this.roomId}] Started with ${this.config.tickRate} ticks/sec`);
  }

  stop(): void {
    this.isRunning = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log(`[RoomWorker ${this.roomId}] Stopped`);
  }

  addPlayer(playerId: string, playerName: string): PlayerState {
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

    if (this.players.size >= 1 && this.gamePhase === 'waiting') {
      this.startGame();
    }

    this.sendToParent('player_joined', { player, tickCount: this.tickCount });
    this.broadcastDelta();
    return player;
  }

  removePlayer(playerId: string): void {
    this.players.delete(playerId);
    this.inputBuffer.delete(playerId);

    if (this.players.size === 0) {
      this.gamePhase = 'waiting';
    }

    this.sendToParent('player_left', { playerId, tickCount: this.tickCount });
    this.broadcastDelta();
  }

  queueInput(playerId: string, input: PlayerInput): void {
    if (!this.players.has(playerId)) return;

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

  private tick(): void {
    if (!this.isRunning) return;

    const startTime = Date.now();
    const frameTime = startTime - this.lastFrameTime;
    this.lastFrameTime = startTime;

    try {
      this.processInputs();
      this.updateGameLogic(frameTime);
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
            `[RoomWorker ${this.roomId}] Slow tick detected! Tick ${this.tickCount} took ${elapsed}ms (budget: ${this.tickTimeBudget}ms)`
          );
          this.slowTickWarningCount = 0;
        }
      }
    } catch (error) {
      console.error(`[RoomWorker ${this.roomId}] Tick error:`, error);
    }
  }

  private processInputs(): void {
    this.pendingInputs = [];

    for (const [playerId, buffer] of this.inputBuffer) {
      if (buffer.length > 0) {
        const buffered = buffer.shift()!;
        this.pendingInputs.push(buffered.input);
      }
    }
  }

  private updateGameLogic(deltaTime: number): void {
    if (this.gamePhase !== 'playing') return;

    const speed = 0.1;

    for (const input of this.pendingInputs) {
      const player = this.players.get(input.playerId);
      if (!player) continue;

      if (input.moveDir) {
        const length = Math.sqrt(input.moveDir.x ** 2 + input.moveDir.y ** 2);
        if (length > 0) {
          const normalized = {
            x: input.moveDir.x / length,
            y: input.moveDir.y / length,
          };
          player.velocity.x = normalized.x * speed * deltaTime;
          player.velocity.y = normalized.y * speed * deltaTime;
        }
      }

      if (input.action === 'jump') {
        player.score += 1;
      }
    }

    for (const player of this.players.values()) {
      player.position.x += player.velocity.x;
      player.position.y += player.velocity.y;

      player.velocity.x *= 0.9;
      player.velocity.y *= 0.9;

      player.position.x = Math.max(-100, Math.min(100, player.position.x));
      player.position.y = Math.max(-100, Math.min(100, player.position.y));
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
      state: this.getRoomStateData(),
    };

    this.snapshots.push(snapshot);
    this.lastSnapshotTick = this.tickCount;

    if (this.snapshots.length > 60) {
      this.snapshots.shift();
    }

    this.sendToParent('snapshot', snapshot);
  }

  private broadcastDelta(): void {
    const prevTick = this.lastDeltaTick;
    this.lastDeltaTick = this.tickCount;

    const changedPlayers: PlayerState[] = [];

    for (const player of this.players.values()) {
      changedPlayers.push({ ...player });
    }

    const delta: DeltaUpdate = {
      tick: this.tickCount,
      timestamp: Date.now(),
      changedPlayers,
      removedPlayers: [],
    };

    if (prevTick === 0) {
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
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  getCurrentState(): RoomStateData {
    return this.getRoomStateData();
  }

  private getRoomStateData(): RoomStateData {
    const players: PlayerState[] = [];
    for (const player of this.players.values()) {
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

    switch (type) {
      case 'init':
        roomWorker = new RoomWorker(payload.roomId, payload.roomName, payload.config);
        roomWorker.start();
        break;

      case 'player_join':
        roomWorker?.addPlayer(payload.playerId, payload.playerName);
        break;

      case 'player_leave':
        roomWorker?.removePlayer(payload.playerId);
        break;

      case 'player_input':
        roomWorker?.queueInput(payload.playerId, payload.input);
        break;

      case 'get_snapshot':
        const snapshot = roomWorker?.getLatestSnapshot();
        if (parentPort) {
          parentPort.postMessage({
            type: 'snapshot_response',
            roomId: roomWorker ? (roomWorker as any).roomId : '',
            payload: { snapshot, requestId: payload.requestId },
          });
        }
        break;

      case 'shutdown':
        roomWorker?.stop();
        process.exit(0);
        break;

      default:
        console.warn('[RoomWorker] Unknown message type:', type);
    }
  });
}

export { RoomWorker };
