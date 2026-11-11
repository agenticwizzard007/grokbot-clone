import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#endif

@main
struct SwarmApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif

    var body: some Scene {
        #if os(macOS)
        Window("Swarm", id: "main") { content }
        .defaultSize(width: 1200, height: 800)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Use this Mac…") { openWindow(id: "mac-control") }
                Button("Server Settings…") { model.showingSettings = true }.keyboardShortcut(",")
            }
            CommandMenu("Mac Control") {
                MacControlMenu(control: model.macControl) { openWindow(id: "mac-control") }
            }
            CommandGroup(after: .toolbar) {
                Button("Reload Swarm") { model.reload() }.keyboardShortcut("r")
                Button("Go Home") { model.loadHome() }.keyboardShortcut("h", modifiers: [.command, .shift])
            }
        }
        MenuBarExtra {
            MacControlMenu(control: model.macControl) {
                NSApplication.shared.activate(ignoringOtherApps: true)
                openWindow(id: "mac-control")
            }
            Divider()
            Button("Quit Swarm") { NSApplication.shared.terminate(nil) }
        } label: { MacControlMenuLabel(control: model.macControl) }
        Window("Use this Mac", id: "mac-control") { MacControlView(control: model.macControl) }
            .defaultSize(width: 660, height: 760)
            .windowResizability(.contentSize)
        #else
        WindowGroup("Swarm") { content }
        #endif
    }

    private var content: some View {
        ContentView(model: model)
            .onChange(of: scenePhase) { _, phase in if phase == .active { model.resume() } }
            #if os(iOS)
            .onReceive(VoiceShortcutCenter.shared.$pending) { request in
                if let request {
                    VoiceShortcutCenter.shared.consume(request)
                    model.startMainAgentVoice(request)
                }
            }
            #endif
            .onOpenURL { url in
                // Only the browser authentication session may exchange sign-in credentials.
                if url.scheme == SignInAttempt.callbackScheme && url.host == "connected" { model.resume() }
            }
    }
}

struct ContentView: View {
    @ObservedObject var model: AppModel
    #if os(macOS)
    @Environment(\.openWindow) private var openWindow
    #endif

    var body: some View {
        NavigationStack {
            ZStack {
                WebContent(webView: model.webView)
                if let failure = model.failure {
                    VStack(spacing: 18) {
                        Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
                        Text("Let’s reconnect").font(.title2.bold())
                        Text(failure).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        Button("Try again") { model.loadHome() }.buttonStyle(.borderedProminent)
                        Button("Server settings") { model.showingSettings = true }
                    }
                    .padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(.background)
                }
            }
            .overlay(alignment: .top) {
                if (model.loading || model.signingIn) && model.failure == nil { ProgressView().padding(10).background(.regularMaterial, in: Capsule()).padding(8) }
            }
            #if os(iOS)
            .overlay(alignment: .bottom) {
                if let message = model.voiceShortcutMessage {
                    HStack(spacing: 12) {
                        Text(message).font(.callout)
                        Spacer(minLength: 0)
                        Button("Cancel") { model.cancelVoiceShortcut() }
                    }
                    .padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).padding(12)
                }
            }
            #endif
            .navigationTitle("Swarm")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItemGroup(placement: .automatic) {
                    Menu {
                        #if os(iOS)
                        Button("Talk to Swarm", systemImage: "waveform") { VoiceShortcutCenter.shared.request() }
                        #endif
                        #if os(macOS)
                        Button("Use this Mac…", systemImage: "desktopcomputer") { openWindow(id: "mac-control") }
                        #endif
                        Button("Home", systemImage: "house") { model.loadHome() }
                        Button("Reload", systemImage: "arrow.clockwise") { model.reload() }
                        Button("Server settings", systemImage: "network") { model.showingSettings = true }
                    } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("App controls") }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 520)
        #endif
        .sheet(isPresented: $model.showingSettings) { ServerSettings(model: model) }
        .alert("Swarm", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("OK") { model.notice = nil }
        } message: { Text(model.notice ?? "") }
        #if os(iOS)
        .sheet(item: $model.sharedFile) { file in ShareFile(url: file.url) }
        #endif
    }
}

struct ServerSettings: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://swarm.example.com", text: $address)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL).textInputAutocapitalization(.never)
                        #endif
                    if let error { Text(error).foregroundStyle(.red) }
                } header: { Text("Swarm server") } footer: {
                    Text("Connect to the same server you use in your browser. Your bots and conversations stay on that server.")
                }
                Section {
                    Button("Clear local sign-in data", role: .destructive) { confirmClear = true }
                } footer: { Text("Removes saved sessions and website settings from this app for every server. Your bots and conversations are kept.") }
                Section {
                    Text("Swarm · Swarms.so").foregroundStyle(.secondary)
                    Text("Bots keep working on your server when this app is closed. Voice calls need the app to stay open.").font(.callout).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Server settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        do { try model.changeServer(address); dismiss() } catch { self.error = error.localizedDescription }
                    }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        #if os(macOS)
        .frame(width: 480, height: 440)
        #endif
        .onAppear { address = model.server.url.absoluteString }
        .confirmationDialog("Clear this app’s saved sessions and website settings?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear local data", role: .destructive) { model.clearWebsiteData(); dismiss() }
        }
    }
}

#if os(macOS)
struct WebContent: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
struct WebContent: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
struct ShareFile: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
