#!/usr/bin/env python3
"""Offline lifecycle regression tests for the installed app's native supervisor."""
import json
from concurrent.futures import ThreadPoolExecutor
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest


def write(path, value):
    pathlib.Path(path).write_text(value)


def alive(pid):
    result = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith('Z')


def fixture(mode, root):
    root = pathlib.Path(root)
    if mode == 'worker':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(4)
        write(root / 'escaped-work', 'detached work survived quit')
        time.sleep(30)
        return
    worker = subprocess.Popen([sys.executable, __file__, 'fixture', 'worker', str(root)], start_new_session=True)
    write(root / 'worker-pid', str(worker.pid))
    if mode == 'responsive':
        def stop(_number, _frame):
            # A measurable asynchronous-cleanup interval catches immediate SIGKILL on Quit.
            time.sleep(0.25)
            try:
                os.killpg(worker.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            worker.wait(timeout=1)
            write(root / 'graceful-cleanup', 'finished')
            sys.exit(0)
        signal.signal(signal.SIGTERM, stop)
    else:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    write(root / 'ready', json.dumps({'companion': os.getpid(), 'worker': worker.pid}))
    while True:
        time.sleep(0.02)


def wait_ready(root, process):
    deadline = time.monotonic() + 5
    while not (root / 'ready').exists():
        if process.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError('supervised fixture did not become ready')
        time.sleep(0.01)
    return json.loads((root / 'ready').read_text())


class SupervisorLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix='swarm-host-build-')
        cls.host = pathlib.Path(cls.build.name) / 'control-host'
        source = pathlib.Path(__file__).with_name('control-host.c').resolve()
        command = ['xcrun', '--sdk', 'macosx', 'clang'] if sys.platform == 'darwin' else ['cc']
        command += ['-Wall', '-Wextra', '-Werror', '-O2']
        libraries = ['-lproc'] if sys.platform == 'darwin' else []
        subprocess.run(command + [str(source)] + libraries + ['-o', str(cls.host)], check=True)
        # Pause only the parent's return from fork, before its identity read. No
        # timing or environment hooks are compiled into the shipped supervisor.
        startup_source = pathlib.Path(cls.build.name) / 'startup-test.c'
        startup_source.write_text('''#include <unistd.h>
static pid_t startup_test_fork(void);
#define fork startup_test_fork
#include ''' + json.dumps(str(source)) + '''
#undef fork
static pid_t startup_test_fork(void) {
    pid_t child = fork();
    if (child > 0) {
        const char *directory = getenv("SWARM_TEST_STARTUP_ROOT");
        char ready[4096], pending[4096], release[4096];
        if (!directory) _exit(125);
        snprintf(ready, sizeof(ready), "%s/ready", directory);
        snprintf(pending, sizeof(pending), "%s/pending", directory);
        snprintf(release, sizeof(release), "%s/release", directory);
        FILE *file = fopen(pending, "w");
        if (!file) _exit(125);
        fprintf(file, "{\\"companion\\":%ld}", (long)child);
        fclose(file);
        if (rename(pending, ready) != 0) _exit(125);
        while (access(release, F_OK) != 0 && !stopping) pause_briefly();
    }
    return child;
}
''')
        cls.startup_host = pathlib.Path(cls.build.name) / 'control-host-startup-test'
        subprocess.run(command + [str(startup_source)] + libraries + ['-o', str(cls.startup_host)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def run_fixture(self, mode):
        with tempfile.TemporaryDirectory(prefix='swarm-host-test-') as directory:
            root = pathlib.Path(directory)
            external = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
            host = subprocess.Popen([str(self.host), sys.executable, __file__, 'fixture', mode, str(root)])
            owned = {}
            try:
                owned = wait_ready(root, host)
                start = time.monotonic()
                host.terminate()
                host.wait(timeout=4)
                duration = time.monotonic() - start
                if mode == 'responsive':
                    self.assertTrue((root / 'graceful-cleanup').exists(), 'Quit must let the companion finish graceful cleanup')
                    self.assertGreaterEqual(duration, 0.20)
                    self.assertEqual(host.returncode, 0)
                else:
                    self.assertGreaterEqual(duration, 1.8, 'A wedged companion must receive a bounded grace interval')
                    self.assertLess(duration, 3.5)
                self.assertFalse(alive(owned['companion']))
                self.assertFalse(alive(owned['worker']), 'Detached owned work must be reaped even if companion ignored SIGTERM')
                self.assertIsNone(external.poll(), 'Unrelated external browser analogue must survive')
                # Reproduce the review's marker check after the detached command's deadline.
                if mode == 'wedged':
                    time.sleep(max(0, 4.2 - duration))
                self.assertFalse((root / 'escaped-work').exists())
            finally:
                for pid in owned.values():
                    if alive(pid):
                        os.kill(pid, signal.SIGKILL)
                if host.poll() is None:
                    host.kill()
                host.wait()
                external.kill()
                external.wait()

    def check_startup_gate(self, outcome):
        with tempfile.TemporaryDirectory(prefix='swarm-host-startup-') as directory:
            root = pathlib.Path(directory)
            marker = root / 'executed'
            environment = dict(os.environ, SWARM_TEST_STARTUP_ROOT=directory)
            host = subprocess.Popen([str(self.startup_host), '/bin/sh', '-c',
                                     'printf executed > "$1"', 'startup-test', str(marker)], env=environment)
            child = None
            try:
                child = wait_ready(root, host)['companion']
                # The parent is held before identity capture. Even an immediate
                # payload must still be alive inside the gate and cannot execute.
                time.sleep(0.1)
                self.assertTrue(alive(child), 'Child exited before parent recorded its identity')
                self.assertFalse(marker.exists(), 'Child executed before parent recorded its identity')
                if outcome == 'release':
                    (root / 'release').touch()
                    self.assertEqual(host.wait(timeout=3), 0)
                    self.assertTrue(marker.exists())
                else:
                    if outcome == 'parent-dies':
                        host.kill()
                    else:
                        host.terminate()
                    host.wait(timeout=3)
                    if outcome == 'stop':
                        self.assertEqual(host.returncode, 126)
                    deadline = time.monotonic() + 3
                    while alive(child) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertFalse(alive(child), 'Aborted startup left a child waiting for permission')
                    self.assertFalse(marker.exists(), 'Aborted startup executed the payload')
            finally:
                if host.poll() is None:
                    host.kill()
                host.wait()
                if child and alive(child):
                    os.kill(child, signal.SIGKILL)

    def test_quick_child_exit_preserves_status(self):
        for outcome in ['release', 'parent-dies', 'stop']:
            with self.subTest(startup=outcome):
                self.check_startup_gate(outcome)
        # Exercise startup under contention without retries. The gate must keep
        # even an immediately exiting payload alive until identity capture.
        def run(_):
            return subprocess.run([str(self.host), '/usr/bin/true', 'quick-child'], check=False).returncode
        with ThreadPoolExecutor(max_workers=12) as workers:
            results = list(workers.map(run, range(400)))
        self.assertEqual(set(results), {0}, 'Quick child exit was misreported as launcher failure')
        self.assertEqual(subprocess.run([str(self.host), '/usr/bin/false', 'quick-child'], check=False).returncode, 1)
        self.assertEqual(subprocess.run([str(self.host), '/bin/sh', '-c', 'kill -TERM $$'], check=False).returncode,
                         128 + signal.SIGTERM)
        self.assertEqual(subprocess.run([str(self.host), '/swarm-missing-runtime', 'quick-child'], check=False).returncode, 127)

    def test_responsive_companion_gets_time_to_clean_detached_work(self):
        self.run_fixture('responsive')

    def test_wedged_companion_loses_only_its_owned_detached_work(self):
        self.run_fixture('wedged')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'fixture':
        fixture(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
