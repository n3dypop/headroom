// The settings window: the server, the read token (to the keychain only) and the sample switch.

import AppKit
import HeadroomKit

/** Laid out from the top, as the Windows client's window is */
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let app: AppState
    private var window: NSWindow?
    private let url = NSTextField()
    private let token = NSSecureTextField()
    private let demo = NSButton(checkboxWithTitle: "Show sample data instead of the server", target: nil, action: nil)
    private let tokenHint = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")

    init(app: AppState) {
        self.app = app
        super.init()
    }

    /** Opens the settings (or brings them to the front) */
    func show() {
        if window == nil { build() }
        load()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(url)
    }

    private func label(_ s: String, size: CGFloat = 13, bold: Bool = false, gray: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        if gray { l.textColor = .secondaryLabelColor }
        return l
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 420), styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Headroom Settings"
        w.isReleasedWhenClosed = false
        w.delegate = self
        let v = FlippedView(frame: NSRect(x: 0, y: 0, width: 460, height: 420))
        let x: CGFloat = 20, cw: CGFloat = 420
        func put(_ view: NSView, _ y: CGFloat, _ h: CGFloat, width: CGFloat = 420, at left: CGFloat = 20) {
            view.frame = NSRect(x: left, y: y, width: width, height: h)
            v.addSubview(view)
        }
        put(label("Headroom", size: 18, bold: true), 16, 26)
        put(label("Shows the usage limits your Headroom server has. It reads the server every 5 minutes at most, and never touches Claude, Codex or Gemini itself."), 48, 40)
        put(label("Server"), 100, 18)
        url.placeholderString = "https://headroom.example.workers.dev"
        put(url, 120, 24)
        put(label("The https:// address of your Worker, with the host name only.", size: 11, gray: true), 148, 18)
        put(label("Read token"), 178, 18)
        put(token, 198, 24)
        tokenHint.font = .systemFont(ofSize: 11)
        tokenHint.textColor = .secondaryLabelColor
        put(tokenHint, 226, 34)
        put(demo, 268, 22)
        let save = NSButton(title: "Save", target: self, action: #selector(saveClicked))
        save.keyEquivalent = "\r"
        put(save, 306, 28, width: 96, at: x)
        let close = NSButton(title: "Close", target: self, action: #selector(closeClicked))
        close.keyEquivalent = "\u{1b}"
        put(close, 306, 28, width: 96, at: x + 104)
        put(NSButton(title: "Remove token", target: self, action: #selector(removeClicked)), 306, 28, width: 120, at: x + 208)
        put(status, 346, 40, width: cw)
        w.contentView = v
        w.center()
        window = w
    }

    /** Fills the fields from the settings (the token itself is never shown, only whether one is kept) */
    private func load() {
        let (u, has, d) = app.with { ($0.settings.url, $0.hasToken, $0.settings.demo) }
        url.stringValue = u
        token.stringValue = ""
        token.placeholderString = has ? "Saved (leave empty to keep it)" : ""
        demo.state = d ? .on : .off
        tokenHint.stringValue = "A read token for this Mac (not a PC's write token). Kept in the keychain. Time zone: \(TimeZone.current.identifier)."
    }

    @objc private func saveClicked() {
        // Out of the field at once: it never stays in the window, whether the save works or not
        let typed = token.stringValue
        token.stringValue = ""
        do {
            try app.save(url: url.stringValue, token: typed.isEmpty ? nil : typed, demo: demo.state == .on)
            load()
            status.stringValue = "Saved."
        } catch let e as SaveError {
            status.stringValue = e.text + (typed.isEmpty ? "" : ". Enter the token again.")
        } catch {
            status.stringValue = "Couldn't save the settings"
        }
    }

    @objc private func removeClicked() {
        do {
            try app.removeToken()
            load()
            status.stringValue = "Token removed."
        } catch let e as SaveError {
            status.stringValue = e.text
        } catch {
            status.stringValue = "Couldn't remove the token"
        }
    }

    @objc private func closeClicked() {
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        token.stringValue = ""
    }
}
