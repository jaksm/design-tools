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
  designVariants,
  designEdit,
  designGet,
  designProjects,
  designScreens,
  designCreateProject,
  createStitchToolsContext,
  type DesignGenerateParams,
  type DesignVariantsParams,
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
export { DesignConfig } from './core/design-config.js';
export { activate } from './adapter.js';
export { designCatalog } from './tools/design-catalog.js';
export { designVision } from './tools/design-vision.js';
export { GeminiVisionClient } from './core/gemini-client.js';
export {
  designGenerate,
  designVariants,
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
  DesignVariantsParams,
  DesignEditParams,
  DesignGetParams,
  DesignProjectsParams,
  DesignScreensParams,
  DesignCreateProjectParams,
  StitchToolsContext,
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
      const quotaProjectId = context.config.get('stitch.quotaProjectId') || process.env.STITCH_QUOTA_PROJECT_ID || undefined;
      const stitchClient = new StitchClient({
        ...(quotaProjectId ? { quotaProjectId } : {}),
      });
      _stitchToolsCtx = createStitchToolsContext(stitchClient, projectRoot);
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
        description: [
          "Manage the design catalog — the registry of all design artifacts (screens) in the project.",
          "Use this to track design lifecycle: add screens to the catalog, update their status (draft → review → approved/rejected), create new versions, and link artifacts to MC tasks for traceability.",
          "Actions: 'list' (view all artifacts, optionally filter by status), 'add' (register a new screen), 'version' (create a new version of an existing screen), 'status' (approve/reject), 'link' (connect to MC task/objective), 'show' (view details), 'remove' (delete from catalog).",
          "The catalog is the source of truth for which designs exist and their approval state. Always check it before generating new screens.",
        ].join("\n"),
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
        execute: async (_toolCallId: string, params: DesignCatalogParams) => {
          return designCatalog(params, projectRoot);
        },
      },
      {
        name: 'design_vision',
        description: [
          "Analyze design screenshots using Gemini Vision. Six modes for different analysis needs.",
          "Modes: 'vibe' (aesthetic assessment with DIAGNOSE → PRESCRIBE fixes), 'extract' (pull reusable design tokens — colors, spacing, typography), 'compare' (rate visual match against a reference image), 'slop' (detect AI-generated generic feel), 'platform' (check native feel for ios/android/web/macos), 'broken' (find rendering bugs — overlaps, clipping, layout breakage).",
          "Use 'vibe' for overall design quality review, 'compare' to verify implementation matches spec, 'broken' before shipping to catch visual regressions.",
          "Pass a screenshot path via 'image' param. For 'compare' mode, also provide a 'reference' image or use 'screenId' for auto-reference from catalog.",
          "Set 'batch: true' to run a mode against all approved catalog screens at once.",
        ].join("\n"),
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
        execute: async (_toolCallId: string, params: DesignVisionParams) => {
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
        description: [
          "Generate a new design screen from a text prompt via the Stitch API.",
          "This is the ONLY way to create new screens. The tool handles the full pipeline: Stitch API call → HTML download → screenshot download → catalog registration → screen registry entry.",
          "Use this when starting a new screen from scratch. For iterating on an existing screen, use design_edit instead.",
          "NEVER write HTML/CSS manually — always use this tool to create screens via the Stitch API.",
          "Do not use file_write to create design artifacts. Results are automatically downloaded, catalogued, and registered.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Text description of the screen to generate (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (uses default if not provided)' },
            title: { type: 'string', description: 'Screen title (auto-derived from Stitch response if not provided)' },
            platform: { type: 'string', enum: ['ios', 'android', 'web'], description: 'Target platform (maps to device type)' },
            modelId: { type: 'string', enum: ['GEMINI_3_PRO', 'GEMINI_3_FLASH'], description: 'AI model to use for generation' },
          },
          required: ['prompt'],
        },
        execute: async (_toolCallId: string, params: DesignGenerateParams) => {
          return designGenerate(params, stitchCtx);
        },
      },
      {
        name: 'design_variants',
        description: [
          "Generate multiple visual variations of an existing screen via the Stitch API for design exploration.",
          "Use this for exploring different design directions — NOT for iterating on a specific screen. Each variant gets its own catalog entry and screen registry entry.",
          "Control variation with 'creativeRange' (conservative/moderate/adventurous) and 'aspects' (e.g. color, layout, typography).",
          "For refining a single screen toward a specific direction, use design_edit instead. Variants are for exploring, edits are for converging.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            screenId: { type: 'string', description: 'Stitch screen ID to generate variants from (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (looked up from registry if not provided)' },
            modelId: { type: 'string', enum: ['GEMINI_3_PRO', 'GEMINI_3_FLASH'], description: 'AI model to use for generation' },
            variantCount: { type: 'number', description: 'Number of variants to generate (1-5, default 2)' },
            creativeRange: { type: 'string', enum: ['conservative', 'moderate', 'adventurous'], description: 'How different variants should be from the original' },
            aspects: { type: 'array', items: { type: 'string' }, description: 'Design aspects to vary (e.g. "color", "layout", "typography")' },
          },
          required: ['screenId'],
        },
        execute: async (_toolCallId: string, params: DesignVariantsParams) => {
          return designVariants(params, stitchCtx);
        },
      },
      {
        name: 'design_edit',
        description: [
          "Edit an existing Stitch screen by providing edit instructions in natural language.",
          "Use this to iterate on existing screens, not regenerate from scratch. It preserves Stitch context from the previous version, maintaining design continuity.",
          "Pass the screenId from a previous design_generate or design_edit call. The tool auto-versions in the catalog (v1 → v2 → v3) and downloads updated HTML + screenshot.",
          "NEVER regenerate a screen from scratch when editing — use this tool to iterate. It preserves Stitch context and produces better results than starting over.",
          "NEVER write HTML/CSS manually. Do not use file_write to create design artifacts. Results are automatically downloaded, catalogued, and registered.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            screenId: { type: 'string', description: 'Stitch screen ID to edit (required)' },
            editPrompt: { type: 'string', description: 'Edit instructions (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (looked up from registry if not provided)' },
            modelId: { type: 'string', enum: ['GEMINI_3_PRO', 'GEMINI_3_FLASH'], description: 'AI model to use for editing' },
          },
          required: ['screenId', 'editPrompt'],
        },
        execute: async (_toolCallId: string, params: DesignEditParams) => {
          return designEdit(params, stitchCtx);
        },
      },
      {
        name: 'design_get',
        description: [
          "Fetch a screen's details and content from the Stitch API.",
          "Use this to download a screen you don't have locally yet, or to verify a screen exists and inspect its current state.",
          "Automatically downloads and caches HTML + screenshot files locally if not already present. Subsequent calls use the cached version.",
          "Pass a screenId (required) and optionally a projectId (auto-looked up from registry if omitted).",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            screenId: { type: 'string', description: 'Stitch screen ID (required)' },
            projectId: { type: 'string', description: 'Stitch project ID (looked up from registry if not provided)' },
          },
          required: ['screenId'],
        },
        execute: async (_toolCallId: string, params: DesignGetParams) => {
          return designGet(params, stitchCtx);
        },
      },
      {
        name: 'design_projects',
        description: [
          "List all Stitch projects accessible to the current user.",
          "Use this to find project IDs for use with other design tools (design_generate, design_edit, etc.).",
          "Returns project metadata including title, description, and ID.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async (_toolCallId: string, params: DesignProjectsParams) => {
          return designProjects(params, stitchCtx);
        },
      },
      {
        name: 'design_screens',
        description: [
          "List screens from the local screen registry. Does NOT call the Stitch API.",
          "Use this to see what screens have been generated or downloaded in the current workspace.",
          "Optionally filter by projectId. Returns screen metadata from the local registry only — if a screen exists on Stitch but hasn't been fetched, it won't appear here.",
          "To fetch a screen from Stitch into the local registry, use design_get.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Filter by Stitch project ID' },
          },
        },
        execute: async (_toolCallId: string, params: DesignScreensParams) => {
          return designScreens(params, stitchCtx);
        },
      },
      {
        name: 'design_create_project',
        description: [
          "Create a new Stitch project for organizing design screens.",
          "Use this when starting design work for a new product or feature that doesn't fit into an existing project.",
          "Check design_projects first to avoid creating duplicates. Each project acts as a container for related screens.",
        ].join("\n"),
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Project title (required)' },
            description: { type: 'string', description: 'Project description' },
          },
          required: ['title'],
        },
        execute: async (_toolCallId: string, params: DesignCreateProjectParams) => {
          return designCreateProject(params, stitchCtx);
        },
      },
    ];
  });

  api.logger.info('[design-tools] Plugin registered (9 tools: design_catalog, design_vision, design_generate, design_variants, design_edit, design_get, design_projects, design_screens, design_create_project)');
}
