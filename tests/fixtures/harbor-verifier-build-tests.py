"""Controlled Git failures and frozen-runtime install protocol; no network or Docker."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verifier_build", sys.argv.pop(1))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
COMMIT = "a" * 40


class VerifierBuildTests(unittest.TestCase):
    def test_command_timeouts_and_nonzero_exits_propagate(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            build.run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.05)
        with self.assertRaises(subprocess.CalledProcessError):
            build.run_bounded([sys.executable, "-c", "raise SystemExit(7)"], timeout=5)

    def test_locked_harbor_uses_the_commit_not_a_mutable_tag(self):
        lock = {"package": [{"name": "harbor", "source": {"git": "https://github.com/harbor-framework/harbor.git?tag=v0.18.0#" + COMMIT}}]}
        self.assertEqual(build.locked_harbor(lock), ("https://github.com/harbor-framework/harbor.git", COMMIT))
        lock["package"][0]["source"]["git"] = "https://github.com/harbor-framework/harbor.git?tag=main"
        with self.assertRaises(ValueError):
            build.locked_harbor(lock)

    def test_git_mirror_and_transient_timeout_preserve_the_pinned_checkout(self):
        calls, sleeps = [], []
        def run(args, **options):
            calls.append((args, options))
            if "fetch" in args and sum("fetch" in call[0] for call in calls) < 3:
                raise subprocess.TimeoutExpired(args, options["timeout"])
        with patch.dict(os.environ, {"EVALUATOR_GITHUB_MIRROR": "https://git.example/https://github.com/"}):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=run, sleep=sleeps.append)
        self.assertEqual(sleeps, [2, 4])
        self.assertEqual([call[0][-1] for call in calls if "fetch" in call[0]], [COMMIT] * 3)
        self.assertTrue(all(call[1]["timeout"] == 120 for call in calls if "fetch" in call[0]))
        self.assertTrue(all(call[1]["env"]["GIT_TERMINAL_PROMPT"] == "0" for call in calls if "fetch" in call[0]))
        self.assertIn("https://git.example/https://github.com/Tencent/workbuddy-bench.git", calls[1][0])
        self.assertEqual(calls[-1][0][-3:], ["checkout", "--detach", COMMIT])

    def test_git_stops_after_three_failed_attempts(self):
        attempts = []
        def run(args, **options):
            if "fetch" in args:
                attempts.append(args)
                raise subprocess.CalledProcessError(128, args)
        with self.assertRaises(subprocess.CalledProcessError):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=run, sleep=lambda _: None)
        self.assertEqual(len(attempts), 3)

    def test_git_rejects_credentials_and_mutable_revisions_before_running(self):
        calls = []
        with patch.dict(os.environ, {"EVALUATOR_GITHUB_MIRROR": "https://user:secret@git.example/"}):
            with self.assertRaisesRegex(ValueError, "credential-free"):
                build.fetch_checkout(build.WORKBUDDY_REPOSITORY, COMMIT, Path("fixture"), run=lambda *args, **kwargs: calls.append(args))
        with self.assertRaises(ValueError):
            build.fetch_checkout(build.WORKBUDDY_REPOSITORY, "main", Path("fixture"), run=lambda *args, **kwargs: calls.append(args))
        self.assertEqual(calls, [])

    def test_install_uses_locked_hashes_and_the_selected_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "uv.lock").write_bytes(b"locked input")
            calls = []
            with patch.dict(os.environ, {"PIP_INDEX_URL": "https://python.example/simple"}):
                build.install_dependencies(root, root / "harbor", run=lambda args, **options: calls.append((args, options)))
            self.assertIn("--frozen", calls[0][0])
            self.assertIn("--offline", calls[0][0])
            installs = [call for call in calls if "install" in call[0]]
            self.assertIn("--require-hashes", installs[0][0])
            self.assertTrue(all("--no-deps" in call[0] and "https://python.example/simple" in call[0] for call in installs))
            self.assertEqual((root / "uv.lock").read_bytes(), b"locked input")

    def test_a_changed_dependency_lock_fails_the_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "uv.lock").write_bytes(b"locked input")
            def run(args, **options):
                (root / "uv.lock").write_bytes(b"changed input")
            with patch.dict(os.environ, {"PIP_INDEX_URL": "https://python.example/simple"}):
                with self.assertRaisesRegex(RuntimeError, "changed the upstream dependency lock"):
                    build.install_dependencies(root, root / "harbor", run=run)


unittest.main()
