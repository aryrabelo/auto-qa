import { createAgentDeviceClient } from 'agent-device';
import { setTimeout as delay } from 'node:timers/promises';

export class AgentDevice {
  constructor({ app, platform = 'ios', device, udid, serial, scope, session, cwd, settleMs = 250, client } = {}) {
    if (!app) throw new Error('An app bundle/package ID is required.');
    if (!['ios', 'android'].includes(platform)) throw new Error('This POC supports ios and android.');
    this.target = { app, platform, device, udid, serial };
    this.scope = scope;
    this.settleMs = settleMs;
    this.client = client || createAgentDeviceClient({ session, cwd, lockPolicy: 'reject', lockPlatform: platform, responseLevel: 'full' });
  }
  open() { return this.client.apps.open(this.target); }
  snapshot() { return this.client.capture.snapshot({ forceFull: true, scope: this.scope, timeoutMs: 15_000 }); }
  async act(action, { signal } = {}) {
    signal?.throwIfAborted();
    const settle = { settle: true, settleQuietMs: this.settleMs, timeoutMs: 5000 };
    switch (action.kind) {
      case 'press': return this.client.interactions.press({ ref: action.ref, ...settle });
      case 'fill': return this.client.interactions.fill({ ref: action.ref, text: action.text, ...settle });
      case 'scroll': return this.client.interactions.scroll({ direction: action.direction, ...settle });
      case 'back': await this.client.command.back({}); return delay(this.settleMs, undefined, { signal });
      case 'wait': return delay(500, undefined, { signal });
      default: throw new Error(`Unsupported device action: ${action.kind}`);
    }
  }
  startRecording(path) { return this.client.recording.record({ action: 'start', path }); }
  stopRecording() { return this.client.recording.record({ action: 'stop' }); }
  screenshot(path) { return this.client.capture.screenshot({ path }); }
  close() { return this.client.sessions.close(); }
}
