"""Check engine-only sampling across batches, including warmup and counter resets."""
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
import service_collections as sc


def run_case(root):
    config = {"native": {"datasets": [{"name": "textvqa"}], "concurrency": [1, 8], "dataCount": [5, 9],
                         "pressureSeconds": 10, "engineMetrics": ["tokens_total", "waiting"]}}
    count = 100
    calls = []

    def scrape(_):
        return f"# TYPE tokens counter\ntokens_total {count}\nwaiting 2\n"

    def execute(service, name, dataset, work):
        nonlocal count
        options = service["native"]
        requests, = options["dataCount"]
        warmup = work.relative_to(root).parts[0] == "warmup"
        assert options["warmups"] == 0
        assert ("pressureSeconds" in options) != warmup
        calls.append((options["concurrency"][0], requests))
        count += requests
        report = work / "run/performances/model/textvqa.json"
        report.parent.mkdir(parents=True)
        report.write_text(json.dumps({"Success Requests": {"total": requests}, "Failed Requests": {"total": 0}}))
        return 0

    with patch.object(sc, "read_metrics_endpoint", scrape):
        sc.run_engine_metrics(config, root, [(None, None, root / "outputs")], execute)
    points = json.loads((root / "collections.json").read_text())["points"]
    assert calls == [(1, 1), (1, 5), (8, 1), (8, 9)]
    assert [p["engine"]["series"][0]["delta"] for p in points] == [5, 9]
    assert all("delta" not in p["engine"]["series"][1] for p in points)


with TemporaryDirectory() as root:
    run_case(Path(root))
before = ({"x": ("x", 50)}, {"x"}), None
after = ({"x": ("x", 2)}, {"x"}), None
reset = sc.engine_result(["x", "absent"], before, after)
assert reset["series"][0]["delta"] is None and reset["status"] == "partial" and reset["missing"] == ["absent"]
print("Service collection checks passed")
