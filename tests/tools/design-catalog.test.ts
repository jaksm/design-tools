/**
 * design_catalog tool tests — TC-LIST through TC-CROSS
 * Implements all P0 (39) and P1 (31) test cases from test-cases-design-catalog.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { designCatalog, type DesignCatalogParams } from '../../src/tools/design-catalog.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

async function call(params: DesignCatalogParams) {
  return designCatalog(params, tmpDir);
}

async function createFile(relativePath: string, content = 'test'): Promise<void> {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

async function addArtifact(screen: string, extra: Partial<DesignCatalogParams> = {}) {
  const htmlPath = `screens/${screen}/v1.html`;
  const ssPath = `screens/${screen}/v1.png`;
  await createFile(htmlPath);
  await createFile(ssPath);
  return call({
    action: 'add',
    screen,
    description: `${screen} screen`,
    html: htmlPath,
    screenshot: ssPath,
    ...extra,
  });
}

/** Seed a catalog with given artifacts and specific updatedAt values */
async function seedCatalog(artifacts: Array<{
  screen: string;
  status?: string;
  updatedAt?: string;
  mcTaskId?: string | null;
  mcObjectiveId?: string | null;
  currentVersion?: number;
}>) {
  const catalogDir = path.join(tmpDir, 'design-artifacts');
  await fs.mkdir(catalogDir, { recursive: true });

  const entries = artifacts.map((a, i) => ({
    id: `${a.screen}-v${a.currentVersion ?? 1}`,
    screen: a.screen,
    description: `${a.screen} screen`,
    status: a.status ?? 'draft',
    currentVersion: a.currentVersion ?? 1,
    versions: [{
      version: 1,
      html: `screens/${a.screen}/v1.html`,
      screenshot: `screens/${a.screen}/v1.png`,
      createdAt: a.updatedAt ?? new Date(Date.now() - i * 1000).toISOString(),
    }],
    mcTaskId: a.mcTaskId,
    mcObjectiveId: a.mcObjectiveId,
    createdAt: a.updatedAt ?? new Date(Date.now() - i * 1000).toISOString(),
    updatedAt: a.updatedAt ?? new Date(Date.now() - i * 1000).toISOString(),
  }));

  const catalog = { version: 1, artifacts: entries };
  await fs.writeFile(
    path.join(catalogDir, 'catalog.json'),
    JSON.stringify(catalog, null, 2),
  );
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-catalog-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── LIST Tests ──────────────────────────────────────────────────────────────

describe('list action', () => {
  // TC-LIST-01: Empty catalog returns empty array (P0)
  it('TC-LIST-01: empty catalog returns empty array', async () => {
    await seedCatalog([]);
    const result = await call({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.artifacts).toEqual([]);
  });

  // TC-LIST-02: Populated catalog returns all artifacts with summary fields (P0)
  it('TC-LIST-02: populated catalog returns summaries', async () => {
    await seedCatalog([
      { screen: 'dashboard' },
      { screen: 'settings' },
      { screen: 'onboarding' },
    ]);
    const result = await call({ action: 'list' });
    expect(result.success).toBe(true);
    const artifacts = result.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(3);
    for (const a of artifacts) {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('screen');
      expect(a).toHaveProperty('description');
      expect(a).toHaveProperty('currentVersion');
      expect(a).toHaveProperty('status');
      expect(a).toHaveProperty('updatedAt');
      // Should NOT include full versions array
      expect(a).not.toHaveProperty('versions');
    }
  });

  // TC-LIST-03: Filter by status (P1)
  it('TC-LIST-03: filter by status returns matching', async () => {
    await seedCatalog([
      { screen: 'a', status: 'draft' },
      { screen: 'b', status: 'draft' },
      { screen: 'c', status: 'approved' },
      { screen: 'd', status: 'review' },
    ]);
    const result = await call({ action: 'list', status: 'approved' });
    expect(result.success).toBe(true);
    const artifacts = result.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.status).toBe('approved');
  });

  // TC-LIST-04: Filter with no matches returns empty (P1)
  it('TC-LIST-04: filter with no matches returns empty', async () => {
    await seedCatalog([
      { screen: 'a', status: 'draft' },
      { screen: 'b', status: 'draft' },
      { screen: 'c', status: 'draft' },
    ]);
    const result = await call({ action: 'list', status: 'implemented' });
    expect(result.success).toBe(true);
    expect(result.artifacts).toEqual([]);
  });

  // TC-LIST-05: Filter by screen exact match (P1)
  it('TC-LIST-05: filter by screen exact match', async () => {
    await seedCatalog([
      { screen: 'dashboard' },
      { screen: 'dashboard-mobile' },
      { screen: 'settings' },
    ]);
    const result = await call({ action: 'list', screen: 'dashboard' });
    expect(result.success).toBe(true);
    const artifacts = result.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.screen).toBe('dashboard');
  });

  // TC-LIST-06: Sorted by most recently updated (P1)
  it('TC-LIST-06: sorted by updatedAt descending', async () => {
    await seedCatalog([
      { screen: 'settings', updatedAt: '2026-03-09T10:00:00Z' },
      { screen: 'dashboard', updatedAt: '2026-03-09T14:00:00Z' },
      { screen: 'onboarding', updatedAt: '2026-03-09T08:00:00Z' },
    ]);
    const result = await call({ action: 'list' });
    const artifacts = result.artifacts as Array<Record<string, unknown>>;
    expect(artifacts[0]!.screen).toBe('dashboard');
    expect(artifacts[1]!.screen).toBe('settings');
    expect(artifacts[2]!.screen).toBe('onboarding');
  });

  // TC-LIST-08: Invalid status filter returns error (P1)
  it('TC-LIST-08: invalid status filter returns error', async () => {
    const result = await call({ action: 'list', status: 'banana' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('banana');
    expect(result.error).toContain('draft');
  });

  // TC-LIST-09: Auto-init on list when no catalog (P0)
  it('TC-LIST-09: auto-initializes when no catalog exists', async () => {
    // tmpDir exists but no design-artifacts
    const result = await call({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.artifacts).toEqual([]);
    // catalog.json should now exist
    const stat = await fs.stat(path.join(tmpDir, 'design-artifacts', 'catalog.json'));
    expect(stat.isFile()).toBe(true);
  });
});

// ── ADD Tests ───────────────────────────────────────────────────────────────

describe('add action', () => {
  // TC-ADD-01: Add new artifact with all fields (P0)
  it('TC-ADD-01: add new artifact succeeds', async () => {
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');

    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'Main metrics view',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });

    expect(result.success).toBe(true);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.id).toBeTruthy();
    expect(artifact.screen).toBe('dashboard');
    expect(artifact.description).toBe('Main metrics view');
    expect(artifact.status).toBe('draft');
    expect(artifact.currentVersion).toBe(1);
    expect((artifact.versions as unknown[]).length).toBe(1);
    expect(artifact.createdAt).toBeTruthy();
    expect(artifact.updatedAt).toBe(artifact.createdAt);

    // Verify persisted
    const listResult = await call({ action: 'list' });
    expect((listResult.artifacts as unknown[]).length).toBe(1);
  });

  // TC-ADD-02: Duplicate screen name returns error (P0)
  it('TC-ADD-02: duplicate screen returns error', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');

    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'Second attempt',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
    expect(result.error).toContain("version");
  });

  // TC-ADD-03: Missing screen returns error (P0)
  it('TC-ADD-03: missing screen returns error', async () => {
    const result = await call({
      action: 'add',
      description: 'No screen',
      html: 'x.html',
      screenshot: 'x.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('screen');
  });

  // TC-ADD-04: Missing html returns error (P0)
  it('TC-ADD-04: missing html returns error', async () => {
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('html');
  });

  // TC-ADD-05: HTML file not found returns error (P0)
  it('TC-ADD-05: html file not found returns error', async () => {
    await createFile('screens/dashboard/v1.png');
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('v1.html');
  });

  // TC-ADD-06: Screenshot file not found returns error (P0)
  it('TC-ADD-06: screenshot file not found returns error', async () => {
    await createFile('screens/dashboard/v1.html');
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('v1.png');
  });

  // TC-ADD-07: Both files missing returns combined error (P1)
  it('TC-ADD-07: both files missing lists both', async () => {
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('v1.html');
    expect(result.error).toContain('v1.png');
  });

  // TC-ADD-08: Directory auto-created (P1)
  it('TC-ADD-08: directory structure auto-created', async () => {
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');
    // No design-artifacts dir exists
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(true);
    const stat = await fs.stat(path.join(tmpDir, 'design-artifacts', 'catalog.json'));
    expect(stat.isFile()).toBe(true);
  });

  // TC-ADD-09: Stitch fields stored (P1)
  it('TC-ADD-09: stitch fields stored', async () => {
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
      stitchProjectId: 'proj-123',
      stitchScreenId: 'screen-456',
    });
    expect(result.success).toBe(true);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.stitch).toEqual({ projectId: 'proj-123', screenId: 'screen-456' });
  });

  // TC-ADD-10: Status always draft regardless of caller (P0)
  it('TC-ADD-10: status always draft', async () => {
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
      status: 'approved',
    } as DesignCatalogParams);
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('draft');
  });

  // TC-ADD-11: Path traversal rejected (P0)
  it('TC-ADD-11: path traversal in screen rejected', async () => {
    const result = await call({
      action: 'add',
      screen: '../../../etc',
      description: 'attack',
      html: '../../etc/passwd',
      screenshot: 'x.png',
    });
    expect(result.success).toBe(false);
  });
});

