import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildActions, modelState, fingerprint, assertReadable } from './actions.mjs';
import { promptInputs } from './inputs.mjs';
import { writeReport } from './report.mjs';

function finite(value, name, min, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
}

export class JevDeviceAgent {
  constructor({ model, device, maxSteps = 40, minConfidence = 0, minVerdictConfidence = 0.6, timeoutMs = 180_000, inputUsdPerMillion = 0.042, artifactsDir = 'artifacts', record = true, onStep } = {}) {
    if (!model?.decide || !model?.evaluate || !device?.snapshot) throw new Error('model and device adapters are required.');
    finite(maxSteps, 'maxSteps', 1, 1000);
    if (!Number.isInteger(maxSteps)) throw new Error('maxSteps must be an integer.');
    finite(minConfidence, 'minConfidence', 0, 1);
    finite(minVerdictConfidence, 'minVerdictConfidence', 0, 1);
    finite(timeoutMs, 'timeoutMs', 1, 3_600_000);
    finite(inputUsdPerMillion, 'inputUsdPerMillion', 0);
    Object.assign(this, { model, device, maxSteps, minConfidence, minVerdictConfidence, timeoutMs, inputUsdPerMillion, artifactsDir, record, onStep });
    this.running = false;
  }

  async generate({ prompt, inputs = promptInputs(prompt), abortSignal } = {}) {
    if (this.running) throw new Error('This agent is already running. Use another session for concurrent work.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A nonempty task prompt is required.');
    if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || !Object.entries(inputs).every(([k, v]) => k && typeof v === 'string')) throw new Error('inputs must map names to strings.');
    this.running = true;
    const started = performance.now();
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const directory = resolve(this.artifactsDir, runId);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
    const result = { runId, prompt, status: 'incomplete', reason: 'step_limit',
      startedAt: new Date().toISOString(), directory, steps: [], verdict: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, complete: true }, warnings: [], modelVersions: [], recording: null, screenshot: null };
    const history = [];
    const query = async (method, args) => {
      if (JSON.stringify(args.state).length > 80_000) throw new Error('App context exceeds the POC limit. Narrow the snapshot scope or task.');
      result.usage.requests++;
      let answer;
      try { answer = await this.model[method]({ ...args, signal }); }
      catch (error) { result.usage.complete = false; throw error; }
      const usage = answer.usage;
      if (Number.isFinite(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage?.output_tokens) && usage.output_tokens >= 0) {
        result.usage.inputTokens += usage.input_tokens;
        result.usage.outputTokens += usage.output_tokens;
      } else result.usage.complete = false;
      if (answer.model && !result.modelVersions.includes(answer.model)) result.modelVersions.push(answer.model);
      return answer;
    };
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
        const state = { task: prompt, inputs, screen: modelState(snapshot), history };
        const decision = await query('decide', { state, actions });
        const usage = decision.usage;
        const action = actions.find(a => a.id === decision.choice);
        if (!action || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) throw new Error('Invalid model decision.');
        const entry = { executed: false, step, choice: action.id, kind: action.kind, action: action.description, ref: action.ref,
          confidence: decision.confidence, probabilities: decision.probabilities, latencyMs: decision.latencyMs ?? 0,
          model: decision.model, usage, snapshot: `snapshot-${step}.json` };
        const observation = { step, screen: state.screen, action: action.description, executed: false };
        history.push(observation);
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
          assertReadable(finalSnapshot);
          const verdict = await query('evaluate', { state: { task: prompt, history, screen: modelState(finalSnapshot) } });
          result.verdict = { ...verdict, snapshot: 'snapshot-final.json' };
          await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ kind: 'verdict', ...result.verdict }) + '\n');
          signal.throwIfAborted();
          if (!['qa_pass', 'qa_fail', 'incomplete'].includes(verdict.choice) || !Number.isFinite(verdict.confidence) || verdict.confidence < 0 || verdict.confidence > 1) throw new Error('Invalid QA verdict.');
          if (verdict.confidence < this.minVerdictConfidence) { result.reason = 'low_verdict_confidence'; break; }
          result.status = { qa_pass: 'passed', qa_fail: 'failed', incomplete: 'incomplete' }[verdict.choice];
          result.reason = verdict.choice;
          break;
        }
        const signature = fingerprint(snapshot) + JSON.stringify([action.kind, action.target, action.inputName, action.direction]);
        repeats = signature === previous ? repeats + 1 : 1;
        previous = signature;
        if (repeats >= 3) { result.reason = 'repeated_action_without_progress'; break; }
        await this.device.act(action, { signal });
        observation.executed = true;
        entry.executed = true;
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step, kind: 'executed', choice: action.id }) + '\n');
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
      result.estimatedInferenceCostUsd = !result.usage.complete ? null : result.usage.inputTokens / 1_000_000 * this.inputUsdPerMillion;
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
