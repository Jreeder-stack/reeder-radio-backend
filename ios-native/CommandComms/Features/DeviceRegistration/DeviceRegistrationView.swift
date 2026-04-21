import SwiftUI
import UIKit

struct DeviceRegistrationView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                VStack(spacing: 24) {
                    Image(systemName: "iphone.radiowaves.left.and.right")
                        .font(.system(size: 64))
                        .foregroundColor(.cyan)

                    Text("Device Registration")
                        .font(.title2.bold())
                        .foregroundColor(.white)

                    Text("Hardware PTT, MFi accessory binding, and radio device pairing will live here in a future task.")
                        .font(.body)
                        .foregroundColor(.gray)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Device ID").font(.caption).foregroundColor(.gray).tracking(2)
                        Text(deviceIdentifier)
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundColor(.cyan)
                            .textSelection(.enabled)
                    }
                    .padding()
                    .background(Color.white.opacity(0.05))
                    .cornerRadius(12)
                    .padding(.horizontal)

                    Spacer()
                }
                .padding(.top, 48)
            }
            .navigationTitle("Device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
        }
        .foregroundColor(.white)
    }

    private var deviceIdentifier: String {
        if let id = UIDevice.current.identifierForVendor?.uuidString {
            return id
        }
        return "unknown"
    }
}

#Preview {
    DeviceRegistrationView().environmentObject(AppState())
}
