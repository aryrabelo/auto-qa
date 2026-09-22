"""`uv run python -m laya_server [--port 8010] [--checkpoint typed-decisions]`."""
import argparse
import sys

from . import CHECKPOINTS, DEFAULT_CHECKPOINT, serve


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="python -m laya_server",
        description="Serve one laya checkpoint over POST /v1/systemone and GET /v1/models.")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: %(default)s)")
    ap.add_argument("--port", type=int, default=8010, help="bind port (default: %(default)s)")
    ap.add_argument("--checkpoint", choices=CHECKPOINTS, default=DEFAULT_CHECKPOINT,
                    help="which checkpoint of the bundle to load (default: %(default)s)")
    ap.add_argument("--device", default=None, choices=["cpu", "mps", "cuda"],
                    help="torch device; default picks cuda, then mps, then cpu")
    args = ap.parse_args(argv)
    return serve(host=args.host, port=args.port, checkpoint=args.checkpoint, device=args.device)


if __name__ == "__main__":
    sys.exit(main())
