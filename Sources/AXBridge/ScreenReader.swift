#if canImport(UIKit) && DEBUG && targetEnvironment(simulator)
import UIKit

struct ScreenElement {
    let kind: String
    let label: String
    let value: String
    let identifier: String
    let frame: CGRect
    weak var object: NSObject?
}

/// Reads the visible screen from the in-process accessibility tree and acts on it.
@MainActor
final class ScreenReader {
    private(set) var lastElements: [ScreenElement] = []
    private(set) var lastFocusAttempt = ""

    var screenScale: CGFloat { keyWindow?.screen.scale ?? 3 }

    private var allWindows: [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
    }

    /// The app's own window. System overlays (keyboard, its tutorial, alerts) live in other
    /// windows and can become key, so the key window alone is not reliable.
    private var keyWindow: UIWindow? {
        let normal = allWindows.filter { $0.windowLevel == .normal && !$0.isHidden && $0.rootViewController != nil }
        return normal.first(where: \.isKeyWindow) ?? normal.first
    }

    // MARK: Reading

    @discardableResult
    func collect() -> [ScreenElement] {
        var result: [ScreenElement] = []
        if let window = keyWindow {
            // A presented sheet covers the screen below it; list only the sheet.
            if let top = topPresented(in: window), let view = top.view {
                walk(view, bounds: window.bounds, into: &result, depth: 0)
            } else {
                walk(window, bounds: window.bounds, into: &result, depth: 0)
            }
        }
        var seen = Set<String>()
        result = result.filter { seen.insert("\($0.kind)|\($0.label)|\(Int($0.frame.midX))|\(Int($0.frame.midY))").inserted }
        lastElements = result
        return result
    }

    func render(_ elements: [ScreenElement]) -> String {
        if elements.isEmpty { return "(empty — is the app still launching?)" }
        return elements.enumerated().map { index, e in
            var line = "\(index + 1) [\(e.kind)]"
            if !e.label.isEmpty { line += " \(e.label)" }
            if !e.value.isEmpty { line += e.label.isEmpty ? " \(e.value)" : " = \(e.value)" }
            if !e.identifier.isEmpty { line += "  id:\(e.identifier)" }
            line += "  @\(Int(e.frame.midX)),\(Int(e.frame.midY))"
            return line
        }.joined(separator: "\n")
    }

    /// `#3` is the number from the last listing, `id:foo` an accessibility identifier,
    /// anything else matches label or value: exact first, then as a substring, case-insensitive.
    func find(_ target: String) -> ScreenElement? {
        let elements = lastElements.isEmpty ? collect() : lastElements
        if target.hasPrefix("#"), let index = Int(target.dropFirst()), elements.indices.contains(index - 1) {
            return elements[index - 1]
        }
        if target.hasPrefix("id:") {
            let id = String(target.dropFirst(3))
            return elements.first { $0.identifier == id }
        }
        let needle = target.lowercased()
        func texts(_ e: ScreenElement) -> [String] { [e.label.lowercased(), e.value.lowercased()] }
        return elements.first { texts($0).contains(needle) }
            ?? elements.first { e in texts(e).contains { $0.contains(needle) } || e.identifier.lowercased() == needle }
    }

