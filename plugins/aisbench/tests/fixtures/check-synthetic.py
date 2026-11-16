import csv
import importlib.util
import json
from pathlib import Path
import tempfile
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
        for required in ('VLLMCustomAPI', 'SyntheticDataset', 'batch_size=330', 'RequestCount=1320', 'temperature=0.01', 'ignore_eos=True', 'MaxValue=4097'):
            self.assertIn(required, config)
        self.assertNotIn('Chat', config)
        other = e1.render_config(dict(endpoint='https://example.org', tokenizerPath='/model', model='served', workload={**WORKLOAD, 'concurrency': 7}))
        self.assertIn('batch_size=7', other)

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



if __name__ == '__main__': unittest.main()
