/**
 * ScreenRegistry — Local screen registry for tracking Stitch screens.
 * Workaround for broken Stitch `list_screens` API.
 * 
 * Location: {projectRoot}/design-artifacts/screen-registry.json
 * Updated on every design_generate and design_edit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface ScreenRegistryEntry {
  id: string;
  title: string;
  screen: string; // slugified name
  projectId: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  files: {
    html: string;
    screenshot: string;
  };
}

export interface ScreenRegistry {
  screens: ScreenRegistryEntry[];
}

const REGISTRY_DIR = 'design-artifacts';
const REGISTRY_FILE = 'screen-registry.json';

function emptyRegistry(): ScreenRegistry {
  return { screens: [] };
}

export class ScreenRegistryManager {
  private readonly registryDir: string;
  private readonly registryPath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.registryDir = path.join(projectRoot, REGISTRY_DIR);
    this.registryPath = path.join(this.registryDir, REGISTRY_FILE);
  }

  /**
   * Read registry. Returns empty if file doesn't exist.
   */
  async read(): Promise<ScreenRegistry> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf-8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.screens)) {
        return data as ScreenRegistry;
      }
      return emptyRegistry();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyRegistry();
      }
      throw error;
    }
  }

  /**
   * Register a new screen in the registry.
   */
  async register(entry: ScreenRegistryEntry): Promise<void> {
    await this.serialize(async () => {
      const registry = await this.read();
      // Remove existing entry with same id (upsert)
      const idx = registry.screens.findIndex((s) => s.id === entry.id);
      if (idx >= 0) {
        registry.screens[idx] = entry;
      } else {
        registry.screens.push(entry);
      }
      await this.writeAtomic(registry);
    });
  }

  /**
   * Update an existing screen entry (e.g. after edit).
   */
  async update(screenId: string, updates: Partial<ScreenRegistryEntry>): Promise<void> {
    await this.serialize(async () => {
      const registry = await this.read();
      const idx = registry.screens.findIndex((s) => s.id === screenId);
      if (idx === -1) {
        throw new Error(`Screen ${screenId} not found in registry`);
      }
      registry.screens[idx] = { ...registry.screens[idx]!, ...updates };
      await this.writeAtomic(registry);
    });
  }

  /**
   * Find a screen by its Stitch screen ID.
   */
  async findById(screenId: string): Promise<ScreenRegistryEntry | null> {
    const registry = await this.read();
    return registry.screens.find((s) => s.id === screenId) ?? null;
  }

  /**
   * Find a screen by slug.
   */
  async findBySlug(slug: string): Promise<ScreenRegistryEntry | null> {
    const registry = await this.read();
    return registry.screens.find((s) => s.screen === slug) ?? null;
  }

  /**
   * List all screens, optionally filtered by projectId.
   */
  async list(projectId?: string): Promise<ScreenRegistryEntry[]> {
    const registry = await this.read();
    if (projectId) {
      return registry.screens.filter((s) => s.projectId === projectId);
    }
    return registry.screens;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async writeAtomic(registry: ScreenRegistry): Promise<void> {
    await fs.mkdir(this.registryDir, { recursive: true });
    const tmpPath = path.join(this.registryDir, '.screen-registry.json.tmp');
    const json = JSON.stringify(registry, null, 2) + '\n';
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, this.registryPath);
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.catch(() => {});
    return next;
  }
}
