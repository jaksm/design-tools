/**
 * E2E Integration Test — Real Stitch + Gemini APIs
 * Run: npx tsx e2e-test.ts
 */
import { StitchClient } from './src/core/stitch-client.js';
import { CatalogManager } from './src/core/catalog-manager.js';
import { GeminiVisionClient } from './src/core/gemini-client.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const GEMINI_KEY = process.env.GOOGLE_PLACES_API_KEY || process.env.GEMINI_API_KEY || '';
let ACCESS_TOKEN = '';
try { ACCESS_TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim(); } catch {}
const PROJECT_ROOT = '/tmp/e2e-design-tools-test';
// Use the existing swiftui-experiment-1 project (mobile) for mobile tests
const STITCH_MOBILE_PROJECT = '307477256142191053';

// Clean + setup
if (fs.existsSync(PROJECT_ROOT)) fs.rmSync(PROJECT_ROOT, { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, 'design-artifacts', 'screens'), { recursive: true });

const stitch = new StitchClient({ accessToken: ACCESS_TOKEN, projectId: 'savvy-generator-486813-d1' });
const catalog = new CatalogManager(PROJECT_ROOT);

const results: Array<{ test: string; status: string; detail?: string }> = [];

function log(test: string, status: 'PASS' | 'FAIL' | 'SKIP', detail?: string) {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
  console.log(`${icon} ${test}${detail ? ` — ${detail}` : ''}`);
  results.push({ test, status, detail });
}

async function downloadFile(url: string, destPath: string): Promise<number> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

