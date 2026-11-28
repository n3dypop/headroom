// Which screen the notch goes on: the same rule as the Windows client's notch.rs. And where along the edge it sits.

/** Of the screens' right edges (the first is the menu bar's screen, as in NSScreen.screens), the one the notch goes on: the one
 * reaching furthest right, so no screen is right of it and the pointer stops at its edge; the first among those that reach as far
 * (screens stacked one above the other) */
public func rightmostScreen(rightEdges: [Double]) -> Int? {
    guard let right = rightEdges.max() else { return nil }
    return rightEdges.firstIndex(of: right)
}

/** How the settings name a screen: by its NSScreenNumber */
public func screenKey(_ number: UInt32) -> String {
    "screen:\(number)"
}

/** The screen the settings chose (`keys` in the order of `rightEdges`, nil for a screen without a number); the one furthest right
 * when none was chosen or the chosen one isn't connected */
public func chosenScreen(display: String, keys: [String?], rightEdges: [Double]) -> Int? {
    if !display.isEmpty, let i = keys.firstIndex(where: { $0 == display }), i < rightEdges.count { return i }
    return rightmostScreen(rightEdges: rightEdges)
}

/** Where the notch sits along the edge */
public struct NotchPlace: Equatable {
    /** The window's bottom above the bottom of the screen's usable area */
    public var windowY: Double
    /** The pill's top below the window's top */
    public var pillY: Double
}

/** The room the pill keeps from the window's top and bottom at either end of the edge */
public let PLACE_MARGIN = 12.0

/** From the position (0 top, 50 the middle, 100 bottom): the window moves along the screen's usable area and the pill along the
 * window, by the same share; at the ends the pill keeps PLACE_MARGIN from the window's edge. At 50 both are centred exactly (a
 * pill too tall for the margins stays centred whatever the position). The area's height, the window's and the pill's are in the
 * same units */
public func notchPlace(areaHeight: Double, winH: Double, pillH: Double, position: Int) -> NotchPlace {
    let p = Double(min(100, max(0, position))) / 100
    let room = max(0, areaHeight - winH)
    // Written as the middle plus a share, so the middle is the centred layout to the last bit
    let windowY = room / 2 + (0.5 - p) * room
    let span = winH - pillH - 2 * PLACE_MARGIN
    let pillY = (winH - pillH) / 2 + (span > 0 ? (p - 0.5) * span : 0)
    return NotchPlace(windowY: windowY, pillY: pillY)
}