    private func walk(_ object: NSObject, bounds: CGRect, into result: inout [ScreenElement], depth: Int) {
        guard depth < 80 else { return }
        if let view = object as? UIView, view.isHidden || view.alpha < 0.01 { return }
        if object.isAccessibilityElement {
            let frame = object.accessibilityFrame
            let label = object.accessibilityLabel ?? ""
            let value = object.accessibilityValue ?? ""
            if frame.intersects(bounds), !(label.isEmpty && value.isEmpty) {
                let traits = object.accessibilityTraits
                let input = traits.contains(.button) ? nil : textInput(at: CGPoint(x: frame.midX, y: frame.midY))
                let isField = object is UIKeyInput || traits.contains(.searchField) || input != nil
                // SwiftUI puts a text field's identifier on the backing UITextField.
                let identifier = (object as? UIAccessibilityIdentification)?.accessibilityIdentifier
                    ?? input?.accessibilityIdentifier ?? ""
                result.append(ScreenElement(
                    kind: isField ? "field" : Self.kind(of: traits),
                    label: label, value: value, identifier: identifier,
                    frame: frame, object: object))
            }
            return
        }
        // SwiftUI hosting views expose their content through accessibilityElements, while
        // UIKit chrome (navigation bar, search field, tab bar) hangs off subviews. Read both;
        // duplicates are dropped after the walk.
        if let children = object.accessibilityElements {
            for case let child as NSObject in children { walk(child, bounds: bounds, into: &result, depth: depth + 1) }
        }
        if let view = object as? UIView {
            for sub in view.subviews { walk(sub, bounds: bounds, into: &result, depth: depth + 1) }
        }
    }

    private static func kind(of traits: UIAccessibilityTraits) -> String {
        if traits.contains(.header) { return "header" }
        if traits.contains(.searchField) { return "search" }
        if traits.contains(.button) { return "button" }
        if traits.contains(.link) { return "link" }
        if traits.contains(.adjustable) { return "adjustable" }
        if traits.contains(.image) { return "image" }
        if traits.contains(.tabBar) { return "tabbar" }
        return "text"
    }

    // MARK: Acting

    func activate(_ element: ScreenElement) -> Bool {
        guard let object = element.object else { return false }
        // Text fields first: SwiftUI fields and search bars report a successful
        // accessibilityActivate without taking focus.
        if element.kind == "field" || element.kind == "search",
           let input = textInput(at: CGPoint(x: element.frame.midX, y: element.frame.midY)) {
            return input.becomeFirstResponder()
        }
        if object.accessibilityActivate() { return true }
        var view = object as? UIView
        while let current = view {
            if let control = current as? UIControl {
                control.sendActions(for: .touchUpInside)
                return true
            }
            view = current.superview
        }
        return selectTab(titled: element.label)
    }

    /// Tab bar items ignore accessibilityActivate; select the tab and tell the delegate,
    /// which is how SwiftUI's TabView keeps its selection in sync.
    private func selectTab(titled title: String) -> Bool {
        guard let tabs = firstController(of: UITabBarController.self, from: keyWindow?.rootViewController),
              let index = tabs.tabBar.items?.firstIndex(where: { $0.title == title }),
              let controllers = tabs.viewControllers, controllers.indices.contains(index) else { return false }
        if tabs.delegate?.tabBarController?(tabs, shouldSelect: controllers[index]) == false { return false }
        tabs.selectedIndex = index
        tabs.delegate?.tabBarController?(tabs, didSelect: controllers[index])
        return true
    }

    func focusedInput() -> UIKeyInput? {
        for window in allWindows {
            if let input = firstResponder(in: window) as? UIKeyInput { return input }
        }
        return nil
    }

    /// The focused field, or, when none is focused and exactly one field is visible, that
    /// one. Search bars often enter search mode before they take focus.
    func focusedOrOnlyInput() async -> UIKeyInput? {
        if let input = focusedInput() { return input }
        guard let window = keyWindow else { return nil }
        var fields: [UIView] = []
        func search(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01 else { return }
            if (view is UITextField || view is UITextView), view.isUserInteractionEnabled,
               view.convert(view.bounds, to: nil).intersects(window.bounds) {
                fields.append(view)
            }
            view.subviews.forEach(search)
        }
        search(window)
        lastFocusAttempt = "\(fields.count) visible field(s): " + fields.map { String(describing: type(of: $0)) }.joined(separator: ", ")
        guard fields.count == 1 else { return nil }
        let accepted = fields[0].becomeFirstResponder()
        lastFocusAttempt += accepted ? ", focus accepted" : ", focus refused"
        try? await Task.sleep(nanoseconds: 300_000_000)
        return focusedInput() ?? (accepted ? fields[0] as? UIKeyInput : nil)
    }

