import { WebSocketServer } from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from '../network/ConnectionManager';
import { RoomManager, HotReloadResult } from '../core/RoomManager';
import { HotReloader } from '../hot-reload/HotReloader';
import { ReconnectManager } from '../sync/ReconnectManager';
import { GameConfig, DEFAULT_CONFIG, PlayerInput } from '../types';
import { Player } from '../core/Player';

export interface GameServerOptions {
  port: number;
  config?: Partial<GameConfig>;
  hotReload?: boolean;
}

export class GameServer {
  private port: number;
  private config: GameConfig;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private connectionManager: ConnectionManager;
  private roomManager: RoomManager;
  private hotReloader: HotReloader;
  private reconnectManager: ReconnectManager;
  private isRunning: boolean = false;

  constructor(options: GameServerOptions) {
    this.port = options.port;
    this.config = { ...DEFAULT_CONFIG, ...options.config };

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.wss = new WebSocketServer({ server: this.httpServer });

    this.connectionManager = new ConnectionManager();

    this.roomManager = new RoomManager(this.connectionManager, this.config);

    this.hotReloader = new HotReloader({
      enabled: options.hotReload !== false,
    });
    this.hotReloader.setRoomManager(this.roomManager);

    this.reconnectManager = new ReconnectManager(
      this.roomManager,
      this.connectionManager
    );

    this.setupConnectionHandler();
    this.setupHotReloadHandlers();
  }

  private setupConnectionHandler(): void {
    this.connectionManager.setHandler({
      onPlayerJoin: (player: Player, roomId: string) => {
        this.handlePlayerJoin(player, roomId);
      },
      onPlayerLeave: (player: Player, roomId: string) => {
        this.handlePlayerLeave(player, roomId);
      },
      onPlayerInput: (player: Player, roomId: string, input: any) => {
        this.handlePlayerInput(player, roomId, input);
      },
      onReconnect: (player: Player, roomId: string, lastTick: number) => {
        this.handleReconnect(player, roomId, lastTick);
      },
      onPlayerDisconnected: (player: Player, roomId: string) => {
        this.handlePlayerDisconnected(player, roomId);
      },
      getPlayer: (playerId: string) => {
        return this.connectionManager.getPlayer(playerId);
      },
      getRoomPlayers: (roomId: string) => {
        return this.connectionManager.getRoomPlayers(roomId);
      },
    });
  }

  private setupHotReloadHandlers(): void {
    this.hotReloader.on('reload', async (data: any) => {
      console.log('[GameServer] Hot reload triggered by file watcher, reloading rooms...');
      try {
        const result = await this.roomManager.hotReloadAllRooms();
        console.log(
          `[GameServer] Hot reload complete: ${result.succeeded}/${result.totalRooms} rooms succeeded, ${result.failed} failed`
        );
        if (!result.success) {
          for (const r of result.roomResults) {
            if (!r.success) {
              console.warn(`  - Room ${r.roomId} (${r.roomName}) failed: ${r.error}`);
            }
          }
        }
      } catch (error) {
        console.error('[GameServer] Hot reload error (caught, server continues):', error);
      }
    });
  }

  private handlePlayerJoin(player: Player, roomId: string): void {
    console.log(`[GameServer] Player ${player.id} joining room ${roomId}`);
    this.roomManager.joinRoom(player.id, player.name, roomId);

    player.send({
      type: 'room_info',
      payload: {
        roomId,
        playerId: player.id,
        tickRate: this.config.tickRate,
      },
    });
  }

  private handlePlayerLeave(player: Player, roomId: string): void {
    console.log(`[GameServer] Player ${player.id} permanently leaving room ${roomId}`);
    this.roomManager.leaveRoom(player.id, roomId);
  }

  private handlePlayerDisconnected(player: Player, roomId: string): void {
    console.log(`[GameServer] Player ${player.id} disconnected from room ${roomId} - marking offline`);
    this.roomManager.markPlayerOffline(player.id, roomId);
  }

