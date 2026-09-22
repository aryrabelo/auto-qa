# auto-qa

Give the agent a task in plain English. It opens your app, reads the screen, asks a **local**
System One model which action to take, performs it, and repeats with a fresh snapshot until it
decides `qa_pass`, `qa_fail`, or `incomplete`. Every run is recorded as a narrated video: a title
card, a caption on each step with the model's confidence, and a verdict card at the end.

Nothing leaves your machine. There is no API key and no hosted inference.

Web apps run through Playwright/Chromium. iOS and Android apps run through
[agent-device](https://oss.callstack.com/agent-device/docs/client-api).

Credits: forked from [grabbou/jevil](https://github.com/grabbou/jevil) (the mobile QA decision loop),
and driven by [jaredpalmer/kev](https://github.com/jaredpalmer/kev), an open System One pointer model
you can serve locally.

## Setup

Node.js 24 or newer.

```bash
npm ci
npx playwright install chromium   # web runs only
cp .env.example .env
```

### The decision model

`auto-qa` talks plain HTTP to a local server that answers `POST /v1/systemone` with a choice,
a confidence, and a probability distribution. Two backends are supported.

**kev (default).** Clone and serve [kev](https://github.com/jaredpalmer/kev):

```bash
cd /path/to/kev
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
```

Use the **0.8b** checkpoint unless you have memory to spare: it answers in tens of milliseconds
warm. The 4b checkpoint wants roughly 32 GB of RAM — on a 16 GB machine it swaps and a single
decision can take tens of seconds. Point `auto-qa` elsewhere with `KEV_URL` or `--model-url`.

**laya (optional).** A ModernBERT router served by the sidecar in this repo. It has a much smaller
state budget and is weaker zero-shot, so it is opt-in. See [servers/laya/README.md](servers/laya/README.md),
then run with `--backend laya`.

| backend | default address | state budget | action cap |
| --- | --- | --- | --- |
| `kev` | `KEV_URL` or `http://127.0.0.1:8009` | 14,000 characters | 120 |
| `laya` | `LAYA_URL` or `http://127.0.0.1:8010` | 1,600 characters | 40 |

## Run a web task

The task says what to do. `--expect` says what must be true for the run to pass — repeat it once per
statement. Put exact form values in double quotes in the task: those strings become the only text the
agent may type.

```bash
npm run qa -- --url http://localhost:3000/pricing \
  --expect 'A heading reading "Pro" is visible on the current screen.' \
  --expect 'A monthly price is shown on the current screen.' \
  'Open the "Pro" plan and check the monthly price.'
```

Add `--headed` to watch it happen. `npm run qa -- --help` lists every flag.

### Expectations are the pass criterion

Before every step the agent renders the screen as a short transcript and asks the model one yes/no
question per expectation. When every statement scores at least `--pass-threshold` (default `0.9`),
the run passes right there — no further action, no model opinion involved. Otherwise the agent picks
an action and tries again. The model can still end a run early as `qa_fail` or `incomplete`, but it
has no way to declare a pass.

That split is not decoration. With a 0.8B local model, offering "finish with QA PASS" among ~40
choices let a run pass a page that did not contain the requested heading at all: probability mass
spreads thin over many choices, and the pass option wins with 0.17. Asked instead as pointed yes/no
statements over a rendered screen, true statements scored ≥ 0.95 and false ones ≤ 0.81 on the same
pages.

Two rules come out of that measurement and are enforced in code:

- **The task never appears in a verification request.** State is `{ screen }` and nothing else.
  Adding the task pulled a false statement from 0.27 up to 0.96 — the model agrees with the goal
  instead of reading the screen.
- **Write short, checkable, screen-local statements**, e.g. `A heading reading "Settings" is visible
  on the current screen.` Vague or multi-part statements are exactly what small models judge badly.

Without `--expect`, the task prompt is used as the single statement and the run warns you that this
is the weak path.

### Profiles

A profile describes one app: where it lives, how to sign in, and which part of the page matters.
It is a JSON file passed with `--profile`. Secrets are never stored in it — write `${ENV:NAME}`
and the value is read from your environment (or `.env`) at run time; an unset variable is an error.

```json
{
  "name": "demo",
  "baseUrl": "http://localhost:3000",
  "startPath": "/dashboard",
  "scope": "main",
  "viewport": { "width": 1280, "height": 800 },
  "login": {
    "path": "/login",
    "fields": [
      { "selector": "#email", "value": "qa@example.com" },
      { "selector": "#password", "value": "${ENV:QA_PASSWORD}", "secret": true }
    ],
    "submit": "button[type=submit]",
    "waitForUrlNot": "/login"
  }
}
```

```bash
QA_PASSWORD=… npm run qa -- --profile profiles/demo.json \
  'Open Settings and verify that the account email is shown.'
```

The login runs before the task, captioned `Setup: signing in`, with `secret` values masked on
screen and in the recording.

Every field is optional except `name` and `baseUrl`. `--url` overrides `baseUrl`/`startPath`;
`--scope` overrides `scope`.

## Run a mobile task

```bash
npm run qa -- --platform ios --app com.apple.Preferences \
  --expect 'A switch labelled "Smart Invert" is visible on the current screen.' \
  "Open Accessibility, then Display & Text Size, and scroll to Smart Invert. Do not change any settings."
```

Check your setup with `npx agent-device devices`. The harness picks a booted simulator or emulator
when it can; pin one with `--udid` (iOS) or `--serial` (Android). See the
[agent-device setup guide](https://oss.callstack.com/agent-device/docs/agent-setup).

## Output

```text
PASSED: Every expectation was verified on the screen.
Actions executed: <count> | QA confidence: <confidence>
  ✓ 0.97  A heading reading "Pro" is visible on the current screen.
  ✗ 0.31  A monthly price is shown on the current screen.
Model: kev kev-latest at http://127.0.0.1:8009
Startup: <seconds> s
Duration: <seconds> s
Tokens: <in> in / <out> out over <n> local decisions
Video: artifacts/<run-id>/run.mp4
JSON: artifacts/<run-id>/report.json
```

Startup covers browser or device launch, sign-in, and recording setup. Duration starts with the QA
loop and includes flushing the recording.

`artifacts/<run-id>/` holds:

- `run.mp4` — the narrated run: title card, a caption per step (`step · description · confidence`)
  with the target element outlined, then a full-screen verdict card (green pass, red fail, amber
  incomplete).
- `report.json` — status, reason, the final expectation scores, every decision with its probability
  distribution, token counts, backend and model used.
- `trace.jsonl` — the same steps streamed live, each with `t` (milliseconds since the run started)
  and the expectation scores measured on that screen, so the video and the trace line up.
- `snapshot-<n>.json`, `snapshot-final.json` — every screen the model read, in full.
- `final.png` — the app exactly as the run left it, captured before the verdict card is drawn.

Exit codes: `0` pass, `1` fail, `2` incomplete, `3` runtime or configuration error. Incomplete means
the agent could not finish or could not assess the result from what it observed.

## Run limits

- Runs stop after 40 steps or 180 seconds by default (`--max-steps`, `--timeout`).
- Each request's state is capped per backend (table above). When a screen is too large, the agent
  drops descriptive lines first, then the previous-step summary, and only then fails with a
  suggestion to use `--scope`. Trimmed screens end with `(content trimmed to fit)`.
- A screen offering more choices than the backend's action cap is an error, not a truncated list:
  narrow it with `--scope` or pass fewer quoted values.
- A decision sees the rendered screen (with its url) and a short summary of the step before it: the
  action executed, where it ran, and whether the screen or the url changed as a result. A
  verification sees the rendered screen and nothing else. Full snapshots stay on disk instead of
  accumulating in the model's context — small models decide better on a small state.
- Every step costs two local requests, one verification and one decision; a step that passes costs
  only the verification.
- If the requested state is already visible, a run can pass with zero actions. Ask for the
  navigation explicitly if you want the whole path exercised.

## References

- [grabbou/jevil](https://github.com/grabbou/jevil) — the project this is forked from
- [jaredpalmer/kev](https://github.com/jaredpalmer/kev) — local System One pointer model
- [convaiinnovations/laya](https://github.com/convaiinnovations/laya) — the alternate router backend
- [agent-device snapshots](https://oss.callstack.com/agent-device/docs/snapshots)
- [Playwright](https://playwright.dev/)
