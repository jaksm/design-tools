/**
 * Shared type definitions for openclaw-design-tools.
 */

// ── Stitch Client Types ─────────────────────────────────────────────────────

export interface StitchClientConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

export interface StitchResponse {
  result: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: number;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ── Stitch Client Errors ────────────────────────────────────────────────────

export class StitchError extends Error {
  public readonly statusCode?: number;
  public readonly rpcCode?: number;

  constructor(message: string, options?: { statusCode?: number; rpcCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'StitchError';
    this.statusCode = options?.statusCode;
    this.rpcCode = options?.rpcCode;
  }
}

export class StitchAuthError extends StitchError {
  constructor(message: string, statusCode: number) {
    super(message, { statusCode });
    this.name = 'StitchAuthError';
  }
}

export class StitchPermissionError extends StitchError {
  constructor(message: string, statusCode: number) {
    super(message, { statusCode });
    this.name = 'StitchPermissionError';
  }
}

export class StitchRateLimitError extends StitchError {
  constructor(message: string) {
    super(message, { statusCode: 429 });
    this.name = 'StitchRateLimitError';
  }
}

export class StitchTimeoutError extends StitchError {
  constructor(message: string) {
    super(message);
    this.name = 'StitchTimeoutError';
  }
}

export class StitchNetworkError extends StitchError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StitchNetworkError';
  }
}

export class StitchParseError extends StitchError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StitchParseError';
  }
}

export class StitchRpcError extends StitchError {
  constructor(message: string, code: number) {
    super(message, { rpcCode: code });
    this.name = 'StitchRpcError';
  }
}

// ── Catalog Types ───────────────────────────────────────────────────────────

export type CatalogEntryStatus = 'draft' | 'review' | 'approved' | 'implemented' | 'rejected';

export interface CatalogEntryVersion {
  version: number;
  timestamp: string;
  source: string;
  notes?: string;
}

export interface CatalogEntry {
  id: string;
  screen: string;
  status: CatalogEntryStatus;
  versions: CatalogEntryVersion[];
  name?: string;
  description?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Catalog {
  version: number;
  entries: CatalogEntry[];
}

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

export class CatalogCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogCorruptionError';
  }
}

export class CatalogVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogVersionError';
  }
}

// ── Status Transitions ──────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<CatalogEntryStatus, CatalogEntryStatus[]> = {
  draft: ['review'],
  review: ['approved', 'rejected'],
  approved: ['implemented'],
  implemented: [],
  rejected: ['draft'],
};

export function isValidStatusTransition(from: CatalogEntryStatus, to: CatalogEntryStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── File Download Types ─────────────────────────────────────────────────────

export interface DownloadOptions {
  overwrite?: boolean;
  expectedContentType?: string;
  timeout?: number;
}

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  contentType?: string;
}

export class FileDownloadError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'FileDownloadError';
    this.statusCode = options?.statusCode;
  }
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

// ── Plugin Types ────────────────────────────────────────────────────────────

export interface PluginContext {
  config: {
    get(key: string): string | undefined;
  };
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export const CURRENT_CATALOG_VERSION = 1;
