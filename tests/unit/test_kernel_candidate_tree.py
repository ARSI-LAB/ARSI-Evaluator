"""CPU checks for the same declared candidate tree in precision, strict timing and replay."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

runtime = Path(__file__).resolve().parents[2] / 'src/plugins/benchmarks/operator/kernel/runtime'
sys.path.insert(0, str(runtime))
import precision
import msprof_replay
import strict as strict_worker
from test_kernel_strict import Tensor


class CandidateTreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidate_root = self.root / 'candidate'
        files = {
            'problem.py': 'from kernel_tree_fixture import Model, input_value\nget_inputs = lambda: [input_value()]\n',
            'candidate/tree_root.py': 'from kernel_tree_fixture import output_value\ndef run(x): return output_value()\n',
            'candidate/kernels/__init__.py': '',
            'candidate/kernels/tiling.py': 'from tree_root import run\n',
            'candidate/kernels/problem.py': 'from .tiling import run\ndef kernel_function(x): return run(x)\n',
        }
        self.hashes = {}
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            self.hashes[str(path)] = hashlib.sha256(content.encode()).hexdigest()
        self.request = {'hashes': self.hashes, 'problem': str(self.root / 'problem.py'),
            'candidate': str(self.candidate_root / 'kernels/problem.py'), 'dataRoot': str(self.root),
            'candidateRoot': str(self.candidate_root), 'seeds': [42], 'warmup': 2, 'repeat': 3,
            'rtol': 0, 'atol': 0, 'outputIndices': None, 'inputUnmodified': True}
        self.calls = []
        def output_value():
            self.calls.append('output')
            return Tensor([1], len(self.calls) + 10)
        class Model:
            def to(self, _): return self
            def eval(self): return self
            def __call__(self, _): return output_value()
        self.fixture = types.SimpleNamespace(Model=Model, input_value=lambda: Tensor([1], 1), output_value=output_value)
        self.torch = types.SimpleNamespace(Tensor=Tensor, __version__='fixture', manual_seed=lambda _: None,
            inference_mode=contextlib.nullcontext, npu=types.SimpleNamespace(is_available=lambda: True,
                set_device=lambda _: None, manual_seed_all=lambda _: None, synchronize=lambda: None,
                current_device=lambda: 0, device_count=lambda: 1, get_device_name=lambda _: 'fixture'))
        self.timer = types.SimpleNamespace(bench_kernel_ms=lambda run, **_: (run(), 1)[1])
        self.mstx = types.SimpleNamespace(get_tool_id=lambda: 4097, range_start=lambda *_: 0, range_end=lambda _: None)

    @contextlib.contextmanager
    def workers(self):
        saved_path = sys.path[:]
        original = precision.load_module
        def load(path, name):
            return self.timer if str(path).endswith('timing.py') else original(path, name)
        try:
            with patch.dict(sys.modules, {'torch': self.torch, 'torch_npu': types.SimpleNamespace(__version__='fixture'),
                                         'mstx': self.mstx, 'kernel_tree_fixture': self.fixture}), \
                 patch.object(precision, 'load_module', side_effect=load), \
                 patch.object(precision, 'clone_tree', side_effect=lambda value, _: copy.deepcopy(value)), \
                 patch.object(precision, 'validate_reference'), patch.object(precision, 'compare_tree'):
                yield
        finally:
            sys.path[:] = saved_path
            for name, module in list(sys.modules.items()):
                origin = getattr(module, '__file__', '')
                if name.startswith('_kernel_task') or origin and str(origin).startswith(str(self.root)):
                    sys.modules.pop(name, None)

    def test_precision_and_strict_load_nested_relative_and_root_helpers_with_same_reference_basename(self):
        for strict in (False, True):
            with self.subTest(strict=strict), self.workers():
                request = copy.deepcopy(self.request)
                if strict:
                    tensor = {'shape': [1], 'dtype': 'float16', 'contiguous': True}
                    request.update(contractSha256='fixture', contract={'inputs': [tensor],
                        'output': {**tensor, 'independent': True}, 'inputUnmodified': True})
                    request['_assessment'] = strict_worker.new_assessment(request)
                result = precision.evaluate(request, self.root)
                self.assertEqual(result['status'], 'passed')
                self.assertEqual(result['candidateMs'], 1)

    def strict_request(self, operation):
        request = copy.deepcopy(self.request)
        tensor = {'shape': [1], 'dtype': 'float16', 'contiguous': True}
        request.update(operation=operation, candidateSha256='candidate-fixture', referenceKind='eager',
            contractSha256='fixture', contract={'inputs': [tensor],
                'output': {**tensor, 'independent': True}, 'inputUnmodified': True})
        return request

    def run_main(self, request):
        output = self.root / 'result.json'
        with patch.object(sys, 'argv', ['precision.py', '--output', str(output)]), \
             patch.object(sys, 'stdin', io.StringIO(json.dumps(request))), \
             patch.object(sys, 'stdout', io.StringIO()), \
             patch.object(sys, 'stderr', io.StringIO()), \
             patch.object(precision, 'native_output', side_effect=lambda _: contextlib.nullcontext()):
            precision.main()
        return json.loads(output.read_text())

    def test_missing_operation_retains_evaluate_and_source_identity(self):
        request = self.strict_request('evaluate')
        del request['operation']
        with self.workers(): result = self.run_main(request)
        self.assertEqual(result['operation'], 'evaluate')
        self.assertEqual(result['candidateSha256'], 'candidate-fixture')
        self.assertEqual(result['referenceKind'], 'eager')
        self.assertEqual(result['status'], 'passed', result)
        self.assertEqual(result['timingScope'], 'all-device-kernels')
        self.assertEqual([result[key] for key in ('referenceMs', 'candidateMs', 'speedup')], [1, 1, 1])

    def test_operations_reject_locked_helper_changes_before_executing_candidate(self):
        helper = self.candidate_root / 'kernels/tiling.py'
        helper.write_text('# changed before execution\n')
        for operation in ('evaluate', 'precision', 'bench'):
            with self.subTest(operation=operation), self.workers():
                result = self.run_main(self.strict_request(operation))
                self.assertEqual(result['status'], 'infrastructure_error', result)
                self.assertIsNone(result['candidateMs'])
        self.assertEqual(self.calls, [])

    def test_non_strict_precision_rejects_wrong_output_and_input_mutation_without_timing(self):
        candidate = self.candidate_root / 'kernels/problem.py'
        candidate.write_text('from kernel_tree_fixture import run_candidate\ndef kernel_function(x): return run_candidate(x)\n')
        self.hashes[str(candidate)] = hashlib.sha256(candidate.read_bytes()).hexdigest()
        def tensor(value):
            result = Tensor([1], 1)
            result.values = [value]
            return result
        self.fixture.input_value = lambda: tensor(7)
        class Model:
            def to(self, _): return self
            def eval(self): return self
            def __call__(self, _): return tensor(7)
        self.fixture.Model = Model
        def compare(left, right, *_):
            if isinstance(left, (list, tuple)):
                for a, b in zip(left, right): compare(a, b)
            else:
                if left.values != right.values: raise AssertionError('Tensor values changed')
        for defect in ('numerical', 'mutation'):
            with self.subTest(defect=defect):
                def run_candidate(value):
                    if defect == 'mutation': value.values[0] = 9
                    return tensor(9 if defect == 'numerical' else 7)
                self.fixture.run_candidate = run_candidate
                request = {**self.request, 'operation': 'precision',
                    'candidateSha256': 'candidate-fixture', 'referenceKind': 'eager'}
                self.timer.bench_kernel_ms = lambda *_args, **_kwargs: self.fail('incorrect precision must not time')
                with self.workers(), patch.object(precision, 'compare_tree', side_effect=compare):
                    result = self.run_main(request)
                self.assertEqual(result['status'], 'incorrect', result)
                self.assertIsNone(result['candidateMs'])

    def test_precision_runs_all_correctness_cases_without_loading_timer(self):
        for strict in (False, True):
            with self.subTest(strict=strict), self.workers():
                request = self.strict_request('precision') if strict else {
                    **self.request, 'operation': 'precision', 'candidateSha256': 'candidate-fixture', 'referenceKind': 'eager'}
                request['seeds'] = [3, 7]
                original = precision.load_module
                def no_timer(path, name):
                    if Path(path).name == 'timing.py': raise AssertionError('precision must not load timer')
                    return original(path, name)
                self.calls.clear()
                with patch.object(precision, 'load_module', side_effect=no_timer):
                    result = self.run_main(request)
                self.assertEqual(result['status'], 'passed', result)
                self.assertEqual(result['operation'], 'precision')
                self.assertEqual(len(self.calls), 6)
                self.assertEqual([result[key] for key in ('referenceMs', 'candidateMs', 'speedup')], [None, None, None])
                self.assertNotIn('timingEvidence', result)
                if strict: self.assertTrue(all(c['status'] == 'passed' for c in result['assessment']['checks']))

    def test_bench_skips_reference_and_checks_and_retains_tree_profile(self):
        def forbidden(*_): raise AssertionError('bench must not execute reference or correctness checks')
        self.fixture.Model = forbidden
        self.fixture.get_init_inputs = forbidden
        request = self.strict_request('bench')
        request['seeds'] = [7, 11]
        self.fixture.input_value = lambda: Tensor([1], 1)
        seeds, options = [], []
        def bench(run, **kwargs):
            options.append(kwargs)
            for _ in range(kwargs['warmup'] + kwargs['active']): run()
            return 0.5
        self.timer.bench_kernel_ms = bench
        self.torch.manual_seed = seeds.append
        with self.workers(), patch.object(precision, 'compare_tree', side_effect=forbidden), \
             patch.object(strict_worker, 'new_assessment', side_effect=forbidden):
            result = self.run_main(request)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(result['operation'], 'bench')
        self.assertEqual(result['candidateMs'], 0.5)
        self.assertEqual(result['timingScope'], 'triton-kernels')
        self.assertEqual([result[key] for key in ('referenceMs', 'speedup')], [None, None])
        self.assertNotIn('assessment', result)
        self.assertEqual(seeds, [7])
        self.assertEqual(len(self.calls), 5)
        self.assertEqual(options, [dict(warmup=2, active=3,
            prof_dir=str(self.root / 'profile-candidate'), keep_res=True, triton_only=True)])

    def test_mutable_bench_prepares_fresh_inputs_for_every_invocation(self):
        request = self.strict_request('bench')
        request['contract']['inputUnmodified'] = False
        source = Tensor([1], 1)
        source.values = [7]
        self.fixture.input_value = lambda: source
        seen = []
        def mutate(value):
            seen.append(value.values.pop())
            return Tensor([1], 2)
        candidate = self.candidate_root / 'kernels/problem.py'
        candidate.write_text('from kernel_tree_fixture import mutate\ndef kernel_function(x): return mutate(x)\n')
        self.fixture.mutate = mutate
        self.hashes[str(candidate)] = hashlib.sha256(candidate.read_bytes()).hexdigest()
        request['hashes'] = self.hashes
        def bench_prepared(run, prepare, **kwargs):
            self.assertTrue(kwargs['triton_only'])
            kwargs['audit']['stepLayout'] = 'prepare-then-run'
            for _ in range(kwargs['warmup'] + kwargs['active']): run(prepare())
            return 0.25
        self.timer.bench_prepared_kernel_ms = bench_prepared
        self.timer.bench_kernel_ms = lambda *_args, **_kwargs: self.fail('mutable bench must use prepared inputs')
        with self.workers(): result = self.run_main(request)
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(seen, [7] * 5)
        self.assertEqual(source.values, [7])

    def test_all_operations_recheck_source_bytes_after_execution(self):
        helper = self.candidate_root / 'kernels/tiling.py'
        content = helper.read_text()
        original = self.fixture.output_value
        for operation in ('evaluate', 'precision', 'bench'):
            with self.subTest(operation=operation):
                helper.write_text(content)
                def tamper():
                    helper.write_text('# changed during execution\n')
                    return original()
                self.fixture.output_value = tamper
                with self.workers(): result = self.run_main(self.strict_request(operation))
                self.assertEqual(result['status'], 'infrastructure_error', result)
                self.assertIn('Locked source', result['error'])
                self.assertIsNone(result['candidateMs'])
                self.assertIsNone(result['referenceMs'])

    def test_bench_errors_never_publish_a_duration(self):
        for failure, status in ((TypeError('candidate failure'), 'candidate_error'),
                                (float('inf'), 'infrastructure_error')):
            with self.subTest(failure=failure):
                if isinstance(failure, Exception):
                    def fail(error=failure): raise error
                    self.fixture.output_value = fail
                    self.timer.bench_kernel_ms = lambda run, **_: (run(), 1)[1]
                else:
                    self.timer.bench_kernel_ms = lambda *_args, **_kwargs: failure
                with self.workers(): result = self.run_main(self.strict_request('bench'))
                self.assertEqual(result['status'], status, result)
                self.assertIsNone(result['candidateMs'])
                self.assertNotIn('assessment', result)

    def test_msprof_replay_executes_the_same_tree(self):
        with self.workers(), patch.object(msprof_replay, 'observe_environment', return_value={}), \
             patch.object(msprof_replay, 'clone_tree', side_effect=lambda value, _: copy.deepcopy(value)):
            result = msprof_replay.replay(self.request)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(result['capture']['warmupCompleted'], 2)

    def test_changed_missing_and_symlink_helpers_fail_before_execution(self):
        helper = self.candidate_root / 'kernels/tiling.py'
        for mutation in ('changed', 'missing', 'symlink'):
            with self.subTest(mutation=mutation):
                helper.unlink(missing_ok=True)
                if mutation == 'changed': helper.write_text('changed')
                if mutation == 'symlink':
                    target = self.root / 'same-bytes.py'
                    target.write_text('from tree_root import run\n')
                    helper.symlink_to(target)
                with self.assertRaises((RuntimeError, FileNotFoundError)):
                    precision.verify_hashes(self.hashes)
        self.assertEqual(self.calls, [])

    def test_replay_preserves_nested_reference_import_root_and_checks_its_helper_bytes(self):
        reference = self.root / 'refs/pkg/problem.py'
        reference.parent.mkdir(parents=True)
        sources = {
            'refs/__init__.py': '', 'refs/pkg/__init__.py': '',
            'refs/inputs.py': 'from kernel_tree_fixture import input_value\ndef make_inputs(): return [input_value()]\n',
            'refs/pkg/problem.py': 'from kernel_tree_fixture import Model\nfrom ..inputs import make_inputs\nget_inputs = make_inputs\n',
        }
        for name, content in sources.items():
            path = self.root / name
            path.write_text(content)
            self.hashes[str(path)] = hashlib.sha256(content.encode()).hexdigest()
        self.request['problem'] = str(reference)
        with self.workers(), patch.object(msprof_replay, 'observe_environment', return_value={}):
            result = msprof_replay.replay(self.request)
            self.assertEqual(result['capture']['callsInRange'], 1)
        helper = self.root / 'refs/inputs.py'
        original_input = self.fixture.input_value
        def change_reference():
            helper.write_text('# changed after initial replay verification\n')
            return original_input()
        self.fixture.input_value = change_reference
        with self.workers(), patch.object(msprof_replay, 'observe_environment', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'Locked source changed'):
                msprof_replay.replay(self.request)


if __name__ == '__main__': unittest.main()
