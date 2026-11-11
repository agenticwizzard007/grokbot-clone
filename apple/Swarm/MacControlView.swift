#if os(macOS)
import SwiftUI
import WebKit
import CoreText

// Paper: Settings · Redesign / Mac app · Computer · Device access.
// Keep the native consent surface in the same type, palette and row rhythm as web settings.
private enum MacControlBrand {
    private static let registered: Void = {
        if let url = Bundle.main.url(forResource: "InstrumentSans-550", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()
    static func font(_ size: CGFloat) -> Font {
        _ = registered
        return .custom("InstrumentSans-550", size: size)
    }
    private static func gray(_ light: CGFloat, _ dark: CGFloat) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(white: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light, alpha: 1)
        })
    }
    static let ink = gray(28 / 255, 245 / 255)
    static let paper = gray(1, 22 / 255)
    static let secondary = ink.opacity(0.68)
    static let border = ink.opacity(0.12)
    static let hairline = ink.opacity(0.08)
    static let fill = ink.opacity(0.06)
}

struct MacControlView: View {
    @ObservedObject var control: MacControlController
    private var desktopReady: Bool { control.accessibilityAllowed && control.screenRecordingAllowed }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Device access").font(MacControlBrand.font(15))
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    card {
                        HStack(alignment: .center, spacing: 16) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(control.accountLabel).font(MacControlBrand.font(14))
                                Text(control.serverLabel).font(MacControlBrand.font(13))
                                    .foregroundStyle(MacControlBrand.secondary).textSelection(.enabled)
                                if control.accountID.isEmpty {
                                    Text("Sign in on this server before approving access.")
                                        .foregroundStyle(MacControlBrand.secondary)
                                }
                            }
                            Spacer(minLength: 8)
                            Text(control.connected ? "Connected" : "Not connected")
                                .foregroundStyle(MacControlBrand.secondary)
                        }.padding(.vertical, 16)
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .top, spacing: 16) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Agent access").font(MacControlBrand.font(15))
                                Text("Agents act as your Mac user. Approve all four to connect.")
                                    .foregroundStyle(MacControlBrand.secondary)
                            }
                            Spacer(minLength: 0)
                            if !control.consent.complete {
                                Button("Approve all") {
                                    control.consent = MacControlConsent(terminal: true, files: true, browsers: true, desktop: true)
                                }.buttonStyle(MacControlButtonStyle())
                            }
                        }
                        card {
                            accessRow("Terminal", detail: "Run commands and use installed tools.", value: $control.consent.terminal)
                            hairline
                            accessRow("Files", detail: "Read, create, change and delete files you can access.", value: $control.consent.files)
                            hairline
                            accessRow("Browsers", detail: "Browse websites and interact with signed-in pages.", value: $control.consent.browsers)
                            hairline
                            accessRow("Desktop & apps", detail: "See the screen, click, type and use open apps.", value: $control.consent.desktop)
                        }
                    }.disabled(control.running || control.busy || control.accountID.isEmpty)
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("macOS permissions").font(MacControlBrand.font(15))
                            Text("Enable Swarm in System Settings. Status updates when you return.")
                                .foregroundStyle(MacControlBrand.secondary)
                        }
                        card {
                            permissionRow("Accessibility", detail: "Click, type and control apps. Required for input.", allowed: control.accessibilityAllowed) {
                                control.requestAccessibility()
                                if !control.accessibilityAllowed { control.openPrivacy("Privacy_Accessibility") }
                            }
                            hairline
                            permissionRow("Screen Recording", detail: "See your screen. Required for screen access.", allowed: control.screenRecordingAllowed) {
                                control.requestScreenRecording()
                                if !control.screenRecordingAllowed { control.openPrivacy("Privacy_ScreenCapture") }
                            }
                            hairline
                            settingsRow("Full Disk Access", detail: "Read protected folders and data. Optional; add Swarm in Settings.", pane: "Privacy_AllFiles")
                            hairline
                            settingsRow("Automation", detail: "Control other apps. macOS asks for each app.", pane: "Privacy_Automation")
                        }
                        Text("If macOS asks you to quit and reopen Swarm, do that before connecting.")
                            .foregroundStyle(MacControlBrand.secondary)
                    }
                    DisclosureGroup("Use an existing browser") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Agents normally use a separate managed Chrome profile. Desktop access can also use your visible browser windows.")
                                .foregroundStyle(MacControlBrand.secondary)
                            TextField("Local browser debugging endpoint", text: $control.browserEndpoint)
                                .textFieldStyle(.roundedBorder).autocorrectionDisabled()
                            if !control.browserEndpoint.isEmpty {
                                Toggle("Allow access to this browser and its signed-in tabs", isOn: $control.browserEndpointApproved)
                                    .toggleStyle(MacControlCheckboxStyle())
                            }
                            if let error = control.browserEndpointError { Text(error).foregroundStyle(.red) }
                            Text("Direct attachment needs an already-running browser’s local debugging endpoint. Stopping Swarm leaves that browser open.")
                                .foregroundStyle(MacControlBrand.secondary)
                        }.padding(.top, 12)
                    }.disabled(control.running || control.busy)
                }.padding(.trailing, 4)
            }
            hairline
            VStack(alignment: .leading, spacing: 12) {
                if let failure = control.failure {
                    Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled)
                }
                if let message = control.message { Text(message).foregroundStyle(MacControlBrand.secondary) }
                HStack(spacing: 10) {
                    Text(control.connected ? (desktopReady ? "Your Mac is ready." : "Finish screen and input permissions above.") : "Keep Swarm open while agents work.")
                        .foregroundStyle(MacControlBrand.secondary)
                    Spacer(minLength: 8)
                    if control.busy { ProgressView().controlSize(.small) }
                    if control.running || control.busy {
                        Button("Stop") { control.stop() }.buttonStyle(MacControlButtonStyle())
                    } else {
                        Button(control.stopping ? "Stopping…" : "Connect this Mac") { control.start() }
                            .buttonStyle(MacControlButtonStyle(primary: true)).disabled(!control.canStart)
                    }
                    if control.canDisconnect {
                        Button("Disconnect") { control.disconnect() }.buttonStyle(MacControlButtonStyle())
                    }
                }
                Text("Stop keeps this Mac selected but offline. Disconnect returns agents to the cloud computer.")
                    .foregroundStyle(MacControlBrand.secondary)
            }
        }
        .font(MacControlBrand.font(13)).foregroundStyle(MacControlBrand.ink)
        .padding(1).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(MacControlBrand.paper)
        .task { control.refreshPermissions(); await control.refresh() }
    }

    private var hairline: some View { Rectangle().fill(MacControlBrand.hairline).frame(height: 1) }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0, content: content)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20)
            .background(MacControlBrand.paper)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(MacControlBrand.border, lineWidth: 1))
    }

    private func rowText(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(MacControlBrand.font(14))
            Text(detail).foregroundStyle(MacControlBrand.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func accessRow(_ title: String, detail: String, value: Binding<Bool>) -> some View {
        Toggle(isOn: value) { rowText(title, detail) }
            .toggleStyle(MacControlCheckboxStyle()).padding(.vertical, 14)
    }

    private func permissionRow(_ title: String, detail: String, allowed: Bool, request: @escaping () -> Void) -> some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                rowText(title, detail)
                Text(allowed ? "Allowed" : "Needs approval").foregroundStyle(MacControlBrand.secondary)
            }
            Button(allowed ? "Settings" : "Enable", action: allowed ? { control.openPrivacy(title == "Accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture") } : request)
                .buttonStyle(MacControlButtonStyle()).frame(width: 96, alignment: .trailing)
        }.padding(.vertical, 14)
    }

    private func settingsRow(_ title: String, detail: String, pane: String) -> some View {
        HStack(spacing: 16) {
            rowText(title, detail)
            Button("Settings") { control.openPrivacy(pane) }
                .buttonStyle(MacControlButtonStyle()).frame(width: 96, alignment: .trailing)
        }.padding(.vertical, 14)
    }
}

