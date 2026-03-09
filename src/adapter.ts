/**
 * OC Plugin Adapter — thin boundary layer.
 * Reads config, initializes core classes. Zero business logic.
 */

import { StitchClient } from './core/stitch-client.js';
import { CatalogManager } from './core/catalog-manager.js';
import { FileDownloadManager } from './core/file-manager.js';
import type { PluginContext } from './core/types.js';

export interface DesignToolsContext {
  stitchClient: StitchClient;
  catalogManager: CatalogManager | null;
  fileManager: FileDownloadManager | null;
}

/**
 * Activate the Design Tools plugin.
 * Initializes core infrastructure. Tools are registered separately.
 * Uses Google ADC (Application Default Credentials) — no API key needed.
 */
export function activate(context: PluginContext, projectRoot?: string): DesignToolsContext {
  const quotaProjectId = context.config.get('stitch.quotaProjectId') || process.env.STITCH_QUOTA_PROJECT_ID || undefined;

  const stitchClient = new StitchClient({
    ...(quotaProjectId ? { quotaProjectId } : {}),
  });

  const catalogManager = projectRoot ? new CatalogManager(projectRoot) : null;
  const fileManager = projectRoot ? new FileDownloadManager(projectRoot) : null;

  context.logger.info('[design-tools] Plugin activated (using ADC for Stitch auth)');

  return {
    stitchClient,
    catalogManager,
    fileManager,
  };
}
