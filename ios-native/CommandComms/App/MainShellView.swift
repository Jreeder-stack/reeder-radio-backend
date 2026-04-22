import SwiftUI

// MARK: - Page history

/// Single page received from dispatch (via APNs). Persisted in-memory only;
/// the Pages tab reads from this list so taps on notifications can scroll to
/// a specific page.
struct PageRecord: Identifiable, Equatable {
    let id: String
    let message: String
    let sender: String
    let receivedAt: Date
}

/// Shared, observable list of recently received pages. Both the foreground
/// presentation hook and the tap handler in `AppDelegate` push into this
/// store so the Pages tab is always up to date.
@MainActor
final class PageHistoryStore: ObservableObject {
    static let shared = PageHistoryStore()
    @Published private(set) var pages: [PageRecord] = []
    private init() {}

    func record(id: String, message: String, sender: String) {
        guard !id.isEmpty else { return }
        if let idx = pages.firstIndex(where: { $0.id == id }) {
            pages.remove(at: idx)
        }
        pages.insert(
            PageRecord(id: id, message: message, sender: sender, receivedAt: Date()),
            at: 0
        )
        if pages.count > 100 { pages = Array(pages.prefix(100)) }
    }
}

// MARK: - Emergency alerts

/// Active emergency surfaced from a notification tap. Cleared by the user via
/// the radio banner.
struct EmergencyAlert: Equatable, Identifiable {
    let unitId: String
    let channelId: String
    let receivedAt: Date
    var id: String { "\(channelId)-\(unitId)-\(Int(receivedAt.timeIntervalSince1970))" }
}

@MainActor
final class EmergencyAlertCenter: ObservableObject {
    static let shared = EmergencyAlertCenter()
    @Published var active: EmergencyAlert?
    private init() {}

    func raise(unitId: String, channelId: String) {
        active = EmergencyAlert(unitId: unitId, channelId: channelId, receivedAt: Date())
    }

    func clear() { active = nil }
}

// MARK: - Tabs

enum AppTab: Hashable {
    case radio
    case pages
    case device
    case settings
}

// MARK: - Shell

struct MainShellView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: NotificationRouter
    @StateObject private var pageHistory = PageHistoryStore.shared
    @StateObject private var emergencyCenter = EmergencyAlertCenter.shared
    @State private var selectedTab: AppTab = .radio
    @State private var highlightedPageId: String?

    var body: some View {
        TabView(selection: $selectedTab) {
            RadioView()
                .tabItem { Label("Radio", systemImage: "antenna.radiowaves.left.and.right") }
                .tag(AppTab.radio)

            PagesView(
                history: pageHistory,
                highlightedPageId: $highlightedPageId
            )
            .tabItem { Label("Pages", systemImage: "tray.full") }
            .tag(AppTab.pages)

            DeviceRegistrationView()
                .tabItem { Label("Device", systemImage: "iphone.radiowaves.left.and.right") }
                .tag(AppTab.device)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .tint(.cyan)
        .environmentObject(pageHistory)
        .environmentObject(emergencyCenter)
        .onAppear { handleRoute(router.consume()) }
        .onChange(of: router.pending) { _, _ in
            handleRoute(router.consume())
        }
    }

    private func handleRoute(_ route: NotificationRoute?) {
        guard let route else { return }
        switch route {
        case .page(let id, let message, let sender):
            // Make sure the page is in history (foreground hook also records it,
            // but we double-record here for taps that arrive from a cold start).
            pageHistory.record(id: id, message: message, sender: sender)
            selectedTab = .pages
            highlightedPageId = id
        case .emergency(let unitId, let channelId):
            selectedTab = .radio
            if !channelId.isEmpty,
               appState.signaling.currentChannel != channelId {
                appState.signaling.joinChannel(channelId)
                appState.radio.channelId = channelId
            }
            emergencyCenter.raise(unitId: unitId, channelId: channelId)
        }
    }
}

// MARK: - Pages tab

struct PagesView: View {
    @ObservedObject var history: PageHistoryStore
    @Binding var highlightedPageId: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                Group {
                    if history.pages.isEmpty {
                        emptyState
                    } else {
                        pageList
                    }
                }
            }
            .navigationTitle("Pages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .foregroundColor(.white)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray")
                .font(.system(size: 40))
                .foregroundColor(.gray)
            Text("No pages yet")
                .font(.headline)
                .foregroundColor(.gray)
            Text("Pages from dispatch will appear here.")
                .font(.footnote)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }

    private var pageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(history.pages) { page in
                        PageRow(page: page, highlighted: page.id == highlightedPageId)
                            .id(page.id)
                    }
                }
                .padding()
            }
            .onChange(of: highlightedPageId) { _, newValue in
                guard let target = newValue else { return }
                withAnimation(.easeInOut(duration: 0.25)) {
                    proxy.scrollTo(target, anchor: .center)
                }
                // Clear the highlight after a few seconds so future visits
                // don't keep flashing the same row.
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 4_000_000_000)
                    if highlightedPageId == target {
                        highlightedPageId = nil
                    }
                }
            }
            .onAppear {
                if let target = highlightedPageId {
                    DispatchQueue.main.async {
                        proxy.scrollTo(target, anchor: .center)
                    }
                }
            }
        }
    }
}

private struct PageRow: View {
    let page: PageRecord
    let highlighted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(page.sender.isEmpty ? "Dispatch" : page.sender)
                    .font(.headline)
                    .foregroundColor(.cyan)
                Spacer()
                Text(page.receivedAt, style: .time)
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            Text(page.message)
                .font(.body)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(highlighted ? Color.cyan.opacity(0.18) : Color.white.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(highlighted ? Color.cyan : Color.clear, lineWidth: 2)
        )
        .animation(.easeInOut(duration: 0.2), value: highlighted)
    }
}