// ── VERSION Tests ───────────────────────────────────────────────────────────

describe('version action', () => {
  // TC-VER-01: Creates new version with incremented number (P0)
  it('TC-VER-01: increments version number', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
    });

    expect(result.success).toBe(true);
    const artifact = result.artifact as Record<string, unknown>;
    expect(artifact.currentVersion).toBe(2);
    expect((artifact.versions as unknown[]).length).toBe(2);
  });

  // TC-VER-02: Previous version auto-superseded (P0)
  it('TC-VER-02: previous version superseded', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
    });

    const artifact = result.artifact as { versions: Array<{ version: number; supersededBy?: number; supersededAt?: string }> };
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    expect(v1.supersededBy).toBe(2);
    expect(v1.supersededAt).toBeTruthy();
  });

  // TC-VER-03: Reason stored in supersededReason (P1)
  it('TC-VER-03: reason stored on superseded version', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
      reason: 'Spacing too tight',
    });

    const artifact = result.artifact as { versions: Array<{ version: number; supersededReason?: string }> };
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    expect(v1.supersededReason).toBe('Spacing too tight');
  });

  // TC-VER-04: No reason still supersedes cleanly (P1)
  it('TC-VER-04: no reason still supersedes', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
    });

    expect(result.success).toBe(true);
    const artifact = result.artifact as { versions: Array<{ version: number; supersededBy?: number }> };
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    expect(v1.supersededBy).toBe(2);
  });

  // TC-VER-05: Non-existent screen returns error (P0)
  it('TC-VER-05: non-existent screen errors', async () => {
    await createFile('screens/settings/v1.html');
    await createFile('screens/settings/v1.png');
    const result = await call({
      action: 'version',
      screen: 'settings',
      html: 'screens/settings/v1.html',
      screenshot: 'screens/settings/v1.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.error).toContain("add");
  });

  // TC-VER-06: File validation before write (P0)
  it('TC-VER-06: files validated before mutation', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    // v2.png does NOT exist

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('v2.png');

    // Verify no mutation
    const show = await call({ action: 'show', screen: 'dashboard' });
    expect((show.artifact as Record<string, unknown>).currentVersion).toBe(1);
  });

  // TC-VER-07: Status resets to draft (P0)
  it('TC-VER-07: status resets to draft', async () => {
    await addArtifact('dashboard');
    // Move to review then approved
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved' });

    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    const result = await call({
      action: 'version',
      screen: 'dashboard',
      html: 'screens/dashboard/v2.html',
      screenshot: 'screens/dashboard/v2.png',
    });

    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('draft');
  });

  // TC-VER-08: Three versions build correct chain (P1)
  it('TC-VER-08: three versions build correct chain', async () => {
    await addArtifact('dashboard');

    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v2.html', screenshot: 'screens/dashboard/v2.png' });

    await createFile('screens/dashboard/v3.html');
    await createFile('screens/dashboard/v3.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v3.html', screenshot: 'screens/dashboard/v3.png' });

    const show = await call({ action: 'show', screen: 'dashboard' });
    const artifact = show.artifact as { currentVersion: number; versions: Array<{ version: number; supersededBy?: number }> };

    expect(artifact.currentVersion).toBe(3);
    expect(artifact.versions).toHaveLength(3);

    const v1 = artifact.versions.find((v) => v.version === 1)!;
    const v2 = artifact.versions.find((v) => v.version === 2)!;
    const v3 = artifact.versions.find((v) => v.version === 3)!;

    expect(v1.supersededBy).toBe(2);
    expect(v2.supersededBy).toBe(3);
    expect(v3.supersededBy).toBeUndefined();
  });

  // TC-VER-09: Missing screen returns error (P0)
  it('TC-VER-09: missing screen returns error', async () => {
    const result = await call({
      action: 'version',
      html: 'x.html',
      screenshot: 'x.png',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('screen');
  });
});

