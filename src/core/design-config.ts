/**
 * DesignConfig — Resolution chain for Stitch project IDs.
 *
 * Reads/writes `design-config.json` in the project root.
 * Resolution chain: explicit param → config file → error
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface DesignConfigData {
  /** Default Stitch project ID for this workspace */
  stitchProjectId?: string;
  /** GCP quota project ID */
  quotaProjectId?: string;
}

const CONFIG_FILE = 'design-config.json';

export class DesignConfig {
  private readonly configPath: string;

  constructor(projectRoot: string) {
    this.configPath = path.join(projectRoot, CONFIG_FILE);
  }

  /**
   * Read config. Returns empty object if file doesn't exist.
   */
  async read(): Promise<DesignConfigData> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(raw) as DesignConfigData;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  /**
   * Write config atomically.
   */
  async write(data: DesignConfigData): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = this.configPath + '.tmp';
    const json = JSON.stringify(data, null, 2) + '\n';
    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, this.configPath);
  }

  /**
   * Update specific fields in config (read-modify-write).
   */
  async update(updates: Partial<DesignConfigData>): Promise<DesignConfigData> {
    const current = await this.read();
    const merged = { ...current, ...updates };
    await this.write(merged);
    return merged;
  }

  /**
   * Resolve the Stitch project ID using the resolution chain:
   * 1. Explicit param (if provided)
   * 2. Config file (design-config.json)
   * 3. null (caller decides how to handle)
   */
  async resolveProjectId(explicit?: string): Promise<string | null> {
    if (explicit) return explicit;
    const config = await this.read();
    return config.stitchProjectId ?? null;
  }
}
