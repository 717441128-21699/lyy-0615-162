import { SnapshotData, DeltaUpdate, PlayerState } from '../types';

export class StateSyncManager {
  private snapshotHistory: SnapshotData[] = [];
  private maxSnapshots: number = 60;
  private lastFullSyncTick: number = 0;
  private fullSyncInterval: number = 100;

  constructor(maxSnapshots: number = 60, fullSyncInterval: number = 100) {
    this.maxSnapshots = maxSnapshots;
    this.fullSyncInterval = fullSyncInterval;
  }

  addSnapshot(snapshot: SnapshotData): void {
    this.snapshotHistory.push(snapshot);

    if (this.snapshotHistory.length > this.maxSnapshots) {
      this.snapshotHistory.shift();
    }
  }

  getLatestSnapshot(): SnapshotData | null {
    return this.snapshotHistory[this.snapshotHistory.length - 1] || null;
  }

  getSnapshotAtTick(tick: number): SnapshotData | null {
    for (let i = this.snapshotHistory.length - 1; i >= 0; i--) {
      if (this.snapshotHistory[i].tick <= tick) {
        return this.snapshotHistory[i];
      }
    }
    return this.snapshotHistory[0] || null;
  }

  computeDelta(prev: SnapshotData, current: SnapshotData): DeltaUpdate {
    const changedPlayers: PlayerState[] = [];
    const removedPlayers: string[] = [];

    const prevPlayers = new Map<string, PlayerState>();
    for (const p of prev.state.players) {
      prevPlayers.set(p.id, p);
    }

    const currentPlayers = new Map<string, PlayerState>();
    for (const p of current.state.players) {
      currentPlayers.set(p.id, p);
    }

    for (const player of current.state.players) {
      const prevPlayer = prevPlayers.get(player.id);
      if (!prevPlayer || !this.arePlayersEqual(prevPlayer, player)) {
        changedPlayers.push({ ...player });
      }
    }

    for (const playerId of prevPlayers.keys()) {
      if (!currentPlayers.has(playerId)) {
        removedPlayers.push(playerId);
      }
    }

    const delta: DeltaUpdate = {
      tick: current.tick,
      timestamp: current.timestamp,
      changedPlayers,
      removedPlayers,
    };

    if (prev.state.gamePhase !== current.state.gamePhase) {
      delta.phaseChanged = current.state.gamePhase;
    }

    return delta;
  }

  private arePlayersEqual(a: PlayerState, b: PlayerState): boolean {
    return (
      a.id === b.id &&
      a.name === b.name &&
      a.health === b.health &&
      a.score === b.score &&
      a.position.x === b.position.x &&
      a.position.y === b.position.y &&
      a.velocity.x === b.velocity.x &&
      a.velocity.y === b.velocity.y
    );
  }

  shouldDoFullSync(currentTick: number): boolean {
    return currentTick - this.lastFullSyncTick >= this.fullSyncInterval;
  }

  markFullSync(tick: number): void {
    this.lastFullSyncTick = tick;
  }

  getSnapshotRange(startTick: number, endTick: number): SnapshotData[] {
    return this.snapshotHistory.filter(
      (s) => s.tick >= startTick && s.tick <= endTick
    );
  }
}
