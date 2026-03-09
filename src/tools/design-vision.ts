/**
 * design_vision tool — Visual analysis engine with 6 modes, powered by Gemini Vision API.
 *
 * Modes: vibe, extract, compare, slop, platform, broken
 * Integrates with design_catalog for auto-reference resolution and batch analysis.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { GeminiVisionClient } from '../core/gemini-client.js';

// ── Constants ───────────────────────────────────────────────────────────────

const VALID_MODES = ['vibe', 'extract', 'compare', 'slop', 'platform', 'broken'] as const;
type Mode = (typeof VALID_MODES)[number];

const VALID_PLATFORMS = ['ios', 'android', 'web', 'macos'] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

const VALID_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

const VIBE_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const VIBE_EFFORTS = ['minimal', 'moderate', 'significant'] as const;
const COMPARE_RATINGS = ['Strong', 'Partial', 'Weak', 'No'] as const;
const SLOP_TIERS = ['Distinctive', 'Acceptable', 'Generic', 'Slop'] as const;
const BUG_SEVERITIES = ['critical', 'warning', 'info'] as const;
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

// ── Result Types ────────────────────────────────────────────────────────────

interface SuccessResult {
  success: true;
  [key: string]: unknown;
}

interface ErrorResult {
  success: false;
  error: string;
  code: string;
}

type ToolResult = SuccessResult | ErrorResult;

// ── Input Params ────────────────────────────────────────────────────────────

export interface DesignVisionParams {
  mode?: string;
  image?: string;
  // vibe-specific
  context?: string;
  spec?: string;
  // compare-specific
  screenshot?: string;
  reference?: string;
  screenId?: string;
  versionA?: string;
  versionB?: string;
  // platform-specific
  platform?: string;
  // catalog integration
  batch?: boolean;
  // project root override
  projectRoot?: string;
  [key: string]: unknown;
}

// ── Catalog Types (minimal, for reading catalog.json) ───────────────────────

interface CatalogVersion {
  version: number;
  html?: string;
  screenshot?: string;
  createdAt: string;
  approvedAt?: string;
  [key: string]: unknown;
}

interface CatalogArtifact {
  id: string;
  screen: string;
  status: string;
  currentVersion: number;
  versions: CatalogVersion[];
  [key: string]: unknown;
}

interface DesignCatalog {
  version: number;
  artifacts: CatalogArtifact[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function err(message: string, code: string): ErrorResult {
  return { success: false, error: message, code };
}

function isValidImageExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return VALID_IMAGE_EXTENSIONS.includes(ext);
}

function validateImagePath(imagePath: string, _projectRoot: string): ErrorResult | null {
  // Path traversal check
  if (imagePath.includes('..')) {
    return err(
      `Path traversal detected in image path: \`${imagePath}\`. Paths must not contain \`...\``,
      'PATH_TRAVERSAL',
    );
  }

  // Extension check
  if (!isValidImageExtension(imagePath)) {
    const ext = path.extname(imagePath) || '(none)';
    return err(
      `Unsupported file type: ${ext}. Accepted: ${VALID_IMAGE_EXTENSIONS.join(', ')}`,
      'INVALID_FILE_TYPE',
    );
  }

  return null;
}

function resolveImagePath(imagePath: string, projectRoot: string): string {
  if (path.isAbsolute(imagePath)) {
    return imagePath;
  }
  return path.resolve(projectRoot, imagePath);
}

async function readAndValidateImage(
  imagePath: string,
  projectRoot: string,
): Promise<{ buffer: Buffer; resolvedPath: string; sizeBytes: number } | ErrorResult> {
  const pathErr = validateImagePath(imagePath, projectRoot);
  if (pathErr) return pathErr;

  const resolvedPath = resolveImagePath(imagePath, projectRoot);

  try {
    const buffer = await fs.readFile(resolvedPath);
    const sizeBytes = buffer.length;

    if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
      return err(
        `Image exceeds 20MB Gemini limit. Got ${sizeMB}MB.`,
        'IMAGE_TOO_LARGE',
      );
    }

    return { buffer, resolvedPath, sizeBytes };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return err(`Image file not found: \`${imagePath}\``, 'FILE_NOT_FOUND');
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read image: ${message}`, 'FILE_READ_ERROR');
  }
}

function isErrorResult(result: unknown): result is ErrorResult {
  return typeof result === 'object' && result !== null && (result as ErrorResult).success === false;
}

async function readCatalog(projectRoot: string): Promise<DesignCatalog | ErrorResult> {
  const catalogPath = path.join(projectRoot, 'design-artifacts', 'catalog.json');
  try {
    const raw = await fs.readFile(catalogPath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.artifacts) {
      return data as DesignCatalog;
    }
    if (data.entries) {
      return { version: data.version, artifacts: data.entries };
    }
    return { version: 1, artifacts: [] };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return err(
        'Design catalog not found. Run `design_catalog` with `action: add` to create entries first.',
        'CATALOG_NOT_FOUND',
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return err(`Failed to read design catalog: ${message}`, 'CATALOG_READ_ERROR');
  }
}

function resolveScreenFromCatalog(
  catalog: DesignCatalog,
  screenId: string,
): { screenshotPath: string; warning?: string } | ErrorResult {
  const artifact = catalog.artifacts.find((a) => a.screen === screenId);
  if (!artifact) {
    return err(
      `Screen '${screenId}' not found in design catalog. Run \`design_catalog list\` to see available screens.`,
      'SCREEN_NOT_FOUND',
    );
  }

  // Find latest approved version
  const approvedVersions = artifact.versions.filter((v) => v.approvedAt);
  if (approvedVersions.length > 0) {
    const latest = approvedVersions.sort((a, b) => b.version - a.version)[0]!;
    if (latest.screenshot) {
      return { screenshotPath: latest.screenshot };
    }
  }

  // Fallback: check if the artifact status is 'approved' or 'implemented'
  if (artifact.status === 'approved' || artifact.status === 'implemented') {
    const currentVer = artifact.versions.find((v) => v.version === artifact.currentVersion);
    if (currentVer?.screenshot) {
      return { screenshotPath: currentVer.screenshot };
    }
  }

  // No approved version — use latest with warning
  const sorted = [...artifact.versions].sort((a, b) => b.version - a.version);
  if (sorted.length > 0 && sorted[0]!.screenshot) {
    return {
      screenshotPath: sorted[0]!.screenshot,
      warning: `No approved version found for '${screenId}' — using latest (v${sorted[0]!.version})`,
    };
  }

  return err(
    `Screen '${screenId}' has no versions with screenshots.`,
    'NO_SCREENSHOT',
  );
}

function resolveVersionFromCatalog(
  catalog: DesignCatalog,
  screenId: string,
  version: string,
): { screenshotPath: string } | ErrorResult {
  const artifact = catalog.artifacts.find((a) => a.screen === screenId);
  if (!artifact) {
    return err(
      `Screen '${screenId}' not found in design catalog. Run \`design_catalog list\` to see available screens.`,
      'SCREEN_NOT_FOUND',
    );
  }

  const versionNum = parseInt(version.replace(/^v/, ''), 10);
  if (isNaN(versionNum)) {
    return err(`Invalid version format: '${version}'. Use 'v1', 'v2', etc.`, 'INVALID_VERSION');
  }

  const ver = artifact.versions.find((v) => v.version === versionNum);
  if (!ver) {
    return err(
      `Version ${version} not found for screen '${screenId}'. Available versions: ${artifact.versions.map((v) => `v${v.version}`).join(', ')}`,
      'VERSION_NOT_FOUND',
    );
  }

  if (!ver.screenshot) {
    return err(`Version ${version} of '${screenId}' has no screenshot.`, 'NO_SCREENSHOT');
  }

  return { screenshotPath: ver.screenshot };
}

// ── Gemini Prompt Templates ─────────────────────────────────────────────────

function buildVibePrompt(context?: string, spec?: string): string {
  let prompt = `You are a senior UI/UX design critic. Analyze this screenshot and provide an aesthetic assessment.

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "score": <integer 1-10, where 10 is exceptional design>,
  "strengths": [<string descriptions of what works well>],
  "weaknesses": [<string descriptions of what needs improvement>],
  "fixes": [
    {
      "description": <string: specific actionable fix>,
      "priority": <"critical" | "high" | "medium" | "low">,
      "effort": <"minimal" | "moderate" | "significant">
    }
  ]
}

Rules:
- score MUST be an integer (no decimals)
- priority MUST be one of: "critical", "high", "medium", "low"
- effort MUST be one of: "minimal", "moderate", "significant"
- strengths and weaknesses are arrays of strings
- fixes is an array (may be empty for great designs)`;

  if (context) {
    prompt += `\n\nContext about this design: ${context}`;
  }
  if (spec) {
    prompt += `\n\nDesign specification/direction to evaluate against: ${spec}`;
  }

  return prompt;
}

function buildExtractPrompt(): string {
  return `You are a design system analyst. Extract the design decisions from this screenshot.

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "colors": [
    { "name": <string: descriptive name like "Primary Blue">, "hex": <string: #RRGGBB format>, "role": <string: "primary" | "secondary" | "accent" | "background" | "text" | "success" | "warning" | "error" | "info" | "border" | "surface"> }
  ],
  "typography": [
    { "family": <string: font family name>, "size": <string: size with unit e.g. "16px">, "weight": <number: 100-900>, "usage": <string: where it's used e.g. "headings", "body text"> }
  ],
  "spacing": {
    "density": <"compact" | "comfortable" | "spacious">,
    "pattern": <string: description of spacing pattern>,
    "baseUnit": <string: detected base spacing unit e.g. "8px", "4px">
  },
  "patterns": [<string: detected UI patterns like "card-grid", "sidebar-nav", "data-table", "floating-action-button">]
}

Rules:
- All hex values MUST match #RRGGBB format (6 chars, no alpha)
- density MUST be one of: "compact", "comfortable", "spacious"
- Detect ALL visible colors, typography scales, and UI patterns
- If a value cannot be determined, use a reasonable estimate with a note`;
}

function buildComparePrompt(): string {
  return `You are a design comparison expert. Compare these two designs and assess their visual similarity.

The FIRST image is the design being evaluated.
The SECOND image is the reference/inspiration design.

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "rating": <"Strong" | "Partial" | "Weak" | "No">,
  "differences": [<string: specific visual differences between the designs>],
  "similarities": [<string: specific visual similarities between the designs>]
}

Rules:
- rating MUST be one of: "Strong", "Partial", "Weak", "No" (title-cased exactly)
- "Strong" = very close visual match
- "Partial" = some elements match, others differ significantly  
- "Weak" = few similarities, mostly different
- "No" = completely different designs
- differences and similarities are arrays of descriptive strings`;
}

function buildSlopPrompt(): string {
  return `You are a design originality assessor. Analyze this screenshot for signs of AI-generated generic design ("slop").

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "tier": <"Distinctive" | "Acceptable" | "Generic" | "Slop">,
  "indicators": [<string: specific indicators of generic/AI-generated design OR distinctive design choices>]
}

Rules:
- tier MUST be one of: "Distinctive", "Acceptable", "Generic", "Slop" (title-cased exactly)
- "Distinctive" = unique, clearly human-crafted design identity
- "Acceptable" = mostly original with minor generic elements
- "Generic" = looks like a template or AI-generated design
- "Slop" = obvious AI slop — stock photos, default gradients, generic hero sections, meaningless copy
- indicators: list specific visual evidence supporting the tier rating
- For "Distinctive" tier, indicators may be empty or list what makes it distinctive`;
}

function buildPlatformPrompt(platform: Platform): string {
  const guidelines: Record<Platform, string> = {
    ios: 'Apple Human Interface Guidelines (HIG)',
    android: 'Material Design 3 guidelines',
    web: 'W3C accessibility guidelines (WCAG) and modern web conventions',
    macos: 'macOS Human Interface Guidelines (HIG)',
  };

  return `You are a platform design expert specializing in ${guidelines[platform]}. Analyze this screenshot for platform-native design compliance.

Target platform: ${platform.toUpperCase()}
Reference guidelines: ${guidelines[platform]}

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "score": <integer 1-10, where 10 is perfectly native-feeling>,
  "violations": [
    {
      "guideline": <string: name of the violated guideline>,
      "description": <string: specific description of the violation>,
      "severity": <"critical" | "warning" | "info">
    }
  ],
  "recommendations": [<string: specific actionable recommendations for better platform conformance>]
}

Rules:
- score MUST be an integer (no decimals)
- severity MUST be one of: "critical", "warning", "info"
- violations is an array (may be empty for perfectly native design)
- recommendations should reference specific platform components or patterns
- Be specific about which guideline is violated, not generic advice`;
}

function buildBrokenPrompt(): string {
  return `You are a QA engineer specializing in visual bug detection. Analyze this screenshot for rendering bugs.

RESPOND WITH ONLY VALID JSON. No markdown, no explanation, no code fences.

Output schema:
{
  "bugs": [
    {
      "type": <string: bug type e.g. "overlap", "clipping", "layout-break", "z-index", "overflow", "misalignment", "truncation">,
      "location": <string: human-readable description of where in the UI>,
      "severity": <"critical" | "warning" | "info">,
      "description": <string: detailed description of the rendering bug>
    }
  ]
}

Rules:
- severity MUST be one of: "critical", "warning", "info"
- bugs is an array (may be empty for clean designs with no rendering issues)
- type should be a short category identifier
- location should describe WHERE in the UI the bug is visible
- description should describe WHAT is wrong`;
}

// ── Response Validation & Normalization ──────────────────────────────────────

function parseGeminiJson(text: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch?.[1]) {
      try {
        return JSON.parse(fenceMatch[1]);
      } catch {
        // Fall through
      }
    }
    // Try finding first { to last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through
      }
    }
    throw new Error(`Failed to parse Gemini response as JSON. Raw response: ${text.slice(0, 200)}`);
  }
}

function clampInt(value: unknown, min: number, max: number): number {
  const num = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (isNaN(num)) return min;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function normalizeEnum<T extends string>(value: unknown, valid: readonly T[], fallback?: T): T | null {
  const str = String(value);
  // Exact match
  if (valid.includes(str as T)) return str as T;
  // Case-insensitive match
  const lower = str.toLowerCase();
  const match = valid.find((v) => v.toLowerCase() === lower);
  if (match) return match;
  return fallback ?? null;
}

function validateVibeResponse(parsed: unknown): {
  score: number;
  strengths: string[];
  weaknesses: string[];
  fixes: Array<{ description: string; priority: string; effort: string }>;
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const missing: string[] = [];
  if (obj.score === undefined) missing.push('score');
  if (!Array.isArray(obj.strengths)) missing.push('strengths');
  if (obj.weaknesses === undefined) missing.push('weaknesses');
  if (obj.fixes === undefined) missing.push('fixes');

  if (missing.length > 0) {
    throw new Error(`Gemini vibe response missing required fields: ${missing.join(', ')}`);
  }

  const score = clampInt(obj.score, 1, 10);
  const strengths = (obj.strengths as unknown[]).map(String);
  const weaknesses = Array.isArray(obj.weaknesses) ? (obj.weaknesses as unknown[]).map(String) : [];
  const fixes = Array.isArray(obj.fixes)
    ? (obj.fixes as Array<Record<string, unknown>>).map((f) => ({
        description: String(f.description ?? ''),
        priority: normalizeEnum(f.priority, VIBE_PRIORITIES) ?? 'medium',
        effort: normalizeEnum(f.effort, VIBE_EFFORTS) ?? 'moderate',
      }))
    : [];

  return { score, strengths, weaknesses, fixes };
}

function validateExtractResponse(parsed: unknown): {
  colors: Array<{ name: string; hex: string; role: string }>;
  typography: Array<{ family: string; size: string; weight: number; usage: string }>;
  spacing: { density: string; pattern: string; baseUnit: string };
  patterns: string[];
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const missing: string[] = [];
  if (!Array.isArray(obj.colors)) missing.push('colors');
  if (!Array.isArray(obj.typography)) missing.push('typography');
  if (!obj.spacing || typeof obj.spacing !== 'object') missing.push('spacing');
  if (!Array.isArray(obj.patterns)) missing.push('patterns');

  if (missing.length > 0) {
    throw new Error(`Gemini extract response missing required fields: ${missing.join(', ')}`);
  }

  const colors = (obj.colors as Array<Record<string, unknown>>).map((c) => ({
    name: String(c.name ?? ''),
    hex: String(c.hex ?? '#000000'),
    role: String(c.role ?? 'unknown'),
  }));

  const typography = (obj.typography as Array<Record<string, unknown>>).map((t) => ({
    family: String(t.family ?? ''),
    size: String(t.size ?? ''),
    weight: typeof t.weight === 'number' ? t.weight : parseInt(String(t.weight ?? '400'), 10),
    usage: String(t.usage ?? ''),
  }));

  const spacingObj = obj.spacing as Record<string, unknown>;
  const spacing = {
    density: normalizeEnum(spacingObj.density, ['compact', 'comfortable', 'spacious'] as const) ?? 'comfortable',
    pattern: String(spacingObj.pattern ?? ''),
    baseUnit: String(spacingObj.baseUnit ?? '8px'),
  };

  const patterns = (obj.patterns as unknown[]).map(String);

  return { colors, typography, spacing, patterns };
}

function validateCompareResponse(parsed: unknown): {
  rating: string;
  differences: string[];
  similarities: string[];
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const missing: string[] = [];
  if (obj.rating === undefined) missing.push('rating');
  if (!Array.isArray(obj.differences)) missing.push('differences');
  if (!Array.isArray(obj.similarities)) missing.push('similarities');

  if (missing.length > 0) {
    throw new Error(`Gemini compare response missing required fields: ${missing.join(', ')}`);
  }

  const rating = normalizeEnum(obj.rating, COMPARE_RATINGS);
  if (!rating) {
    throw new Error(`Invalid compare rating: '${String(obj.rating)}'. Must be one of: ${COMPARE_RATINGS.join(', ')}`);
  }

  const differences = (obj.differences as unknown[]).map(String);
  const similarities = (obj.similarities as unknown[]).map(String);

  return { rating, differences, similarities };
}

function validateSlopResponse(parsed: unknown): {
  tier: string;
  indicators: string[];
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const missing: string[] = [];
  if (obj.tier === undefined) missing.push('tier');
  if (!Array.isArray(obj.indicators)) missing.push('indicators');

  if (missing.length > 0) {
    throw new Error(`Gemini slop response missing required fields: ${missing.join(', ')}`);
  }

  const tier = normalizeEnum(obj.tier, SLOP_TIERS);
  if (!tier) {
    throw new Error(`Invalid slop tier: '${String(obj.tier)}'. Must be one of: ${SLOP_TIERS.join(', ')}`);
  }

  const indicators = (obj.indicators as unknown[]).map(String);

  return { tier, indicators };
}

function validatePlatformResponse(parsed: unknown): {
  score: number;
  violations: Array<{ guideline: string; description: string; severity: string }>;
  recommendations: string[];
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  const missing: string[] = [];
  if (obj.score === undefined) missing.push('score');
  if (!Array.isArray(obj.violations)) missing.push('violations');
  if (!Array.isArray(obj.recommendations)) missing.push('recommendations');

  if (missing.length > 0) {
    throw new Error(`Gemini platform response missing required fields: ${missing.join(', ')}`);
  }

  const score = clampInt(obj.score, 1, 10);
  const violations = (obj.violations as Array<Record<string, unknown>>).map((v) => ({
    guideline: String(v.guideline ?? ''),
    description: String(v.description ?? ''),
    severity: normalizeEnum(v.severity, BUG_SEVERITIES) ?? 'warning',
  }));
  const recommendations = (obj.recommendations as unknown[]).map(String);

  return { score, violations, recommendations };
}

function validateBrokenResponse(parsed: unknown): {
  bugs: Array<{ type: string; location: string; severity: string; description: string }>;
} {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini response is not an object');
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.bugs)) {
    throw new Error('Gemini broken response missing required field: bugs');
  }

  const bugs = (obj.bugs as Array<Record<string, unknown>>)
    .map((b) => ({
      type: String(b.type ?? ''),
      location: String(b.location ?? ''),
      severity: normalizeEnum(b.severity, BUG_SEVERITIES) ?? 'warning',
      description: String(b.description ?? ''),
    }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99));

  return { bugs };
}

// ── Mode Handlers ───────────────────────────────────────────────────────────

async function handleVibe(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  const imagePath = params.image ?? params.screenshot;
  if (!imagePath) {
    return err('Missing required parameter: `image`. Provide a path to a screenshot.', 'MISSING_PARAM');
  }

  const imageResult = await readAndValidateImage(imagePath, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  const prompt = buildVibePrompt(params.context, params.spec);

  try {
    const response = await gemini.analyze(imageResult.buffer, prompt);
    const parsed = parseGeminiJson(response.text);
    const validated = validateVibeResponse(parsed);

    const processingMs = Date.now() - startMs;
    const usage = gemini.usage;

    const result: SuccessResult = {
      success: true,
      mode: 'vibe',
      ...validated,
      timestamp,
      image: { path: imagePath, sizeBytes: imageResult.sizeBytes },
      processingMs,
    };

    if (usage.remaining <= 50) {
      result.warning = `Approaching Gemini daily rate limit (${usage.today}/${usage.limit} RPD)`;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

async function handleExtract(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  const imagePath = params.image ?? params.screenshot;
  if (!imagePath) {
    return err('Missing required parameter: `image`. Provide a path to a screenshot.', 'MISSING_PARAM');
  }

  const imageResult = await readAndValidateImage(imagePath, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await gemini.analyze(imageResult.buffer, buildExtractPrompt());
    const parsed = parseGeminiJson(response.text);
    const validated = validateExtractResponse(parsed);

    const processingMs = Date.now() - startMs;
    const usage = gemini.usage;

    const result: SuccessResult = {
      success: true,
      mode: 'extract',
      ...validated,
      timestamp,
      image: { path: imagePath, sizeBytes: imageResult.sizeBytes },
      processingMs,
    };

    if (usage.remaining <= 50) {
      result.warning = `Approaching Gemini daily rate limit (${usage.today}/${usage.limit} RPD)`;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

async function handleCompare(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  // Version comparison mode: screenId + versionA + versionB
  if (params.screenId && params.versionA && params.versionB) {
    const catalog = await readCatalog(projectRoot);
    if (isErrorResult(catalog)) return catalog;

    const resolvedA = resolveVersionFromCatalog(catalog, params.screenId, params.versionA);
    if (isErrorResult(resolvedA)) return resolvedA;

    const resolvedB = resolveVersionFromCatalog(catalog, params.screenId, params.versionB);
    if (isErrorResult(resolvedB)) return resolvedB;

    const imageA = await readAndValidateImage(resolvedA.screenshotPath, projectRoot);
    if (isErrorResult(imageA)) return imageA;

    const imageB = await readAndValidateImage(resolvedB.screenshotPath, projectRoot);
    if (isErrorResult(imageB)) return imageB;

    const timestamp = new Date().toISOString();
    const startMs = Date.now();

    try {
      // Combine both images in the prompt
      const combinedBuffer = Buffer.concat([imageA.buffer, imageB.buffer]);
      const response = await gemini.analyze(combinedBuffer, buildComparePrompt());
      const parsed = parseGeminiJson(response.text);
      const validated = validateCompareResponse(parsed);

      const processingMs = Date.now() - startMs;

      return {
        success: true,
        mode: 'compare',
        ...validated,
        timestamp,
        image: { path: resolvedA.screenshotPath, sizeBytes: imageA.sizeBytes },
        reference: { path: resolvedB.screenshotPath, sizeBytes: imageB.sizeBytes },
        processingMs,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(message, 'GEMINI_ERROR');
    }
  }

  // Standard compare: need screenshot + (reference OR screenId)
  const imagePath = params.image ?? params.screenshot;
  if (!imagePath && !params.screenId) {
    return err(
      'Missing required parameter: `screenshot` (or `image`). Provide a path to the design being evaluated.',
      'MISSING_PARAM',
    );
  }

  if (!params.reference && !params.screenId) {
    return err(
      'Missing reference for compare mode. Provide either `reference` (path to reference image) or `screenId` (to auto-resolve from design catalog).',
      'MISSING_PARAM',
    );
  }

  let referencePath: string;
  let warning: string | undefined;

  if (params.screenId) {
    const catalog = await readCatalog(projectRoot);
    if (isErrorResult(catalog)) return catalog;

    const resolved = resolveScreenFromCatalog(catalog, params.screenId);
    if (isErrorResult(resolved)) return resolved;

    referencePath = resolved.screenshotPath;
    warning = resolved.warning;
  } else {
    referencePath = params.reference!;
  }

  const imageResult = await readAndValidateImage(imagePath!, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const refResult = await readAndValidateImage(referencePath, projectRoot);
  if (isErrorResult(refResult)) return refResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    // Combine both images
    const combinedBuffer = Buffer.concat([imageResult.buffer, refResult.buffer]);
    const response = await gemini.analyze(combinedBuffer, buildComparePrompt());
    const parsed = parseGeminiJson(response.text);
    const validated = validateCompareResponse(parsed);

    const processingMs = Date.now() - startMs;

    const result: SuccessResult = {
      success: true,
      mode: 'compare',
      ...validated,
      timestamp,
      image: { path: imagePath!, sizeBytes: imageResult.sizeBytes },
      reference: { path: referencePath, sizeBytes: refResult.sizeBytes },
      processingMs,
    };

    if (warning) {
      result.warning = warning;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

async function handleSlop(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  const imagePath = params.image ?? params.screenshot;
  if (!imagePath) {
    return err('Missing required parameter: `image`. Provide a path to a screenshot.', 'MISSING_PARAM');
  }

  const imageResult = await readAndValidateImage(imagePath, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await gemini.analyze(imageResult.buffer, buildSlopPrompt());
    const parsed = parseGeminiJson(response.text);
    const validated = validateSlopResponse(parsed);

    const processingMs = Date.now() - startMs;
    const usage = gemini.usage;

    const result: SuccessResult = {
      success: true,
      mode: 'slop',
      ...validated,
      timestamp,
      image: { path: imagePath, sizeBytes: imageResult.sizeBytes },
      processingMs,
    };

    if (usage.remaining <= 50) {
      result.warning = `Approaching Gemini daily rate limit (${usage.today}/${usage.limit} RPD)`;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

async function handlePlatform(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  if (!params.platform) {
    return err(
      `Missing required parameter: \`platform\`. Valid values: ${VALID_PLATFORMS.join(', ')}`,
      'MISSING_PARAM',
    );
  }

  const platform = normalizeEnum(params.platform, VALID_PLATFORMS);
  if (!platform) {
    return err(
      `Invalid platform: \`${params.platform}\`. Valid values: ${VALID_PLATFORMS.join(', ')}`,
      'INVALID_PARAM',
    );
  }

  const imagePath = params.image ?? params.screenshot;
  if (!imagePath) {
    return err('Missing required parameter: `image`. Provide a path to a screenshot.', 'MISSING_PARAM');
  }

  const imageResult = await readAndValidateImage(imagePath, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await gemini.analyze(imageResult.buffer, buildPlatformPrompt(platform));
    const parsed = parseGeminiJson(response.text);
    const validated = validatePlatformResponse(parsed);

    const processingMs = Date.now() - startMs;
    const usage = gemini.usage;

    const result: SuccessResult = {
      success: true,
      mode: 'platform',
      platform,
      ...validated,
      timestamp,
      image: { path: imagePath, sizeBytes: imageResult.sizeBytes },
      processingMs,
    };

    if (usage.remaining <= 50) {
      result.warning = `Approaching Gemini daily rate limit (${usage.today}/${usage.limit} RPD)`;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

async function handleBroken(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  const imagePath = params.image ?? params.screenshot;
  if (!imagePath) {
    return err('Missing required parameter: `image`. Provide a path to a screenshot.', 'MISSING_PARAM');
  }

  const imageResult = await readAndValidateImage(imagePath, projectRoot);
  if (isErrorResult(imageResult)) return imageResult;

  const timestamp = new Date().toISOString();
  const startMs = Date.now();

  try {
    const response = await gemini.analyze(imageResult.buffer, buildBrokenPrompt());
    const parsed = parseGeminiJson(response.text);
    const validated = validateBrokenResponse(parsed);

    const processingMs = Date.now() - startMs;
    const usage = gemini.usage;

    const result: SuccessResult = {
      success: true,
      mode: 'broken',
      ...validated,
      timestamp,
      image: { path: imagePath, sizeBytes: imageResult.sizeBytes },
      processingMs,
    };

    if (usage.remaining <= 50) {
      result.warning = `Approaching Gemini daily rate limit (${usage.today}/${usage.limit} RPD)`;
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(message, 'GEMINI_ERROR');
  }
}

// ── Batch Mode ──────────────────────────────────────────────────────────────

async function handleBatch(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  projectRoot: string,
): Promise<ToolResult> {
  const mode = params.mode as Mode;
  if (mode === 'compare') {
    return err('Batch mode is not supported for compare mode.', 'INVALID_PARAM');
  }

  const catalog = await readCatalog(projectRoot);
  if (isErrorResult(catalog)) return catalog;

  if (catalog.artifacts.length === 0) {
    return {
      success: true,
      mode,
      batch: true,
      results: [],
      message: 'Design catalog is empty. Add screens with `design_catalog` before running batch analysis.',
    };
  }

  // Find approved screens with screenshots
  const approved: Array<{ screen: string; screenshotPath: string }> = [];
  const skipped: string[] = [];

  for (const artifact of catalog.artifacts) {
    if (artifact.status !== 'approved' && artifact.status !== 'implemented') {
      skipped.push(artifact.screen);
      continue;
    }
    const currentVer = artifact.versions.find((v) => v.version === artifact.currentVersion);
    if (currentVer?.screenshot) {
      approved.push({ screen: artifact.screen, screenshotPath: currentVer.screenshot });
    } else {
      skipped.push(artifact.screen);
    }
  }

  if (approved.length === 0) {
    return {
      success: true,
      mode,
      batch: true,
      results: [],
      skipped,
      message: 'No approved screens with screenshots found in catalog.',
    };
  }

  const results: Array<{ screen: string; result: ToolResult }> = [];

  for (const { screen, screenshotPath } of approved) {
    const batchParams = { ...params, image: screenshotPath, batch: false };
    let result: ToolResult;

    switch (mode) {
      case 'vibe':
        result = await handleVibe(batchParams, gemini, projectRoot);
        break;
      case 'extract':
        result = await handleExtract(batchParams, gemini, projectRoot);
        break;
      case 'slop':
        result = await handleSlop(batchParams, gemini, projectRoot);
        break;
      case 'platform':
        result = await handlePlatform(batchParams, gemini, projectRoot);
        break;
      case 'broken':
        result = await handleBroken(batchParams, gemini, projectRoot);
        break;
      default:
        result = err(`Unexpected mode: ${mode}`, 'INTERNAL_ERROR');
    }

    results.push({ screen, result });
  }

  return {
    success: true,
    mode,
    batch: true,
    results,
    skipped: skipped.length > 0 ? skipped : undefined,
  } as SuccessResult;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function designVision(
  params: DesignVisionParams,
  gemini: GeminiVisionClient,
  defaultProjectRoot: string,
): Promise<ToolResult> {
  try {
    // Validate mode
    if (!params.mode) {
      return err(
        `Missing required parameter: \`mode\`. Valid modes: ${VALID_MODES.join(', ')}`,
        'MISSING_PARAM',
      );
    }

    if (!VALID_MODES.includes(params.mode as Mode)) {
      return err(
        `Invalid mode: \`${params.mode}\`. Valid modes: ${VALID_MODES.join(', ')}`,
        'INVALID_MODE',
      );
    }

    const projectRoot = params.projectRoot ?? defaultProjectRoot;

    // Batch mode handler
    if (params.batch) {
      return await handleBatch(params, gemini, projectRoot);
    }

    // Handle screenId resolution for non-compare modes
    if (params.screenId && params.mode !== 'compare') {
      const catalog = await readCatalog(projectRoot);
      if (isErrorResult(catalog)) return catalog;

      const resolved = resolveScreenFromCatalog(catalog, params.screenId);
      if (isErrorResult(resolved)) return resolved;

      params = { ...params, image: resolved.screenshotPath };
    }

    switch (params.mode as Mode) {
      case 'vibe':
        return await handleVibe(params, gemini, projectRoot);
      case 'extract':
        return await handleExtract(params, gemini, projectRoot);
      case 'compare':
        return await handleCompare(params, gemini, projectRoot);
      case 'slop':
        return await handleSlop(params, gemini, projectRoot);
      case 'platform':
        return await handlePlatform(params, gemini, projectRoot);
      case 'broken':
        return await handleBroken(params, gemini, projectRoot);
      default:
        return err(`Unknown mode: \`${params.mode}\``, 'INVALID_MODE');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`Internal error: ${message}`, 'INTERNAL_ERROR');
  }
}
