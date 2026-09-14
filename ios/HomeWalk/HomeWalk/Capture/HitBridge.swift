import Combine
import Foundation

protocol PlacementHitSource: AnyObject {
    func currentHit() -> PlacementHit?
    func currentCamera() -> CameraPose?
    /// Start tracking again from scratch (e.g. to pick up compass alignment once location is allowed).
    func restartTracking()
}

extension PlacementHitSource {
    func restartTracking() {}
}

final class HitBridge: ObservableObject {
    weak var source: PlacementHitSource?
    /// Sink for AR camera frames while walking. Not published: frames arrive at 60 Hz.
    var videoRecorder: WalkVideoRecorder?
    /// Last known camera position on the floor plan, for Check alignment.
    var lastCameraPlan: Vec2?
    /// Whether the AR session was started compass-aligned (+X east, −Z north).
    var headingAligned = false
    @Published var aim = SimulatorAimState()
    @Published var candidatePlane: String?

    func hit(worldY: Double = 0) -> PlacementHit? {
        if let source {
            return source.currentHit()
        }
        return aim.hit(worldY: worldY)
    }

    /// The phone's pose, whatever the crosshair is on. Simulator: the aim point at chest height.
    func camera() -> CameraPose? {
        if let source {
            return source.currentCamera()
        }
        return CameraPose(position: Vec3(x: aim.x, y: 1.5, z: aim.z), forward: Vec3(x: 0, y: -1, z: 0), trackingNormal: true)
    }

    func setSimAim(x: Double, z: Double) {
        aim.set(x: x, z: z)
    }

    /// Only the Aim button applies typed meters. Add corner / Confirm floor must not call this.
    func applyTextFieldsToAim() {
        aim.applyTextFields()
    }
}
