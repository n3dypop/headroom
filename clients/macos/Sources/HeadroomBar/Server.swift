// Reading the view: GET only, https only, the token in the Authorization header only, no redirects followed. The answer is taken
// as it arrives: anything but 200 is stopped at its headers, and a body past 2 MB is stopped there.

import Foundation
import HeadroomKit

private let USER_AGENT = "headroom-desktop/0.1.0"
/** A view is a few kilobytes; anything far larger is not one */
private let MAX_BODY_BYTES = 2 * 1024 * 1024

/** One read: collects the body up to the bound, refuses redirects, and tells the waiting thread when it is over */
private final class Reading: NSObject, URLSessionDataDelegate {
    private let done = DispatchSemaphore(value: 0)
    private var body = Data()
    var result: Result<JSON, ReadError> = .failure(.network)

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            result = .failure(.network)
            return completionHandler(.cancel)
        }
        switch http.statusCode {
        case 200:
            if http.expectedContentLength > Int64(MAX_BODY_BYTES) {
                result = .failure(.badBody)
                return completionHandler(.cancel)
            }
            completionHandler(.allow)
            return
        case 401, 403: result = .failure(.tokenRejected)
        case 404: result = .failure(.notFound)
        case 429, 503: result = .failure(.busy)
        default: result = .failure(.server(http.statusCode))
        }
        // Not a view: its body isn't read
        completionHandler(.cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        body.append(data)
        if body.count > MAX_BODY_BYTES {
            result = .failure(.badBody)
            body = Data()
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { done.signal() }
        // A refusal or a stop decided above stays as it is
        guard case .failure(.network) = result else { return }
        guard error == nil, let http = task.response as? HTTPURLResponse, http.statusCode == 200 else { return }
        if let json = JSON.parse(body), json.object != nil {
            result = .success(json)
        } else {
            result = .failure(.badBody)
        }
    }

    func wait() {
        done.wait()
    }
}

/** Reads the view (on the reading thread; it waits for the answer) */
func readView(base: String, token: String, tz: String) -> Result<JSON, ReadError> {
    // Only to an https origin, checked again right before sending the token
    guard normalizeBaseURL(base) == base, let url = URL(string: viewURL(base, tz)), url.scheme == "https" else { return .failure(.notSetUp) }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(USER_AGENT, forHTTPHeaderField: "User-Agent")
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 20
    config.httpCookieStorage = nil
    config.urlCache = nil
    let reading = Reading()
    let session = URLSession(configuration: config, delegate: reading, delegateQueue: nil)
    session.dataTask(with: request).resume()
    reading.wait()
    session.finishTasksAndInvalidate()
    return reading.result
}
