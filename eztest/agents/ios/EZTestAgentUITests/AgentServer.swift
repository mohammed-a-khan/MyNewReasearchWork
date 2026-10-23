// EZTest iOS agent: HTTP/1.1 server (Network framework) for the EZTest agent protocol.
// Connections are accepted on a background queue; requests are executed on the
// XCTest main thread (XCUI APIs must run there) by AgentRunner.
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import Foundation
import Network

final class AgentRequest {
    let method: String
    let path: String
    let body: Data
    private let reply: (Int, Data) -> Void

    init(method: String, path: String, body: Data, reply: @escaping (Int, Data) -> Void) {
        self.method = method
        self.path = path
        self.body = body
        self.reply = reply
    }

    func respond(_ status: Int, _ json: Data) { reply(status, json) }
}

final class AgentServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "io.eztest.agent.server")
    private let lock = NSLock()
    private var pending: [AgentRequest] = []

    init(port: UInt16) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        #if targetEnvironment(simulator)
        // The simulator shares the host's network: listen on the loopback only.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: params)
        #else
        // On a device the host connects through usbmuxd.
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        #endif
        listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
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
        for l in lines.dropFirst() {
            let kv = l.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if kv.count == 2, kv[0].lowercased() == "content-length" { length = Int(kv[1]) ?? 0 }
        }
        let bodyStart = headEnd.upperBound
        guard buf.count - bodyStart >= length else { return nil }
        let body = buf.subdata(in: bodyStart..<(bodyStart + length))
        var path = String(parts[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        return AgentRequest(method: String(parts[0]), path: path, body: body) { status, json in
            var out = Data("HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(json.count)\r\nConnection: close\r\n\r\n".utf8)
            out.append(json)
            c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
        }
    }
}
