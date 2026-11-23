#if canImport(UIKit) && DEBUG && targetEnvironment(simulator)
import UIKit

struct ScreenElement {
    let kind: String
    let label: String
    let value: String
    let identifier: String
    let actions: [String]
    let frame: CGRect
    weak var object: NSObject?
}

enum ActionResult {
    case ok
    case notFound
    case noMatchingAction(available: [String])
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

    /// The app's own normal window. System overlays (keyboard, its tutorial, alerts) live in
    /// other windows and can become key, so the key window alone is not reliable.
    private var keyWindow: UIWindow? {
        let normal = allWindows.filter { $0.windowLevel == .normal && !$0.isHidden && $0.rootViewController != nil }
        return normal.first(where: \.isKeyWindow) ?? normal.first
    }

    /// Visible alert/popover/menu windows above `.normal`, excluding keyboard and text-effects windows.
    private var overlayWindows: [UIWindow] {
        allWindows
            .filter { window in
                guard window.windowLevel > .normal, !window.isHidden, window.alpha > 0.01 else { return false }
                let className = String(describing: type(of: window))
                return !className.contains("Keyboard") && !className.contains("TextEffects")
            }
            .sorted { $0.windowLevel.rawValue > $1.windowLevel.rawValue }
    }

    /// The currently active window: the highest overlay window with visible elements, or `keyWindow`.
    private var activeWindow: UIWindow? {
        for overlay in overlayWindows where !collectElements(in: overlay, allowOverlayFallback: true).isEmpty {
            return overlay
        }
        return keyWindow
    }

    // MARK: Reading

    @discardableResult
    func collect() -> [ScreenElement] {
        for overlay in overlayWindows {
            let elements = collectElements(in: overlay, allowOverlayFallback: true)
            if !elements.isEmpty {
                lastElements = elements
                return elements
            }
        }
        if let window = keyWindow {
            let elements = collectElements(in: window, allowOverlayFallback: false)
            lastElements = elements
            return elements
        }
        lastElements = []
        return []
    }

    private func collectElements(in window: UIWindow, allowOverlayFallback: Bool) -> [ScreenElement] {
        var result: [ScreenElement] = []
        let windowBounds = window.convert(window.bounds, to: nil)
        // A presented sheet/popover/alert covers the screen below it; list only that controller.
        if let top = topPresented(in: window), let view = top.view {
            let viewBounds = view.window.map { $0.convert($0.bounds, to: nil) } ?? windowBounds
            walk(view, bounds: viewBounds, into: &result, depth: 0)
            if result.isEmpty && allowOverlayFallback {
                walk(window, bounds: windowBounds, into: &result, depth: 0)
            }
        } else {
            walk(window, bounds: windowBounds, into: &result, depth: 0)
        }
        var seen = Set<String>()
        return result.filter { seen.insert("\($0.kind)|\($0.label)|\(Int($0.frame.midX))|\(Int($0.frame.midY))").inserted }
    }

