/**
 * CatalogManager tests — TC-CM-01 through TC-CM-14
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CatalogManager } from '../../src/core/catalog-manager.js';
import {
  type Catalog,
  type CatalogEntry,
  CURRENT_CATALOG_VERSION,
  CatalogValidationError,
  CatalogCorruptionError,
  CatalogVersionError,
} from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

function catalogPath(): string {
  return path.join(tmpDir, 'design-artifacts', 'catalog.json');
}

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'test-entry',
    screen: 'home',
    status: 'draft',
    versions: [{ version: 1, timestamp: '2026-01-01T00:00:00Z', source: 'stitch' }],
    ...overrides,
  };
}

async function writeCatalog(catalog: Catalog): Promise<void> {
  const dir = path.join(tmpDir, 'design-artifacts');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'catalog.json'), JSON.stringify(catalog, null, 2));
}

async function readCatalogRaw(): Promise<Catalog> {
  const raw = await fs.readFile(catalogPath(), 'utf-8');
  return JSON.parse(raw) as Catalog;
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CatalogManager', () => {
  // TC-CM-01: Initialize empty catalog in a new project directory
  it('TC-CM-01: init creates catalog.json with empty entries', async () => {
    const manager = new CatalogManager(tmpDir);
    await manager.init();

    const stat = await fs.stat(catalogPath());
    expect(stat.isFile()).toBe(true);

    const catalog = await readCatalogRaw();
    expect(catalog.version).toBe(CURRENT_CATALOG_VERSION);
    expect(catalog.entries).toEqual([]);
  });

  // TC-CM-02: Re-initializing does not overwrite existing data
  it('TC-CM-02: re-init preserves existing entries', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'existing' })],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);
    await manager.init();

    const catalog = await readCatalogRaw();
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]!.id).toBe('existing');
  });

  // TC-CM-03: Read returns catalog from existing file
  it('TC-CM-03: read returns parsed catalog', async () => {
    const fixture: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })],
    };
    await writeCatalog(fixture);

    const manager = new CatalogManager(tmpDir);
    const catalog = await manager.read();
    expect(catalog).toEqual(fixture);
  });

  // TC-CM-04: Read on missing catalog returns empty catalog
  it('TC-CM-04: read on missing file returns empty catalog', async () => {
    const manager = new CatalogManager(tmpDir);
    const catalog = await manager.read();

    expect(catalog.version).toBe(CURRENT_CATALOG_VERSION);
    expect(catalog.entries).toEqual([]);

    // Should NOT create the file as side effect
    await expect(fs.access(catalogPath())).rejects.toThrow();
  });

  // TC-CM-05: Write persists data atomically
  it('TC-CM-05: write persists data, no temp file left behind', async () => {
    const manager = new CatalogManager(tmpDir);
    const catalog: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'abc' })],
    };

    await manager.write(catalog);

    const read = await readCatalogRaw();
    expect(read).toEqual(catalog);

    // No tmp file
    const tmpFile = path.join(tmpDir, 'design-artifacts', '.catalog.json.tmp');
    await expect(fs.access(tmpFile)).rejects.toThrow();

    // Formatted JSON (indented)
    const raw = await fs.readFile(catalogPath(), 'utf-8');
    expect(raw).toContain('\n');
    expect(raw).toContain('  ');
  });

  // TC-CM-06: Atomic write — failure leaves original intact
  it('TC-CM-06: failed rename leaves original catalog intact', async () => {
    const original: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'original' })],
    };
    await writeCatalog(original);

    const manager = new CatalogManager(tmpDir);

    // Mock fs.rename to fail
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));

    const newCatalog: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'new' })],
    };

    await expect(manager.write(newCatalog)).rejects.toThrow('rename failed');

    renameSpy.mockRestore();

    // Original data intact
    const read = await readCatalogRaw();
    expect(read.entries[0]!.id).toBe('original');
  });

  // TC-CM-07: Add entry without corrupting existing
  it('TC-CM-07: addEntry preserves existing entries', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);
    await manager.addEntry(makeEntry({ id: 'c', screen: 'new-screen' }));

    const catalog = await manager.read();
    expect(catalog.entries).toHaveLength(3);
    expect(catalog.entries[0]!.id).toBe('a');
    expect(catalog.entries[1]!.id).toBe('b');
    expect(catalog.entries[2]!.id).toBe('c');
  });

  // TC-CM-08: Update modifies entry without corrupting others
  it('TC-CM-08: updateEntry modifies target, preserves others', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [
        makeEntry({ id: 'a', name: 'Old Name' }),
        makeEntry({ id: 'b' }),
      ],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);
    await manager.updateEntry('a', { name: 'New Name' });

    const catalog = await manager.read();
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries[0]!.name).toBe('New Name');
    expect(catalog.entries[1]!.id).toBe('b');
  });

  // TC-CM-09: Concurrent writes do not corrupt
  it('TC-CM-09: concurrent addEntry calls all succeed', async () => {
    const manager = new CatalogManager(tmpDir);
    await manager.init();

    const promises = Array.from({ length: 5 }, (_, i) =>
      manager.addEntry(makeEntry({ id: `entry-${i}`, screen: `screen-${i}` })),
    );

    await Promise.all(promises);

    const catalog = await manager.read();
    expect(catalog.entries).toHaveLength(5);

    // Verify valid JSON
    const raw = await fs.readFile(catalogPath(), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();

    // All entries present
    const ids = catalog.entries.map((e) => e.id).sort();
    expect(ids).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3', 'entry-4']);
  });

  // TC-CM-10: Schema validation rejects missing required fields
  it('TC-CM-10: addEntry rejects entry missing id', async () => {
    const manager = new CatalogManager(tmpDir);
    await manager.init();

    await expect(
      manager.addEntry({ name: 'Missing ID' } as unknown as CatalogEntry),
    ).rejects.toThrow(CatalogValidationError);

    await expect(
      manager.addEntry({ name: 'Missing ID' } as unknown as CatalogEntry),
    ).rejects.toThrow(/id/i);

    // Catalog not modified
    const catalog = await manager.read();
    expect(catalog.entries).toHaveLength(0);
  });

  // TC-CM-11: Schema validation rejects wrong field types
  it('TC-CM-11: addEntry rejects numeric id', async () => {
    const manager = new CatalogManager(tmpDir);
    await manager.init();

    await expect(
      manager.addEntry({ id: 12345, name: 'Wrong ID type' } as unknown as CatalogEntry),
    ).rejects.toThrow(CatalogValidationError);

    const catalog = await manager.read();
    expect(catalog.entries).toHaveLength(0);
  });

  // TC-CM-12: Schema validation rejects unknown version
  it('TC-CM-12: read rejects unknown catalog version', async () => {
    await writeCatalog({ version: 999, entries: [] });

    const manager = new CatalogManager(tmpDir);
    await expect(manager.read()).rejects.toThrow(CatalogVersionError);
    await expect(manager.read()).rejects.toThrow(/unsupported.*version/i);
  });

  // TC-CM-13: Migration (v1→v2) — currently only v1 supported, so test documents the contract
  it('TC-CM-13: current version catalog reads successfully', async () => {
    // Since CURRENT_CATALOG_VERSION is 1, verify v1 reads without migration
    const v1: Catalog = {
      version: 1,
      entries: [makeEntry({ id: 'v1-entry' })],
    };
    await writeCatalog(v1);

    const manager = new CatalogManager(tmpDir);
    const catalog = await manager.read();
    expect(catalog.version).toBe(1);
    expect(catalog.entries[0]!.id).toBe('v1-entry');
  });

  // TC-CM-14: Corrupted catalog.json → clear error, no auto-delete
  it('TC-CM-14: corrupted JSON throws CatalogCorruptionError', async () => {
    const dir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'catalog.json'), '{ "version": 1, "entries": [');

    const manager = new CatalogManager(tmpDir);
    await expect(manager.read()).rejects.toThrow(CatalogCorruptionError);
    await expect(manager.read()).rejects.toThrow(/corrupted/i);

    // File NOT deleted
    const stat = await fs.stat(catalogPath());
    expect(stat.isFile()).toBe(true);
  });

  // Additional: getEntry
  it('getEntry returns entry by id or null', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'a' })],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);
    const found = await manager.getEntry('a');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('a');

    const notFound = await manager.getEntry('nonexistent');
    expect(notFound).toBeNull();
  });

  // Additional: Status transition validation
  it('updateEntry validates status transitions', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'a', status: 'draft' })],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);

    // draft → approved is invalid (must go draft → review → approved)
    await expect(
      manager.updateEntry('a', { status: 'approved' }),
    ).rejects.toThrow(CatalogValidationError);

    // draft → review is valid
    await manager.updateEntry('a', { status: 'review' });
    const entry = await manager.getEntry('a');
    expect(entry!.status).toBe('review');
  });

  // Additional: Duplicate id
  it('addEntry rejects duplicate id', async () => {
    const existing: Catalog = {
      version: CURRENT_CATALOG_VERSION,
      entries: [makeEntry({ id: 'dup' })],
    };
    await writeCatalog(existing);

    const manager = new CatalogManager(tmpDir);
    await expect(
      manager.addEntry(makeEntry({ id: 'dup' })),
    ).rejects.toThrow(/already exists/i);
  });
});
