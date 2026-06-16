import { SnapshotData, DeltaUpdate, RoomStateData } from '../types';
import { RoomManager } from '../core/RoomManager';
import { ConnectionManager } from '../network/ConnectionManager';

interface ReconnectSession {
  playerId: string;
  roomId: string;
  lastKnownTick: number;
  reconnectTime: number;
  state: 'requested' | 'syncing' | 'completed';
}

export class ReconnectManager {
  private roomManager: RoomManager;
  private connectionManager: ConnectionManager;
  private activeSessions: Map<string, ReconnectSession> = new Map();
  private maxTickGapForDelta: number = 60;
  private reconnectTimeout: number = 30000;

  constructor(
    roomManager: RoomManager,
    connectionManager: ConnectionManager,
    options?: {
      maxTickGapForDelta?: number;
      reconnectTimeout?: number;
    }
  ) {
    this.roomManager = roomManager;
    this.connectionManager = connectionManager;

    if (options?.maxTickGapForDelta) {
      this.maxTickGapForDelta = options.maxTickGapForDelta;
    }
    if (options?.reconnectTimeout) {
      this.reconnectTimeout = options.reconnectTimeout;
    }
  }

  async handleReconnect(
    playerId: string,
    roomId: string,
    lastKnownTick: number
  ): Promise<void> {
    const session: ReconnectSession = {
      playerId,
      roomId,
      lastKnownTick,
      reconnectTime: Date.now(),
      state: 'requested',
    };

    this.activeSessions.set(playerId, session);

    try {
      const { snapshot, currentTick } = await this.roomManager.getSnapshotForReconnect(
        roomId,
        playerId,
        lastKnownTick
      );

      if (!snapshot) {
        this.sendReconnectResponse(playerId, {
          success: false,
          reason: 'no_snapshot_available',
          currentTick: 0,
        });
        return;
      }

      session.state = 'syncing';

      const tickGap = currentTick - lastKnownTick;

      if (tickGap <= this.maxTickGapForDelta && lastKnownTick > 0) {
        this.sendDeltaSync(playerId, snapshot, lastKnownTick);
      } else {
        this.sendFullSync(playerId, snapshot);
      }

      this.roomManager.reconnectRoom(playerId, roomId);

      session.state = 'completed';

      console.log(
        `[ReconnectManager] Player ${playerId} reconnected to room ${roomId}, tick gap: ${tickGap}`
      );
    } catch (error) {
      console.error('[ReconnectManager] Reconnect failed:', error);
      this.sendReconnectResponse(playerId, {
        success: false,
        reason: 'internal_error',
        currentTick: 0,
      });
    } finally {
      setTimeout(() => {
        this.activeSessions.delete(playerId);
      }, this.reconnectTimeout);
    }
  }

  private sendFullSync(playerId: string, snapshot: SnapshotData): void {
    this.connectionManager.sendToPlayer(playerId, {
      type: 'reconnect_response',
      payload: {
        success: true,
        syncType: 'full',
        tick: snapshot.tick,
        timestamp: snapshot.timestamp,
        state: snapshot.state,
      },
    });

    console.log(
      `[ReconnectManager] Full sync sent to player ${playerId} at tick ${snapshot.tick}`
    );
  }

  private sendDeltaSync(
    playerId: string,
    latestSnapshot: SnapshotData,
    lastKnownTick: number
  ): void {
    this.connectionManager.sendToPlayer(playerId, {
      type: 'reconnect_response',
      payload: {
        success: true,
        syncType: 'delta',
        tick: latestSnapshot.tick,
        timestamp: latestSnapshot.timestamp,
        state: latestSnapshot.state,
        lastKnownTick,
      },
    });

    console.log(
      `[ReconnectManager] Delta sync sent to player ${playerId}: ${lastKnownTick} -> ${latestSnapshot.tick}`
    );
  }

  private sendReconnectResponse(playerId: string, payload: any): void {
    this.connectionManager.sendToPlayer(playerId, {
      type: 'reconnect_response',
      payload,
    });
  }

  getActiveSession(playerId: string): ReconnectSession | undefined {
    return this.activeSessions.get(playerId);
  }

  isReconnecting(playerId: string): boolean {
    const session = this.activeSessions.get(playerId);
    return session?.state === 'syncing';
  }

  cleanup(): void {
    const now = Date.now();
    for (const [playerId, session] of this.activeSessions) {
      if (now - session.reconnectTime > this.reconnectTimeout) {
        this.activeSessions.delete(playerId);
      }
    }
  }
}
