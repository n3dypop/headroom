// What a provider's icon file may be: the same rule as the Windows client's.

import Foundation

/** The largest icon file that is read */
public let MAX_ICON_BYTES = 64 * 1024

/** Bytes that can be an icon: a PNG (by its signature) of MAX_ICON_BYTES at most */
public func usableIcon(_ data: Data) -> Bool {
    data.count <= MAX_ICON_BYTES && data.starts(with: [0x89, 0x50, 0x4E, 0x47])
}
