import SwiftUI
import WebKit

/// Embeds the Tiger Cowork web UI in a native WebView
struct TigerCoworkWebView: NSViewRepresentable {
    let host: String
    let port: Int

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Allow local network access
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        // Enable dev tools in debug builds
        #if DEBUG
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator

        // Load Tiger Cowork at the VM's IP
        let url = URL(string: "http://\(host):\(port)")!
        webView.load(URLRequest(url: url))

        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        // Reload if port changed
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            // Retry after a short delay if service isn't ready yet
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                webView.reload()
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                if let url = webView.url ?? URL(string: "http://localhost:3001") {
                    webView.load(URLRequest(url: url))
                }
            }
        }

        // Block navigation to external URLs — security sandbox
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            // Allow localhost and VM subnet connections
            if url.host == "localhost" || url.host == "127.0.0.1" || (url.host?.hasPrefix("192.168.") == true) {
                decisionHandler(.allow)
            } else if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
                decisionHandler(.allow)
            } else {
                // Open external URLs in default browser
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            }
        }
    }
}
