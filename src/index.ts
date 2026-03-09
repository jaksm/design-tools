/**
 * openclaw-design-tools — Plugin Entry Point
 *
 * Design tooling for AI agents: Design Catalog, Design Vision, Stitch Native Tools.
 * Architecture: pure TS core + thin OC adapter layer.
 */

import { activate } from './adapter.js';
import type { DesignToolsContext } from './adapter.js';

// Re-export core classes for direct usage
export { StitchClient } from './core/stitch-client.js';
export { CatalogManager } from './core/catalog-manager.js';
export { FileDownloadManager } from './core/file-manager.js';
export { activate, getMissingApiKeyError } from './adapter.js';
export type { DesignToolsContext } from './adapter.js';

// Re-export types
export * from './core/types.js';

// ── OC Plugin Interface ─────────────────────────────────────────────────────

interface OpenClawPluginApi {
  id: string;
  name: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  pluginConfig?: Record<string, unknown>;
  registerTool: (factory: (ctx: { workspaceDir?: string }) => unknown[] | null, opts?: Record<string, unknown>) => void;
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: Record<string, unknown>) => void;
}

/**
 * OC plugin registration entry point.
 * For now, registers zero tools — just initializes the infrastructure.
 */
export default function register(api: OpenClawPluginApi): void {
  const pluginConfig = api.pluginConfig ?? {};

  const context = {
    config: {
      get(key: string): string | undefined {
        // Navigate dot-separated keys in config
        const parts = key.split('.');
        let current: unknown = pluginConfig;
        for (const part of parts) {
          if (current && typeof current === 'object') {
            current = (current as Record<string, unknown>)[part];
          } else {
            return undefined;
          }
        }
        return typeof current === 'string' ? current : undefined;
      },
    },
    logger: api.logger,
  };

  let _designTools: DesignToolsContext | null = null;

  // Register tool factory — runs per session
  api.registerTool((ctx) => {
    const projectRoot = ctx.workspaceDir;
    if (!projectRoot) {
      api.logger.warn('[design-tools] No workspaceDir available — skipping initialization');
      return null;
    }

    // Initialize infrastructure (once per session)
    if (!_designTools) {
      _designTools = activate(context, projectRoot);
    }

    // No tools registered yet — infrastructure only
    return [];
  });

  api.logger.info('[design-tools] Plugin registered (infrastructure only, 0 tools)');
}
