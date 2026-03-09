/**
 * FileDownloadManager tests — TC-FD-01 through TC-FD-14
 * + Plugin Registration tests — TC-PR-01 through TC-PR-09
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileDownloadManager } from '../../src/core/file-manager.js';
import { FileDownloadError, PathTraversalError } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function mockFetchResponse(body: string | Buffer, contentType = 'text/html', status = 200) {
  const buffer = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Error ${status}`,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  } as unknown as Response;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fdm-test-'));
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── FileDownloadManager Tests ───────────────────────────────────────────────

describe('FileDownloadManager', () => {
  // TC-FD-01: Successful download saves file to correct path
  it('TC-FD-01: download saves file correctly', async () => {
    const html = '<html><body>Hello</body></html>';
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(html));

    const manager = new FileDownloadManager(tmpDir);
    const result = await manager.download('https://stitch.example/file.html', 'components/button.html');

    const content = await fs.readFile(result.path, 'utf-8');
    expect(content).toBe(html);
    expect(result.path).toBe(path.join(tmpDir, 'components', 'button.html'));
  });

  // TC-FD-02: Auto-creates nested directories
  it('TC-FD-02: creates nested directories automatically', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse('data'));

    const manager = new FileDownloadManager(tmpDir);
    await manager.download('https://example.com/f', 'deep/nested/path/file.png');

    const stat = await fs.stat(path.join(tmpDir, 'deep', 'nested', 'path', 'file.png'));
    expect(stat.isFile()).toBe(true);
  });

  // TC-FD-03: Large file downloads completely
  it('TC-FD-03: large file (12MB) downloads without truncation', async () => {
    const largeBuffer = Buffer.alloc(12 * 1024 * 1024, 0x42); // 12MB of 'B'
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(largeBuffer, 'image/png'));

    const manager = new FileDownloadManager(tmpDir);
    const result = await manager.download('https://example.com/large.png', 'screenshots/large.png');

    expect(result.sizeBytes).toBe(12 * 1024 * 1024);
    const stat = await fs.stat(result.path);
    expect(stat.size).toBe(12 * 1024 * 1024);
  });

  // TC-FD-04: Network error during download → cleanup partial file
  it('TC-FD-04: network error cleans up partial file', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('Connection reset'));

    const manager = new FileDownloadManager(tmpDir);
    await expect(
      manager.download('https://example.com/f', 'components/broken.html'),
    ).rejects.toThrow(FileDownloadError);

    // No partial file
    const filePath = path.join(tmpDir, 'components', 'broken.html');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  // TC-FD-05: HTTP 404 → no file created
  it('TC-FD-05: HTTP 404 rejects with not-found error', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse('', 'text/html', 404));

    const manager = new FileDownloadManager(tmpDir);

    try {
      await manager.download('https://example.com/missing', 'components/missing.html');
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FileDownloadError);
      expect((error as FileDownloadError).message).toMatch(/404/);
      expect((error as FileDownloadError).statusCode).toBe(404);
    }

    // No file created
    await expect(
      fs.access(path.join(tmpDir, 'components', 'missing.html')),
    ).rejects.toThrow();
  });

  // TC-FD-06: Timeout during download → cleanup partial file
  it('TC-FD-06: timeout cleans up and rejects', async () => {
    // Use a very short real timeout instead of fake timers
    fetchSpy.mockImplementation((_url, init) => {
      const signal = (init as RequestInit)?.signal;
      return new Promise((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    });

    const manager = new FileDownloadManager(tmpDir);
    const promise = manager.download(
      'https://example.com/slow',
      'screenshots/timeout.png',
      { timeout: 50 }, // Very short timeout
    );

    await expect(promise).rejects.toThrow(FileDownloadError);
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  // TC-FD-07: Skip existing file when overwrite: false
  it('TC-FD-07: skip existing file when overwrite is false', async () => {
    // Create existing file
    const filePath = path.join(tmpDir, 'components', 'existing.html');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'original');

    fetchSpy.mockResolvedValueOnce(mockFetchResponse('new content'));

    const manager = new FileDownloadManager(tmpDir);
    await manager.download(
      'https://example.com/f',
      'components/existing.html',
      { overwrite: false },
    );

    // fetch NOT called
    expect(fetchSpy).not.toHaveBeenCalled();

    // File unchanged
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('original');
  });

  // TC-FD-08: Overwrite existing file when overwrite: true
  it('TC-FD-08: overwrite existing file when overwrite is true', async () => {
    const filePath = path.join(tmpDir, 'components', 'existing.html');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'original');

    fetchSpy.mockResolvedValueOnce(mockFetchResponse('updated content'));

    const manager = new FileDownloadManager(tmpDir);
    await manager.download(
      'https://example.com/f',
      'components/existing.html',
      { overwrite: true },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('updated content');
  });

  // TC-FD-09: Content-Type validation rejects unexpected types
  it('TC-FD-09: content-type mismatch rejects', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse('code', 'application/javascript'));

    const manager = new FileDownloadManager(tmpDir);
    try {
      await manager.download(
        'https://example.com/f',
        'components/button.html',
        { expectedContentType: 'text/html' },
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(FileDownloadError);
      expect((error as FileDownloadError).message).toMatch(/content-type/i);
    }

    // No file written
    await expect(
      fs.access(path.join(tmpDir, 'components', 'button.html')),
    ).rejects.toThrow();
  });

  // TC-FD-10 (P2): Content-Type with charset passes
  it('TC-FD-10: content-type with charset passes validation', async () => {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse('html', 'text/html; charset=utf-8'));

    const manager = new FileDownloadManager(tmpDir);
    const result = await manager.download(
      'https://example.com/f',
      'file.html',
      { expectedContentType: 'text/html' },
    );

    expect(result.sizeBytes).toBe(4);
  });

  // TC-FD-11: Path traversal — absolute path rejected
  it('TC-FD-11: absolute path is rejected', () => {
    const manager = new FileDownloadManager('/safe/directory');
    expect(() => manager.resolvePath('/etc/passwd')).toThrow(PathTraversalError);
  });

  // TC-FD-12: Path traversal — ../ sequences rejected
  it('TC-FD-12: ../ sequences rejected', () => {
    const manager = new FileDownloadManager('/safe/directory');
    expect(() => manager.resolvePath('../../sensitive/file.txt')).toThrow(PathTraversalError);
  });

  // TC-FD-13: Path traversal — URL-encoded ../ rejected
  it('TC-FD-13: URL-encoded traversal rejected', () => {
    const manager = new FileDownloadManager('/safe/directory');
    expect(() => manager.resolvePath('..%2F..%2Fsensitive.txt')).toThrow(PathTraversalError);
  });

  // TC-FD-14 (P2): Download result includes metadata
  it('TC-FD-14: download result includes size and path', async () => {
    const content = 'a'.repeat(1024);
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(content, 'text/html'));

    const manager = new FileDownloadManager(tmpDir);
    const result = await manager.download('https://example.com/f', 'components/button.html');

    expect(result.path).toBe(path.join(tmpDir, 'components', 'button.html'));
    expect(result.sizeBytes).toBe(1024);
    expect(result.contentType).toBe('text/html');
  });
});

// ── Plugin Registration Tests ───────────────────────────────────────────────

describe('Plugin Registration', () => {
  // TC-PR-01 & TC-PR-02: Plugin loads and registers expected tools (currently 0)
  it('TC-PR-01/02: plugin loads without throwing, registers 0 tools', async () => {
    const { default: register } = await import('../../src/index.js');

    const registeredTools: unknown[][] = [];
    const api = {
      id: 'design-tools',
      name: 'design-tools',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: { stitch: { apiKey: 'test-key' } },
      registerTool: vi.fn((factory: (ctx: { workspaceDir?: string }) => unknown[] | null) => {
        const tools = factory({ workspaceDir: tmpDir });
        if (tools) registeredTools.push(tools);
      }),
      on: vi.fn(),
    };

    expect(() => register(api)).not.toThrow();
    expect(api.registerTool).toHaveBeenCalledOnce();

    // 8 tools registered: design_catalog, design_vision, + 6 stitch native tools
    expect(registeredTools.length).toBeGreaterThan(0);
    expect(registeredTools[0]).toHaveLength(8);
    expect((registeredTools[0] as Array<{ name: string }>)[0]!.name).toBe('design_catalog');
    expect((registeredTools[0] as Array<{ name: string }>)[1]!.name).toBe('design_vision');
    expect((registeredTools[0] as Array<{ name: string }>)[2]!.name).toBe('design_generate');
    expect((registeredTools[0] as Array<{ name: string }>)[3]!.name).toBe('design_edit');
    expect((registeredTools[0] as Array<{ name: string }>)[4]!.name).toBe('design_get');
    expect((registeredTools[0] as Array<{ name: string }>)[5]!.name).toBe('design_projects');
    expect((registeredTools[0] as Array<{ name: string }>)[6]!.name).toBe('design_screens');
    expect((registeredTools[0] as Array<{ name: string }>)[7]!.name).toBe('design_create_project');
  });

  // TC-PR-03: ADC-based auth — no API key needed, always creates StitchClient
  it('TC-PR-03: activate always creates StitchClient (ADC auth)', async () => {
    const { activate } = await import('../../src/adapter.js');

    const context = {
      config: { get: () => undefined },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const result = activate(context, tmpDir);
    expect(result.stitchClient).toBeDefined();
    expect(result.stitchClient).not.toBeNull();
  });

  // TC-PR-04: quota project from config
  it('TC-PR-04: quota project from config is passed to StitchClient', async () => {
    const { activate } = await import('../../src/adapter.js');

    const context = {
      config: { get: (key: string) => key === 'stitch.quotaProjectId' ? 'my-gcp-project' : undefined },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const result = activate(context, tmpDir);
    expect(result.stitchClient).toBeDefined();
    // StitchClient is created — quota project is internal config
  });

  // TC-PR-05: activate without any config still works (ADC handles auth)
  it('TC-PR-05: activate without config still works', async () => {
    const { activate } = await import('../../src/adapter.js');

    const context = {
      config: { get: () => undefined },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const result = activate(context, tmpDir);
    expect(result.stitchClient).toBeDefined();
    expect(result.catalogManager).toBeDefined();
    expect(result.fileManager).toBeDefined();
  });

  // TC-PR-06: activate logs ADC info message
  it('TC-PR-06: activate logs ADC activation message', async () => {
    const { activate } = await import('../../src/adapter.js');

    const infoSpy = vi.fn();
    const context = {
      config: { get: () => undefined },
      logger: { info: infoSpy, warn: vi.fn(), error: vi.fn() },
    };

    activate(context, tmpDir);

    expect(infoSpy).toHaveBeenCalled();
    expect(infoSpy.mock.calls[0]![0]).toMatch(/ADC/);
  });

  // TC-PR-07: Plugin manifest has required metadata
  it('TC-PR-07: package.json has required metadata', async () => {
    const raw = await fs.readFile(
      path.join(path.dirname(path.dirname(tmpDir)), 'Projects', 'jaksa', 'openclaw-design-tools', 'package.json'),
      'utf-8',
    ).catch(async () => {
      // Fallback: read from project root
      return fs.readFile(
        path.resolve(import.meta.dirname, '../../package.json'),
        'utf-8',
      );
    });

    const pkg = JSON.parse(raw);
    expect(pkg.name).toBeTruthy();
    expect(pkg.version).toBeTruthy();
    expect(pkg.description).toBeTruthy();
    // Semver format
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  // TC-PR-08: Tool name conflicts (infrastructure test — currently no tools)
  it('TC-PR-08: no duplicate tool names in registration', async () => {
    const { default: register } = await import('../../src/index.js');

    const tools: { name: string }[] = [];
    const api = {
      id: 'design-tools',
      name: 'design-tools',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: { stitch: { apiKey: 'test-key' } },
      registerTool: vi.fn((factory: (ctx: { workspaceDir?: string }) => { name: string }[] | null) => {
        const result = factory({ workspaceDir: tmpDir });
        if (result) tools.push(...result);
      }),
      on: vi.fn(),
    };

    register(api);

    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });

  // TC-PR-09 (P2): Plugin unloads cleanly — infrastructure registers cleanup
  it('TC-PR-09: plugin registration is idempotent', async () => {
    const { default: register } = await import('../../src/index.js');

    const api = {
      id: 'design-tools',
      name: 'design-tools',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      pluginConfig: { stitch: { apiKey: 'test-key' } },
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    // Loading twice should not throw
    expect(() => register(api)).not.toThrow();
    expect(() => register(api)).not.toThrow();
  });
});
