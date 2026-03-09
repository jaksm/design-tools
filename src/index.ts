/**
 * openclaw-design-tools — Plugin Entry Point
 *
 * Design tooling for AI agents: Design Catalog, Design Vision, Stitch Native Tools.
 * Architecture: pure TS core + thin OC adapter layer.
 */

import { activate } from './adapter.js';
import type { DesignToolsContext } from './adapter.js';
import { designCatalog, type DesignCatalogParams } from './tools/design-catalog.js';

// Re-export core classes for direct usage
export { StitchClient } from './core/stitch-client.js';
export { CatalogManager } from './core/catalog-manager.js';
export { FileDownloadManager } from './core/file-manager.js';
export { activate, getMissingApiKeyError } from './adapter.js';
export { designCatalog } from './tools/design-catalog.js';
export type { DesignToolsContext } from './adapter.js';
export type { DesignCatalogParams } from './tools/design-catalog.js';

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

    // Register design_catalog tool
    return [
      {
        name: 'design_catalog',
        description: 'Manage design artifacts per project. Actions: list, add, version, status, link, show, remove.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'version', 'status', 'link', 'show', 'remove'],
              description: 'Action to perform',
            },
            screen: { type: 'string', description: 'Artifact screen name' },
            description: { type: 'string', description: 'Artifact description (add)' },
            html: { type: 'string', description: 'Path to HTML file (add, version)' },
            screenshot: { type: 'string', description: 'Path to screenshot file (add, version)' },
            status: { type: 'string', description: 'Target status (status action) or filter (list)' },
            reason: { type: 'string', description: 'Supersede reason (version)' },
            approvedBy: { type: 'string', description: 'Approver name (status → approved)' },
            notes: { type: 'string', description: 'Approval/rejection notes (status)' },
            mcTaskId: { type: ['string', 'null'], description: 'MC task ID (link)' },
            mcObjectiveId: { type: ['string', 'null'], description: 'MC objective ID (link)' },
            stitchProjectId: { type: 'string', description: 'Stitch project ID (add)' },
            stitchScreenId: { type: 'string', description: 'Stitch screen ID (add)' },
            deleteFiles: { type: 'boolean', description: 'Delete associated files on remove (default: false)' },
          },
          required: ['action'],
        },
        execute: async (params: DesignCatalogParams) => {
          return designCatalog(params, projectRoot);
        },
      },
    ];
  });

  api.logger.info('[design-tools] Plugin registered (1 tool: design_catalog)');
}
