import AXBridge
import SwiftUI

@main
struct ExampleApp: App {
    private let router = Router.shared

    init() {
        AXBridge.start(openURL: { Router.shared.open($0) })
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(router)
                .onOpenURL { router.open($0) }
        }
    }
}

@MainActor @Observable
final class Router {
    static let shared = Router()
    var tab = "stations"
    var path: [String] = []

    func open(_ url: URL) {
        guard url.scheme == "axdemo" else { return }
        switch url.host {
        case "settings": tab = "settings"
        case "station": tab = "stations"; path = [url.lastPathComponent]
        default: tab = "stations"
        }
    }
}

let stations = (1...40).map { "Station \($0)" } + ["Graz Jakominiplatz", "Wien Praterstern", "Linz Hauptbahnhof"]

struct RootView: View {
    @Environment(Router.self) private var router

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Stations", systemImage: "tram", value: "stations") { StationsView() }
            Tab("Settings", systemImage: "gear", value: "settings") { SettingsView() }
        }
    }
}

struct StationsView: View {
    @Environment(Router.self) private var router
    @State private var query = ""

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            List(stations.filter { query.isEmpty || $0.localizedCaseInsensitiveContains(query) }, id: \.self) { name in
                NavigationLink(name, value: name)
            }
            .searchable(text: $query, prompt: "Search stations")
            .navigationTitle("Stations")
            .navigationDestination(for: String.self) { StationDetail(name: $0) }
        }
    }
}

struct StationDetail: View {
    let name: String
    @State private var showingInfo = false
    @State private var note = ""

    var body: some View {
        Form {
            Section("Next departures") {
                ForEach(0..<3) { i in
                    LabeledContent("Line \(i + 1)", value: "in \(i * 4 + 2) min")
                }
            }
            Section("Note") {
                TextField("Add a note", text: $note)
                    .accessibilityIdentifier("note")
                if !note.isEmpty { Text("Saved: \(note)") }
            }
            Button("About this station") { showingInfo = true }
        }
        .navigationTitle(name)
        .sheet(isPresented: $showingInfo) {
            NavigationStack {
                Text("\(name) is part of the example data.")
                    .padding()
                    .navigationTitle("About")
                    .toolbar { Button("Done") { showingInfo = false } }
            }
        }
    }
}

struct SettingsView: View {
    @AppStorage("compact") private var compact = false

    var body: some View {
        NavigationStack {
            Form {
                Toggle("Compact rows", isOn: $compact)
                Text(AXBridge.isActive ? "Launched by axbridge" : "Launched normally")
            }
            .navigationTitle("Settings")
        }
    }
}
