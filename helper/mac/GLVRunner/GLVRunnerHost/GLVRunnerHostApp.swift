import SwiftUI

/// An empty app. Xcode needs one to build a UI test runner; the tests open the client's app by its
/// bundle ID, not this one.
@main
struct GLVRunnerHostApp: App {
    var body: some Scene {
        WindowGroup {
            Text("GLV audit runner")
        }
    }
}
