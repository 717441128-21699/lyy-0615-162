import { WebSocket } from 'ws';
import { Player } from '../core/Player';
import { Protocol } from './Protocol';
import { NetworkMessage } from '../types';
import { v4 as uuidv4 } from 'uuid';

export interface ConnectionHandler {
  onPlayerJoin: (player: Player, roomId: string) => void;
  onPlayerLeave: (player: Player, roomId: string) => void;
  onPlayerInput: (player: Player, roomId: string, input: any) => void;
  onReconnect: (player: Player, roomId: string, lastTick: number) => void;
  onPlayerDisconnected: (player: Player, roomId: string) => void;
  getPlayer: (playerId: string) => Player | undefined;
  getRoomPlayers: (roomId: string) => Player[];
}

export class ConnectionManager {
  private players: Map<string, Player> = new Map();
  private handler: ConnectionHandler | null = null;
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DISCONNECT_TIMEOUT_MS: number = 30000;

  setHandler(handler: ConnectionHandler): void {
    this.handler = handler;
  }

  handleConnection(ws: WebSocket): void {
    const playerId = this.getPlayerIdFromQuery(ws) || uuidv4();
    let player = this.players.get(playerId);

    if (!player) {
      player = new Player(playerId);
      this.players.set(playerId, player);
    } else {
      const existingTimer = this.disconnectTimers.get(playerId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.disconnectTimers.delete(playerId);
        console.log(`[ConnectionManager] Player ${playerId} reconnected - cleared disconnect timer`);
      }
    }

    player.setWebSocket(ws);

    ws.on('message', (data) => {
      this.handleMessage(player!, data.toString());
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnect(player!, code, reason?.toString());
    });

    ws.on('error', (error) => {
      console.error(`[ConnectionManager] WebSocket error for player ${playerId}:`, error.message);
    });

    console.log(`[ConnectionManager] Player connected: ${playerId}`);
  }

  private getPlayerIdFromQuery(ws: WebSocket): string | null {
    try {
      const url = new URL(ws.url || '', 'http://localhost');
      return url.searchParams.get('playerId');
    } catch {
      return null;
    }
  }

  private handleMessage(player: Player, data: string): void {
    try {
      const message = Protocol.decode(data);
      this.dispatchMessage(player, message);
    } catch (error) {
      console.error('[ConnectionManager] Failed to parse message:', error);
      player.send({ type: 'error', payload: { message: 'Invalid message format' } });
    }
  }

  private dispatchMessage(player: Player, message: NetworkMessage): void {
    player.lastActiveTime = Date.now();

    switch (message.type) {
      case 'player_join':
        this.handleJoinRoom(player, message.payload);
        break;
      case 'player_leave':
        this.handleLeaveRoom(player, message.payload);
        break;
      case 'player_input':
        this.handlePlayerInput(player, message.payload);
        break;
      case 'reconnect_request':
        this.handleReconnectRequest(player, message.payload);
        break;
      default:
        console.warn(`[ConnectionManager] Unknown message type: ${message.type}`);
    }
  }

  private handleJoinRoom(player: Player, payload: any): void {
    const { roomId, playerName } = payload;
    if (!roomId) {
      player.send({ type: 'error', payload: { message: 'Room ID is required' } });
      return;
    }

    if (playerName) {
      player.name = playerName;
      player.state.name = playerName;
    }

    player.roomId = roomId;
    this.handler?.onPlayerJoin(player, roomId);
  }

  private handleLeaveRoom(player: Player, payload: any): void {
    const { roomId } = payload;
    if (player.roomId && player.roomId === roomId) {
      this.handler?.onPlayerLeave(player, roomId);
      player.roomId = null;
    }
  }

  private handlePlayerInput(player: Player, payload: any): void {
    const { roomId, input } = payload;
    if (player.roomId && player.roomId === roomId) {
      this.handler?.onPlayerInput(player, roomId, input);
    }
  }

  private handleReconnectRequest(player: Player, payload: any): void {
    const { roomId, lastKnownTick } = payload;
    if (roomId) {
      player.roomId = roomId;
    }
    this.handler?.onReconnect(player, player.roomId || roomId, lastKnownTick);
  }

  private handleDisconnect(player: Player, code: number, reason?: string): void {
    player.isConnected = false;
    console.log(`[ConnectionManager] Player disconnected: ${player.id} (code=${code})`);

    if (player.roomId) {
      this.handler?.onPlayerDisconnected(player, player.roomId);

      const existingTimer = this.disconnectTimers.get(player.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        if (!player.isConnected && this.players.has(player.id)) {
          if (player.roomId) {
            this.handler?.onPlayerLeave(player, player.roomId);
          }
          this.players.delete(player.id);
          this.disconnectTimers.delete(player.id);
          console.log(`[ConnectionManager] Player removed due to timeout: ${player.id}`);
        }
      }, this.DISCONNECT_TIMEOUT_MS);

      this.disconnectTimers.set(player.id, timer);
    } else {
      this.players.delete(player.id);
    }
  }

  getPlayer(playerId: string): Player | undefined {
    return this.players.get(playerId);
  }

  broadcastToRoom(roomId: string, message: NetworkMessage): void {
    for (const player of this.players.values()) {
      if (player.roomId === roomId && player.isConnected) {
        player.send(message);
      }
    }
  }

  sendToPlayer(playerId: string, message: NetworkMessage): void {
    const player = this.players.get(playerId);
    if (player && player.isConnected) {
      player.send(message);
    }
  }

  getRoomPlayers(roomId: string): Player[] {
    const players: Player[] = [];
    for (const player of this.players.values()) {
      if (player.roomId === roomId) {
        players.push(player);
      }
    }
    return players;
  }
}
