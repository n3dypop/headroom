// The providers' icons: PNGs the user put in ~/Library/Application Support/Headroom/icons/ (the vendors' logos aren't shipped),
// and a second set in icons/alt/ that the settings can choose per provider, as the widget's Display settings do.

import AppKit
import HeadroomKit

struct ProviderIcons {
    var first: [String: NSImage] = [:]
    var second: [String: NSImage] = [:]

    /** Both sets, read again from the folders (on the main thread: a few small files) */
    static func load() -> ProviderIcons {
        var icons = ProviderIcons()
        for p in PROVIDER_ORDER {
            if let i = read(p, alt: false) { icons.first[p] = i }
            if let i = read(p, alt: true) { icons.second[p] = i }
        }
        return icons
    }

    /** One icon: a PNG of MAX_ICON_BYTES at most (its size is checked before it is read), with a size to draw at */
    private static func read(_ provider: String, alt: Bool) -> NSImage? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let url = dir.appendingPathComponent("Headroom/icons/\(alt ? "alt/" : "")\(provider).png")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let bytes = attributes[.size] as? NSNumber, bytes.intValue <= MAX_ICON_BYTES,
              let data = try? Data(contentsOf: url), usableIcon(data),
              let image = NSImage(data: data), image.size.width > 0, image.size.height > 0
        else { return nil }
        return image
    }

    /** The providers that have a second icon, in PROVIDER_ORDER's order (only these can be switched) */
    var withSecond: [String] {
        PROVIDER_ORDER.filter { second[$0] != nil }
    }

    /** The icon drawn for a provider: its second when chosen and there, else its first (nil: none, the letters are drawn) */
    func icon(_ provider: String, prefs: Prefs) -> NSImage? {
        if prefs.usesAltIcon(provider), let i = second[provider] { return i }
        return first[provider]
    }
}
