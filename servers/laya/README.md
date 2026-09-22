# laya sidecar

A local HTTP server that puts the [laya](https://huggingface.co/convaiinnovations/laya) decision
model behind the same API auto-qa already speaks, so `--backend laya` is a process swap and nothing
more.

## What laya is

laya is a **System One** model: it does not generate text. It is a bidirectional encoder
(ModernBERT-large) with a typed decision head that reads a state and a set of typed questions in a
single non-autoregressive forward pass and returns a probability distribution over the options you
gave it. There is no sampling, no tool loop, and no token stream — one forward pass, one
distribution, ~40 ms.

That is exactly the shape of auto-qa's inner loop: *here is the screen, here are the 12 things I
could press, which one.* The model never invents an action, because it can only ever return an index
into the options you handed it.

## Running it

```sh
cd servers/laya
uv sync                                  # one-time: creates .venv, resolves from uv.lock
uv run python -m laya_server --port 8010
```

Flags: `--host` (default `127.0.0.1`), `--port` (default `8010`), `--checkpoint`
(`root` | `typed-decisions` | `multilingual`, default `typed-decisions`), `--device`
(`cpu` | `mps` | `cuda`, default picks the best available).

The first start downloads the checkpoint from Hugging Face (~800 MiB for `typed-decisions`) into
`~/.cache/huggingface`; later starts load from that cache. Only the requested subfolder is
downloaded, never the whole bundle. The port is bound **after** the weights are loaded, so a
connectable port means the server is ready to answer — no warm-up race.

## Why `typed-decisions` is the default

The bundle ships three checkpoints. Measured from their `rl_agent_config.json`:

| checkpoint | encoder | context | head budget | usable state |
|---|---|---|---|---|
| `root` | ModernBERT-large | 512 | 192 | ~260–470 tokens |
| **`typed-decisions`** | ModernBERT-large | **1024** | 256 | **~770–980 tokens** |
| `multilingual` | mmBERT-base | 1024 | 256 | ~770–980 tokens |

A QA screen serialised for the model — title, url, every hittable element with its label, plus the
visible text context — is the single biggest input this server gets, so context is the deciding
axis. That rules out `root` at 512.

Between the two 1024-token checkpoints, `typed-decisions` wins on calibration: it ships fitted
per-question-type temperatures (`1.015 / 1.037 / 1.058`), while `multilingual` ships `1.0, 1.0, 1.0`
and an empty `temperature_by_options` — i.e. it was never temperature-fitted at all, so its
confidence is raw softmax. `multilingual`'s one advantage, non-English input, buys auto-qa nothing:
it drives English web UIs.

"Usable state" is a range because the question head — the instructions plus every option — is
charged against the same 1024 tokens. Measured on this server, with a short instruction:

| options in the question | head tokens | state tokens left |
|---|---|---|
| 3 | 44 | 980 |
| 11 | 132 | 892 |
| 20 | 231 | 793 |
| 30 or more | 252 (capped) | 772 |

auto-qa's `maxStateChars: 1600` for this backend is ~400–500 tokens, comfortably inside every row.

## Limits you must design around

These are the real failure modes, all measured against this server, not copied from the model card.

**State is silently right-truncated.** The encoder has no overflow signal — it fills the context and
drops the rest, with no error. Sending a 4,817-token state to the 1024-token checkpoint returned a
perfectly confident-looking answer computed from the first ~1,000 tokens:

```json
{"input_tokens": 1024, "output_tokens": 61, "state_tokens": 4817}
```

This is why the response carries `usage.state_tokens` (the whole state, as tokenized) next to
`usage.input_tokens` (what actually reached the model). **`state_tokens` > `input_tokens` means the
model never saw the tail of your screen** — and on a QA run the tail is usually the part with the
button in it. Keep the state small; that is what `maxStateChars` is for.

**Option text is truncated too, once the options stop fitting the head.** The head has a 256-token
budget. While the options fit, each is kept whole (measured: 3 options cost 44 head tokens, 20 cost
231). Once their combined length passes ~240 tokens — about 25 short action labels — laya switches
to an equal per-option ration of `240 / n` tokens: **8 tokens each at 30 options, 6 at 40**. A label
like `press the link labelled Campaign Settings` then survives as about three words. Past ~25
actions, keep labels short and front-load the distinguishing word.

**Confidence is inflated above 10 options.** The checkpoint ships a fitted temperature of **0.1006**
for the `choice:11+` bucket. A temperature below 1 *sharpens* logits instead of softening them —
0.1006 multiplies them ~10x, which republishes a 0.24 top probability as 0.99. laya refuses the
worst of this and clamps to 0.5, printing a `RuntimeWarning` at load (you will see it; it is
expected). But 0.5 still sharpens 2x, and the seam is visible from outside. The same state, asked
with a growing option list:

| options | temperature bucket | top probability, as a multiple of uniform | `confidence` |
|---|---|---|---|
| 9 | `choice:6-10` (1.000) | 1.98x | 0.122 |
| 10 | `choice:6-10` (1.000) | 1.72x | 0.080 |
| 11 | `choice:11+` (0.5, clamped) | **2.60x** | **0.160** |
| 12 | `choice:11+` (0.5, clamped) | 2.57x | 0.142 |

Adding an eleventh option makes the model *more* confident, which nothing about the question
justifies. So **treat confidence from questions with more than 10 options as an upper bound, not a
calibrated probability.** Ten options or fewer use temperatures in `[1.0, 1.91]` and are the range
the calibration actually covers.

**Zero-shot quality is modest.** laya is a small encoder that was not trained on web QA. It reliably
prefers a plausible action over an implausible one but does so with low margin: on a three-option
Dashboard screen it picked the right link at `p = 0.42` against `0.32 / 0.26`. Read it as a ranking
signal, not as an oracle, and do not gate a run on a high confidence threshold. kev is the default
backend for this reason; laya is the selectable second opinion.

## API

Identical to the other System One backend, so `src/model.mjs` needs no branch beyond the URL.

### `GET /v1/models`

```json
{"models": [{"name": "laya-latest", "description": "...", "run": "convaiinnovations/laya/typed-decisions",
             "checkpoint": "typed-decisions", "context": 1024, "head_context": 256,
             "encoder": "answerdotai/ModernBERT-large", "device": "mps", "dtype": "float32"}]}
```

### `POST /v1/systemone`

Request. `state` may be a string, object, or array — non-strings are serialised to compact JSON
before the model sees them. `questions` maps an id to a typed question; all questions in one request
are answered in a single forward pass.

```json
{
  "state": "task: open Campaigns\nscreen: Dashboard\n- link \"Campaigns\" (e1)\n- link \"Settings\" (e2)",
  "model": "laya-latest",
  "questions": {
    "nextAction": {
      "type": "choice",
      "instructions": "You are QA-testing a web app. Pick the single next action.",
      "criteria": {
        "press e1": "press the link labelled Campaigns",
        "press e2": "press the link labelled Settings",
        "qa_pass": "the task is already complete on this screen"
      }
    }
  }
}
```

Response:

```json
{
  "model": "laya-latest",
  "answers": {
    "nextAction": {
      "type": "choice",
      "choice": "press e1",
      "confidence": 0.1371,
      "probabilities": {"press e1": 0.4247, "press e2": 0.317, "qa_pass": 0.2583},
      "laya_confidence": 0.0192
    }
  },
  "usage": {"input_tokens": 115, "output_tokens": 69, "state_tokens": 50},
  "latency_ms": 41.6
}
```

Question types, matching the other backend exactly:

| type | `criteria` | answer fields |
|---|---|---|
| `choice` | object of option name -> description (or an array of names) | `choice`, `confidence`, `probabilities` |
| `noul` | optional object with `false` / `true` descriptions | `noul` (the probability of true) |
| `score` | ordered array of level descriptions | `score`, `legend`, `probabilities`, `confidence` |

Errors are JSON, never an HTML traceback: `400` with
`{"error": {"type": "invalid_request", "message": "..."}}` for a malformed body, an unknown question
type, empty `questions`, a missing `state`, or options that cannot fit the head; `500` with
`type: "model_error"` if the forward pass itself fails; `404` for any other route.

### The one deliberate difference: `confidence`

The two backends disagree on what "confidence" means, so this server **does not** pass laya's number
through as `confidence`.

- laya natively reports normalised Shannon entropy, `1 - H(p)/log k`.
- kev reports the chance-corrected top probability, `(max(p) - 1/k) / (1 - 1/k)`.

They diverge sharply on the same distribution — `0.6 / 0.2 / 0.2` is **0.40** chance-corrected but
**0.135** by entropy, and a near coin flip `0.34 / 0.33 / 0.33` is **0.01** against **0.0001** — so
a caller with one threshold would silently be applying two different
policies depending on which backend was up. This server therefore computes `confidence` with kev's
formula from laya's own probabilities, and reports laya's native value alongside it as
`laya_confidence`. If you want the plain probability of the chosen option, it is already in
`probabilities[choice]`.

Two more fields are ours, not laya's: `usage.output_tokens` (laya returns `0`; we count the
serialised answers with laya's tokenizer, which is what kev bills) and `usage.state_tokens`
(explained under Limits).

## Memory

**~2.4 GB resident, ~3.8 GB peak during load**, measured on an M5 with `--checkpoint typed-decisions`
on `mps`:

```
phys_footprint:      2369 MB
phys_footprint_peak: 3781 MB
```

Beware `ps`/`top` here: they report **139 MiB RSS** for the same process. On Apple silicon the model
lives in unified memory that MPS allocates outside the RSS accounting, so `ps` understates this
server by ~17x. Use `footprint -p <pid>`. The peak is the safetensors load plus the fp32 conversion
and is transient.

On a 16 GB machine already running kev and a Docker VM, that is enough to matter: run one checkpoint
at a time and stop the server when you are done with it. This is also why the server loads a single
`laya.Agent` for the checkpoint you asked for rather than `laya.Router`, which lazily loads several
checkpoints into memory to route between them.

## How auto-qa uses it

```sh
uv run python -m laya_server --port 8010    # this directory
npm start -- --backend laya ...             # repo root
```

auto-qa's model client defaults to `LAYA_URL` or `http://127.0.0.1:8010` and sends one `choice`
question per step, with the candidate actions as criteria. Because laya's context is tighter than
kev's, the `laya` backend also uses smaller budgets (`maxStateChars: 1600`, `maxActions: 40`) — see
the model client for the exact defaults. No API key, no network egress: everything after the initial
checkpoint download is local.
