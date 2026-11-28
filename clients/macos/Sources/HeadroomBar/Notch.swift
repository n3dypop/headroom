// The notch: a pill against the right edge of the screen with one ring per provider, folded to a small nub until the pointer
// touches it, and a card beside the ring under the pointer. A clear panel that lets the pointer through everywhere but what is
// drawn; the pointer is followed with mouse monitors (no permission is needed for mouse movement). Sizes, colors and timings are
// the Windows client's (points here). The settings choose its screen, its place along the edge, its size, its colors (dark, light,
// the system's, or glass) and how it opens and folds.

import AppKit
import HeadroomKit

// The layout, in points (the Windows client's DIPs) at the normal size
private let WIN_W: CGFloat = 380
private let WIN_H: CGFloat = 660
private let PILL_W: CGFloat = 64
private let FLARE: CGFloat = 22
private let PILL_PAD: CGFloat = FLARE + 14
private let CELL_GAP: CGFloat = 12
private let RING_PX: CGFloat = 44
private let PCT_GAP: CGFloat = 4
private let PCT_LINE: CGFloat = 16
private let CELL_H: CGFloat = RING_PX + PCT_GAP + PCT_LINE
private let CARD_W: CGFloat = 252
private let CARD_RIGHT: CGFloat = PILL_W + 14
/** The ring's own units (its drawing is 48 across, shown at 44) */
private let VB: CGFloat = 48
private let RING_R: CGFloat = 19
private let RING_STROKE: CGFloat = 5
private let OUTER_R: CGFloat = 23.4
private let OUTER_STROKE: CGFloat = 1.6
private let ICON_BOX: CGFloat = 19
private let NUB_W: CGFloat = 7
private let NUB_H: CGFloat = 64
/** The margin around what is drawn that keeps the pointer (the folded nub's is wider, to catch it) */
private let HOT_PAD: CGFloat = 6
private let NUB_HOT_W: CGFloat = 14
/** The rounding of the pill's left corners and of the card */
private let PILL_RADIUS: CGFloat = 18
private let CARD_RADIUS: CGFloat = 14
/** How far the pill's glass reaches past the screen's edge (so only its left corners are round) */
private let GLASS_PAST_EDGE: CGFloat = 40

private let RECENT = "#6B7280"
private let MARKS = ["claude": "Cl", "codex": "Cx", "gemini": "Ge"]

private let FOLD_S = 0.34
private let CARD_MOVE_S = 0.26
/** How long "Next read in N min" stays after a click */
private let NOTE_S = 4.0

func color(_ hex: String, _ a: CGFloat = 1) -> NSColor {
    let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
    return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: a)
}

/** A color made more transparent (its own alpha times `a`) */
private func fade(_ c: NSColor, _ a: CGFloat) -> NSColor {
    c.withAlphaComponent(c.alphaComponent * a)
}

/** The colors a theme draws with */
private struct Palette {
    var ink: NSColor
    var ink2: NSColor
    var dim: NSColor
    var warn: NSColor
    /** The ring's track and the outer ring's */
    var track: NSColor
    var outerTrack: NSColor
    var card: NSColor
    /** The card's border, its separator and its bars' track */
    var cardLine: NSColor
    /** The card's tail pointing at the ring */
    var tail: NSColor
    var nub: NSColor
    var pill: NSColor
}

private let DARK = Palette(ink: color("#ffffff"), ink2: color("#c9c9ce"), dim: color("#8e8e93"), warn: color("#ffd60a"), track: color("#2a2a2d"),
                           outerTrack: color("#1c1c1f"), card: color("#0c0c0d"), cardLine: color("#26262a"), tail: color("#0c0c0d"),
                           nub: color("#3a3a3e"), pill: color("#000000"))

private let LIGHT = Palette(ink: color("#1d1d1f"), ink2: color("#3a3a3c"), dim: color("#6e6e73"), warn: color("#b26a00"), track: color("#dcdce0"),
                            outerTrack: color("#ececef"), card: color("#ffffff"), cardLine: color("#e3e3e7"), tail: color("#ffffff"),
                            nub: color("#b8b8bd"), pill: color("#f5f5f7"))

/** Over glass: white text and translucent white lines (black ones for the light tint); the pill and the card get only a thin tint
 * of their own, so the glass shows */
private func glassPalette(_ tint: GlassTint) -> Palette {
    let base: NSColor = tint == .light ? NSColor(white: 0, alpha: 1) : NSColor(white: 1, alpha: 1)
    let fill: NSColor
    let tail: NSColor
    switch tint {
    case .clear:
        fill = NSColor(white: 1, alpha: 0.06)
        tail = NSColor(white: 1, alpha: 0.24)
    case .dark:
        fill = NSColor(white: 0, alpha: 0.32)
        tail = NSColor(white: 0, alpha: 0.55)
    case .light:
        fill = NSColor(white: 1, alpha: 0.42)
        tail = NSColor(white: 1, alpha: 0.75)
    }
    return Palette(ink: base, ink2: base.withAlphaComponent(0.8), dim: base.withAlphaComponent(0.6),
                   warn: color(tint == .light ? "#b26a00" : "#ffd60a"), track: base.withAlphaComponent(0.2),
                   outerTrack: base.withAlphaComponent(0.12), card: fill, cardLine: base.withAlphaComponent(0.2), tail: tail,
                   nub: base.withAlphaComponent(0.5), pill: fill)
}

/** Whether the system's look for apps is dark */
private func systemIsDark() -> Bool {
    NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
}

