import { RoomManager, ReconnectStateResult } from '../core/RoomManager';
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
  private reconnectTimeout: number = 30000;

  constructor(
    roomManager: RoomManager,
    connectionManager: ConnectionManager,
    options?: {
      reconnectTimeout?: number;
    }
  ) {
    this.roomManager = roomManager;
    this.connectionManager = connectionManager;

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
      const result: ReconnectStateResult | null = await this.roomManager.reconnectAndGetState(
        playerId,
        roomId
      );

      if (!result || !result.player) {
        this.sendReconnectResponse(playerId, {
          success: false,
          reason: 'player_not_found_in_room',
          currentTick: result?.tick || 0,
        });
        return;
      }

      session.state = 'syncing';

      this.sendFullSync(playerId, result.state, result.tick, result.player);

      session.state = 'completed';

      console.log(
        `[ReconnectManager] Player ${playerId} reconnected to room ${roomId}, tick=${result.tick}, pos=(${result.player.position.x.toFixed(1)}, ${result.player.position.y.toFixed(1)}), score=${result.player.score}`
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

  private sendFullSync(
    playerId: string,
    state: any,
    tick: number,
    selfPlayer: any
  ): void {
    this.connectionManager.sendToPlayer(playerId, {
      type: 'reconnect_response',
      payload: {
        success: true,
        syncType: 'full',
        tick,
        timestamp: Date.now(),
        state,
        selfPlayer,
      },
    });
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
