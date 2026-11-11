#!/usr/bin/env python3
"""Real WebKit integration for inline native device access. No grants or live account."""
import pathlib
import subprocess
import sys
import tempfile

if sys.platform != 'darwin':
    print('SKIP: native settings integration requires macOS/WebKit')
    sys.exit(0)

apple = pathlib.Path(__file__).resolve().parents[1]
sources = [apple / 'Swarm' / name for name in [
    'ServerAddress.swift', 'MacControlAPI.swift', 'MacControlController.swift',
    'MacControlPolicy.swift', 'MacControlTokenStore.swift',
    'MacControlProcessLifecycle.swift', 'MacControlView.swift',
]]
with tempfile.TemporaryDirectory(prefix='swarm-settings-integration-') as directory:
    executable = pathlib.Path(directory) / 'test-settings'
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', *map(str, sources),
                    str(apple / 'MacControl/test_settings.swift'), '-o', str(executable)], check=True, timeout=120)
    font = apple / 'Swarm/Resources/InstrumentSans-550.ttf'
    subprocess.run([str(executable), str(font), *sys.argv[1:]], check=True, timeout=60)
