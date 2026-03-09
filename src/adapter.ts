/**
 * OC Plugin Adapter — thin boundary layer.
 * Reads config, initializes core classes. Zero business logic.
 */

import { StitchClient } from './core/stitch-client.js';
import { CatalogManager } from './core/catalog-manager.js';
import { FileDownloadManager } from './core/file-manager.js';
import type { PluginContext } from './core/types.js';

export interface DesignToolsContext {
  stitchClient: StitchClient | null;
  catalogManager: CatalogManager | null;
  fileManager: FileDownloadManager | null;
  apiKey: string | null;
}

/**
 * Activate the Design Tools plugin.
 * Initializes core infrastructure. Tools are registered separately.
 */
export function activate(context: PluginContext, projectRoot?: string): DesignToolsContext {
  const apiKey = context.config.get('stitch.apiKey') || process.env.STITCH_API_KEY || null;

  if (!apiKey) {
    context.logger.warn(
      '[design-tools] Stitch API key not configured. ' +
      'Set stitch.apiKey in OpenClaw config or STITCH_API_KEY environment variable.',
    );
  }

  const stitchClient = apiKey ? new StitchClient({ apiKey }) : null;
  const catalogManager = projectRoot ? new CatalogManager(projectRoot) : null;
  const fileManager = projectRoot ? new FileDownloadManager(projectRoot) : null;

  context.logger.info('[design-tools] Plugin activated');

  return {
    stitchClient,
    catalogManager,
    fileManager,
    apiKey,
  };
}

/**
 * Get an actionable error message when Stitch API key is missing.
 */
export function getMissingApiKeyError(): string {
  return 'Stitch API key not configured. Set `stitch.apiKey` in OpenClaw config or `STITCH_API_KEY` environment variable.';
}
