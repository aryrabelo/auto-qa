#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { QaAgent } from './agent.mjs';
import { SystemOneModel } from './model.mjs';

const HELP = `Usage: npm run qa -- --url <address> --expect "<statement>" [options] "Task to perform"
       npm run qa -- --app <bundle/package ID> --platform ios --expect "<statement>" "Task to perform"

  --platform web|ios|android   Default: web
  --url <address>              Web: page to start from (or use --profile)
  --profile <file.json>        Web: app profile with baseUrl, startPath, scope, login steps
  --headed                     Web: show the browser window instead of running headless
  --app <id>                   Mobile: bundle or package ID
  --device <name>              Mobile: select a device by name
  --udid <id>                  Mobile: pin an Apple simulator/device
  --serial <id>                Mobile: pin an Android emulator/device
  --expect "<statement>"       Pass criterion; repeat for each statement that must be true on screen
  --pass-threshold <0..1>      Probability each expectation must reach; default: 0.9
  --backend kev|laya           Local decision model; default: AUTOQA_BACKEND or kev
  --model-url <address>        Override the decision server address (default KEV_URL/LAYA_URL)
  --model <id>                 Override the served model name
  --max-steps <n>              Default: 40
  --min-confidence <0..1>      Action cutoff; default: 0 (disabled)
  --timeout <seconds>          Default: 180; cancels model requests, stops between device calls
  --scope <label/id>           Limit the snapshot to a specific subtree
  --artifacts <directory>      Default: artifacts
  --no-record                  Disable video capture
  --help                       Show this help

The decision model runs on your machine; no API key is involved. Start the kev server before a run.
Describe the expected outcome in the task. Put exact form values in double quotes.
Expectations are the pass criterion: the run passes as soon as every --expect statement is verified
true on the current screen, and never because the model felt like passing. Write one short, factual,
checkable statement per flag, for example --expect 'A heading reading "Settings" is visible.'
Without --expect, the task prompt is used as the single statement, which small local models judge poorly.
Exit codes: 0 QA pass, 1 QA fail, 2 incomplete, 3 runtime/config error.`;

