/**
 * Demo: design to code for several pages at once. A design-system step reads every page and
 * writes the shared tokens and components; then each page runs the same sub-flow side by side
 * (analyze → spec ⇄ review → build ⇄ screenshot & compare), every page in its own copy of the
 * workspace, merged back and checked; a last step screenshots all pages in parallel.
 * The per-page sub-flow is written inline, as the item graph of a parallel step.
 *
 * Usage: node scripts/d2c-pages-flow.mjs [server URL]   (default http://localhost:4317)
 * Creates a sandbox repository under ~/.universal-agent/workflow/demo/d2c-pages with the designs
 * in design/pages/*.png and Playwright installed, registers the agents and the workspace, saves
 * the workflow `test-d2c-pages` (the per-page sub-flow is inline in it) and binds the slot.
 * Agents run on `deepseek` and open the images themselves; set D2C_ENGINE to change it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkflowBuilder } from '@universal-agent/workflow-contract';

const server = process.argv[2] ?? 'http://localhost:4317';
const engine = process.env.D2C_ENGINE ?? 'deepseek';
const repo = join(homedir(), '.universal-agent', 'workflow', 'demo', 'd2c-pages');
const MARKER = '.d2c-pages-demo';
const WIDTH = 960;
const HEIGHT = 640;
const CONCURRENCY = 3;

// ---------------------------------------------------------------- the designer's mocks
// Three pages of one product, sharing a design system; rendered once to design/pages/*.png.
const BASE = `* { box-sizing: border-box; margin: 0; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f6f7fb; color: #1d2340; }
nav { height: 72px; display: flex; align-items: center; padding: 0 48px; background: #fff; border-bottom: 1px solid #e6e8f0; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 20px; }
.logo i { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #5b5bf7, #9b6bff); display: block; }
.links { display: flex; gap: 28px; margin-left: 56px; font-size: 15px; color: #5a6185; }
.links .on { color: #1d2340; font-weight: 600; }
.cta { margin-left: auto; padding: 10px 18px; border-radius: 10px; background: #1d2340; color: #fff; font-size: 14px; font-weight: 600; }
.primary, .secondary { display: inline-block; padding: 14px 22px; border-radius: 12px; font-size: 15px; font-weight: 600; text-align: center; }
.primary { background: #5b5bf7; color: #fff; box-shadow: 0 8px 20px rgba(91, 91, 247, 0.3); }
.secondary { background: #fff; border: 1px solid #d9dcea; color: #1d2340; }
.tag { display: inline-block; padding: 6px 12px; border-radius: 999px; background: #e9e8ff; color: #5b5bf7; font-size: 13px; font-weight: 600; }`;
const NAV = (on) => `<nav><div class="logo"><i></i>Lumen</div><div class="links">${['Product', 'Pricing', 'Customers', 'Docs'].map((l) => `<span${l === on ? ' class="on"' : ''}>${l}</span>`).join('')}</div><div class="cta">Start free trial</div></nav>`;
const page = (css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}\n${css}</style></head><body>${body}</body></html>`;
const DESIGNS = {
  home: page(`.hero { display: flex; gap: 40px; padding: 56px 48px 0; }
.copy { width: 470px; }
h1 { margin-top: 18px; font-size: 44px; line-height: 52px; letter-spacing: -0.5px; }
p { margin-top: 16px; font-size: 17px; line-height: 27px; color: #5a6185; }
.buttons { display: flex; gap: 12px; margin-top: 28px; }
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
.feature b { width: 36px; height: 36px; border-radius: 10px; display: block; }`, `${NAV('Product')}
<section class="hero"><div class="copy"><span class="tag">New · Live dashboards</span><h1>See every metric your team cares about</h1><p>Lumen pulls data from the tools you already use and turns it into dashboards everyone can read in seconds.</p><div class="buttons"><span class="primary">Get started</span><span class="secondary">Book a demo</span></div></div>
<div class="card"><h3>Weekly active users</h3><div class="big">48,210<span class="up">▲ 12.4%</span></div><div class="bars"><span style="height:45%"></span><span style="height:60%"></span><span style="height:52%"></span><span style="height:74%"></span><span style="height:66%"></span><span class="on" style="height:92%"></span><span style="height:80%"></span></div><div class="legend"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div></div></section>
<section class="features"><div class="feature"><b style="background:#ffe9d6"></b>120+ integrations</div><div class="feature"><b style="background:#d9f5ea"></b>Real-time sync</div><div class="feature"><b style="background:#e9e8ff"></b>Shareable views</div></section>`),
  pricing: page(`.head { padding: 44px 48px 0; text-align: center; }
h1 { margin-top: 14px; font-size: 36px; line-height: 44px; letter-spacing: -0.4px; }
.sub { margin-top: 10px; font-size: 16px; color: #5a6185; }
.plans { display: flex; gap: 20px; padding: 32px 48px 0; }
.plan { flex: 1; height: 330px; padding: 24px; border-radius: 18px; background: #fff; border: 1px solid #e6e8f0; display: flex; flex-direction: column; }
.plan.best { border: 2px solid #5b5bf7; box-shadow: 0 20px 50px rgba(91, 91, 247, 0.16); }
.plan h3 { font-size: 16px; font-weight: 700; }
.price { margin-top: 12px; font-size: 38px; font-weight: 700; }
.price small { font-size: 14px; font-weight: 500; color: #8a90ad; }
.plan ul { list-style: none; padding: 0; margin-top: 16px; font-size: 14px; line-height: 30px; color: #5a6185; }
.plan ul li::before { content: '✓  '; color: #17a673; font-weight: 700; }
.plan .primary, .plan .secondary { margin-top: auto; }`, `${NAV('Pricing')}
<section class="head"><span class="tag">Pricing</span><h1>Simple plans that grow with you</h1><div class="sub">Start free, upgrade when your team needs more.</div></section>
<section class="plans">
<div class="plan"><h3>Starter</h3><div class="price">$0<small> /month</small></div><ul><li>3 dashboards</li><li>10 integrations</li><li>Community support</li></ul><span class="secondary">Start free</span></div>
<div class="plan best"><h3>Team</h3><div class="price">$49<small> /month</small></div><ul><li>Unlimited dashboards</li><li>120+ integrations</li><li>Real-time sync</li></ul><span class="primary">Start 14-day trial</span></div>
<div class="plan"><h3>Enterprise</h3><div class="price">Custom</div><ul><li>SSO &amp; audit logs</li><li>Dedicated success manager</li><li>99.9% uptime SLA</li></ul><span class="secondary">Talk to sales</span></div>
</section>`),
  signin: page(`main { display: flex; justify-content: center; padding-top: 64px; }
.panel { width: 400px; padding: 32px; border-radius: 20px; background: #fff; box-shadow: 0 20px 50px rgba(29, 35, 64, 0.1); }
h1 { font-size: 26px; line-height: 34px; }
.sub { margin-top: 6px; font-size: 14px; color: #5a6185; }
label { display: block; margin-top: 20px; font-size: 13px; font-weight: 600; }
.field { margin-top: 8px; height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid #d9dcea; background: #fbfbfe; font-size: 14px; line-height: 44px; color: #8a90ad; }
.row { display: flex; justify-content: space-between; margin-top: 14px; font-size: 13px; color: #5a6185; }
.row a { color: #5b5bf7; font-weight: 600; }
.panel .primary { display: block; margin-top: 22px; }
.alt { margin-top: 18px; text-align: center; font-size: 13px; color: #5a6185; }
.alt b { color: #5b5bf7; }`, `${NAV('')}
<main><div class="panel"><h1>Welcome back</h1><div class="sub">Sign in to see your team's dashboards.</div>
<label>Work email</label><div class="field">you@company.com</div>
<label>Password</label><div class="field">••••••••</div>
<div class="row"><span>☐ Remember me</span><a>Forgot password?</a></div>
<span class="primary">Sign in</span>
<div class="alt">New to Lumen? <b>Create an account</b></div></div></main>`),
};

// ---------------------------------------------------------------- steps
const port = (name, type, required = true) => ({ name, type, required });
const script = (id, name, source, extra) => ({
  id,
  name,
  command: process.execPath,
  args: ['--input-type=module', '-e', source],
  writeScopes: [],
  producesAssessment: false,
  timeoutMs: 180_000,
  ...extra,
});

/** Shared by the per-page screenshot and the final gallery: diff a screenshot against a design. */
const DIFF = String.raw`
const diffImages = async (page, designFile, shotFile, w, h) => {
  const url = (file) => 'data:image/png;base64,' + readFileSync(file).toString('base64');
  return page.evaluate(async ([a, b, w, h]) => {
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
    const bytes = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    const cell = (w / 3) * (h / 3);
    return { mismatchPct: +((off * 100) / (w * h)).toFixed(2), grid: grid.map((row) => row.map((n) => +((n * 100) / cell).toFixed(1))), png: btoa(bin) };
  }, [url(designFile), url(shotFile), w, h]);
};
// The installed Chrome when there is one (no browser download), else Playwright's own.
const launch = () => chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
`;

