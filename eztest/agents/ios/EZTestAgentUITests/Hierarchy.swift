// EZTest iOS agent: the UI hierarchy as XML (tags XCUIElementType*, attributes
// name, label, value, placeholderValue, enabled, visible, x, y, width, height)
// built from XCUIElement snapshots, plus the small XPath subset EZTest's host
// generates (Foundation on iOS has no XPath engine):
//   //Tag[pred] or //*[pred] with and/or/not/parentheses, @a="v", contains(@a,"v"),
//   local-name()="v", contains(local-name(),"v"); and absolute /a[1]/b[2] paths.
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import XCTest

final class HNode {
    let tag: String
    var attrs: [String: String]
    var children: [HNode] = []
    weak var parent: HNode?
    var path = ""
    let frame: CGRect

    init(tag: String, attrs: [String: String], frame: CGRect) {
        self.tag = tag
        self.attrs = attrs
        self.frame = frame
    }
}

enum Hierarchy {
    static func typeName(_ t: XCUIElement.ElementType) -> String {
        // XCUIElement.ElementType has no public string form; the debug description names the case.
        let names: [XCUIElement.ElementType: String] = [
            .application: "Application", .window: "Window", .button: "Button", .staticText: "StaticText", .textField: "TextField",
            .secureTextField: "SecureTextField", .textView: "TextView", .searchField: "SearchField", .switch: "Switch", .toggle: "Toggle",
            .image: "Image", .link: "Link", .cell: "Cell", .table: "Table", .collectionView: "CollectionView", .scrollView: "ScrollView",
            .navigationBar: "NavigationBar", .tabBar: "TabBar", .alert: "Alert", .sheet: "Sheet", .other: "Other", .keyboard: "Keyboard",
            .key: "Key", .slider: "Slider", .picker: "Picker", .pickerWheel: "PickerWheel", .segmentedControl: "SegmentedControl",
            .webView: "WebView", .menuItem: "MenuItem", .toolbar: "Toolbar", .activityIndicator: "ActivityIndicator", .progressIndicator: "ProgressIndicator",
            .checkBox: "CheckBox", .radioButton: "RadioButton", .icon: "Icon", .map: "Map", .statusBar: "StatusBar",
        ]
        return "XCUIElementType" + (names[t] ?? "Any")
    }

    static func build(_ s: XCUIElementSnapshot, screen: CGRect, parentPath: String = "", position: Int = 1) -> HNode {
        let tag = typeName(s.elementType)
        let f = s.frame
        var a: [String: String] = [
            "type": tag,
            "name": s.identifier.isEmpty ? s.label : s.identifier,
            "label": s.label,
            "enabled": s.isEnabled ? "true" : "false",
            "selected": s.isSelected ? "true" : "false",
            "visible": (!f.isEmpty && f.intersects(screen)) ? "true" : "false",
            "x": String(Int(f.origin.x)), "y": String(Int(f.origin.y)), "width": String(Int(f.size.width)), "height": String(Int(f.size.height)),
        ]
        if !s.identifier.isEmpty { a["identifier"] = s.identifier }
        if let v = s.value { a["value"] = "\(v)" }
        if let p = s.placeholderValue { a["placeholderValue"] = p }
        if s.elementType == .secureTextField { a["password"] = "true" }
        let n = HNode(tag: tag, attrs: a, frame: f)
        n.path = "\(parentPath)/\(tag)[\(position)]"
        var seen: [String: Int] = [:]
        for c in s.children {
            let ct = typeName(c.elementType)
            seen[ct, default: 0] += 1
            let child = build(c, screen: screen, parentPath: n.path, position: seen[ct]!)
            child.parent = n
            n.children.append(child)
        }
        return n
    }

    static func flatten(_ n: HNode, into out: inout [HNode]) {
        out.append(n)
        for c in n.children { flatten(c, into: &out) }
    }

    static func xml(_ root: HNode, screen: CGRect) -> String {
        var out = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy width=\"\(Int(screen.width))\" height=\"\(Int(screen.height))\">"
        write(root, &out)
        return out + "</hierarchy>"
    }

    private static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\n", with: "&#10;")
    }

    private static func write(_ n: HNode, _ out: inout String) {
        out += "<\(n.tag)"
        for k in n.attrs.keys.sorted() { out += " \(k)=\"\(esc(n.attrs[k]!))\"" }
        if n.children.isEmpty { out += "/>"; return }
        out += ">"
        for c in n.children { write(c, &out) }
        out += "</\(n.tag)>"
    }
}

