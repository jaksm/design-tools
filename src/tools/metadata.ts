/**
 * Tool metadata — IDs, descriptions, and JSON Schema parameter definitions.
 *
 * @example
 * ```ts
 * import { toolMetadata } from '@jaksm/design-tools/tools'
 * const meta = toolMetadata.design_generate
 * ```
 */

export interface ToolMetadataEntry {
  id: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}

const design_catalog: ToolMetadataEntry = {
  id: "design_catalog",
  label: "Design Catalog",
  description: [
    "Manage the design catalog — the registry of all design artifacts (screens) in the project.",
    "Use this to track design lifecycle: add screens to the catalog, update their status (draft → review → approved/rejected), create new versions, and link artifacts to MC tasks for traceability.",
    "Actions: 'list' (view all artifacts, optionally filter by status), 'add' (register a new screen), 'version' (create a new version of an existing screen), 'status' (approve/reject), 'link' (connect to MC task/objective), 'show' (view details), 'remove' (delete from catalog).",
    "The catalog is the source of truth for which designs exist and their approval state. Always check it before generating new screens.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "version", "status", "link", "show", "remove"], description: "Action to perform" },
      screen: { type: "string", description: "Artifact screen name" },
      description: { type: "string", description: "Artifact description (add)" },
      html: { type: "string", description: "Path to HTML file (add, version)" },
      screenshot: { type: "string", description: "Path to screenshot file (add, version)" },
      status: { type: "string", description: "Target status (status action) or filter (list)" },
      reason: { type: "string", description: "Supersede reason (version)" },
      approvedBy: { type: "string", description: "Approver name (status → approved)" },
      notes: { type: "string", description: "Approval/rejection notes (status)" },
      mcTaskId: { type: ["string", "null"], description: "MC task ID (link)" },
      mcObjectiveId: { type: ["string", "null"], description: "MC objective ID (link)" },
      stitchProjectId: { type: "string", description: "Stitch project ID (add)" },
      stitchScreenId: { type: "string", description: "Stitch screen ID (add)" },
      deleteFiles: { type: "boolean", description: "Delete associated files on remove (default: false)" },
    },
    required: ["action"],
  },
};

const design_vision: ToolMetadataEntry = {
  id: "design_vision",
  label: "Design Vision",
  description: [
    "Analyze design screenshots using Gemini Vision. Six modes for different analysis needs.",
    "Modes: 'vibe' (aesthetic assessment with DIAGNOSE → PRESCRIBE fixes), 'extract' (pull reusable design tokens — colors, spacing, typography), 'compare' (rate visual match against a reference image), 'slop' (detect AI-generated generic feel), 'platform' (check native feel for ios/android/web/macos), 'broken' (find rendering bugs — overlaps, clipping, layout breakage).",
    "Use 'vibe' for overall design quality review, 'compare' to verify implementation matches spec, 'broken' before shipping to catch visual regressions.",
    "Pass a screenshot path via 'image' param. For 'compare' mode, also provide a 'reference' image or use 'screenId' for auto-reference from catalog.",
    "Set 'batch: true' to run a mode against all approved catalog screens at once.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["vibe", "extract", "compare", "slop", "platform", "broken"], description: "Analysis mode" },
      image: { type: "string", description: "Path to screenshot (required for most modes)" },
      screenshot: { type: "string", description: "Alias for image (used in compare mode)" },
      context: { type: "string", description: "Context about the design (vibe mode)" },
      spec: { type: "string", description: "Design specification to evaluate against (vibe mode)" },
      reference: { type: "string", description: "Path to reference image (compare mode)" },
      screenId: { type: "string", description: "Catalog screen ID for auto-reference resolution (compare mode) or screen selection" },
      versionA: { type: "string", description: "First version for comparison (compare mode)" },
      versionB: { type: "string", description: "Second version for comparison (compare mode)" },
      platform: { type: "string", enum: ["ios", "android", "web", "macos"], description: "Target platform (platform mode)" },
      batch: { type: "boolean", description: "Run mode against all approved catalog screens" },
    },
    required: ["mode"],
  },
};

const design_generate: ToolMetadataEntry = {
  id: "design_generate",
  label: "Generate Design Screen",
  description: [
    "Generate a new design screen from a text prompt via the Stitch API.",
    "This is the ONLY way to create new screens. The tool handles the full pipeline: Stitch API call → HTML download → screenshot download → catalog registration → screen registry entry.",
    "Use this when starting a new screen from scratch. For iterating on an existing screen, use design_edit instead.",
    "NEVER write HTML/CSS manually — always use this tool to create screens via the Stitch API.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Text description of the screen to generate (required)" },
      projectId: { type: "string", description: "Stitch project ID (uses default if not provided)" },
      title: { type: "string", description: "Screen title (auto-derived from Stitch response if not provided)" },
      platform: { type: "string", enum: ["ios", "android", "web"], description: "Target platform (maps to device type)" },
      modelId: { type: "string", enum: ["GEMINI_3_PRO", "GEMINI_3_FLASH"], description: "AI model to use for generation" },
    },
    required: ["prompt"],
  },
};