const prepare = script('prepare', 'Prepare', `
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
if (!existsSync('${MARKER}')) throw new Error('This workspace is not the D2C pages sandbox (no ${MARKER} file); bind the "d2c-pages-demo" workspace. Nothing was changed.');
const pages = readdirSync('design/pages').filter((f) => f.endsWith('.png')).sort().map((file) => {
  const png = readFileSync('design/pages/' + file);
  return { name: file.replace(/\\.png$/, ''), path: 'design/pages/' + file, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
});
for (const dir of ['app', 'shots']) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir); }
rmSync('HANDOFF.md', { force: true });
writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { pages } }));
`, { writeScopes: ['app', 'shots', 'HANDOFF.md'], outputs: [port('pages', 'array')] });

// One page: screenshot app/<name>.html, diff it with its design, keep shots/<name>-round-N.png.
const shoot = script('shoot', 'Screenshot & diff', String.raw`
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
${DIFF}
const design = JSON.parse(readFileSync(process.env.UA_INPUT_PAGE, 'utf8'));
const round = readdirSync('shots').filter((f) => f.startsWith(design.name + '-round-')).length + 1;
const shot = 'shots/' + design.name + '-round-' + round + '.png', diff = 'shots/' + design.name + '-diff-' + round + '.png';
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: design.width, height: design.height } });
  await page.goto(pathToFileURL(resolve('app/' + design.name + '.html')).href);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot });
  const result = await diffImages(page, design.path, shot, design.width, design.height);
  writeFileSync(diff, Buffer.from(result.png, 'base64'));
  const report = { page: design.name, round, design: design.path, screenshot: shot, diff, mismatchPct: result.mismatchPct, regionMismatchPct: { rows: ['top', 'middle', 'bottom'], cols: ['left', 'center', 'right'], values: result.grid } };
  spawnSync('ua-workflow', ['data', 'append', 'fidelity', JSON.stringify({ page: design.name, round, mismatchPct: report.mismatchPct }), '--shared'], { stdio: 'ignore' });
  writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({ outputs: { report } }));
} finally {
  await browser.close();
}
`, { writeScopes: ['shots'], inputs: [port('page', 'json')], outputs: [port('report', 'json')] });