  private handlePlayerInput(player: Player, roomId: string, input: any): void {
    const playerInput: PlayerInput = {
      playerId: player.id,
      tickNumber: input.tickNumber || 0,
      timestamp: Date.now(),
      moveDir: input.moveDir,
      action: input.action,
    };

    this.roomManager.sendInput(player.id, roomId, playerInput);
  }

  private handleReconnect(player: Player, roomId: string, lastTick: number): void {
    console.log(
      `[GameServer] Player ${player.id} reconnecting to room ${roomId} from tick ${lastTick}`
    );

    if (!player.roomId) {
      player.roomId = roomId;
    }

    this.reconnectManager.handleReconnect(player.id, roomId, lastTick);
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '/';

    if (url === '/status') {
      this.handleStatusRequest(res);
      return;
    }

    if (url === '/hot-reload' || url === '/hot-reload/') {
      this.handleHotReloadRequest(res);
      return;
    }

    this.serveStaticFile(url, res);
  }

  private handleStatusRequest(res: http.ServerResponse): void {
    try {
      const status = {
        running: this.isRunning,
        rooms: this.roomManager.getRoomList(),
        roomCount: this.roomManager.getRoomCount(),
        hotReload: this.hotReloader.getStats(),
        uptime: process.uptime(),
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  }

  private async handleHotReloadRequest(res: http.ServerResponse): Promise<void> {
    try {
      console.log('[GameServer] Hot reload requested via HTTP API');

      this.hotReloader.clearMainProcessCache();

      const result: HotReloadResult = await this.roomManager.hotReloadAllRooms(5000);

      const httpStatus = result.success ? 200 : 500;

      const response = {
        ok: result.success,
        message: result.success
          ? `Hot reload succeeded: ${result.succeeded}/${result.totalRooms} rooms`
          : `Hot reload partially failed: ${result.failed}/${result.totalRooms} rooms failed`,
        succeeded: result.succeeded,
        failed: result.failed,
        totalRooms: result.totalRooms,
        details: result.roomResults.map((r) => ({
          roomId: r.roomId,
          roomName: r.roomName,
          success: r.success,
          version: r.version,
          error: r.error,
        })),
      };

      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));

      console.log(
        `[GameServer] Hot reload API response: ${response.ok ? 'OK' : 'FAILED'} - ${response.message}`
      );
    } catch (error) {
      console.error('[GameServer] Hot reload API error (caught):', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          {
            ok: false,
            message: 'Hot reload failed with exception',
            error: (error as Error).message,
          },
          null,
          2
        )
      );
    }
  }

  private serveStaticFile(url: string, res: http.ServerResponse): void {
    const publicDir = path.resolve(process.cwd(), 'public');
    let filePath = url === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, url);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404);
          res.end('Not Found');
        } else {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = this.getContentType(ext);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  private getContentType(ext: string): string {
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    return types[ext] || 'application/octet-stream';
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.on('connection', (ws) => {
        this.connectionManager.handleConnection(ws);
      });

      this.httpServer.listen(this.port, () => {
        this.isRunning = true;
        console.log(`[GameServer] Server started on port ${this.port}`);
        console.log(`[GameServer] WebSocket: ws://localhost:${this.port}`);
        console.log(`[GameServer] Status: http://localhost:${this.port}/status`);
        console.log(`[GameServer] Hot-Reload: http://localhost:${this.port}/hot-reload`);
        console.log(`[GameServer] Tick rate: ${this.config.tickRate} ticks/sec (fixed step)`);

        this.hotReloader.start();

        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.isRunning = false;
      this.hotReloader.stop();
      this.roomManager.shutdownAll();
      this.wss.close(() => {
        this.httpServer.close(() => {
          console.log('[GameServer] Server stopped');
          resolve();
        });
      });
    });
  }

  getRoomManager(): RoomManager {
    return this.roomManager;
  }

  getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  getHotReloader(): HotReloader {
    return this.hotReloader;
  }
}