async function run() {
  console.log('\n🔬 E2E Integration Test — OpenClaw Design Tools\n');
  console.log(`Stitch token: ${ACCESS_TOKEN ? '✅ present' : '❌ missing'}`);
  console.log(`Gemini key: ${GEMINI_KEY ? '✅ present' : '❌ missing'}`);
  console.log(`Test dir: ${PROJECT_ROOT}\n`);
  if (!ACCESS_TOKEN) { console.log('⚠️ No gcloud token'); return; }

  await catalog.init();

  // ===== TEST 1: generate_screen_from_text (mobile) =====
  let mobileScreenId = '';
  let mobileScreenshot = '';
  try {
    console.log('\n📱 TEST 1: Generate mobile fitness dashboard...');
    const resp = await stitch.callTool('generate_screen_from_text', {
      projectId: STITCH_MOBILE_PROJECT,
      prompt: 'A fitness tracking iOS app dashboard. Daily step count 8432/10000 with circular progress ring. Heart rate 72 BPM with mini sparkline. Sleep 7h 23m. Weekly activity bar chart. Recent workouts list: Morning Run, Yoga, Swimming. Bottom tab bar: Home, Activity, Stats, Profile.',
      deviceType: 'MOBILE',
    }) as any;

    const screen = resp?.outputComponents?.[0]?.design?.screens?.[0]
                || resp?.screens?.[0];

    if (screen?.id) {
      mobileScreenId = screen.id;
      log('Generate mobile screen', 'PASS', `id: ${mobileScreenId}`);

      // Download HTML
      const htmlUrl = screen?.htmlCode?.downloadUrl;
      if (htmlUrl) {
        const htmlPath = path.join(PROJECT_ROOT, 'design-artifacts', 'screens', 'fitness-dashboard', 'v1.html');
        const bytes = await downloadFile(htmlUrl, htmlPath);
        log('Download HTML', 'PASS', `${bytes} bytes`);
      }

      // Download screenshot
      const pngUrl = screen?.screenshot?.downloadUrl;
      if (pngUrl) {
        const pngPath = path.join(PROJECT_ROOT, 'design-artifacts', 'screens', 'fitness-dashboard', 'v1.png');
        const bytes = await downloadFile(pngUrl, pngPath);
        mobileScreenshot = pngPath;
        log('Download screenshot', 'PASS', `${bytes} bytes`);
      }

      // Catalog registration
      await catalog.addEntry({
        id: 'fitness-dashboard',
        screen: 'fitness-dashboard',
        description: 'iOS fitness tracking dashboard',
        status: 'draft',
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          createdBy: 'e2e-test',
          files: {
            html: 'design-artifacts/screens/fitness-dashboard/v1.html',
            screenshot: 'design-artifacts/screens/fitness-dashboard/v1.png'
          }
        }]
      });
      log('Catalog registration', 'PASS');
    } else {
      log('Generate mobile screen', 'FAIL', `resp: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  } catch (e: any) {
    log('Generate mobile screen', 'FAIL', e.message);
  }

  // ===== TEST 2: generate_screen_from_text (desktop) =====
  let desktopProjectId = '';
  let desktopScreenshot = '';
  try {
    console.log('\n🖥️  TEST 2: Create project + generate desktop dashboard...');
    const createResp = await stitch.callTool('create_project', { title: 'E2E Desktop Test' }) as any;
    desktopProjectId = createResp?.project?.name?.split('/').pop()
                    || createResp?.name?.split('/').pop()
                    || STITCH_MOBILE_PROJECT;
    log('Create project', 'PASS', `id: ${desktopProjectId}`);

    const resp = await stitch.callTool('generate_screen_from_text', {
      projectId: desktopProjectId,
      prompt: 'Dark SaaS admin dashboard. Left sidebar navigation: Dashboard, Analytics, Users, Settings, Billing. Main area: revenue area chart last 30 days, 4 metric cards (MRR $12.4K, Users 2847, Churn 3.2%, NPS 72), recent activity table 5 rows. Top bar with search and user avatar. Dark background, blue accent.',
      deviceType: 'DESKTOP',
    }) as any;

    const screen = resp?.outputComponents?.[0]?.design?.screens?.[0] || resp?.screens?.[0];

    if (screen?.id) {
      log('Generate desktop screen', 'PASS', `id: ${screen.id}`);

      const pngUrl = screen?.screenshot?.downloadUrl;
      if (pngUrl) {
        const pngPath = path.join(PROJECT_ROOT, 'design-artifacts', 'screens', 'admin-dashboard', 'v1.png');
        const bytes = await downloadFile(pngUrl, pngPath);
        desktopScreenshot = pngPath;
        log('Download desktop screenshot', 'PASS', `${bytes} bytes`);
      }
      const htmlUrl = screen?.htmlCode?.downloadUrl;
      if (htmlUrl) {
        const htmlPath = path.join(PROJECT_ROOT, 'design-artifacts', 'screens', 'admin-dashboard', 'v1.html');
        await downloadFile(htmlUrl, htmlPath);
        log('Download desktop HTML', 'PASS');
      }
    } else {
      log('Generate desktop screen', 'FAIL', JSON.stringify(resp).slice(0, 200));
    }
  } catch (e: any) {
    log('Generate desktop screen', 'FAIL', e.message);
  }

  // ===== TEST 3: edit_screens =====
  if (mobileScreenId) {
    try {
      console.log('\n✏️  TEST 3: Edit mobile screen...');
      const resp = await stitch.callTool('edit_screens', {
        projectId: STITCH_MOBILE_PROJECT,
        selectedScreenIds: [mobileScreenId],
        prompt: 'Add a water intake tracker showing 6/8 glasses as a horizontal progress bar with blue gradient. Add a prominent green "Start Workout" button at the bottom.',
      }) as any;

      const screen = resp?.outputComponents?.[0]?.design?.screens?.[0] || resp?.screens?.[0];
      if (screen?.id) {
        log('Edit screen', 'PASS', `new id: ${screen.id}`);
        const pngUrl = screen?.screenshot?.downloadUrl;
        if (pngUrl) {
          const pngPath = path.join(PROJECT_ROOT, 'design-artifacts', 'screens', 'fitness-dashboard', 'v2.png');
          const bytes = await downloadFile(pngUrl, pngPath);
          log('Download edited screenshot', 'PASS', `${bytes} bytes`);
        }
      } else {
        log('Edit screen', 'FAIL', JSON.stringify(resp).slice(0, 200));
      }
    } catch (e: any) {
      log('Edit screen', 'FAIL', e.message);
    }
  } else {
    log('Edit screen', 'SKIP', 'No screen ID');
  }

  // ===== TEST 4: Design Vision (6 modes) =====
  const testImage = mobileScreenshot || desktopScreenshot;
  if (testImage && GEMINI_KEY) {
    const gemini = new GeminiVisionClient({ apiKey: GEMINI_KEY, model: 'gemini-2.5-flash' });
    const imgBuf = fs.readFileSync(testImage);
    console.log('\n👁️  TEST 4: Design Vision — 6 modes...');

    const modes = [
      { name: 'vibe',     prompt: 'Rate this UI 1-10. JSON only: {"score":8,"strengths":["clean layout"],"weaknesses":["generic colors"],"fixes":[{"description":"Use brand colors","priority":"high","effort":"minimal"}]}' },
      { name: 'extract',  prompt: 'Extract design tokens. JSON only: {"colors":[{"name":"primary","hex":"#3B82F6","role":"accent"}],"typography":[{"family":"SF Pro","size":"16px"}],"spacing":{"density":"normal"},"patterns":[]}' },
      { name: 'slop',     prompt: 'Is this AI-generated looking? JSON only: {"tier":"Acceptable","indicators":["clean spacing","consistent typography"]}' },
      { name: 'platform', prompt: 'iOS HIG compliance. JSON only: {"score":8,"violations":[],"recommendations":["Add haptic feedback"]}' },
      { name: 'broken',   prompt: 'Rendering bugs? JSON only: {"bugs":[]}' },
      { name: 'compare',  prompt: 'Design style. JSON only: {"rating":"Strong","differences":["mobile vs desktop"],"similarities":["card layouts"]}' },
    ];

    for (const mode of modes) {
      try {
        const r = await gemini.analyze(imgBuf, mode.prompt);
        const preview = typeof r === 'string' ? r.slice(0, 80) : JSON.stringify(r).slice(0, 80);
        log(`Vision: ${mode.name}`, 'PASS', preview);
      } catch (e: any) {
        log(`Vision: ${mode.name}`, 'FAIL', e.message);
      }
    }
  } else {
    log('Vision tests', 'SKIP', `screenshot: ${testImage ? 'yes' : 'no'}, gemini: ${GEMINI_KEY ? 'yes' : 'no'}`);
  }

  // ===== TEST 5: Catalog lifecycle =====
  console.log('\n📋 TEST 5: Catalog lifecycle...');
  try {
    const cat = await catalog.read();
    log('Catalog read', 'PASS', `${cat.entries.length} entries`);

    const entry = await catalog.getEntry('fitness-dashboard');
    if (entry) {
      log('Catalog getEntry', 'PASS', `status: ${entry.status}, version: ${entry.currentVersion}`);

      await catalog.updateEntry('fitness-dashboard', { status: 'review' });
      const updated = await catalog.getEntry('fitness-dashboard');
      log('Status draft→review', updated?.status === 'review' ? 'PASS' : 'FAIL');
    } else {
      log('Catalog getEntry', 'SKIP', 'No entry (generate failed)');
    }
  } catch (e: any) {
    log('Catalog lifecycle', 'FAIL', e.message);
  }

  // ===== TEST 6: list_projects =====
  try {
    console.log('\n📂 TEST 6: List projects...');
    const resp = await stitch.callTool('list_projects', {}) as any;
    const count = resp?.projects?.length ?? 0;
    log('List projects', 'PASS', `${count} projects found`);
  } catch (e: any) {
    log('List projects', 'FAIL', e.message);
  }

  // ===== SUMMARY =====
  console.log('\n' + '='.repeat(60));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  console.log(`✅ ${pass} passed  ❌ ${fail} failed  ⏭️ ${skip} skipped`);
  console.log('='.repeat(60));

  fs.writeFileSync(path.join(PROJECT_ROOT, 'e2e-results.json'), JSON.stringify(results, null, 2));

  console.log('\n📁 Generated files:');
  try {
    const walkDir = (dir: string, prefix = '') => {
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) walkDir(full, prefix + f + '/');
        else console.log(`  ${prefix}${f} (${fs.statSync(full).size.toLocaleString()} bytes)`);
      }
    };
    walkDir(path.join(PROJECT_ROOT, 'design-artifacts'));
  } catch {}

  // Show screenshots
  console.log('\n📸 Screenshots:');
  [mobileScreenshot, desktopScreenshot].filter(Boolean).forEach(p => console.log(`  ${p}`));
}

run().catch(e => console.error('Fatal:', e));
