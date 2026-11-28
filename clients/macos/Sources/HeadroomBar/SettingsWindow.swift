// The settings window, in four tabs: Connection (the server, the read token, to the keychain only, and the sample switch, saved
// with Save), Placement, Appearance and Behavior (each change takes effect and is saved at once). A status line at the bottom.

import AppKit
import HeadroomKit

/** Laid out from the top, as the Windows client's window is */
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

private let SIZES: [(String, NotchSize)] = [("Small", .small), ("Normal", .normal), ("Large", .large)]
private let THEMES: [(String, Theme)] = [("System", .system), ("Dark", .dark), ("Light", .light), ("Liquid Glass", .glass)]
private let TINTS: [(String, GlassTint)] = [("Clear", .clear), ("Dark", .dark), ("Light", .light)]
private let OPENS: [(String, OpenOn)] = [("When the pointer touches it", .hover), ("When clicked", .click)]
private let FOLDS: [(String, FoldDelay)] = [("Quickly", .short), ("Normally", .normal), ("Slowly", .long)]

/** The index of a value among the options (the first when it isn't there) */
private func optionIndex<T: Equatable>(_ options: [(String, T)], _ value: T) -> Int {
    options.firstIndex { $0.1 == value } ?? 0
}

final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let app: AppState
    private var window: NSWindow?
    private let tabs = NSTabView()
    // Connection
    private let url = NSTextField()
    private let token = NSSecureTextField()
    private let demo = NSButton(checkboxWithTitle: "Show sample data instead of the server", target: nil, action: nil)
    private let tokenHint = NSTextField(wrappingLabelWithString: "")
    // Placement
    private let screenPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let position = NSSlider()
    private let sizePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    // Appearance
    private let themePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let tintPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let motion = NSButton(checkboxWithTitle: "Animations", target: nil, action: nil)
    private let iconsBox = NSBox()
    /** Told the icons read when the settings open (both sets), so the notch draws files added since */
    var onIcons: ((ProviderIcons) -> Void)?
    // Behavior
    private let openPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let foldPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let hideFullscreen = NSButton(checkboxWithTitle: "Hide over full-screen apps", target: nil, action: nil)
    private let atLogin = NSButton(checkboxWithTitle: "Start Headroom when you log in", target: nil, action: nil)
    private let loginHint = NSTextField(wrappingLabelWithString: "")
    private let openLoginItems = NSButton(title: "Open Login Items…", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "")
    private var screensWatch: Any?

    init(app: AppState) {
        self.app = app
        super.init()
    }

    /** Opens the settings (or brings them to the front) */
    func show() {
        if window == nil { build() }
        // Brought to the front as it is when already open (what is being typed stays)
        if window?.isVisible != true { load() }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        if tabs.selectedTabViewItem?.identifier as? String == "connection" { window?.makeFirstResponder(url) }
    }

    private func label(_ s: String, size: CGFloat = 13, bold: Bool = false, gray: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        if gray { l.textColor = .secondaryLabelColor }
        return l
    }

    private func hint(_ s: String) -> NSTextField {
        label(s, size: 11, gray: true)
    }

    private func fill<T>(_ popup: NSPopUpButton, _ options: [(String, T)], _ action: Selector) {
        popup.removeAllItems()
        popup.addItems(withTitles: options.map { $0.0 })
        popup.target = self
        popup.action = action
    }

    /** A tab's page, laid out from the top */
    private func newPage() -> FlippedView {
        FlippedView(frame: NSRect(x: 0, y: 0, width: 476, height: 380))
    }

    private func put(_ page: NSView, _ view: NSView, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        view.frame = NSRect(x: x, y: y, width: w, height: h)
        page.addSubview(view)
    }

    private func item(_ id: String, _ title: String, _ page: NSView) -> NSTabViewItem {
        let item = NSTabViewItem(identifier: id)
        item.label = title
        item.view = page
        return item
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 500), styleMask: [.titled, .closable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Headroom Settings"
        w.isReleasedWhenClosed = false
        w.delegate = self
        let content = FlippedView(frame: NSRect(x: 0, y: 0, width: 520, height: 500))
        let x: CGFloat = 20, cw: CGFloat = 430

        // Connection: saved with Save only
        url.placeholderString = "https://headroom.example.workers.dev"
        tokenHint.font = .systemFont(ofSize: 11)
        tokenHint.textColor = .secondaryLabelColor
        let save = NSButton(title: "Save", target: self, action: #selector(saveClicked))
        save.keyEquivalent = "\r"
        let remove = NSButton(title: "Remove token", target: self, action: #selector(removeClicked))
        let connection = newPage()
        let about = "Shows the usage limits your Headroom server has. It reads the server every 5 minutes at most, and never touches Claude, "
            + "Codex or Gemini itself."
        put(connection, label(about), x, 12, cw, 40)
        put(connection, label("Server"), x, 62, cw, 18)
        put(connection, url, x, 82, cw, 24)
        put(connection, hint("The https:// address of your Worker, with the host name only."), x, 110, cw, 18)
        put(connection, label("Read token"), x, 138, cw, 18)
        put(connection, token, x, 158, cw, 24)
        put(connection, tokenHint, x, 186, cw, 34)
        put(connection, demo, x, 226, cw, 22)
        put(connection, save, x, 262, 96, 28)
        put(connection, remove, x + 104, 262, 130, 28)
        tabs.addTabViewItem(item("connection", "Connection", connection))

        // Placement
        screenPopup.target = self
        screenPopup.action = #selector(screenChosen)
        // Its items have no action of their own: never disabled for it, so every screen can be chosen
        screenPopup.autoenablesItems = false
        position.minValue = 0
        position.maxValue = 100
        position.numberOfTickMarks = 3
        position.isContinuous = true
        position.target = self
        position.action = #selector(positionMoved)
        fill(sizePopup, SIZES, #selector(sizeChosen))
        let top = hint("Top")
        let middle = hint("Middle")
        middle.alignment = .center
        let bottom = hint("Bottom")
        bottom.alignment = .right
        let placement = newPage()
        put(placement, label("Screen"), x, 16, cw, 18)
        put(placement, screenPopup, x, 38, cw, 26)
        let automatic = "Automatic puts the notch on the screen furthest right, where the pointer stops at the edge. A chosen screen that "
            + "isn't connected counts as automatic."
        put(placement, hint(automatic), x, 70, cw, 30)
        put(placement, label("Position along the edge"), x, 116, cw, 18)
        put(placement, position, x, 138, cw, 24)
        put(placement, top, x, 166, 120, 16)
        put(placement, middle, x + cw / 2 - 60, 166, 120, 16)
        put(placement, bottom, x + cw - 120, 166, 120, 16)
        put(placement, label("Size"), x, 198, cw, 18)
        put(placement, sizePopup, x, 220, 180, 26)
        tabs.addTabViewItem(item("placement", "Placement", placement))

        // Appearance
        fill(themePopup, THEMES, #selector(themeChosen))
        fill(tintPopup, TINTS, #selector(tintChosen))
        motion.target = self
        motion.action = #selector(motionToggled)
        let glassNote = liquidGlassAvailable()
            ? "Liquid Glass shows the screen behind the notch through it."
            : "Liquid Glass needs macOS 26: here the glass is a blurred background."
        let appearance = newPage()
        put(appearance, label("Theme"), x, 16, cw, 18)
        put(appearance, themePopup, x, 38, 220, 26)
        put(appearance, hint("System follows the light or dark look of macOS."), x, 68, cw, 16)
        put(appearance, label("Glass tint"), x, 96, cw, 18)
        put(appearance, tintPopup, x, 118, 220, 26)
        put(appearance, hint(glassNote + " The tint applies to Liquid Glass only; Light has dark text."), x, 148, cw, 30)
        put(appearance, motion, x, 192, cw, 22)
        put(appearance, hint("Opening, folding and moving the card. Off, they happen at once."), x, 216, cw, 16)
        iconsBox.title = "Icons"
        iconsBox.contentView = FlippedView(frame: NSRect(x: 0, y: 0, width: cw - 20, height: 84))
        put(appearance, iconsBox, x, 244, cw, 112)
        tabs.addTabViewItem(item("appearance", "Appearance", appearance))

        // Behavior
        fill(openPopup, OPENS, #selector(openChosen))
        fill(foldPopup, FOLDS, #selector(foldChosen))
        hideFullscreen.target = self
        hideFullscreen.action = #selector(hideToggled)
        atLogin.target = self
        atLogin.action = #selector(loginToggled)
        openLoginItems.target = self
        openLoginItems.action = #selector(openLoginItemsClicked)
        openLoginItems.isHidden = true
        let behavior = newPage()
        put(behavior, label("Open the notch"), x, 16, cw, 18)
        put(behavior, openPopup, x, 38, 280, 26)
        put(behavior, hint("Once it is open, the card follows the pointer either way."), x, 68, cw, 16)
        put(behavior, label("Fold after the pointer leaves"), x, 96, cw, 18)
        put(behavior, foldPopup, x, 118, 180, 26)
        put(behavior, hideFullscreen, x, 160, cw, 22)
        put(behavior, hint("While another app is full screen (a game or a video), its space shows no notch."), x, 184, cw, 16)
        put(behavior, atLogin, x, 214, cw, 22)
        put(behavior, loginHint, x, 238, cw, 34)
        put(behavior, openLoginItems, x, 276, 170, 28)
        tabs.addTabViewItem(item("behavior", "Behavior", behavior))
        loginHint.font = .systemFont(ofSize: 11)
        loginHint.textColor = .secondaryLabelColor

        tabs.frame = NSRect(x: 12, y: 12, width: 496, height: 422)
        content.addSubview(tabs)
        status.frame = NSRect(x: 20, y: 444, width: 380, height: 40)
        content.addSubview(status)
        let close = NSButton(title: "Close", target: self, action: #selector(closeClicked))
        close.keyEquivalent = "\u{1b}"
        close.frame = NSRect(x: 412, y: 448, width: 96, height: 28)
        content.addSubview(close)
        w.contentView = content
        w.center()
        window = w
        // Screens come and go: the list follows
        screensWatch = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil,
                                                              queue: .main) { [weak self] _ in
            self?.fillScreens()
        }
    }

    /** Fills the fields from the settings (the token itself is never shown, only whether one is kept) */
    private func load() {
        let (u, has, d, prefs) = app.with { ($0.settings.url, $0.hasToken, $0.settings.demo, $0.settings.prefs) }
        url.stringValue = u
        token.stringValue = ""
        token.placeholderString = has ? "Saved (leave empty to keep it)" : ""
        demo.state = d ? .on : .off
        tokenHint.stringValue = "A read token for this Mac (not a PC's write token). Kept in the keychain. Time zone: \(TimeZone.current.identifier)."
        fillScreens()
        position.doubleValue = Double(prefs.position)
        sizePopup.selectItem(at: optionIndex(SIZES, prefs.size))
        themePopup.selectItem(at: optionIndex(THEMES, prefs.theme))
        tintPopup.selectItem(at: optionIndex(TINTS, prefs.glassTint))
        tintPopup.isEnabled = prefs.theme == .glass
        motion.state = prefs.motion ? .on : .off
        openPopup.selectItem(at: optionIndex(OPENS, prefs.openOn))
        foldPopup.selectItem(at: optionIndex(FOLDS, prefs.foldDelay))
        hideFullscreen.state = prefs.hideFullscreen ? .on : .off
        let icons = ProviderIcons.load()
        fillIcons(icons, prefs)
        onIcons?(icons)
        readLoginItem()
    }

    /** A checkbox for each provider that has a second icon; where to put the second set when none has */
    private func fillIcons(_ icons: ProviderIcons, _ prefs: Prefs) {
        guard let inner = iconsBox.contentView else { return }
        for v in inner.subviews { v.removeFromSuperview() }
        let width = iconsBox.frame.width - 28
        let choosable = icons.withSecond
        if choosable.isEmpty {
            let note = hint("Put a second set of icons in ~/Library/Application Support/Headroom/icons/alt/ to choose between them.")
            note.frame = NSRect(x: 6, y: 6, width: width, height: 32)
            inner.addSubview(note)
            return
        }
        for (i, p) in choosable.enumerated() {
            let box = NSButton(checkboxWithTitle: "\(providerName(p)): use the second icon", target: self, action: #selector(altIconToggled(_:)))
            box.identifier = NSUserInterfaceItemIdentifier(p)
            box.state = prefs.usesAltIcon(p) ? .on : .off
            box.frame = NSRect(x: 6, y: 6 + CGFloat(i) * 24, width: width, height: 22)
            inner.addSubview(box)
        }
    }

    @objc private func altIconToggled(_ sender: NSButton) {
        guard let p = sender.identifier?.rawValue else { return }
        let on = sender.state == .on
        change { $0.setAltIcon(p, on) }
    }

    /** The screens, by name and size (the menu bar's marked), after Automatic; a chosen screen that isn't connected stays listed */
    private func fillScreens() {
        let chosen = app.with { $0.settings.prefs.display }
        screenPopup.removeAllItems()
        // Items added to the menu itself (the button would merge items of the same title, as two alike screens have)
        func add(_ title: String, _ key: String) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.representedObject = key
            item.isEnabled = true
            screenPopup.menu?.addItem(item)
        }
        add("Automatic (furthest right)", "")
        var keys: [String] = []
        for (i, screen) in NSScreen.screens.enumerated() {
            guard let key = screenKey(of: screen) else { continue }
            keys.append(key)
            let size = screen.frame.size
            add("\(screen.localizedName) (\(Int(size.width)) × \(Int(size.height))\(i == 0 ? ", main" : ""))", key)
        }
        if !chosen.isEmpty && !keys.contains(chosen) { add("A screen that isn't connected (automatic until it is)", chosen) }
        let at = screenPopup.itemArray.firstIndex { ($0.representedObject as? String) == chosen } ?? 0
        screenPopup.selectItem(at: at)
    }

    /** The login item as the system has it */
    private func readLoginItem() {
        DispatchQueue.global(qos: .userInitiated).async {
            let now = LoginItem.status()
            DispatchQueue.main.async { self.showLogin(now) }
        }
    }

    /** On only when the system has the login item enabled for this copy; the hint says why not otherwise */
    private func showLogin(_ now: LoginItem.Status) {
        atLogin.state = now == .on ? .on : .off
        openLoginItems.isHidden = now != .needsApproval
        switch now {
        case .off, .on:
            loginHint.stringValue = "A login item in ~/Library/LaunchAgents that starts this copy of Headroom."
        case .other(let path):
            loginHint.stringValue = "The login item starts another copy\(path.isEmpty ? "" : " (\(path))"). Turn this on to start this one."
        case .needsApproval:
            loginHint.stringValue = "macOS has the login item turned off. Allow Headroom in System Settings > General > Login Items."
        case .notRegistered:
            loginHint.stringValue = "The login item is written, but macOS hasn't taken it up yet. Turn this on again, or log out and in."
        }
    }

    @objc private func openLoginItemsClicked() {
        LoginItem.openSettings()
    }

    /** A change of the notch's prefs: shown at once, written in the background */
    private func change(_ f: (inout Prefs) -> Void) {
        app.setPrefs(f) { [weak self] error in
            self?.status.stringValue = error?.text ?? "Saved."
        }
    }

    @objc private func screenChosen() {
        let key = screenPopup.selectedItem?.representedObject as? String ?? ""
        change { $0.display = key }
    }

    @objc private func positionMoved() {
        let v = Int(position.doubleValue.rounded())
        change { $0.position = min(100, max(0, v)) }
    }

    @objc private func sizeChosen() {
        guard SIZES.indices.contains(sizePopup.indexOfSelectedItem) else { return }
        let v = SIZES[sizePopup.indexOfSelectedItem].1
        change { $0.size = v }
    }

    @objc private func themeChosen() {
        guard THEMES.indices.contains(themePopup.indexOfSelectedItem) else { return }
        let v = THEMES[themePopup.indexOfSelectedItem].1
        tintPopup.isEnabled = v == .glass
        change { $0.theme = v }
    }

    @objc private func tintChosen() {
        guard TINTS.indices.contains(tintPopup.indexOfSelectedItem) else { return }
        let v = TINTS[tintPopup.indexOfSelectedItem].1
        change { $0.glassTint = v }
    }

    @objc private func motionToggled() {
        let on = motion.state == .on
        change { $0.motion = on }
    }

    @objc private func openChosen() {
        guard OPENS.indices.contains(openPopup.indexOfSelectedItem) else { return }
        let v = OPENS[openPopup.indexOfSelectedItem].1
        change { $0.openOn = v }
    }

    @objc private func foldChosen() {
        guard FOLDS.indices.contains(foldPopup.indexOfSelectedItem) else { return }
        let v = FOLDS[foldPopup.indexOfSelectedItem].1
        change { $0.foldDelay = v }
    }

    @objc private func hideToggled() {
        let on = hideFullscreen.state == .on
        change { $0.hideFullscreen = on }
    }

    /** Writes or removes the login item off the main thread, then shows what the system has */
    @objc private func loginToggled() {
        let on = atLogin.state == .on
        atLogin.isEnabled = false
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome: SaveError?
            do {
                try LoginItem.set(on)
                outcome = nil
            } catch let e as SaveError {
                outcome = e
            } catch {
                outcome = SaveError("Couldn't change the login item")
            }
            let now = LoginItem.status()
            DispatchQueue.main.async {
                self.atLogin.isEnabled = true
                self.showLogin(now)
                let said: String
                switch now {
                case .on: said = "Headroom starts when you log in."
                case .off: said = "Headroom no longer starts when you log in."
                case .needsApproval: said = "Allow Headroom in System Settings > Login Items to start it when you log in."
                case .other, .notRegistered: said = on ? "The login item is written; macOS doesn't list it as enabled yet." : "Login item changed."
                }
                self.status.stringValue = outcome?.text ?? said
            }
        }
    }

    @objc private func saveClicked() {
        // Out of the field at once: it never stays in the window, whether the save works or not
        let typed = token.stringValue
        token.stringValue = ""
        status.stringValue = "Saving…"
        app.save(url: url.stringValue, token: typed.isEmpty ? nil : typed, demo: demo.state == .on) { [weak self] error in
            guard let self else { return }
            if let error {
                self.status.stringValue = error.text + (typed.isEmpty ? "" : ". Enter the token again.")
            } else {
                // Only the token's note: what is being typed in the other fields stays
                let has = self.app.with { $0.hasToken }
                self.token.placeholderString = has ? "Saved (leave empty to keep it)" : ""
                self.status.stringValue = "Saved."
            }
        }
    }

    @objc private func removeClicked() {
        app.removeToken { [weak self] error in
            guard let self else { return }
            if let error {
                self.status.stringValue = error.text
            } else {
                self.load()
                self.status.stringValue = "Token removed."
            }
        }
    }

    @objc private func closeClicked() {
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        token.stringValue = ""
    }
}
