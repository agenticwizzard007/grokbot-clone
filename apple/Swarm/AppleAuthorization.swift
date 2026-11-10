import AuthenticationServices
import Foundation

/// Owns one Apple system authorization sheet; no Apple credentials are exposed to JavaScript.
@MainActor
final class AppleAuthorization: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    struct Result { let code: String; let name: String? }
    private let anchor: ASPresentationAnchor
    private let state: String
    private var completion: ((Swift.Result<Result, Error>) -> Void)?
    private var controller: ASAuthorizationController?

    init(nonce: String, state: String, anchor: ASPresentationAnchor, completion: @escaping (Swift.Result<Result, Error>) -> Void) {
        self.anchor = anchor
        self.state = state
        self.completion = completion
        super.init()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = nonce
        request.state = state
        controller = ASAuthorizationController(authorizationRequests: [request])
        controller?.delegate = self
        controller?.presentationContextProvider = self
    }

    func start() { controller?.performRequests() }
    func cancel() { completion = nil; controller?.delegate = nil; controller = nil }
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor { anchor }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              credential.state == state, let data = credential.authorizationCode,
              let code = String(data: data, encoding: .utf8), !code.isEmpty else {
            finish(.failure(SignInAttempt.SignInError.invalid)); return
        }
        let name = credential.fullName.map { PersonNameComponentsFormatter().string(from: $0) }
        finish(.success(Result(code: code, name: name)))
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) { finish(.failure(error)) }
    private func finish(_ result: Swift.Result<Result, Error>) {
        let callback = completion
        completion = nil
        controller = nil
        callback?(result)
    }

    static func message(for code: String?) -> String {
        switch code {
        case "apple_unavailable": return "Apple sign-in is not configured on this server yet. You can use Google or phone sign-in."
        case "apple_link_required": return "You already have a Swarm account with this email. Sign in with Google or phone, then connect Apple in Settings → Account."
        case "apple_link_signin": return "Sign in to your existing Swarm account before connecting Apple."
        case "apple_already_linked": return "This Apple Account is already connected to a different Swarm account, or this Swarm account already has Apple connected."
        case "apple_email_required": return "Apple didn’t provide a verified email. Review Swarm’s access in your Apple Account and try again."
        default: return "Apple sign-in could not be completed. Please try again."
        }
    }
}
