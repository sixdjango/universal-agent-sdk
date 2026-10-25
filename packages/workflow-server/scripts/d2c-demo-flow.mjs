/**
 * Demo: design to code (D2C). From a design image, agents write a spec and review it (a loop
 * of at most 2 rounds), then build the page, screenshot it in a real browser, compare it with
 * the design and fix what differs (another loop of at most 2 rounds).
 *
 * Usage: node scripts/d2c-demo-flow.mjs [server URL]   (default http://localhost:4317)
 * Creates a sandbox repository under ~/.universal-agent/workflow/demo/d2c with the design at
 * design/design.png and Playwright installed, registers the agents and the workspace, saves the
 * workflow `test-d2c-demo` and binds its slot. Agents run on the `deepseek` engine and open the
 * images themselves; set D2C_ENGINE to use another engine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';

const server = process.argv[2] ?? 'http://localhost:4317';
const engine = process.env.D2C_ENGINE ?? 'deepseek';
const repo = join(homedir(), '.universal-agent', 'workflow', 'demo', 'd2c');
const MARKER = '.d2c-demo';
const WIDTH = 960;
const HEIGHT = 640;

/** The "designer's mock": rendered once to design/design.png, then kept out of the sandbox. */
const DESIGN_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f6f7fb; color: #1d2340; }
nav { height: 72px; display: flex; align-items: center; padding: 0 48px; background: #fff; border-bottom: 1px solid #e6e8f0; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; }
.logo i { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #5b5bf7, #9b6bff); display: block; }
.links { display: flex; gap: 28px; margin-left: 56px; font-size: 15px; color: #5a6185; }
.cta { margin-left: auto; padding: 10px 18px; border-radius: 10px; background: #1d2340; color: #fff; font-size: 14px; font-weight: 600; }
.hero { display: flex; gap: 40px; padding: 56px 48px 0; }
.copy { width: 470px; }
.tag { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #e9e8ff; color: #5b5bf7; font-size: 13px; font-weight: 600; }
h1 { margin-top: 18px; font-size: 44px; line-height: 52px; letter-spacing: -0.5px; }
p { margin-top: 16px; font-size: 17px; line-height: 27px; color: #5a6185; }
.buttons { display: flex; gap: 12px; margin-top: 28px; }
.primary, .secondary { padding: 14px 22px; border-radius: 12px; font-size: 15px; font-weight: 600; }
.primary { background: #5b5bf7; color: #fff; box-shadow: 0 8px 20px rgba(91, 91, 247, 0.3); }
.secondary { background: #fff; border: 1px solid #d9dcea; color: #1d2340; }
.card { width: 362px; height: 300px; padding: 24px; border-radius: 20px; background: #fff; box-shadow: 0 20px 50px rgba(29, 35, 64, 0.1); }
.card h3 { font-size: 15px; color: #5a6185; font-weight: 600; }
.big { margin-top: 8px; font-size: 36px; font-weight: 700; }
.up { color: #17a673; font-size: 14px; font-weight: 600; margin-left: 6px; }
.bars { display: flex; align-items: flex-end; gap: 12px; height: 130px; margin-top: 22px; }
.bars span { flex: 1; border-radius: 8px 8px 4px 4px; background: #e9e8ff; }
.bars span.on { background: #5b5bf7; }
.legend { display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px; color: #8a90ad; }
.features { display: flex; gap: 20px; padding: 44px 48px 0; }
.feature { flex: 1; display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 14px; background: #fff; border: 1px solid #e6e8f0; font-size: 14px; font-weight: 600; }
.feature b { width: 36px; height: 36px; border-radius: 10px; display: block; }
</style></head><body>
<nav><div class="logo"><i></i>Lumen</div><div class="links"><span>Product</span><span>Pricing</span><span>Customers</span><span>Docs</span></div><div class="cta">Start free trial</div></nav>
<section class="hero">
  <div class="copy">
    <span class="tag">New · Live dashboards</span>
    <h1>See every metric your team cares about</h1>
    <p>Lumen pulls data from the tools you already use and turns it into dashboards everyone can read in seconds.</p>
    <div class="buttons"><span class="primary">Get started</span><span class="secondary">Book a demo</span></div>
  </div>
  <div class="card">
    <h3>Weekly active users</h3>
    <div class="big">48,210<span class="up">▲ 12.4%</span></div>
    <div class="bars"><span style="height:45%"></span><span style="height:60%"></span><span style="height:52%"></span><span style="height:74%"></span><span style="height:66%"></span><span class="on" style="height:92%"></span><span style="height:80%"></span></div>
    <div class="legend"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
  </div>
</section>
<section class="features">
  <div class="feature"><b style="background:#ffe9d6"></b>120+ integrations</div>
  <div class="feature"><b style="background:#d9f5ea"></b>Real-time sync</div>
  <div class="feature"><b style="background:#e9e8ff"></b>Shareable views</div>
</section>
</body></html>`;

const port = (name, type, required = true) => ({ name, type, required });
const script = (id, name, source, extra) => ({
  id,
  name,
  command: process.execPath,
  args: ['--input-type=module', '-e', source],
  writeScopes: [],
  producesAssessment: false,
  timeoutMs: 120_000,
  ...extra,
});

// Resets the generated code and screenshots; reads the design's size from its PNG header.
const prepare = script('prepare', 'Prepare', `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
if (!existsSync('${MARKER}')) throw new Error('This workspace is not the D2C demo sandbox (no ${MARKER} file); bind the "d2c-demo" workspace. Nothing was changed.');
const png = readFileSync('design/design.png');
const design = { path: 'design/design.png', width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
for (const dir of ['app', 'shots']) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir); }
rmSync('HANDOFF.md', { force: true });
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { design } }));
`, { writeScopes: ['app', 'shots', 'HANDOFF.md'], outputs: [port('design', 'json')] });

// Screenshots app/index.html at the design's size, diffs it with the design pixel by pixel
// (in the browser, no extra packages) and writes shots/round-N.png and shots/diff-N.png.
const shoot = script('shoot', 'Screenshot & diff', String.raw`
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const design = JSON.parse(readFileSync(process.env.UA_INPUT_DESIGN, 'utf8'));
const round = readdirSync('shots').filter((f) => /^round-\d+\.png$/.test(f)).length + 1;
const shot = 'shots/round-' + round + '.png', diff = 'shots/diff-' + round + '.png';
// The installed Chrome when there is one (no browser download), else Playwright's own.
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: design.width, height: design.height } });
  await page.goto(pathToFileURL(resolve('app/index.html')).href);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot });
  const url = (file) => 'data:image/png;base64,' + readFileSync(file).toString('base64');
  const result = await page.evaluate(async ([a, b, w, h]) => {
    const load = (src) => new Promise((done) => { const img = new Image(); img.onload = () => done(img); img.src = src; });
    const pixels = async (src) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.drawImage(await load(src), 0, 0); return x.getImageData(0, 0, w, h).data; };
    const [p, q] = [await pixels(a), await pixels(b)];
    const out = new OffscreenCanvas(w, h), ctx = out.getContext('2d'), img = ctx.createImageData(w, h);
    const grid = Array.from({ length: 3 }, () => [0, 0, 0]);
    let off = 0;
    for (let i = 0; i < p.length; i += 4) {
      const d = Math.max(Math.abs(p[i] - q[i]), Math.abs(p[i + 1] - q[i + 1]), Math.abs(p[i + 2] - q[i + 2]));
      const px = (i / 4) % w, py = Math.floor(i / 4 / w);
      if (d > 16) { off++; grid[Math.min(2, Math.floor((py * 3) / h))][Math.min(2, Math.floor((px * 3) / w))]++; img.data.set([230, 40, 60, 255], i); }
      else { const g = 255 - (255 - (p[i] + p[i + 1] + p[i + 2]) / 3) * 0.25; img.data.set([g, g, g, 255], i); }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    const cell = (w / 3) * (h / 3);
    return { mismatchPct: +((off * 100) / (w * h)).toFixed(2), grid: grid.map((row) => row.map((n) => +((n * 100) / cell).toFixed(1))), png: btoa(bin) };
  }, [url(design.path), url(shot), design.width, design.height]);
  writeFileSync(diff, Buffer.from(result.png, 'base64'));
  const report = { round, design: design.path, screenshot: shot, diff, mismatchPct: result.mismatchPct, regionMismatchPct: { rows: ['top', 'middle', 'bottom'], cols: ['left', 'center', 'right'], values: result.grid } };
  // A run-wide history of how close each round got, readable by any step (ua-workflow data).
  spawnSync('ua-workflow', ['data', 'append', 'fidelity', JSON.stringify({ round, mismatchPct: report.mismatchPct }), '--shared'], { stdio: 'ignore' });
  writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({
    outputs: { report },
    artifacts: { report_md: { mediaType: 'text/markdown', content: '# Round ' + round + '\n\nPixels that differ: **' + report.mismatchPct + '%**\n\n| | left | center | right |\n|---|---|---|---|\n' + report.regionMismatchPct.values.map((r, i) => '| ' + report.regionMismatchPct.rows[i] + ' | ' + r.join('% | ') + '% |').join('\n') + '\n\nScreenshot: ' + shot + ' · diff: ' + diff } },
  }));
} finally {
  await browser.close();
}
`, { writeScopes: ['shots'], inputs: [port('design', 'json')], outputs: [port('report', 'json'), port('report_md', 'artifact')] });

const deliver = script('deliver', 'Deliver', `
import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.env.UA_INPUT_REPORT, 'utf8'));
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { fidelity: { rounds: report.round, mismatchPct: report.mismatchPct, page: 'app/index.html', screenshot: report.screenshot, diff: report.diff } } }));
`, { inputs: [port('report', 'json')], outputs: [port('fidelity', 'json')] });

const LOOK = 'Open image files with your file-reading tool; it shows you the image. Paths are relative to the current directory.';
// Small problems are recorded and handed over to a person at the end instead of holding the run up.
const SEVERITY = 'Give NEEDS_FIX only for critical or major problems (wrong layout, missing elements, clearly wrong colours or type). For minor ones (a few px, a slightly different radius or shade) give PASS and still list each as a finding with severity minor: they are handed over to a person.';
const HANDOFF = "Hand the result over to a person who will fine-tune it by hand (vibe coding). Run `ua-workflow findings` for everything still open (what the reviews left and the issues steps logged), look at the final screenshot and diff image named in the fidelity report, and write HANDOFF.md at the workspace root: what was built and how to open it, how close it got (share of differing pixels), then the open problems grouped by severity, each with its file (and line when known), the evidence to look at, and one ready-to-paste prompt that fixes it (e.g. \"In app/styles.css set the feature cards' border-radius to 14px\"). Do not fix anything yourself; return the file's contents as the handoff artifact.";
const LOG = 'If you knowingly leave something imperfect, log it before you finish: ua-workflow issue "<what and how to fix it>" --severity <major|minor> --file <path>.';
const AGENTS = [
  {
    id: 'd2c-designer',
    version: '3',
    name: 'D2C designer',
    charter: 'Turns UI designs into precise specs and faithful, hand-written front-end code.',
    instructions: ['Do not delegate to another agent.', 'Work only in the current directory.', LOOK, LOG],
    skills: [],
    runtime: { adapter: 'acp', agentType: engine },
  },
  {
    id: 'd2c-reviewer',
    version: '3',
    name: 'D2C reviewer',
    charter: 'Checks specs and built pages against the design with a sharp eye for layout, colour, type and spacing.',
    instructions: ['Do not delegate to another agent.', 'Never edit files.', LOOK, SEVERITY, 'Name each problem with the element, what the design shows and what you see instead.'],
    skills: [],
    runtime: { adapter: 'acp', agentType: engine },
  },
];
const [designer, reviewer] = AGENTS.map((a) => `${a.id}@${a.version}`);

const definition = createWorkflowBuilder('test-d2c-demo', 'Demo · Design to code')
  .addWorkspace({ name: 'main', description: 'Sandbox with the design image and the generated page' })
  .addWorkflowOutput({ name: 'fidelity', type: 'json', required: true })
  .addWorkflowOutput({ name: 'handoff', type: 'artifact', required: true })
  .addScript(prepare)
  .addAgent({
    id: 'analyze',
    name: 'Analyze design',
    role: 'designer',
    agentRef: designer,
    goal: 'Look at the design image (input "design" gives its path and size) and describe it for someone who cannot see it: the overall layout and its regions top to bottom, every element with its approximate position and size in px, colours as hex, typography (size, weight, line height), spacing, radii and shadows.',
    acceptanceCriteria: ['every visible element is covered', 'measurements are in px on the design\'s own size', 'colours are hex values sampled from the image'],
    inputs: [port('design', 'json')],
    outputs: [port('analysis', 'artifact')],
  })
  .addAgent({
    id: 'write_spec',
    name: 'Write spec',
    role: 'designer',
    agentRef: designer,
    goal: 'Write the implementation spec for this design as Markdown: canvas size, colour and type tokens, then the layout as a tree of boxes with exact px positions, sizes, paddings and gaps, and every component\'s styles and content. Check the image yourself, not only the analysis. When a previous spec and review feedback are given, revise that spec to fix exactly what the review found.',
    acceptanceCriteria: ['a developer can build the page from the spec alone', 'numbers are exact px, not ranges', 'all text content is quoted verbatim'],
    inputs: [port('design', 'json'), port('analysis', 'artifact'), port('previous_spec', 'artifact', false)],
    outputs: [port('spec', 'artifact')],
  })
  .addAgent({
    id: 'review_spec',
    name: 'Review spec',
    role: 'reviewer',
    agentRef: reviewer,
    producesAssessment: true,
    goal: 'Review the spec against the design image. PASS if a developer following it would land within a few px and the right colours and type everywhere; NEEDS_FIX with one finding per problem (missing elements, wrong sizes, positions, colours, fonts, text) when any is critical or major; minor ones go in the findings of a PASS.',
    inputs: [port('design', 'json'), port('spec', 'artifact')],
  })
  .addAgent({
    id: 'implement',
    name: 'Build page',
    role: 'developer',
    agentRef: designer,
    goal: 'Build the page from the spec as app/index.html with app/styles.css: static HTML and CSS only, no external fonts, images or scripts, sized exactly to the design. When a previous fidelity report and review feedback are given, open its screenshot and diff image (red marks pixels that differ) and fix exactly those differences.',
    acceptanceCriteria: ['app/index.html renders the whole design at its exact size', 'no external resources', 'structure and colours follow the spec'],
    writeScopes: ['app'],
    inputs: [port('design', 'json'), port('spec', 'artifact'), port('previous_report', 'json', false)],
  })
  .addScript(shoot)
  .addAgent({
    id: 'compare',
    name: 'Compare with design',
    role: 'reviewer',
    agentRef: reviewer,
    producesAssessment: true,
    goal: 'Compare the built page with the design: open the design image, the screenshot and the diff image named in the report (red marks pixels that differ; the report also gives the share of differing pixels per region). PASS if the page matches the design in layout, colours, typography and spacing to within a few px; NEEDS_FIX with one finding per visible difference when any is critical or major, naming the element, what the design shows and what the page shows; minor ones go in the findings of a PASS.',
    inputs: [port('design', 'json'), port('report', 'json'), port('spec', 'artifact')],
  })
  .addScript(deliver)
  .addAgent({
    id: 'handoff',
    name: 'Hand over',
    role: 'designer',
    agentRef: designer,
    goal: HANDOFF,
    acceptanceCriteria: ['every open finding is in HANDOFF.md with a ready-to-paste prompt', 'nothing else in the workspace changes'],
    writeScopes: ['HANDOFF.md'],
    inputs: [port('fidelity', 'json')],
    outputs: [port('handoff', 'artifact')],
  })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'analyze', toPort: 'design', withControl: true })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'write_spec', toPort: 'design' })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'review_spec', toPort: 'design' })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'implement', toPort: 'design' })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'shoot', toPort: 'design' })
  .connectData({ fromNodeId: 'prepare', fromPort: 'design', toNodeId: 'compare', toPort: 'design' })
  .connectData({ fromNodeId: 'analyze', fromPort: 'analysis', toNodeId: 'write_spec', toPort: 'analysis', withControl: true })
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'review_spec', toPort: 'spec', withControl: true })
  // The spec a round wrote comes back to the next round to revise.
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'write_spec', toPort: 'previous_spec' })
  .loopBack('review_spec', 'write_spec', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2, onExhausted: 'pass_with_findings' })
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'implement', toPort: 'spec' })
  .connectControl('review_spec', 'implement')
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'compare', toPort: 'spec' })
  .connectControl('implement', 'shoot')
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: 'compare', toPort: 'report', withControl: true })
  // The last round's screenshot report comes back to the next round's build.
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: 'implement', toPort: 'previous_report' })
  .loopBack('compare', 'implement', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2, onExhausted: 'pass_with_findings' })
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: 'deliver', toPort: 'report' })
  .connectControl('compare', 'deliver')
  .connectData({ fromNodeId: 'deliver', fromPort: 'fidelity', toNodeId: '$output', toPort: 'fidelity' })
  .connectData({ fromNodeId: 'deliver', fromPort: 'fidelity', toNodeId: 'handoff', toPort: 'fidelity', withControl: true })
  .connectData({ fromNodeId: 'handoff', fromPort: 'handoff', toNodeId: '$output', toPort: 'handoff' })
  .setChief({})
  .buildDefinition();
definition.description =
  'Design image → analysis → spec, reviewed and fixed (≤2 rounds) → page built from the spec, screenshotted in a real browser and compared with the design, fixed (≤2 rounds) → delivered with its fidelity.';

async function api(method, path, body) {
  const response = await fetch(server + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// The sandbox: a git repository with Playwright and the rendered design.
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, stdio: 'ignore' });
if (!existsSync(join(repo, '.git'))) {
  mkdirSync(join(repo, 'design'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'd2c-demo', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(repo, MARKER), 'Sandbox for the test-d2c-demo workflow; its first step resets app/ and shots/.\n');
  run('git', ['init', '-q', '-b', 'main']);
}
if (!existsSync(join(repo, 'node_modules', 'playwright'))) {
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'playwright@1.57.0']);
}
if (!existsSync(join(repo, 'design', 'design.png'))) {
  const { chromium } = await import(pathToFileURL(join(repo, 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.setContent(DESIGN_HTML);
  await page.screenshot({ path: join(repo, 'design', 'design.png') });
  await browser.close();
  run('git', ['add', '.']);
  run('git', ['-c', 'user.email=demo@universal-agent.local', '-c', 'user.name=demo', 'commit', '-qm', 'D2C demo sandbox']);
}

for (const agent of AGENTS) await api('POST', '/api/agents', agent);
const { workspaces } = await api('GET', '/api/workspaces');
const workspace = workspaces.find((w) => w.path === repo) ?? (await api('POST', '/api/workspaces', { name: 'd2c-demo', path: repo }));
const exists = (await api('GET', '/api/workflows')).workflows.some((w) => w.id === definition.id);
await api(exists ? 'PUT' : 'POST', exists ? `/api/workflows/${definition.id}` : '/api/workflows', { definition });
await api('PUT', `/api/workflows/${definition.id}/workspace-bindings`, { main: workspace.id });
console.log(`Saved ${definition.id}; sandbox ${repo} (${workspace.id}); agents on ${engine}`);