private struct MacControlButtonStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(MacControlBrand.font(13)).padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(primary ? MacControlBrand.paper : MacControlBrand.ink)
            .background(primary ? MacControlBrand.ink : MacControlBrand.fill, in: Capsule())
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.35)
            .contentShape(Capsule())
    }
}

private struct MacControlCheckboxStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        Button { configuration.isOn.toggle() } label: {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4).fill(configuration.isOn ? MacControlBrand.ink : MacControlBrand.paper)
                    RoundedRectangle(cornerRadius: 4).strokeBorder(MacControlBrand.border, lineWidth: 1)
                    if configuration.isOn {
                        Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(MacControlBrand.paper)
                    }
                }.frame(width: 16, height: 16)
                configuration.label
            }.contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityValue(configuration.isOn ? "Approved" : "Not approved")
    }
}

// Only this isolated native script can send placement messages. Page JavaScript receives
// no permission, pairing, command or Start API. All consent controls remain native views.
@MainActor
final class MacControlSettingsHost: NSObject, WKScriptMessageHandler {
    private weak var webView: WKWebView?
    private let address: () -> ServerAddress?
    private let clip = MacControlSettingsClip()
    private let content: NSHostingView<MacControlView>

    init(webView: WKWebView, control: MacControlController, address: @escaping () -> ServerAddress?) {
        self.webView = webView
        self.address = address
        self.content = NSHostingView(rootView: MacControlView(control: control))
        super.init()
        content.sizingOptions = []
        clip.wantsLayer = true
        clip.layer?.masksToBounds = true
        clip.addSubview(content)
        let scripts = webView.configuration.userContentController
        scripts.add(self, contentWorld: .defaultClient, name: "swarmComputerSettings")
        scripts.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
    }

