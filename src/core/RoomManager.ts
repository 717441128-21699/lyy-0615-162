import { Worker } from 'worker_threads';
import * as path from 'path';
import {
  GameConfig,
  DEFAULT_CONFIG,
  SnapshotData,
  DeltaUpdate,
  PlayerInput,
  RoomStateData,
} from '../types';
import { ConnectionManager } from '../network/ConnectionManager';

interface RoomInfo {
  id: string;
  name: string;
  worker: Worker;
  playerCount: number;
  config: GameConfig;
  latestSnapshot: SnapshotData | null;
  latestDelta: DeltaUpdate | null;
  pendingSnapshotRequests: Map<string, (snapshot: SnapshotData | null) => void>;
  pendingHotReloadRequests: Map<string, (result: any) => void>;
  gameLogicVersion: number;
}

export interface HotReloadResult {
  success: boolean;
  totalRooms: number;
  succeeded: number;
  failed: number;
  roomResults: Array<{
    roomId: string;
    roomName: string;
    success: boolean;
    version?: number;
    error?: string;
  }>;
}

export class RoomManager {
  private rooms: Map<string, RoomInfo> = new Map();
  private connectionManager: ConnectionManager;
  private config: GameConfig;

  constructor(connectionManager: ConnectionManager, config?: Partial<GameConfig>) {
    this.connectionManager = connectionManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  createRoom(roomId: string, roomName: string, customConfig?: Partial<GameConfig>): RoomInfo {
    const roomConfig = { ...this.config, ...customConfig };

    const workerPath = path.resolve(__dirname, 'RoomWorker.js');
    const worker = new Worker(workerPath, {
      workerData: { roomId, roomName, config: roomConfig },
    });

    const roomInfo: RoomInfo = {
      id: roomId,
      name: roomName,
      worker,
      playerCount: 0,
      config: roomConfig,
      latestSnapshot: null,
      latestDelta: null,
      pendingSnapshotRequests: new Map(),
      pendingHotReloadRequests: new Map(),
      gameLogicVersion: 0,
    };

    this.rooms.set(roomId, roomInfo);

    worker.on('message', (message) => {
      this.handleWorkerMessage(roomId, message);
    });

    worker.on('error', (error) => {
      console.error(`[RoomManager] Worker error for room ${roomId}:`, error);
    });

    worker.on('exit', (code) => {
      console.log(`[RoomManager] Worker for room ${roomId} exited with code ${code}`);
      this.rooms.delete(roomId);
    });

    worker.postMessage({
      type: 'init',
      payload: { roomId, roomName, config: roomConfig },
    });

    console.log(`[RoomManager] Room created: ${roomId}`);
    return roomInfo;
  }

  getOrCreateRoom(roomId: string, roomName?: string): RoomInfo {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.createRoom(roomId, roomName || `Room_${roomId.slice(0, 8)}`);
    }
    return room;
  }

  joinRoom(playerId: string, playerName: string, roomId: string): void {
    const room = this.getOrCreateRoom(roomId);
    room.worker.postMessage({
      type: 'player_join',
      payload: { playerId, playerName },
    });
  }

