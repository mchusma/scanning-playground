import ARKit
import Foundation

enum SpatialCapabilities {
    static var worldTrackingSupported: Bool {
        ARWorldTrackingConfiguration.isSupported
    }

    static var lidarDepthSupported: Bool {
        ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    }

    static var sceneReconstructionSupported: Bool {
        ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    }

    static func current() -> DeviceCapabilities {
        DeviceCapabilities(
            worldTrackingSupported: worldTrackingSupported,
            lidarDepthSupported: lidarDepthSupported,
            sceneReconstructionSupported: sceneReconstructionSupported,
            captureMode: worldTrackingSupported ? "arkit" : "simulated"
        )
    }
}

/// Shared hit factory used by the Simulator canvas and by tests.
enum SimulatedHit {
    static func downward(x: Double, z: Double, worldY: Double = 0, cameraY: Double = 1.5) -> PlacementHit {
        let world = Vec3(x: x, y: worldY, z: z)
        let origin = Vec3(x: x, y: cameraY, z: z)
        return PlacementHit(
            world: world,
            rayOrigin: origin,
            rayDirection: Vec3(x: 0, y: -1, z: 0),
            distance: abs(cameraY - worldY),
            candidatePlaneID: "simulated-floor"
        )
    }

    static func shallow(x: Double, z: Double) -> PlacementHit {
        PlacementHit(
            world: Vec3(x: x, y: 0, z: z),
            rayOrigin: Vec3(x: x, y: 1.5, z: z),
            rayDirection: Vec3(x: 1, y: 0.02, z: 0).normalized(),
            distance: 4,
            candidatePlaneID: "simulated-floor"
        )
    }
}

enum CameraRay {
    static func from(_ transform: simd_float4x4) -> (origin: Vec3, direction: Vec3) {
        let origin = Vec3(
            x: Double(transform.columns.3.x),
            y: Double(transform.columns.3.y),
            z: Double(transform.columns.3.z)
        )
        let direction = Vec3(
            x: Double(-transform.columns.2.x),
            y: Double(-transform.columns.2.y),
            z: Double(-transform.columns.2.z)
        ).normalized()
        return (origin, direction)
    }

    static func hit(from transform: simd_float4x4, world: Vec3, planeID: String?) -> PlacementHit {
        let ray = from(transform)
        let distance = (world - ray.origin).length
        return PlacementHit(
            world: world,
            rayOrigin: ray.origin,
            rayDirection: ray.direction,
            distance: distance,
            candidatePlaneID: planeID
        )
    }
}

extension TrackingQuality {
    static func from(_ state: ARCamera.TrackingState) -> TrackingQuality {
        switch state {
        case .notAvailable:
            return .unavailable
        case .normal:
            return .normal
        case .limited(let reason):
            switch reason {
            case .initializing:
                return .initializing
            case .excessiveMotion:
                return .limited("excessive motion")
            case .insufficientFeatures:
                return .limited("insufficient features")
            case .relocalizing:
                return .limited("relocalizing")
            @unknown default:
                return .limited("limited")
            }
        }
    }
}