private func palette(_ p: Prefs) -> Palette {
    switch p.theme {
    case .dark: return DARK
    case .light: return LIGHT
    case .system: return systemIsDark() ? DARK : LIGHT
    case .glass: return glassPalette(p.glassTint)
    }
}

/** A rounded rectangle as a mask that stretches to any size of at least twice its radius */
private func roundedMask(_ radius: CGFloat) -> NSImage {
    let side = 2 * radius + 2
    let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
}

/** The glass behind the pill or the card: Liquid Glass on macOS 26 and later, the blurred background behind the window before it */
private func makeGlass() -> NSView {
    #if compiler(>=6.2)
    if #available(macOS 26, *) {
        return NSGlassEffectView(frame: .zero)
    }
    #endif
    let v = NSVisualEffectView(frame: .zero)
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    // Never dimmed: the notch's panel is never the key window
    v.state = .active
    return v
}

/** Rounds a glass's corners and gives it the tint's look */
private func shapeGlass(_ v: NSView, radius: CGFloat, tint: GlassTint) {
    v.appearance = NSAppearance(named: tint == .light ? .aqua : .darkAqua)
    #if compiler(>=6.2)
    if #available(macOS 26, *), let g = v as? NSGlassEffectView {
        g.cornerRadius = radius
        switch tint {
        case .clear: g.tintColor = nil
        case .dark: g.tintColor = NSColor(white: 0, alpha: 0.35)
        case .light: g.tintColor = NSColor(white: 1, alpha: 0.45)
        }
        return
    }
    #endif
    if let e = v as? NSVisualEffectView {
        e.maskImage = roundedMask(radius)
    }
}

/** cubic-bezier(.32, .72, .24, 1): quick at first, then settling (the fold and the card) */
private func ease(_ t0: Double) -> Double {
    let (x1, y1, x2, y2) = (0.32, 0.72, 0.24, 1.0)
    let t = min(1, max(0, t0))
    func bez(_ a: Double, _ b: Double, _ s: Double) -> Double { 3 * a * s * pow(1 - s, 2) + 3 * b * s * s * (1 - s) + pow(s, 3) }
    var (lo, hi) = (0.0, 1.0)
    for _ in 0..<24 {
        let mid = (lo + hi) / 2
        if bez(x1, x2, mid) < t { lo = mid } else { hi = mid }
    }
    return bez(y1, y2, (lo + hi) / 2)
}

/** A value moving from one place to another over a time */
private struct Anim {
    var from: Double
    var to: Double
    var start = Date()
    let seconds: Double

    var progress: Double { min(1, max(0, Date().timeIntervalSince(start) / seconds)) }
    var value: Double { from + (to - from) * ease(progress) }
    var moving: Bool { from != to && progress < 1 }

    mutating func go(_ target: Double) {
        if target != to {
            from = value
            to = target
            start = Date()
        }
    }

    mutating func jump(_ v: Double) {
        from = v
        to = v
    }
}

/** The size an icon of that shape is drawn at in place of a square of side `box`: the widget's iconBox */
private func iconBox(_ aspect: CGFloat, _ box: CGFloat) -> CGSize {
    let ar = aspect.isFinite && aspect > 0 ? aspect : 1
    if ar < 1 { return CGSize(width: box * ar, height: box) }
    let w = min(box * ar.squareRoot(), box * 1.5)
    return CGSize(width: w, height: w / ar)
}

/** The screen's number, as the settings name it */
func screenKey(of screen: NSScreen) -> String? {
    screenNumber(of: screen).map { HeadroomKit.screenKey($0) }
}

