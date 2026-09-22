"""A System One HTTP sidecar: one laya checkpoint served behind the API auto-qa already speaks.

auto-qa talks to exactly one endpoint shape, POST /v1/systemone, and swaps the process behind it
(`--backend kev` / `--backend laya`). This module is the laya side of that swap: it loads a single
`laya.Agent` and translates between that API and `Agent.system_one`.

The translation is thin because laya's own return value is already nearly the target shape. Three
things are not, and each is a deliberate decision documented here and in README.md:

1. `confidence`. laya reports normalised Shannon entropy (`laya.confidence_from_probs`); the other
   backend reports the chance-corrected top probability `(max(p) - 1/K) / (1 - 1/K)`. Those two
   numbers disagree badly on the same distribution -- a 0.6/0.2/0.2 split is 0.40 chance-corrected
   but 0.135 by entropy, and over three options a near coin flip (0.34/0.33/0.33) is 0.01 against
   0.0001 -- so a caller gating on one threshold would silently mean two different things per
   backend. `confidence` is therefore the chance-corrected statistic, computed identically for both
   backends, and laya's native number is reported alongside it as `laya_confidence`.
2. `usage.output_tokens`. laya returns 0. We count the serialised answers with laya's own tokenizer,
   which is what the other backend bills.
3. `usage.state_tokens`. Added, not translated: a laya checkpoint holds 512 or 1024 tokens total and
   silently right-truncates the state to whatever the question head leaves over, so a caller that
   cannot see how much state it actually spent cannot tell a decision from a decision made blind.

Everything else -- option rendering ("name: description"), noul's [false, true] order, score's
`legend` of level index to description -- laya already does the same way, so it is passed through.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BUNDLE_REPO = "convaiinnovations/laya"
CHECKPOINTS = ("root", "typed-decisions", "multilingual")
DEFAULT_CHECKPOINT = "typed-decisions"
SERVED_NAME = "laya-latest"
QTYPES = ("choice", "noul", "score")
MAX_OPTIONS = 255
MAX_BODY_BYTES = 4 << 20


class BadRequest(Exception):
    """A malformed request: reported as 400, never as a server fault."""


def serialize_state(state):
    """The state as the one string laya encodes. Objects and arrays become compact JSON."""
    if isinstance(state, str):
        return state
    return json.dumps(state, ensure_ascii=False, separators=(",", ":"), default=str)


def choice_confidence(p):
    """Chance-corrected top probability: 0 at a uniform distribution, 1 at certainty."""
    k = len(p)
    return 1.0 if k == 1 else (max(p) - 1 / k) / (1 - 1 / k)


def score_confidence(p):
    """1 - E|level - mode| / (L - 1): how tightly the distribution sits on its modal level."""
    n = len(p)
    if n == 1:
        return 1.0
    mode = max(range(n), key=lambda i: p[i])
    return 1.0 - sum(pi * abs(i - mode) for i, pi in enumerate(p)) / (n - 1)


def round_prob(x):
    return round(float(x), 4)


def _require(cond, message):
    if not cond:
        raise BadRequest(message)


def validate_question(qid, q):
    """One question, checked the way the model would fail on it, but as a 400 instead of a crash.

    Returns the question laya accepts: `instructions` always present (laya indexes it), `criteria`
    left in laya's own vocabulary so option rendering stays identical across the two backends.
    """
    _require(isinstance(q, dict), f"questions.{qid} must be an object")
    qtype = q.get("type")
    _require(qtype in QTYPES, f"questions.{qid}.type must be one of {', '.join(QTYPES)}")
    criteria = q.get("criteria")

    if qtype == "choice":
        if isinstance(criteria, list):
            _require(all(isinstance(c, str) for c in criteria),
                     f"questions.{qid}.criteria as an array must hold strings")
            criteria = {c: None for c in criteria}
        _require(isinstance(criteria, dict),
                 f"questions.{qid}.criteria must be an object of option name -> description")
        _require(1 <= len(criteria) <= MAX_OPTIONS,
                 f"questions.{qid}.criteria must have 1..{MAX_OPTIONS} options")
    elif qtype == "score":
        _require(isinstance(criteria, list),
                 f"questions.{qid}.criteria must be an array of ordered level descriptions")
        _require(1 <= len(criteria) <= MAX_OPTIONS,
                 f"questions.{qid}.criteria must have 1..{MAX_OPTIONS} levels")
    else:
        _require(criteria is None or isinstance(criteria, dict),
                 f"questions.{qid}.criteria must be an object with optional 'false' and 'true' keys")

    instructions = q.get("instructions")
    return {"type": qtype, "instructions": "" if instructions is None else instructions,
            "criteria": criteria}


def validate_request(body):
    """-> (state string, questions laya accepts). Raises BadRequest on anything else."""
    _require(isinstance(body, dict), "request body must be a JSON object")
    _require("state" in body, "request body must have a 'state' field")
    model = body.get("model", SERVED_NAME)
    _require(model is None or isinstance(model, str), "'model' must be a string")

    questions = body.get("questions")
    _require(isinstance(questions, dict) and questions,
             "'questions' must be a non-empty object of question id -> question")
    return serialize_state(body["state"]), {qid: validate_question(qid, q)
                                            for qid, q in questions.items()}


def to_answers(laya_answers):
    """laya's answers in the shape the other backend returns.

    Both report `probabilities` in option order, so the chance-corrected confidence is recomputed
    from them rather than from laya's entropy score; laya's own number is kept as `laya_confidence`.
    """
    out = {}
    for qid, a in laya_answers.items():
        native = round_prob(a["confidence"])
        if a["type"] == "noul":
            out[qid] = {"type": "noul", "noul": round_prob(a["noul"]), "laya_confidence": native}
            continue
        probs = a["probabilities"]
        p = [float(v) for v in probs.values()]
        dist = {k: round_prob(v) for k, v in probs.items()}
        if a["type"] == "choice":
            out[qid] = {"type": "choice", "choice": a["choice"],
                        "confidence": round_prob(choice_confidence(p)), "probabilities": dist,
                        "laya_confidence": native}
        else:
            out[qid] = {"type": "score", "score": round_prob(a["score"]), "legend": a["legend"],
                        "probabilities": dist, "confidence": round_prob(score_confidence(p)),
                        "laya_confidence": native}
    return out


class LayaService:
    """One loaded checkpoint, plus the lock that keeps concurrent requests off a single torch module."""

    def __init__(self, checkpoint=DEFAULT_CHECKPOINT, device=None):
        from laya import Agent

        if checkpoint not in CHECKPOINTS:
            raise ValueError(f"unknown checkpoint {checkpoint!r}; expected one of {', '.join(CHECKPOINTS)}")
        self.checkpoint = checkpoint
        subfolder = None if checkpoint == "root" else checkpoint
        self.agent = Agent(BUNDLE_REPO, device=device, subfolder=subfolder)
        self.lock = threading.Lock()

    @property
    def context(self):
        return int(self.agent.cfg.get("max_len", 512))

    def describe(self):
        """The GET /v1/models entry: what is actually loaded, not what was asked for."""
        cfg = self.agent.cfg
        return {
            "name": SERVED_NAME,
            "description": f"laya System One decision model, {self.checkpoint} checkpoint on "
                           f"{cfg.get('encoder')}, {self.context}-token context",
            "run": BUNDLE_REPO if self.checkpoint == "root" else f"{BUNDLE_REPO}/{self.checkpoint}",
            "checkpoint": self.checkpoint,
            "context": self.context,
            "head_context": int(cfg.get("head_max_len", 192)),
            "encoder": cfg.get("encoder"),
            "device": str(self.agent.device),
            "dtype": str(self.agent.dtype).replace("torch.", ""),
        }

    def count_tokens(self, text):
        return len(self.agent.tok(text, add_special_tokens=False)["input_ids"])

    def systemone(self, body):
        state, questions = validate_request(body)
        started = time.perf_counter()
        with self.lock:
            try:
                raw = self.agent.system_one(state, questions)
            except ValueError as e:
                # laya raises this when a question's options cannot fit the head: a request problem.
                raise BadRequest(str(e)) from e
        latency_ms = round((time.perf_counter() - started) * 1000, 1)

        answers = to_answers(raw["answers"])
        return {
            "model": SERVED_NAME,
            "answers": answers,
            "usage": {
                "input_tokens": int(raw["usage"]["input_tokens"]),
                "output_tokens": self.count_tokens(json.dumps(answers)),
                "state_tokens": self.count_tokens(state),
            },
            "latency_ms": latency_ms,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "laya-server"
    protocol_version = "HTTP/1.1"
    service = None

    def log_message(self, fmt, *args):
        print("[laya-server] %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _error(self, status, kind, message):
        self._send(status, {"error": {"type": kind, "message": message}})

    def _read_json(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise BadRequest("Content-Length is required")
        try:
            length = int(length)
        except ValueError:
            raise BadRequest("Content-Length must be an integer") from None
        if length > MAX_BODY_BYTES:
            raise BadRequest(f"request body exceeds {MAX_BODY_BYTES} bytes")
        try:
            return json.loads(self.rfile.read(length) or b"")
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise BadRequest(f"request body is not valid JSON: {e}") from None

    def do_GET(self):
        if self.path.split("?")[0] == "/v1/models":
            self._send(200, {"models": [self.service.describe()]})
        else:
            self._error(404, "not_found", f"no route for GET {self.path}")

    def do_POST(self):
        if self.path.split("?")[0] != "/v1/systemone":
            self._error(404, "not_found", f"no route for POST {self.path}")
            return
        try:
            self._send(200, self.service.systemone(self._read_json()))
        except BadRequest as e:
            self._error(400, "invalid_request", str(e))
        except Exception as e:  # a model or runtime fault, reported rather than dropped
            self._error(500, "model_error", f"{type(e).__name__}: {e}")


def serve(host="127.0.0.1", port=8010, checkpoint=DEFAULT_CHECKPOINT, device=None):
    """Load the checkpoint, then listen. Loading first makes a bound port mean 'ready'."""
    service = LayaService(checkpoint=checkpoint, device=device)
    described = service.describe()
    print(f"[laya-server] loaded {described['run']} on {described['device']} "
          f"({described['context']}-token context)", flush=True)

    handler = type("BoundHandler", (Handler,), {"service": service})
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    print(f"[laya-server] listening on http://{host}:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("[laya-server] stopping", flush=True)
    finally:
        httpd.server_close()
    return 0
