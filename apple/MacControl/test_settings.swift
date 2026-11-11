import AppKit
import WebKit
import CoreText

// Exercise the real isolated script and native view using a local, unauthenticated page.
@MainActor
private final class SettingsNavigation: NSObject, WKNavigationDelegate {
    var host: MacControlSettingsHost?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { host?.refresh() }
}

@main
@MainActor
struct SettingsIntegrationTest {
    enum Failure: Error { case check(String) }

    static func main() throws {
        if CommandLine.arguments.count > 1 {
            let fontURL = URL(fileURLWithPath: CommandLine.arguments[1])
            CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
            let font = CTFontCreateWithName("InstrumentSans-550" as CFString, 14, nil)
            guard CTFontCopyPostScriptName(font) as String == "InstrumentSans-550" else {
                throw Failure.check("The branded font must be available to native settings")
            }
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 1000, height: 900))
        let address = try ServerAddress("http://127.0.0.1:51999", allowLocalHTTP: true)
        let control = MacControlController(cookies: web.configuration.websiteDataStore.httpCookieStore, address: address)
        let host = MacControlSettingsHost(webView: web, control: control, address: { address })
        let navigation = SettingsNavigation()
        navigation.host = host
        web.navigationDelegate = navigation
        let window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Swarm device access integration test"
        window.contentView = web
        window.orderFront(nil)
        defer { window.orderOut(nil); host.hide() }

        func embedded() -> Bool { web.subviews.contains { String(describing: type(of: $0)) == "MacControlSettingsClip" } }
        func wait(_ label: String, _ condition: () -> Bool) throws {
            let end = Date().addingTimeInterval(8)
            while !condition() && Date() < end { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
            guard condition() else { throw Failure.check(label) }
        }
        func js(_ source: String) throws -> Any? {
            var done = false, value: Any?, failure: Error?
            web.evaluateJavaScript(source) { result, error in value = result; failure = error; done = true }
            try wait("JavaScript completed") { done }
            if let failure { throw failure }
            return value
        }

        web.loadHTMLString("<div class='app-settings__page'><header><h1>Computer</h1></header><div>Cloud status</div></div>", baseURL: address.url)
        try wait("Native controls embed in an older Computer page") { embedded() }
        guard try js("typeof window.webkit?.messageHandlers?.swarmComputerSettings") as? String == "undefined" else {
            throw Failure.check("Page JavaScript must not access the isolated native handler")
        }
        guard !control.canStart && !control.consent.complete else { throw Failure.check("An unauthenticated page cannot approve or start device control") }

        // Replacing the fallback with a React-owned slot must not reserve duplicate space.
        _ = try js("var slot=document.createElement('section');slot.dataset.swarmMacControlSlot='';slot.style.cssText='height:700px';document.querySelector('.app-settings__page').append(slot)")
        try wait("Native replacement remains embedded") { embedded() }
        try wait("Fallback is removed") {
            (try? js("document.querySelectorAll('[data-swarm-mac-control-slot]').length")) as? Int == 1
        }

        _ = try js("document.querySelector('[data-swarm-mac-control-slot]').style.height='20px'")
        try wait("A tiny slot cannot expose native approval controls") { !embedded() }
        _ = try js("document.querySelector('[data-swarm-mac-control-slot]').style.height='700px'")
        try wait("Normal placement returns") { embedded() }

        _ = try js("var modal=document.createElement('div');modal.className='modal-root';document.body.append(modal)")
        try wait("Web dialogs must cover native controls") { !embedded() }
        _ = try js("document.querySelector('.modal-root').remove()")
        try wait("Native controls return after a dialog closes") { embedded() }
        _ = try js("document.querySelector('.app-settings__page').innerHTML='<h1>Account</h1>'")
        try wait("Leaving Computer hides native controls") { !embedded() }

        _ = try js("document.querySelector('.app-settings__page').innerHTML='<header><h1>Permissions</h1></header><div>Always allowed</div>'")
        try wait("Permissions has no duplicate native device controls") { !embedded() }
        guard try js("document.querySelectorAll('[data-swarm-mac-control-fallback]').length") as? Int == 0 else {
            throw Failure.check("Permissions must not reserve a device-permissions fallback")
        }
        _ = try js("var oldSlot=document.createElement('section');oldSlot.dataset.swarmMacControlSlot='';oldSlot.style.height='700px';document.querySelector('.app-settings__page').append(oldSlot)")
        let settling = Date().addingTimeInterval(0.3)
        while Date() < settling { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
        guard !embedded() else { throw Failure.check("An old web Permissions slot cannot expose native device controls") }
        _ = try js("document.querySelector('.app-settings__page').innerHTML='<header><h1>Computer</h1></header><div>Cloud status</div>'")
        try wait("Computer remains the single device access surface") { embedded() }
        if CommandLine.arguments.count > 2,
           let native = web.subviews.first(where: { String(describing: type(of: $0)) == "MacControlSettingsClip" }),
           let bitmap = native.bitmapImageRepForCachingDisplay(in: native.bounds) {
            native.cacheDisplay(in: native.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [:]) {
                try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
            }
        }
        host.hide()
        web.loadHTMLString("<div class='app-settings__page'><h1>Computer</h1></div>", baseURL: URL(string: "https://different-server.invalid")!)
        try wait("Foreign page loads") { !web.isLoading }
        _ = try js("document.documentElement.style.padding='1px'")
        // Give the foreign-origin message time to arrive, then require no native surface.
        let end = Date().addingTimeInterval(0.5)
        while Date() < end { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
        guard !embedded() else { throw Failure.check("Different-server content must not place native controls") }
        print("PASS: inline placement, isolated handler, signed-out gating, branded font, Computer-only controls, duplicate-slot cleanup, dialogs, navigation and foreign-origin rejection")
    }
}
