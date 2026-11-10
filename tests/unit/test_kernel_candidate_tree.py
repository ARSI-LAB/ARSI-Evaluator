"""CPU checks for the same declared candidate tree in precision, strict timing and replay."""
import contextlib
import copy
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

runtime = Path(__file__).resolve().parents[2] / 'src/adapters/kernel'
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
            'rtol': 0, 'atol': 0, 'outputIndices': None}
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
        self.timer = types.SimpleNamespace(IS_NPU=True, bench_kernel_ms=lambda run, **_: (run(), 1)[1])
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
