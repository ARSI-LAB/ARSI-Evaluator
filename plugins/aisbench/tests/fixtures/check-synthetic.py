import csv
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

e1 = module('synthetic', ROOT / 'runtime/synthetic.py')
WORKLOAD = dict(inputLength=4096, outputLength=2048, dataCount=1320, concurrency=330, requestRate=0, warmups=8)


class E1Tests(unittest.TestCase):
    def test_config_preserves_historical_protocol(self):
        config = e1.render_config(dict(endpoint='http://127.0.0.1:18080/v1', tokenizerPath='/models/fixed', model='served', apiKey="quote'\\", workload=WORKLOAD))
        compile(config, '<config>', 'exec')
        for required in ('VLLMCustomAPI', 'SyntheticDataset', 'batch_size=330', 'RequestCount=1320', 'temperature=0.01', 'ignore_eos=True', 'MaxValue=4097', 'host_port=18080'):
            self.assertIn(required, config)
        self.assertNotIn('Chat', config)
        other = e1.render_config(dict(endpoint='https://example.org', tokenizerPath='/model', model='served', workload={**WORKLOAD, 'concurrency': 7}))
        self.assertIn('batch_size=7', other)
        self.assertIn('host_port=443', other)
        plain = e1.render_config(dict(endpoint='http://example.org/v1', tokenizerPath='/model', model='served', workload=WORKLOAD))
        self.assertIn('host_port=80', plain)

    def test_complete_summary_and_reject_partial_or_wrong_units(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); (root / 'outputs').mkdir()
            path = root / 'outputs/summary.csv'
            rows = [['Performance Parameters', 'Stage', 'Average', 'P90', 'P99', 'N'], ['TTFT', 'total', '12 ms', '16 ms', '20 ms', '1320'], ['TPOT', 'total', '2 ms', '3 ms', '4 ms', '1320']]
            with path.open('w') as output: csv.writer(output).writerows(rows)
            totals = {'Output Token Throughput': 1000, 'Success Requests': 1320, 'Failed Requests': 0, 'Total Input Tokens': 5406720, 'Total Generated Tokens': 2703360}
            def logs(): (root / 'aisbench_client.log').write_text('\n'.join(f'│ {key} │ total │ {str(value) + (" token/s" if key == "Output Token Throughput" else "")} │' for key, value in totals.items()))
            logs(); result = e1.parse_results(root, WORKLOAD)
            self.assertEqual(result['metrics']['outputThroughput'], 1000)
            self.assertEqual(result['metrics']['tpotP90'], 3)
            totals['Total Generated Tokens'] = 10; logs()
            with self.assertRaisesRegex(ValueError, 'token totals'): e1.parse_results(root, WORKLOAD)
            totals['Total Generated Tokens'] = 2703360; totals['Success Requests'] = 1319; logs()
            with self.assertRaisesRegex(ValueError, 'Incomplete'): e1.parse_results(root, WORKLOAD)
            totals['Success Requests'] = 1320; logs()
            rows[1][2] = '0.012 s'
            with path.open('w') as output: csv.writer(output).writerows(rows)
            with self.assertRaisesRegex(ValueError, 'unit'): e1.parse_results(root, WORKLOAD)

    def test_aisbench_exit_code_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            with (Path(temp) / 'client.log').open('w') as log:
                code = e1.run_aisbench([sys.executable, '-c', 'raise SystemExit(7)'], log)
            self.assertEqual(code, 7)

    @unittest.skipUnless(os.name == 'posix', 'POSIX signal semantics are required')
    def test_cancel_is_forwarded_to_aisbench_child(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            ready, stopped, log = root / 'ready', root / 'stopped', root / 'client.log'
            child = root / 'child.py'
            child.write_text(
                'import pathlib, signal, sys, time\n'
                'signal.signal(signal.SIGTERM, lambda *_: (pathlib.Path(sys.argv[2]).write_text("stopped"), sys.exit(0)))\n'
                'pathlib.Path(sys.argv[1]).write_text("ready")\n'
                'while True: time.sleep(1)\n'
            )
            wrapper = (
                'import importlib.util, signal, sys\n'
                'signal.signal(signal.SIGTERM, signal.SIG_DFL)\n'
                'spec = importlib.util.spec_from_file_location("synthetic", sys.argv[1])\n'
                'module = importlib.util.module_from_spec(spec)\n'
                'spec.loader.exec_module(module)\n'
                'with open(sys.argv[5], "w") as output:\n'
                '    raise SystemExit(module.run_aisbench([sys.executable, sys.argv[2], sys.argv[3], sys.argv[4]], output))\n'
            )
            process = subprocess.Popen(
                [sys.executable, '-c', wrapper, str(ROOT / 'runtime/synthetic.py'),
                 str(child), str(ready), str(stopped), str(log)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    time.sleep(.05)
                else:
                    self.fail('AISBench child did not start')
                process.terminate()
                process.wait(timeout=5)
                self.assertTrue(stopped.exists(), process.stdout.read())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()



if __name__ == '__main__': unittest.main()
