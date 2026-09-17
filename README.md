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

```bash
npm run qa -- \
  --app com.example.shop \
  --platform ios \
  --expect "Checkout summary" \
  "Add a Canvas backpack to the cart, set its quantity to two, and open the checkout summary. Stop before placing an order."
```

Replace the app ID, prompt, and expected text with your app's values. The example checks only that the final screen contains `Checkout summary`. Add field-level checks to verify the product and quantity:

```bash
npm run qa -- \
  --app com.example.shop --platform android \
  --serial emulator-5554 \
  --checks examples/cart-checks.json \
  --inputs examples/inputs.json \
  "Add a Canvas backpack, change its quantity to two, and open checkout. Stop before placing an order."
```

The identifiers in `cart-checks.json` describe the simulated shop. Change them to the accessibility identifiers and values in your app. `--expect` is a convenience for visible text checks; `selector` + `expected` checks match exactly one visible node and compare its fields.

Use `--udid` on iOS or `--serial` on Android to pin a device. `npm run qa -- --help` lists all options. Use test data and a test account for QA tasks.

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
  prompt: 'Search for Canvas backpack and open its product page.',
  inputs: { searchTerm: 'Canvas backpack' },
  checks: [{ name: 'Product name visible', textIncludes: 'Canvas backpack' }],
});

console.log(result.status, result.directory);
```

The interface is conceptually similar to `ToolLoopAgent.generate({ prompt })`. Jev returns a choice from the current action list. This runner executes the selected action through agent-device. It does not use a text-generating model or assume Jev implements the AI SDK language-model protocol.

## How the loop works

1. Open the specified app in a dedicated session and start recording.
2. Read a full accessibility snapshot, including text needed to check the outcome.
3. Build choices for press, fill, scroll, back, wait, finish, and stop.
4. Send the task, current state, supplied inputs, acceptance criteria, and action history to Jev.
5. Validate the returned choice and confidence, then execute only that action.
6. Repeat with fresh references. When Jev chooses to finish, capture a new snapshot and evaluate the explicit checks.
7. Capture the final screenshot, stop recording, close the session, and write the report.

Text entry uses named values supplied in `inputs`. Jev cannot invent a search query, email address, or other free-form string. Every fill choice maps to a supplied value. Snapshot references are refreshed after each action and carry their generation when available.

## Results

Open the printed `artifacts/<run-id>/report.html` to review the run. The same folder contains:

- `report.json`: outcome, individual checks, timing, token usage, model versions, and estimated inference cost.
- `trace.jsonl`: each selected action, confidence, probabilities, and model latency.
- `snapshot-*.json`: the app state used for each decision and the final checks.
- `run.mp4` and `final.png` when supported. Long Android recordings may have multiple chunks.

`passed` means the model finished and all supplied checks passed. `failed` means at least one final check failed. `completed` means Jev judged the task complete, but no explicit checks were supplied. `incomplete` covers low confidence, missing input, a blocked path, repeated ineffective actions, cancellation, or step/time limits. `error` identifies an integration/runtime failure. Checks that were never reached are `not_run`.

The report estimates inference cost from returned input-token usage and `JEV_INPUT_USD_PER_MILLION` (default `0.042`). It assumes free output tokens and excludes device infrastructure. Update the rate for your model/account. If a request fails or usage is unavailable, the total cost is marked unavailable rather than presenting a partial estimate as complete. Timings include device work and recording finalization; the trace also lists model request time separately.

## Try the simulated demo and tests

```bash
npm run demo
npm test
```

The demo performs a complete shopping journey against a simulated device with predetermined decisions. It uses the same runner and assertions as live mode. It produces an HTML report but no video, real model costs, or performance claims.

Tests exercise successful and failed checks, fresh references, cancellation, confidence limits, incomplete snapshots, API errors, cleanup, and actual SDK request serialization using fake transports.

## Current limits

- Jev reads text/structured state, not screenshots. Visual-only controls and assertions need another approach.
- The initial action set covers common press/fill/scroll interactions on iOS and Android. It does not generate text, run arbitrary commands, drag controls, or perform multi-app workflows.
- A screen has at most 255 choices, including the control actions. If it exceeds that limit, narrow `--scope` or reduce supplied input values. Truncated, empty, or sparse snapshots stop the run.
- The default confidence threshold of `0.6` is a starting point for experimentation, not an accuracy guarantee. Evaluate it on your app. A typed choice can still be the wrong choice.
- The timeout cancels Jev requests and is checked between device operations. An in-flight native device command and final recording export must finish before cleanup completes.
- Recording failure is reported explicitly but does not replace the outcome of the acceptance checks. App content in snapshots and recordings stays in the ignored artifacts directory; the model receives the task, snapshot, inputs, and history.
- `jev-latest` can change. Set `TYPESAFE_MODEL` to a specific available version for repeatable comparisons. Each response's model version is saved.

## References

- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Jev choice questions](https://docs.typesafe.ai/primitives/choice)
- [Confidence](https://docs.typesafe.ai/confidence)
- [agent-device Node.js API](https://oss.callstack.com/agent-device/docs/client-api)
- [agent-device snapshots](https://oss.callstack.com/agent-device/docs/snapshots)

