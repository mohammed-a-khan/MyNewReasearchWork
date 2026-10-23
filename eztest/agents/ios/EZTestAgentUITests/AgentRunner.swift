// EZTest iOS agent: the EZTest agent protocol (version 1) on XCTest.
// Same routes and error codes as the Android agent (see eztest docs/mobile.md).
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import CoreLocation
import XCTest

struct AgentFailure: Error {
    let status: Int
    let code: String
    let message: String
    static func notSupported(_ what: String) -> AgentFailure { AgentFailure(status: 501, code: "not supported", message: "\(what) is not supported on iOS") }
    static func invalid(_ m: String) -> AgentFailure { AgentFailure(status: 400, code: "invalid argument", message: m) }
}

enum Handle {
    case element(XCUIElement)
    /// A node found by XPath over the snapshot: acted on through its frame and attributes.
    case node(HNode)
}

final class AgentRunner {
    static let version = "1.0.0"
    private var app: XCUIApplication
    private var handles: [String: Handle] = [:]
    private var order: [String] = []
    private var nextId = 1
    private(set) var shutdown = false

    init() {
        app = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    private var screen: CGRect { XCUIApplication(bundleIdentifier: "com.apple.springboard").frame }

    private func json(_ v: Any?) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["value": v ?? NSNull()], options: [.fragmentsAllowed])) ?? Data("{}".utf8)
    }

    private func errorJSON(_ f: AgentFailure) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["error": ["code": f.code, "message": f.message]])) ?? Data()
    }

    func handle(_ r: AgentRequest) {
        do {
            let body = (r.body.isEmpty ? [:] : (try JSONSerialization.jsonObject(with: r.body) as? [String: Any])) ?? [:]
            let (status, data) = try route(r.method, r.path, body)
            r.respond(status, data)
        } catch let f as AgentFailure {
            r.respond(f.status, errorJSON(f))
        } catch {
            r.respond(500, errorJSON(AgentFailure(status: 500, code: "internal", message: "\(error)")))
        }
    }

    private func str(_ b: [String: Any], _ k: String) throws -> String {
        guard let v = b[k] as? String else { throw AgentFailure.invalid("\"\(k)\" must be a string") }
        return v
    }

    private func num(_ b: [String: Any], _ k: String) throws -> Double {
        guard let v = b[k] as? NSNumber else { throw AgentFailure.invalid("\"\(k)\" must be a number") }
        return v.doubleValue
    }

    private func register(_ h: Handle) -> String {
        let id = "e\(nextId)"
        nextId += 1
        handles[id] = h
        order.append(id)
        if order.count > 1000 { handles.removeValue(forKey: order.removeFirst()) }
        return id
    }

    private func handleOf(_ id: String) throws -> Handle {
        guard let h = handles[id] else { throw AgentFailure(status: 404, code: "stale element", message: "element \(id) is no longer on screen") }
        if case let .element(e) = h, !e.exists { throw AgentFailure(status: 404, code: "stale element", message: "element \(id) is no longer on screen") }
        return h
    }

    private func snapshotNodes() throws -> (HNode, [HNode]) {
        let root = Hierarchy.build(try app.snapshot(), screen: screen)
        var all: [HNode] = []
        Hierarchy.flatten(root, into: &all)
        return (root, all)
    }

    private func rect(_ f: CGRect) -> [String: Int] {
        ["x": Int(f.origin.x), "y": Int(f.origin.y), "width": Int(f.size.width), "height": Int(f.size.height)]
    }

    private func find(_ using: String, _ value: String) throws -> [String] {
        let any = app.descendants(matching: .any)
        switch using {
        case "accessibility id", "id":
            return any.matching(identifier: value).allElementsBoundByIndex.map { register(.element($0)) }
        case "predicate":
            return any.matching(NSPredicate(format: value)).allElementsBoundByIndex.map { register(.element($0)) }
        case "text":
            return any.matching(NSPredicate(format: "label == %@ OR value == %@", value, value)).allElementsBoundByIndex.map { register(.element($0)) }
        case "text contains":
            return any.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", value, value)).allElementsBoundByIndex.map { register(.element($0)) }
        case "class":
            let (_, nodes) = try snapshotNodes()
            return nodes.filter { $0.tag == value }.map { register(.node($0)) }
        case "xpath":
            let (_, nodes) = try snapshotNodes()
            do { return try MiniXPath.evaluate(value, nodes: nodes).map { register(.node($0)) } } catch { throw AgentFailure.invalid("unsupported XPath \(value) (the iOS agent supports //Tag[predicate] and absolute paths)") }
        case "css": throw AgentFailure.notSupported("CSS selectors (web views only)")
        default: throw AgentFailure.invalid("unknown find strategy \"\(using)\"")
        }
    }

    private func center(_ f: CGRect) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: f.midX, dy: f.midY))
    }

    private func point(_ x: Double, _ y: Double) -> XCUICoordinate {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
    }

    private func frameOf(_ h: Handle) -> CGRect {
        switch h { case let .element(e): return e.frame; case let .node(n): return n.frame }
    }

    private func attr(_ h: Handle, _ name: String) -> String? {
        switch h {
        case let .node(n): return n.attrs[name]
        case let .element(e):
            switch name {
            case "name", "identifier": return e.identifier
            case "label": return e.label
            case "value": return e.value.map { "\($0)" }
            case "placeholderValue": return e.placeholderValue
            case "enabled": return e.isEnabled ? "true" : "false"
            case "selected": return e.isSelected ? "true" : "false"
            case "visible": return e.isHittable ? "true" : "false"
            case "type": return Hierarchy.typeName(e.elementType)
            default: return nil
            }
        }
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func route(_ method: String, _ path: String, _ b: [String: Any]) throws -> (Int, Data) {
        if path.hasPrefix("/element/") {
            let rest = path.dropFirst("/element/".count).split(separator: "/", maxSplits: 1).map(String.init)
            guard rest.count == 2 else { throw AgentFailure(status: 404, code: "unknown command", message: path) }
            let h = try handleOf(rest[0])
            switch (method, rest[1]) {
            case ("POST", "click"): center(frameOf(h)).tap(); return (200, json(nil))
            case ("POST", "clear"):
                center(frameOf(h)).tap()
                let current = attr(h, "value") ?? ""
                app.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
                return (200, json(nil))
            case ("POST", "type"):
                if case let .element(e) = h { e.tap(); e.typeText(try str(b, "text")) } else { center(frameOf(h)).tap(); app.typeText(try str(b, "text")) }
                return (200, json(nil))
            case ("GET", "text"): return (200, json(attr(h, "value").flatMap { $0.isEmpty ? nil : $0 } ?? attr(h, "label") ?? ""))
            case ("GET", "rect"): return (200, json(rect(frameOf(h))))
            case ("GET", "displayed"):
                if case let .element(e) = h { return (200, json(e.exists && e.isHittable)) }
                return (200, json(attr(h, "visible") == "true"))
            case ("GET", "enabled"): return (200, json(attr(h, "enabled") != "false"))
            case ("GET", "selected"): return (200, json(attr(h, "selected") == "true" || attr(h, "value") == "1"))
            default:
                if method == "GET", rest[1].hasPrefix("attribute/") {
                    let name = String(rest[1].dropFirst("attribute/".count)).removingPercentEncoding ?? ""
                    return (200, json(attr(h, name)))
                }
                throw AgentFailure(status: 404, code: "unknown command", message: "\(method) /element/:id/\(rest[1])")
            }
        }
        switch (method, path) {
        case ("GET", "/status"):
            let d = UIDevice.current
            let status: [String: Any] = ["ready": true, "agent": "eztest-ios", "version": AgentRunner.version, "protocol": 1, "platform": "ios",
                                         "device": ["model": d.model, "name": d.name, "systemVersion": d.systemVersion]]
            return (200, try JSONSerialization.data(withJSONObject: status))
        case ("POST", "/find"):
            let ids = try find(try str(b, "using"), try str(b, "value"))
            return (200, try JSONSerialization.data(withJSONObject: ["elements": ids]))
        case ("GET", "/source"):
            let (root, _) = try snapshotNodes()
            return (200, json(Hierarchy.xml(root, screen: screen)))
        case ("GET", "/screenshot"): return (200, json(XCUIScreen.main.screenshot().pngRepresentation.base64EncodedString()))
        case ("GET", "/window"): return (200, json(rect(screen)))
        case ("POST", "/gesture"): try gesture(b); return (200, json(nil))
        case ("POST", "/key"): try key(try str(b, "key")); return (200, json(nil))
        case ("POST", "/keys"): app.typeText(try str(b, "text")); return (200, json(nil))
        case ("GET", "/orientation"): return (200, json(XCUIDevice.shared.orientation.isLandscape ? "landscape" : "portrait"))
        case ("POST", "/orientation"):
            XCUIDevice.shared.orientation = try str(b, "value") == "landscape" ? .landscapeLeft : .portrait
            return (200, json(nil))
        case ("GET", "/alert"): return (200, json(alert().map { a in ([a.label] + a.staticTexts.allElementsBoundByIndex.map { $0.label }).filter { !$0.isEmpty }.joined(separator: "\n") }))
        case ("POST", "/alert/accept"), ("POST", "/alert/dismiss"):
            guard let a = alert() else { throw AgentFailure(status: 404, code: "no such alert", message: "no alert is open") }
            let buttons = a.buttons.allElementsBoundByIndex
            guard let button = path.hasSuffix("accept") ? buttons.last : buttons.first else { throw AgentFailure(status: 404, code: "no such alert", message: "the alert has no buttons") }
            button.tap()
            return (200, json(nil))
        case ("POST", "/keyboard/hide"):
            if app.keyboards.count > 0 {
                let done = app.keyboards.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "Return", "Hide keyboard"])).firstMatch
                if done.exists { done.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap() }
            }
            return (200, json(nil))
        case ("POST", "/app/launch"): app = XCUIApplication(bundleIdentifier: try str(b, "appId")); app.launch(); return (200, json(nil))
        case ("POST", "/app/activate"): app = XCUIApplication(bundleIdentifier: try str(b, "appId")); app.activate(); return (200, json(nil))
        case ("POST", "/app/terminate"): XCUIApplication(bundleIdentifier: try str(b, "appId")).terminate(); return (200, json(nil))
        case ("POST", "/app/background"):
            let seconds = try num(b, "seconds")
            XCUIDevice.shared.press(.home)
            if seconds >= 0 { Thread.sleep(forTimeInterval: seconds); app.activate() }
            return (200, json(nil))
        case ("POST", "/deeplink"):
            guard let url = URL(string: try str(b, "url")) else { throw AgentFailure.invalid("bad URL") }
            if #available(iOS 16.4, *) { XCUIDevice.shared.system.open(url) } else { throw AgentFailure.notSupported("opening deep links before iOS 16.4") }
            return (200, json(nil))
        case ("POST", "/geolocation"):
            if #available(iOS 16.4, *) {
                XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: try num(b, "latitude"), longitude: try num(b, "longitude")))
                return (200, json(nil))
            }
            throw AgentFailure.notSupported("simulating the location before iOS 16.4")
        case ("POST", "/notifications/open"): throw AgentFailure.notSupported("opening the notification centre")
        case ("POST", "/lock"), ("POST", "/unlock"): throw AgentFailure.notSupported("locking the device from XCTest")
        case ("POST", "/shake"): throw AgentFailure.notSupported("shaking the device")
        case ("POST", "/shutdown"): shutdown = true; return (200, json(nil))
        default: throw AgentFailure(status: 404, code: "unknown command", message: "\(method) \(path)")
        }
    }

    private func alert() -> XCUIElement? {
        for owner in [app, XCUIApplication(bundleIdentifier: "com.apple.springboard")] {
            let a = owner.alerts.firstMatch
            if a.exists { return a }
        }
        return nil
    }

    private func key(_ k: String) throws {
        switch k.lowercased() {
        case "enter", "return": app.typeText("\n")
        case "tab": app.typeText("\t")
        case "backspace", "delete": app.typeText(XCUIKeyboardKey.delete.rawValue)
        case "space": app.typeText(" ")
        case "home": XCUIDevice.shared.press(.home)
        case "back":
            let back = app.navigationBars.buttons.element(boundBy: 0)
            guard back.exists else { throw AgentFailure.notSupported("a back key (no navigation bar back button on screen)") }
            back.tap()
        #if !targetEnvironment(simulator)
        case "volume_up": XCUIDevice.shared.press(.volumeUp)
        case "volume_down": XCUIDevice.shared.press(.volumeDown)
        #endif
        default:
            if k.count == 1 { app.typeText(k) } else { throw AgentFailure.invalid("unknown key \"\(k)\"") }
        }
    }

    /// Finger paths -> XCUICoordinate gestures: tap, long press, drag/swipe; two fingers -> pinch.
    private func gesture(_ b: [String: Any]) throws {
        guard let fingers = b["fingers"] as? [[[String: Any]]], !fingers.isEmpty else { throw AgentFailure.invalid("gesture needs \"fingers\"") }
        let paths: [[(x: Double, y: Double, t: Double)]] = try fingers.map { f in
            guard f.count >= 2 else { throw AgentFailure.invalid("each finger needs at least two points") }
            return try f.map { p in
                guard let x = p["x"] as? NSNumber, let y = p["y"] as? NSNumber, let t = p["t"] as? NSNumber else { throw AgentFailure.invalid("points need x, y, t") }
                return (x.doubleValue, y.doubleValue, t.doubleValue)
            }
        }
        let overlapping = paths.count == 2 && paths[0].first!.t < paths[1].last!.t && paths[1].first!.t < paths[0].last!.t
        if overlapping {
            let d = { (a: (x: Double, y: Double, t: Double), b: (x: Double, y: Double, t: Double)) in hypot(a.x - b.x, a.y - b.y) }
            let start = max(1, d(paths[0].first!, paths[1].first!))
            let end = max(1, d(paths[0].last!, paths[1].last!))
            let seconds = max(0.1, (paths[0].last!.t - paths[0].first!.t) / 1000)
            app.pinch(withScale: CGFloat(end / start), velocity: CGFloat((end / start - 1) / seconds))
            return
        }
        guard paths.count <= 2 else { throw AgentFailure.notSupported("gestures with more than two fingers") }
        for f in paths.sorted(by: { $0.first!.t < $1.first!.t }) {
            let a = f.first!, z = f.last!
            let moved = hypot(z.x - a.x, z.y - a.y) > 10
            let hold = (f.count > 2 ? f[1].t - a.t : z.t - a.t) / 1000
            if !moved {
                if z.t - a.t < 300 { point(a.x, a.y).tap() } else { point(a.x, a.y).press(forDuration: (z.t - a.t) / 1000) }
            } else {
                point(a.x, a.y).press(forDuration: max(0.05, hold), thenDragTo: point(z.x, z.y))
            }
        }
    }
}
