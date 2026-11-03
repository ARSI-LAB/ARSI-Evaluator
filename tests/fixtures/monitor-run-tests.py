import importlib.util
import json
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('monitor_run', Path(__file__).resolve().parents[2] / 'scripts/monitor-run.py')
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'errors').mkdir()
        self.run = self.root / 'results/run-id'
        self.run.mkdir(parents=True)
        monitor.atomic_json(self.run / 'manifest.json', {'taskIds': ['zero', 'gpu', 'broken'], 'status': 'running', 'startedAt': '2026-10-14'})

    def record(self, task, status, score, errors):
        attempt = self.run / 'tasks' / task / 'attempts/one'
        attempt.mkdir(parents=True)
        monitor.atomic_json(attempt / 'allocation.json', {'ordinal': 1, 'key': {'taskId': task}})
        monitor.atomic_json(attempt / 'result.json', {'status': status, 'scoreStatus': score, 'errors': errors,
            'verdict': {'score': 0, 'passed': False} if score == 'valid' else None,
            'solve': {'usage': {'totalTokens': 10}} if score == 'valid' else None})

    def test_valid_zero_is_not_failure_and_errors_are_redacted(self):
        self.record('zero', 'completed', 'valid', [])
        self.record('gpu', 'unsupported', 'invalid', [{'code': 'BENCHMARK_UNSUPPORTED', 'message': 'GPU unavailable'}])
        self.record('broken', 'error', 'invalid', [{'code': 'ENV_IMAGE_BUILD_FAILED', 'message': 'secret-fixture-token'}])
        seen = set()
        summary, packets = monitor.snapshot(self.root, self.root / 'repo', self.root / 'full.yaml', 3, ['secret-fixture-token'], seen)
        self.assertEqual(summary['valid'], 1)
        self.assertEqual(summary['terminal'], 3)
        self.assertEqual(summary['tokens']['knownTotal'], 10)
        self.assertEqual(len(packets), 2)
        evidence = '\n'.join(p.read_text() for p in (self.root / 'errors').glob('*/error.json'))
        self.assertNotIn('secret-fixture-token', evidence)
        self.assertIn('[REDACTED]', evidence)
        self.assertIn('hardware_unavailable', evidence)
        self.assertNotIn('"taskId": "zero"', evidence)
        self.assertFalse(monitor.snapshot(self.root, self.root / 'repo', self.root / 'full.yaml', 3, [], seen)[1])

    def test_stale_heartbeat_is_deferred_without_terminating_processes(self):
        monitor.atomic_json(self.root / 'run.heartbeat.json', {'updatedAtEpoch': time.time() - 1000, 'pid': 123})
        summary, _ = monitor.snapshot(self.root, self.root / 'repo', self.root / 'full.yaml', 3, [], set())
        self.assertTrue(summary['heartbeatStale'])
        self.assertTrue((self.root / 'errors/coordinator-unresponsive.json').is_file())

    def test_exit_without_full_coverage_is_not_success(self):
        monitor.atomic_json(self.root / 'run.exit.json', {'exitCode': 0})
        summary, _ = monitor.snapshot(self.root, self.root / 'repo', self.root / 'full.yaml', 3, [], set())
        self.assertTrue(summary['finished'])
        self.assertFalse(summary['completeCoverage'])
        self.assertTrue((self.root / 'errors/run-failure.json').is_file())

    def test_explicit_run_directory_never_reports_another_experiment(self):
        target = self.root / 'results-deepseek-verified/new-run'
        target.mkdir(parents=True)
        monitor.atomic_json(target / 'manifest.json', {'runId': 'new-run', 'taskIds': [], 'status': 'running'})
        summary, _ = monitor.snapshot(self.root, self.root / 'repo', self.root / 'new.yaml', 3, [], set(), target)
        self.assertEqual(summary['runId'], 'new-run')
        self.assertEqual(summary['terminal'], 0)
        target.joinpath('manifest.json').unlink()
        summary, _ = monitor.snapshot(self.root, self.root / 'repo', self.root / 'new.yaml', 3, [], set(), target)
        self.assertNotIn('runId', summary)

    def test_invalid_terminal_tasks_do_not_count_as_complete_scoring(self):
        self.record('zero', 'completed', 'valid', [])
        self.record('gpu', 'unsupported', 'invalid', [{'code': 'BENCHMARK_UNSUPPORTED'}])
        self.record('broken', 'invalid', 'invalid', [{'code': 'ENV_IMAGE_PULL_TIMEOUT'}])
        monitor.atomic_json(self.root / 'run.exit.json', {'exitCode': 0})
        summary, _ = monitor.snapshot(self.root, self.root / 'repo', self.root / 'full.yaml', 3, [], set())
        self.assertEqual(summary['terminal'], 3)
        self.assertEqual(summary['valid'], 1)
        self.assertFalse(summary['completeCoverage'])

    def test_failure_packet_preserves_actual_resume_command_and_current_log(self):
        self.record('broken', 'invalid', 'invalid', [{'code': 'ENV_IMAGE_PULL_TIMEOUT'}])
        command = ['node', 'cli-runtime.js', 'run', 'new.yaml', '--resume', 'run-id']
        monitor.atomic_json(self.root / 'command.json', {'argv': command})
        (self.root / 'run.log').write_text('current failure evidence')
        _, packets = monitor.snapshot(self.root, self.root / 'repo', self.root / 'new.yaml', 3, [], set())
        packet_path = Path(packets[0]['packet'])
        packet = monitor.read_json(packet_path)
        self.assertEqual(packet['testCommand'], command)
        self.assertEqual(packet['retryCommand'], command)
        self.assertEqual((packet_path.parent / 'run-tail.log').read_text(), 'current failure evidence')


if __name__ == '__main__':
    unittest.main()