// ── STATUS Tests ────────────────────────────────────────────────────────────

describe('status action', () => {
  // TC-STS-01: draft → review (P0)
  it('TC-STS-01: draft → review succeeds', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard', status: 'review' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('review');
  });

  // TC-STS-02: review → approved with metadata (P0)
  it('TC-STS-02: review → approved stores metadata', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });

    const result = await call({
      action: 'status',
      screen: 'dashboard',
      status: 'approved',
      approvedBy: 'jaksa',
      notes: 'Looks great, ship it',
    });

    expect(result.success).toBe(true);
    const artifact = result.artifact as { status: string; versions: Array<{ version: number; approvedAt?: string; approvedBy?: string; notes?: string }> };
    expect(artifact.status).toBe('approved');
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    expect(v1.approvedAt).toBeTruthy();
    expect(v1.approvedBy).toBe('jaksa');
    expect(v1.notes).toBe('Looks great, ship it');
  });

  // TC-STS-03: Approval without approvedBy (P1)
  it('TC-STS-03: approval without approvedBy succeeds', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    const result = await call({ action: 'status', screen: 'dashboard', status: 'approved' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('approved');
  });

  // TC-STS-04: review → rejected (P0)
  it('TC-STS-04: review → rejected succeeds', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    const result = await call({
      action: 'status',
      screen: 'dashboard',
      status: 'rejected',
      notes: "Colors don't match brand",
    });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('rejected');
  });

  // TC-STS-05: approved → implemented (P0)
  it('TC-STS-05: approved → implemented succeeds', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved' });
    const result = await call({ action: 'status', screen: 'dashboard', status: 'implemented' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('implemented');
  });

  // TC-STS-06: rejected → draft (P0)
  it('TC-STS-06: rejected → draft succeeds', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'rejected', notes: 'Bad colors' });
    const result = await call({ action: 'status', screen: 'dashboard', status: 'draft' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).status).toBe('draft');
  });

  // TC-STS-07: draft → implemented invalid (P0)
  it('TC-STS-07: draft → implemented returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard', status: 'implemented' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('review');
  });

  // TC-STS-08: draft → approved invalid (P0)
  it('TC-STS-08: draft → approved returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard', status: 'approved' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('review');
  });

  // TC-STS-09: approved → draft invalid (P1)
  it('TC-STS-09: approved → draft returns error', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved' });
    const result = await call({ action: 'status', screen: 'dashboard', status: 'draft' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('implemented');
  });

  // TC-STS-10: implemented → anything is error (P1)
  it('TC-STS-10: implemented is terminal', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved' });
    await call({ action: 'status', screen: 'dashboard', status: 'implemented' });

    for (const status of ['draft', 'review', 'approved', 'rejected']) {
      const result = await call({ action: 'status', screen: 'dashboard', status });
      expect(result.success).toBe(false);
      expect(result.error).toContain('terminal');
    }
  });

  // TC-STS-11: Same status is error (P1)
  it('TC-STS-11: same status returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard', status: 'draft' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
  });

  // TC-STS-12: Non-existent screen (P0)
  it('TC-STS-12: non-existent screen returns error', async () => {
    const result = await call({ action: 'status', screen: 'profile', status: 'review' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TC-STS-13: Missing status param (P0)
  it('TC-STS-13: missing status param returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('status');
  });

  // TC-STS-14: Unknown status value (P0)
  it('TC-STS-14: unknown status value returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'status', screen: 'dashboard', status: 'wip' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('wip');
    expect(result.error).toContain('draft');
  });
});