/** The screen's NSScreenNumber (its CGDirectDisplayID) */
func screenNumber(of screen: NSScreen) -> UInt32? {
    (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
}

/** Whether the glass theme gets the system's Liquid Glass here (macOS 26 and an app built for it); a blurred background if not */
func liquidGlassAvailable() -> Bool {
    #if compiler(>=6.2)
    if #available(macOS 26, *) { return true }
    #endif
    return false
}

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/** The panel's content: the glass (when the theme has it) under the drawing. Laid out in the panel's own points */
final class NotchRoot: NSView {
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
}

final class NotchController {
    private let app: AppState
    private let panel: NotchPanel
    private let root: NotchRoot
    private let view: NotchView
    private var cells: [Cell] = []
    private var footer: (String, Bool) = ("", false)
    private var note: (String, Date)?
    private var fold: Anim
    private var card: Int?
    private var cardTop = Anim(from: 0, to: 0, seconds: CARD_MOVE_S)
    private var cardScroll = 0.0
    private var inside = false
    private var pinned: Bool
    /** The window's height in the notch's own points (at the normal size) */
    private var winH = WIN_H
    /** The height of the screen's usable area, in the same points */
    private var areaH = WIN_H
    /** How much larger than the normal size the notch is drawn: the view's bounds stay in normal-size points */
    private var scale: CGFloat = 1
    private var prefs = Prefs()
    private var pal = DARK
    private var pillGlass: NSView?
    private var cardGlass: NSView?
    /** Both sets of the providers' icons (the prefs say which is drawn) */
    private var icons = ProviderIcons()
    private var animTimer: Timer?
    private var tickTimer: Timer?
    private var foldTimer: Timer?
    private var cardTimer: Timer?
    private var monitors: [Any] = []
    private var appearanceWatch: NSKeyValueObservation?
    /** The display the notch is on (for the check whether a window covers it) */
    private var displayID: CGDirectDisplayID?
    /** Checks about once a second whether another app covers the notch's screen (while full-screen hiding is on) */
    private var coverTimer: Timer?
    /** Hidden (ordered out) because the frontmost app covers the whole screen */
    private var covered = false
    /** Where the card and its up and down lines were last drawn (for the wheel and clicks) */
    fileprivate var cardBox: CGRect?
    fileprivate var upBox: CGRect?
    fileprivate var downBox: CGRect?
    var onTray: ((Tray) -> Void)?

    init(app: AppState, pinned: Bool) {
        self.app = app
        self.pinned = pinned
        fold = Anim(from: pinned ? 1 : 0, to: pinned ? 1 : 0, seconds: FOLD_S)
        card = pinned ? 0 : nil
        panel = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: WIN_W, height: WIN_H), styleMask: [.borderless, .nonactivatingPanel],
                           backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.acceptsMouseMovedEvents = true
        root = NotchRoot(frame: NSRect(x: 0, y: 0, width: WIN_W, height: WIN_H))
        view = NotchView(frame: NSRect(x: 0, y: 0, width: WIN_W, height: WIN_H))
        view.controller = self
        root.addSubview(view)
        panel.contentView = root
        icons = ProviderIcons.load()
        applyPrefs()
        refresh()
        if !covered { panel.orderFrontRegardless() }
        // The pointer, wherever it is (global) and over the notch (local)
        if let g = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] _ in self?.pointerMoved() }) {
            monitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] e in self?.pointerMoved(); return e }) {
            monitors.append(l)
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            self?.place()
        }
        // The system's light or dark look, for the system theme
        appearanceWatch = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.appearanceChanged() }
        }
    }

    // MARK: Prefs

    /** Takes the prefs again: the screen, the place and the size, the colors, the full-screen spaces and the animations */
    func applyPrefs() {
        prefs = app.with { $0.settings.prefs }
        // Without fullScreenAuxiliary the panel stays out of other apps' full-screen spaces
        var behaviour: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        if !prefs.hideFullscreen { behaviour.insert(.fullScreenAuxiliary) }
        if panel.collectionBehavior != behaviour {
            panel.collectionBehavior = behaviour
            if panel.isVisible { panel.orderFrontRegardless() }
        }
        if !prefs.motion {
            // What is moving gets there at once
            let (foldTo, cardTo) = (fold.to, cardTop.to)
            fold.jump(foldTo)
            cardTop.jump(cardTo)
        }
        applyTheme()
        place()
        watchCover()
    }

    // MARK: Covered by another app

    /** While full-screen hiding is on, the notch goes away whenever the frontmost app covers its whole screen in the normal Space
     * (a game or a video player with a borderless window), as it stays out of full-screen Spaces */
    private func watchCover() {
        if prefs.hideFullscreen {
            if coverTimer == nil {
                coverTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkCover() }
            }
            checkCover()
        } else {
            coverTimer?.invalidate()
            coverTimer = nil
            setCovered(false)
        }
    }

    private func checkCover() {
        setCovered(screenCovered())
    }

    private func setCovered(_ now: Bool) {
        if now == covered { return }
        covered = now
        if now {
            panel.orderOut(nil)
        } else {
            panel.orderFrontRegardless()
            recheck()
        }
    }

    /** Whether the frontmost app (not this one) has an on-screen window at the normal level over the whole of the notch's screen.
     * Only each window's owner, bounds and level are read (never its name), which needs no screen-recording permission */
    private func screenCovered() -> Bool {
        guard let id = displayID, let front = NSWorkspace.shared.frontmostApplication else { return false }
        let pid = front.processIdentifier
        if pid == getpid() { return false }
        let display = CGDisplayBounds(id)
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        for w in windows {
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let bounds = w[kCGWindowBounds as String] as? NSDictionary,
                  let r = CGRect(dictionaryRepresentation: bounds as CFDictionary)
            else { continue }
            // A point either way (rounding)
            if r.insetBy(dx: -1, dy: -1).contains(display) { return true }
        }
        return false
    }

    /** Icons read again (the settings opened: files added since show up) */
    func setIcons(_ next: ProviderIcons) {
        icons = next
        redraw()
    }

    private func appearanceChanged() {
        if prefs.theme == .system { applyTheme() }
    }

    /** The colors, and the glass under the pill and the card for the glass theme */
    private func applyTheme() {
        pal = palette(prefs)
        if prefs.theme == .glass {
            if pillGlass == nil {
                let g = makeGlass()
                root.addSubview(g, positioned: .below, relativeTo: view)
                pillGlass = g
            }
            if cardGlass == nil {
                let g = makeGlass()
                root.addSubview(g, positioned: .below, relativeTo: view)
                cardGlass = g
            }
            shapeGlasses()
        } else {
            pillGlass?.removeFromSuperview()
            cardGlass?.removeFromSuperview()
            pillGlass = nil
            cardGlass = nil
        }
        redraw()
    }

    private func shapeGlasses() {
        if let g = pillGlass { shapeGlass(g, radius: PILL_RADIUS * scale, tint: prefs.glassTint) }
        if let g = cardGlass { shapeGlass(g, radius: CARD_RADIUS * scale, tint: prefs.glassTint) }
    }

    // MARK: Layout

    private var count: Int { max(1, cells.count) }
    private var pillH: CGFloat { 2 * PILL_PAD + CGFloat(count) * CELL_H + CGFloat(count - 1) * CELL_GAP }
    private var pillX: CGFloat { WIN_W - PILL_W }
    /** Along the window by the position (centred at 50) */
    private var pillY: CGFloat {
        CGFloat(notchPlace(areaHeight: Double(areaH), winH: Double(winH), pillH: Double(pillH), position: prefs.position).pillY)
    }
    /** The nub sits at the pill's middle */
    private var nubMid: CGFloat { pillY + pillH / 2 }
    private func cellTop(_ i: Int) -> CGFloat { pillY + PILL_PAD + CGFloat(i) * (CELL_H + CELL_GAP) }
    private func ringCentre(_ i: Int) -> CGFloat { cellTop(i) + RING_PX / 2 }

    /** The cell under a point of the pill (the rows meet halfway across the gaps) */
    private func cellAt(_ p: CGPoint) -> Int? {
        if p.x < pillX { return nil }
        return (0..<count).first { i in
            let top = cellTop(i)
            return p.y >= top - CELL_GAP / 2 && p.y < top + CELL_H + CELL_GAP / 2
        }
    }

    private func fit(_ i: Int) -> CardFit {
        cardFit(cells.indices.contains(i) ? cells[i] : nil, winH: Double(winH), scroll: cardScroll)
    }

    private func cardTarget(_ i: Int) -> CGFloat {
        let h = CGFloat(fit(i).h)
        return max(8, min(winH - h - 8, ringCentre(min(i, count - 1)) - h / 2))
    }

    /** Against the right edge of the chosen screen's visible area (beside the Dock and under the menu bar), or of the screen nothing
     * is right of when none is chosen or the chosen one isn't connected; along the edge by the position, at the size chosen */
    func place() {
        let screens = NSScreen.screens
        guard let i = chosenScreen(display: prefs.display, keys: screens.map { screenKey(of: $0) }, rightEdges: screens.map { Double($0.frame.maxX) })
        else { return }
        let area = screens[i].visibleFrame
        displayID = screenNumber(of: screens[i])
        let s = CGFloat(prefs.size.scale)
        scale = s
        areaH = area.height / s
        winH = min(WIN_H, areaH)
        let at = notchPlace(areaHeight: Double(areaH), winH: Double(winH), pillH: Double(pillH), position: prefs.position)
        let frame = NSRect(x: area.maxX - WIN_W * s, y: area.minY + CGFloat(at.windowY) * s, width: WIN_W * s, height: winH * s)
        panel.setFrame(frame, display: false)
        root.frame = NSRect(x: 0, y: 0, width: frame.width, height: frame.height)
        // The drawing and the pointer stay in normal-size points: the bounds scale them to the panel
        view.frame = root.bounds
        view.bounds = NSRect(x: 0, y: 0, width: WIN_W, height: winH)
        shapeGlasses()
        redraw()
        recheck()
    }

    /** Whether the pointer is over what takes clicks, checked again after the notch moved, opened, folded or changed */
    private func recheck() {
        panel.ignoresMouseEvents = !clickable(pointerInView())
    }

    /** The folded nub's strip, which takes the pointer and clicks */
    private var nubStrip: CGRect {
        CGRect(x: WIN_W - NUB_HOT_W, y: nubMid - NUB_H / 2, width: NUB_HOT_W, height: NUB_H)
    }

    /** The box the pill is cut to as it opens: from the nub's to the whole pill's (`e` is how far open) */
    private func pillClip(_ e: CGFloat) -> CGRect {
        let lerp = { (a: CGFloat, b: CGFloat) in a + (b - a) * e }
        let x = lerp(WIN_W - NUB_W, pillX)
        let top = lerp(nubMid - NUB_H / 2, pillY)
        return CGRect(x: x, y: top, width: WIN_W - x, height: lerp(nubMid + NUB_H / 2, pillY + pillH) - top)
    }

    /** Where the card of a cell is now */
    private func cardRect(_ i: Int) -> CGRect {
        CGRect(x: WIN_W - CARD_RIGHT - CARD_W, y: currentCardTop(i), width: CARD_W, height: CGFloat(fit(i).h))
    }

    /** What takes clicks: the nub's strip, and the pill and the card in their rounded shapes while the notch is open or opening
     * (not their clear corners, the margin around them, nor the gap between; nothing of them once the card goes or the notch folds) */
    private func clickable(_ p: CGPoint) -> Bool {
        if nubStrip.contains(p) { return true }
        let e = CGFloat(fold.value)
        guard fold.to > 0, e > 0.001 else { return false }
        if pillClip(e).contains(p) && pillPath(pillX, pillY, PILL_W, pillH).contains(p) { return true }
        if let i = card, e > 0.5, NSBezierPath(roundedRect: cardRect(i), xRadius: CARD_RADIUS, yRadius: CARD_RADIUS).contains(p) { return true }
        return false
    }

    /** Forgets where the card and its lines were drawn (the card went: nothing of it takes the wheel or clicks) */
    private func forgetCard() {
        cardBox = nil
        upBox = nil
        downBox = nil
    }

    // MARK: State

    /** Takes the reader's state again and works out what to show */
    func refresh() {
        let now = Double(nowMs())
        let (mode, sharedView, foot) = app.with { s in (s.mode, s.view, s.footer(now: nowMs())) }
        let shown: View?
        switch mode {
        case .demo: shown = sanitizeView(demoBody(now))
        case .live: shown = sharedView
        case .setup: shown = nil
        }
        cells = shown.map { notchModel($0, now, TimeZone.current) } ?? []
        footer = foot
        onTray?(trayModel(cells, footer: footer.0))
        if let c = card, c >= count { card = 0 }
        setTick()
        redraw()
        recheck()
    }

    /** Draws again, and moves the glass with what is drawn */
    private func redraw() {
        view.needsDisplay = true
        syncGlass()
    }

    /** The glass follows the pill as it opens from the nub (hidden when folded) and the card as it moves (hidden without one) */
    private func syncGlass() {
        guard let pg = pillGlass, let cg = cardGlass else { return }
        let e = CGFloat(fold.value)
        if e > 0.001 {
            let lerp = { (a: CGFloat, b: CGFloat) in a + (b - a) * e }
            let x = lerp(WIN_W - NUB_W, pillX)
            let top = lerp(nubMid - NUB_H / 2, pillY + FLARE)
            let bottom = lerp(nubMid + NUB_H / 2, pillY + pillH - FLARE)
            pg.frame = onRoot(CGRect(x: x, y: top, width: WIN_W - x + GLASS_PAST_EDGE, height: max(0, bottom - top)))
            pg.isHidden = false
        } else {
            pg.isHidden = true
        }
        if let i = card, e > 0.5 {
            cg.frame = onRoot(cardRect(i))
            cg.isHidden = false
        } else {
            cg.isHidden = true
        }
    }

    /** A rectangle of the drawing (normal-size points) in the panel's own points */
    private func onRoot(_ r: CGRect) -> CGRect {
        CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
    }

    private func setTick() {
        let waiting = foldTimer != nil || cardTimer != nil
        let interval: TimeInterval = card != nil || waiting ? 1 : 30
        if tickTimer?.timeInterval == interval { return }
        tickTimer?.invalidate()
        tickTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func animate() {
        if animTimer != nil { return }
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] t in
            guard let self else { return t.invalidate() }
            if !self.fold.moving && !self.cardTop.moving {
                t.invalidate()
                self.animTimer = nil
            }
            self.redraw()
            self.recheck()
        }
    }

    // MARK: Pointer

    /** The areas that keep the pointer: the nub's strip, the open pill, the open card and the gap to it */
    private func hot(_ p: CGPoint) -> Bool {
        var rects = [nubStrip.insetBy(dx: 0, dy: -HOT_PAD)]
        if fold.to > 0 || fold.value > 0.001 {
            rects.append(CGRect(x: pillX - HOT_PAD, y: pillY - HOT_PAD, width: WIN_W - pillX + HOT_PAD, height: pillH + 2 * HOT_PAD))
        }
        if let c = card, fold.value > 0.5 {
            let h = CGFloat(fit(c).h)
            let top = currentCardTop(c)
            rects.append(CGRect(x: WIN_W - CARD_RIGHT - CARD_W - HOT_PAD, y: top - HOT_PAD, width: CARD_W + CARD_RIGHT - PILL_W + HOT_PAD,
                                height: h + 2 * HOT_PAD))
        }
        return rects.contains { $0.contains(p) }
    }

    /** The pointer in the view's coordinates (top-left origin, normal-size points) */
    private func pointerInView() -> CGPoint {
        let screen = NSEvent.mouseLocation
        let inWindow = panel.convertPoint(fromScreen: screen)
        return view.convert(inWindow, from: nil)
    }

    /** Opened by a click only, and folded (or folding): the pointer alone does nothing */
    private var waitsForClick: Bool {
        prefs.openOn == .click && fold.to < 1 && !pinned
    }

    private func pointerMoved() {
        let p = pointerInView()
        let now = hot(p)
        panel.ignoresMouseEvents = !clickable(p)
        if waitsForClick { return }
        if now {
            if !inside { inside = true }
            foldTimer?.invalidate()
            foldTimer = nil
            cardTimer?.invalidate()
            cardTimer = nil
            unfold()
            if cells.isEmpty {
                if p.x >= pillX { showCard(0) }
            } else if let i = cellAt(p) {
                showCard(i)
            }
        } else if inside {
            inside = false
            if !pinned {
                cardTimer = Timer.scheduledTimer(withTimeInterval: prefs.foldDelay.cardSeconds, repeats: false) { [weak self] _ in
                    self?.cardTimer = nil
                    self?.hideCard()
                }
                foldTimer = Timer.scheduledTimer(withTimeInterval: prefs.foldDelay.foldSeconds, repeats: false) { [weak self] _ in
                    self?.foldTimer = nil
                    self?.foldAway()
                }
                setTick()
            }
        }
    }

    private func unfold() {
        if fold.to < 1 {
            if prefs.motion {
                fold.go(1)
                animate()
            } else {
                fold.jump(1)
                redraw()
                recheck()
            }
        }
    }

    private func foldAway() {
        if pinned { return }
        card = nil
        forgetCard()
        if prefs.motion {
            fold.go(0)
            animate()
        } else {
            fold.jump(0)
            redraw()
        }
        setTick()
        // Clicks go through at once (the nub's strip takes them again with the next check)
        panel.ignoresMouseEvents = true
    }

    private func showCard(_ i: Int) {
        if card == i { return }
        let target = Double(cardTarget(i))
        if card != nil && prefs.motion {
            cardTop.go(target)
            animate()
        } else {
            cardTop.jump(target)
        }
        card = i
        cardScroll = 0
        refresh()
    }

    private func hideCard() {
        if pinned { return }
        card = nil
        forgetCard()
        setTick()
        redraw()
        recheck()
    }

    fileprivate func currentCardTop(_ i: Int) -> CGFloat {
        let top = cardTop.moving ? CGFloat(cardTop.value) : cardTarget(i)
        return max(8, min(winH - CGFloat(fit(i).h) - 8, top))
    }

    /** A click: on the folded nub it opens the notch (when a click opens it); the card's lines move its rows; a ring reads the
     * server now, or says when it next may */
    fileprivate func click(_ p: CGPoint) {
        if waitsForClick {
            if nubStrip.contains(p) {
                unfold()
                // The pointer is over the notch now: its card, and the fold when it leaves
                pointerMoved()
            }
            return
        }
        if card != nil, let b = upBox, b.contains(p) { return wheel(1) }
        if card != nil, let b = downBox, b.contains(p) { return wheel(-1) }
        if cellAt(p) == nil && !(cells.isEmpty && p.x >= pillX) { return }
        let minutes = app.refreshNow()
        if minutes > 0 {
            note = ("Next read in \(minutes) min", Date())
            redraw()
        }
    }

    /** Moves the card's rows by a row: down for a negative delta, up for a positive one */
    fileprivate func wheel(_ delta: CGFloat) {
        scroll(by: delta < 0 ? ROW_H : -ROW_H)
    }

    /** Moves the card's rows by points (a trackpad's movement as it is; a wheel's step and the up and down lines by a row) */
    fileprivate func scroll(by points: Double) {
        guard let i = card else { return }
        let f = fit(i)
        guard f.scrolls else { return }
        let next = min(f.max, max(0, f.offset + points))
        if next != f.offset {
            cardScroll = next
            redraw()
        }
    }

    // MARK: Drawing

    fileprivate func draw() {
        let e = CGFloat(fold.value)
        let mid = nubMid
        // The pill, opened from the nub: clipped to a box that grows from the nub to the whole pill
        if e > 0.001 {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: pillClip(e)).addClip()
            pal.pill.setFill()
            pillPath(pillX, pillY, PILL_W, pillH).fill()
            if cells.isEmpty {
                text("—", font: .systemFont(ofSize: 12, weight: .semibold), in: CGRect(x: pillX, y: cellTop(0) + RING_PX / 2 - 8, width: PILL_W, height: PCT_LINE),
                     color: fade(pal.ink, cellAlpha(e, 0)), align: .center)
            }
            for (i, c) in cells.enumerated() {
                let a = cellAlpha(e, i)
                drawCell(c, cx: pillX + PILL_W / 2 + 10 * (1 - a), top: cellTop(i), alpha: a)
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        // The nub fades in as the pill folds away (drawn past the edge, so only its left corners are round)
        let nubA = min(1, max(0, 1 - e * 2.5))
        if nubA > 0 {
            fade(pal.nub, nubA).setFill()
            NSBezierPath(roundedRect: CGRect(x: WIN_W - NUB_W, y: mid - NUB_H / 2, width: NUB_W + 6, height: NUB_H), xRadius: 5, yRadius: 5).fill()
        }
        forgetCard()
        if let i = card, e > 0.5 { drawCard(i, top: currentCardTop(i), centre: ringCentre(min(i, count - 1))) }
    }

    private func cellAlpha(_ e: CGFloat, _ i: Int) -> CGFloat {
        min(1, max(0, (e * CGFloat(FOLD_S * 1000) - CGFloat(i) * 30) / 180))
    }

    private func pillPath(_ x0: CGFloat, _ y0: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSBezierPath {
        let f = FLARE
        let r = min(PILL_RADIUS, (w - 1) / 2)
        let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: x0 + x, y: y0 + y) }
        let path = NSBezierPath()
        path.move(to: p(w, 0))
        path.appendArc(withCenter: p(w - f, 0), radius: f, startAngle: 0, endAngle: 90, clockwise: false)
        path.line(to: p(r, f))
        quad(path, to: p(0, f + r), control: p(0, f))
        path.line(to: p(0, h - f - r))
        quad(path, to: p(r, h - f), control: p(0, h - f))
        path.line(to: p(w - f, h - f))
        path.appendArc(withCenter: p(w - f, h), radius: f, startAngle: 270, endAngle: 360, clockwise: false)
        path.close()
        return path
    }

    private func quad(_ path: NSBezierPath, to end: CGPoint, control q: CGPoint) {
        let start = path.currentPoint
        let c1 = CGPoint(x: start.x + 2 / 3 * (q.x - start.x), y: start.y + 2 / 3 * (q.y - start.y))
        let c2 = CGPoint(x: end.x + 2 / 3 * (q.x - end.x), y: end.y + 2 / 3 * (q.y - end.y))
        path.curve(to: end, controlPoint1: c1, controlPoint2: c2)
    }

    /** An arc of a ring from `from` to `to` (fractions, clockwise from 12 o'clock), with flat ends */
    private func arc(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ from: CGFloat, _ to: CGFloat, _ width: CGFloat, _ c: NSColor) {
        if to - from <= 0.0005 { return }
        let path = NSBezierPath()
        if to - from >= 0.9995 {
            path.appendOval(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
        } else {
            path.appendArc(withCenter: CGPoint(x: cx, y: cy), radius: r, startAngle: -90 + from * 360, endAngle: -90 + to * 360, clockwise: false)
        }
        path.lineWidth = width
        path.lineCapStyle = .butt
        c.setStroke()
        path.stroke()
    }

    private func ringArcs(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, _ w: CGFloat, _ p: Pieces, _ hex: String, _ a: CGFloat) {
        let fade = a * (p.faded ? 0.45 : 1)
        let (solid, projected, recent) = (CGFloat(p.solid), CGFloat(p.projected), CGFloat(p.recent))
        arc(cx, cy, r, 0, solid, w, color(hex, fade))
        arc(cx, cy, r, solid, solid + projected, w, color(hex, 0.35 * fade))
        arc(cx, cy, r, solid + projected, solid + projected + recent, w, color(RECENT, fade))
    }

    private func drawCell(_ c: Cell, cx: CGFloat, top: CGFloat, alpha a: CGFloat) {
        let k = RING_PX / VB
        let cy = top + RING_PX / 2
        let ringA = a * (c.stale ? 0.5 : 1)
        arc(cx, cy, RING_R * k, 0, 1, RING_STROKE * k, fade(pal.track, ringA))
        if let h = c.headline { ringArcs(cx, cy, RING_R * k, RING_STROKE * k, h.pieces, c.color, ringA) }
        if let w = c.weekly {
            arc(cx, cy, OUTER_R * k, 0, 1, OUTER_STROKE * k, fade(pal.outerTrack, ringA))
            arc(cx, cy, OUTER_R * k, 0, CGFloat(w.solid + w.projected), OUTER_STROKE * k, color(c.color, 0.6 * ringA))
        }
        if let icon = icons.icon(c.provider, prefs: prefs) {
            let size = iconBox(icon.size.height > 0 ? icon.size.width / icon.size.height : 1, ICON_BOX)
            let r = CGRect(x: cx - size.width * k / 2, y: cy - size.height * k / 2, width: size.width * k, height: size.height * k)
            icon.draw(in: r, from: .zero, operation: .sourceOver, fraction: ringA, respectFlipped: true, hints: nil)
        } else {
            text(MARKS[c.provider] ?? "?", font: .systemFont(ofSize: 12.5, weight: .bold), in: CGRect(x: cx - 20, y: cy - 9, width: 40, height: 18),
                 color: color(c.color, ringA), align: .center)
        }
        let warn = c.headline?.warn ?? false
        let label = c.headline.map { (warn ? "⚠ " : "") + $0.text } ?? "—"
        text(label, font: .monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
             in: CGRect(x: cx - PILL_W / 2, y: top + RING_PX + PCT_GAP, width: PILL_W, height: PCT_LINE), color: fade(warn ? pal.warn : pal.ink, a),
             align: .center)
    }

    @discardableResult
    private func text(_ s: String, font: NSFont, in r: CGRect, color: NSColor, align: NSTextAlignment = .left) -> CGFloat {
        let style = NSMutableParagraphStyle()
        style.alignment = align
        style.lineBreakMode = .byTruncatingTail
        let a = NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
        a.draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        return min(r.width, a.size().width)
    }

    private func width(_ s: String, _ font: NSFont) -> CGFloat {
        NSAttributedString(string: s, attributes: [.font: font]).size().width
    }

    private func drawCard(_ i: Int, top: CGFloat, centre: CGFloat) {
        let f = fit(i)
        let h = CGFloat(f.h)
        let right = WIN_W - CARD_RIGHT
        let left = right - CARD_W
        cardBox = CGRect(x: left, y: top, width: CARD_W, height: h)
        pal.card.setFill()
        NSBezierPath(roundedRect: CGRect(x: left, y: top, width: CARD_W, height: h), xRadius: CARD_RADIUS, yRadius: CARD_RADIUS).fill()
        let border = NSBezierPath(roundedRect: CGRect(x: left + 0.5, y: top + 0.5, width: CARD_W - 1, height: h - 1), xRadius: CARD_RADIUS - 0.5,
                                  yRadius: CARD_RADIUS - 0.5)
        border.lineWidth = 1
        pal.cardLine.setStroke()
        border.stroke()
        // The tail pointing at the ring (none when the card is too short for one)
        if h >= 42 {
            let ty = top + 1 + min(max(centre - top - 11, 10), h - 32)
            let x = right - 1
            let tail = NSBezierPath()
            tail.move(to: CGPoint(x: x, y: ty))
            tail.curve(to: CGPoint(x: x + 12, y: ty + 11), controlPoint1: CGPoint(x: x, y: ty + 6), controlPoint2: CGPoint(x: x + 9, y: ty + 8.5))
            tail.curve(to: CGPoint(x: x, y: ty + 22), controlPoint1: CGPoint(x: x + 9, y: ty + 13.5), controlPoint2: CGPoint(x: x, y: ty + 16))
            tail.close()
            pal.tail.setFill()
            tail.fill()
        }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: CGRect(x: left, y: top, width: CARD_W, height: h)).addClip()
        drawCardBody(i, left: left, top: top, fit: f)
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawCardBody(_ i: Int, left: CGFloat, top: CGFloat, fit f: CardFit) {
        let x = left + 15
        let w = CARD_W - 30
        var y = top + 13
        let small = NSFont.systemFont(ofSize: 11)
        let smallDigits = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        let c = cells.indices.contains(i) ? cells[i] : nil
        let nameW = text(c?.name ?? "Headroom", font: .systemFont(ofSize: 14, weight: .bold), in: CGRect(x: x, y: y, width: w, height: 18.9), color: pal.ink)
        if let c {
            if let plan = c.plan {
                text(plan, font: small, in: CGRect(x: x + nameW + 6, y: y + 3.5, width: w - nameW - 20, height: 16), color: pal.dim)
            }
            color(c.fresh.color).setFill()
            NSBezierPath(ovalIn: CGRect(x: x + w - 7, y: y + 7, width: 7, height: 7)).fill()
        }
        y += 18.9
        if let c {
            if let m = c.message {
                y += 8
                text(m, font: .systemFont(ofSize: 12), in: CGRect(x: x, y: y, width: w, height: 16.2), color: pal.ink2)
                y += 16.2
            }
            if f.notice {
                y += 10
                text("Too little room here: see the menu bar menu", font: small, in: CGRect(x: x, y: y + 1, width: w, height: 16.2), color: pal.dim)
                y += 16.2
            } else {
                if f.scrolls {
                    y += 10
                    let can = f.offset > 0
                    if can { upBox = CGRect(x: x, y: y - 5, width: w, height: 26.2) }
                    text("↑ more", font: small, in: CGRect(x: x, y: y + 1, width: w, height: 16.2), color: fade(pal.dim, can ? 1 : 0.35))
                    y += 16.2
                }
                // The rows, cut to their room
                let rowsTop = y
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(rect: CGRect(x: left, y: rowsTop, width: CARD_W, height: CGFloat(f.area))).addClip()
                var ry = rowsTop - CGFloat(f.offset)
                for r in c.rows {
                    let rh = CGFloat(rowHeight(r))
                    if ry + rh <= rowsTop || ry >= rowsTop + CGFloat(f.area) {
                        ry += rh
                        continue
                    }
                    ry += 10
                    switch r {
                    case .missing(let label, let t):
                        let tw = width(t, smallDigits)
                        text(label, font: .systemFont(ofSize: 12), in: CGRect(x: x, y: ry, width: w - tw - 8, height: 16.2), color: pal.dim)
                        text(t, font: smallDigits, in: CGRect(x: x, y: ry + 1, width: w, height: 16.2), color: pal.dim, align: .right)
                        ry += 16.2
                    case let .limit(_, label, leftText, pace, time, warn, pieces):
                        let tw = width(time, smallDigits)
                        text(label, font: .systemFont(ofSize: 12, weight: .semibold), in: CGRect(x: x, y: ry, width: w - tw - 8, height: 16.2), color: pal.ink)
                        text(time, font: smallDigits, in: CGRect(x: x, y: ry + 1, width: w, height: 16.2), color: warn ? pal.warn : pal.dim, align: .right)
                        ry += 16.2 + 5
                        bar(x, ry, w, pieces, c.color)
                        ry += 5 + 4
                        text(leftText, font: smallDigits, in: CGRect(x: x, y: ry, width: w, height: 14.85), color: pal.ink2)
                        text(pace, font: smallDigits, in: CGRect(x: x, y: ry, width: w, height: 14.85), color: pal.dim, align: .right)
                        ry += 14.85
                    }
                }
                NSGraphicsContext.restoreGraphicsState()
                y = rowsTop + CGFloat(f.area)
                if f.scrolls {
                    y += 10
                    let can = f.offset < f.max
                    if can { downBox = CGRect(x: x, y: y - 5, width: w, height: 26.2) }
                    text("↓ more", font: small, in: CGRect(x: x, y: y + 1, width: w, height: 16.2), color: fade(pal.dim, can ? 1 : 0.35))
                    y += 16.2
                }
            }
        }
        y += 11
        pal.cardLine.setFill()
        NSBezierPath(rect: CGRect(x: x, y: y, width: w, height: 1)).fill()
        y += 9
        let showNote = note.map { Date().timeIntervalSince($0.1) < NOTE_S } ?? false
        let (line, warn) = showNote ? (note!.0, false) : footer
        text(line, font: small, in: CGRect(x: x, y: y, width: w, height: 14.85), color: warn ? pal.warn : pal.dim)
    }

    /** A card's bar: the track, then the same three pieces from the left, cut to the track's rounded shape */
    private func bar(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ p: Pieces, _ hex: String) {
        let track = NSBezierPath(roundedRect: CGRect(x: x, y: y, width: w, height: 5), xRadius: 2.5, yRadius: 2.5)
        pal.cardLine.setFill()
        track.fill()
        NSGraphicsContext.saveGraphicsState()
        track.addClip()
        let fade: CGFloat = p.faded ? 0.45 : 1
        var bx = x
        for (frac, hexc, a) in [(p.solid, hex, fade), (p.projected, hex, 0.35 * fade), (p.recent, RECENT, fade)] {
            let bw = CGFloat(frac) * w
            if frac > 0.0005 {
                color(hexc, a).setFill()
                NSBezierPath(rect: CGRect(x: bx, y: y, width: bw, height: 5)).fill()
            }
            bx += bw
        }
        NSGraphicsContext.restoreGraphicsState()
    }
}

final class NotchView: NSView {
    weak var controller: NotchController?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)
        controller?.draw()
    }

    override func mouseUp(with event: NSEvent) {
        controller?.click(convert(event.locationInWindow, from: nil))
    }

    /** The wheel over the card moves its rows */
    override func scrollWheel(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        guard let c = controller, let box = c.cardBox, box.contains(p), event.scrollingDeltaY != 0 else { return }
        if event.hasPreciseScrollingDeltas {
            c.scroll(by: Double(-event.scrollingDeltaY))
        } else {
            c.wheel(event.scrollingDeltaY)
        }
    }
}
