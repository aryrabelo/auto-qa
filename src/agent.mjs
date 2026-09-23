import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildActions, renderScreen, isStaticLine, fingerprint, assertReadable } from './actions.mjs';
import { promptInputs } from './inputs.mjs';

function finite(value, name, min, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
}

const size = value => JSON.stringify(value).length;

// A ref that stopped resolving because the app navigated is recoverable: re-read the screen.
// Bounded, so a page that keeps moving cannot hold the run in a retry loop.
const MAX_STALE_RETRIES = 2;
const isStaleRef = error => error?.code === 'stale_ref' || error?.name === 'StaleRefError';

// The decision model has a hard context budget. Shed the least valuable context first:
// descriptive screen lines, then the previous-step transition. Never silently drop controls.
export function budgetState(state, maxStateChars, backend = 'the model') {
  const trimmed = [];
  if (size(state) <= maxStateChars) return { state, trimmed, chars: size(state) };
  let candidate = state;
  if (typeof candidate.screen === 'string') {
    const lines = candidate.screen.split('\n');
    let dropped = 0;
    for (let i = lines.length - 1; i >= 1 && size(candidate) > maxStateChars; i--) {
      if (!isStaticLine(lines[i])) continue;
      lines.splice(i, 1);
      dropped++;
      candidate = { ...candidate, screen: `${lines.join('\n')}\n(content trimmed to fit)` };
    }
    if (dropped) trimmed.push(`${dropped} screen lines`);
  }
  if (size(candidate) > maxStateChars && candidate.previous) {
    candidate = { ...candidate, previous: null };
    trimmed.push('previous');
  }
  const chars = size(candidate);
  if (chars > maxStateChars) {
    throw new Error(`The screen state is ${chars} characters, over the ${backend} budget of ${maxStateChars} even after dropping every descriptive line and the previous step. Narrow the snapshot with --scope, or use a backend with a larger state budget.`);
  }
  return { state: candidate, trimmed, chars };
}

