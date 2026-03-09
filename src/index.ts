/**
 * openclaw-design-tools — Plugin Entry Point
 *
 * Design tooling for AI agents: Design Catalog, Design Vision, Stitch Native Tools.
 * Architecture: pure TS core + thin OC adapter layer.
 */

import { activate } from './adapter.js';
import type { DesignToolsContext } from './adapter.js';
import { designCatalog, type DesignCatalogParams } from './tools/design-catalog.js';
import { designVision, type DesignVisionParams } from './tools/design-vision.js';
import { GeminiVisionClient } from './core/gemini-client.js';
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
  type DesignProjectsParams,
  type DesignScreensParams,
  type DesignCreateProjectParams,
} from './tools/stitch-tools.js';
import { StitchClient } from './core/stitch-client.js';

// Re-export core classes for direct usage
export { StitchClient } from './core/stitch-client.js';
export { CatalogManager } from './core/catalog-manager.js';
export { FileDownloadManager } from './core/file-manager.js';
export { ScreenRegistryManager } from './core/screen-registry.js';
export { activate, getMissingApiKeyError } from './adapter.js';
export { designCatalog } from './tools/design-catalog.js';
export { designVision } from './tools/design-vision.js';
export { GeminiVisionClient } from './core/gemini-client.js';
export {
  designGenerate,
  designEdit,
  designGet,
  designProjects,
  designScreens,
  designCreateProject,
  createStitchToolsContext,
} from './tools/stitch-tools.js';
export type { DesignToolsContext } from './adapter.js';
export type { DesignCatalogParams } from './tools/design-catalog.js';
export type { DesignVisionParams } from './tools/design-vision.js';
export type {
  DesignGenerateParams,
  DesignEditParams,
  DesignGetParams,
  DesignProjectsParams,
  DesignScreensParams,
  DesignCreateProjectParams,
} from './tools/stitch-tools.js';

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
  let _stitchToolsCtx: ReturnType<typeof createStitchToolsContext> | null = null;

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

    // Initialize Stitch tools context (once per session)
    if (!_stitchToolsCtx) {
      const stitchApiKey = context.config.get('stitch.apiKey') || process.env.STITCH_API_KEY || null;
      const stitchClient = stitchApiKey ? new StitchClient({ apiKey: stitchApiKey }) : null;
      const defaultProjectId = context.config.get('stitch.defaultProjectId') || process.env.STITCH_DEFAULT_PROJECT_ID || undefined;
      _stitchToolsCtx = createStitchToolsContext(stitchClient, projectRoot, defaultProjectId);
    }

    // Initialize Gemini client (lazy — only when design_vision is called)
    const geminiApiKey = context.config.get('gemini.apiKey') || process.env.GEMINI_API_KEY || null;
    let geminiClient: GeminiVisionClient | null = null;

    function getGeminiClient(): GeminiVisionClient {
      if (!geminiClient) {
        if (!geminiApiKey) {
          throw new Error(
            'Gemini API key not configured. Set gemini.apiKey in plugin config or GEMINI_API_KEY environment variable.',
          );
        }
        geminiClient = new GeminiVisionClient({ apiKey: geminiApiKey });
      }
      return geminiClient;
    }

    const stitchCtx = _stitchToolsCtx;

    // Register all tools
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
      {
        name: 'design_vision',
        description: 'Visual analysis engine with 6 modes: vibe (aesthetic assessment), extract (design tokens), compare (vs reference), slop (AI slop detection), platform (native feel check), broken (rendering bug detection). Powered by Gemini Vision API.',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['vibe', 'extract', 'compare', 'slop', 'platform', 'broken'],
              description: 'Analysis mode',
            },
            image: { type: 'string', description: 'Path to screenshot (required for most modes)' },
            screenshot: { type: 'string', description: 'Alias for image (used in compare mode)' },
            context: { type: 'string', description: 'Context about the design (vibe mode)' },
            spec: { type: 'string', description: 'Design specification to evaluate against (vibe mode)' },
            reference: { type: 'string', description: 'Path to reference image (compare mode)' },
            screenId: { type: 'string', description: 'Catalog screen ID for auto-reference resolution (compare mode) or screen selection' },
            versionA: { type: 'string', description: 'First version for comparison (compare mode, e.g. "v1")' },
            versionB: { type: 'string', description: 'Second version for comparison (compare mode, e.g. "v2")' },
            platform: {
              type: 'string',
              enum: ['ios', 'android', 'web', 'macos'],
              description: 'Target platform (platform mode)',
            },
            batch: { type: 'boolean', description: 'Run mode against all approved catalog screens' },
          },
          required: ['mode'],
        },
        execute: async (params: DesignVisionParams) => {
          try {
            const client = getGeminiClient();
            return await designVision(params, client, projectRoot);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message, code: 'GEMINI_INIT_ERROR' };
          }
        },
      },
      // ── Stitch Native Tools ─────────────────────────────────────────────
      {
        name: 'design_generate',
        description: 'Generate a new screen from text via Stitch API. Auto-downloads HTML + screenshot and registers in catalog.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Text description of the screen to generate (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (uses default if not provided)' },
            title: { type: 'string', description: 'Screen title (auto-derived from Stitch response if not provided)' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'], description: 'Target platform (maps to device type)' },
            colorMode: { type: 'string', enum: ['light', 'dark'], description: 'Color mode for the generated screen' },
            customColor: { type: 'string', description: 'Custom primary color (hex)' },
          },
          required: ['prompt'],
        },
        execute: async (params: DesignGenerateParams) => {
          return designGenerate(params, stitchCtx);
        },
      },
      {
        name: 'design_edit',
        description: 'Edit an existing Stitch screen. Auto-downloads updated HTML + screenshot and versions in catalog.',
        parameters: {
          type: 'object',
          properties: {
            screenId: { type: 'string', description: 'Stitch screen ID to edit (required)' },
            editPrompt: { type: 'string', description: 'Edit instructions (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (looked up from registry if not provided)' },
          },
          required: ['screenId', 'editPrompt'],
        },
        execute: async (params: DesignEditParams) => {
          return designEdit(params, stitchCtx);
        },
      },
      {
        name: 'design_get',
        description: 'Get screen details + content from Stitch. Downloads HTML + screenshot if not cached locally.',
        parameters: {
          type: 'object',
          properties: {
            screenId: { type: 'string', description: 'Stitch screen ID (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (looked up from registry if not provided)' },
          },
          required: ['screenId'],
        },
        execute: async (params: DesignGetParams) => {
          return designGet(params, stitchCtx);
        },
      },
      {
        name: 'design_projects',
        description: 'List all accessible Stitch projects.',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async (params: DesignProjectsParams) => {
          return designProjects(params, stitchCtx);
        },
      },
      {
        name: 'design_screens',
        description: 'List screens from local registry (workaround for broken Stitch list_screens). Never calls Stitch API.',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Filter by Stitch project ID' },
          },
        },
        execute: async (params: DesignScreensParams) => {
          return designScreens(params, stitchCtx);
        },
      },
      {
        name: 'design_create_project',
        description: 'Create a new Stitch project.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Project title (required)' },
            description: { type: 'string', description: 'Project description' },
          },
          required: ['title'],
        },
        execute: async (params: DesignCreateProjectParams) => {
          return designCreateProject(params, stitchCtx);
        },
      },
    ];
  });

  api.logger.info('[design-tools] Plugin registered (8 tools: design_catalog, design_vision, design_generate, design_edit, design_get, design_projects, design_screens, design_create_project)');
}
