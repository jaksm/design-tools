/**
 * Stitch Native Tools tests — P0 + P1 test cases
 * Implements test cases from test-cases-stitch-tools.md
 *
 * Mock strategy:
 * - StitchClient.callTool is mocked at the boundary
 * - fetch is mocked for download operations
 * - Real filesystem (temp dirs) for catalog + registry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  designGenerate,
  designEdit,
  designGet,
  designProjects,
  designScreens,
  designCreateProject,
  createStitchToolsContext,
  type DesignGenerateParams,
  type DesignEditParams,
  type DesignGetParams,
  type DesignCreateProjectParams,
  type StitchToolsContext,
} from '../../src/tools/stitch-tools.js';
import { StitchClient } from '../../src/core/stitch-client.js';
import {
  StitchError,
  StitchAuthError,
  StitchRateLimitError,
} from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let ctx: StitchToolsContext;
let mockCallTool: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.spyOn>;

const DEFAULT_PROJECT_ID = 'default-proj-id';

function makeStitchScreenResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'screen-abc',
    title: 'Login Screen',
    prompt: 'A login screen',
    width: '390',
    height: '844',
    deviceType: 'MOBILE',
    name: 'projects/proj-123/screens/screen-abc',
    theme: { colorMode: 'LIGHT', font: 'Roboto', roundness: 'MEDIUM' },
    screenMetadata: { agentType: 'PRO_AGENT', status: 'COMPLETE' },
    htmlCode: {
      name: 'projects/proj-123/files/html-hash',
      downloadUrl: 'https://cdn.example.com/html-file.html',
      mimeType: 'text/html',
    },
    screenshot: {
      name: 'projects/proj-123/files/screenshot-hash',
      downloadUrl: 'https://cdn.example.com/screenshot.png',
    },
    ...overrides,
  };
}

function mockFetchForDownloads() {
  fetchSpy.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    if (urlStr.includes('html')) {
      return new Response('<html><body>Test screen</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (urlStr.includes('screenshot') || urlStr.includes('png')) {
      return new Response(Buffer.from('fake-png-data'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

async function readCatalog() {
  try {
    const raw = await fs.readFile(path.join(tmpDir, 'design-artifacts', 'catalog.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, artifacts: [] };
  }
}

async function readRegistry() {
  try {
    const raw = await fs.readFile(path.join(tmpDir, 'design-artifacts', 'screen-registry.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { screens: [] };
  }
}

async function seedCatalogWithScreen(
  screen: string,
  screenId: string,
  projectId: string,
  version = 1,
) {
  const catalogDir = path.join(tmpDir, 'design-artifacts');
  await fs.mkdir(catalogDir, { recursive: true });

  const htmlPath = `design-artifacts/screens/${screen}/v${version}.html`;
  const ssPath = `design-artifacts/screens/${screen}/v${version}.png`;

  // Create actual files
  const screenDir = path.join(tmpDir, 'design-artifacts', 'screens', screen);
  await fs.mkdir(screenDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, htmlPath), '<html>test</html>');
  await fs.writeFile(path.join(tmpDir, ssPath), 'fake-png');

  const catalog = {
    version: 1,
    artifacts: [
      {
        id: `${screen}-v${version}`,
        screen,
        description: `${screen} screen`,
        status: 'draft',
        currentVersion: version,
        versions: [
          {
            version,
            html: htmlPath,
            screenshot: ssPath,
            createdAt: new Date().toISOString(),
          },
        ],
        stitch: { projectId, screenId },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  await fs.writeFile(path.join(catalogDir, 'catalog.json'), JSON.stringify(catalog, null, 2));

  // Also register in screen registry
  const registry = {
    screens: [
      {
        id: screenId,
        title: screen.charAt(0).toUpperCase() + screen.slice(1),
        screen,
        projectId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentVersion: version,
        files: { html: htmlPath, screenshot: ssPath },
      },
    ],
  };
  await fs.writeFile(path.join(catalogDir, 'screen-registry.json'), JSON.stringify(registry, null, 2));
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stitch-tools-test-'));

  // Create a real StitchClient then mock its callTool method
  const client = new StitchClient({ apiKey: 'test-api-key' });
  mockCallTool = vi.fn();
  client.callTool = mockCallTool;

  ctx = createStitchToolsContext(client, tmpDir, DEFAULT_PROJECT_ID);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  mockFetchForDownloads();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. design_generate
// ═══════════════════════════════════════════════════════════════════════════

describe('design_generate', () => {
  // TC-GEN-01
  it('TC-GEN-01: successful generation with only required prompt', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'A login screen with email and password fields' }, ctx);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty('screenId', 'screen-abc');
    expect(result).toHaveProperty('files');
    expect((result as any).files.html).toMatch(/\.html$/);
    expect((result as any).files.screenshot).toMatch(/\.png$/);
    expect(result).toHaveProperty('catalogEntry');
    expect((result as any).catalogEntry.status).toBe('draft');

    // Verify callTool was called correctly
    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      prompt: 'A login screen with email and password fields',
      projectId: DEFAULT_PROJECT_ID,
    }));

    // Verify files exist on disk
    const htmlFullPath = path.resolve(tmpDir, (result as any).files.html);
    const ssFullPath = path.resolve(tmpDir, (result as any).files.screenshot);
    await expect(fs.access(htmlFullPath)).resolves.toBeUndefined();
    await expect(fs.access(ssFullPath)).resolves.toBeUndefined();
  });

  // TC-GEN-02
  it('TC-GEN-02: generation with all optional parameters', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ title: 'Dashboard' }));

    const result = await designGenerate({
      prompt: 'Dashboard screen',
      projectId: 'proj-123',
      title: 'Main Dashboard',
      platform: 'web',
      colorMode: 'dark',
      customColor: '#0A0A0A',
    }, ctx);

    expect(result.success).toBe(true);

    // Check Stitch received correct mapped args
    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      prompt: 'Dashboard screen',
      projectId: 'proj-123',
      deviceType: 'DESKTOP',
      colorMode: 'dark',
      customColor: '#0A0A0A',
    }));

    // File paths use the explicit title's slug
    expect((result as any).files.html).toContain('main-dashboard');
    expect((result as any).catalogEntry.screen).toBe('main-dashboard');
  });

  // TC-GEN-03
  it('TC-GEN-03: platform ios maps to MOBILE', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designGenerate({ prompt: 'Settings screen', platform: 'ios' }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      deviceType: 'MOBILE',
    }));
  });

  // TC-GEN-04
  it('TC-GEN-04: platform android maps to MOBILE', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designGenerate({ prompt: 'Home screen', platform: 'android' }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      deviceType: 'MOBILE',
    }));
  });

  // TC-GEN-05
  it('TC-GEN-05: platform web maps to DESKTOP', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designGenerate({ prompt: 'Landing page', platform: 'web' }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      deviceType: 'DESKTOP',
    }));
  });

  // TC-GEN-06
  it('TC-GEN-06: uses default projectId when not provided', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'Splash screen' }, ctx);

    expect(result.success).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      projectId: DEFAULT_PROJECT_ID,
    }));
  });

  // TC-GEN-07
  it('TC-GEN-07: no default projectId AND no projectId returns error', async () => {
    const ctxNoDefault = createStitchToolsContext(
      new StitchClient({ apiKey: 'test-key' }),
      tmpDir,
      undefined, // no default
    );

    const result = await designGenerate({ prompt: 'Splash screen' }, ctxNoDefault);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('No projectId provided');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-GEN-08
  it('TC-GEN-08: missing required prompt returns error', async () => {
    const result = await designGenerate({ projectId: 'proj-123' } as any, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('prompt');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-GEN-09
  it('TC-GEN-09: empty string prompt is rejected', async () => {
    const result = await designGenerate({ prompt: '' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('empty');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-GEN-10
  it('TC-GEN-10: title auto-derived from Stitch response when not provided', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ title: 'Login Screen' }));

    const result = await designGenerate({ prompt: 'A login screen' }, ctx);

    expect(result.success).toBe(true);
    expect((result as any).files.html).toContain('login-screen');
    expect((result as any).catalogEntry.screen).toBe('login-screen');
  });

  // TC-GEN-11
  it('TC-GEN-11: explicit title takes precedence over Stitch-returned title', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ title: 'Something Stitch Named This' }));

    const result = await designGenerate({ prompt: '...', title: 'My Custom Title' }, ctx);

    expect(result.success).toBe(true);
    expect((result as any).files.html).toContain('my-custom-title');
    expect((result as any).catalogEntry.screen).toBe('my-custom-title');
  });

  // TC-GEN-12
  it('TC-GEN-12: special characters in title are safely slugified', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: '...', title: "User's Profile & Settings!" }, ctx);

    expect(result.success).toBe(true);
    const htmlPath = (result as any).files.html as string;
    expect(htmlPath).not.toContain("'");
    expect(htmlPath).not.toContain('&');
    expect(htmlPath).not.toContain('!');
    expect(htmlPath).not.toContain('..');
    expect(htmlPath).toMatch(/^design-artifacts\/screens\/[a-z0-9-]+\//);
  });

  // TC-GEN-13
  it('TC-GEN-13: HTML file saved with correct content', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    const htmlContent = '<html><body>Login screen</body></html>';
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('html')) {
        return new Response(htmlContent, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png' } });
    });

    const result = await designGenerate({ prompt: 'Login', title: 'Login' }, ctx);
    expect(result.success).toBe(true);

    const fullPath = path.resolve(tmpDir, (result as any).files.html);
    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(htmlContent);
  });

  // TC-GEN-14
  it('TC-GEN-14: screenshot PNG saved to expected path', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'Login', title: 'Login' }, ctx);
    expect(result.success).toBe(true);

    const ssPath = path.resolve(tmpDir, (result as any).files.screenshot);
    const stat = await fs.stat(ssPath);
    expect(stat.size).toBeGreaterThan(0);
    expect((result as any).files.screenshot).toMatch(/v1\.png$/);
  });

  // TC-GEN-15
  it('TC-GEN-15: catalog entry created after successful generation', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'Dashboard', title: 'Dashboard' }, ctx);
    expect(result.success).toBe(true);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'dashboard');
    expect(artifact).toBeDefined();
    expect(artifact.status).toBe('draft');
    expect(artifact.currentVersion).toBe(1);
    expect(artifact.stitch.screenId).toBe('screen-abc');
  });

  // TC-GEN-16
  it('TC-GEN-16: response includes all expected fields', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'Splash screen', title: 'Splash' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screenId).toBe('screen-abc');
    expect(result.title).toBe('Splash');
    expect(result.files).toHaveProperty('html');
    expect(result.files).toHaveProperty('screenshot');
    expect(result.files.html).toMatch(/^design-artifacts\//);
    expect(result.catalogEntry).toHaveProperty('id');
    expect(result.catalogEntry).toHaveProperty('screen', 'splash');
    expect(result.catalogEntry).toHaveProperty('status', 'draft');
    expect(result.catalogEntry).toHaveProperty('currentVersion', 1);
  });

  // TC-GEN-17
  it('TC-GEN-17: Stitch API error is handled gracefully', async () => {
    mockCallTool.mockRejectedValue(new StitchError('Internal error', { statusCode: 500 }));

    const result = await designGenerate({ prompt: 'test' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Stitch API error');
    expect((result as any).code).toBe('STITCH_API_ERROR');

    // No partial files or catalog entries
    const catalog = await readCatalog();
    expect(catalog.artifacts).toHaveLength(0);
  });

  // TC-GEN-18
  it('TC-GEN-18: download HTML failure → error with cleanup', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('html')) {
        throw new Error('Network error downloading HTML');
      }
      return new Response(Buffer.from('png'), { status: 200 });
    });

    const result = await designGenerate({ prompt: 'test', title: 'FailedHtml' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Failed to download HTML');

    // No catalog entry
    const catalog = await readCatalog();
    expect(catalog.artifacts).toHaveLength(0);
  });

  // TC-GEN-19
  it('TC-GEN-19: download screenshot failure → error with cleanup', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('html')) {
        return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (urlStr.includes('screenshot') || urlStr.includes('png')) {
        throw new Error('Screenshot download failed');
      }
      return new Response('', { status: 404 });
    });

    const result = await designGenerate({ prompt: 'test', title: 'FailedSS' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Failed to download screenshot');

    // No catalog entry
    const catalog = await readCatalog();
    expect(catalog.artifacts).toHaveLength(0);

    // HTML file should be cleaned up too
    const screenDir = path.join(tmpDir, 'design-artifacts', 'screens', 'failedss');
    try {
      await fs.access(screenDir);
      // If dir exists, it should be empty (cleaned up)
      const files = await fs.readdir(screenDir);
      expect(files).toHaveLength(0);
    } catch {
      // Dir doesn't exist — that's fine (cleanup removed it)
    }
  });

  // TC-GEN-21
  it('TC-GEN-21: concurrent calls with same title use unique entries', async () => {
    let callCount = 0;
    mockCallTool.mockImplementation(async () => {
      callCount++;
      return makeStitchScreenResponse({ id: `screen-${callCount}`, title: 'Login' });
    });

    const [r1, r2] = await Promise.all([
      designGenerate({ prompt: 'Login A' }, ctx),
      designGenerate({ prompt: 'Login B' }, ctx),
    ]);

    // At least one should succeed, and if both use same slug, second may fail with duplicate
    const results = [r1, r2];
    const successes = results.filter((r) => r.success);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    const catalog = await readCatalog();
    // catalog.json should be valid JSON with correct entries
    expect(catalog.version).toBe(1);
  });

  // TC-GEN-22
  it('TC-GEN-22: colorMode forwarded to Stitch', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designGenerate({ prompt: '...', colorMode: 'dark' }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('generate_screen_from_text', expect.objectContaining({
      colorMode: 'dark',
    }));
  });

  // TC-GEN-23
  it('TC-GEN-23: invalid platform value returns error', async () => {
    const result = await designGenerate({ prompt: '...', platform: 'blackberry' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Invalid platform');
    expect((result as any).error).toContain('blackberry');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-GEN-24
  it('TC-GEN-24: invalid colorMode value returns error', async () => {
    const result = await designGenerate({ prompt: '...', colorMode: 'midnight' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Invalid colorMode');
    expect((result as any).error).toContain('midnight');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. design_edit
// ═══════════════════════════════════════════════════════════════════════════

describe('design_edit', () => {
  // TC-EDIT-01
  it('TC-EDIT-01: successful edit with required params', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({
      htmlCode: { downloadUrl: 'https://cdn.example.com/html-v2.html' },
      screenshot: { downloadUrl: 'https://cdn.example.com/screenshot-v2.png' },
    }));

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'Change the button color to blue',
    }, ctx);

    expect(result.success).toBe(true);
    expect((result as any).screenId).toBe('screen-abc');
    expect((result as any).version).toBe(2);

    // Verify Stitch was called correctly
    expect(mockCallTool).toHaveBeenCalledWith('edit_screens', expect.objectContaining({
      projectId: 'proj-123',
      screenIds: ['screen-abc'],
      prompt: 'Change the button color to blue',
    }));
  });

  // TC-EDIT-02
  it('TC-EDIT-02: missing screenId returns error', async () => {
    const result = await designEdit({ editPrompt: 'Make it darker' } as any, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('screenId');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-EDIT-03
  it('TC-EDIT-03: missing editPrompt returns error', async () => {
    const result = await designEdit({ screenId: 'screen-abc' } as any, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('editPrompt');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-EDIT-04
  it('TC-EDIT-04: unknown screenId not in registry returns error', async () => {
    const result = await designEdit({
      screenId: 'screen-xyz',
      editPrompt: 'test',
    }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('screen-xyz');
    expect((result as any).error).toContain('not found');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-EDIT-05
  it('TC-EDIT-05: explicit projectId overrides registry value', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-old');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test',
      projectId: 'proj-new',
    }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('edit_screens', expect.objectContaining({
      projectId: 'proj-new',
    }));
  });

  // TC-EDIT-06
  it('TC-EDIT-06: edit creates new version (v2) in catalog', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'Add forgot password link',
    }, ctx);

    expect(result.success).toBe(true);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact).toBeDefined();
    expect(artifact.currentVersion).toBe(2);
    expect(artifact.versions).toHaveLength(2);
  });

  // TC-EDIT-07
  it('TC-EDIT-07: edit auto-versions with editPrompt as superseded reason', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'Increase font size to 18px',
    }, ctx);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    const v1 = artifact.versions.find((v: any) => v.version === 1);
    expect(v1.supersededReason).toBe('Increase font size to 18px');
  });

  // TC-EDIT-08
  it('TC-EDIT-08: new version files saved at correct paths', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test',
    }, ctx);

    expect(result.success).toBe(true);
    expect((result as any).files.html).toContain('v2.html');
    expect((result as any).files.screenshot).toContain('v2.png');

    // v2 files exist
    await expect(fs.access(path.resolve(tmpDir, (result as any).files.html))).resolves.toBeUndefined();
    await expect(fs.access(path.resolve(tmpDir, (result as any).files.screenshot))).resolves.toBeUndefined();

    // v1 files still exist
    await expect(fs.access(path.join(tmpDir, 'design-artifacts', 'screens', 'login', 'v1.html'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, 'design-artifacts', 'screens', 'login', 'v1.png'))).resolves.toBeUndefined();
  });

  // TC-EDIT-09
  it('TC-EDIT-09: Stitch API error during edit → catalog unchanged', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockRejectedValue(new StitchError('Internal error', { statusCode: 500 }));

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test',
    }, ctx);

    expect(result.success).toBe(false);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact.currentVersion).toBe(1);
  });

  // TC-EDIT-10
  it('TC-EDIT-10: download failure during edit → catalog unchanged', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    fetchSpy.mockImplementation(async () => {
      throw new Error('Network timeout');
    });

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test',
    }, ctx);

    expect(result.success).toBe(false);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact.currentVersion).toBe(1);
    // v1 should NOT be superseded
    const v1 = artifact.versions.find((v: any) => v.version === 1);
    expect(v1.supersededBy).toBeUndefined();
  });

  // TC-EDIT-11
  it('TC-EDIT-11: edit_screens called with array of screenIds', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test',
    }, ctx);

    const callArgs = mockCallTool.mock.calls[0]!;
    expect(callArgs[0]).toBe('edit_screens');
    expect(callArgs[1].screenIds).toEqual(['screen-abc']);
  });

  // TC-EDIT-12
  it('TC-EDIT-12: multiple consecutive edits build correct version chain', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({ screenId: 'screen-abc', editPrompt: 'First edit' }, ctx);
    await designEdit({ screenId: 'screen-abc', editPrompt: 'Second edit' }, ctx);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact.currentVersion).toBe(3);
    expect(artifact.versions).toHaveLength(3);

    const v1 = artifact.versions.find((v: any) => v.version === 1);
    expect(v1.supersededBy).toBe(2);
    expect(v1.supersededReason).toBe('First edit');

    const v2 = artifact.versions.find((v: any) => v.version === 2);
    expect(v2.supersededBy).toBe(3);
    expect(v2.supersededReason).toBe('Second edit');
  });

  // TC-EDIT-13
  it('TC-EDIT-13: empty string editPrompt is rejected', async () => {
    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: '',
    }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('empty');
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. design_get
// ═══════════════════════════════════════════════════════════════════════════

describe('design_get', () => {
  // TC-GET-01
  it('TC-GET-01: get screen that exists locally → returns metadata and file paths', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGet({ screenId: 'screen-abc' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screen.id).toBe('screen-abc');
    expect(result.files.html).toContain('login');
    expect(result.files.screenshot).toContain('login');
    // Files already existed, so fetch should NOT have been called for downloads
    // (callTool was called for metadata though)
    expect(mockCallTool).toHaveBeenCalledWith('get_screen', expect.objectContaining({
      screenId: 'screen-abc',
    }));
  });

  // TC-GET-02
  it('TC-GET-02: get screen with no local files → downloads both', async () => {
    // Seed registry but don't create actual files
    const registryDir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(registryDir, { recursive: true });
    const registry = {
      screens: [{
        id: 'screen-abc',
        title: 'Login',
        screen: 'login',
        projectId: 'proj-123',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentVersion: 1,
        files: {
          html: 'design-artifacts/screens/login/v1.html',
          screenshot: 'design-artifacts/screens/login/v1.png',
        },
      }],
    };
    await fs.writeFile(path.join(registryDir, 'screen-registry.json'), JSON.stringify(registry));

    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGet({ screenId: 'screen-abc' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.files.html).toBeDefined();
    expect(result.files.screenshot).toBeDefined();
  });

  // TC-GET-03
  it('TC-GET-03: HTML preview is returned (partial content)', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    // Write a large HTML file
    const largeHtml = '<html>' + 'x'.repeat(5000) + '</html>';
    await fs.writeFile(
      path.join(tmpDir, 'design-artifacts', 'screens', 'login', 'v1.html'),
      largeHtml,
    );
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGet({ screenId: 'screen-abc' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(typeof result.htmlPreview).toBe('string');
    expect(result.htmlPreview.length).toBeLessThanOrEqual(500);
    expect(result.htmlPreview).toBe(largeHtml.slice(0, 500));
  });

  // TC-GET-04
  it('TC-GET-04: missing required screenId returns error', async () => {
    const result = await designGet({}, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('screenId');
  });

  // TC-GET-05
  it('TC-GET-05: unknown screenId not in registry → error', async () => {
    const result = await designGet({ screenId: 'screen-xyz' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('screen-xyz');
    expect((result as any).error).toContain('not found');
  });

  // TC-GET-06
  it('TC-GET-06: Stitch get_screen API error → graceful error', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockRejectedValue(new StitchError('Server error', { statusCode: 500 }));

    const result = await designGet({ screenId: 'screen-abc' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Failed to retrieve screen metadata');
  });

  // TC-GET-07
  it('TC-GET-07: explicit projectId is used over registry value', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-old');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designGet({ screenId: 'screen-abc', projectId: 'proj-override' }, ctx);

    expect(mockCallTool).toHaveBeenCalledWith('get_screen', expect.objectContaining({
      projectId: 'proj-override',
    }));
  });

  // TC-GET-08
  it('TC-GET-08: screen metadata includes theme and device info', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({
      theme: { colorMode: 'DARK', font: 'Inter', roundness: 'HIGH' },
      deviceType: 'MOBILE',
      width: '390',
      height: '844',
    }));

    const result = await designGet({ screenId: 'screen-abc' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screen.theme).toBeDefined();
    expect(result.screen.theme.colorMode).toBe('DARK');
    expect(result.screen.deviceType).toBe('MOBILE');
    expect(result.screen.width).toBe('390');
    expect(result.screen.height).toBe('844');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. design_projects
// ═══════════════════════════════════════════════════════════════════════════

describe('design_projects', () => {
  // TC-PROJ-01
  it('TC-PROJ-01: returns array of projects with required fields', async () => {
    mockCallTool.mockResolvedValue([
      { id: 'proj-1', name: 'LinguaAI', screenCount: 5 },
      { id: 'proj-2', name: 'RepairBot', screenCount: 2 },
    ]);

    const result = await designProjects({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.projects).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.projects[0]).toEqual({ id: 'proj-1', name: 'LinguaAI', screenCount: 5 });
    expect(result.projects[1]).toEqual({ id: 'proj-2', name: 'RepairBot', screenCount: 2 });
  });

  // TC-PROJ-02
  it('TC-PROJ-02: empty projects list returns empty array', async () => {
    mockCallTool.mockResolvedValue({ projects: [] });

    const result = await designProjects({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.projects).toEqual([]);
    expect(result.count).toBe(0);
  });

  // TC-PROJ-03
  it('TC-PROJ-03: Stitch API error returns graceful error', async () => {
    mockCallTool.mockRejectedValue(new StitchError('Network failure'));

    const result = await designProjects({}, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Failed to list projects');
    expect((result as any).code).toBe('STITCH_API_ERROR');
  });

  // TC-PROJ-04
  it('TC-PROJ-04: missing API key returns actionable error', async () => {
    const ctxNoKey = createStitchToolsContext(null, tmpDir);

    const result = await designProjects({}, ctxNoKey);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Stitch API key not configured');
    expect((result as any).code).toBe('no-api-key');
  });

  // TC-PROJ-05
  it('TC-PROJ-05: design_projects ignores unknown parameters', async () => {
    mockCallTool.mockResolvedValue([]);

    const result = await designProjects({ unexpectedParam: 'value' } as any, ctx);

    expect(result.success).toBe(true);
  });

  // TC-PROJ-06
  it('TC-PROJ-06: Stitch returns unexpected format → graceful handling', async () => {
    mockCallTool.mockResolvedValue(null);

    const result = await designProjects({}, ctx) as any;

    // Should safely normalize to empty array
    expect(result.success).toBe(true);
    expect(result.projects).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. design_screens
// ═══════════════════════════════════════════════════════════════════════════

describe('design_screens', () => {
  // TC-SCR-01
  it('TC-SCR-01: returns all screens when no projectId filter', async () => {
    // Seed catalog with multiple screens
    const catalogDir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(catalogDir, { recursive: true });
    const catalog = {
      version: 1,
      artifacts: [
        {
          id: 'login-v1', screen: 'login', status: 'draft', currentVersion: 1,
          versions: [{ version: 1, html: 'design-artifacts/screens/login/v1.html', screenshot: 'design-artifacts/screens/login/v1.png', createdAt: new Date().toISOString() }],
          stitch: { projectId: 'proj-1', screenId: 'scr-1' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        {
          id: 'dashboard-v1', screen: 'dashboard', status: 'draft', currentVersion: 1,
          versions: [{ version: 1, html: 'design-artifacts/screens/dashboard/v1.html', screenshot: 'design-artifacts/screens/dashboard/v1.png', createdAt: new Date().toISOString() }],
          stitch: { projectId: 'proj-1', screenId: 'scr-2' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        {
          id: 'settings-v1', screen: 'settings', status: 'draft', currentVersion: 1,
          versions: [{ version: 1, html: 'design-artifacts/screens/settings/v1.html', screenshot: 'design-artifacts/screens/settings/v1.png', createdAt: new Date().toISOString() }],
          stitch: { projectId: 'proj-2', screenId: 'scr-3' },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
      ],
    };
    await fs.writeFile(path.join(catalogDir, 'catalog.json'), JSON.stringify(catalog));

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toHaveLength(3);
    expect(result.count).toBe(3);

    // Each screen has expected fields
    const login = result.screens.find((s: any) => s.screen === 'login');
    expect(login).toBeDefined();
    expect(login.screenId).toBe('scr-1');
    expect(login.projectId).toBe('proj-1');
    expect(login.files.html).toBeDefined();
    expect(login.files.screenshot).toBeDefined();
  });

  // TC-SCR-02
  it('TC-SCR-02: filter by projectId returns only matching screens', async () => {
    const catalogDir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(catalogDir, { recursive: true });
    const catalog = {
      version: 1,
      artifacts: [
        { id: 'login-v1', screen: 'login', status: 'draft', currentVersion: 1, versions: [{ version: 1, html: 'a.html', screenshot: 'a.png', createdAt: '' }], stitch: { projectId: 'proj-1', screenId: 'scr-1' }, createdAt: '', updatedAt: '' },
        { id: 'dashboard-v1', screen: 'dashboard', status: 'draft', currentVersion: 1, versions: [{ version: 1, html: 'b.html', screenshot: 'b.png', createdAt: '' }], stitch: { projectId: 'proj-1', screenId: 'scr-2' }, createdAt: '', updatedAt: '' },
        { id: 'settings-v1', screen: 'settings', status: 'draft', currentVersion: 1, versions: [{ version: 1, html: 'c.html', screenshot: 'c.png', createdAt: '' }], stitch: { projectId: 'proj-2', screenId: 'scr-3' }, createdAt: '', updatedAt: '' },
      ],
    };
    await fs.writeFile(path.join(catalogDir, 'catalog.json'), JSON.stringify(catalog));

    const result = await designScreens({ projectId: 'proj-1' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toHaveLength(2);
    expect(result.screens.every((s: any) => s.projectId === 'proj-1')).toBe(true);
  });

  // TC-SCR-03
  it('TC-SCR-03: empty registry returns empty array', async () => {
    const catalogDir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(catalogDir, { recursive: true });
    await fs.writeFile(path.join(catalogDir, 'catalog.json'), JSON.stringify({ version: 1, artifacts: [] }));

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toEqual([]);
    expect(result.count).toBe(0);
  });

  // TC-SCR-04
  it('TC-SCR-04: registry not initialized → returns empty array, no crash', async () => {
    // Don't create design-artifacts dir at all
    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toEqual([]);
    expect(result.count).toBe(0);
  });

  // TC-SCR-05
  it('TC-SCR-05: each screen entry includes local file paths', async () => {
    const catalogDir = path.join(tmpDir, 'design-artifacts');
    await fs.mkdir(catalogDir, { recursive: true });
    const catalog = {
      version: 1,
      artifacts: [
        {
          id: 'login-v2', screen: 'login', status: 'draft', currentVersion: 2,
          versions: [
            { version: 1, html: 'design-artifacts/screens/login/v1.html', screenshot: 'design-artifacts/screens/login/v1.png', createdAt: '' },
            { version: 2, html: 'design-artifacts/screens/login/v2.html', screenshot: 'design-artifacts/screens/login/v2.png', createdAt: '' },
          ],
          stitch: { projectId: 'proj-1', screenId: 'scr-1' },
          createdAt: '', updatedAt: '',
        },
      ],
    };
    await fs.writeFile(path.join(catalogDir, 'catalog.json'), JSON.stringify(catalog));

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    const login = result.screens[0];
    expect(login.currentVersion).toBe(2);
    expect(login.files.html).toBe('design-artifacts/screens/login/v2.html');
    expect(login.files.screenshot).toBe('design-artifacts/screens/login/v2.png');
  });

  // TC-SCR-06
  it('TC-SCR-06: filter by unknown projectId returns empty array, not error', async () => {
    await seedCatalogWithScreen('login', 'scr-1', 'proj-1');

    const result = await designScreens({ projectId: 'proj-nonexistent' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toEqual([]);
    expect(result.count).toBe(0);
  });

  // TC-SCR-07
  it('TC-SCR-07: design_screens reflects screens added by design_generate', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-new', title: 'Login' }));

    const genResult = await designGenerate({ prompt: 'Login screen', title: 'Login' }, ctx);
    expect(genResult.success).toBe(true);

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens.length).toBeGreaterThanOrEqual(1);
    const login = result.screens.find((s: any) => s.screen === 'login');
    expect(login).toBeDefined();
  });

  // TC-SCR-08
  it('TC-SCR-08: design_screens reflects updates from design_edit', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({ screenId: 'screen-abc', editPrompt: 'edit' }, ctx);

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    const login = result.screens.find((s: any) => s.screen === 'login');
    expect(login).toBeDefined();
    expect(login.currentVersion).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. design_create_project
// ═══════════════════════════════════════════════════════════════════════════

describe('design_create_project', () => {
  // TC-CREATE-01
  it('TC-CREATE-01: create project with only required title', async () => {
    mockCallTool.mockResolvedValue({ id: 'proj-new', name: 'Decorize' });

    const result = await designCreateProject({ title: 'Decorize' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.projectId).toBe('proj-new');
    expect(result.title).toBe('Decorize');
    expect(mockCallTool).toHaveBeenCalledWith('create_project', { title: 'Decorize' });
  });

  // TC-CREATE-02
  it('TC-CREATE-02: create project with optional description', async () => {
    mockCallTool.mockResolvedValue({ id: 'proj-new', name: 'LinguaAI' });

    const result = await designCreateProject({
      title: 'LinguaAI',
      description: 'Language learning app',
    }, ctx);

    expect(result.success).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith('create_project', {
      title: 'LinguaAI',
      description: 'Language learning app',
    });
  });

  // TC-CREATE-03
  it('TC-CREATE-03: missing required title returns error', async () => {
    const result = await designCreateProject({} as any, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('title');
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  // TC-CREATE-04
  it('TC-CREATE-04: empty string title is rejected', async () => {
    const result = await designCreateProject({ title: '' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('empty');
  });

  // TC-CREATE-05
  it('TC-CREATE-05: Stitch API error returns graceful error', async () => {
    mockCallTool.mockRejectedValue(new StitchError('API failure'));

    const result = await designCreateProject({ title: 'TestProject' }, ctx);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Failed to create project');
    expect((result as any).code).toBe('STITCH_API_ERROR');
  });

  // TC-CREATE-06
  it('TC-CREATE-06: returned project ID is a non-empty string', async () => {
    mockCallTool.mockResolvedValue({ id: 'proj-abc123', name: 'MyApp' });

    const result = await designCreateProject({ title: 'MyApp' }, ctx) as any;

    expect(result.success).toBe(true);
    expect(typeof result.projectId).toBe('string');
    expect(result.projectId.length).toBeGreaterThan(0);
    expect(result.title).toBe('MyApp');
  });

  // TC-CREATE-07
  it('TC-CREATE-07: missing API key returns error before HTTP call', async () => {
    const ctxNoKey = createStitchToolsContext(null, tmpDir);

    const result = await designCreateProject({ title: 'Test' }, ctxNoKey);

    expect(result.success).toBe(false);
    expect((result as any).error).toContain('Stitch API key not configured');
    expect((result as any).code).toBe('no-api-key');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('integration', () => {
  // TC-INTEG-01
  it('TC-INTEG-01: generate → verify artifact in catalog with correct metadata', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-splash' }));

    const result = await designGenerate({
      prompt: 'Splash screen',
      title: 'Splash',
      projectId: 'proj-1',
    }, ctx);

    expect(result.success).toBe(true);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'splash');
    expect(artifact).toBeDefined();
    expect(artifact.status).toBe('draft');
    expect(artifact.currentVersion).toBe(1);
    expect(artifact.stitch.projectId).toBe('proj-1');
    expect(artifact.stitch.screenId).toBe('scr-splash');

    // Files exist on disk
    const v1 = artifact.versions[0];
    await expect(fs.access(path.resolve(tmpDir, v1.html))).resolves.toBeUndefined();
    await expect(fs.access(path.resolve(tmpDir, v1.screenshot))).resolves.toBeUndefined();
  });

  // TC-INTEG-02
  it('TC-INTEG-02: generate → edit → verify catalog auto-versioned', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-login' }));

    const genResult = await designGenerate({
      prompt: 'Login form',
      title: 'Login',
      projectId: 'proj-1',
    }, ctx);
    expect(genResult.success).toBe(true);
    const screenId = (genResult as any).screenId;

    // Edit
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({
      id: 'scr-login',
      htmlCode: { downloadUrl: 'https://cdn.example.com/html-v2.html' },
      screenshot: { downloadUrl: 'https://cdn.example.com/ss-v2.png' },
    }));

    const editResult = await designEdit({
      screenId,
      editPrompt: 'Add biometric button',
      projectId: 'proj-1',
    }, ctx);
    expect(editResult.success).toBe(true);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact.currentVersion).toBe(2);

    const v1 = artifact.versions.find((v: any) => v.version === 1);
    expect(v1.supersededReason).toBe('Add biometric button');

    // Both version files exist
    await expect(fs.access(path.resolve(tmpDir, v1.html))).resolves.toBeUndefined();
    const v2 = artifact.versions.find((v: any) => v.version === 2);
    await expect(fs.access(path.resolve(tmpDir, v2.html))).resolves.toBeUndefined();
  });

  // TC-INTEG-04
  it('TC-INTEG-04: generate → list screens → screen appears with correct file paths', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-dash' }));

    const genResult = await designGenerate({
      prompt: 'Dashboard',
      title: 'Dashboard',
      projectId: 'proj-1',
    }, ctx);
    expect(genResult.success).toBe(true);

    const screensResult = await designScreens({ projectId: 'proj-1' }, ctx) as any;
    expect(screensResult.success).toBe(true);

    const dashboard = screensResult.screens.find((s: any) => s.screen === 'dashboard');
    expect(dashboard).toBeDefined();
    expect(dashboard.files.html).toBeDefined();
    expect(dashboard.files.screenshot).toBeDefined();

    // Files actually exist
    await expect(fs.access(path.resolve(tmpDir, dashboard.files.html))).resolves.toBeUndefined();
    await expect(fs.access(path.resolve(tmpDir, dashboard.files.screenshot))).resolves.toBeUndefined();
  });

  // TC-INTEG-05
  it('TC-INTEG-05: multiple generates → list returns all screens', async () => {
    let callCount = 0;
    mockCallTool.mockImplementation(async () => {
      callCount++;
      return makeStitchScreenResponse({ id: `scr-${callCount}` });
    });

    await designGenerate({ prompt: 'A', title: 'Screen A' }, ctx);
    await designGenerate({ prompt: 'B', title: 'Screen B' }, ctx);
    await designGenerate({ prompt: 'C', title: 'Screen C' }, ctx);

    const result = await designScreens({}, ctx) as any;

    expect(result.success).toBe(true);
    expect(result.screens).toHaveLength(3);

    const catalog = await readCatalog();
    expect(catalog.artifacts).toHaveLength(3);
  });

  // TC-INTEG-06
  it('TC-INTEG-06: generate with Stitch failure → catalog stays clean', async () => {
    mockCallTool.mockRejectedValue(new StitchError('Server error', { statusCode: 500 }));

    const result = await designGenerate({ prompt: 'test', title: 'Broken' }, ctx);
    expect(result.success).toBe(false);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'broken');
    expect(artifact).toBeUndefined();

    // No files on disk
    const screenDir = path.join(tmpDir, 'design-artifacts', 'screens', 'broken');
    await expect(fs.access(screenDir)).rejects.toThrow();
  });

  // TC-INTEG-07
  it('TC-INTEG-07: edit with download failure → catalog stays at previous version', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-123');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    // HTML downloads fine but screenshot fails
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('html')) {
        return new Response('<html>v2</html>', { status: 200 });
      }
      throw new Error('Screenshot download timeout');
    });

    const result = await designEdit({
      screenId: 'screen-abc',
      editPrompt: 'test edit',
    }, ctx);
    expect(result.success).toBe(false);

    const catalog = await readCatalog();
    const artifact = catalog.artifacts.find((a: any) => a.screen === 'login');
    expect(artifact.currentVersion).toBe(1);
    const v1 = artifact.versions.find((v: any) => v.version === 1);
    expect(v1.supersededBy).toBeUndefined();
  });

  // TC-INTEG-08
  it('TC-INTEG-08: generate → get → file paths match', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-onboarding' }));

    const genResult = await designGenerate({
      prompt: 'Onboarding step 1',
      title: 'Onboarding',
    }, ctx) as any;
    expect(genResult.success).toBe(true);

    const getResult = await designGet({ screenId: 'scr-onboarding' }, ctx) as any;
    expect(getResult.success).toBe(true);
    expect(getResult.files.html).toBe(genResult.files.html);
    expect(getResult.files.screenshot).toBe(genResult.files.screenshot);
  });

  // TC-INTEG-09
  it('TC-INTEG-09: design_screens after edit reflects updated version', async () => {
    await seedCatalogWithScreen('profile', 'screen-prof', 'proj-1');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({ screenId: 'screen-prof', editPrompt: 'update' }, ctx);

    const result = await designScreens({}, ctx) as any;
    expect(result.success).toBe(true);
    const profile = result.screens.find((s: any) => s.screen === 'profile');
    expect(profile).toBeDefined();
    expect(profile.currentVersion).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Cross-Cutting Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('cross-cutting', () => {
  // TC-CROSS-01
  it('TC-CROSS-01: all error responses have { success: false, error, code } shape', async () => {
    const ctxNoKey = createStitchToolsContext(null, tmpDir);

    const errors = await Promise.all([
      designGenerate({ prompt: '' }, ctx),
      designEdit({ screenId: '' } as any, ctx),
      designGet({}, ctx),
      designProjects({}, ctxNoKey),
      designCreateProject({} as any, ctx),
    ]);

    for (const result of errors) {
      expect(result.success).toBe(false);
      expect(typeof (result as any).error).toBe('string');
      expect((result as any).error.length).toBeGreaterThan(0);
      expect(typeof (result as any).code).toBe('string');
      expect((result as any).code.length).toBeGreaterThan(0);
    }
  });

  // TC-CROSS-02
  it('TC-CROSS-02: all success responses have success: true', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    // design_screens doesn't need Stitch
    const screensResult = await designScreens({}, ctx);
    expect(screensResult.success).toBe(true);

    // design_projects
    mockCallTool.mockResolvedValue([]);
    const projResult = await designProjects({}, ctx);
    expect(projResult.success).toBe(true);

    // design_create_project
    mockCallTool.mockResolvedValue({ id: 'proj-1', name: 'Test' });
    const createResult = await designCreateProject({ title: 'Test' }, ctx);
    expect(createResult.success).toBe(true);

    // design_generate
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());
    const genResult = await designGenerate({ prompt: 'test', title: 'TestGen' }, ctx);
    expect(genResult.success).toBe(true);
  });

  // TC-CROSS-03
  it('TC-CROSS-03: missing API key returns actionable error on all Stitch-dependent tools', async () => {
    const ctxNoKey = createStitchToolsContext(null, tmpDir);

    const results = await Promise.all([
      designGenerate({ prompt: 'test' }, ctxNoKey),
      designEdit({ screenId: 'abc', editPrompt: 'test' }, ctxNoKey),
      designGet({ screenId: 'abc' }, ctxNoKey),
      designProjects({}, ctxNoKey),
      designCreateProject({ title: 'test' }, ctxNoKey),
    ]);

    for (const result of results) {
      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Stitch API key not configured');
      expect((result as any).code).toBe('no-api-key');
    }

    // design_screens should still work (local registry)
    const screensResult = await designScreens({}, ctxNoKey);
    expect(screensResult.success).toBe(true);
  });

  // TC-CROSS-04
  it('TC-CROSS-04: local screen registry is updated after design_generate', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-contact' }));

    await designGenerate({ prompt: 'Contact page', title: 'Contact' }, ctx);

    const screensResult = await designScreens({}, ctx) as any;
    expect(screensResult.success).toBe(true);
    const contact = screensResult.screens.find((s: any) => s.screen === 'contact');
    expect(contact).toBeDefined();
  });

  // TC-CROSS-05
  it('TC-CROSS-05: local screen registry is updated after design_edit', async () => {
    await seedCatalogWithScreen('contact', 'scr-contact', 'proj-1');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    await designEdit({ screenId: 'scr-contact', editPrompt: 'update' }, ctx);

    const screensResult = await designScreens({}, ctx) as any;
    const contact = screensResult.screens.find((s: any) => s.screen === 'contact');
    expect(contact).toBeDefined();
    expect(contact.currentVersion).toBe(2);
  });

  // TC-CROSS-06
  it('TC-CROSS-06: file paths use safe naming (no special characters)', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({
      prompt: 'test',
      title: "User's Profile & Settings!",
    }, ctx) as any;

    expect(result.success).toBe(true);
    const htmlPath = result.files.html as string;
    const ssPath = result.files.screenshot as string;

    // No special characters
    for (const p of [htmlPath, ssPath]) {
      expect(p).not.toMatch(/[&!'@#$%^*()=+{}\[\]|\\:;"<>,?]/);
      expect(p).toMatch(/^[a-z0-9/\-_.]+$/);
    }
  });

  // TC-CROSS-07
  it('TC-CROSS-07: file paths are always relative to projectRoot', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    const result = await designGenerate({ prompt: 'test', title: 'TestRel' }, ctx) as any;
    expect(result.success).toBe(true);

    // Paths don't start with /
    expect(result.files.html).not.toMatch(/^\//);
    expect(result.files.screenshot).not.toMatch(/^\//);
    // Paths start with design-artifacts/
    expect(result.files.html).toMatch(/^design-artifacts\//);
    expect(result.files.screenshot).toMatch(/^design-artifacts\//);
  });

  // TC-CROSS-09
  it('TC-CROSS-09: all tools handle null input gracefully', async () => {
    const results = await Promise.all([
      designGenerate(null as any, ctx),
      designEdit(null as any, ctx),
      designGet(null as any, ctx),
      designProjects(null as any, ctx),
      designScreens(null as any, ctx),
      designCreateProject(null as any, ctx),
    ]);

    // None should throw unhandled exceptions — all should return structured responses
    for (const result of results) {
      expect(result).toBeDefined();
      expect(typeof (result as any).success).toBe('boolean');
    }
  });

  // TC-CROSS-11
  it('TC-CROSS-11: Stitch API errors expose user-friendly message (no stack trace)', async () => {
    mockCallTool.mockRejectedValue(new StitchError('Internal Server Error', { statusCode: 500 }));

    const result = await designGenerate({ prompt: 'test' }, ctx) as any;

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('at ');
    expect(result.error).not.toContain('.ts:');
    expect(result.error).toContain('Stitch API error');
    expect(typeof result.code).toBe('string');
  });

  // TC-CROSS-12
  it('TC-CROSS-12: concurrent calls do not corrupt catalog.json', async () => {
    let callCount = 0;
    mockCallTool.mockImplementation(async () => {
      callCount++;
      return makeStitchScreenResponse({ id: `scr-${callCount}`, title: `Screen ${callCount}` });
    });

    await Promise.all([
      designGenerate({ prompt: 'A', title: 'Screen A' }, ctx),
      designGenerate({ prompt: 'B', title: 'Screen B' }, ctx),
    ]);

    const catalog = await readCatalog();
    // Should be valid JSON with entries
    expect(catalog.version).toBe(1);
    expect(catalog.artifacts.length).toBeGreaterThanOrEqual(1);

    // Verify no corruption
    const raw = await fs.readFile(path.join(tmpDir, 'design-artifacts', 'catalog.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  // TC-CROSS-13
  it('TC-CROSS-13: Stitch tools look up projectId from registry when not provided', async () => {
    await seedCatalogWithScreen('login', 'screen-abc', 'proj-from-registry');
    mockCallTool.mockResolvedValue(makeStitchScreenResponse());

    // design_edit without projectId
    await designEdit({ screenId: 'screen-abc', editPrompt: 'test' }, ctx);
    expect(mockCallTool).toHaveBeenCalledWith('edit_screens', expect.objectContaining({
      projectId: 'proj-from-registry',
    }));

    // design_get without projectId
    await designGet({ screenId: 'screen-abc' }, ctx);
    expect(mockCallTool).toHaveBeenCalledWith('get_screen', expect.objectContaining({
      projectId: 'proj-from-registry',
    }));
  });

  // TC-CROSS-14
  it('TC-CROSS-14: screen slug is consistent across generate, edit, get, and screens list', async () => {
    mockCallTool.mockResolvedValue(makeStitchScreenResponse({ id: 'scr-myapp' }));

    const genResult = await designGenerate({ prompt: 'test', title: 'My App Screen' }, ctx) as any;
    expect(genResult.success).toBe(true);
    const slug = genResult.catalogEntry.screen;
    expect(slug).toBe('my-app-screen');

    // design_screens shows the same slug
    const screensResult = await designScreens({}, ctx) as any;
    const found = screensResult.screens.find((s: any) => s.screen === slug);
    expect(found).toBeDefined();
  });
});
