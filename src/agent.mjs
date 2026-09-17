import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildActions, modelState, fingerprint, assertReadable } from './actions.mjs';
import { validateChecks, evaluateChecks } from './checks.mjs';
import { writeReport } from './report.mjs';

function finite(value, name, min, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
}

export class JevDeviceAgent {
  constructor({ model, device, maxSteps = 40, minConfidence = 0.6, timeoutMs = 180_000, inputUsdPerMillion = 0.042, artifactsDir = 'artifacts', record = true, onStep } = {}) {
    if (!model?.decide || !device?.snapshot) throw new Error('model and device adapters are required.');
    finite(maxSteps, 'maxSteps', 1, 1000);
    if (!Number.isInteger(maxSteps)) throw new Error('maxSteps must be an integer.');
    finite(minConfidence, 'minConfidence', 0, 1);
    finite(timeoutMs, 'timeoutMs', 1, 3_600_000);
    finite(inputUsdPerMillion, 'inputUsdPerMillion', 0);
    Object.assign(this, { model, device, maxSteps, minConfidence, timeoutMs, inputUsdPerMillion, artifactsDir, record, onStep });
    this.running = false;
  }

  async generate({ prompt, inputs = {}, checks = [], abortSignal } = {}) {
    if (this.running) throw new Error('This agent is already running. Use another session for concurrent work.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A nonempty task prompt is required.');
    if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || !Object.entries(inputs).every(([k, v]) => k && typeof v === 'string')) throw new Error('inputs must map names to strings.');
    validateChecks(checks);
    this.running = true;
    const started = performance.now();
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const directory = resolve(this.artifactsDir, runId);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
    const result = { runId, prompt, mode: this.model.mode || 'live', status: 'incomplete', reason: 'step_limit',
      startedAt: new Date().toISOString(), directory, steps: [], checks: checks.map(c => ({ name: c.name, status: 'not_run' })),
      usage: { inputTokens: 0, outputTokens: 0, complete: true }, warnings: [], modelVersions: [], recording: null, screenshot: null };
    let opened = false, recording = false, previous = '', repeats = 0;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'trace.jsonl'), '');
      signal.throwIfAborted();
      result.device = await this.device.open();
      opened = true;
      signal.throwIfAborted();
      if (this.record) {
        try { await this.device.startRecording(join(directory, 'run.mp4')); recording = true; }
        catch (error) { result.warnings.push(`Recording unavailable: ${safeError(error)}`); }
      }
      for (let step = 1; step <= this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await this.device.snapshot();
        await writeFile(join(directory, `snapshot-${step}.json`), JSON.stringify(snapshot, null, 2));
        assertReadable(snapshot);
        signal.throwIfAborted();
        const actions = buildActions(snapshot, inputs);
        const state = { task: prompt, acceptanceCriteria: checks, inputs,
          screen: modelState(snapshot), history: result.steps.map(s => ({ step: s.step, action: s.action })) };
        if (JSON.stringify(state).length > 80_000) throw new Error('App context exceeds the POC limit. Narrow the snapshot scope or task.');
        let decision;
        try { decision = await this.model.decide({ state, actions, signal }); }
        catch (error) { result.usage.complete = false; throw error; }
        const usage = decision.usage;
        if (Number.isFinite(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage?.output_tokens) && usage.output_tokens >= 0) {
          result.usage.inputTokens += usage.input_tokens;
          result.usage.outputTokens += usage.output_tokens;
        } else result.usage.complete = false;
        if (decision.model && !result.modelVersions.includes(decision.model)) result.modelVersions.push(decision.model);
        const action = actions.find(a => a.id === decision.choice);
        if (!action || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) throw new Error('Invalid model decision.');
        const entry = { step, choice: action.id, kind: action.kind, action: action.description, ref: action.ref,
          confidence: decision.confidence, probabilities: decision.probabilities, latencyMs: decision.latencyMs ?? 0,
          model: decision.model, usage, snapshot: `snapshot-${step}.json` };
        result.steps.push(entry);
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify(entry) + '\n');
        this.onStep?.(entry);
        signal.throwIfAborted();
        if (decision.confidence < this.minConfidence) { result.reason = 'low_confidence'; break; }
        if (action.kind === 'blocked') { result.reason = action.id; break; }
        if (action.kind === 'done') {
          // The app may have changed while the model request was in flight.
          const finalSnapshot = await this.device.snapshot();
          await writeFile(join(directory, 'snapshot-final.json'), JSON.stringify(finalSnapshot, null, 2));
          signal.throwIfAborted();
          result.checks = evaluateChecks(finalSnapshot, checks);
          result.status = checks.length ? (result.checks.every(c => c.status === 'passed') ? 'passed' : 'failed') : 'completed';
          result.reason = checks.length ? 'acceptance_checks' : 'model_judged_complete';
          break;
        }
        const signature = fingerprint(snapshot) + JSON.stringify([action.kind, action.target, action.inputName, action.direction]);
        repeats = signature === previous ? repeats + 1 : 1;
        previous = signature;
        if (repeats >= 3) { result.reason = 'repeated_action_without_progress'; break; }
        await this.device.act(action, { signal });
      }
    } catch (error) {
      result.status = signal.aborted ? 'incomplete' : 'error';
      result.reason = signal.aborted ? (deadline.aborted ? 'timeout' : 'cancelled') : 'runtime_error';
      result.warnings.push(safeError(error));
    } finally {
      if (opened) {
        try { result.screenshot = await this.device.screenshot(join(directory, 'final.png')); }
        catch (error) { result.warnings.push(`Screenshot unavailable: ${safeError(error)}`); }
      }
      if (recording) {
        try {
          result.recording = await this.device.stopRecording();
          for (const note of [result.recording?.warning, result.recording?.overlayWarning]) {
            if (note) result.warnings.push(`Recording: ${note}`);
          }
        }
        catch (error) { result.warnings.push(`Recording finalization failed: ${safeError(error)}`); }
      }
      if (opened) {
        try { await this.device.close(); }
        catch (error) { result.warnings.push(`Session cleanup failed: ${safeError(error)}`); }
      }
      result.durationMs = performance.now() - started;
      result.inputUsdPerMillion = this.inputUsdPerMillion;
      result.estimatedInferenceCostUsd = result.mode === 'simulation' || !result.usage.complete ? null : result.usage.inputTokens / 1_000_000 * this.inputUsdPerMillion;
      this.running = false;
    }
    await writeReport(directory, result);
    return result;
  }
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  const key = process.env.TYPESAFE_API_KEY;
  if (key) message = message.replaceAll(key, '[REDACTED]');
  return message;
}
