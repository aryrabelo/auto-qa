import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JevDeviceAgent } from '../src/agent.mjs';
import { buildActions } from '../src/actions.mjs';
import { evaluateChecks, validateChecks } from '../src/checks.mjs';
import { SimulatedShop, SimulatedDecisions } from '../examples/simulated-shop.mjs';

const checks = JSON.parse(await readFile(new URL('../examples/cart-checks.json', import.meta.url)));
const decision = (choice, confidence = 0.99) => ({ choice, confidence, latencyMs: 10, model: 'fixture', usage: { input_tokens: 100, output_tokens: 0 } });
async function setup(t, options = {}) {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'jev-qa-test-'));
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const device = options.device || new SimulatedShop();
  const model = options.model || new SimulatedDecisions();
  return { device, agent: new JevDeviceAgent({ device, model, artifactsDir, record: false, ...options }) };
}

test('full shopping journey refreshes refs, checks final state, and writes honest simulation report', async t => {
  const { agent, device } = await setup(t);
  const result = await agent.generate({ prompt: 'Add backpack, increase to two, and open checkout.', checks });
  assert.equal(result.status, 'passed');
  assert.equal(result.steps.length, 5);
  assert.equal(result.estimatedInferenceCostUsd, null);
  assert.equal(device.calls.at(-1), 'close');
  assert.equal(result.recording, null);
  const report = JSON.parse(await readFile(join(result.directory, 'report.json')));
  assert.equal(report.checks.filter(c => c.status === 'passed').length, 3);
  const html = await readFile(join(result.directory, 'report.html'), 'utf8');
  assert.match(html, /SIMULATED RUN/);
  assert.match(html, /No video recorded/);
});

test('model completion is never a QA pass without acceptance checks', async t => {
  const { agent } = await setup(t);
  const result = await agent.generate({ prompt: 'Complete the shopping flow.' });
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'model_judged_complete');
});

test('wrong quantity fails an explicit check', async t => {
  const { agent } = await setup(t);
  const result = await agent.generate({ prompt: 'Complete the flow.', checks: [
    { name: 'Three items', selector: { identifier: 'checkout-quantity' }, expected: { value: '3' } },
  ] });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].observed[0].value, '2');
});

test('low confidence stops without executing a device action and finalizes video', async t => {
  const device = new SimulatedShop();
  device.startRecording = async () => { device.calls.push('startRecording'); };
  device.stopRecording = async () => { device.calls.push('stopRecording'); return { outPath: '/tmp/example.mp4' }; };
  const { agent } = await setup(t, { device, record: true, model: { decide: async () => decision('back', 0.1) } });
  const result = await agent.generate({ prompt: 'Do the task.', checks });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'low_confidence');
  assert.deepEqual(device.calls, ['open', 'startRecording', 'stopRecording', 'close']);
  assert.ok(result.checks.every(c => c.status === 'not_run'));
});

test('API failure closes the session and does not present partial billing as total cost', async t => {
  const { agent, device } = await setup(t, { model: { decide: async () => { throw new Error('upstream failed'); } } });
  const result = await agent.generate({ prompt: 'Task' });
  assert.equal(result.status, 'error');
  assert.equal(result.usage.complete, false);
  assert.equal(result.estimatedInferenceCostUsd, null);
  assert.equal(device.calls.at(-1), 'close');
});

test('unknown model action cannot reach the device', async t => {
  const { agent, device } = await setup(t, { model: { decide: async () => decision('shell rm -rf /') } });
  const result = await agent.generate({ prompt: 'Task' });
  assert.equal(result.status, 'error');
  assert.deepEqual(device.calls, ['open', 'close']);
});

test('sparse or truncated snapshots never go to the model', async t => {
  for (const partial of [{ truncated: true }, { snapshotQuality: { state: 'sparse' } }]) {
    const device = new SimulatedShop();
    device.snapshot = async () => ({ nodes: [{ ref: '@e1', role: 'button', label: 'Go' }], ...partial });
    const { agent } = await setup(t, { device, model: { decide: async () => assert.fail('Must not query incomplete state') } });
    assert.equal((await agent.generate({ prompt: 'Task' })).status, 'error');
  }
});

