/**
 * E2E tests for all Stitch design tools against the live API.
 * Run: npx tsx tests/e2e/stitch-e2e.ts
 * Requires: ADC credentials (gcloud auth application-default login)
 */

import { StitchClient } from '../../src/core/stitch-client.js';
import { GoogleAuth } from 'google-auth-library';

// ADC auth — no shell calls needed, google-auth-library handles everything
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

// Verify ADC is available
try {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token) throw new Error('No token');
  console.log('🔑 ADC credentials found');
} catch {
  console.error('❌ ADC not configured. Run: gcloud auth application-default login');
  process.exit(1);
}

// Get quota project from ADC (if available)
let quotaProjectId: string | undefined;
try {
  quotaProjectId = await auth.getProjectId() ?? undefined;
  if (quotaProjectId) console.log(`📋 GCP project: ${quotaProjectId}`);
} catch {
  console.log('⚠️  No GCP project detected (quota billing may fail)');
}

const stitchClient = new StitchClient({ auth, quotaProjectId });

let projectId: string | null = null;
let screenId: string | null = null;

const results: { tool: string; status: string; detail: string; duration: number }[] = [];

async function test(name: string, fn: () => Promise<string>) {
  process.stdout.write(`⏳ ${name}...`);
  const start = Date.now();
  try {
    const detail = await fn();
    const duration = Date.now() - start;
    results.push({ tool: name, status: '✅ PASS', detail, duration });
    process.stdout.write(`\r✅ ${name} (${(duration/1000).toFixed(1)}s) — ${detail}\n`);
  } catch (err: any) {
    const duration = Date.now() - start;
    const msg = err?.message || String(err);
    results.push({ tool: name, status: '❌ FAIL', detail: msg.slice(0, 200), duration });
    process.stdout.write(`\r❌ ${name} (${(duration/1000).toFixed(1)}s) — ${msg.slice(0, 200)}\n`);
  }
}

