// Reading the view: GET only, https only, the token in the Authorization header only, no redirects followed.

import Foundation
import HeadroomKit

private let USER_AGENT = "headroom-desktop/0.1.0"
/** A view is a few kilobytes; anything far larger is not one */
private let MAX_BODY_BYTES = 2 * 1024 * 1024

/** Refuses every redirect (the token is never sent anywhere else) */
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 20
    config.httpCookieStorage = nil
    config.urlCache = nil
    return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
}()

/** Reads the view (on the reading thread; it waits for the answer) */
func readView(base: String, token: String, tz: String) -> Result<JSON, ReadError> {
    // Only to an https origin, checked again right before sending the token
    guard normalizeBaseURL(base) == base, let url = URL(string: viewURL(base, tz)), url.scheme == "https" else { return .failure(.notSetUp) }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(USER_AGENT, forHTTPHeaderField: "User-Agent")
    let done = DispatchSemaphore(value: 0)
    var out: Result<JSON, ReadError> = .failure(.network)
    let task = session.dataTask(with: request) { data, response, error in
        defer { done.signal() }
        guard error == nil, let http = response as? HTTPURLResponse else { return }
        switch http.statusCode {
        case 200:
            guard let data, data.count <= MAX_BODY_BYTES, let body = JSON.parse(data), body.object != nil else {
                out = .failure(.badBody)
                return
            }
            out = .success(body)
        case 401, 403: out = .failure(.tokenRejected)
        case 404: out = .failure(.notFound)
        case 429, 503: out = .failure(.busy)
        default: out = .failure(.server(http.statusCode))
        }
    }
    task.resume()
    done.wait()
    return out
}
