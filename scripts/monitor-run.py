#!/usr/bin/env python3
"""Observe persisted evaluator results without model calls or changing the run."""
import argparse
import collections
import hashlib
import json
import os
import time
from pathlib import Path


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.replace(temporary, path)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, '[REDACTED]')
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, secrets) for key, item in value.items()}
    return value


def tail(path, limit=24000):
    try:
        with path.open('rb') as stream:
            stream.seek(0, 2)
            size = stream.tell()
            stream.seek(max(0, size - limit))
            return stream.read(limit).decode('utf-8', errors='replace')
    except FileNotFoundError:
        return ''


def snapshot(root, repo, config, expected, secrets, seen, run_directory=None):
    paths = [run_directory / 'manifest.json'] if run_directory is not None else (root / 'results').glob('*/manifest.json')
    manifests = [(path, read_json(path)) for path in paths]
    manifests = [(path, value) for path, value in manifests if isinstance(value, dict)]
    receipt = read_json(root / 'run.exit.json')
    heartbeat = read_json(root / 'run.heartbeat.json')
    latest = max(manifests, key=lambda item: item[1].get('startedAt', ''), default=None)
    summary = {'state': 'starting', 'expectedTasks': expected, 'terminal': 0, 'valid': 0, 'passed': 0,
               'statuses': {}, 'failures': {}, 'tokens': {'knownTotal': 0, 'coveredAttempts': 0},
               'projectPath': str(repo), 'configPath': str(config), 'updatedAtEpoch': time.time(),
               'automaticModelCalls': False}
    packets = []
    if latest:
        manifest_path, manifest = latest
        run = manifest_path.parent
        ids = manifest.get('taskIds', [])
        summary.update({'runDirectory': str(run), 'runId': manifest.get('runId', run.name),
                        'selectedTasks': len(ids), 'state': manifest.get('status', 'unknown')})
        allocations = {}
        all_attempts = []
        for path in run.glob('tasks/*/attempts/*/allocation.json'):
            allocation = read_json(path)
            if not allocation:
                continue
            task = allocation['key']['taskId']
            ordinal = allocation['ordinal']
            if task not in allocations or ordinal > allocations[task][0]:
                allocations[task] = (ordinal, path.parent)
            record = read_json(path.parent / 'result.json')
            if record:
                all_attempts.append(record)
        statuses, failures = collections.Counter(), collections.Counter()
        for task in ids:
            attempt = allocations.get(task)
            record = read_json(attempt[1] / 'result.json') if attempt else None
            if not record:
                statuses['pending'] += 1
                continue
            statuses[record.get('status', 'unknown')] += 1
            summary['terminal'] += 1
            if record.get('scoreStatus') == 'valid':
                summary['valid'] += 1
                summary['passed'] += int(bool((record.get('verdict') or {}).get('passed')))
                if not record.get('errors') and record.get('cleanupStatus') != 'unconfirmed':
                    continue  # A valid zero is a scored answer, not an infrastructure failure.
            for failure in record.get('errors', []):
                failures[failure.get('code', 'UNKNOWN')] += 1
            identity = str(attempt[1])
            if identity not in seen:
                seen.add(identity)
                key = hashlib.sha256(identity.encode()).hexdigest()[:24]
                error_dir = root / 'errors' / key
                error_dir.mkdir(parents=True, exist_ok=True)
                message = json.dumps(record.get('errors', []))
                hardware = record.get('status') == 'unsupported' and any(word in message.lower() for word in ['gpu', 'hardware'])
                command_receipt = read_json(root / 'command.json') or read_json(root / 'run.command.json') or {}
                test_command = command_receipt.get('argv') or command_receipt.get('command') or ['node', str(repo / 'dist/cli-runtime.js'), 'run', str(config)]
                launcher = test_command
                packet = {'kind': 'hardware_unavailable' if hardware else 'task_failure', 'taskId': task,
                          'status': record.get('status'), 'failures': record.get('errors', []),
                          'projectPath': str(repo), 'attemptPath': str(attempt[1]),
                          'testCommand': test_command, 'launchCommand': launcher,
                          'modelCredentialsFile': str(root / '.credentials/model.json'),
                          'runDirectory': str(run), 'action': 'deferred; no automatic Codex invocation',
                          'retryCommand': launcher if '--resume' in launcher else [*launcher, '--resume', run.name]}
                atomic_json(error_dir / 'error.json', redact(packet, secrets))
                log_path = root / 'run.log' if (root / 'run.log').is_file() else root / 'logs/run.log'
                (error_dir / 'run-tail.log').write_text(redact(tail(log_path), secrets))
                for filename in ['compose-solve.log', 'compose-verify.log', 'agent/runner-stderr.log', 'agent/stderr.log', 'agent/mcp.log', 'verifier/test-stderr.txt']:
                    content = tail(attempt[1] / filename)
                    if content:
                        (error_dir / filename.replace('/', '-')).write_text(redact(content, secrets))
                packets.append({'taskId': task, 'packet': str(error_dir / 'error.json')})
        summary['statuses'], summary['failures'] = dict(statuses), dict(failures)
        for record in all_attempts:
            usage = (record.get('solve') or {}).get('usage') or {}
            total = usage.get('totalTokens')
            if isinstance(total, (int, float)):
                summary['tokens']['knownTotal'] += total
                summary['tokens']['coveredAttempts'] += 1
        summary['validCoverage'] = summary['valid'] / expected if expected else None
        summary['unscored'] = len(ids) - summary['valid']
        if len(ids) != expected:
            summary['selectionMismatch'] = True
    if heartbeat and time.time() - heartbeat.get('updatedAtEpoch', 0) > 180 and not receipt:
        summary['heartbeatStale'] = True
        packet = {'kind': 'coordinator_unresponsive', 'projectPath': str(repo),
                  'heartbeat': heartbeat, 'action': 'deferred; check management container and server connectivity'}
        atomic_json(root / 'errors/coordinator-unresponsive.json', redact(packet, secrets))
    if receipt:
        summary['exitCode'] = receipt.get('exitCode')
        summary['finished'] = True
        summary['completeCoverage'] = summary['valid'] == expected
        if receipt.get('exitCode') != 0 or not summary['completeCoverage']:
            atomic_json(root / 'errors/run-failure.json', redact({'kind': 'run_failure', 'receipt': receipt,
                'summary': summary, 'projectPath': str(repo), 'testCommand': ['node', str(repo / 'dist/cli-runtime.js'), 'run', str(config)]}, secrets))
        if receipt.get('reportExitCode', 0) != 0:
            atomic_json(root / 'errors/report-failure.json', redact({'kind': 'offline_report_failed', 'receipt': receipt, 'projectPath': str(repo)}, secrets))
    atomic_json(root / 'monitor-summary.json', redact(summary, secrets))
    (root / 'monitor-report.md').write_text(redact(
        '# Evaluator background report\n\n'
        f"State: {summary['state']}\n\nTerminal: {summary['terminal']}/{expected}\n\n"
        f"Valid scores: {summary['valid']}/{expected}; passed: {summary['passed']}\n\n"
        f"Statuses: {json.dumps(summary['statuses'])}\n\nFailures: {json.dumps(summary['failures'])}\n\n"
        f"Known tokens: {summary['tokens']['knownTotal']} (missing usage remains unknown).\n\n"
        'Unscored tasks are not counted as ordinary zero scores. Hardware and other errors are preserved in errors/.\n\n'
        'This monitor makes no model calls, does not invoke Codex, and does not retry or modify tests.\n', secrets))
    return summary, packets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--run-directory', type=Path, help='Observe only this native run; never fall back to an older results directory')
    parser.add_argument('--expected-tasks', required=True, type=int)
    parser.add_argument('--interval', type=float, default=60)
    parser.add_argument('--once', action='store_true')
    options = parser.parse_args()
    if options.expected_tasks <= 0 or options.interval <= 0:
        parser.error('expected task count and interval must be positive')
    os.umask(0o077)
    options.root.mkdir(parents=True, exist_ok=True)
    (options.root / 'errors').mkdir(exist_ok=True)
    credentials = read_json(options.root / '.credentials/model.json') or {}
    secrets = [value for name, value in credentials.items() if ('key' in name.lower() or 'token' in name.lower()) and isinstance(value, str)]
    seen = set()
    while True:
        try:
            summary, packets = snapshot(options.root, options.repo, options.config, options.expected_tasks, secrets, seen, options.run_directory)
            if packets or summary.get('finished'):
                print(json.dumps({'state': summary['state'], 'terminal': summary['terminal'], 'valid': summary['valid'], 'newErrors': packets}), flush=True)
            if options.once or summary.get('finished'):
                return
        except Exception as error:
            atomic_json(options.root / 'errors/monitor-error.json', {'kind': 'monitor_error', 'message': redact(str(error), secrets)})
            if options.once:
                raise
        time.sleep(options.interval)


if __name__ == '__main__':
    main()