export class QaAgent {
  constructor({ model, device, expectations = [], passThreshold = 0.9, maxSteps = 40, minConfidence = 0, timeoutMs = 180_000, artifactsDir = 'artifacts', record = true, onStep } = {}) {
    if (!model?.decide || !model?.verify || !device?.snapshot) throw new Error('model and device adapters are required.');
    if (!Array.isArray(expectations) || !expectations.every(statement => typeof statement === 'string' && statement.trim())) {
      throw new Error('expectations must be an array of nonempty statements.');
    }
    finite(maxSteps, 'maxSteps', 1, 1000);
    if (!Number.isInteger(maxSteps)) throw new Error('maxSteps must be an integer.');
    finite(minConfidence, 'minConfidence', 0, 1);
    finite(passThreshold, 'passThreshold', 0, 1);
    finite(timeoutMs, 'timeoutMs', 1, 3_600_000);
    Object.assign(this, { model, device, expectations, passThreshold, maxSteps, minConfidence, timeoutMs, artifactsDir, record, onStep });
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
    const backend = this.model.backend || 'model';
    const maxStateChars = Number.isFinite(this.model.maxStateChars) ? this.model.maxStateChars : 14_000;
    const maxActions = Number.isFinite(this.model.maxActions) ? this.model.maxActions : 255;
    const result = { runId, prompt, status: 'incomplete', reason: 'step_limit',
      startedAt: new Date().toISOString(), directory, steps: [], verdict: null,
      backend, modelUrl: this.model.url ?? null, modelName: this.model.model ?? null,
      maxStateChars, maxActions, passThreshold: this.passThreshold, expectations: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, complete: true }, warnings: [], modelVersions: [], recording: null, screenshot: null };
    // The pass criterion is the expectation list. Without one, the prompt is all we have to check.
    const expectations = this.expectations.length ? this.expectations : [prompt];
    if (!this.expectations.length) {
      result.warnings.push('No expectations were given, so the task prompt itself is the pass criterion. Small local models judge free-form tasks poorly; state what must be true on screen, one short statement per expectation.');
    }
    const score = results => results.map(({ statement, p }) => ({ statement, p, met: p >= this.passThreshold }));
    let previous = null, previousFingerprint = null;
    let runStarted = null;
    const elapsed = () => Math.round(performance.now() - (runStarted ?? started));
    const note = (label, error) => result.warnings.push(`${label}: ${safeError(error)}`);
    const hook = async (name, payload) => {
      if (typeof this.device[name] !== 'function') return;
      try { await this.device[name](payload); }
      catch (error) { note(`${name} failed`, error); }
    };
    const query = async (method, args, useSignal = true) => {
      result.usage.requests++;
      let answer;
      try { answer = await this.model[method]({ ...args, ...(useSignal ? { signal } : {}) }); }
      catch (error) { result.usage.complete = false; throw error; }
      const usage = answer.usage;
      if (Number.isFinite(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage?.output_tokens) && usage.output_tokens >= 0) {
        result.usage.inputTokens += usage.input_tokens;
        result.usage.outputTokens += usage.output_tokens;
      } else result.usage.complete = false;
      if (answer.model && !result.modelVersions.includes(answer.model)) result.modelVersions.push(answer.model);
      return answer;
    };
    let opened = false, recording = false, lastSignature = '', repeats = 0, staleRetries = 0;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'trace.jsonl'), '');
      signal.throwIfAborted();
      result.device = await this.device.open();
      opened = true;
      signal.throwIfAborted();
      if (this.record) {
        try { await this.device.startRecording(join(directory, 'run.mp4')); recording = true; }
        catch (error) { note('Recording unavailable', error); }
      }
      runStarted = performance.now();
      for (let step = 1; step <= this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await this.device.snapshot();
        await writeFile(join(directory, `snapshot-${step}.json`), JSON.stringify(snapshot, null, 2));
        assertReadable(snapshot);
        const screen = renderScreen(snapshot);
        const current = fingerprint(snapshot);
        if (previous) {
          // What the executed action actually did, in a handful of tokens instead of a whole screen.
          previous.screenChanged = current !== previousFingerprint;
          if (previous.url !== undefined) previous.urlChanged = snapshot.url !== previous.url;
        }
        signal.throwIfAborted();
        // Verification runs first and alone: the task is deliberately absent from this state, because
        // including it pulls the answers toward the task instead of toward what the screen shows.
        const check = await query('verify', { screen, expectations });
        const checked = score(check.results);
        result.expectations = checked;
        if (checked.every(expectation => expectation.met)) {
          await writeFile(join(directory, 'snapshot-final.json'), JSON.stringify(snapshot, null, 2));
          const confidence = Math.min(...checked.map(expectation => expectation.p));
          const entry = { executed: false, step, t: elapsed(), choice: 'expectations_met', kind: 'verdict',
            action: `Every expectation is verified on this screen (${checked.length}).`, confidence,
            latencyMs: check.latencyMs ?? 0, model: check.model, usage: check.usage,
            expectations: checked, snapshot: `snapshot-${step}.json` };
          result.steps.push(entry);
          await appendFile(join(directory, 'trace.jsonl'), JSON.stringify(entry) + '\n');
          this.onStep?.(entry);
          await hook('annotate', { step, kind: 'verdict', description: entry.action, confidence, ref: null, expectations: checked });
          result.verdict = { choice: 'expectations_met', confidence, expectations: checked,
            model: check.model, latencyMs: check.latencyMs ?? 0, snapshot: 'snapshot-final.json' };
          result.status = 'passed';
          result.reason = 'expectations_met';
          break;
        }
        signal.throwIfAborted();
        const actions = buildActions(snapshot, inputs, this.device.capabilities ?? {});
        if (actions.length > maxActions) {
          throw new Error(`This screen offers ${actions.length} actions, over the ${backend} limit of ${maxActions}. Narrow the snapshot with --scope, or supply fewer input values.`);
        }
        const budget = budgetState({ task: prompt, screen, previous }, maxStateChars, backend);
        const state = budget.state;
        const decision = await query('decide', { state, actions });
        const usage = decision.usage;
        const action = actions.find(a => a.id === decision.choice);
        if (!action || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) throw new Error('Invalid model decision.');
        const entry = { executed: false, step, t: elapsed(), choice: action.id, kind: action.kind, action: action.description, ref: action.ref,
          confidence: decision.confidence, probabilities: decision.probabilities, latencyMs: decision.latencyMs ?? 0,
          model: decision.model, usage, stateChars: budget.chars, trimmed: budget.trimmed, actionCount: actions.length,
          expectations: checked, verifyLatencyMs: check.latencyMs ?? 0, snapshot: `snapshot-${step}.json` };
        result.steps.push(entry);
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify(entry) + '\n');
        this.onStep?.(entry);
        // Narrate the decision on screen before it is carried out, so the recording shows intent.
        await hook('annotate', { step, kind: action.kind, description: action.description, confidence: decision.confidence, ref: action.ref ?? null, expectations: checked });
        signal.throwIfAborted();
        if (action.kind !== 'verdict' && decision.confidence < this.minConfidence) { result.reason = 'low_confidence'; break; }
        if (action.kind === 'blocked') { result.reason = action.id; break; }
        if (action.kind === 'verdict') {
          // Save the exact observation that produced this terminal decision.
          await writeFile(join(directory, 'snapshot-final.json'), JSON.stringify(snapshot, null, 2));
          signal.throwIfAborted();
          result.verdict = { ...decision, expectations: checked, snapshot: 'snapshot-final.json' };
          result.status = action.status;
          result.reason = action.id;
          break;
        }
        const signature = current + JSON.stringify([action.kind, action.target, action.inputName, action.direction, action.value, action.key]);
        repeats = signature === lastSignature ? repeats + 1 : 1;
        lastSignature = signature;
        if (repeats >= 3) { result.reason = 'repeated_action_without_progress'; break; }
        try {
          await this.device.act(action, { signal });
        } catch (error) {
          // The page changed under the action: that is the app moving, not a broken run. Read the
          // new screen and decide again, without counting the attempt as a repeat that made no progress.
          if (!isStaleRef(error) || staleRetries >= MAX_STALE_RETRIES) throw error;
          staleRetries++;
          result.warnings.push(`Step ${step}: ${safeError(error)} Re-reading the screen (stale retry ${staleRetries}/${MAX_STALE_RETRIES}).`);
          await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step, t: elapsed(), kind: 'stale_ref', choice: action.id, retry: staleRetries }) + '\n');
          repeats = 0;
          lastSignature = '';
          continue;
        }
        staleRetries = 0;
        previousFingerprint = current;
        previous = { ...(snapshot.url !== undefined && { url: snapshot.url }),
          ...(snapshot.appName !== undefined && { title: snapshot.appName }), action: action.description };
        entry.executed = true;
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step, t: elapsed(), kind: 'executed', choice: action.id }) + '\n');
      }
    } catch (error) {
      result.status = signal.aborted ? 'incomplete' : 'error';
      result.reason = signal.aborted ? (deadline.aborted ? 'timeout' : 'cancelled') : 'runtime_error';
      result.warnings.push(safeError(error));
    } finally {
      if (opened && result.status !== 'passed') {
        // The screen left by the last action was never checked. Measure it before the run is filed.
        try {
          const snapshot = await this.device.snapshot();
          await writeFile(join(directory, 'snapshot-final.json'), JSON.stringify(snapshot, null, 2));
          const check = await query('verify', { screen: renderScreen(snapshot), expectations }, false);
          const checked = score(check.results);
          result.expectations = checked;
          result.finalCheck = { confidence: Math.min(...checked.map(expectation => expectation.p)), snapshot: 'snapshot-final.json' };
          // Ran out of steps, not out of evidence: the last action may well have satisfied everything.
          if (checked.every(expectation => expectation.met) && ['step_limit', 'low_confidence', 'repeated_action_without_progress'].includes(result.reason)) {
            result.status = 'passed';
            result.reason = 'expectations_met';
            result.verdict = { choice: 'expectations_met', confidence: result.finalCheck.confidence, expectations: checked,
              model: check.model, latencyMs: check.latencyMs ?? 0, snapshot: 'snapshot-final.json' };
          }
        } catch (error) { note('Final verification unavailable', error); }
      }
      if (opened) {
        // final.png must show the app as it was left, so it is taken before the verdict card covers it.
        try { result.screenshot = await this.device.screenshot(join(directory, 'final.png')); }
        catch (error) { note('Screenshot unavailable', error); }
        // The verdict card is part of the narration: it must land before the recording stops.
        await hook('showVerdict', { status: result.status, reason: result.reason,
          confidence: result.verdict?.confidence ?? null, summary: prompt, expectations: result.expectations ?? [] });
      }
      if (recording) {
        try {
          result.recording = await this.device.stopRecording();
          for (const warning of [result.recording?.warning, result.recording?.overlayWarning]) {
            if (warning) result.warnings.push(`Recording: ${warning}`);
          }
        }
        catch (error) { note('Recording finalization failed', error); }
      }
      if (opened) {
        try { await this.device.close(); }
        catch (error) { note('Session cleanup failed', error); }
      }
      const finished = performance.now();
      result.startupMs = (runStarted ?? finished) - started;
      result.durationMs = runStarted === null ? 0 : finished - runStarted;
      result.totalDurationMs = finished - started;
      this.running = false;
    }
    await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2));
    return result;
  }
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
