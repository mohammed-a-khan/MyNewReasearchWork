// EZTest iOS agent: HTTP/1.1 server (Network framework) for the EZTest agent protocol.
// Connections are accepted on a background queue; requests are executed on the
// XCTest main thread (XCUI APIs must run there) by AgentRunner.
// It listens on the loopback only (simulator: the host's loopback; device: the
// device's, which usbmuxd tunnels reach) and answers only requests carrying the
// session token it was started with (X-EZTest-Agent-Token); anything else gets
// 401 "unauthorized" before reaching the runner.
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import Foundation
import Network

final class AgentRequest {
    let method: String
    let path: String
    let body: Data
    /** The X-EZTest-Agent-Token header, if any. */
    let token: String?
    private let reply: (Int, Data) -> Void

    init(method: String, path: String, body: Data, token: String?, reply: @escaping (Int, Data) -> Void) {
        self.method = method
        self.path = path
        self.body = body
        self.token = token
        self.reply = reply
    }

    func respond(_ status: Int, _ json: Data) { reply(status, json) }
}

final class AgentServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "io.eztest.agent.server")
    private let lock = NSLock()
    private var pending: [AgentRequest] = []
    private let token: [UInt8]

    init(port: UInt16, token: String) throws {
        self.token = Array(token.utf8)
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Loopback only, on the simulator (the host's network) and on a device (usbmuxd tunnels to it).
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: params)
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
    }

    /** Constant-time comparison with the session token (an empty token accepts nothing). */
    private func authorized(_ presented: String?) -> Bool {
        guard let p = presented, !token.isEmpty else { return false }
        let b = Array(p.utf8)
        guard b.count == token.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<b.count { diff |= b[i] ^ token[i] }
        return diff == 0
    }

    func start() { listener.start(queue: queue) }
    func stop() { listener.cancel() }

    /** The next request, if one arrived (called from the main thread). */
    func next() -> AgentRequest? {
        lock.lock(); defer { lock.unlock() }
        return pending.isEmpty ? nil : pending.removeFirst()
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        read(c, buffer: Data())
    }

    private func read(_ c: NWConnection, buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self = self else { return }
            var buf = buffer
            if let d = data { buf.append(d) }
            if let req = self.parse(buf, c) {
                guard self.authorized(req.token) else {
                    req.respond(401, Data("{\"error\":{\"code\":\"unauthorized\",\"message\":\"missing or wrong session token\"}}".utf8))
                    return
                }
                self.lock.lock(); self.pending.append(req); self.lock.unlock()
                return
            }
            if done || error != nil { c.cancel(); return }
            self.read(c, buffer: buf)
        }
    }

    private func parse(_ buf: Data, _ c: NWConnection) -> AgentRequest? {
        guard let headEnd = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buf[..<headEnd.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { return nil }
        var length = 0
        var token: String?
        for l in lines.dropFirst() {
            let kv = l.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if kv.count == 2, kv[0].lowercased() == "content-length" { length = Int(kv[1]) ?? 0 }
            if kv.count == 2, kv[0].lowercased() == "x-eztest-agent-token" { token = kv[1] }
        }
        let bodyStart = headEnd.upperBound
        guard buf.count - bodyStart >= length else { return nil }
        let body = buf.subdata(in: bodyStart..<(bodyStart + length))
        var path = String(parts[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        return AgentRequest(method: String(parts[0]), path: path, body: body, token: token) { status, json in
            var out = Data("HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n".utf8)
            out.append(json)
            c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
        }
    }
}
