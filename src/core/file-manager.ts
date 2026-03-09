/**
 * FileDownloadManager — Downloads files from Stitch API URLs to local filesystem.
 * Path traversal protection, atomic downloads, content type validation.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type DownloadOptions,
  type DownloadResult,
  FileDownloadError,
  PathTraversalError,
} from './types.js';

const DEFAULT_TIMEOUT = 60_000;

export class FileDownloadManager {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Download a file from a URL to a path relative to projectRoot.
   */
  async download(
    url: string,
    destPath: string,
    options?: DownloadOptions,
  ): Promise<DownloadResult> {
    const resolvedPath = this.resolvePath(destPath);

    // Skip existing file when overwrite is false
    if (options?.overwrite === false) {
      try {
        await fs.access(resolvedPath);
        // File exists and overwrite is false — skip
        const stat = await fs.stat(resolvedPath);
        return {
          path: resolvedPath,
          sizeBytes: stat.size,
        };
      } catch {
        // File doesn't exist — proceed with download
      }
    }

    // Ensure parent directory exists
    await this.ensureDir(path.dirname(resolvedPath));

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      // Clean up partial file
      await this.cleanupFile(resolvedPath);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new FileDownloadError(
          `Download timed out after ${timeout}ms for ${destPath}`,
          { cause: error },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new FileDownloadError(
        `Network error downloading to ${destPath}: ${message}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new FileDownloadError(
        `HTTP ${response.status} downloading ${url} to ${destPath}`,
        { statusCode: response.status },
      );
    }

    // Content type validation
    if (options?.expectedContentType) {
      const contentType = response.headers.get('content-type') ?? '';
      const actualBase = contentType.split(';')[0]!.trim().toLowerCase();
      const expectedBase = options.expectedContentType.toLowerCase();
      if (actualBase !== expectedBase) {
        throw new FileDownloadError(
          `Content-Type mismatch for ${destPath}: expected "${expectedBase}", got "${actualBase}"`,
        );
      }
    }

    // Write response body to file
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(resolvedPath, buffer);

      const contentType = response.headers.get('content-type') ?? undefined;

      return {
        path: resolvedPath,
        sizeBytes: buffer.length,
        contentType,
      };
    } catch (error) {
      // Clean up partial file on write failure
      await this.cleanupFile(resolvedPath);
      throw new FileDownloadError(
        `Failed to write downloaded file to ${destPath}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  /**
   * Ensure a directory exists (mkdir -p).
   */
  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  /**
   * Resolve a relative path against projectRoot with traversal protection.
   * Rejects absolute paths, `..` sequences, and URL-encoded traversal.
   */
  resolvePath(relativePath: string): string {
    // Decode URL-encoded sequences first
    const decoded = decodeURIComponent(relativePath);

    // Reject absolute paths
    if (path.isAbsolute(decoded)) {
      throw new PathTraversalError(
        `Absolute paths are not allowed: ${relativePath}`,
      );
    }

    // Reject .. sequences (check both original and decoded)
    if (decoded.includes('..') || relativePath.includes('..')) {
      throw new PathTraversalError(
        `Path traversal detected: ${relativePath}`,
      );
    }

    const resolved = path.resolve(this.projectRoot, decoded);

    // Double-check the resolved path is within projectRoot
    if (!resolved.startsWith(this.projectRoot + path.sep) && resolved !== this.projectRoot) {
      throw new PathTraversalError(
        `Resolved path escapes project root: ${relativePath}`,
      );
    }

    return resolved;
  }

  private async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // Ignore — file might not exist
    }
  }
}
