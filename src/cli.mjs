#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JevDeviceAgent, JevModel, AgentDevice } from './index.mjs';

const HELP = `Usage: npm run qa -- --app <bundle/package ID> [options] "Task to perform"

  --platform ios|android     Default: ios
  --device <name>            Select a device by name
  --udid <id>                Pin an Apple simulator/device
  --serial <id>              Pin an Android emulator/device
  --expect <text>            Required visible text at completion (repeatable)
  --checks <file.json>       Acceptance checks; see examples/cart-checks.json
  --inputs <file.json>       Named form values; Jev cannot generate strings
  --model <id>               Default: TYPESAFE_MODEL or jev-latest
  --max-steps <n>            Default: 40
  --min-confidence <0..1>    Default: 0.6 (an experimental threshold)
  --timeout <seconds>        Default: 180; cancels model requests, stops between device calls
  --scope <label/id>         Limit the snapshot to a specific app subtree
  --artifacts <directory>    Default: artifacts
  --no-record               Disable video capture
  --help                    Show this help

Set TYPESAFE_API_KEY through your environment or a local .env file.
Exit codes: 0 completed/passed, 1 failed check, 2 incomplete, 3 runtime/config error.
Without acceptance checks, 'completed' means Jev judged the task complete.
Run 'npm run demo' for a clearly labeled simulation with no API key or device.`;

async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    app: { type: 'string' }, platform: { type: 'string', default: 'ios' },
    device: { type: 'string' }, udid: { type: 'string' }, serial: { type: 'string' },
    expect: { type: 'string', multiple: true, default: [] }, checks: { type: 'string' }, inputs: { type: 'string' },
    model: { type: 'string' }, 'max-steps': { type: 'string', default: '40' },
    'min-confidence': { type: 'string', default: '0.6' }, timeout: { type: 'string', default: '180' },
    scope: { type: 'string' }, artifacts: { type: 'string', default: 'artifacts' },
    'no-record': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) { console.log(HELP); return; }
  const prompt = positionals.join(' ').trim();
  if (!v.app || !prompt) throw new Error('Provide --app and a task prompt. Run npm run qa -- --help for examples.');
  const inputs = v.inputs ? JSON.parse(await readFile(v.inputs, 'utf8')) : {};
  const fromFile = v.checks ? JSON.parse(await readFile(v.checks, 'utf8')) : [];
  if (!Array.isArray(fromFile)) throw new Error('The checks file must contain an array.');
  const checks = [...fromFile, ...v.expect.map(text => ({ name: `Visible text: ${text}`, textIncludes: text }))];
  // Keep this process's daemon state separate from other agent-device projects.
  process.env.AGENT_DEVICE_STATE_DIR ||= resolve('.agent-device');
  const model = new JevModel({ model: v.model || process.env.TYPESAFE_MODEL || 'jev-latest' });
  const device = new AgentDevice({ app: v.app, platform: v.platform, device: v.device, udid: v.udid,
    serial: v.serial, scope: v.scope, session: `jev-${randomUUID()}`, cwd: process.cwd() });
  const agent = new JevDeviceAgent({ model, device, maxSteps: Number(v['max-steps']),
    minConfidence: Number(v['min-confidence']), timeoutMs: Number(v.timeout) * 1000,
    inputUsdPerMillion: Number(process.env.JEV_INPUT_USD_PER_MILLION || '0.042'),
    artifactsDir: v.artifacts, record: !v['no-record'],
    onStep: step => console.log(`${step.step}. ${step.action} (${step.latencyMs.toFixed(0)} ms; confidence ${step.confidence.toFixed(2)})`),
  });
  const controller = new AbortController();
  const stop = () => { if (!controller.signal.aborted) console.log('\nStopping after the current device operation…'); controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await agent.generate({ prompt, inputs, checks, abortSignal: controller.signal });
    console.log(`\n${result.status.toUpperCase()}: ${result.reason}`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)} s | Jev input tokens: ${result.usage.inputTokens}`);
    console.log(`Estimated inference cost: ${result.estimatedInferenceCostUsd == null ? 'unavailable' : '$' + result.estimatedInferenceCostUsd.toFixed(8)}`);
    console.log(`Report: ${result.directory}/report.html`);
    result.warnings.forEach(w => console.error(`Note: ${w}`));
    process.exitCode = { passed: 0, completed: 0, failed: 1, incomplete: 2, error: 3 }[result.status];
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 3; });

