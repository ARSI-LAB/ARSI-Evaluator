"""Fixed-length SyntheticDataset workload, owned by the AISBench SSH plugin."""
import csv
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit



def norm(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def numeric(cell):
    value = float(cell.replace(",", "").split()[0])
    if not math.isfinite(value):
        raise ValueError("Nonfinite measurement")
    return value


def parse_results(directory, workload):
    # The aggregate throughput comes from AISBench's total table, not an average
    # of per-request rates. Latencies come from its own statistics CSV.
    tables = []
    for path in sorted(directory.glob("outputs/**/*.csv")):
        with path.open(encoding="utf-8") as stream:
            rows = list(csv.reader(stream))
        if rows and rows[0] and norm(rows[0][0]) == "performanceparameters":
            tables.append(rows)
    if len(tables) != 1:
        raise ValueError(f"Expected one workload summary CSV, found {len(tables)}")
    rows = tables[0]
    stages = [norm(x) for x in rows[0][2:]]
    stats = {norm(row[0]): dict(zip(stages, row[2:])) for row in rows[1:] if len(row) > 1 and norm(row[1]) == "total"}
    metrics = {}
    for metric, row in [("ttft", "ttft"), ("tpot", "tpot"), ("e2el", "e2el")]:
        for suffix, stage in [("Mean", "average"), ("P90", "p90"), ("P99", "p99")]:
            cell = stats.get(row, {}).get(stage)
            if cell:
                # Fail closed on a unit change; never mistake seconds for ms.
                if not cell.strip().endswith(" ms"):
                    raise ValueError(f"Unexpected {row}/{stage} unit")
                metrics[metric + suffix] = numeric(cell)
    aggregate = {}
    for line in (directory / "aisbench_client.log").read_text().splitlines():
        cells = [x.strip() for x in line.split("│")]
        if len(cells) >= 4 and norm(cells[2]) == "total" and cells[3]:
            name = norm(cells[1])
            name = {"successrequests": "successfulrequests", "totalgeneratedtokens": "totaloutputtokens"}.get(name, name)
            if name in {"outputtokenthroughput", "successfulrequests", "failedrequests", "totalinputtokens", "totaloutputtokens"}:
                if name == "outputtokenthroughput" and not cells[3].endswith(" token/s"):
                    raise ValueError("Unexpected throughput unit")
                aggregate[name] = numeric(cells[3])
    completed = aggregate.get("successfulrequests")
    if completed != workload["dataCount"] or aggregate.get("failedrequests") != 0:
        raise ValueError("Incomplete request workload or missing failure count")
    if aggregate.get("totalinputtokens") != workload["inputLength"] * workload["dataCount"] or aggregate.get("totaloutputtokens") != workload["outputLength"] * workload["dataCount"]:
        raise ValueError("Actual input/output token totals differ from synthetic workload, or are unavailable")
    throughput = aggregate.get("outputtokenthroughput")
    if not throughput or throughput <= 0:
        raise ValueError("Missing positive aggregate output throughput")
    metrics["outputThroughput"] = throughput
    metrics["completedRequests"] = completed
    return {"metrics": metrics, "aggregate": aggregate}


def render_config(config):
    endpoint = urlsplit(config["endpoint"])
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
        raise ValueError("Invalid inference endpoint")
    # Uses AISBench native VLLMCustomAPI/SyntheticDataset configuration;
    # Endpoint and credential are supplied by the instance owner.
    w = config["workload"]
    return f'''from ais_bench.benchmark.models import VLLMCustomAPI
from ais_bench.benchmark.datasets import SyntheticDataset, MATHEvaluator
from ais_bench.benchmark.openicl.icl_prompt_template import PromptTemplate
from ais_bench.benchmark.openicl.icl_retriever import ZeroRetriever
from ais_bench.benchmark.openicl.icl_inferencer import GenInferencer
from ais_bench.benchmark.summarizers import DefaultPerfSummarizer
from ais_bench.benchmark.calculators import DefaultPerfMetricCalculator
models = [dict(attr='service', type=VLLMCustomAPI, abbr='synthetic', path={config['tokenizerPath']!r},
    model={config['model']!r}, stream=True, request_rate={w['requestRate']}, use_timestamp=False, retry=2,
    api_key={config.get('apiKey', '')!r}, host_ip={endpoint.hostname!r}, host_port={endpoint.port},
    url={config['endpoint']!r}, max_out_len={w['outputLength']}, batch_size={w['concurrency']},
    trust_remote_code=False, generation_kwargs=dict(temperature=0.01, ignore_eos=True))]
synthetic_config = dict(Type='string', RequestCount={w['dataCount']}, TrustRemoteCode=False,
    StringConfig=dict(Input=dict(Method='uniform', Params=dict(MinValue={w['inputLength']}, MaxValue={w['inputLength'] + 1})),
                      Output=dict(Method='uniform', Params=dict(MinValue={w['outputLength']}, MaxValue={w['outputLength'] + 1}))))
datasets = [dict(abbr='synthetic', type=SyntheticDataset, config=synthetic_config,
    reader_cfg=dict(input_columns=['question', 'max_out_len'], output_column='answer'),
    infer_cfg=dict(prompt_template=dict(type=PromptTemplate, template='{{question}}'),
                   retriever=dict(type=ZeroRetriever), inferencer=dict(type=GenInferencer)),
    eval_cfg=dict(evaluator=dict(type=MATHEvaluator, version='v2')))]
summarizer = dict(attr='performance', type=DefaultPerfSummarizer,
    calculator=dict(type=DefaultPerfMetricCalculator, stats_list=['Average','Min','Max','Median','P90','P99']))
'''


def prepare_run(root, config):
    if importlib.metadata.version("ais-bench-benchmark") != config["aisbenchVersion"]:
        raise ValueError("AISBench version changed")
    run = root / "run"
    run.mkdir()
    (run / "settings.json").write_text(json.dumps(config))
    os.chmod(run / "settings.json", 0o600)
    return run, [config["pythonExecutable"], "-u", str(Path(__file__).resolve()), str(run)], {**os.environ, "PATH": str(Path(config["pythonExecutable"]).parent) + os.pathsep + os.environ.get("PATH", ""), "PYTHONUNBUFFERED": "1", "PYTHONHASHSEED": "0"}


def main(directory):
    config = json.loads((directory / "settings.json").read_text())
    cli = shutil.which("ais_bench")
    if not cli:
        raise ValueError("ais_bench is not in the selected Python environment PATH")
    configuration = directory / "config.py"
    configuration.write_text(render_config(config))
    os.chmod(configuration, 0o600)
    with (directory / "aisbench_client.log").open("w") as log:
        result = subprocess.run([cli, "--mode", "perf", "--num-warmups", str(config["workload"]["warmups"]), "--work-dir", str(directory / "outputs"), str(configuration)], stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"AISBench exited {result.returncode}; see aisbench_client.log")
    summary = parse_results(directory, config["workload"])
    metrics, aggregate = summary["metrics"], summary["aggregate"]
    row = {
        "total_req": aggregate["successfulrequests"], "failed_req": aggregate["failedrequests"],
        "total_input_tokens": aggregate["totalinputtokens"], "total_output_tokens": aggregate["totaloutputtokens"],
        "output_throughput": metrics["outputThroughput"],
        # Equal output lengths and verified totals make this aggregate rate exact.
        "qps": metrics["outputThroughput"] / config["workload"]["outputLength"],
    }
    for metric, column in [("ttftP90", "TTFT P90"), ("tpotP90", "TPOT SLO_P90"), ("e2elP90", "E2EL P90")]:
        if metric not in metrics:
            raise ValueError("Missing latency metric " + metric)
        row[column] = metrics[metric]
    with (directory / "aisbench_result.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(row))
        writer.writeheader()
        writer.writerow(row)



if __name__ == "__main__":
    main(Path(sys.argv[1]))
