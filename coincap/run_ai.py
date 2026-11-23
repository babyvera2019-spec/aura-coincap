"""Scheduled Triple AI run, e.g. from cron:  python -m coincap.run_ai

Exits 0 on success, 2 when the run was refused by a safety limit.
"""
import json
import sys

from . import triple_ai


def main() -> int:
    try:
        run = triple_ai.run_once()
    except triple_ai.RunRefused as exc:
        print(json.dumps({"refused": str(exc), "budget": triple_ai.budget_status()}))
        return 2
    print(json.dumps({"verdict": run["consensus"], "votes": run["votes"], "cost_usd": run["cost_usd"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
