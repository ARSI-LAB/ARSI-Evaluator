"""Service-side measurements coordinated with native AISBench request windows."""
import json
import math
import re
import time
from threading import Event, Thread
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # Control requests and bearer tokens belong to the selected service.


def read_metrics_endpoint(config):
    headers = {"Content-Type": "application/json"}
    if config.get("apiKey"):
        headers["Authorization"] = "Bearer " + config["apiKey"]
    request = Request(config["endpoint"].rstrip("/") + "/metrics", headers=headers)
    with build_opener(NoRedirect()).open(request, timeout=60) as response:
        return response.read().decode("utf-8")


# Preserve separate label sets; gauges only have before/after readings.
SAMPLE = re.compile(r'^([\w:]+)(\{(?:[^"{}]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)(?:\s+\S+)?$')


def scrape(config, names):
    counters, series = set(), {}
    for line in read_metrics_endpoint(config).splitlines():
        words = line.split()
        if len(words) == 4 and words[:2] == ["#", "TYPE"] and words[3] == "counter":
            counters.update([words[2], words[2] + "_total"])
        match = SAMPLE.fullmatch(line)
        if match and match[1] in names:
            value = float(match[3])
            if math.isfinite(value):
                series[match[1] + (match[2] or "")] = (match[1], value)
    return series, counters


def read_metrics(config, names):
    try:
        return scrape(config, names), None
    except (OSError, ValueError) as error:
        return ({}, set()), str(error)


def engine_result(names, before, after):
    (first, _), before_error = before
    (last, counters), after_error = after
    result = []
    missing = set(names)
    complete = True
    for series in sorted(first.keys() | last.keys()):
        name = (last.get(series) or first[series])[0]
        start = first.get(series, (None, None))[1]
        end = last.get(series, (None, None))[1]
        row = {"series": series, "before": start, "after": end}
        if start is not None and end is not None:
            missing.discard(name)
            if name in counters:
                row["delta"] = end - start if end >= start else None
                complete &= row["delta"] is not None
        else:
            complete = False
        result.append(row)
    return {"status": "measured" if complete and not missing and not before_error and not after_error else "partial",
            "series": result, "missing": sorted(missing), "errors": [e for e in (before_error, after_error) if e]}


class ServiceWindow:
    """Sample gauges while requests are active, preserving label sets and missing readings."""
    def __init__(self, config, names, directory):
        self.config, self.names, self.directory = config, names, directory
        self.stop = Event()
        self.before = read_metrics(config, names)
        self.summary = {}
        self.worker = Thread(target=self.sample, daemon=True)

    def sample(self):
        with (self.directory / "engine-series.jsonl").open("w", encoding="utf-8") as output:
            while not self.stop.is_set():
                (series, _), error = read_metrics(self.config, self.names)
                values = {}
                for label, (_, value) in series.items():
                    stats = self.summary.setdefault(label, {"count": 0, "sum": 0, "peak": value})
                    stats["count"] += 1
                    stats["sum"] += value
                    stats["peak"] = max(stats["peak"], value)
                    values[label] = value
                output.write(json.dumps({"time": time.time(), "values": values, "error": error}) + "\n")
                output.flush()
                self.stop.wait(1)

    def finish(self):
        self.stop.set()
        self.worker.join()
        result = engine_result(self.names, self.before, read_metrics(self.config, self.names))
        result["rawSeries"] = "engine-series.jsonl"
        result["window"] = {label: {"mean": s["sum"] / s["count"], "peak": s["peak"], "samples": s["count"]}
                            for label, s in self.summary.items()}
        return result


def verify_window(work, count=None):
    """AISBench may exit zero even when requests failed or a selected dataset is missing."""
    files = set(work.glob("**/performances/*/*.json"))
    if not files:
        raise ValueError("AISBench produced no performance report")
    for name in ("combos_manifest.json", "evaluator-expected.json"):
        for path in work.rglob(name):
            for pair in json.loads(path.read_text(encoding="utf-8"))["combos"]:
                expected = path.parent / "performances" / pair["model_abbr"] / (pair["dataset_abbr"] + ".json")
                if expected not in files:
                    raise ValueError(f"Missing AISBench report for {expected.name}")
    for path in files:
        report = json.loads(path.read_text(encoding="utf-8"))
        def requests(field):
            value = float(str(report[field]["total"]).split()[0])
            if not value.is_integer() or value < 0:
                raise ValueError(f"Invalid request count in {path.name}")
            return int(value)
        success = requests("Success Requests")
        if (success < 1 or requests("Failed Requests") != 0 or (count is not None and success != count)
                or ("Total Requests" in report and success != requests("Total Requests"))):
            raise ValueError(f"Incomplete AISBench requests in {path.name}")


def bounded_window(options, count):
    result = {**options, "warmups": 0, "dataCount": [count],
              "options": {k: v for k, v in options.get("options", {}).items()
                          if k not in {"pressure", "no-pressure", "pressure-time"}}}
    result.pop("pressureSeconds", None)
    return result


def run_engine_metrics(config, run, selections, execute):
    native = config["native"]
    metrics = native["engineMetrics"]
    batches = native.get("concurrency", [1])
    points = []

    def save():
        (run / "collections.json").write_text(json.dumps({"points": points}, allow_nan=False), encoding="utf-8")

    def measure(service, options, work, name, datasets):
        code = execute({**service, "native": options}, name, datasets, work)
        if code:
            raise RuntimeError(f"AISBench exited with code {code}")

    def warmup(service, options, count, work, name, datasets):
        n = options.get("warmups", 1)
        if n:
            n = min(n, count or n)
            measure(service, bounded_window(options, n), work, name, datasets)
            verify_window(work, n)

    for name, datasets, output in selections:
        for index, batch in enumerate(batches):
            count = native["dataCount"][index] if "dataCount" in native else None
            options = {**native, "concurrency": [batch]}
            if count is not None:
                options["dataCount"] = [count]
            work = output / f"point-{index + 1}"
            point = {"dataset": name or ", ".join(d["name"] for d in native["datasets"]), "concurrency": batch,
                     "performanceDirectory": work.relative_to(run).as_posix()}
            points.append(point)
            warmup(config, options, count, run / "warmup" / str(len(points)), name, datasets)
            before = read_metrics(config, metrics)
            measure(config, {**options, "warmups": 0}, work, name, datasets)
            point["engine"] = engine_result(metrics, before, read_metrics(config, metrics))
            try:
                verify_window(work, None if native.get("pressureSeconds") or native.get("options", {}).get("pressure") else count)
                point["performanceStatus"] = "measured"
            except (ValueError, OSError, KeyError) as error:
                point.update(performanceStatus="partial", error=str(error))
            save()