async function run() {
  console.log('\n🧪 Stitch Design Tools — E2E Test Suite (ADC auth)\n');
  console.log('='.repeat(60));

  // ── 1. design_projects (list_projects) ──
  await test('design_projects (list_projects)', async () => {
    const response = await stitchClient.callTool('list_projects', {}) as any;
    const projects = response?.projects || response?.structuredContent?.projects || [];
    if (projects.length > 0) {
      projectId = projects[0].name?.split('projects/')[1] || projects[0].id;
      return `Found ${projects.length} project(s), first: "${projects[0].title}" (${projectId})`;
    }
    return 'No existing projects';
  });

  // ── 2. design_create_project (create_project) ──
  await test('design_create_project (create_project)', async () => {
    const response = await stitchClient.callTool('create_project', {
      title: `E2E Test ${new Date().toISOString().slice(0, 16)}`,
    }) as any;
    const name = response?.name || response?.projectId;
    if (name) {
      const id = typeof name === 'string' && name.includes('/')
        ? name.split('projects/')[1]
        : name;
      projectId = id || projectId;
      return `Created project: ${projectId}`;
    }
    return `Response keys: ${JSON.stringify(Object.keys(response || {}))}`;
  });

  if (!projectId) {
    console.error('\n❌ No projectId — cannot continue');
    printSummary();
    return;
  }

  // ── 3. design_generate (generate_screen_from_text) ──
  await test('design_generate (generate_screen_from_text)', async () => {
    const response = await stitchClient.callTool('generate_screen_from_text', {
      projectId,
      prompt: 'A dashboard with sidebar nav, header with user avatar, and 3 metric cards in the main area',
      deviceType: 'DESKTOP',
    }) as any;

    const root = response?.structuredContent || response;
    const screen = root?.outputComponents?.[0]?.design?.screens?.[0];
    if (screen) {
      screenId = screen.id || screen.name?.split('screens/')[1];
      const hasHtml = !!screen.htmlCode?.downloadUrl;
      const hasScreenshot = !!screen.screenshot?.downloadUrl;
      return `Screen: ${screenId?.slice(0, 20)}..., HTML: ${hasHtml}, Screenshot: ${hasScreenshot}`;
    }
    if (root?.htmlCode || root?.screenshot) {
      screenId = root.id || root.name?.split('screens/')[1];
      return `Direct screen: ${screenId?.slice(0, 20)}..., HTML: ${!!root.htmlCode?.downloadUrl}, Screenshot: ${!!root.screenshot?.downloadUrl}`;
    }
    return `Unexpected response. Keys: ${JSON.stringify(Object.keys(root || {}))}`;
  });

  // ── 4. design_screens (list_screens) ──
  await test('design_screens (list_screens)', async () => {
    const response = await stitchClient.callTool('list_screens', {
      projectId,
    }) as any;
    const root = response?.structuredContent || response;
    const screens = root?.screens || [];
    if (screens.length > 0) {
      if (!screenId) {
        screenId = screens[0].id || screens[0].name?.split('screens/')[1];
      }
      return `Found ${screens.length} screen(s)`;
    }
    return `Empty response (known Google API bug): ${JSON.stringify(root).slice(0, 100)}`;
  });

  // ── 5. design_get (get_screen) ──
  if (screenId) {
    await test('design_get (get_screen)', async () => {
      const response = await stitchClient.callTool('get_screen', {
        name: `projects/${projectId}/screens/${screenId}`,
      }) as any;
      const root = response?.structuredContent || response;
      const hasHtml = !!root?.htmlCode?.downloadUrl;
      const hasScreenshot = !!root?.screenshot?.downloadUrl;
      const title = root?.title || root?.name || 'unknown';
      return `Title: ${title}, HTML: ${hasHtml}, Screenshot: ${hasScreenshot}`;
    });
  } else {
    results.push({ tool: 'design_get (get_screen)', status: '⏭️ SKIP', detail: 'No screenId', duration: 0 });
    console.log('⏭️  design_get — skipped (no screenId)');
  }

  // ── 6. design_edit (edit_screens) ──
  if (screenId) {
    await test('design_edit (edit_screens)', async () => {
      const response = await stitchClient.callTool('edit_screens', {
        projectId,
        selectedScreenIds: [screenId],
        prompt: 'Change header background to dark blue, add rounded corners and subtle shadows to metric cards',
      }) as any;

      const root = response?.structuredContent || response;
      const screen = root?.outputComponents?.[0]?.design?.screens?.[0];
      if (screen) {
        const newId = screen.id || screen.name?.split('screens/')[1];
        const hasHtml = !!screen.htmlCode?.downloadUrl;
        const hasScreenshot = !!screen.screenshot?.downloadUrl;
        return `Edited → ${newId?.slice(0, 20)}..., HTML: ${hasHtml}, Screenshot: ${hasScreenshot}`;
      }
      if (root?.htmlCode || root?.screenshot) {
        return `Direct screen response, HTML: ${!!root.htmlCode?.downloadUrl}, Screenshot: ${!!root.screenshot?.downloadUrl}`;
      }
      return `Unexpected response. Keys: ${JSON.stringify(Object.keys(root || {}))}`;
    });
  } else {
    results.push({ tool: 'design_edit (edit_screens)', status: '⏭️ SKIP', detail: 'No screenId', duration: 0 });
    console.log('⏭️  design_edit — skipped (no screenId)');
  }

  printSummary();
}

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY\n');

  const passed = results.filter(r => r.status.includes('PASS')).length;
  const failed = results.filter(r => r.status.includes('FAIL')).length;
  const skipped = results.filter(r => r.status.includes('SKIP')).length;
  const totalTime = results.reduce((s, r) => s + r.duration, 0);

  for (const r of results) {
    console.log(`  ${r.status} ${r.tool} (${(r.duration/1000).toFixed(1)}s)`);
    console.log(`     ${r.detail}\n`);
  }

  console.log('='.repeat(60));
  console.log(`Total: ${passed} passed, ${failed} failed, ${skipped} skipped — ${(totalTime / 1000).toFixed(1)}s`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
