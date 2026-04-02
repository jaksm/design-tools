/**
 * Barrel export for all design tool functions.
 *
 * Standalone usage (no OpenClaw required):
 *
 *   import { designCatalog, designVision, designGenerate } from '@jaksm/design-tools/tools'
 */

// ── Design Catalog ───────────────────────────────────────────────────────────

export { designCatalog, type DesignCatalogParams } from "./design-catalog.js";

// ── Design Vision (Gemini) ───────────────────────────────────────────────────

export { designVision, type DesignVisionParams } from "./design-vision.js";

// ── Stitch Native Tools ──────────────────────────────────────────────────────

export {
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
  type StitchToolsContext,
} from "./stitch-tools.js";

// ── Tool Metadata ────────────────────────────────────────────────────────────

export {
  toolMetadata,
  allToolMetadata,
  type ToolMetadataEntry,
  type ToolId,
} from "./metadata.js";
