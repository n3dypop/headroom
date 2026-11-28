// The server's address and the view's URL. Only an https origin is accepted: the token is sent to no other place.

import Foundation

/** The server's origin from what the user typed: https only, host (and port) only, no user info, path, query or fragment.
 * nil when it isn't one */
public func normalizeBaseURL(_ input: String) -> String? {
    var s = Substring(input.trimmingCharacters(in: .whitespaces))
    while s.hasSuffix("/") { s = s.dropLast() }
    guard s.count >= 8, s.prefix(8).lowercased() == "https://" else { return nil }
    let rest = s.dropFirst(8)
    if rest.isEmpty || rest.contains(where: { "/?#@ \\".contains($0) }) { return nil }
    // A port is 1 to 65535, written once (an out-of-range one would send the request to 443 instead); 443 is the default
    var host = rest
    var port: Int?
    if let colon = rest.lastIndex(of: ":") {
        let p = rest[rest.index(after: colon)...]
        guard !p.isEmpty, p.count <= 5, p.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(p), (1...65535).contains(n) else { return nil }
        host = rest[..<colon]
        port = n == 443 ? nil : n
    }
    let labelsOK = !host.isEmpty && host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
        !label.isEmpty && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
    guard labelsOK else { return nil }
    let h = host.lowercased()
    return port.map { "https://\(h):\($0)" } ?? "https://\(h)"
}

/** The view's URL for this Mac's time zone */
public func viewURL(_ base: String, _ tz: String) -> String {
    var out = ""
    for b in tz.utf8 {
        switch b {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "~"):
            out.append(Character(UnicodeScalar(b)))
        default:
            out += String(format: "%%%02X", b)
        }
    }
    return "\(base)/v2/view?tz=\(out)"
}
