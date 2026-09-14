import ARKit
import CoreLocation
import SceneKit
import SwiftUI

/// Device capture surface. Not instantiated when world tracking is unsupported
/// (iOS Simulator). Uses gravity-aligned world tracking and horizontal planes
/// only — no sceneDepth, no scene reconstruction, no RoomPlan.
struct ARKitCaptureView: UIViewRepresentable {
    @ObservedObject var session: CaptureSession
    var hits: HitBridge

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(session: session, onCandidatePlane: { hits.candidatePlane = $0 })
        coordinator.hits = hits
        hits.source = coordinator
        return coordinator
    }

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.delegate = context.coordinator
        view.session.delegate = context.coordinator
        view.autoenablesDefaultLighting = true
        view.automaticallyUpdatesLighting = true
        context.coordinator.view = view
        context.coordinator.start()
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {
        context.coordinator.session = session
        context.coordinator.syncOverlays()
    }

    static func dismantleUIView(_ uiView: ARSCNView, coordinator: Coordinator) {
        uiView.session.pause()
    }

    final class Coordinator: NSObject, ARSCNViewDelegate, ARSessionDelegate, PlacementHitSource {
        var session: CaptureSession
        var onCandidatePlane: (String?) -> Void
        weak var hits: HitBridge?
        private(set) var headingAligned = false
        weak var view: ARSCNView?
        private var overlayRoot = SCNNode()
        private var lastMapStatus: ARFrame.WorldMappingStatus = .notAvailable
        private var overlaySignature: Int?
        private var frameCounter = 0

        init(session: CaptureSession, onCandidatePlane: @escaping (String?) -> Void) {
            self.session = session
            self.onCandidatePlane = onCandidatePlane
        }

        func start() {
            guard let view else { return }
            view.scene.rootNode.addChildNode(overlayRoot)
            let config = ARWorldTrackingConfiguration()
            // With location authorised, ARKit aligns +X to east and −Z to north
            // from the compass at start. Indoors that is only good to several
            // degrees; the measured wall grid corrects it. Without location we
            // stay gravity-only and the plan has no orientation on Earth.
            let heading = GeoProvider.isAuthorized && CLLocationManager.headingAvailable()
            config.worldAlignment = heading ? .gravityAndHeading : .gravity
            headingAligned = heading
            hits?.headingAligned = heading
            config.planeDetection = [.horizontal]
            config.frameSemantics = []
            view.session.run(config)
        }

        /// Fresh session with the current alignment choice. Only sensible
        /// before any geometry exists: it discards the world map.
        func restartTracking() {
            guard let view else { return }
            let heading = GeoProvider.isAuthorized && CLLocationManager.headingAvailable()
            let config = ARWorldTrackingConfiguration()
            config.worldAlignment = heading ? .gravityAndHeading : .gravity
            headingAligned = heading
            hits?.headingAligned = heading
            config.planeDetection = [.horizontal]
            config.frameSemantics = []
            view.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        }

        /// After an interruption (phone call, app switch) ARKit can try to
        /// relocalize to the map it already has. Say yes: the alternative is a
        /// fresh origin, which would put the next room in a different frame.
        func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool {
            true
        }

        func currentCamera() -> CameraPose? {
            guard let view, let frame = view.session.currentFrame else { return nil }
            let ray = CameraRay.from(frame.camera.transform)
            return CameraPose(
                position: ray.origin,
                forward: ray.direction,
                trackingNormal: TrackingQuality.from(frame.camera.trackingState) == .normal
            )
        }

        func currentHit() -> PlacementHit? {
            guard let view, let frame = view.session.currentFrame else { return nil }
            let ray = CameraRay.from(frame.camera.transform)
            var world: Vec3?
            var planeID: String?
            if let floor = session.floor {
                let denom = ray.direction.dot(floor.basis.yAxis)
                if abs(denom) >= Geometry.minRayFloorDot {
                    let t = (floor.basis.origin - ray.origin).dot(floor.basis.yAxis) / denom
                    if t >= Geometry.minHitDistance && t <= Geometry.maxHitDistance {
                        world = ray.origin + ray.direction * t
                        planeID = floor.basis.planeID
                    }
                }
            } else if let result = view.raycastQuery(
                from: CGPoint(x: view.bounds.midX, y: view.bounds.midY),
                allowing: .existingPlaneGeometry,
                alignment: .horizontal
            ).flatMap({ view.session.raycast($0).first }) {
                let c = result.worldTransform.columns.3
                world = Vec3(x: Double(c.x), y: Double(c.y), z: Double(c.z))
                planeID = result.anchor?.identifier.uuidString
            }
            guard let world else { return nil }
            return PlacementHit(
                world: world,
                rayOrigin: ray.origin,
                rayDirection: ray.direction,
                distance: (world - ray.origin).length,
                candidatePlaneID: planeID
            )
        }

        func session(_ session: ARSession, didUpdate frame: ARFrame) {
            let quality = TrackingQuality.from(frame.camera.trackingState)
            DispatchQueue.main.async {
                self.session.updateTracking(quality)
            }
            lastMapStatus = frame.worldMappingStatus
            // Video: copy-and-queue, never blocks here. Recorded regardless of
            // tracking quality — the camera image is evidence even when the
            // position is not. The wall-clock anchor is corrected for the lag
            // between capture and this callback.
            if let recorder = hits?.videoRecorder, recorder.isArmed {
                let lag = ProcessInfo.processInfo.systemUptime - frame.timestamp
                recorder.append(
                    frame.capturedImage,
                    timestamp: frame.timestamp,
                    wallClock: Date().timeIntervalSince1970 - lag
                )
            }
            // The crosshair plane probe is only needed a few times a second,
            // not at 60 Hz; AR frame processing must stay cheap.
            frameCounter &+= 1
            guard frameCounter % 6 == 0, let view else { return }
            let center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            var id: String?
            if let query = view.raycastQuery(from: center, allowing: .existingPlaneGeometry, alignment: .horizontal),
               let result = view.session.raycast(query).first
            {
                id = result.anchor?.identifier.uuidString ?? "plane"
            }
            DispatchQueue.main.async { self.onCandidatePlane(id) }
        }

        func sessionWasInterrupted(_ session: ARSession) {
            DispatchQueue.main.async {
                self.session.updateTracking(.interrupted)
                self.session.recordCaptureEvent("arInterrupted", detail: "Camera frames paused")
            }
        }

        func sessionInterruptionEnded(_ session: ARSession) {
            DispatchQueue.main.async {
                self.session.updateTracking(.initializing)
                self.session.recordCaptureEvent("arInterruptionEnded", detail: "Relocalizing in the existing frame")
            }
        }

        func session(_ session: ARSession, didFailWithError error: Error) {
            DispatchQueue.main.async {
                self.session.updateTracking(.failed(error.localizedDescription))
            }
        }

        func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
            guard let plane = anchor as? ARPlaneAnchor, plane.alignment == .horizontal else { return }
            let mesh = SCNPlane(width: CGFloat(plane.planeExtent.width), height: CGFloat(plane.planeExtent.height))
            mesh.firstMaterial?.diffuse.contents = UIColor.systemYellow.withAlphaComponent(0.18)
            mesh.firstMaterial?.isDoubleSided = true
            let planeNode = SCNNode(geometry: mesh)
            planeNode.eulerAngles.x = -.pi / 2
            planeNode.name = "plane-\(anchor.identifier.uuidString)"
            node.addChildNode(planeNode)
        }

        func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
            guard let plane = anchor as? ARPlaneAnchor,
                  let planeNode = node.childNode(withName: "plane-\(anchor.identifier.uuidString)", recursively: false),
                  let mesh = planeNode.geometry as? SCNPlane
            else { return }
            mesh.width = CGFloat(plane.planeExtent.width)
            mesh.height = CGFloat(plane.planeExtent.height)
        }

        func syncOverlays() {
            // Rebuild only when the geometry changed. This is called on every
            // SwiftUI update, and tearing down SceneKit nodes per frame stalls AR.
            var hasher = Hasher()
            hasher.combine(session.rooms.map(\.revision))
            hasher.combine(session.rooms.count)
            hasher.combine(session.doorways.count)
            hasher.combine(session.inProgressDisplayPolygon)
            hasher.combine(session.floor?.gridAngle)
            hasher.combine(session.footprintPlan)
            let signature = hasher.finalize()
            if signature == overlaySignature { return }
            overlaySignature = signature

            overlayRoot.childNodes.forEach { $0.removeFromParentNode() }
            guard let floor = session.floor else { return }
            let pts = session.inProgressDisplayPolygon
            for (i, p) in pts.enumerated() {
                let world = floor.basis.toWorld(p)
                let sphere = SCNSphere(radius: 0.04)
                sphere.firstMaterial?.diffuse.contents = UIColor(red: 0.90, green: 0.76, blue: 0.12, alpha: 1)
                let node = SCNNode(geometry: sphere)
                node.position = SCNVector3(world.x, world.y + 0.02, world.z)
                overlayRoot.addChildNode(node)
                if i > 0 {
                    let prev = floor.basis.toWorld(pts[i - 1])
                    overlayRoot.addChildNode(Self.line(from: prev, to: world, color: UIColor.white))
                }
            }
            for room in session.rooms {
                let poly = room.displayPolygon
                for i in 0..<poly.count {
                    let a = floor.basis.toWorld(poly[i])
                    let b = floor.basis.toWorld(poly[(i + 1) % poly.count])
                    overlayRoot.addChildNode(Self.line(from: a, to: b, color: UIColor.systemBlue))
                }
            }
            for door in session.doorways {
                overlayRoot.addChildNode(
                    Self.line(
                        from: floor.basis.toWorld(door.endpointA),
                        to: floor.basis.toWorld(door.endpointB),
                        color: UIColor.systemOrange
                    )
                )
            }
            if let fp = session.footprintPlan, fp.count >= 3 {
                for i in 0..<fp.count {
                    overlayRoot.addChildNode(
                        Self.line(from: floor.basis.toWorld(fp[i]), to: floor.basis.toWorld(fp[(i + 1) % fp.count]), color: UIColor.systemTeal)
                    )
                }
            }
        }

        private static func line(from a: Vec3, to b: Vec3, color: UIColor) -> SCNNode {
            let vec = b - a
            let length = vec.length
            let box = SCNBox(width: 0.02, height: 0.02, length: CGFloat(length), chamferRadius: 0)
            box.firstMaterial?.diffuse.contents = color
            let node = SCNNode(geometry: box)
            node.position = SCNVector3((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.02, (a.z + b.z) / 2)
            node.look(at: SCNVector3(b.x, b.y, b.z))
            return node
        }
    }
}
