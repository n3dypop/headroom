// How the notch looks and behaves: the keys the Windows and Mac clients share in desktop.json, beside the server and its token.
// A key with a value of the wrong type, or a value this client doesn't know, goes back to its default on its own (the others
// stay as they are).

import Foundation

/** How large the notch is drawn */
public enum NotchSize: String, CaseIterable {
    case small, normal, large

    /** The scale the whole notch is drawn at */
    public var scale: Double {
        switch self {
        case .small: return 0.85
        case .normal: return 1.0
        case .large: return 1.2
        }
    }
}

/** The notch's colors: the system's light or dark look, dark, light, or glass */
public enum Theme: String, CaseIterable {
    case system, dark, light, glass
}

/** The glass's tint (light has dark text) */
public enum GlassTint: String, CaseIterable {
    case clear, dark, light
}

/** What opens the folded notch: the pointer touching the nub, or a click on it */
public enum OpenOn: String, CaseIterable {
    case hover, click
}

/** How long the notch waits after the pointer leaves */
public enum FoldDelay: String, CaseIterable {
    case short, normal, long

    /** Seconds until the notch folds */
    public var foldSeconds: Double {
        switch self {
        case .short: return 0.2
        case .normal: return 0.45
        case .long: return 1.5
        }
    }

    /** Seconds until the card goes */
    public var cardSeconds: Double {
        switch self {
        case .short: return 0.12
        case .normal: return 0.25
        case .long: return 1.0
        }
    }
}

/** The notch's look and behaviour, as kept in desktop.json */
public struct Prefs: Equatable {
    /** The screen the notch goes on ("screen:<NSScreenNumber>" here, "\\.\DISPLAYn" on Windows); empty for the screen furthest
     * right. A screen that isn't connected counts as empty, and the value is kept */
    public var display = ""
    /** Where along the edge, 0 (top) to 100 (bottom) */
    public var position = 50
    public var size = NotchSize.normal
    public var theme = Theme.dark
    /** Windows only (whether its glass reads the screen behind it): kept and written back, not used here */
    public var glassBackdrop = true
    public var glassTint = GlassTint.clear
    public var openOn = OpenOn.hover
    public var foldDelay = FoldDelay.normal
    /** Animate opening, folding and moving the card (off: they happen at once) */
    public var motion = true
    /** Leave other apps' full-screen spaces to them */
    public var hideFullscreen = true

    /** The keys, as written in desktop.json */
    public static let keys = ["display", "position", "size", "theme", "glass_backdrop", "glass_tint", "open_on", "fold_delay", "motion",
                              "hide_fullscreen"]

    public init() {}

    /** From the settings file's object: each key on its own (a missing one, one of the wrong type or an unknown value is the default) */
    public init(json o: [String: JSON]) {
        func pick<E: RawRepresentable>(_ key: String, _ fallback: E) -> E where E.RawValue == String {
            o[key]?.string.flatMap(E.init(rawValue:)) ?? fallback
        }
        func flag(_ key: String, _ fallback: Bool) -> Bool {
            o[key]?.bool ?? fallback
        }
        // A screen's name is short (as the Windows client takes it: 64 at most)
        display = o["display"]?.string.flatMap { $0.utf8.count <= 64 ? $0 : nil } ?? ""
        // A whole number from 0 to 100
        if let n = o["position"]?.number, n.rounded() == n, n >= 0, n <= 100 { position = Int(n) }
        size = pick("size", NotchSize.normal)
        theme = pick("theme", Theme.dark)
        glassBackdrop = flag("glass_backdrop", true)
        glassTint = pick("glass_tint", GlassTint.clear)
        openOn = pick("open_on", OpenOn.hover)
        foldDelay = pick("fold_delay", FoldDelay.normal)
        motion = flag("motion", true)
        hideFullscreen = flag("hide_fullscreen", true)
    }

    /** As the settings file's keys */
    public var json: [String: JSON] {
        [
            "display": .string(display),
            "position": .number(Double(position)),
            "size": .string(size.rawValue),
            "theme": .string(theme.rawValue),
            "glass_backdrop": .bool(glassBackdrop),
            "glass_tint": .string(glassTint.rawValue),
            "open_on": .string(openOn.rawValue),
            "fold_delay": .string(foldDelay.rawValue),
            "motion": .bool(motion),
            "hide_fullscreen": .bool(hideFullscreen),
        ]
    }
}
