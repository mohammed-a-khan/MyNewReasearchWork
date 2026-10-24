// EZTest iOS agent entry point: one long-running UI test that serves the EZTest
// agent protocol until POST /shutdown.
//   xcodebuild test-without-building -xctestrun <file> -destination id=<udid>
// Port: EZTEST_AGENT_PORT in the test environment (default 8790). Session token:
// EZTEST_AGENT_TOKEN (EZTest passes both as TEST_RUNNER_* to xcodebuild); without a
// token the agent answers every request with 401.
//
// UNTESTED: written without access to macOS/Xcode. See ../README.md.

import XCTest

final class AgentTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    func testRunAgent() throws {
        let env = ProcessInfo.processInfo.environment
        let port = UInt16(env["EZTEST_AGENT_PORT"] ?? "") ?? 8790
        let token = env["EZTEST_AGENT_TOKEN"] ?? ""
        if token.isEmpty { NSLog("EZTest iOS agent: no EZTEST_AGENT_TOKEN; every request will be refused") }
        let server = try AgentServer(port: port, token: token)
        let runner = AgentRunner()
        server.start()
        NSLog("EZTest iOS agent \(AgentRunner.version) listening on 127.0.0.1:\(port)")
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