    func render(_ elements: [ScreenElement]) -> String {
        if elements.isEmpty { return "(empty — is the app still launching?)" }
        return elements.enumerated().map { index, e in
            let label = ScreenText.oneLine(e.label), value = ScreenText.oneLine(e.value)
            var line = "\(index + 1) [\(e.kind)]"
            if !label.isEmpty { line += " \(label)" }
            if !value.isEmpty { line += label.isEmpty ? " \(value)" : " = \(value)" }
            if !e.identifier.isEmpty { line += "  id:\(ScreenText.oneLine(e.identifier))" }
            if !e.actions.isEmpty { line += "  actions:[\(e.actions.map(ScreenText.oneLine).joined(separator: ", "))]" }
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
        func texts(_ e: ScreenElement) -> [String] {
            [ScreenText.oneLine(e.label).lowercased(), ScreenText.oneLine(e.value).lowercased()]
        }
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
                let actions = object.accessibilityCustomActions?.map(\.name) ?? []
                result.append(ScreenElement(
                    kind: isField ? "field" : Self.kind(of: traits),
                    label: label, value: value, identifier: identifier, actions: actions,
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
        // SwiftUI Stepper buttons are plain elements that do not react to activation.
        if element.identifier == "Increment" || element.identifier == "Decrement",
           adjust(element, direction: element.identifier.lowercased()) {
            return true
        }
        return selectTab(titled: element.label)
    }

    func performAction(target: String, actionName: String) -> ActionResult {
        collect()
        guard let element = find(target), let object = element.object else { return .notFound }
        let customActions = object.accessibilityCustomActions ?? []
        let available = customActions.map(\.name)
        let match = customActions.first { $0.name.caseInsensitiveCompare(actionName) == .orderedSame }
            ?? customActions.first { $0.name.localizedCaseInsensitiveContains(actionName) }
        guard let action = match, invoke(action) else {
            return .noMatchingAction(available: available)
        }
        return .ok
    }

    /// Steps an adjustable control. The element itself may be adjustable (Slider, Picker), or it
    /// belongs to a container that is: SwiftUI's Stepper is two plain elements inside a `UIStepper`,
    /// which ignores `accessibilityIncrement`, so the stepper's value is changed directly.
    func adjust(_ element: ScreenElement, direction: String, steps: Int = 1) -> Bool {
        guard direction == "increment" || direction == "decrement", let object = element.object else { return false }
        let count = max(1, min(steps, 20))
        let up = direction == "increment"
        var candidate: NSObject? = object
        for _ in 0..<3 {
            guard let current = candidate else { break }
            if let stepper = current as? UIStepper {
                // One step per event: SwiftUI moves its binding by one step for each change it sees.
                for _ in 0..<count {
                    let next = stepper.value + stepper.stepValue * (up ? 1 : -1)
                    stepper.value = min(stepper.maximumValue, max(stepper.minimumValue, next))
                    stepper.sendActions(for: .valueChanged)
                }
                return true
            }
            if current.accessibilityTraits.contains(.adjustable) {
                for _ in 0..<count {
                    if up { current.accessibilityIncrement() } else { current.accessibilityDecrement() }
                }
                return true
            }
            candidate = Self.accessibilityContainer(of: current)
        }
        return false
    }

    private static func accessibilityContainer(of object: NSObject) -> NSObject? {
        let selector = NSSelectorFromString("accessibilityContainer")
        guard object.responds(to: selector) else { return nil }
        return object.perform(selector)?.takeUnretainedValue() as? NSObject
    }

    func submitInput(_ input: UIKeyInput) {
        if let tf = input as? UITextField {
            let shouldReturn = tf.delegate?.textFieldShouldReturn?(tf) ?? true
            tf.sendActions(for: .editingDidEndOnExit)
            if shouldReturn, tf.isFirstResponder { tf.resignFirstResponder() }
        } else if input is UITextView {
            input.insertText("\n")
        } else if let responder = input as? UIResponder {
            responder.resignFirstResponder()
        }
    }

    /// Selects everything and deletes it, which is what the user would do: delegates,
    /// formatters and SwiftUI bindings (`TextField`, `TextEditor`, `.searchable`) see a
    /// normal edit. Falls back to assigning the text when the field refuses the selection.
    func clearInput(_ input: UIKeyInput) {
        guard input.hasText else { return }
        if let field = input as? UITextInput, let range = field.textRange(from: field.beginningOfDocument, to: field.endOfDocument) {
            field.selectedTextRange = range
            input.deleteBackward()
            if !input.hasText { return }
        }
        if let tf = input as? UITextField {
            tf.text = ""
            tf.sendActions(for: .editingChanged)
            NotificationCenter.default.post(name: UITextField.textDidChangeNotification, object: tf)
        } else if let tv = input as? UITextView {
            tv.text = ""
            tv.delegate?.textViewDidChange?(tv)
            NotificationCenter.default.post(name: UITextView.textDidChangeNotification, object: tv)
        } else {
            var count = 0
            while input.hasText, count < 1000 {
                input.deleteBackward()
                count += 1
            }
        }
    }

    /// Runs a custom action. Block-based actions (SwiftUI) are called directly. Target/selector
    /// actions are called through their IMP only for the signatures UIKit documents, `-(BOOL)action:(id)`
    /// and `-(void)action:(id)` or without argument; anything else goes through the responder machinery
    /// so a mismatched signature never reaches an unchecked function-pointer cast.
    private func invoke(_ customAction: UIAccessibilityCustomAction) -> Bool {
        if let handler = customAction.actionHandler {
            return handler(customAction)
        }
        guard let target = customAction.target else { return false }
        let selector = customAction.selector
        if let obj = target as? NSObjectProtocol, !obj.responds(to: selector) { return false }
        guard let method = class_getInstanceMethod(type(of: target), selector) else {
            return UIApplication.shared.sendAction(selector, to: target, from: customAction, for: nil)
        }
        let argCount = method_getNumberOfArguments(method)
        var retType = [CChar](repeating: 0, count: 16)
        method_getReturnType(method, &retType, retType.count)
        let returnsVoid = retType[0] == CChar(UnicodeScalar("v").value)
        let returnsBool = retType[0] == CChar(UnicodeScalar("B").value) || retType[0] == CChar(UnicodeScalar("c").value)
        guard (argCount == 2 || argCount == 3), returnsVoid || returnsBool else {
            return UIApplication.shared.sendAction(selector, to: target, from: customAction, for: nil)
        }
        let imp = method_getImplementation(method)
        switch (returnsVoid, argCount) {
        case (true, 3):
            typealias Fn = @convention(c) (AnyObject, Selector, UIAccessibilityCustomAction) -> Void
            unsafeBitCast(imp, to: Fn.self)(target, selector, customAction)
            return true
        case (true, _):
            typealias Fn = @convention(c) (AnyObject, Selector) -> Void
            unsafeBitCast(imp, to: Fn.self)(target, selector)
            return true
        case (false, 3):
            typealias Fn = @convention(c) (AnyObject, Selector, UIAccessibilityCustomAction) -> ObjCBool
            return unsafeBitCast(imp, to: Fn.self)(target, selector, customAction).boolValue
        default:
            typealias Fn = @convention(c) (AnyObject, Selector) -> ObjCBool
            return unsafeBitCast(imp, to: Fn.self)(target, selector).boolValue
        }
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
        guard let window = activeWindow else { return nil }
        let root: UIView = topPresented(in: window)?.view ?? window
        var fields: [UIView] = []
        func search(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01 else { return }
            if (view is UITextField || view is UITextView), view.isUserInteractionEnabled,
               view.convert(view.bounds, to: nil).intersects(window.bounds) {
                fields.append(view)
            }
            view.subviews.forEach(search)
        }
        search(root)
        lastFocusAttempt = "\(fields.count) visible field(s): " + fields.map { String(describing: type(of: $0)) }.joined(separator: ", ")
        guard fields.count == 1 else { return nil }
        let accepted = fields[0].becomeFirstResponder()
        lastFocusAttempt += accepted ? ", focus accepted" : ", focus refused"
        try? await Task.sleep(nanoseconds: 300_000_000)
        return focusedInput() ?? (accepted ? fields[0] as? UIKeyInput : nil)
    }

    func scroll(_ direction: String) -> Bool {
        guard let window = activeWindow else { return false }
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
        if let active = activeWindow {
            if let top = topPresented(in: active) {
                top.dismiss(animated: true)
                return true
            }
            if active !== keyWindow, let root = active.rootViewController, root.presentingViewController != nil {
                root.dismiss(animated: true)
                return true
            }
        }
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
        let windows = overlayWindows + (keyWindow.map { [$0] } ?? [])
        for window in windows {
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
            if let found { return found }
        }
        return nil
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