    func scroll(_ direction: String) -> Bool {
        guard let window = keyWindow else { return false }
        let root: UIView = topPresented(in: window)?.view ?? window
        var candidates: [UIScrollView] = []
        func search(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01 else { return }
            if let scroll = view as? UIScrollView, scroll.isScrollEnabled,
               scroll.contentSize.height > scroll.bounds.height + 1 || scroll.contentSize.width > scroll.bounds.width + 1 {
                candidates.append(scroll)
            }
            view.subviews.forEach(search)
        }
        search(root)
        let vertical = ["down", "up", "top", "bottom"].contains(direction)
        guard let scroll = candidates
            .filter({ vertical ? $0.contentSize.height > $0.bounds.height + 1 : $0.contentSize.width > $0.bounds.width + 1 })
            .max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else { return false }
        let inset = scroll.adjustedContentInset
        let minY = -inset.top, maxY = max(minY, scroll.contentSize.height - scroll.bounds.height + inset.bottom)
        let minX = -inset.left, maxX = max(minX, scroll.contentSize.width - scroll.bounds.width + inset.right)
        var offset = scroll.contentOffset
        let pageY = scroll.bounds.height * 0.8, pageX = scroll.bounds.width * 0.8
        switch direction {
        case "down": offset.y = min(maxY, offset.y + pageY)
        case "up": offset.y = max(minY, offset.y - pageY)
        case "top": offset.y = minY
        case "bottom": offset.y = maxY
        case "right": offset.x = min(maxX, offset.x + pageX)
        case "left": offset.x = max(minX, offset.x - pageX)
        default: return false
        }
        guard offset != scroll.contentOffset else { return false }
        scroll.setContentOffset(offset, animated: false)
        return true
    }

    func goBack() -> Bool {
        guard let window = keyWindow else { return false }
        if let top = topPresented(in: window) {
            top.dismiss(animated: true)
            return true
        }
        if let nav = deepestNavigation(from: window.rootViewController), nav.viewControllers.count > 1 {
            nav.popViewController(animated: true)
            return true
        }
        return false
    }

    // MARK: Helpers

    private func topPresented(in window: UIWindow) -> UIViewController? {
        var top = window.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top === window.rootViewController ? nil : top
    }

    private func firstController<T: UIViewController>(of type: T.Type, from root: UIViewController?) -> T? {
        guard let root else { return nil }
        if let match = root as? T { return match }
        for child in root.children {
            if let found = firstController(of: type, from: child) { return found }
        }
        return firstController(of: type, from: root.presentedViewController)
    }

    private func deepestNavigation(from root: UIViewController?) -> UINavigationController? {
        guard let root else { return nil }
        var candidate = root as? UINavigationController
        let visibleChildren: [UIViewController]
        if let tabs = root as? UITabBarController {
            visibleChildren = tabs.selectedViewController.map { [$0] } ?? []
        } else {
            visibleChildren = root.children
        }
        for child in visibleChildren {
            if let deeper = deepestNavigation(from: child), deeper.viewControllers.count > 1 { candidate = deeper }
        }
        return candidate
    }

    private func textInput(at point: CGPoint) -> UIView? {
        guard let window = keyWindow else { return nil }
        var found: UIView?
        func search(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01 else { return }
            if view is UITextField || view is UITextView,
               view.convert(view.bounds, to: nil).insetBy(dx: -6, dy: -6).contains(point) {
                found = view
            }
            view.subviews.forEach(search)
        }
        search(window)
        return found
    }

    private func firstResponder(in view: UIView?) -> UIResponder? {
        guard let view else { return nil }
        if view.isFirstResponder { return view }
        for sub in view.subviews {
            if let found = firstResponder(in: sub) { return found }
        }
        return nil
    }
}
#endif
