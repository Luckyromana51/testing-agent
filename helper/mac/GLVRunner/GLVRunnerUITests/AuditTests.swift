import XCTest

/// Runs Apple's accessibility audit (the one in Xcode's Accessibility Inspector) on another app:
/// its first screen, then each tab of its tab bar. The GLV Mac helper starts it with
///   TEST_RUNNER_GLV_BUNDLE_ID  the app to test (already installed in the Simulator)
///   TEST_RUNNER_GLV_OUT        a folder on the Mac for audit.json and the screenshots
///   TEST_RUNNER_GLV_TABS       how many tabs to open at most
/// Every issue is collected, none fails the test, so one run reports them all.
final class AuditTests: XCTestCase {
    struct Issue: Codable {
        let type: String
        let description: String
        let element: String?
    }

    struct Screen: Codable {
        let name: String
        let screenshot: String?
        let issues: [Issue]
    }

    struct Report: Codable {
        var screens: [Screen] = []
        var crashed = false
        var error: String?
    }

    @MainActor
    func testAudit() throws {
        let env = ProcessInfo.processInfo.environment
        guard let bundleId = env["GLV_BUNDLE_ID"], !bundleId.isEmpty else {
            throw XCTSkip("GLV_BUNDLE_ID is not set; the GLV Mac helper sets it.")
        }
        let outDir = URL(fileURLWithPath: env["GLV_OUT"] ?? NSTemporaryDirectory())
        let maxTabs = Int(env["GLV_TABS"] ?? "5") ?? 5
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        continueAfterFailure = true

        var report = Report()
        defer { write(report, to: outDir) }

        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        guard app.wait(for: .runningForeground, timeout: 30) else {
            report.crashed = app.state == .notRunning
            report.error = "The app did not come to the front within 30 seconds."
            return
        }
        sleep(3)
        dismissSystemAlerts()
        report.screens.append(audit(app, name: "First screen", file: "screen-1", outDir: outDir))

        let tabBar = app.tabBars.firstMatch
        guard tabBar.exists else { return }
        let buttons = tabBar.buttons.allElementsBoundByIndex
        // The first tab is the first screen, already audited.
        for (index, button) in buttons.enumerated() where index > 0 && index < maxTabs {
            guard app.state == .runningForeground else {
                report.crashed = app.state == .notRunning
                return
            }
            guard button.exists, button.isHittable else { continue }
            let label = button.label.isEmpty ? "Tab \(index + 1)" : button.label
            button.tap()
            sleep(2)
            dismissSystemAlerts()
            if app.state == .notRunning {
                report.crashed = true
                return
            }
            report.screens.append(audit(app, name: "Tab: \(label)", file: "screen-\(index + 1)", outDir: outDir))
        }
        if app.state == .notRunning { report.crashed = true }
    }

    /// Audits what is on screen now, and saves a screenshot of it.
    @MainActor
    private func audit(_ app: XCUIApplication, name: String, file: String, outDir: URL) -> Screen {
        var issues: [Issue] = []
        do {
            try app.performAccessibilityAudit(for: .all) { issue in
                issues.append(Issue(type: Self.typeName(issue.auditType), description: issue.compactDescription, element: Self.describe(issue.element)))
                // true: keep going and do not fail; the helper reports every issue.
                return true
            }
        } catch {
            issues.append(Issue(type: "auditError", description: "\(error)", element: nil))
        }
        let fileName = "\(file).png"
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let saved = (try? png.write(to: outDir.appendingPathComponent(fileName))) != nil
        return Screen(name: name, screenshot: saved ? fileName : nil, issues: issues)
    }

    /// Permission prompts (location, tracking, notifications) would cover the app: say no to each.
    @MainActor
    private func dismissSystemAlerts() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<3 {
            let alert = springboard.alerts.firstMatch
            guard alert.waitForExistence(timeout: 1) else { return }
            var tapped = false
            for label in ["Don’t Allow", "Don't Allow", "Ask App Not to Track", "Not Now", "Cancel", "OK"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    tapped = true
                    break
                }
            }
            if !tapped { return }
            sleep(1)
        }
    }

    private static func typeName(_ type: XCUIAccessibilityAuditType) -> String {
        if type.contains(.sufficientElementDescription) { return "sufficientElementDescription" }
        if type.contains(.contrast) { return "contrast" }
        if type.contains(.hitRegion) { return "hitRegion" }
        if type.contains(.dynamicType) { return "dynamicType" }
        if type.contains(.textClipped) { return "textClipped" }
        if type.contains(.trait) { return "trait" }
        if type.contains(.elementDetection) { return "elementDetection" }
        return "other"
    }

    @MainActor
    private static func describe(_ element: XCUIElement?) -> String? {
        guard let element = element, element.exists else { return nil }
        if !element.label.isEmpty { return "\"\(element.label)\"" }
        if !element.identifier.isEmpty { return element.identifier }
        return nil
    }

    private func write(_ report: Report, to outDir: URL) {
        guard let data = try? JSONEncoder().encode(report) else { return }
        try? data.write(to: outDir.appendingPathComponent("audit.json"))
        // Also in the log, in case the Simulator cannot write to the Mac's folder.
        print("GLV-AUDIT-JSON:" + data.base64EncodedString())
    }
}
