import SwiftUI

enum OnboardingIllustration {
    case plan, hold, checklist, review
}

struct OnboardingPage: Identifiable {
    var id: Int
    var kicker: String
    var title: String
    var body: String
    var illustration: OnboardingIllustration
}

struct OnboardingView: View {
    @EnvironmentObject var app: AppModel
    @State private var page = 0

    private var pages: [OnboardingPage] { WalkCopy.pages }
    private var isLast: Bool { page >= pages.count - 1 }

    var body: some View {
        ZStack {
            HWTheme.navy.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(WalkCopy.brand)
                        .font(.system(size: 12, weight: .semibold, design: .serif))
                        .tracking(2.4)
                        .foregroundStyle(HWTheme.brass)
                    Spacer()
                    if app.onboardingDone {
                        Button("Close") { app.route = .list }
                            .font(.system(size: 13, design: .serif))
                            .foregroundStyle(HWTheme.paper.opacity(0.8))
                            .accessibilityIdentifier("onboarding-close")
                    } else {
                        Text("\(page + 1) of \(pages.count)")
                            .font(.system(size: 13, design: .serif))
                            .foregroundStyle(HWTheme.paper.opacity(0.7))
                            .monospacedDigit()
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 20)

                TabView(selection: $page) {
                    ForEach(pages) { item in
                        pageContent(item)
                            .tag(item.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                .animation(.easeInOut(duration: 0.25), value: page)

                HStack(spacing: 6) {
                    ForEach(pages) { item in
                        Capsule()
                            .fill(item.id == page ? HWTheme.brass : HWTheme.paper.opacity(0.25))
                            .frame(width: item.id == page ? 18 : 6, height: 6)
                    }
                    Spacer()
                    if !isLast {
                        Button("Skip") { page = pages.count - 1 }
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(HWTheme.paper.opacity(0.6))
                            .accessibilityIdentifier("onboarding-skip")
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 14)

                Button {
                    if !isLast {
                        page += 1
                    } else {
                        app.finishOnboarding()
                    }
                } label: {
                    Text(isLast ? "Set up camera & mic" : "Continue")
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .foregroundStyle(HWTheme.navy)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(HWTheme.brass)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .accessibilityIdentifier(isLast ? "onboarding-start" : "onboarding-next")
                .padding(.horizontal, 24)
                .padding(.bottom, 28)
            }
        }
    }

    private func pageContent(_ item: OnboardingPage) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            OnboardingArt(kind: item.illustration)
                .frame(maxWidth: .infinity)
                .frame(height: 230)
                .padding(.top, 18)
                .padding(.bottom, 26)
            Text(item.kicker.uppercased())
                .font(.system(size: 12, weight: .semibold, design: .serif))
                .tracking(1.6)
                .foregroundStyle(HWTheme.brass)
                .padding(.bottom, 10)
            Text(item.title)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .foregroundStyle(HWTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 14)
            Text(item.body)
                .font(.system(size: 17))
                .foregroundStyle(HWTheme.paper.opacity(0.82))
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
            if item.illustration == .checklist {
                checklistPreview
                    .padding(.top, 16)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
    }

    private var checklistPreview: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(WalkCopy.insuranceItems.prefix(3), id: \.self) { title in
                HStack(spacing: 8) {
                    Image(systemName: "square")
                        .foregroundStyle(HWTheme.brass)
                    Text(title)
                        .font(.subheadline)
                        .foregroundStyle(HWTheme.paper.opacity(0.85))
                }
            }
        }
    }
}

/// Line-drawn illustrations in the house palette. No image assets.
struct OnboardingArt: View {
    var kind: OnboardingIllustration

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(HWTheme.paper.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(HWTheme.paper.opacity(0.12), lineWidth: 1)
                    )
                switch kind {
                case .plan: planArt(w, h)
                case .hold: holdArt(w, h)
                case .checklist: checklistArt(w, h)
                case .review: reviewArt(w, h)
                }
            }
        }
    }

    // Two rooms sharing a wall, a door gap, a dashed walking loop, dimension ticks.
    private func planArt(_ w: CGFloat, _ h: CGFloat) -> some View {
        let m: CGFloat = 26
        let a = CGRect(x: m, y: m + 14, width: w * 0.46, height: h - 2 * m - 14)
        let b = CGRect(x: a.maxX, y: a.minY + 22, width: w - a.maxX - m, height: a.height - 22)
        return ZStack {
            Path { p in p.addRect(a) }.fill(HWTheme.blueprint.opacity(0.35))
            Path { p in p.addRect(b) }.fill(HWTheme.moss.opacity(0.35))
            Path { p in p.addRect(a); p.addRect(b) }.stroke(HWTheme.paper, lineWidth: 2)
            // Door gap on the shared wall
            Path { p in
                p.move(to: CGPoint(x: a.maxX, y: b.midY - 14))
                p.addLine(to: CGPoint(x: a.maxX, y: b.midY + 14))
            }
            .stroke(HWTheme.navy, lineWidth: 4)
            Path { p in
                p.move(to: CGPoint(x: a.maxX, y: b.midY - 14))
                p.addLine(to: CGPoint(x: a.maxX, y: b.midY + 14))
            }
            .stroke(HWTheme.brass, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
            // Walking loop
            Path { p in
                let r = a.insetBy(dx: 18, dy: 18)
                p.move(to: CGPoint(x: r.minX, y: r.maxY))
                p.addLine(to: CGPoint(x: r.minX, y: r.minY))
                p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
                p.addLine(to: CGPoint(x: r.maxX, y: b.midY))
            }
            .stroke(HWTheme.stamp, style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [5, 5]))
            // Width tick
            Path { p in
                p.move(to: CGPoint(x: a.minX, y: a.minY - 9))
                p.addLine(to: CGPoint(x: a.maxX, y: a.minY - 9))
            }
            .stroke(HWTheme.brass, lineWidth: 1)
            Text("4.2 m")
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(HWTheme.brass)
                .position(x: a.midX, y: a.minY - 18)
            Text("Kitchen")
                .font(.system(size: 12, design: .serif))
                .foregroundStyle(HWTheme.paper)
                .position(x: a.midX, y: a.midY + 20)
            Text("Hall")
                .font(.system(size: 12, design: .serif))
                .foregroundStyle(HWTheme.paper)
                .position(x: b.midX, y: b.midY + 20)
        }
    }

    // Side view: figure holding a phone at chest height, ray to the floor a few steps ahead.
    private func holdArt(_ w: CGFloat, _ h: CGFloat) -> some View {
        let floorY = h - 34
        let personX = w * 0.26
        let headY: CGFloat = 46
        let chestY: CGFloat = headY + 44
        let phone = CGPoint(x: personX + 30, y: chestY)
        let hit = CGPoint(x: w * 0.78, y: floorY)
        return ZStack {
            Path { p in
                p.move(to: CGPoint(x: 22, y: floorY))
                p.addLine(to: CGPoint(x: w - 22, y: floorY))
            }
            .stroke(HWTheme.paper.opacity(0.8), lineWidth: 2)
            // Figure
            Circle().stroke(HWTheme.paper, lineWidth: 2)
                .frame(width: 22, height: 22)
                .position(x: personX, y: headY)
            Path { p in
                p.move(to: CGPoint(x: personX, y: headY + 11))
                p.addLine(to: CGPoint(x: personX, y: floorY - 48))
                p.move(to: CGPoint(x: personX, y: floorY - 48))
                p.addLine(to: CGPoint(x: personX - 14, y: floorY))
                p.move(to: CGPoint(x: personX, y: floorY - 48))
                p.addLine(to: CGPoint(x: personX + 14, y: floorY))
                p.move(to: CGPoint(x: personX, y: chestY - 8))
                p.addLine(to: CGPoint(x: phone.x - 6, y: phone.y))
            }
            .stroke(HWTheme.paper, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            // Phone, tilted down
            RoundedRectangle(cornerRadius: 2)
                .fill(HWTheme.brass)
                .frame(width: 8, height: 18)
                .rotationEffect(.degrees(-28))
                .position(phone)
            // Ray
            Path { p in
                p.move(to: phone)
                p.addLine(to: hit)
            }
            .stroke(HWTheme.tape, style: StrokeStyle(lineWidth: 2, dash: [4, 4]))
            Circle().fill(HWTheme.tape)
                .frame(width: 10, height: 10)
                .position(hit)
            // Chest-height marker
            Path { p in
                p.move(to: CGPoint(x: personX - 40, y: chestY))
                p.addLine(to: CGPoint(x: personX - 8, y: chestY))
            }
            .stroke(HWTheme.brass, lineWidth: 1)
            Text("chest")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(HWTheme.brass)
                .position(x: personX - 24, y: chestY - 10)
            Text("a few steps ahead")
                .font(.system(size: 11, design: .rounded))
                .foregroundStyle(HWTheme.tape)
                .position(x: hit.x - 6, y: hit.y - 16)
        }
    }

    // A room with three pins and a checklist card.
    private func checklistArt(_ w: CGFloat, _ h: CGFloat) -> some View {
        let room = CGRect(x: 26, y: 30, width: w * 0.5, height: h - 60)
        let pins = [
            CGPoint(x: room.minX + 28, y: room.minY + 34),
            CGPoint(x: room.maxX - 34, y: room.minY + 60),
            CGPoint(x: room.midX, y: room.maxY - 36)
        ]
        let card = CGRect(x: room.maxX + 18, y: 44, width: w - room.maxX - 18 - 26, height: h - 88)
        return ZStack {
            Path { p in p.addRect(room) }.fill(HWTheme.blueprint.opacity(0.35))
            Path { p in p.addRect(room) }.stroke(HWTheme.paper, lineWidth: 2)
            ForEach(0..<pins.count, id: \.self) { i in
                ZStack {
                    Circle().fill(HWTheme.brass).frame(width: 18, height: 18)
                    Text("\(i + 1)")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .foregroundStyle(HWTheme.navy)
                }
                .position(pins[i])
            }
            RoundedRectangle(cornerRadius: 8)
                .fill(HWTheme.paper)
                .frame(width: card.width, height: card.height)
                .position(x: card.midX, y: card.midY)
            VStack(alignment: .leading, spacing: 9) {
                ForEach(["Panel", "Water heater", "Serial no."], id: \.self) { t in
                    HStack(spacing: 6) {
                        Image(systemName: t == "Serial no." ? "square" : "checkmark.square.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(t == "Serial no." ? HWTheme.ink.opacity(0.4) : HWTheme.moss)
                        Text(t)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(HWTheme.ink)
                    }
                }
            }
            .frame(width: card.width - 20, alignment: .leading)
            .position(x: card.midX, y: card.midY)
        }
    }

    // Plan with a dragged corner handle and a rename field.
    private func reviewArt(_ w: CGFloat, _ h: CGFloat) -> some View {
        let room = CGRect(x: 30, y: 34, width: w * 0.52, height: h - 68)
        let handle = CGPoint(x: room.maxX, y: room.minY)
        return ZStack {
            Path { p in p.addRect(room) }.fill(HWTheme.blueprint.opacity(0.35))
            Path { p in p.addRect(room) }.stroke(HWTheme.paper, lineWidth: 2)
            Path { p in
                p.move(to: handle)
                p.addLine(to: CGPoint(x: handle.x + 26, y: handle.y - 14))
            }
            .stroke(HWTheme.tape, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
            Circle().fill(HWTheme.tape).frame(width: 16, height: 16).position(handle)
            Circle().stroke(HWTheme.tape, lineWidth: 2).frame(width: 16, height: 16)
                .position(x: handle.x + 26, y: handle.y - 14)
            Text("Primary bedroom")
                .font(.system(size: 12, design: .serif))
                .foregroundStyle(HWTheme.paper)
                .position(x: room.midX, y: room.midY)
            RoundedRectangle(cornerRadius: 6)
                .fill(HWTheme.paper)
                .frame(width: w - room.maxX - 44, height: 30)
                .overlay(
                    Text("Rename")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(HWTheme.navy)
                )
                .position(x: (room.maxX + w - 22) / 2, y: room.minY + 40)
            RoundedRectangle(cornerRadius: 6)
                .stroke(HWTheme.paper.opacity(0.6), lineWidth: 1)
                .frame(width: w - room.maxX - 44, height: 30)
                .overlay(
                    Text("Add note")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(HWTheme.paper.opacity(0.8))
                )
                .position(x: (room.maxX + w - 22) / 2, y: room.minY + 80)
        }
    }
}
