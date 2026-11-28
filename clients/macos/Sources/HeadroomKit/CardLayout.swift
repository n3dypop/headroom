// How a card is laid out in the window's height (points): the same rules as the Windows client's notch.rs.

/** A limit's row; a scroll step */
public let ROW_H = 10.0 + 16.2 + 5.0 + 5.0 + 4.0 + 14.85
/** The line for moving the rows up or down */
public let MORE_LINE = 10.0 + 16.2
/** The shortest window in which a card's rows scroll (below it the card says the rows are in the menu) */
public let MIN_SCROLL_WIN_H = 300.0

/** A row of a card: a limit (heading, bar, what is left) or a limit the provider hasn't (heading only) */
public func rowHeight(_ r: CardRow) -> Double {
    if case .limit = r { return 10.0 + 16.2 + 5.0 + 5.0 + 4.0 + 14.85 }
    return 10.0 + 16.2
}

/** Whether a card's rows scroll, how far they are scrolled and can be, their room, the card's height, and whether the rows are left
 * to the menu (a window too short for them) */
public struct CardFit: Equatable {
    public var scrolls: Bool
    public var offset: Double
    public var max: Double
    public var area: Double
    public var h: Double
    public var notice: Bool
}

/** The heading, the footer and the lines for rows above and below get their room first; the rows scroll by points in what is left */
public func cardFit(_ cell: Cell?, winH: Double, scroll: Double) -> CardFit {
    var fixed = 1.0 + 12.0 + 18.9 + 11.0 + 1.0 + 8.0 + 14.85 + 13.0 + 1.0
    guard let c = cell else { return CardFit(scrolls: false, offset: 0, max: 0, area: 0, h: fixed, notice: false) }
    if c.message != nil { fixed += 8.0 + 16.2 }
    let room = winH - 16.0
    let all = c.rows.map(rowHeight).reduce(0, +)
    if fixed + all <= room { return CardFit(scrolls: false, offset: 0, max: 0, area: all, h: fixed + all, notice: false) }
    // A window too short for the rows to scroll in: a notice in their place
    if winH < MIN_SCROLL_WIN_H { return CardFit(scrolls: false, offset: 0, max: 0, area: MORE_LINE, h: fixed + MORE_LINE, notice: true) }
    let area = Swift.max(room - fixed - 2.0 * MORE_LINE, ROW_H)
    let max = Swift.max(all - area, 0)
    return CardFit(scrolls: true, offset: Swift.min(Swift.max(scroll, 0), max), max: max, area: area, h: fixed + 2.0 * MORE_LINE + area, notice: false)
}
