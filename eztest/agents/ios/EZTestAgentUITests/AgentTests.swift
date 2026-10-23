// EZTest iOS agent entry point: one long-running UI test that serves the EZTest
// agent protocol until POST /shutdown.
//   xcodebuild test-without-building -xctestrun <file> -destination id=<udid>
// Port: EZTEST_AGENT_PORT in the test environment (default 8790).
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import XCTest

final class AgentTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    func testRunAgent() throws {
        let port = UInt16(ProcessInfo.processInfo.environment["EZTEST_AGENT_PORT"] ?? "") ?? 8790
        let server = try AgentServer(port: port)
        let runner = AgentRunner()
        server.start()
        NSLog("EZTest iOS agent \(AgentRunner.version) listening on port \(port)")
        // XCUI APIs must run on this (the test) thread: requests are executed here, one at a time.
        while !runner.shutdown {
            if let request = server.next() {
                runner.handle(request)
            } else {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
            }
        }
        server.stop()
    }
}
