# @jaksm/design-tools

Design tooling for AI agents — design artifact catalog, Gemini Vision analysis, and [Google Stitch](https://stitch.withgoogle.com/) integration for AI-powered screen generation.

Built for [OpenClaw](https://github.com/openclaw/openclaw) but works standalone with **any** agent framework.

## What's Inside

| Tool | What It Does |
|---|---|
| `design_catalog` | Track design artifacts (screens) through their lifecycle: draft → review → approved/rejected. Version management, MC task linking. |
| `design_vision` | Analyze screenshots with Gemini Vision — vibe check, extract tokens, compare to reference, detect AI slop, platform-native check, find rendering bugs. |
| `design_generate` | Generate new screens from text prompts via Google Stitch API. Full pipeline: API → download HTML/screenshot → catalog → registry. |
| `design_edit` | Iterate on existing screens with natural language instructions. Preserves Stitch context across edits. Auto-versions in catalog. |
| `design_variants` | Explore design directions with multiple variations. Control divergence (conservative/moderate/adventurous) and aspects (color, layout, typography). |
| `design_get` | Fetch screen details from Stitch. Auto-downloads and caches locally. |
| `design_projects` | List Stitch projects. |
| `design_screens` | List locally-registered screens. |
| `design_create_project` | Create new Stitch projects. |

## Installation

### As an OpenClaw Plugin

```bash
openclaw plugin add @jaksm/design-tools
```

### As a Standalone Package

```bash
npm install @jaksm/design-tools
```

## Usage

### OpenClaw Plugin (zero config)

Install and tools appear in your agent's tool list. Configure Stitch and Gemini API keys via plugin config or environment variables.

### Standalone — Design Catalog

```typescript
import { designCatalog } from '@jaksm/design-tools/tools'

// List all screens
const list = await designCatalog({ action: 'list' }, '/path/to/project')

// Add a new screen
await designCatalog({
  action: 'add',
  screen: 'login-screen',
  description: 'Main login page with OAuth buttons',
  html: './designs/login.html',
  screenshot: './designs/login.png',
}, '/path/to/project')

// Approve a screen
await designCatalog({
  action: 'status',
  screen: 'login-screen',
  status: 'approved',
  approvedBy: 'designer',
  notes: 'Visual fidelity matches spec',
}, '/path/to/project')
```

### Standalone — Design Vision (Gemini)

```typescript
import { GeminiVisionClient } from '@jaksm/design-tools/core'
import { designVision } from '@jaksm/design-tools/tools'

const client = new GeminiVisionClient({ apiKey: process.env.GEMINI_API_KEY! })

// Vibe check a design
const vibe = await designVision(
  { mode: 'vibe', image: './screenshots/dashboard.png' },
  client,
  '/path/to/project',
)

// Extract design tokens
const tokens = await designVision(
  { mode: 'extract', image: './screenshots/dashboard.png' },
  client,
  '/path/to/project',
)

// Compare implementation to reference
const compare = await designVision(
  { mode: 'compare', image: './screenshots/impl.png', reference: './designs/spec.png' },
  client,
  '/path/to/project',
)
```

### Standalone — Stitch Screen Generation

```typescript
import { StitchClient } from '@jaksm/design-tools/core'
import { designGenerate, designEdit, createStitchToolsContext } from '@jaksm/design-tools/tools'

// Initialize Stitch client (uses ADC or STITCH_API_KEY)
const stitch = new StitchClient()
const ctx = createStitchToolsContext(stitch, '/path/to/project')

// Generate a new screen
const screen = await designGenerate({
  prompt: 'Modern dark dashboard with project cards, activity feed, and status indicators',
  platform: 'web',
}, ctx)

// Iterate on it
const edited = await designEdit({
  screenId: screen.data.screenId,
  editPrompt: 'Make the sidebar collapsible and add a search bar at the top',
}, ctx)
```

## Design Vision Modes

| Mode | Purpose | Output |
|---|---|---|
| `vibe` | Aesthetic assessment | DIAGNOSE → PRESCRIBE pattern with specific fixes |
| `extract` | Pull design tokens | Colors, spacing, typography, patterns as reusable specs |
| `compare` | Rate visual match | Strong/Partial/Weak/No match score with detailed diff |
| `slop` | AI slop detection | Distinctive/Acceptable/Generic/Slop rating |
| `platform` | Platform-native check | iOS/Android/Web/macOS conformance analysis |
| `broken` | Rendering bug detection | Overlaps, clipping, layout breakage identification |

## Configuration

### Environment Variables

| Variable | Required For | Description |
|---|---|---|
| `GEMINI_API_KEY` | `design_vision` | Google AI Studio API key for Gemini Vision |
| `STITCH_QUOTA_PROJECT_ID` | Stitch tools | Google Cloud project ID for Stitch API quota |

### OpenClaw Plugin Config

```json
{
  "gemini": {
    "apiKey": "your-key-here"
  },
  "stitch": {
    "quotaProjectId": "your-gcp-project-id"
  }
}
```

## Architecture

```
@jaksm/design-tools
├── src/
│   ├── index.ts          # OpenClaw plugin adapter + re-exports
│   ├── adapter.ts        # Thin OC adapter layer
│   ├── core/             # Pure TypeScript core
│   │   ├── stitch-client.ts    # Google Stitch API client
│   │   ├── gemini-client.ts    # Gemini Vision API client
│   │   ├── catalog-manager.ts  # Design artifact lifecycle
│   │   ├── screen-registry.ts  # Local screen metadata registry
│   │   ├── file-manager.ts     # HTML/screenshot download manager
│   │   ├── design-config.ts    # Configuration management
│   │   └── types.ts            # All type definitions
│   └── tools/            # Tool implementations
│       ├── index.ts      # Barrel export
│       ├── design-catalog.ts
│       ├── design-vision.ts
│       └── stitch-tools.ts
```

## Requirements

- Node.js >= 20
- For Design Vision: Gemini API key (Google AI Studio)
- For Stitch tools: Google Cloud authentication (ADC or API key)

## License

MIT
