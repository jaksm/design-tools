/**
 * CatalogManager — Manages {project}/design-artifacts/catalog.json
 * with atomic writes, schema validation, and status lifecycle.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type Catalog,
  type CatalogEntry,
  type CatalogEntryStatus,
  CURRENT_CATALOG_VERSION,
  CatalogValidationError,
  CatalogCorruptionError,
  CatalogVersionError,
  isValidStatusTransition,
} from './types.js';

const CATALOG_DIR = 'design-artifacts';
const CATALOG_FILE = 'catalog.json';
const CATALOG_TMP = '.catalog.json.tmp';

function emptyCatalog(): Catalog {
  return { version: CURRENT_CATALOG_VERSION, entries: [] };
}

export class CatalogManager {
  private readonly catalogDir: string;
  private readonly catalogPath: string;
  private readonly tmpPath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.catalogDir = path.join(projectRoot, CATALOG_DIR);
    this.catalogPath = path.join(this.catalogDir, CATALOG_FILE);
    this.tmpPath = path.join(this.catalogDir, CATALOG_TMP);
  }

  /**
   * Create catalog.json if missing. Idempotent — does not overwrite existing data.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.catalogDir, { recursive: true });
    try {
      await fs.access(this.catalogPath);
      // File exists — don't overwrite (TC-CM-02)
    } catch {
      // File doesn't exist — create empty catalog
      await this.writeAtomic(emptyCatalog());
    }
  }

  /**
   * Read catalog. Returns empty catalog if file missing. Throws on corruption.
   */
  async read(): Promise<Catalog> {
    let raw: string;
    try {
      raw = await fs.readFile(this.catalogPath, 'utf-8');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyCatalog();
      }
      throw error;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new CatalogCorruptionError(
        `catalog.json is corrupted — please restore from backup or delete to reinitialize: ${(error as Error).message}`,
      );
    }

    const catalog = data as Catalog;

    // Version check
    if (catalog.version !== CURRENT_CATALOG_VERSION) {
      throw new CatalogVersionError(
        `Unsupported catalog version: ${catalog.version}. Expected ${CURRENT_CATALOG_VERSION}.`,
      );
    }

    return catalog;
  }

  /**
   * Write catalog atomically (temp + rename).
   */
  async write(catalog: Catalog): Promise<void> {
    await this.serialize(async () => {
      await this.writeAtomic(catalog);
    });
  }

  /**
   * Add a new entry to the catalog.
   */
  async addEntry(entry: CatalogEntry): Promise<void> {
    this.validateEntry(entry);
    await this.serialize(async () => {
      const catalog = await this.read();
      if (catalog.entries.some((e) => e.id === entry.id)) {
        throw new CatalogValidationError(`Entry with id "${entry.id}" already exists`);
      }
      catalog.entries.push(entry);
      await this.writeAtomic(catalog);
    });
  }

  /**
   * Update an existing entry by id.
   */
  async updateEntry(id: string, updates: Partial<CatalogEntry>): Promise<void> {
    await this.serialize(async () => {
      const catalog = await this.read();
      const index = catalog.entries.findIndex((e) => e.id === id);
      if (index === -1) {
        throw new CatalogValidationError(`Entry with id "${id}" not found`);
      }

      const existing = catalog.entries[index]!;

      // Validate status transition if status is being changed
      if (updates.status && updates.status !== existing.status) {
        if (!isValidStatusTransition(existing.status, updates.status)) {
          throw new CatalogValidationError(
            `Invalid status transition: ${existing.status} → ${updates.status}`,
          );
        }
      }

      catalog.entries[index] = { ...existing, ...updates };
      await this.writeAtomic(catalog);
    });
  }

  /**
   * Get an entry by id. Returns null if not found.
   */
  async getEntry(id: string): Promise<CatalogEntry | null> {
    const catalog = await this.read();
    return catalog.entries.find((e) => e.id === id) ?? null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private validateEntry(entry: unknown): asserts entry is CatalogEntry {
    const e = entry as Record<string, unknown>;

    if (!e || typeof e !== 'object') {
      throw new CatalogValidationError('Entry must be an object');
    }
    if (typeof e.id !== 'string') {
      throw new CatalogValidationError('Missing or invalid required field: id (must be string)');
    }
    if (typeof e.screen !== 'string') {
      throw new CatalogValidationError('Missing or invalid required field: screen (must be string)');
    }
    if (typeof e.status !== 'string') {
      throw new CatalogValidationError('Missing or invalid required field: status (must be string)');
    }
    const validStatuses: CatalogEntryStatus[] = ['draft', 'review', 'approved', 'implemented', 'rejected'];
    if (!validStatuses.includes(e.status as CatalogEntryStatus)) {
      throw new CatalogValidationError(`Invalid status: ${e.status}. Must be one of: ${validStatuses.join(', ')}`);
    }
    if (!Array.isArray(e.versions)) {
      throw new CatalogValidationError('Missing or invalid required field: versions (must be array)');
    }
  }

  private async writeAtomic(catalog: Catalog): Promise<void> {
    await fs.mkdir(this.catalogDir, { recursive: true });
    const json = JSON.stringify(catalog, null, 2) + '\n';
    await fs.writeFile(this.tmpPath, json, 'utf-8');
    await fs.rename(this.tmpPath, this.catalogPath);
  }

  /**
   * Serializes write operations to prevent concurrent corruption.
   */
  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.catch(() => {});
    return next;
  }
}