// All pages at once: one browser, every page screenshotted and diffed in parallel; an index page.
const gallery = script('gallery', 'Screenshot all pages', String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
${DIFF}
const pages = JSON.parse(readFileSync(process.env.UA_INPUT_PAGES, 'utf8'));
const browser = await launch();
try {
  const started = Date.now();
  const fidelity = await Promise.all(pages.map(async (design) => {
    const page = await browser.newPage({ viewport: { width: design.width, height: design.height } });
    await page.goto(pathToFileURL(resolve('app/' + design.name + '.html')).href);
    await page.waitForTimeout(300);
    const shot = 'shots/final-' + design.name + '.png';
    await page.screenshot({ path: shot });
    const result = await diffImages(page, design.path, shot, design.width, design.height);
    writeFileSync('shots/final-' + design.name + '-diff.png', Buffer.from(result.png, 'base64'));
    await page.close();
    return { page: design.name, html: 'app/' + design.name + '.html', screenshot: shot, mismatchPct: result.mismatchPct };
  }));
  writeFileSync('app/index.html', '<!doctype html><meta charset="utf-8"><title>Lumen pages</title><body style="font-family:sans-serif;padding:24px">' +
    fidelity.map((f) => '<h2>' + f.page + ' · ' + f.mismatchPct + '% differs</h2><a href="' + f.page + '.html"><img src="../' + f.screenshot + '" width="480"></a>').join('') + '</body>');
  writeFileSync(process.env.UA_OUTPUTS_FILE, JSON.stringify({
    outputs: { fidelity },
    artifacts: { summary: { mediaType: 'text/markdown', content: '# Pages\n\nScreenshotted ' + pages.length + ' pages in parallel in ' + (Date.now() - started) + ' ms.\n\n| page | differs |\n|---|---|\n' + fidelity.map((f) => '| ' + f.page + ' | ' + f.mismatchPct + '% |').join('\n') } },
  }));
} finally {
  await browser.close();
}
`, { writeScopes: ['app/index.html', 'shots'], inputs: [port('pages', 'array'), port('reports', 'array')], outputs: [port('fidelity', 'json'), port('summary', 'artifact')] });

// Run on merged code whenever pages built side by side land together.
const CHECK = `// Each page links only stylesheets that exist and loads nothing from the network.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
const problems = [];
for (const file of readdirSync('app').filter((f) => f.endsWith('.html'))) {
  const html = readFileSync('app/' + file, 'utf8');
  if (/(?:src|href)=["']?https?:/i.test(html)) problems.push(file + ' loads something from the network');
  for (const [, css] of html.matchAll(/href=["']([^"']+\\.css)["']/gi)) if (!existsSync('app/' + css)) problems.push(file + ' links ' + css + ', which does not exist');
}
if (problems.length) { console.error(problems.join('\\n')); process.exit(1); }
console.log('pages check out:', readdirSync('app').join(', '));
`;

// ---------------------------------------------------------------- agents
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
if (engine !== 'deepseek') for (const a of AGENTS) a.version = `3-${engine}`;
const [designer, reviewer] = AGENTS.map((a) => `${a.id}@${a.version}`);

// ---------------------------------------------------------------- one page
// The sub-flow every page runs, inline in the workflow: $input.page is this page (the list
// outside), $input.system the shared design system, and each page's last report goes to
// $output.report.
const pageSteps = (b) => b
  .addAgent({
    id: 'analyze',
    name: 'Analyze page',
    role: 'designer',
    agentRef: designer,
    goal: 'Look at this page\'s design image (input "page" gives its name, path and size) and describe it for someone who cannot see it: layout and regions top to bottom, every element with its position and size in px, colours as hex, typography and spacing. Note where it uses the shared design system and what is specific to this page.',
    inputs: [port('page', 'json'), port('system', 'artifact')],
    outputs: [port('analysis', 'artifact')],
  })
  .addAgent({
    id: 'write_spec',
    name: 'Write spec',
    role: 'designer',
    agentRef: designer,
    goal: 'Write the implementation spec for this page as Markdown: the shared tokens and components it reuses (by name, from the design system), then its own layout as a tree of boxes with exact px positions, sizes and gaps, and every element\'s styles and verbatim text. When a previous spec and review feedback are given, revise that spec to fix exactly what the review found.',
    acceptanceCriteria: ['a developer can build the page from the spec and the design system alone', 'numbers are exact px', 'text is verbatim'],
    inputs: [port('page', 'json'), port('system', 'artifact'), port('analysis', 'artifact'), port('previous_spec', 'artifact', false)],
    outputs: [port('spec', 'artifact')],
  })
  .addAgent({
    id: 'review_spec',
    name: 'Review spec',
    role: 'reviewer',
    agentRef: reviewer,
    producesAssessment: true,
    goal: 'Review the spec against this page\'s design image. PASS if a developer following it would land within a few px with the right colours and type; NEEDS_FIX with one finding per problem when any is critical or major; minor ones go in the findings of a PASS.',
    inputs: [port('page', 'json'), port('spec', 'artifact')],
  })
  .addAgent({
    id: 'implement',
    name: 'Build page',
    role: 'developer',
    agentRef: designer,
    goal: 'Build this page as app/<name>.html with app/<name>.css (name from input "page"), linking app/shared.css for the shared design system: static HTML and CSS only, nothing loaded from the network, sized exactly to the design. Only touch this page\'s two files. When a previous fidelity report and review feedback are given, open its screenshot and diff image (red marks pixels that differ) and fix exactly those differences.',
    acceptanceCriteria: ['the page renders the whole design at its exact size', 'it links shared.css and nothing from the network', 'only this page\'s files change'],
    writeScopes: ['app'],
    inputs: [port('page', 'json'), port('spec', 'artifact'), port('previous_report', 'json', false)],
  })
  .addScript(shoot)
  .addAgent({
    id: 'compare',
    name: 'Compare with design',
    role: 'reviewer',
    agentRef: reviewer,
    producesAssessment: true,
    goal: 'Compare the built page with its design: open the design image, the screenshot and the diff image named in the report (red marks pixels that differ; the report also gives the share of differing pixels per region). PASS if it matches in layout, colours, typography and spacing to within a few px; NEEDS_FIX with one finding per visible difference when any is critical or major; minor ones go in the findings of a PASS.',
    inputs: [port('page', 'json'), port('report', 'json'), port('spec', 'artifact')],
  })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'analyze', toPort: 'page' })
  .connectData({ fromNodeId: '$input', fromPort: 'system', toNodeId: 'analyze', toPort: 'system' })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'write_spec', toPort: 'page' })
  .connectData({ fromNodeId: '$input', fromPort: 'system', toNodeId: 'write_spec', toPort: 'system' })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'review_spec', toPort: 'page' })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'implement', toPort: 'page' })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'shoot', toPort: 'page' })
  .connectData({ fromNodeId: '$input', fromPort: 'page', toNodeId: 'compare', toPort: 'page' })
  .connectData({ fromNodeId: 'analyze', fromPort: 'analysis', toNodeId: 'write_spec', toPort: 'analysis', withControl: true })
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'review_spec', toPort: 'spec', withControl: true })
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'write_spec', toPort: 'previous_spec' })
  .loopBack('review_spec', 'write_spec', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2, onExhausted: 'pass_with_findings' })
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'implement', toPort: 'spec' })
  .connectControl('review_spec', 'implement')
  .connectData({ fromNodeId: 'write_spec', fromPort: 'spec', toNodeId: 'compare', toPort: 'spec' })
  .connectControl('implement', 'shoot')
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: 'compare', toPort: 'report', withControl: true })
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: 'implement', toPort: 'previous_report' })
  .loopBack('compare', 'implement', { kind: 'verdict_is', verdict: 'NEEDS_FIX' }, { maxRounds: 2, onExhausted: 'pass_with_findings' })
  .connectData({ fromNodeId: 'shoot', fromPort: 'report', toNodeId: '$output', toPort: 'report' });

// ---------------------------------------------------------------- all pages
const parent = createWorkflowBuilder('test-d2c-pages', 'Demo · Design to code, all pages in parallel')
  .addWorkspace({
    name: 'main',
    description: 'Sandbox with the page designs and the generated site',
    mergeCheck: { command: process.execPath, args: ['tools/check.mjs'], timeoutMs: 60_000 },
  })
  .addWorkflowOutput(port('fidelity', 'json'))
  .addWorkflowOutput(port('handoff', 'artifact'))
  .addScript(prepare)
  .addAgent({
    id: 'design_system',
    name: 'Extract design system',
    role: 'designer',
    agentRef: designer,
    goal: 'Look at every page design (input "pages" lists them) and extract what they share: colour, type, radius, shadow and spacing tokens, and the components that repeat (navigation bar, buttons, tags, cards). Write them as CSS custom properties and classes in app/shared.css, and describe the system as Markdown (token names and values, each component with its class name, exact styles and where it appears) for the per-page work to reuse.',
    acceptanceCriteria: ['every repeated element of the designs is covered', 'app/shared.css defines the tokens and component classes', 'class names in the Markdown match app/shared.css'],
    writeScopes: ['app/shared.css'],
    inputs: [port('pages', 'array')],
    outputs: [port('system', 'artifact')],
  })
  .addParallel({
    id: 'pages',
    name: 'Build each page',
    description: 'Inline sub-flow, run for every page side by side: analysis → spec ⇄ review (≤2) → build ⇄ screenshot & compare (≤2).',
    itemsPort: 'page',
    maxConcurrency: CONCURRENCY,
    failurePolicy: 'settle_all',
    inputs: [port('page', 'array'), port('system', 'artifact')],
    outputs: [port('report', 'array')],
    itemBody: pageSteps,
  })
  .addScript(gallery)
  .addAgent({
    id: 'handoff',
    name: 'Hand over',
    role: 'designer',
    agentRef: designer,
    goal: HANDOFF,
    acceptanceCriteria: ['every open finding of every page is in HANDOFF.md with a ready-to-paste prompt', 'nothing else in the workspace changes'],
    writeScopes: ['HANDOFF.md'],
    inputs: [port('fidelity', 'json'), port('summary', 'artifact')],
    outputs: [port('handoff', 'artifact')],
  })
  .connectData({ fromNodeId: 'prepare', fromPort: 'pages', toNodeId: 'design_system', toPort: 'pages', withControl: true })
  .connectData({ fromNodeId: 'prepare', fromPort: 'pages', toNodeId: 'pages', toPort: 'page' })
  .connectData({ fromNodeId: 'design_system', fromPort: 'system', toNodeId: 'pages', toPort: 'system', withControl: true, delivery: 'artifact_ref' })
  .connectData({ fromNodeId: 'prepare', fromPort: 'pages', toNodeId: 'gallery', toPort: 'pages' })
  .connectData({ fromNodeId: 'pages', fromPort: 'report', toNodeId: 'gallery', toPort: 'reports', withControl: true })
  .connectData({ fromNodeId: 'gallery', fromPort: 'fidelity', toNodeId: '$output', toPort: 'fidelity' })
  .connectData({ fromNodeId: 'gallery', fromPort: 'fidelity', toNodeId: 'handoff', toPort: 'fidelity', withControl: true })
  .connectData({ fromNodeId: 'gallery', fromPort: 'summary', toNodeId: 'handoff', toPort: 'summary' })
  .connectData({ fromNodeId: 'handoff', fromPort: 'handoff', toNodeId: '$output', toPort: 'handoff' })
  .setChief({})
  .buildDefinition();
parent.description = `Page designs → shared design system → every page built side by side (up to ${CONCURRENCY} at once, each in its own copy of the workspace, merged and checked) → all pages screenshotted in parallel.`;

// ---------------------------------------------------------------- setup
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

const run = (command, args) => execFileSync(command, args, { cwd: repo, stdio: 'ignore' });
if (!existsSync(join(repo, '.git'))) {
  mkdirSync(join(repo, 'design', 'pages'), { recursive: true });
  mkdirSync(join(repo, 'tools'), { recursive: true });
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'd2c-pages-demo', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(repo, MARKER), 'Sandbox for the test-d2c-pages workflow; its first step resets app/ and shots/.\n');
  writeFileSync(join(repo, 'tools', 'check.mjs'), CHECK);
  run('git', ['init', '-q', '-b', 'main']);
}
if (!existsSync(join(repo, 'node_modules', 'playwright'))) {
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'playwright@1.57.0']);
}
const missing = Object.keys(DESIGNS).filter((name) => !existsSync(join(repo, 'design', 'pages', `${name}.png`)));
if (missing.length > 0) {
  const { chromium } = await import(pathToFileURL(join(repo, 'node_modules', 'playwright', 'index.mjs')).href);
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  for (const name of missing) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    await page.setContent(DESIGNS[name]);
    await page.screenshot({ path: join(repo, 'design', 'pages', `${name}.png`) });
  }
  await browser.close();
  run('git', ['add', '.']);
  run('git', ['-c', 'user.email=demo@universal-agent.local', '-c', 'user.name=demo', 'commit', '-qm', 'D2C pages sandbox']);
}

for (const agent of AGENTS) await api('POST', '/api/agents', agent);
const { workspaces } = await api('GET', '/api/workspaces');
const workspace = workspaces.find((w) => w.path === repo) ?? (await api('POST', '/api/workspaces', { name: 'd2c-pages-demo', path: repo }));
const saved = (await api('GET', '/api/workflows')).workflows.map((w) => w.id);
const exists = saved.includes(parent.id);
await api(exists ? 'PUT' : 'POST', exists ? `/api/workflows/${parent.id}` : '/api/workflows', { definition: parent });
await api('PUT', `/api/workflows/${parent.id}/workspace-bindings`, { main: workspace.id });
console.log(`Saved ${parent.id}; sandbox ${repo} (${workspace.id}); agents on ${engine}`);
