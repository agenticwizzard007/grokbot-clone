#if os(macOS)
import SwiftUI

struct MacControlView: View {
    @ObservedObject var control: MacControlController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Use this Mac").font(.title2.bold())
                Spacer()
                Label(control.statusLabel, systemImage: control.running ? "circle.fill" : "stop.circle")
                    .foregroundStyle(control.connected ? .green : .secondary)
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    GroupBox("Account and server") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(control.accountLabel).font(.headline)
                            Text(control.serverLabel).textSelection(.enabled)
                            Text(control.localSelected ? "This account has selected a local computer. While stopped, it stays offline until you start it again or disconnect." : "Starting selects this Mac for this account’s computer tasks.")
                                .font(.callout).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    }
                    GroupBox("Explicit access approval") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Bots in the account above can act as you on this Mac while control is running. Approve each type of access before starting.")
                                .font(.callout)
                            Toggle("Terminal — run commands as my signed-in Mac user", isOn: $control.consent.terminal)
                            Toggle("Files — read, change, and delete files my user can access", isOn: $control.consent.files)
                            Toggle("Browsers — use Playwright and interact with my open browsers", isOn: $control.consent.browsers)
                            Toggle("Desktop — view my screen, click, type, and control apps", isOn: $control.consent.desktop)
                            Text("Desktop control can reach signed-in apps and websites. Playwright starts a separate persistent Chrome profile; your existing browser remains accessible through the visible desktop. macOS protected files and app automation still require Apple’s permissions.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.disabled(control.running || control.busy).padding(4)
                    }
                    GroupBox {
                        DisclosureGroup("Advanced: attach Playwright to an existing browser") {
                            VStack(alignment: .leading, spacing: 10) {
                                TextField("Optional loopback CDP endpoint, e.g. http://127.0.0.1:9222", text: $control.browserEndpoint)
                                    .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                                if !control.browserEndpoint.isEmpty {
                                    Toggle("I approve Playwright access to this existing browser and its signed-in tabs", isOn: $control.browserEndpointApproved)
                                }
                                if let error = control.browserEndpointError { Text(error).font(.caption).foregroundStyle(.red) }
                                Text("Leave empty to use a separate managed Chrome profile. For attachment, supply an already-running browser’s loopback http(s)/ws(s) debugging endpoint. Swarm does not start or restart that browser, copy its profile, or enable remote debugging. Stop detaches Playwright and leaves the browser open. Keep the endpoint private.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(.top, 10)
                        }.padding(4)
                    }.disabled(control.running || control.busy)
                    GroupBox("macOS privacy permissions") {
                        VStack(alignment: .leading, spacing: 12) {
                            permissionRow("Accessibility", allowed: control.accessibilityAllowed, request: control.requestAccessibility, pane: "Privacy_Accessibility")
                            permissionRow("Screen Recording", allowed: control.screenRecordingAllowed, request: control.requestScreenRecording, pane: "Privacy_ScreenCapture")
                            HStack {
                                Text("Full Disk Access")
                                Spacer()
                                Button("Open System Settings") { control.openPrivacy("Privacy_AllFiles") }
                            }
                            HStack {
                                Text("Automation")
                                Spacer()
                                Button("Open System Settings") { control.openPrivacy("Privacy_Automation") }
                            }
                            Text("Terminal and Playwright can start before desktop permissions are approved. Desktop screenshots need Screen Recording; clicks and typing need Accessibility. Swarm checks both with macOS APIs. Full Disk Access has no general status API; Automation is granted per target app when first used. These links do not grant access. Approve Swarm (or the helper macOS identifies) in System Settings. Restart Swarm if macOS requests it.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Refresh account and permissions") {
                                control.refreshPermissions()
                                Task { await control.refresh() }
                            }.disabled(control.busy)
                        }.padding(4)
                    }
                    if let failure = control.failure {
                        Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
                    }
                    if let message = control.message { Text(message).font(.callout).foregroundStyle(.secondary) }
                }
            }
            HStack(spacing: 12) {
                Button(control.savedPairing ? "Approve and start again" : "Approve and start") { control.start() }
                    .buttonStyle(.borderedProminent).disabled(!control.canStart)
                Button("Stop", role: .destructive) { control.stop() }.disabled(!control.running && !control.busy)
                Spacer()
                if control.busy { ProgressView().controlSize(.small) }
                Button("Disconnect", role: .destructive) { control.disconnect() }.disabled(!control.canDisconnect)
            }
            Text("Stop ends access and keeps local mode selected. Disconnect revokes local-device tokens for this account and returns it to the server’s default computer. Quitting Swarm stops access.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(20).frame(width: 660, height: 760)
        .task { control.refreshPermissions(); await control.refresh() }
    }

    private func permissionRow(_ title: String, allowed: Bool, request: @escaping () -> Void, pane: String) -> some View {
        HStack {
            Label(title, systemImage: allowed ? "checkmark.circle.fill" : "exclamationmark.circle")
            Text(allowed ? "Allowed" : "Not allowed").foregroundStyle(allowed ? .green : .secondary)
            Spacer()
            if !allowed { Button("Request") { request() } }
            Button("Settings") { control.openPrivacy(pane) }
        }
    }
}

struct MacControlMenu: View {
    @ObservedObject var control: MacControlController
    let showControls: () -> Void
    var body: some View {
        Text("Mac control: \(control.statusLabel)")
        if !control.accountID.isEmpty { Text(control.accountLabel) }
        Button("Use this Mac…", action: showControls)
        Button("Stop Mac control", role: .destructive) { control.stop() }.disabled(!control.running && !control.busy)
        Button("Disconnect this Mac", role: .destructive) { control.disconnect() }.disabled(!control.canDisconnect)
    }
}

struct MacControlMenuLabel: View {
    @ObservedObject var control: MacControlController
    var body: some View {
        Label(control.running ? "Swarm Mac control running" : "Swarm Mac control stopped",
              systemImage: control.running ? "desktopcomputer.and.arrow.down" : "desktopcomputer")
    }
}
#endif
