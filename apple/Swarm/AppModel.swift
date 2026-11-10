import AuthenticationServices
import Combine
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class AppModel: NSObject, ObservableObject {
    @Published var server: ServerAddress
    @Published var loading = true
    @Published var failure: String?
    @Published var notice: String?
    @Published var showingSettings = false
    @Published var signingIn = false
    @Published var sharedFile: SharedFile?
    let webView: WKWebView
    private var authentication: ASWebAuthenticationSession?
    private var appleAuthorization: AppleAuthorization?
    private var exchangeTask: Task<Void, Never>?
    private var downloads: [ObjectIdentifier: URL] = [:]

    static var allowsLocalHTTP: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    override init() {
        let saved = UserDefaults.standard.string(forKey: "serverAddress") ?? ServerAddress.defaultURL.absoluteString
        server = (try? ServerAddress(saved, allowLocalHTTP: Self.allowsLocalHTTP)) ?? (try! ServerAddress(ServerAddress.defaultURL.absoluteString))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        #if os(macOS)
        configuration.applicationNameForUserAgent = "SwarmNative/1.0 (macOS)"
        #else
        configuration.applicationNameForUserAgent = "SwarmNative/1.0 (iOS)"
        #endif
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #endif
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #endif
        loadHome()
    }

    func loadHome() {
        failure = nil
        loading = true
        webView.load(URLRequest(url: server.url, timeoutInterval: 30))
    }

    func reload() {
        failure = nil
        loading = true
        if let url = webView.url, server.contains(url) { webView.reload() } else { loadHome() }
    }

    func changeServer(_ value: String) throws {
        let next = try ServerAddress(value, allowLocalHTTP: Self.allowsLocalHTTP)
        guard next != server else { showingSettings = false; return }
        authentication?.cancel()
        appleAuthorization?.cancel()
        appleAuthorization = nil
        authentication = nil
        exchangeTask?.cancel()
        signingIn = false
        webView.stopLoading()
        server = next
        UserDefaults.standard.set(next.url.absoluteString, forKey: "serverAddress")
        showingSettings = false
        loadHome()
    }

    func resume() {
        // Keep unsent drafts intact while refreshing events after background suspension
        // or a connected-app authorization in the browser.
        guard let url = webView.url, server.contains(url) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('swarm:resume'))", completionHandler: nil)
    }

    func clearWebsiteData() {
        authentication?.cancel()
        appleAuthorization?.cancel()
        appleAuthorization = nil
        authentication = nil
        exchangeTask?.cancel()
        signingIn = false
        Task {
            await webView.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            loadHome()
        }
    }

    func openExternal(_ url: URL) {
        guard ["https", "http", "mailto", "tel", "sms"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }

    func signIn() {
        guard !signingIn else { return }
        do {
            let attempt = try SignInAttempt()
            let address = server
            signingIn = true
            let session = ASWebAuthenticationSession(url: attempt.startURL(server: address.url), callbackURLScheme: SignInAttempt.callbackScheme) { [weak self] callback, error in
                Task { @MainActor in
                    guard let self else { return }
                    self.authentication = nil
                    guard self.server == address else { self.signingIn = false; return }
                    if let error {
                        self.signingIn = false
                        if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin { self.notice = error.localizedDescription }
                        return
                    }
                    guard let callback else { self.signingIn = false; return }
                    self.exchangeTask = Task { await self.exchange(attempt, callback: callback, address: address) }
                }
            }
            authentication = session
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            if !session.start() {
                signingIn = false
                authentication = nil
                notice = "Couldn’t open the sign-in browser. Please try again."
            }
        } catch { signingIn = false; notice = error.localizedDescription }
    }

    private func installSession(from http: HTTPURLResponse, url: URL) async throws {
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields { headers[String(describing: key)] = String(describing: value) }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        guard let cookie = cookies.first(where: { $0.name == "swarm_session" && $0.isHTTPOnly }) else { throw SignInAttempt.SignInError.exchange }
        await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
    }

    private func appleRequest(path: String, body: [String: Any], address: ServerAddress, includeSession: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let url = address.url.appendingPathComponent("api/auth/apple/\(path)")
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        if includeSession {
            let cookies = await webView.configuration.websiteDataStore.httpCookieStore.allCookies()
            if let cookie = cookies.first(where: { $0.name == "swarm_session" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == address.url.host }) {
                request.setValue("swarm_session=\(cookie.value)", forHTTPHeaderField: "Cookie")
            }
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard server == address, let http = response as? HTTPURLResponse,
              let responseURL = http.url, address.contains(responseURL) else { throw SignInAttempt.SignInError.invalid }
        if http.statusCode != 200 {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw NSError(domain: "SwarmAppleSignIn", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: AppleAuthorization.message(for: error?["error"] as? String)])
        }
        return (data, http)
    }

    func signInWithApple(linking: Bool) {
        guard !signingIn else { return }
        signingIn = true
        let address = server
        exchangeTask = Task { [self] in
            do {
                let attempt = try SignInAttempt()
                #if os(macOS)
                let client = "macos"
                #else
                let client = "ios"
                #endif
                let (data, _) = try await appleRequest(path: "native/start", body: ["client": client, "challenge": attempt.challenge, "intent": linking ? "link" : "signin"], address: address, includeSession: linking)
                struct Start: Decodable { let attempt: String; let nonce: String }
                let pending = try JSONDecoder().decode(Start.self, from: data)
                try Task.checkCancellation()
                guard server == address else { return }
                #if os(macOS)
                let anchor = webView.window ?? NSApplication.shared.keyWindow ?? ASPresentationAnchor()
                #else
                let anchor = webView.window ?? ASPresentationAnchor()
                #endif
                appleAuthorization = AppleAuthorization(nonce: pending.nonce, state: attempt.state, anchor: anchor) { [weak self] result in
                    guard let self else { return }
                    self.appleAuthorization = nil
                    guard self.server == address else { self.signingIn = false; return }
                    switch result {
                    case .failure(let error):
                        self.signingIn = false
                        if (error as? ASAuthorizationError)?.code != .canceled { self.notice = error.localizedDescription }
                    case .success(let credential):
                        self.exchangeTask = Task {
                            defer { self.signingIn = false }
                            do {
                                var body: [String: Any] = ["attempt": pending.attempt, "verifier": attempt.verifier, "code": credential.code]
                                if let name = credential.name { body["name"] = name }
                                let (_, response) = try await self.appleRequest(path: "native/complete", body: body, address: address)
                                try await self.installSession(from: response, url: address.url)
                                try Task.checkCancellation()
                                guard self.server == address else { return }
                                self.loadHome()
                            } catch is CancellationError {} catch { self.notice = error.localizedDescription }
                        }
                    }
                }
                appleAuthorization?.start()
            } catch is CancellationError { signingIn = false }
            catch { signingIn = false; notice = error.localizedDescription }
        }
    }

    private func exchange(_ attempt: SignInAttempt, callback: URL, address: ServerAddress) async {
        defer { signingIn = false }
        do {
            let code = try attempt.code(from: callback)
            let url = address.url.appendingPathComponent("api/auth/native/exchange")
            var request = URLRequest(url: url, timeoutInterval: 30)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "verifier": attempt.verifier])
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            let (_, response) = try await session.data(for: request)
            try Task.checkCancellation()
            guard server == address, let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let responseURL = http.url, address.contains(responseURL) else { throw SignInAttempt.SignInError.exchange }
            try await installSession(from: http, url: url)
            try Task.checkCancellation()
            guard server == address else { return }
            loadHome()
        } catch is CancellationError {
            // Switching servers or clearing local data cancels the pending handoff.
        } catch { notice = error.localizedDescription }
    }
}