const design_variants: ToolMetadataEntry = {
  id: "design_variants",
  label: "Generate Design Variants",
  description: [
    "Generate multiple visual variations of an existing screen via the Stitch API for design exploration.",
    "Use this for exploring different design directions — NOT for iterating on a specific screen.",
    "Control variation with 'creativeRange' (conservative/moderate/adventurous) and 'aspects' (e.g. color, layout, typography).",
    "For refining a single screen toward a specific direction, use design_edit instead. Variants are for exploring, edits are for converging.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      screenId: { type: "string", description: "Stitch screen ID to generate variants from (required)" },
      projectId: { type: "string", description: "Stitch project ID (looked up from registry if not provided)" },
      modelId: { type: "string", enum: ["GEMINI_3_PRO", "GEMINI_3_FLASH"], description: "AI model to use for generation" },
      variantCount: { type: "number", description: "Number of variants to generate (1-5, default 2)" },
      creativeRange: { type: "string", enum: ["conservative", "moderate", "adventurous"], description: "How different variants should be from the original" },
      aspects: { type: "array", items: { type: "string" }, description: "Design aspects to vary (e.g. 'color', 'layout', 'typography')" },
    },
    required: ["screenId"],
  },
};

const design_edit: ToolMetadataEntry = {
  id: "design_edit",
  label: "Edit Design Screen",
  description: [
    "Edit an existing Stitch screen by providing edit instructions in natural language.",
    "Use this to iterate on existing screens, not regenerate from scratch. It preserves Stitch context from the previous version, maintaining design continuity.",
    "Pass the screenId from a previous design_generate or design_edit call. The tool auto-versions in the catalog (v1 → v2 → v3) and downloads updated HTML + screenshot.",
    "NEVER regenerate a screen from scratch when editing — use this tool to iterate.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      screenId: { type: "string", description: "Stitch screen ID to edit (required)" },
      editPrompt: { type: "string", description: "Edit instructions (required)" },
      projectId: { type: "string", description: "Stitch project ID (looked up from registry if not provided)" },
      modelId: { type: "string", enum: ["GEMINI_3_PRO", "GEMINI_3_FLASH"], description: "AI model to use for editing" },
    },
    required: ["screenId", "editPrompt"],
  },
};

const design_get: ToolMetadataEntry = {
  id: "design_get",
  label: "Get Design Screen",
  description: [
    "Fetch a screen's details and content from the Stitch API.",
    "Use this to download a screen you don't have locally yet, or to verify a screen exists and inspect its current state.",
    "Automatically downloads and caches HTML + screenshot files locally if not already present.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      screenId: { type: "string", description: "Stitch screen ID (required)" },
      projectId: { type: "string", description: "Stitch project ID (looked up from registry if not provided)" },
    },
    required: ["screenId"],
  },
};

const design_projects: ToolMetadataEntry = {
  id: "design_projects",
  label: "List Design Projects",
  description: [
    "List all Stitch projects accessible to the current user.",
    "Use this to find project IDs for use with other design tools.",
    "Returns project metadata including title, description, and ID.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
};

const design_screens: ToolMetadataEntry = {
  id: "design_screens",
  label: "List Design Screens",
  description: [
    "List screens from the local screen registry. Does NOT call the Stitch API.",
    "Use this to see what screens have been generated or downloaded in the current workspace.",
    "Optionally filter by projectId.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Filter by Stitch project ID" },
    },
    required: [],
  },
};

const design_create_project: ToolMetadataEntry = {
  id: "design_create_project",
  label: "Create Design Project",
  description: [
    "Create a new Stitch project for organizing design screens.",
    "Use this when starting design work for a new product or feature that doesn't fit into an existing project.",
    "Check design_projects first to avoid creating duplicates.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Project title (required)" },
      description: { type: "string", description: "Project description" },
    },
    required: ["title"],
  },
};

export const toolMetadata = {
  design_catalog,
  design_vision,
  design_generate,
  design_variants,
  design_edit,
  design_get,
  design_projects,
  design_screens,
  design_create_project,
} as const satisfies Record<string, ToolMetadataEntry>;

export const allToolMetadata: readonly ToolMetadataEntry[] = Object.values(toolMetadata);

export type ToolId = keyof typeof toolMetadata;