/// The XPath subset (see the file header). Throws for anything else.
struct MiniXPath {
    enum XPathError: Error { case unsupported(String) }

    private indirect enum Pred {
        case eq(String, String), contains(String, String), has(String), and(Pred, Pred), or(Pred, Pred), not(Pred)
    }

    static func evaluate(_ expr: String, nodes: [HNode]) throws -> [HNode] {
        let e = expr.trimmingCharacters(in: .whitespaces)
        if e.hasPrefix("/") && !e.hasPrefix("//") { return nodes.filter { $0.path == e } }
        guard e.hasPrefix("//") else { throw XPathError.unsupported(expr) }
        var rest = String(e.dropFirst(2))
        var tag = rest
        var pred: Pred? = nil
        if let open = rest.firstIndex(of: "["), rest.hasSuffix("]") {
            tag = String(rest[..<open])
            rest = String(rest[rest.index(after: open)..<rest.index(before: rest.endIndex)])
            var p = Parser(tokens: try tokenize(rest))
            pred = try p.or()
            if p.i != p.tokens.count { throw XPathError.unsupported(expr) }
        }
        return nodes.filter { n in (tag == "*" || n.tag == tag) && (pred.map { eval($0, n) } ?? true) }
    }

    private static func value(_ key: String, _ n: HNode) -> String? {
        key == "local-name()" || key == "name()" ? n.tag : n.attrs[key]
    }

    private static func eval(_ p: Pred, _ n: HNode) -> Bool {
        switch p {
        case let .eq(k, v): return value(k, n) == v
        case let .contains(k, v): return (value(k, n) ?? "").contains(v)
        case let .has(k): return value(k, n) != nil
        case let .and(a, b): return eval(a, n) && eval(b, n)
        case let .or(a, b): return eval(a, n) || eval(b, n)
        case let .not(a): return !eval(a, n)
        }
    }

    private static func tokenize(_ s: String) throws -> [String] {
        var out: [String] = []
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i]
            if c == " " { i = s.index(after: i); continue }
            if "(),=".contains(c) { out.append(String(c)); i = s.index(after: i); continue }
            if c == "\"" || c == "'" {
                guard let end = s[s.index(after: i)...].firstIndex(of: c) else { throw XPathError.unsupported(s) }
                out.append(String(s[i...end]))
                i = s.index(after: end)
                continue
            }
            var j = i
            while j < s.endIndex, !" (),=\"'".contains(s[j]) { j = s.index(after: j) }
            var word = String(s[i..<j])
            if word == "local-name" || word == "name", s[j...].hasPrefix("()") { word += "()"; j = s.index(j, offsetBy: 2) }
            if word.isEmpty { throw XPathError.unsupported(s) }
            out.append(word)
            i = j
        }
        return out
    }

    private struct Parser {
        let tokens: [String]
        var i = 0
        mutating func eat() -> String { defer { i += 1 }; return i < tokens.count ? tokens[i] : "" }
        func peek() -> String { i < tokens.count ? tokens[i] : "" }
        static func lit(_ t: String) -> String { String(t.dropFirst().dropLast()) }
        static func key(_ t: String) throws -> String {
            if t.hasPrefix("@") { return String(t.dropFirst()) }
            if t == "local-name()" || t == "name()" { return t }
            throw XPathError.unsupported(t)
        }
        mutating func primary() throws -> Pred {
            let t = peek()
            if t == "(" { _ = eat(); let e = try or(); _ = eat(); return e }
            if t == "not" { _ = eat(); _ = eat(); let e = try or(); _ = eat(); return .not(e) }
            if t == "contains" {
                _ = eat(); _ = eat()
                let k = try Parser.key(eat()); _ = eat()
                let v = Parser.lit(eat()); _ = eat()
                return .contains(k, v)
            }
            let k = try Parser.key(eat())
            if peek() != "=" { return .has(k) }
            _ = eat()
            return .eq(k, Parser.lit(eat()))
        }
        mutating func and() throws -> Pred {
            var l = try primary()
            while peek() == "and" { _ = eat(); l = .and(l, try primary()) }
            return l
        }
        mutating func or() throws -> Pred {
            var l = try and()
            while peek() == "or" { _ = eat(); l = .or(l, try and()) }
            return l
        }
    }
}
