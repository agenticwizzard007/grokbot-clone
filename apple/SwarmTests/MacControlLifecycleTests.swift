#if os(macOS)
import XCTest
import Darwin

@MainActor
final class MacControlLifecycleTests: XCTestCase {
    func testQuitWaitsForCompanionCleanupAfterStop() throws {
        try exerciseQuit(mode: "responsive")
    }

    func testQuitStopsWedgedDetachedWorkAndPreservesExternalBrowser() throws {
        try exerciseQuit(mode: "wedged")
    }

    private func exerciseQuit(mode: String) throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("MacControl")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let host = folder.appendingPathComponent("control-host")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compiler.arguments = ["--sdk", "macosx", "clang", "-Wall", "-Wextra", "-Werror", source.appendingPathComponent("control-host.c").path, "-lproc", "-o", host.path]
        try compiler.run()
        compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0)
        guard compiler.terminationStatus == 0 else { return }
        let fixture = Process()
        fixture.executableURL = host
        fixture.arguments = ["/usr/bin/python3", source.appendingPathComponent("test_lifecycle.py").path, "fixture", mode, folder.path]
        let externalBrowser = Process()
        externalBrowser.executableURL = URL(fileURLWithPath: "/bin/sleep")
        externalBrowser.arguments = ["30"]
        try externalBrowser.run()
        defer { if externalBrowser.isRunning { externalBrowser.terminate() } }
        try fixture.run()
        defer {
            if fixture.isRunning {
                let cleanup = MacControlProcessLifecycle()
                cleanup.stop(fixture)
                cleanup.finishForQuit()
            }
        }
        let ready = folder.appendingPathComponent("ready")
        let readyDeadline = Date().addingTimeInterval(5)
        while !FileManager.default.fileExists(atPath: ready.path) && fixture.isRunning && Date() < readyDeadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        let data = try Data(contentsOf: ready)
        let pids = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Int32])
        let worker = try XCTUnwrap(pids["worker"])
        let lifecycle = MacControlProcessLifecycle()
        let start = ProcessInfo.processInfo.systemUptime
        lifecycle.stop(fixture)
        // This is the production Stop -> Quit path. Quit must drain an already stopping host.
        lifecycle.finishForQuit()
        let duration = ProcessInfo.processInfo.systemUptime - start
        XCTAssertFalse(lifecycle.isStopping)
        XCTAssertFalse(fixture.isRunning)
        XCTAssertTrue(externalBrowser.isRunning, "An externally attached browser is not an owned descendant")
        if mode == "responsive" {
            XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("graceful-cleanup").path))
            XCTAssertGreaterThanOrEqual(duration, 0.2, "Quit must allow the companion's asynchronous cleanup")
            XCTAssertEqual(fixture.terminationStatus, 0)
        } else {
            XCTAssertGreaterThanOrEqual(duration, 1.8)
            XCTAssertLessThan(duration, 3.8)
            Thread.sleep(forTimeInterval: max(0, 4.2 - duration))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("escaped-work").path), "Detached work must not write a marker after Quit")
        let workerStatus = Process()
        workerStatus.executableURL = URL(fileURLWithPath: "/bin/ps")
        workerStatus.arguments = ["-o", "stat=", "-p", String(worker)]
        let output = Pipe()
        workerStatus.standardOutput = output
        try workerStatus.run()
        workerStatus.waitUntilExit()
        let state = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        XCTAssertTrue(state.isEmpty || state.hasPrefix("Z"), "Owned detached process must be gone")
    }
}
#endif
