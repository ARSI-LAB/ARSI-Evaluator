import importlib.util
import tempfile
import unittest
from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "src/plugins/benchmarks/operator/kernel/runtime/timing_evidence.py"
spec = importlib.util.spec_from_file_location("timing_evidence", path)
timing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(timing)

HEADER = "Step Id,Device_id,Stream ID,Name,Start Time(us),Duration(us)\n"

class TimingEvidenceTest(unittest.TestCase):
    def fixture(self):
        import json
        return json.loads((root / "tests/fixtures/kernel-timing-flow.json").read_text())

    def collect(self, csv=None, trace=None):
        fixture = self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "profile-reference"
            directory.mkdir()
            (directory / "kernel_details.csv").write_text(fixture['csv'] if csv is None else csv)
            (directory / "trace_view.json").write_text(fixture['trace'] if trace is None else trace)
            return timing.collect_flow_timing(directory, 1, 2)

    def test_uses_flow_identity_despite_wrong_csv_steps_and_variable_kernel_counts(self):
        result = self.collect()
        self.assertEqual(result['meanMs'], 0.03)
        self.assertEqual([r['step'] for r in result['rows']], [0, 1, 1, 2])
        self.assertEqual(result['tracePath'], 'profile-reference/trace_view.json')
        self.assertEqual(len(result['traceSha256']), 64)

    def test_supports_direct_and_queued_host_launch_flows(self):
        for key in ('traceHostDirect', 'traceHostQueued'):
            result = self.collect(trace=self.fixture()[key])
            self.assertEqual([r['step'] for r in result['rows']], [0, 1, 1, 2])

    def test_rejects_incomplete_ambiguous_or_conflicting_flow_evidence(self):
        import json
        fixture = self.fixture()
        original = json.loads(fixture['trace'])
        cases = [original[:-1], original + [original[0]], original + [original[-1]]]
        # A second distinct flow assigns the same kernel to a different CPU step.
        source, target = dict(original[-2]), dict(original[-1])
        source.update(id='conflict', ts=original[1]['ts']); target['id'] = 'conflict'
        cases.append(original + [source, target])
        for events in cases:
            with self.subTest(events=events), self.assertRaises(ValueError):
                self.collect(trace=json.dumps(events))

    def test_rejects_missing_flow_ids_and_mixed_device_trace_processes(self):
        import json
        for mode in ('missing-id', 'mixed-device'):
            events = json.loads(self.fixture()['trace'])
            if mode == 'missing-id':
                del events[4]['id']; del events[5]['id']
            else:
                events[3]['pid'] = 21; events[5]['pid'] = 21
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.collect(trace=json.dumps(events))

    def test_rejects_unrepresented_flow_target_without_task_type(self):
        import json
        fixture = self.fixture(); events = json.loads(fixture['trace'])
        for event in events:
            if event.get('name') == 'transpose': del event['args']['Task Type']
        csv = '\n'.join(line for line in fixture['csv'].splitlines() if ',transpose,' not in line) + '\n'
        with self.assertRaises(ValueError): self.collect(csv=csv, trace=json.dumps(events))

    def test_rejects_missing_duplicate_nonfinite_and_mixed_device_rows(self):
        fixture = self.fixture(); lines = fixture['csv'].splitlines()
        for csv in ['\n'.join(lines[:-1])+'\n', fixture['csv']+lines[-1]+'\n',
                    fixture['csv'].replace(',20\n', ',nan\n'), fixture['csv'].replace('1,0,43', '1,1,43')]:
            with self.subTest(csv=csv), self.assertRaises(ValueError): self.collect(csv=csv)


class TimerCaptureTest(unittest.TestCase):
    def test_timer_collects_framework_steps_and_excludes_only_warmup(self):
        self.run_capture(prepared=False)

    def test_prepared_capture_separates_restore_from_kernel_even_if_they_have_the_same_name(self):
        self.run_capture(prepared=True)

    def run_capture(self, prepared):
        import sys, types
        from unittest.mock import patch
        calls, steps, synchronizations, preparations = [], [], [], []
        pending_copies = []
        def synchronize():
            synchronizations.append(True)
            for value in pending_copies: value.append(7)
            pending_copies.clear()
        torch = types.SimpleNamespace(npu=types.SimpleNamespace(is_available=lambda: True,
            set_device=lambda _: None, synchronize=synchronize),
            cuda=types.SimpleNamespace(is_available=lambda: False))
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / "profile-reference"
            class Profile:
                def __init__(self, **kwargs):
                    self.kwargs = kwargs
                    self.index = 0
                def __enter__(self): return self
                def step(self): steps.append(self.index); self.index += 1
                def __exit__(self, *_):
                    self.kwargs['on_trace_ready'](self)
            def trace_handler(dir_name):
                def write_trace(profile):
                    self.assertEqual(profile.kwargs['schedule'], dict(wait=0, warmup=0, active=4 if prepared else 3, repeat=1))
                    # torch_npu requires CPU activity to emit framework Step Id associations.
                    self.assertIn(1, profile.kwargs['activities'])
                    self.assertIn(0, profile.kwargs['activities'])
                    import json
                    name = 'kernel-timing-prepared.json' if prepared else 'kernel-timing-flow.json'
                    fixture = json.loads((root / 'tests/fixtures' / name).read_text())
                    (directory / 'kernel_details.csv').write_text(fixture['csv'])
                    (directory / 'trace_view.json').write_text(json.dumps(fixture['trace']) if prepared else fixture['trace'])
                return write_trace
            profiler = types.SimpleNamespace(_ExperimentalConfig=lambda **_: None,
                AiCMetrics=types.SimpleNamespace(PipeUtilization=0), ProfilerLevel=types.SimpleNamespace(Level1=1),
                ProfilerActivity=types.SimpleNamespace(NPU=0, CPU=1), schedule=lambda **kwargs: kwargs,
                tensorboard_trace_handler=trace_handler, profile=Profile)
            with patch.dict(sys.modules, {'torch': torch, 'torch_npu': types.SimpleNamespace(profiler=profiler), 'timing_evidence': timing}):
                spec = importlib.util.spec_from_file_location('kernel_timer_test', path.with_name('timing.py'))
                timer = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(timer)
                audit = {}
                options = dict(warmup=1, active=1 if prepared else 2, prof_dir=str(directory), keep_res=True, audit=audit)
                if prepared:
                    def prepare():
                        preparations.append(len(steps))
                        value = []
                        pending_copies.append(value)
                        return value
                    def mutate(value):
                        self.assertEqual(value, [7], 'Device copy must complete before the invocation')
                        calls.append((len(steps), value.pop()))
                    result = timer.bench_prepared_kernel_ms(mutate, prepare, **options)
                    self.assertEqual(preparations, [0, 0, 2])
                    self.assertEqual(calls, [(0, 7), (1, 7), (3, 7)])
                    self.assertEqual(audit['stepLayout'], 'prepare-then-run')
                else:
                    result = timer.bench_kernel_ms(lambda: calls.append(True), **options)
                    self.assertEqual(len(calls), 4)
            self.assertEqual(steps, list(range(4 if prepared else 3)))
            self.assertGreaterEqual(len(synchronizations), 4)
            self.assertEqual(result, 0.004 if prepared else 0.03)
            self.assertEqual(audit['meanMs'], result)
            self.assertEqual([r['step'] for r in audit['rows']], [0, 1] if prepared else [0, 1, 1, 2])

if __name__ == "__main__": unittest.main()
