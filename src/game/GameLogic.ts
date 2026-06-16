import { PlayerState, Vector2, PlayerInput } from '../types';

export interface GameLogicConfig {
  moveSpeed: number;
  friction: number;
  worldBounds: { minX: number; maxX: number; minY: number; maxY: number };
  jumpScore: number;
}

export const DEFAULT_GAME_CONFIG: GameLogicConfig = {
  moveSpeed: 0.1,
  friction: 0.9,
  worldBounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
  jumpScore: 1,
};

let gameConfig: GameLogicConfig = { ...DEFAULT_GAME_CONFIG };

export function setGameConfig(config: Partial<GameLogicConfig>): void {
  gameConfig = { ...gameConfig, ...config };
}

export function getGameConfig(): GameLogicConfig {
  return { ...gameConfig };
}

export function updatePlayerPhysics(
  player: PlayerState,
  input: PlayerInput | undefined,
  deltaTime: number
): void {
  if (input?.moveDir) {
    const { moveDir } = input;
    const length = Math.sqrt(moveDir.x ** 2 + moveDir.y ** 2);

    if (length > 0) {
      const normalized = {
        x: moveDir.x / length,
        y: moveDir.y / length,
      };
      player.velocity.x = normalized.x * gameConfig.moveSpeed * deltaTime;
      player.velocity.y = normalized.y * gameConfig.moveSpeed * deltaTime;
    }
  }

  if (input?.action === 'jump') {
    player.score += gameConfig.jumpScore;
  }

  player.position.x += player.velocity.x;
  player.position.y += player.velocity.y;

  player.velocity.x *= gameConfig.friction;
  player.velocity.y *= gameConfig.friction;

  const { worldBounds } = gameConfig;
  player.position.x = Math.max(
    worldBounds.minX,
    Math.min(worldBounds.maxX, player.position.x)
  );
  player.position.y = Math.max(
    worldBounds.minY,
    Math.min(worldBounds.maxY, player.position.y)
  );
}

export function processPlayerAction(
  player: PlayerState,
  action: string,
  params?: any
): void {
  switch (action) {
    case 'jump':
      player.score += gameConfig.jumpScore;
      break;
    case 'heal':
      player.health = Math.min(100, player.health + (params?.amount || 10));
      break;
    case 'damage':
      player.health = Math.max(0, player.health - (params?.amount || 10));
      break;
  }
}

export function checkCollision(a: PlayerState, b: PlayerState, radius: number = 5): boolean {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.sqrt(dx * dx + dy * dy) < radius * 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalizeVector(v: Vector2): Vector2 {
  const length = Math.sqrt(v.x ** 2 + v.y ** 2);
  if (length === 0) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

console.log('[GameLogic] Module loaded');
