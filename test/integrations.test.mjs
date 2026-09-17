import test from 'node:test';
import assert from 'node:assert/strict';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { createAgentDeviceClient } from 'agent-device';
import { JevModel } from '../src/jev.mjs';
import { AgentDevice } from '../src/device.mjs';

test('real TypeSafe SDK serializes the Jev request and parses its response', async () => {
  let request;
  const client = new TypeSafeClient({ apiKey: 'test-only', logLevel: 'off', retry: { maxRetries: 0 }, fetch: async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return Response.json({ model: 'jev-test', answers: { nextAction: { type: 'choice', choice: 'done', confidence: 0.95, probabilities: { done: 0.97, blocked: 0.03 } } }, usage: { input_tokens: 120, output_tokens: 0 } });
  } });
  const model = new JevModel({ client });
  const result = await model.decide({ state: { task: 'Check cart' }, actions: [{ id: 'done', description: 'Finished' }, { id: 'blocked', description: 'Cannot continue' }] });
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.body.questions.nextAction.type, 'choice');
  assert.deepEqual(Object.keys(request.body.questions.nextAction.criteria), ['done', 'blocked']);
  assert.equal(result.choice, 'done');
  assert.equal(result.usage.input_tokens, 120);
});

test('SDK adapter rejects an answer outside the available action set', async () => {
  const model = new JevModel({ client: { systemOne: async () => ({ answers: { nextAction: { choice: 'invented', confidence: 1 } } }) } });
  await assert.rejects(model.decide({ state: {}, actions: [{ id: 'done', description: 'Finished' }] }), /invalid action/);
});

test('agent-device public SDK builds the real command envelopes', async () => {
  const requests = [];
  const client = createAgentDeviceClient({ session: 'test-jev', lockPolicy: 'reject', lockPlatform: 'ios' }, { transport: async request => {
    requests.push(request);
    const data = request.command === 'snapshot' ? { nodes: [{ ref: '@e1', role: 'button', label: 'Next' }], identifiers: {} } : {};
    return { ok: true, data };
  } });
  const device = new AgentDevice({ app: 'com.example.test', udid: 'test-device', client });
  await device.open();
  await device.snapshot();
  await device.act({ kind: 'press', ref: '@e1~s4' });
  await device.act({ kind: 'fill', ref: '@e2~s5', text: 'Hello' });
  await device.act({ kind: 'scroll', direction: 'down' });
  await device.startRecording('/tmp/jev-sdk-test.mp4');
  await device.stopRecording();
  await device.close();
  assert.deepEqual(requests.map(r => r.command), ['open', 'snapshot', 'press', 'fill', 'scroll', 'record', 'record', 'close']);
  assert.ok(requests.every(r => r.session === 'test-jev'));
  assert.ok(JSON.stringify(requests[2]).includes('@e1~s4'));
  assert.ok(JSON.stringify(requests[3]).includes('Hello'));
  assert.equal(requests[0].flags.udid, 'test-device');
});

