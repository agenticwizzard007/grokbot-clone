#if os(macOS)
import Foundation
import Darwin

// Shared by normal Stop and Quit. The bundled supervisor owns detached-descendant cleanup.
// Keep stopping supervisors alive across Stop -> Quit, rather than dropping their Process.
@MainActor
final class MacControlProcessLifecycle {
    private var stopping: [Process] = []
    var isStopping: Bool { stopping.contains(where: { $0.isRunning }) }

    func stop(_ process: Process) {
        reap()
        guard process.isRunning, !stopping.contains(where: { $0 === process }) else { return }
        stopping.append(process)
        process.terminate()
        // The supervisor grants its companion 2 seconds, then verifies and kills only its
        // observed descendants. This outer bound protects against a broken supervisor.
        DispatchQueue.global().asyncAfter(deadline: .now() + 4) {
            if process.isRunning { process.terminate(); kill(process.processIdentifier, SIGKILL) }
        }
    }

    func reap() { stopping.removeAll(where: { !$0.isRunning }) }

    func finishForQuit(timeout: TimeInterval = 4) {
        // willTerminate must finish cleanup before the native app exits. A main-queue timer
        // cannot run once teardown begins; wait a bounded interval for the supervisors.
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while isStopping && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        for process in stopping where process.isRunning { kill(process.processIdentifier, SIGKILL) }
        reap()
    }
}
#endif