  reconnectRoom(playerId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      console.warn(`[RoomManager] Cannot reconnect player ${playerId}: room ${roomId} not found`);
      return;
    }
    room.worker.postMessage({
      type: 'player_reconnect',
      payload: { playerId },
    });
  }

  markPlayerOffline(playerId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.worker.postMessage({
      type: 'player_offline',
      payload: { playerId },
    });
  }

  leaveRoom(playerId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.worker.postMessage({
        type: 'player_leave',
        payload: { playerId },
      });
    }
  }

  sendInput(playerId: string, roomId: string, input: PlayerInput): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.worker.postMessage({
        type: 'player_input',
        payload: { playerId, input },
      });
    }
  }

  private handleWorkerMessage(roomId: string, message: any): void {
    const { type, payload } = message;
    const room = this.rooms.get(roomId);
    if (!room) return;

    switch (type) {
      case 'snapshot':
        room.latestSnapshot = payload as SnapshotData;
        room.playerCount = payload.state.players.length;
        this.broadcastSnapshot(roomId, payload);
        break;

      case 'delta':
        room.latestDelta = payload as DeltaUpdate;
        this.broadcastDelta(roomId, payload);
        if (room.latestSnapshot) {
          room.playerCount = room.latestSnapshot.state.players.filter(
            (p: any) => !payload.removedPlayers.includes(p.id)
          ).length;
        }
        break;

      case 'player_joined':
        console.log(`[RoomManager] Player joined room ${roomId}:`, payload.player.id);
        room.playerCount++;
        break;

      case 'player_reconnected':
        console.log(`[RoomManager] Player reconnected to room ${roomId}:`, payload.player.id);
        break;

      case 'player_offline':
        console.log(`[RoomManager] Player marked offline in room ${roomId}:`, payload.playerId);
        room.playerCount = Math.max(0, room.playerCount - 1);
        break;

      case 'player_left':
        console.log(`[RoomManager] Player permanently left room ${roomId}:`, payload.playerId);
        room.playerCount = Math.max(0, room.playerCount - 1);
        break;

      case 'snapshot_response': {
        const requestId = payload.requestId;
        const callback = room.pendingSnapshotRequests.get(requestId);
        if (callback) {
          callback(payload.snapshot);
          room.pendingSnapshotRequests.delete(requestId);
        }
        break;
      }

      case 'hot_reload_response': {
        const requestId = payload.requestId;
        if (payload.success) {
          room.gameLogicVersion = payload.version;
        }
        const callback = room.pendingHotReloadRequests.get(requestId);
        if (callback) {
          callback({
            roomId,
            roomName: room.name,
            success: payload.success,
            version: payload.version,
            error: payload.error,
          });
          room.pendingHotReloadRequests.delete(requestId);
        }
        break;
      }

      case 'worker_error':
        console.error(
          `[RoomManager] Worker error in room ${roomId} while handling ${payload.messageType}:`,
          payload.error
        );
        break;

      default:
        console.warn(`[RoomManager] Unknown worker message type: ${type}`);
    }
  }

  private broadcastSnapshot(roomId: string, snapshot: SnapshotData): void {
    this.connectionManager.broadcastToRoom(roomId, {
      type: 'snapshot',
      payload: snapshot,
    });
  }

  private broadcastDelta(roomId: string, delta: DeltaUpdate): void {
    this.connectionManager.broadcastToRoom(roomId, {
      type: 'delta',
      payload: delta,
    });
  }

  async getSnapshotForReconnect(
    roomId: string,
    playerId: string,
    lastKnownTick: number
  ): Promise<{ snapshot: SnapshotData | null; currentTick: number }> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { snapshot: null, currentTick: 0 };
    }

    if (room.latestSnapshot) {
      return {
        snapshot: room.latestSnapshot,
        currentTick: room.latestSnapshot.tick,
      };
    }

    return new Promise((resolve) => {
      const requestId = `${playerId}_${Date.now()}`;
      room.pendingSnapshotRequests.set(requestId, (snapshot) => {
        resolve({
          snapshot,
          currentTick: snapshot?.tick || 0,
        });
      });

      room.worker.postMessage({
        type: 'get_snapshot',
        payload: { requestId },
      });

      setTimeout(() => {
        if (room.pendingSnapshotRequests.has(requestId)) {
          room.pendingSnapshotRequests.delete(requestId);
          resolve({ snapshot: null, currentTick: 0 });
        }
      }, 2000);
    });
  }

  async hotReloadAllRooms(timeoutMs: number = 5000): Promise<HotReloadResult> {
    const rooms = Array.from(this.rooms.values());
    const totalRooms = rooms.length;

    if (totalRooms === 0) {
      return {
        success: true,
        totalRooms: 0,
        succeeded: 0,
        failed: 0,
        roomResults: [],
      };
    }

    const results: any[] = [];
    const promises = rooms.map(
      (room) =>
        new Promise<any>((resolve) => {
          const requestId = `hr_${room.id}_${Date.now()}`;

          const timer = setTimeout(() => {
            if (room.pendingHotReloadRequests.has(requestId)) {
              room.pendingHotReloadRequests.delete(requestId);
              resolve({
                roomId: room.id,
                roomName: room.name,
                success: false,
                error: 'timeout',
              });
            }
          }, timeoutMs);

          room.pendingHotReloadRequests.set(requestId, (result) => {
            clearTimeout(timer);
            resolve(result);
          });

          try {
            room.worker.postMessage({
              type: 'hot_reload',
              payload: { requestId },
            });
          } catch (error) {
            clearTimeout(timer);
            room.pendingHotReloadRequests.delete(requestId);
            resolve({
              roomId: room.id,
              roomName: room.name,
              success: false,
              error: (error as Error).message,
            });
          }
        })
    );

    const roomResults = await Promise.all(promises);
    const succeeded = roomResults.filter((r) => r.success).length;
    const failed = roomResults.length - succeeded;

    return {
      success: failed === 0,
      totalRooms,
      succeeded,
      failed,
      roomResults,
    };
  }

  getRoomState(roomId: string): RoomStateData | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.latestSnapshot) return null;
    return room.latestSnapshot.state;
  }

  getRoomList(): { id: string; name: string; playerCount: number; gameLogicVersion: number }[] {
    const result: { id: string; name: string; playerCount: number; gameLogicVersion: number }[] = [];
    for (const room of this.rooms.values()) {
      result.push({
        id: room.id,
        name: room.name,
        playerCount: room.playerCount,
        gameLogicVersion: room.gameLogicVersion,
      });
    }
    return result;
  }

  shutdownRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.worker.postMessage({ type: 'shutdown' });
    }
  }

  shutdownAll(): void {
    for (const roomId of this.rooms.keys()) {
      this.shutdownRoom(roomId);
    }
  }

  getRoomCount(): number {
    return this.rooms.size;
  }
}