test('step exhaustion remains incomplete even if a check would pass', async t => {
  const { agent } = await setup(t, { maxSteps: 1 });
  const result = await agent.generate({ prompt: 'Task', checks: [{ name: 'Product visible', textIncludes: 'Canvas backpack' }] });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.reason, 'step_limit');
  assert.equal(result.steps.length, 1);
  assert.equal(result.checks[0].status, 'not_run');
});

test('cancellation after model response prevents the action', async t => {
  const controller = new AbortController();
  const { agent, device } = await setup(t, { model: { decide: async () => { controller.abort(); return decision('back'); } } });
  const result = await agent.generate({ prompt: 'Task', abortSignal: controller.signal });
  assert.equal(result.reason, 'cancelled');
  assert.deepEqual(device.calls, ['open', 'close']);
});

test('deadline cancels an in-flight model request and still cleans up', async t => {
  const { agent, device } = await setup(t, { timeoutMs: 25, model: { decide: async ({ signal }) => {
    await delay(2000, undefined, { signal });
    return decision('done');
  } } });
  const result = await agent.generate({ prompt: 'Task' });
  assert.equal(result.reason, 'timeout');
  assert.equal(device.calls.at(-1), 'close');
});

test('checks use a fresh snapshot after Jev declares completion', async t => {
  const device = new SimulatedShop();
  let count = 0;
  device.snapshot = async () => ({ nodes: [{ ref: '@e1', role: 'text', label: ++count === 1 ? 'Success' : 'Error' }] });
  const { agent } = await setup(t, { device, model: { decide: async () => decision('done') } });
  const result = await agent.generate({ prompt: 'Task', checks: [{ name: 'Success visible', textIncludes: 'Success' }] });
  assert.equal(result.status, 'failed');
  assert.equal(count, 2);
});

test('repeated ineffective action stops instead of looping', async t => {
  const device = new SimulatedShop();
  device.act = async () => {};
  const { agent } = await setup(t, { device, model: { decide: async () => decision('back') } });
  const result = await agent.generate({ prompt: 'Task' });
  assert.equal(result.reason, 'repeated_action_without_progress');
  assert.equal(result.steps.length, 3);
});

test('only supplied text is fillable; disabled and offscreen nodes are excluded; refs carry epochs', () => {
  const snapshot = { refsGeneration: 7, nodes: [
    { ref: '@e1', role: 'text-field', label: 'Email' },
    { ref: '@e2', role: 'button', label: 'Hidden', visibleToUser: false },
    { ref: '@e3', role: 'button', label: 'Disabled', enabled: false },
  ] };
  const actions = buildActions(snapshot, { email: 'qa@example.com' });
  const fill = actions.find(a => a.kind === 'fill');
  assert.equal(fill.ref, '@e1~s7');
  assert.equal(fill.text, 'qa@example.com');
  assert.equal(actions.filter(a => a.kind === 'press').length, 0);
  assert.equal(buildActions(snapshot).filter(a => a.kind === 'fill').length, 0);
});

test('no-progress detection survives reminted element references', async t => {
  const device = new SimulatedShop();
  device.act = async () => {};
  const { agent } = await setup(t, { device });
  const result = await agent.generate({ prompt: 'Add a product.' });
  assert.equal(result.reason, 'repeated_action_without_progress');
  assert.equal(result.steps.length, 3);
  assert.notEqual(result.steps[0].ref, result.steps[1].ref);
});

test('too many actions fail explicitly rather than silently discarding controls', () => {
  assert.throws(() => buildActions({ nodes: Array.from({ length: 255 }, (_, i) => ({ ref: `@e${i}`, role: 'button', label: `Button ${i}` })) }), /255/);
});

test('duplicate selector matches and unavailable values do not pass checks', () => {
  const check = { name: 'Quantity', selector: { identifier: 'quantity' }, expected: { value: '2' } };
  const node = { identifier: 'quantity', value: '2' };
  assert.equal(evaluateChecks({ nodes: [node, node] }, [check])[0].status, 'failed');
  assert.equal(evaluateChecks({ nodes: [{ identifier: 'quantity' }] }, [check])[0].status, 'failed');
  assert.throws(() => validateChecks([{ name: 'Invalid', selector: {} }]), /Invalid check/);
});

test('the HTML report escapes prompt and app-derived strings', async t => {
  const { agent } = await setup(t, { model: { decide: async () => decision('blocked') } });
  const result = await agent.generate({ prompt: '<script>alert(1)</script>' });
  const html = await readFile(join(result.directory, 'report.html'), 'utf8');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});