const ENV_REFERENCE = /\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Profiles are committed next to the code, so secrets live in the environment only.
function resolveEnvReferences(value, path = 'profile') {
  if (typeof value === 'string') {
    return value.replace(ENV_REFERENCE, (_, name) => {
      const found = process.env[name];
      if (found === undefined || found === '') throw new Error(`${path} needs environment variable ${name}, which is not set.`);
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((item, index) => resolveEnvReferences(item, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvReferences(item, `${path}.${key}`)]));
  }
  return value;
}

async function loadProfile(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Profile not found: ${path}`);
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`Profile ${path} is not valid JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Profile ${path} must contain a JSON object.`);
  return resolveEnvReferences(parsed, path);
}

async function buildDevice(v, prompt, profile, backend) {
  if (v.platform === 'web') {
    if (!v.url && !profile) throw new Error('Web runs need --url or --profile. Run npm run qa -- --help for examples.');
    const { BrowserDevice } = await import('./browser.mjs');
    return new BrowserDevice({ url: v.url, profile, headless: !v.headed, backend,
      scope: v.scope || profile?.scope, title: prompt });
  }
  if (!v.app) throw new Error('Mobile runs need --app with the bundle or package ID.');
  const { AgentDevice } = await import('./device.mjs');
  // Keep this process's daemon state separate from other agent-device projects.
  process.env.AGENT_DEVICE_STATE_DIR ||= resolve('.agent-device');
  return new AgentDevice({ app: v.app, platform: v.platform, device: v.device, udid: v.udid,
    serial: v.serial, scope: v.scope, session: `auto-qa-${randomUUID()}`, cwd: process.cwd() });
}

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    app: { type: 'string' }, platform: { type: 'string', default: 'web' },
    url: { type: 'string' }, profile: { type: 'string' }, headed: { type: 'boolean', default: false },
    device: { type: 'string' }, udid: { type: 'string' }, serial: { type: 'string' },
    expect: { type: 'string', multiple: true }, 'pass-threshold': { type: 'string', default: '0.9' },
    backend: { type: 'string' }, 'model-url': { type: 'string' }, model: { type: 'string' },
    'max-steps': { type: 'string', default: '40' },
    'min-confidence': { type: 'string', default: '0' }, timeout: { type: 'string', default: '180' },
    scope: { type: 'string' }, artifacts: { type: 'string', default: 'artifacts' },
    'no-record': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) { console.log(HELP); return; }
  const prompt = positionals.join(' ').trim();
  if (!prompt) throw new Error('Provide a task prompt. Run npm run qa -- --help for examples.');
  if (!['web', 'ios', 'android'].includes(v.platform)) throw new Error('--platform must be web, ios, or android.');
  const profile = v.profile ? await loadProfile(v.profile) : null;
  const backend = v.backend || process.env.AUTOQA_BACKEND || 'kev';
  const model = new SystemOneModel({ backend, url: v['model-url'], model: v.model });
  const device = await buildDevice(v, prompt, profile, backend);
  const agent = new QaAgent({ model, device, expectations: v.expect ?? [],
    passThreshold: Number(v['pass-threshold']), maxSteps: Number(v['max-steps']),
    minConfidence: Number(v['min-confidence']), timeoutMs: Number(v.timeout) * 1000,
    artifactsDir: v.artifacts, record: !v['no-record'],
    onStep: step => console.log(`${step.step}. ${step.kind === 'verdict' ? 'Decision: ' + step.choice : 'Selected: ' + step.action} (${step.latencyMs.toFixed(0)} ms; confidence ${step.confidence.toFixed(2)})`),
  });
  const controller = new AbortController();
  const stop = () => { if (!controller.signal.aborted) console.log('\nStopping after the current device operation…'); controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await agent.generate({ prompt, abortSignal: controller.signal });
    const explanations = {
      expectations_met: 'Every expectation was verified on the screen.',
      qa_fail: 'The agent found a failure against the task.',
      incomplete: 'The agent could not determine the outcome from the observed app states.',
      low_confidence: 'The selected action was below your confidence cutoff and was not executed.',
      blocked: 'The agent could not continue with the available controls.',
      need_input: 'The agent needs a text value. Include it in double quotes in the task.',
      step_limit: 'The run reached its step limit.',
      timeout: 'The run reached its time limit.',
      cancelled: 'The run was cancelled.',
      repeated_action_without_progress: 'The same action repeatedly made no progress.',
      runtime_error: 'The run stopped because of an error. See the details below.',
    };
    console.log(`\n${result.status.toUpperCase()}: ${explanations[result.reason] || result.reason}`);
    const confidence = result.verdict ? ` | QA confidence: ${result.verdict.confidence.toFixed(2)}` : '';
    console.log(`Actions executed: ${result.steps.filter(step => step.executed).length}${confidence}`);
    for (const { statement, p, met } of result.expectations ?? []) {
      console.log(`  ${met ? '✓' : '✗'} ${p.toFixed(2)}  ${statement}`);
    }
    console.log(`Model: ${result.backend} ${result.modelName} at ${result.modelUrl}`);
    console.log(`Startup: ${(result.startupMs / 1000).toFixed(2)} s`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)} s`);
    console.log(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out over ${result.usage.requests} local decisions${result.usage.complete ? '' : ' (partial)'}`);
    const videos = result.recording?.chunks?.map(chunk => chunk.path) || [result.recording?.outPath];
    const paths = videos.filter(Boolean);
    if (paths.length) paths.forEach(path => console.log(`Video: ${path}`));
    else console.log('Video: not recorded');
    console.log(`JSON: ${result.directory}/report.json`);
    result.warnings.forEach(w => console.error(`Note: ${w}`));
    process.exitCode = { passed: 0, failed: 1, incomplete: 2, error: 3 }[result.status];
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 3; });