// ── LINK Tests ──────────────────────────────────────────────────────────────

describe('link action', () => {
  // TC-LNK-01: Link to MC task (P0)
  it('TC-LNK-01: link to MC task', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-abc123' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).mcTaskId).toBe('task-abc123');
  });

  // TC-LNK-02: Link to MC objective (P0)
  it('TC-LNK-02: link to MC objective', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'link', screen: 'dashboard', mcObjectiveId: 'obj-xyz789' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).mcObjectiveId).toBe('obj-xyz789');
  });

  // TC-LNK-03: Link both in one call (P1)
  it('TC-LNK-03: link both task and objective', async () => {
    await addArtifact('dashboard');
    const result = await call({
      action: 'link',
      screen: 'dashboard',
      mcTaskId: 'task-abc',
      mcObjectiveId: 'obj-xyz',
    });
    expect(result.success).toBe(true);
    const a = result.artifact as Record<string, unknown>;
    expect(a.mcTaskId).toBe('task-abc');
    expect(a.mcObjectiveId).toBe('obj-xyz');
  });

  // TC-LNK-04: Update existing link (P1)
  it('TC-LNK-04: update existing link', async () => {
    await addArtifact('dashboard');
    await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-old' });
    const result = await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-new' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).mcTaskId).toBe('task-new');
  });

  // TC-LNK-05: Remove link by passing null (P1)
  it('TC-LNK-05: remove link by null', async () => {
    await addArtifact('dashboard');
    await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-abc' });
    const result = await call({ action: 'link', screen: 'dashboard', mcTaskId: null });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).mcTaskId).toBeNull();
  });

  // TC-LNK-06: No link fields returns error (P1)
  it('TC-LNK-06: no link fields returns error', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'link', screen: 'dashboard' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('mcTaskId');
  });

  // TC-LNK-07: Stores IDs without validation (P0)
  it('TC-LNK-07: stores IDs without validation', async () => {
    await addArtifact('dashboard');
    const result = await call({ action: 'link', screen: 'dashboard', mcTaskId: 'nonexistent-task-id-999' });
    expect(result.success).toBe(true);
    expect((result.artifact as Record<string, unknown>).mcTaskId).toBe('nonexistent-task-id-999');
  });

  // TC-LNK-08: Non-existent screen (P0)
  it('TC-LNK-08: non-existent screen errors', async () => {
    const result = await call({ action: 'link', screen: 'profile', mcTaskId: 'task-abc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TC-LNK-09: Missing screen (P0)
  it('TC-LNK-09: missing screen returns error', async () => {
    const result = await call({ action: 'link', mcTaskId: 'task-abc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('screen');
  });
});

// ── SHOW Tests ──────────────────────────────────────────────────────────────

describe('show action', () => {
  // TC-SHOW-01: Full detail for existing screen (P0)
  it('TC-SHOW-01: returns full detail', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v2.html', screenshot: 'screens/dashboard/v2.png' });
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved', approvedBy: 'jaksa' });
    await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-abc', mcObjectiveId: 'obj-xyz' });

    const result = await call({ action: 'show', screen: 'dashboard' });
    expect(result.success).toBe(true);
    const a = result.artifact as Record<string, unknown>;
    expect(a.id).toBeTruthy();
    expect(a.screen).toBe('dashboard');
    expect(a.currentVersion).toBe(2);
    expect(a.status).toBe('approved');
    expect(a.mcTaskId).toBe('task-abc');
    expect(a.mcObjectiveId).toBe('obj-xyz');
    expect(a.createdAt).toBeTruthy();
    expect(a.updatedAt).toBeTruthy();
    expect((a.versions as unknown[]).length).toBe(2);
  });

  // TC-SHOW-02: Version chain correct (P0)
  it('TC-SHOW-02: supersededBy chain correct', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v2.html', screenshot: 'screens/dashboard/v2.png' });
    await createFile('screens/dashboard/v3.html');
    await createFile('screens/dashboard/v3.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v3.html', screenshot: 'screens/dashboard/v3.png' });

    const result = await call({ action: 'show', screen: 'dashboard' });
    const artifact = result.artifact as { versions: Array<{ version: number; supersededBy?: number }> };
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    const v2 = artifact.versions.find((v) => v.version === 2)!;
    const v3 = artifact.versions.find((v) => v.version === 3)!;
    expect(v1.supersededBy).toBe(2);
    expect(v2.supersededBy).toBe(3);
    expect(v3.supersededBy).toBeUndefined();
  });

  // TC-SHOW-03: MC links present (P1)
  it('TC-SHOW-03: MC links present', async () => {
    await addArtifact('dashboard');
    await call({ action: 'link', screen: 'dashboard', mcTaskId: 'task-abc', mcObjectiveId: 'obj-xyz' });
    const result = await call({ action: 'show', screen: 'dashboard' });
    const a = result.artifact as Record<string, unknown>;
    expect(a.mcTaskId).toBe('task-abc');
    expect(a.mcObjectiveId).toBe('obj-xyz');
  });

  // TC-SHOW-04: Non-existent screen (P0)
  it('TC-SHOW-04: non-existent screen errors', async () => {
    const result = await call({ action: 'show', screen: 'profile' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TC-SHOW-05: Missing screen (P0)
  it('TC-SHOW-05: missing screen errors', async () => {
    const result = await call({ action: 'show' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('screen');
  });

  // TC-SHOW-07: Approval metadata visible (P1)
  it('TC-SHOW-07: approval metadata visible', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    await call({ action: 'status', screen: 'dashboard', status: 'approved', approvedBy: 'jaksa', notes: 'LGTM' });

    const result = await call({ action: 'show', screen: 'dashboard' });
    const artifact = result.artifact as { versions: Array<{ version: number; approvedAt?: string; approvedBy?: string; notes?: string }> };
    const v1 = artifact.versions.find((v) => v.version === 1)!;
    expect(v1.approvedAt).toBeTruthy();
    expect(v1.approvedBy).toBe('jaksa');
    expect(v1.notes).toBe('LGTM');
  });
});

// ── REMOVE Tests ────────────────────────────────────────────────────────────

describe('remove action', () => {
  // TC-REM-01: Remove existing artifact (P0)
  it('TC-REM-01: remove existing artifact', async () => {
    await addArtifact('dashboard');
    await addArtifact('settings');

    const result = await call({ action: 'remove', screen: 'dashboard' });
    expect(result.success).toBe(true);
    expect((result.removed as Record<string, unknown>).screen).toBe('dashboard');

    const list = await call({ action: 'list' });
    expect((list.artifacts as unknown[]).length).toBe(1);

    const show = await call({ action: 'show', screen: 'dashboard' });
    expect(show.success).toBe(false);
  });

  // TC-REM-02: Non-existent screen (P0)
  it('TC-REM-02: non-existent screen errors', async () => {
    const result = await call({ action: 'remove', screen: 'profile' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TC-REM-03: Default doesn't delete files (P1)
  it('TC-REM-03: default preserves files on disk', async () => {
    await addArtifact('dashboard');
    const htmlPath = path.join(tmpDir, 'screens/dashboard/v1.html');
    await call({ action: 'remove', screen: 'dashboard' });
    const exists = await fs.access(htmlPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  // TC-REM-04: deleteFiles removes files (P1)
  it('TC-REM-04: deleteFiles removes files', async () => {
    await addArtifact('dashboard');
    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');
    await call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v2.html', screenshot: 'screens/dashboard/v2.png' });

    await call({ action: 'remove', screen: 'dashboard', deleteFiles: true });

    const v1html = await fs.access(path.join(tmpDir, 'screens/dashboard/v1.html')).then(() => true).catch(() => false);
    const v2html = await fs.access(path.join(tmpDir, 'screens/dashboard/v2.html')).then(() => true).catch(() => false);
    expect(v1html).toBe(false);
    expect(v2html).toBe(false);
  });

  // TC-REM-06: Missing screen (P0)
  it('TC-REM-06: missing screen returns error', async () => {
    const result = await call({ action: 'remove' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('screen');
  });

  // TC-REM-07: Remove last artifact leaves catalog intact (P1)
  it('TC-REM-07: remove last leaves catalog intact', async () => {
    await addArtifact('dashboard');
    await call({ action: 'remove', screen: 'dashboard' });

    const catalogPath = path.join(tmpDir, 'design-artifacts', 'catalog.json');
    const exists = await fs.access(catalogPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const list = await call({ action: 'list' });
    expect(list.success).toBe(true);
    expect(list.artifacts).toEqual([]);
  });
});

// ── CROSS-CUTTING Tests ─────────────────────────────────────────────────────

describe('cross-cutting', () => {
  // TC-CROSS-01: Invalid action (P0)
  it('TC-CROSS-01: invalid action returns error', async () => {
    const result = await call({ action: 'upsert' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('upsert');
    expect(result.error).toContain('list');
  });

  // TC-CROSS-02: Missing action (P0)
  it('TC-CROSS-02: missing action returns error', async () => {
    const result = await call({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('action');
  });

  // TC-CROSS-03: Auto-init on first write (P0)
  it('TC-CROSS-03: auto-init on first add', async () => {
    await createFile('screens/dashboard/v1.html');
    await createFile('screens/dashboard/v1.png');
    const result = await call({
      action: 'add',
      screen: 'dashboard',
      description: 'desc',
      html: 'screens/dashboard/v1.html',
      screenshot: 'screens/dashboard/v1.png',
    });
    expect(result.success).toBe(true);
    const catalogPath = path.join(tmpDir, 'design-artifacts', 'catalog.json');
    const stat = await fs.stat(catalogPath);
    expect(stat.isFile()).toBe(true);
  });

  // TC-CROSS-04: Read actions auto-init (P0)
  it('TC-CROSS-04: read actions auto-init', async () => {
    // list auto-inits
    const list = await call({ action: 'list' });
    expect(list.success).toBe(true);
    expect(list.artifacts).toEqual([]);

    // show returns not found (not catalog error)
    const show = await call({ action: 'show', screen: 'anything' });
    expect(show.success).toBe(false);
    expect(show.error).toContain('not found');
  });

  // TC-CROSS-05: Concurrent adds don't produce duplicates (P0)
  it('TC-CROSS-05: concurrent adds produce unique IDs', async () => {
    await createFile('screens/a/v1.html');
    await createFile('screens/a/v1.png');
    await createFile('screens/b/v1.html');
    await createFile('screens/b/v1.png');
    await createFile('screens/c/v1.html');
    await createFile('screens/c/v1.png');

    await Promise.all([
      call({ action: 'add', screen: 'a', description: 'a', html: 'screens/a/v1.html', screenshot: 'screens/a/v1.png' }),
      call({ action: 'add', screen: 'b', description: 'b', html: 'screens/b/v1.html', screenshot: 'screens/b/v1.png' }),
      call({ action: 'add', screen: 'c', description: 'c', html: 'screens/c/v1.html', screenshot: 'screens/c/v1.png' }),
    ]);

    const list = await call({ action: 'list' });
    expect((list.artifacts as unknown[]).length).toBe(3);

    // All IDs unique
    const ids = (list.artifacts as Array<{ id: string }>).map((a) => a.id);
    expect(new Set(ids).size).toBe(3);

    // Catalog is valid JSON
    const raw = await fs.readFile(path.join(tmpDir, 'design-artifacts', 'catalog.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  // TC-CROSS-06: Concurrent status + version (P1)
  it('TC-CROSS-06: concurrent status and version safe', async () => {
    await addArtifact('dashboard');
    await call({ action: 'status', screen: 'dashboard', status: 'review' });

    await createFile('screens/dashboard/v2.html');
    await createFile('screens/dashboard/v2.png');

    await Promise.all([
      call({ action: 'status', screen: 'dashboard', status: 'approved' }),
      call({ action: 'version', screen: 'dashboard', html: 'screens/dashboard/v2.html', screenshot: 'screens/dashboard/v2.png' }),
    ]);

    // Catalog should be valid JSON
    const raw = await fs.readFile(path.join(tmpDir, 'design-artifacts', 'catalog.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();

    const show = await call({ action: 'show', screen: 'dashboard' });
    expect(show.success).toBe(true);
  });

  // TC-CROSS-07: projectRoot defaults (P1)
  it('TC-CROSS-07: uses default project root', async () => {
    // call without projectRoot — designCatalog uses defaultProjectRoot (tmpDir)
    const result = await designCatalog({ action: 'list' }, tmpDir);
    expect(result.success).toBe(true);
  });

  // TC-CROSS-08: Error responses have consistent structure (P1)
  it('TC-CROSS-08: consistent error structure', async () => {
    const errors = [
      await call({}), // missing action
      await call({ action: 'upsert' }), // invalid action
      await call({ action: 'show' }), // missing screen
      await call({ action: 'show', screen: 'nope' }), // not found
      await call({ action: 'status', screen: 'nope', status: 'review' }), // not found
    ];

    for (const result of errors) {
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(typeof result.code).toBe('string');
    }
  });

  // TC-CROSS-10: Case-sensitive screen names (P1)
  it('TC-CROSS-10: screen names are case-sensitive', async () => {
    await addArtifact('Dashboard');
    const result = await call({ action: 'show', screen: 'dashboard' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  // TC-CROSS-12: Empty screen name rejected (P1)
  it('TC-CROSS-12: empty screen name rejected', async () => {
    const result = await call({ action: 'show', screen: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });

  // TC-CROSS-13: updatedAt refreshed on mutations (P1)
  it('TC-CROSS-13: updatedAt refreshed on mutations', async () => {
    const addResult = await addArtifact('dashboard');
    const createdAt = (addResult.artifact as Record<string, unknown>).updatedAt as string;

    // Small delay
    await new Promise((r) => setTimeout(r, 5));

    await call({ action: 'status', screen: 'dashboard', status: 'review' });
    const show = await call({ action: 'show', screen: 'dashboard' });
    const updatedAt = (show.artifact as Record<string, unknown>).updatedAt as string;

    expect(new Date(updatedAt).getTime()).toBeGreaterThan(new Date(createdAt).getTime());
  });
});
