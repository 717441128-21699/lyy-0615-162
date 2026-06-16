import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { PlayerState, Vector2, NetworkMessage } from '../types';
import { Protocol } from '../network/Protocol';

export class Player {
  public id: string;
  public name: string;
  public ws: WebSocket | null;
  public state: PlayerState;
  public roomId: string | null = null;
  public isConnected: boolean = true;
  public lastActiveTime: number = Date.now();
  public lastAcknowledgedTick: number = 0;

  constructor(id?: string, name?: string) {
    this.id = id || uuidv4();
    this.name = name || `Player_${this.id.slice(0, 8)}`;
    this.state = this.createInitialState();
    this.ws = null;
  }

  private createInitialState(): PlayerState {
    return {
      id: this.id,
      name: this.name,
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      health: 100,
      score: 0,
    };
  }

  setWebSocket(ws: WebSocket): void {
    this.ws = ws;
    this.isConnected = true;
    this.lastActiveTime = Date.now();
  }

  send(message: NetworkMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(Protocol.encode(message));
    }
  }

  disconnect(): void {
    this.isConnected = false;
    if (this.ws) {
      this.ws.close();
    }
  }

  setPosition(pos: Vector2): void {
    this.state.position = { ...pos };
  }

  setHealth(health: number): void {
    this.state.health = Math.max(0, Math.min(100, health));
  }

  addScore(points: number): void {
    this.state.score += points;
  }
}
