import SwiftUI

enum HWTheme {
    static let ink = Color(red: 0.10, green: 0.09, blue: 0.07)
    static let paper = Color(red: 0.953, green: 0.937, blue: 0.902)
    static let tape = Color(red: 0.90, green: 0.76, blue: 0.12)
    static let blueprint = Color(red: 0.12, green: 0.31, blue: 0.52)
    static let rust = Color(red: 0.72, green: 0.29, blue: 0.16)
    static let moss = Color(red: 0.31, green: 0.52, blue: 0.33)
    static let overlay = Color.black.opacity(0.52)
    static let navy = Color(red: 0.102, green: 0.153, blue: 0.267)
    static let brass = Color(red: 0.769, green: 0.639, blue: 0.353)
    static let stamp = Color(red: 0.706, green: 0.137, blue: 0.094)

    static func trackingColor(_ quality: TrackingQuality) -> Color {
        switch quality {
        case .normal: return moss
        case .initializing: return tape
        default: return rust
        }
    }
}

struct LargeActionButton: View {
    var title: String
    var identifier: String
    var fill: Color
    var textColor: Color = HWTheme.ink
    var enabled: Bool = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(enabled ? textColor : textColor.opacity(0.35))
                .frame(maxWidth: .infinity, minHeight: 56)
                .background(fill.opacity(enabled ? 1 : 0.35))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .disabled(!enabled)
        .accessibilityIdentifier(identifier)
    }
}