    func hide() { clip.removeFromSuperview() }

    func refresh() {
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('swarm:native-placement-refresh'));", in: nil, in: .defaultClient, completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let webView, message.webView === webView, message.frameInfo.isMainFrame,
              let address = address(), let frameURL = message.frameInfo.request.url, address.contains(frameURL),
              let pageURL = webView.url, address.contains(pageURL), !webView.isLoading,
              let data = message.body as? [String: Any], data["visible"] as? Bool == true else { hide(); return }
        func number(_ key: String) -> Double { (data[key] as? NSNumber)?.doubleValue ?? .nan }
        let values = ["x", "y", "width", "height", "viewportWidth", "viewportHeight"].map(number)
        guard values.allSatisfy({ $0.isFinite && abs($0) < 100_000 }), values[2] >= 280, values[3] >= 400,
              values[4] > 0, values[5] > 0 else { hide(); return }
        let scaleX = webView.bounds.width / values[4]
        let scaleY = webView.bounds.height / values[5]
        let frame = CGRect(x: values[0] * scaleX, y: values[1] * scaleY, width: values[2] * scaleX, height: values[3] * scaleY)
        let visible = frame.intersection(CGRect(origin: .zero, size: webView.bounds.size))
        guard !visible.isNull, visible.width > 0, visible.height > 0 else { hide(); return }
        clip.frame = CGRect(x: visible.minX, y: webView.isFlipped ? visible.minY : webView.bounds.height - visible.maxY, width: visible.width, height: visible.height)
        content.frame = CGRect(x: frame.minX - visible.minX, y: frame.minY - visible.minY, width: frame.width, height: frame.height)
        content.appearance = NSAppearance(named: data["dark"] as? Bool == true ? .darkAqua : .aqua)
        if clip.superview !== webView { webView.addSubview(clip, positioned: .above, relativeTo: nil) }
    }

    static let script = #"""
    (() => {
      document.documentElement.dataset.swarmMacControl = 'available';
      let scheduled = false, previous = '', observed;
      const observer = new ResizeObserver(() => schedule());
      function place() {
        scheduled = false;
        const page = document.querySelector('.app-settings__page');
        const title = page?.querySelector('h1')?.textContent?.trim();
        const computerPage = title === 'Computer';
        if (!computerPage) document.querySelectorAll('[data-swarm-mac-control-fallback]').forEach(el => el.remove());
        let slot = computerPage ? document.querySelector('[data-swarm-mac-control-slot]:not([data-swarm-mac-control-fallback])') : null;
        if (slot) document.querySelectorAll('[data-swarm-mac-control-fallback]').forEach(el => el.remove());
        // Older hosted pages still get the same inline controls after a native update.
        if (!slot) {
          if (page && computerPage) {
            slot = page.querySelector('[data-swarm-mac-control-fallback]');
            if (!slot) {
              slot = document.createElement('section');
              slot.setAttribute('data-swarm-mac-control-slot', '');
              slot.setAttribute('data-swarm-mac-control-fallback', '');
              slot.setAttribute('aria-label', 'Mac device access');
              slot.style.cssText = 'position:relative;height:max(660px,min(900px,calc(100vh - 180px)));margin:24px 0;';
              page.insertBefore(slot, page.children[1] || null);
            }
          }
        }
        if (slot !== observed) { observer.disconnect(); if (slot) observer.observe(slot); observed = slot; }
        const r = document.querySelector('.modal-root') ? null : slot?.getBoundingClientRect();
        const payload = r && r.width && r.height ? { visible:true, x:r.x, y:r.y, width:r.width, height:r.height,
          viewportWidth:innerWidth, viewportHeight:innerHeight, dark:document.documentElement.dataset.theme === 'dark' } : { visible:false };
        const next = JSON.stringify(payload);
        if (next !== previous) { previous = next; window.webkit.messageHandlers.swarmComputerSettings.postMessage(payload); }
      }
      function schedule() { if (!scheduled) { scheduled = true; setTimeout(place, 0); } }
      new MutationObserver(schedule).observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['class','style','data-theme'] });
      addEventListener('scroll', schedule, true);
      addEventListener('resize', schedule);
      addEventListener('animationend', schedule, true);
      addEventListener('swarm:native-placement-refresh', () => { previous = ''; schedule(); });
      addEventListener('pagehide', () => window.webkit.messageHandlers.swarmComputerSettings.postMessage({visible:false}));
      schedule();
    })();
    """#
}

private final class MacControlSettingsClip: NSView {
    override var isFlipped: Bool { true }
}

struct MacControlMenu: View {
    @ObservedObject var control: MacControlController
    let showControls: () -> Void
    var body: some View {
        Text("Mac control: \(control.statusLabel)")
        if !control.accountID.isEmpty { Text(control.accountLabel) }
        Button("Computer & Device Access…", action: showControls)
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
