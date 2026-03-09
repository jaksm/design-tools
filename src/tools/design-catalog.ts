/**
 * design_catalog tool — Manage design artifacts per project.
 *
 * 7 actions: list, add, version, status, link, show, remove
 * Wraps CatalogManager with business logic, input validation, and structured error responses.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type CatalogEntryStatus,
  isValidStatusTransition,
} from '../core/types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const VALID_ACTIONS = ['list', 'add', 'version', 'status', 'link', 'show', 'remove'] as const;
type Action = (typeof VALID_ACTIONS)[number];

const VALID_STATUSES: CatalogEntryStatus[] = ['draft', 'review', 'approved', 'implemented', 'rejected'];

const VALID_TRANSITIONS: Record<CatalogEntryStatus, CatalogEntryStatus[]> = {
  draft: ['review'],
  review: ['approved', 'rejected'],
  approved: ['implemented'],
  implemented: [],
  rejected: ['draft'],
};

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

// ── Extended Types (richer than core CatalogEntry) ──────────────────────────

interface ArtifactVersion {
  version: number;
  html?: string;
  screenshot?: string;
  createdAt: string;
  supersededBy?: number;
  supersededAt?: string;
  supersededReason?: string;
  approvedAt?: string;
  approvedBy?: string;
  notes?: string;
}

interface Artifact {
  id: string;
  screen: string;
  description?: string;
  status: CatalogEntryStatus;
  currentVersion: number;
  versions: ArtifactVersion[];
  mcTaskId?: string | null;
  mcObjectiveId?: string | null;
  stitch?: { projectId?: string; screenId?: string };
  createdAt: string;
  updatedAt: string;
}

interface DesignCatalog {
  version: number;
  artifacts: Artifact[];
}

// ── Input Params ────────────────────────────────────────────────────────────

export interface DesignCatalogParams {
  action?: string;
  screen?: string;
  description?: string;
  html?: string;
  screenshot?: string;
  status?: string;
  reason?: string;
  approvedBy?: string;
  notes?: string;
  mcTaskId?: string | null;
  mcObjectiveId?: string | null;
  stitchProjectId?: string;
  stitchScreenId?: string;
  deleteFiles?: boolean;
  projectRoot?: string;
  [key: string]: unknown;
}

// ── Catalog I/O (works alongside CatalogManager for locking) ────────────────

const CATALOG_DIR = 'design-artifacts';
const CATALOG_FILE = 'catalog.json';

async function readDesignCatalog(projectRoot: string): Promise<DesignCatalog> {
  const catalogPath = path.join(projectRoot, CATALOG_DIR, CATALOG_FILE);
  try {
    const raw = await fs.readFile(catalogPath, 'utf-8');
    const data = JSON.parse(raw);
    // Support both our format and the core format
    if (data.artifacts) {
      return data as DesignCatalog;
    }
    // Convert from core format (entries → artifacts)
    if (data.entries) {
      return { version: data.version, artifacts: data.entries };
    }
    return { version: 1, artifacts: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, artifacts: [] };
    }
    throw error;
  }
}

async function writeDesignCatalog(projectRoot: string, catalog: DesignCatalog): Promise<void> {
  const catalogDir = path.join(projectRoot, CATALOG_DIR);
  const catalogPath = path.join(catalogDir, CATALOG_FILE);
  const tmpPath = path.join(catalogDir, '.catalog.json.tmp');
  await fs.mkdir(catalogDir, { recursive: true });
  const json = JSON.stringify(catalog, null, 2) + '\n';
  await fs.writeFile(tmpPath, json, 'utf-8');
  await fs.rename(tmpPath, catalogPath);
}

async function ensureCatalog(projectRoot: string): Promise<DesignCatalog> {
  const catalogDir = path.join(projectRoot, CATALOG_DIR);
  await fs.mkdir(catalogDir, { recursive: true });
  const catalog = await readDesignCatalog(projectRoot);
  // Write it to ensure the file exists
  await writeDesignCatalog(projectRoot, catalog);
  return catalog;
}

// Write lock per projectRoot for concurrency safety
const writeLocks = new Map<string, Promise<void>>();

async function withLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prev = writeLocks.get(key) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  writeLocks.set(key, next);
  
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
  }
}

// ── Validation Helpers ──────────────────────────────────────────────────────

function err(message: string, code: string): ErrorResult {
  return { success: false, error: message, code };
}

function validateScreenName(screen: unknown): ErrorResult | null {
  if (screen === undefined || screen === null) {
    return err('Missing required parameter: `screen`', 'MISSING_PARAM');
  }
  if (typeof screen !== 'string' || screen.trim() === '') {
    return err('Screen name cannot be empty.', 'INVALID_PARAM');
  }
  if (screen.includes('/') || screen.includes('\\')) {
    return err(
      'Screen name contains invalid characters (`/` or `\\`). Use alphanumeric names with hyphens (e.g. `user-profile`).',
      'PATH_TRAVERSAL',
    );
  }
  if (screen.includes('..')) {
    return err(
      'Screen name contains invalid characters. Use alphanumeric names with hyphens (e.g. `user-profile`).',
      'PATH_TRAVERSAL',
    );
  }
  return null;
}

function generateId(screen: string, version: number): string {
  return `${screen}-v${version}`;
}

function now(): string {
  return new Date().toISOString();
}

function findArtifact(catalog: DesignCatalog, screen: string): Artifact | undefined {
  return catalog.artifacts.find((a) => a.screen === screen);
}

async function fileExists(projectRoot: string, filePath: string): Promise<boolean> {
  try {
    // Check for path traversal
    if (filePath.includes('..') || path.isAbsolute(filePath)) {
      return false;
    }
    const resolved = path.resolve(projectRoot, filePath);
    if (!resolved.startsWith(path.resolve(projectRoot))) {
      return false;
    }
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

function artifactSummary(a: Artifact): Record<string, unknown> {
  return {
    id: a.id,
    screen: a.screen,
    description: a.description,
    currentVersion: a.currentVersion,
    status: a.status,
    updatedAt: a.updatedAt,
  };
}

// ── Action Handlers ─────────────────────────────────────────────────────────

async function handleList(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  // Validate status filter if provided
  if (params.status !== undefined) {
    if (!VALID_STATUSES.includes(params.status as CatalogEntryStatus)) {
      return err(
        `Invalid status filter: \`${params.status}\`. Valid statuses: ${VALID_STATUSES.join(', ')}`,
        'INVALID_PARAM',
      );
    }
  }

  const catalog = await ensureCatalog(projectRoot);
  let artifacts = [...catalog.artifacts];

  // Filter by status
  if (params.status) {
    artifacts = artifacts.filter((a) => a.status === params.status);
  }

  // Filter by screen (exact match)
  if (params.screen) {
    artifacts = artifacts.filter((a) => a.screen === params.screen);
  }

  // Sort by updatedAt descending
  artifacts.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    success: true,
    artifacts: artifacts.map(artifactSummary),
  };
}

async function handleAdd(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  // Validate required params
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  if (!params.html) {
    return err('Missing required parameter: `html`', 'MISSING_PARAM');
  }

  if (!params.screenshot) {
    return err('Missing required parameter: `screenshot`', 'MISSING_PARAM');
  }

  // Validate path traversal on file paths
  if (params.html.includes('..') || path.isAbsolute(params.html)) {
    return err(`Invalid path: \`${params.html}\``, 'PATH_TRAVERSAL');
  }
  if (params.screenshot.includes('..') || path.isAbsolute(params.screenshot)) {
    return err(`Invalid path: \`${params.screenshot}\``, 'PATH_TRAVERSAL');
  }

  // Check files exist
  const missingFiles: string[] = [];
  if (!(await fileExists(projectRoot, params.html))) {
    missingFiles.push(params.html);
  }
  if (!(await fileExists(projectRoot, params.screenshot))) {
    missingFiles.push(params.screenshot);
  }
  if (missingFiles.length === 1) {
    return err(`File not found: \`${missingFiles[0]}\``, 'FILE_NOT_FOUND');
  }
  if (missingFiles.length > 1) {
    return err(`Files not found: ${missingFiles.map((f) => `\`${f}\``).join(', ')}`, 'FILE_NOT_FOUND');
  }

  return withLock(projectRoot, async () => {
    const catalog = await ensureCatalog(projectRoot);
    const screen = params.screen!;

    // Check duplicate
    if (findArtifact(catalog, screen)) {
      return err(
        `Artifact for screen '${screen}' already exists. Use \`action: version\` to add a new version.`,
        'DUPLICATE',
      );
    }

    const timestamp = now();
    const artifact: Artifact = {
      id: generateId(screen, 1),
      screen,
      description: params.description,
      status: 'draft',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          html: params.html,
          screenshot: params.screenshot,
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Store stitch info if provided
    if (params.stitchProjectId || params.stitchScreenId) {
      artifact.stitch = {
        projectId: params.stitchProjectId,
        screenId: params.stitchScreenId,
      };
    }

    // Create screen directory
    const screenDir = path.join(projectRoot, CATALOG_DIR, 'screens', screen);
    await fs.mkdir(screenDir, { recursive: true });

    catalog.artifacts.push(artifact);
    await writeDesignCatalog(projectRoot, catalog);

    return { success: true, artifact };
  });
}

async function handleVersion(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  if (!params.html) {
    return err('Missing required parameter: `html`', 'MISSING_PARAM');
  }
  if (!params.screenshot) {
    return err('Missing required parameter: `screenshot`', 'MISSING_PARAM');
  }

  // Validate files exist before acquiring lock
  const missingFiles: string[] = [];
  if (!(await fileExists(projectRoot, params.html))) {
    missingFiles.push(params.html);
  }
  if (!(await fileExists(projectRoot, params.screenshot))) {
    missingFiles.push(params.screenshot);
  }
  if (missingFiles.length === 1) {
    return err(`File not found: \`${missingFiles[0]}\``, 'FILE_NOT_FOUND');
  }
  if (missingFiles.length > 1) {
    return err(`Files not found: ${missingFiles.map((f) => `\`${f}\``).join(', ')}`, 'FILE_NOT_FOUND');
  }

  return withLock(projectRoot, async () => {
    const catalog = await ensureCatalog(projectRoot);
    const screen = params.screen!;
    const artifact = findArtifact(catalog, screen);

    if (!artifact) {
      return err(
        `Artifact for screen '${screen}' not found. Use \`action: add\` to create it first.`,
        'NOT_FOUND',
      );
    }

    const timestamp = now();
    const newVersion = artifact.currentVersion + 1;

    // Supersede previous version
    const prevVersion = artifact.versions.find((v) => v.version === artifact.currentVersion);
    if (prevVersion) {
      prevVersion.supersededBy = newVersion;
      prevVersion.supersededAt = timestamp;
      if (params.reason) {
        prevVersion.supersededReason = params.reason;
      }
    }

    // Create new version entry
    const newVersionEntry: ArtifactVersion = {
      version: newVersion,
      html: params.html,
      screenshot: params.screenshot,
      createdAt: timestamp,
    };

    artifact.versions.push(newVersionEntry);
    artifact.currentVersion = newVersion;
    artifact.status = 'draft';
    artifact.updatedAt = timestamp;
    artifact.id = generateId(screen, newVersion);

    await writeDesignCatalog(projectRoot, catalog);

    return { success: true, artifact };
  });
}

async function handleStatus(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  if (!params.status) {
    return err('Missing required parameter: `status`', 'MISSING_PARAM');
  }

  // Validate status value
  if (!VALID_STATUSES.includes(params.status as CatalogEntryStatus)) {
    return err(
      `Unknown status: \`${params.status}\`. Valid statuses: ${VALID_STATUSES.join(', ')}`,
      'INVALID_PARAM',
    );
  }

  const targetStatus = params.status as CatalogEntryStatus;

  return withLock(projectRoot, async () => {
    const catalog = await ensureCatalog(projectRoot);
    const screen = params.screen!;
    const artifact = findArtifact(catalog, screen);

    if (!artifact) {
      return err(`Artifact for screen '${screen}' not found.`, 'NOT_FOUND');
    }

    // Check terminal state
    if (artifact.status === 'implemented') {
      return err(
        'Status `implemented` is a terminal state. No further transitions allowed.',
        'INVALID_TRANSITION',
      );
    }

    // Same status check
    if (artifact.status === targetStatus) {
      return err(
        `Artifact is already in \`${targetStatus}\` status`,
        'INVALID_TRANSITION',
      );
    }

    // Validate transition
    if (!isValidStatusTransition(artifact.status, targetStatus)) {
      const validNext = VALID_TRANSITIONS[artifact.status];
      return err(
        `Invalid transition: \`${artifact.status}\` → \`${targetStatus}\`. Valid next statuses: \`${validNext.join('`, `')}\``,
        'INVALID_TRANSITION',
      );
    }

    const timestamp = now();
    artifact.status = targetStatus;
    artifact.updatedAt = timestamp;

    // Store approval metadata
    if (targetStatus === 'approved') {
      const currentVer = artifact.versions.find((v) => v.version === artifact.currentVersion);
      if (currentVer) {
        currentVer.approvedAt = timestamp;
        if (params.approvedBy) {
          currentVer.approvedBy = params.approvedBy;
        }
        if (params.notes) {
          currentVer.notes = params.notes;
        }
      }
    }

    // Store rejection notes
    if (targetStatus === 'rejected' && params.notes) {
      const currentVer = artifact.versions.find((v) => v.version === artifact.currentVersion);
      if (currentVer) {
        currentVer.notes = params.notes;
      }
    }

    await writeDesignCatalog(projectRoot, catalog);

    return { success: true, artifact };
  });
}

async function handleLink(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  // Check that at least one link field is provided
  const hasMcTaskId = 'mcTaskId' in params;
  const hasMcObjectiveId = 'mcObjectiveId' in params;

  if (!hasMcTaskId && !hasMcObjectiveId) {
    return err(
      'No link fields provided. Supply at least one of: `mcTaskId`, `mcObjectiveId`',
      'MISSING_PARAM',
    );
  }

  return withLock(projectRoot, async () => {
    const catalog = await ensureCatalog(projectRoot);
    const screen = params.screen!;
    const artifact = findArtifact(catalog, screen);

    if (!artifact) {
      return err(`Artifact for screen '${screen}' not found.`, 'NOT_FOUND');
    }

    const timestamp = now();

    if (hasMcTaskId) {
      artifact.mcTaskId = params.mcTaskId;
    }
    if (hasMcObjectiveId) {
      artifact.mcObjectiveId = params.mcObjectiveId;
    }

    artifact.updatedAt = timestamp;

    await writeDesignCatalog(projectRoot, catalog);

    return { success: true, artifact };
  });
}

async function handleShow(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  const catalog = await ensureCatalog(projectRoot);
  const screen = params.screen!;
  const artifact = findArtifact(catalog, screen);

  if (!artifact) {
    return err(`Artifact for screen '${screen}' not found.`, 'NOT_FOUND');
  }

  return { success: true, artifact };
}

async function handleRemove(projectRoot: string, params: DesignCatalogParams): Promise<ToolResult> {
  const screenErr = validateScreenName(params.screen);
  if (screenErr) return screenErr;

  const deleteFiles = params.deleteFiles === true;

  return withLock(projectRoot, async () => {
    const catalog = await ensureCatalog(projectRoot);
    const screen = params.screen!;
    const idx = catalog.artifacts.findIndex((a) => a.screen === screen);

    if (idx === -1) {
      return err(`Artifact for screen '${screen}' not found.`, 'NOT_FOUND');
    }

    const artifact = catalog.artifacts[idx]!;
    const removedInfo = { screen: artifact.screen, id: artifact.id };

    // Delete files if requested
    const warnings: string[] = [];
    if (deleteFiles) {
      const deletedFiles: string[] = [];
      for (const ver of artifact.versions) {
        for (const filePath of [ver.html, ver.screenshot]) {
          if (!filePath) continue;
          try {
            const resolved = path.resolve(projectRoot, filePath);
            await fs.unlink(resolved);
            deletedFiles.push(filePath);
          } catch (error: unknown) {
            warnings.push(
              `could not delete \`${filePath}\`: ${(error as Error).message}`,
            );
          }
        }
      }

      // Try to remove screen directory if empty
      try {
        const screenDir = path.join(projectRoot, CATALOG_DIR, 'screens', screen);
        await fs.rmdir(screenDir);
      } catch {
        // Directory might not exist or not be empty — fine
      }

      removedInfo['deletedFiles' as keyof typeof removedInfo] = deletedFiles as unknown as string;
    }

    catalog.artifacts.splice(idx, 1);
    await writeDesignCatalog(projectRoot, catalog);

    const result: SuccessResult = { success: true, removed: removedInfo };
    if (warnings.length > 0) {
      result.warnings = warnings;
    }
    return result;
  });
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function designCatalog(params: DesignCatalogParams, defaultProjectRoot: string): Promise<ToolResult> {
  try {
    // Validate action
    if (!params.action) {
      return err(
        `Missing required parameter: \`action\`. Valid actions: ${VALID_ACTIONS.join(', ')}`,
        'MISSING_PARAM',
      );
    }

    if (!VALID_ACTIONS.includes(params.action as Action)) {
      return err(
        `Unknown action: \`${params.action}\`. Valid actions: ${VALID_ACTIONS.join(', ')}`,
        'INVALID_ACTION',
      );
    }

    const projectRoot = params.projectRoot ?? defaultProjectRoot;

    switch (params.action as Action) {
      case 'list':
        return await handleList(projectRoot, params);
      case 'add':
        return await handleAdd(projectRoot, params);
      case 'version':
        return await handleVersion(projectRoot, params);
      case 'status':
        return await handleStatus(projectRoot, params);
      case 'link':
        return await handleLink(projectRoot, params);
      case 'show':
        return await handleShow(projectRoot, params);
      case 'remove':
        return await handleRemove(projectRoot, params);
      default:
        return err(`Unknown action: \`${params.action}\``, 'INVALID_ACTION');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}
