import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { RoomManager } from '../core/RoomManager';

export interface HotReloadOptions {
  watchDir: string;
  fileExtensions: string[];
  debounceMs: number;
  enabled: boolean;
}

const DEFAULT_OPTIONS: HotReloadOptions = {
  watchDir: path.resolve(process.cwd(), 'src', 'game'),
  fileExtensions: ['.ts', '.js'],
  debounceMs: 1000,
  enabled: true,
};

export class HotReloader extends EventEmitter {
  private options: HotReloadOptions;
  private roomManager: RoomManager | null = null;
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private changedFiles: Set<string> = new Set();
  private isWatching: boolean = false;
  private reloadCount: number = 0;

  constructor(options?: Partial<HotReloadOptions>) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  setRoomManager(roomManager: RoomManager): void {
    this.roomManager = roomManager;
  }

  start(): void {
    if (!this.options.enabled) {
      console.log('[HotReloader] Hot reload is disabled');
      return;
    }

    if (this.isWatching) return;

    console.log(`[HotReloader] Starting file watcher on: ${this.options.watchDir}`);
    this.setupWatcher(this.options.watchDir);
    this.isWatching = true;
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.isWatching = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    console.log('[HotReloader] Stopped');
  }

  private setupWatcher(dir: string): void {
    if (!fs.existsSync(dir)) {
      console.warn(`[HotReloader] Watch directory not found: ${dir}`);
      return;
    }

    const watcher = fs.watch(
      dir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const ext = path.extname(filename);
        if (!this.options.fileExtensions.includes(ext)) return;

        const fullPath = path.join(dir, filename);
        this.changedFiles.add(fullPath);

        this.scheduleReload();
      }
    );

    this.watchers.push(watcher);

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.setupWatcher(path.join(dir, entry.name));
      }
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.performReload();
    }, this.options.debounceMs);
  }

  private performReload(): void {
    const files = Array.from(this.changedFiles);
    this.changedFiles.clear();
    this.reloadCount++;

    console.log(
      `[HotReloader] Reload #${this.reloadCount} - ${files.length} file(s) changed`
    );
    for (const file of files) {
      console.log(`  - ${path.basename(file)}`);
    }

    this.clearRequireCache(files);

    this.emit('reload', {
      count: this.reloadCount,
      files: files,
      timestamp: Date.now(),
    });

    if (this.roomManager) {
      this.notifyRoomsOfReload(files);
    }
  }

  public clearMainProcessCache(): void {
    const gameDir = path.resolve(process.cwd(), 'src', 'game');
    if (!fs.existsSync(gameDir)) return;

    const cleared: string[] = [];
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(gameDir) || key.includes(path.sep + 'game' + path.sep)) {
        delete require.cache[key];
        cleared.push(path.basename(key));
      }
    }
    if (cleared.length > 0) {
      console.log(`[HotReloader] Cleared main process cache for: ${cleared.join(', ')}`);
    }
  }

  private clearRequireCache(files: string[]): void {
    for (const file of files) {
      try {
        const resolved = require.resolve(file);
        if (require.cache[resolved]) {
          delete require.cache[resolved];
          console.log(`[HotReloader] Cleared cache: ${path.basename(file)}`);
        }
      } catch {
        // ignore if module not found
      }
    }
  }

  private notifyRoomsOfReload(files: string[]): void {
    console.log('[HotReloader] Notifying rooms of code update...');
    this.emit('rooms_reload', { files });
  }

  manualReload(): void {
    console.log('[HotReloader] Manual reload triggered');
    this.changedFiles.add('manual');
    this.performReload();
  }

  getStats(): {
    isWatching: boolean;
    reloadCount: number;
    watchDir: string;
    enabled: boolean;
  } {
    return {
      isWatching: this.isWatching,
      reloadCount: this.reloadCount,
      watchDir: this.options.watchDir,
      enabled: this.options.enabled,
    };
  }
}