extension AppModel: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return webView.window ?? NSApplication.shared.keyWindow ?? ASPresentationAnchor()
        #else
        return webView.window ?? ASPresentationAnchor()
        #endif
    }
}

extension AppModel: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if server.contains(url) {
            if url.path == "/api/auth/google/start" && action.targetFrame?.isMainFrame != false {
                decisionHandler(.cancel)
                signIn()
            } else if url.path == "/api/auth/apple/start" && action.targetFrame?.isMainFrame != false {
                decisionHandler(.cancel)
                let linking = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "intent" && $0.value == "link" }) == true
                signInWithApple(linking: linking)
            } else if action.shouldPerformDownload {
                decisionHandler(.download)
            } else { decisionHandler(.allow) }
        } else if url.scheme == "blob", action.shouldPerformDownload {
            decisionHandler(.download)
        } else {
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated || action.targetFrame == nil { openExternal(url) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            loading = false
            failure = "The server returned an error (\(http.statusCode)). Try again, or check your server address."
            decisionHandler(.cancel)
        } else { decisionHandler(response.canShowMIMEType ? .allow : .download) }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false; failure = nil }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reload() }

    private func failed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { loading = false; return }
        loading = false
        failure = "Couldn’t reach Swarm. Check your connection and server address, then try again."
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if server.contains(url) { webView.load(action.request) } else { openExternal(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let originURL = URL(string: "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")")
        decisionHandler(originURL.map(server.contains) == true && frame.isMainFrame && type == .microphone ? .prompt : .deny)
    }

    #if os(macOS)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let url = frame.request.url, server.contains(url) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    #endif
}

extension AppModel: WKDownloadDelegate {
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        #if os(macOS)
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.begin { response in completionHandler(response == .OK ? panel.url : nil) }
        #else
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(name.isEmpty ? "Swarm download" : name)
            downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        } catch { notice = error.localizedDescription; completionHandler(nil) }
        #endif
    }

    func downloadDidFinish(_ download: WKDownload) {
        loading = false
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { sharedFile = SharedFile(url: url) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        loading = false
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        notice = "The download couldn’t finish. Please try again."
    }
}

struct SharedFile: Identifiable { let id = UUID(); let url: URL }
