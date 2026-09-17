# Jev + agent-device QA agent

Give the agent a task. It reads the app through agent-device, asks Jev to choose an action, performs it, and repeats with a fresh snapshot. Each run saves a report, decision trace, snapshots, and, when supported, a device recording.

This is a local proof of concept. It uses the real TypeSafe and agent-device SDKs. The included simulated shop lets you test the loop without an API key or a device; it is not a performance benchmark.

## Setup

Use Node.js 24 or newer. For live runs, you also need an iOS simulator/device with Xcode or an Android emulator/device with ADB, and an installed test app.

```bash
npm ci
cp .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env`, or supply it in your shell environment. The key is read only by the TypeSafe client. `.env`, run artifacts, and local device state are ignored by Git.

Check your device setup with `npx agent-device devices`. See the [agent-device setup guide](https://oss.callstack.com/agent-device/docs/agent-setup) for platform prerequisites.

## Run a task

Pass the app ID, platform, and task. Describe the expected outcome in the task itself:

```bash
npm run qa -- \
  --app com.apple.Preferences \
  --platform ios \
  "Open Accessibility, then Display & Text Size. Scroll to Auto-Brightness and verify that its switch is visible. Do not change any settings."
```

This example uses Settings on an English-language iOS simulator. For your app, replace the app ID and task:

```bash
npm run qa -- \
  --app com.example.shop \
  --platform android \
  "Add a Canvas backpack to the cart, increase its quantity to two, and open checkout. Verify that the summary shows the backpack and a quantity of two. Stop before placing an order."
```

Jev chooses actions and reviews the outcome against your task. No separate assertion file is needed. The harness selects an unclaimed simulator or emulator automatically, preferring one already booted. On iOS it prefers a standard iPhone as the fallback. It prints the selected device and pins its ID for the session. Use `--udid` on iOS or `--serial` on Android to override the selection. `npm run qa -- --help` lists the optional controls.

For text entry, put exact values in double quotes inside the task. The harness makes those strings available as fill choices:

```bash
npm run qa -- --app com.example.shop --platform ios \
  'Search for "Canvas backpack" and verify that its product page opens.'
```

## Use it like a tool-loop agent

```javascript
import { JevDeviceAgent, JevModel, AgentDevice } from './src/index.mjs';

const agent = new JevDeviceAgent({
  model: new JevModel(),
  device: new AgentDevice({
    app: 'com.example.shop',
    platform: 'ios',
    session: `jev-${Date.now()}`,
  }),
});

const result = await agent.generate({
  prompt: 'Search for "Canvas backpack" and verify that its product page opens.',
});

console.log(result.status, result.directory);
```

The interface is conceptually similar to `ToolLoopAgent.generate({ prompt })`. Jev returns a choice from the current action list. This runner executes the selected action through agent-device. It does not use a text-generating model or assume Jev implements the AI SDK language-model protocol.

## How the loop works

1. Open the specified app in a dedicated session and start recording.
2. Read a full accessibility snapshot, including text needed to check the outcome.
3. Build choices for press, fill, scroll, back, wait, finish, and stop.
4. Send the task, current state, quoted input values, and earlier observed states and actions to Jev.
5. Validate the returned choice and confidence, then execute only that action.
6. Repeat with fresh references. When Jev finishes or observes a failure, capture a new snapshot. Ask Jev to choose `qa_pass`, `qa_fail`, or `incomplete` against the original task and observed history.
7. Capture the final screenshot, stop recording, close the session, and write the report.

Text entry uses quoted values from the task, or explicit `inputs` when using the JavaScript API. Jev cannot generate a search query, email address, or other free-form string. Every fill choice maps to a supplied value. Snapshot references are refreshed after each action and carry their generation when available.

## Results

Open the printed `artifacts/<run-id>/report.html` to review the run. The same folder contains:

- `report.json`: outcome, final model verdict, timing, token usage, model versions, and estimated inference cost.
- `trace.jsonl`: each selected action and the final verdict, with confidence, probabilities, and model latency.
- `snapshot-*.json`: the app state used for each decision and the final QA review.
- `run.mp4` and `final.png` when supported. Long Android recordings may have multiple chunks.

The final review is a model judgment based on the accessibility states the agent observed:

| Status | Meaning | Exit code |
| --- | --- | --- |
| `passed` | Jev selected `qa_pass`: the evidence supports the requested outcomes and constraints. | 0 |
| `failed` | Jev selected `qa_fail`: the evidence shows a requested behavior failed or a task constraint was violated. | 1 |
| `incomplete` | Evidence is insufficient, confidence is low, input is missing, progress is blocked, or the run hit a limit or was cancelled. | 2 |
| `error` | A model or device integration failed, or returned invalid data. | 3 |

Selecting the finish action alone never passes QA. The final review must return `qa_pass` above the configured confidence threshold. The review receives earlier screen observations and executed actions, so it can assess behavior that is no longer visible on the final screen. It cannot verify facts that the snapshots never exposed, and a confident model verdict can still be wrong.

The report estimates inference cost from returned input-token usage and `JEV_INPUT_USD_PER_MILLION` (default `0.042`). It assumes free output tokens and excludes device infrastructure. Update the rate for your model/account. If a request fails or usage is unavailable, the total cost is marked unavailable rather than presenting a partial estimate as complete. Timings include device work and recording finalization; the trace also lists model request time separately.

## Try the simulated demo

```bash
npm run demo
npm run check
```

The demo performs a complete shopping journey against a simulated device with predetermined decisions. It uses the same runner and final-review interface as live mode. It produces an HTML report but no video, real model costs, or performance claims.

`npm run check` performs syntax checks only.

## Current limits

- Jev reads text/structured state, not screenshots. Visual-only controls and assertions need another approach.
- The initial action set covers common press/fill/scroll interactions on iOS and Android. It does not generate text, run arbitrary commands, drag controls, or perform multi-app workflows.
- A screen has at most 255 choices, including the control actions. If it exceeds that limit, narrow `--scope` or reduce supplied input values. Truncated, empty, or sparse snapshots stop the run.
- The complete task context is capped at 80,000 characters. If the observed history exceeds that limit, the run stops with an error instead of silently dropping evidence.
- Action confidence is logged but does not stop navigation by default. Set `--min-confidence` to opt into an action cutoff. The final QA review uses a separate confidence threshold of `0.6`; this is an experimental threshold, not an accuracy guarantee. A typed choice can still be wrong.
- The timeout cancels Jev requests and is checked between device operations. An in-flight native device command and final recording export must finish before cleanup completes.
- Recording failure is reported explicitly but does not replace the QA verdict. App content in snapshots and recordings stays in the ignored artifacts directory; the model receives the task, snapshot, inputs, and history.
- `jev-latest` can change. Set `TYPESAFE_MODEL` to a specific available version for repeatable comparisons. Each response's model version is saved.

## References

- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Jev choice questions](https://docs.typesafe.ai/primitives/choice)
- [Confidence](https://docs.typesafe.ai/confidence)
- [agent-device Node.js API](https://oss.callstack.com/agent-device/docs/client-api)
- [agent-device snapshots](https://oss.callstack.com/agent-device/docs/snapshots)

