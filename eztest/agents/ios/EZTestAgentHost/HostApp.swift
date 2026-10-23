// The host app the EZTest UI-test bundle needs (XCTest UI tests run next to an app target).
// It shows nothing; the agent drives the app under test by bundle id.
import SwiftUI

@main
struct EZTestAgentHostApp: App {
    var body: some Scene {
        WindowGroup { Text("EZTest agent host") }
    }
}
