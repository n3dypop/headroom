// The menu bar item: its tooltip says what is left; its menu lists each provider, then Refresh now, Settings… and Quit.

import AppKit
import HeadroomKit

final class StatusItemController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let app: AppState
    private var shown = Tray(lines: [], tooltip: "Headroom")
    var openSettings: (() -> Void)?

    init(app: AppState) {
        self.app = app
        super.init()
        item.button?.image = StatusItemController.icon()
        item.button?.toolTip = shown.tooltip
        rebuild()
    }

    /** A ring with a quarter left open, as a template image (it follows the menu bar's light or dark look) */
    private static func icon() -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let path = NSBezierPath()
            path.appendArc(withCenter: NSPoint(x: rect.midX, y: rect.midY), radius: 6.5, startAngle: 90, endAngle: 0, clockwise: false)
            path.lineWidth = 2.4
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        return image
    }

    /** Shows new lines and a new tooltip (only when they changed) */
    func set(_ next: Tray) {
        if next == shown { return }
        shown = next
        item.button?.toolTip = next.tooltip
        rebuild()
    }

    private func rebuild() {
        let menu = NSMenu()
        for line in shown.lines {
            let i = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            i.isEnabled = false
            menu.addItem(i)
        }
        if !shown.lines.isEmpty { menu.addItem(.separator()) }
        let refresh = NSMenuItem(title: "Refresh now", action: #selector(refreshNow), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)
        let settings = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Headroom", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
        menu.autoenablesItems = false
        item.menu = menu
    }

    @objc private func refreshNow() {
        if app.with({ $0.schedule.mayRead(monoMs()) }) { app.nudge() }
    }

    @objc private func showSettings() {
        openSettings?()
    }
}
