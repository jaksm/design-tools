/**
 * Stitch Native Tools — 6 tools for direct Stitch API integration.
 *
 * design_generate, design_edit, design_get, design_projects,
 * design_screens, design_create_project
 *
 * All tools follow the { success: true/false, ... } response pattern.
 * All Stitch-dependent tools check for API key before making calls.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { StitchClient } from '../core/stitch-client.js';
import { FileDownloadManager } from '../core/file-manager.js';
import { ScreenRegistryManager } from '../core/screen-registry.js';
import {
  StitchError,
  StitchAuthError,
  StitchRateLimitError,
} from '../core/types.js';

// ── Result Types ────────────────────────────────────────────────────────────

interface SuccessResult {
  success: true;
  [key: string]: unknown;
}

interface ErrorResult {
  success: false;
  error: string;
  code: string;
}

type ToolResult = SuccessResult | ErrorResult;

// ── Constants ───────────────────────────────────────────────────────────────

const VALID_PLATFORMS = ['ios', 'android', 'web'] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

const VALID_COLOR_MODES = ['light', 'dark'] as const;

const PLATFORM_TO_DEVICE_TYPE: Record<Platform, string> = {
  ios: 'MOBILE',
  android: 'MOBILE',
  web: 'DESKTOP',
};

const ARTIFACTS_DIR = 'design-artifacts';
const SCREENS_DIR = 'screens';

// ── Helpers ─────────────────────────────────────────────────────────────────

function err(message: string, code: string): ErrorResult {
  return { success: false, error: message, code };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, '') // Remove apostrophes
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '') // Trim leading/trailing hyphens
    .replace(/-{2,}/g, '-'); // Collapse multiple hyphens
}

function screensRelPath(screenSlug: string): string {
  return path.join(ARTIFACTS_DIR, SCREENS_DIR, screenSlug);
}

function htmlRelPath(screenSlug: string, version: number): string {
  return path.join(screensRelPath(screenSlug), `v${version}.html`);
}

function screenshotRelPath(screenSlug: string, version: number): string {
  return path.join(screensRelPath(screenSlug), `v${version}.png`);
}

function isStitchApiError(error: unknown): error is StitchError {
  return error instanceof StitchError;
}

function formatStitchError(error: unknown): ErrorResult {
  if (error instanceof StitchAuthError) {
    return err(`Stitch API authentication failed: ${error.message}`, 'STITCH_AUTH_ERROR');
  }
  if (error instanceof StitchRateLimitError) {
    return err(`Stitch API rate limited: ${error.message}`, 'STITCH_RATE_LIMITED');
  }
  if (isStitchApiError(error)) {
    return err(`Stitch API error: ${error.message}`, 'STITCH_API_ERROR');
  }
  const message = error instanceof Error ? error.message : String(error);
  return err(`Stitch API error: ${message}`, 'STITCH_API_ERROR');
}

// ── Stitch Response Types ───────────────────────────────────────────────────

interface StitchScreenResponse {
  id: string;
  title?: string;
  prompt?: string;
  width?: string;
  height?: string;
  deviceType?: string;
  screenType?: string;
  name?: string;
  generatedBy?: string;
  theme?: Record<string, unknown>;
  screenMetadata?: Record<string, unknown>;
  htmlCode?: {
    name?: string;
    downloadUrl: string;
    mimeType?: string;
  };
  screenshot?: {
    name?: string;
    downloadUrl: string;
  };
}

interface StitchGenerationResponse {
  outputComponents: Array<{
    design?: {
      screens?: StitchScreenResponse[];
      theme?: Record<string, unknown>;
      title?: string;
      deviceType?: string;
    };
    suggestion?: string;
    text?: string;
  }>;
  projectId: string;
  sessionId: string;
}

interface StitchProjectResponse {
  id?: string;
  name?: string;
  title?: string;
  screenCount?: number;
}

// ── Tool Input Types ────────────────────────────────────────────────────────

export interface DesignGenerateParams {
  prompt?: string;
  projectId?: string;
  title?: string;
  platform?: string;
  modelId?: string;
  [key: string]: unknown;
}

export interface DesignEditParams {
  screenId?: string;
  editPrompt?: string;
  projectId?: string;
  modelId?: string;
  [key: string]: unknown;
}

export interface DesignGetParams {
  screenId?: string;
  projectId?: string;
  [key: string]: unknown;
}

export interface DesignProjectsParams {
  [key: string]: unknown;
}

export interface DesignScreensParams {
  projectId?: string;
  [key: string]: unknown;
}

export interface DesignCreateProjectParams {
  title?: string;
  description?: string;
  [key: string]: unknown;
}

// ── Tool Context ────────────────────────────────────────────────────────────

export interface StitchToolsContext {
  stitchClient: StitchClient | null;
  fileManager: FileDownloadManager;
  screenRegistry: ScreenRegistryManager;
  projectRoot: string;
  defaultProjectId?: string;
}

// ── Catalog Integration ─────────────────────────────────────────────────────
// We integrate directly with design_catalog's JSON format (same as design-catalog.ts)

interface ArtifactVersion {
  version: number;
  html?: string;
  screenshot?: string;
  createdAt: string;
  supersededBy?: number;
  supersededAt?: string;
  supersededReason?: string;
  notes?: string;
}

interface Artifact {
  id: string;
  screen: string;
  description?: string;
  status: string;
  currentVersion: number;
  versions: ArtifactVersion[];
  stitch?: { projectId?: string; screenId?: string };
  createdAt: string;
  updatedAt: string;
}

interface DesignCatalog {
  version: number;
  artifacts: Artifact[];
}

const CATALOG_DIR = 'design-artifacts';
const CATALOG_FILE = 'catalog.json';

async function readCatalog(projectRoot: string): Promise<DesignCatalog> {
  const catalogPath = path.join(projectRoot, CATALOG_DIR, CATALOG_FILE);
  try {
    const raw = await fs.readFile(catalogPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.artifacts) return data as DesignCatalog;
    if (data.entries) return { version: data.version, artifacts: data.entries };
    return { version: 1, artifacts: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, artifacts: [] };
    }
    throw error;
  }
}

async function writeCatalog(projectRoot: string, catalog: DesignCatalog): Promise<void> {
  const catalogDir = path.join(projectRoot, CATALOG_DIR);
  const catalogPath = path.join(catalogDir, CATALOG_FILE);
  const tmpPath = path.join(catalogDir, '.catalog.json.tmp');
  await fs.mkdir(catalogDir, { recursive: true });
  const json = JSON.stringify(catalog, null, 2) + '\n';
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, catalogPath);
}

// Write lock for catalog
const catalogLocks = new Map<string, Promise<void>>();

async function withCatalogLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prev = catalogLocks.get(key) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  catalogLocks.set(key, next);

  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
  }
}

function now(): string {
  return new Date().toISOString();
}

// ── Cleanup Helper ──────────────────────────────────────────────────────────

async function cleanupFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore — file might not exist
  }
}

async function cleanupDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true });
  } catch {
    // Ignore
  }
}

// ── Download Helpers ────────────────────────────────────────────────────────

async function downloadHtml(url: string, destPath: string, projectRoot: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading HTML`);
    }
    const html = await response.text();
    const fullPath = path.resolve(projectRoot, destPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, html, 'utf-8');
    return html;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadScreenshot(url: string, destPath: string, projectRoot: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading screenshot`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const fullPath = path.resolve(projectRoot, destPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, buffer);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── 1. design_generate ─────────────────────────────────────────────────────

export async function designGenerate(
  params: DesignGenerateParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Validate API key
    if (!ctx.stitchClient) {
      return err(
        'Stitch API key not configured. Set `STITCH_API_KEY` in your `.env` file.',
        'no-api-key',
      );
    }

    // Validate required params
    if (params.prompt === undefined || params.prompt === null) {
      return err('Missing required parameter: `prompt`', 'MISSING_PARAM');
    }
    if (typeof params.prompt !== 'string' || params.prompt.trim() === '') {
      return err('Parameter `prompt` cannot be empty', 'INVALID_PARAM');
    }

    // Resolve projectId
    const projectId = params.projectId ?? ctx.defaultProjectId;
    if (!projectId) {
      return err(
        'No projectId provided and no default project configured. Provide `projectId` or set a default in plugin config.',
        'MISSING_PARAM',
      );
    }

    // Validate platform
    if (params.platform !== undefined) {
      if (!VALID_PLATFORMS.includes(params.platform as Platform)) {
        return err(
          `Invalid platform: \`${params.platform}\`. Valid values: \`ios\`, \`android\`, \`web\``,
          'INVALID_PARAM',
        );
      }
    }

    // Build Stitch args
    const stitchArgs: Record<string, unknown> = {
      projectId,
      prompt: params.prompt,
    };

    if (params.platform) {
      stitchArgs.deviceType = PLATFORM_TO_DEVICE_TYPE[params.platform as Platform];
    }

    if (params.modelId) {
      stitchArgs.modelId = params.modelId;
    }

    // Call Stitch
    let screen: StitchScreenResponse;
    try {
      const response = await ctx.stitchClient.callTool('generate_screen_from_text', stitchArgs) as StitchGenerationResponse;
      const extracted = response.outputComponents?.[0]?.design?.screens?.[0];
      if (!extracted) {
        return err('No screen generated — Stitch returned empty outputComponents', 'STITCH_EMPTY_RESPONSE');
      }
      screen = extracted;
    } catch (error) {
      return formatStitchError(error);
    }

    // Determine title and slug
    const title = params.title ?? screen.title ?? 'untitled';
    const screenSlug = slugify(title);

    // Determine file paths
    const htmlPath = htmlRelPath(screenSlug, 1);
    const screenshotPath = screenshotRelPath(screenSlug, 1);

    // Download files atomically
    const screenDir = path.resolve(ctx.projectRoot, screensRelPath(screenSlug));
    try {
      if (!screen.htmlCode?.downloadUrl) {
        throw new Error('No HTML download URL in Stitch response');
      }
      await downloadHtml(screen.htmlCode.downloadUrl, htmlPath, ctx.projectRoot);
    } catch (error) {
      await cleanupDir(screenDir);
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to download HTML for screen: ${message}`, 'DOWNLOAD_ERROR');
    }

    try {
      if (!screen.screenshot?.downloadUrl) {
        throw new Error('No screenshot download URL in Stitch response');
      }
      await downloadScreenshot(screen.screenshot.downloadUrl, screenshotPath, ctx.projectRoot);
    } catch (error) {
      // Clean up HTML that was already written + directory
      await cleanupDir(screenDir);
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to download screenshot for screen: ${message}`, 'DOWNLOAD_ERROR');
    }

    // Register in catalog (atomic with lock)
    const timestamp = now();
    const catalogEntry = await withCatalogLock(ctx.projectRoot, async () => {
      const catalog = await readCatalog(ctx.projectRoot);

      const artifact: Artifact = {
        id: `${screenSlug}-v1`,
        screen: screenSlug,
        description: params.prompt,
        status: 'draft',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            html: htmlPath,
            screenshot: screenshotPath,
            createdAt: timestamp,
          },
        ],
        stitch: {
          projectId,
          screenId: screen.id,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      catalog.artifacts.push(artifact);
      await writeCatalog(ctx.projectRoot, catalog);
      return artifact;
    });

    // Register in screen registry
    await ctx.screenRegistry.register({
      id: screen.id,
      title,
      screen: screenSlug,
      projectId,
      createdAt: timestamp,
      updatedAt: timestamp,
      currentVersion: 1,
      files: {
        html: htmlPath,
        screenshot: screenshotPath,
      },
    });

    return {
      success: true,
      screenId: screen.id,
      title,
      files: {
        html: htmlPath,
        screenshot: screenshotPath,
      },
      catalogEntry: {
        id: catalogEntry.id,
        screen: catalogEntry.screen,
        status: catalogEntry.status,
        currentVersion: catalogEntry.currentVersion,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── 2. design_edit ──────────────────────────────────────────────────────────

export async function designEdit(
  params: DesignEditParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Validate API key
    if (!ctx.stitchClient) {
      return err(
        'Stitch API key not configured. Set `STITCH_API_KEY` in your `.env` file.',
        'no-api-key',
      );
    }

    // Validate required params
    if (!params.screenId) {
      return err('Missing required parameter: `screenId`', 'MISSING_PARAM');
    }
    if (params.editPrompt === undefined || params.editPrompt === null) {
      return err('Missing required parameter: `editPrompt`', 'MISSING_PARAM');
    }
    if (typeof params.editPrompt !== 'string' || params.editPrompt.trim() === '') {
      return err('Parameter `editPrompt` cannot be empty', 'INVALID_PARAM');
    }

    // Look up screen in registry
    const registryEntry = await ctx.screenRegistry.findById(params.screenId);
    if (!registryEntry) {
      return err(
        `Screen \`${params.screenId}\` not found in local registry. Use \`design_get\` to fetch it first, or check your screenId.`,
        'NOT_FOUND',
      );
    }

    // Resolve projectId
    const projectId = params.projectId ?? registryEntry.projectId;

    // Call Stitch
    let screen: StitchScreenResponse;
    try {
      const editArgs: Record<string, unknown> = {
        projectId,
        selectedScreenIds: [params.screenId],
        prompt: params.editPrompt,
      };
      if (params.modelId) {
        editArgs.modelId = params.modelId;
      }
      const response = await ctx.stitchClient.callTool('edit_screens', editArgs) as StitchGenerationResponse;
      const extracted = response.outputComponents?.[0]?.design?.screens?.[0];
      if (!extracted) {
        return err('No screen returned from edit — Stitch returned empty outputComponents', 'STITCH_EMPTY_RESPONSE');
      }
      screen = extracted;
    } catch (error) {
      return formatStitchError(error);
    }

    // Determine new version
    const newVersion = registryEntry.currentVersion + 1;
    const screenSlug = registryEntry.screen;
    const htmlPath = htmlRelPath(screenSlug, newVersion);
    const screenshotPath = screenshotRelPath(screenSlug, newVersion);

    // Download files atomically
    try {
      if (!screen.htmlCode?.downloadUrl) {
        throw new Error('No HTML download URL in Stitch response');
      }
      await downloadHtml(screen.htmlCode.downloadUrl, htmlPath, ctx.projectRoot);
    } catch (error) {
      // Clean up any partial files
      await cleanupFile(path.resolve(ctx.projectRoot, htmlPath));
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to download HTML for screen: ${message}`, 'DOWNLOAD_ERROR');
    }

    try {
      if (!screen.screenshot?.downloadUrl) {
        throw new Error('No screenshot download URL in Stitch response');
      }
      await downloadScreenshot(screen.screenshot.downloadUrl, screenshotPath, ctx.projectRoot);
    } catch (error) {
      // Clean up HTML that was already written
      await cleanupFile(path.resolve(ctx.projectRoot, htmlPath));
      await cleanupFile(path.resolve(ctx.projectRoot, screenshotPath));
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to download screenshot for screen: ${message}`, 'DOWNLOAD_ERROR');
    }

    // Update catalog (version the artifact)
    const timestamp = now();
    const catalogEntry = await withCatalogLock(ctx.projectRoot, async () => {
      const catalog = await readCatalog(ctx.projectRoot);
      const artifact = catalog.artifacts.find(
        (a) => a.stitch?.screenId === params.screenId || a.screen === screenSlug,
      );

      if (artifact) {
        // Supersede previous version
        const prevVersion = artifact.versions.find((v) => v.version === artifact.currentVersion);
        if (prevVersion) {
          prevVersion.supersededBy = newVersion;
          prevVersion.supersededAt = timestamp;
          prevVersion.supersededReason = params.editPrompt;
        }

        // Add new version
        artifact.versions.push({
          version: newVersion,
          html: htmlPath,
          screenshot: screenshotPath,
          createdAt: timestamp,
        });
        artifact.currentVersion = newVersion;
        artifact.id = `${screenSlug}-v${newVersion}`;
        artifact.status = 'draft';
        artifact.updatedAt = timestamp;

        await writeCatalog(ctx.projectRoot, catalog);
        return artifact;
      }

      // If artifact doesn't exist in catalog (edge case), create it
      const newArtifact: Artifact = {
        id: `${screenSlug}-v${newVersion}`,
        screen: screenSlug,
        description: params.editPrompt,
        status: 'draft',
        currentVersion: newVersion,
        versions: [
          {
            version: newVersion,
            html: htmlPath,
            screenshot: screenshotPath,
            createdAt: timestamp,
          },
        ],
        stitch: { projectId, screenId: params.screenId },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      catalog.artifacts.push(newArtifact);
      await writeCatalog(ctx.projectRoot, catalog);
      return newArtifact;
    });

    // Update screen registry
    await ctx.screenRegistry.update(params.screenId, {
      currentVersion: newVersion,
      updatedAt: timestamp,
      files: {
        html: htmlPath,
        screenshot: screenshotPath,
      },
    });

    return {
      success: true,
      screenId: params.screenId,
      version: newVersion,
      files: {
        html: htmlPath,
        screenshot: screenshotPath,
      },
      catalogEntry: {
        id: catalogEntry.id,
        screen: catalogEntry.screen,
        status: catalogEntry.status,
        currentVersion: catalogEntry.currentVersion,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── 3. design_get ───────────────────────────────────────────────────────────

export async function designGet(
  params: DesignGetParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Validate API key
    if (!ctx.stitchClient) {
      return err(
        'Stitch API key not configured. Set `STITCH_API_KEY` in your `.env` file.',
        'no-api-key',
      );
    }

    // Validate required params
    if (!params.screenId) {
      return err('Missing required parameter: `screenId`', 'MISSING_PARAM');
    }

    // Look up in registry
    const registryEntry = await ctx.screenRegistry.findById(params.screenId);
    if (!registryEntry) {
      return err(
        `Screen \`${params.screenId}\` not found in local registry. Use \`design_screens\` to list known screens, or \`design_generate\` to create a new one.`,
        'NOT_FOUND',
      );
    }

    // Resolve projectId
    const projectId = params.projectId ?? registryEntry.projectId;

    // Get screen metadata from Stitch
    let screen: StitchScreenResponse;
    try {
      screen = await ctx.stitchClient.callTool('get_screen', {
        name: `projects/${projectId}/screens/${params.screenId}`,
        projectId,
        screenId: params.screenId,
      }) as StitchScreenResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to retrieve screen metadata from Stitch: ${message}`, 'STITCH_API_ERROR');
    }

    // Check if files exist locally, download if not
    const htmlFullPath = path.resolve(ctx.projectRoot, registryEntry.files.html);
    const ssFullPath = path.resolve(ctx.projectRoot, registryEntry.files.screenshot);

    let htmlExists = false;
    let ssExists = false;
    try { await fs.access(htmlFullPath); htmlExists = true; } catch { /* doesn't exist */ }
    try { await fs.access(ssFullPath); ssExists = true; } catch { /* doesn't exist */ }

    if (!htmlExists && screen.htmlCode?.downloadUrl) {
      try {
        await downloadHtml(screen.htmlCode.downloadUrl, registryEntry.files.html, ctx.projectRoot);
      } catch {
        // Non-fatal — we still return metadata
      }
    }

    if (!ssExists && screen.screenshot?.downloadUrl) {
      try {
        await downloadScreenshot(screen.screenshot.downloadUrl, registryEntry.files.screenshot, ctx.projectRoot);
      } catch {
        // Non-fatal
      }
    }

    // Read HTML preview
    let htmlPreview = '';
    try {
      const html = await fs.readFile(htmlFullPath, 'utf-8');
      htmlPreview = html.slice(0, 500);
    } catch {
      // File might still not exist
    }

    return {
      success: true,
      screen: {
        id: screen.id ?? params.screenId,
        title: screen.title ?? registryEntry.title,
        width: screen.width,
        height: screen.height,
        deviceType: screen.deviceType,
        theme: screen.theme,
        screenMetadata: screen.screenMetadata,
      },
      files: {
        html: registryEntry.files.html,
        screenshot: registryEntry.files.screenshot,
      },
      htmlPreview,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── 4. design_projects ──────────────────────────────────────────────────────

export async function designProjects(
  _params: DesignProjectsParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Validate API key
    if (!ctx.stitchClient) {
      return err(
        'Stitch API key not configured. Set `STITCH_API_KEY` in your `.env` file.',
        'no-api-key',
      );
    }

    let result: unknown;
    try {
      result = await ctx.stitchClient.callTool('list_projects', {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to list projects: ${message}`, 'STITCH_API_ERROR');
    }

    // Normalize response — could be array or { projects: [] }
    let projects: StitchProjectResponse[];
    if (Array.isArray(result)) {
      projects = result as StitchProjectResponse[];
    } else if (result && typeof result === 'object' && 'projects' in (result as Record<string, unknown>)) {
      const r = result as Record<string, unknown>;
      projects = Array.isArray(r.projects) ? r.projects as StitchProjectResponse[] : [];
    } else if (result === null || result === undefined) {
      projects = [];
    } else {
      return err('Unexpected response format from Stitch API', 'STITCH_API_ERROR');
    }

    const normalized = projects.map((p) => ({
      id: p.name?.split('projects/')[1] || p.id || '',
      name: p.title ?? p.name ?? '',
      ...(p.screenCount !== undefined ? { screenCount: p.screenCount } : {}),
    }));

    return {
      success: true,
      projects: normalized,
      count: normalized.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── 5. design_screens ───────────────────────────────────────────────────────

export async function designScreens(
  params: DesignScreensParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Read from catalog (local only — no Stitch call)
    const catalog = await readCatalog(ctx.projectRoot);
    let artifacts = catalog.artifacts;

    // Filter by projectId if provided
    if (params.projectId) {
      artifacts = artifacts.filter((a) => a.stitch?.projectId === params.projectId);
    }

    const screens = artifacts.map((a) => {
      const currentVer = a.versions.find((v) => v.version === a.currentVersion);
      return {
        screenId: a.stitch?.screenId ?? a.id,
        title: a.screen,
        screen: a.screen,
        projectId: a.stitch?.projectId ?? '',
        currentVersion: a.currentVersion,
        status: a.status,
        files: {
          html: currentVer?.html ?? '',
          screenshot: currentVer?.screenshot ?? '',
        },
      };
    });

    return {
      success: true,
      screens,
      count: screens.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── 6. design_create_project ────────────────────────────────────────────────

export async function designCreateProject(
  params: DesignCreateProjectParams,
  ctx: StitchToolsContext,
): Promise<ToolResult> {
  try {
    // Validate API key
    if (!ctx.stitchClient) {
      return err(
        'Stitch API key not configured. Set `STITCH_API_KEY` in your `.env` file.',
        'no-api-key',
      );
    }

    // Validate required params
    if (params.title === undefined || params.title === null) {
      return err('Missing required parameter: `title`', 'MISSING_PARAM');
    }
    if (typeof params.title !== 'string' || params.title.trim() === '') {
      return err('Parameter `title` cannot be empty', 'INVALID_PARAM');
    }

    // Build Stitch args
    const stitchArgs: Record<string, unknown> = {
      title: params.title,
    };
    if (params.description) {
      stitchArgs.description = params.description;
    }

    // Call Stitch
    let result: unknown;
    try {
      result = await ctx.stitchClient.callTool('create_project', stitchArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to create project: ${message}`, 'STITCH_API_ERROR');
    }

    const project = result as StitchProjectResponse;
    const projectId = project?.id ?? '';
    const projectTitle = project?.name ?? project?.title ?? params.title;

    if (!projectId) {
      return err('Stitch API returned no project ID', 'STITCH_API_ERROR');
    }

    return {
      success: true,
      projectId,
      title: projectTitle,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a StitchToolsContext for use with all 6 tools.
 */
export function createStitchToolsContext(
  stitchClient: StitchClient | null,
  projectRoot: string,
  defaultProjectId?: string,
): StitchToolsContext {
  return {
    stitchClient,
    fileManager: new FileDownloadManager(projectRoot),
    screenRegistry: new ScreenRegistryManager(projectRoot),
    projectRoot,
    defaultProjectId,
  };
}
