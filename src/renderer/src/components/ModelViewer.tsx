import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { MeshPayload, ModelSummary } from '@shared/geometry'
import type { JSX } from 'react'

/**
 * The 3D viewport.
 *
 * three.js owns the canvas imperatively — React would fight it for every frame
 * otherwise. The component's job is to hand the scene new geometry when the
 * selected model changes, keep the camera sane, and tear everything down
 * cleanly when it unmounts, because a leaked WebGL context outlives the view.
 */

export interface ViewerOptions {
  wireframe: boolean
  grid: boolean
  boundingBox: boolean
  spin: boolean
  shaded: boolean
}

export type ViewPreset = 'iso' | 'front' | 'back' | 'top' | 'right'

interface Props {
  summary: ModelSummary | null
  mesh: (MeshPayload & { id: string }) | null
  options: ViewerOptions
  /** Bumped by the toolbar to re-frame the model. */
  fitSignal: number
  preset: { name: ViewPreset; signal: number }
  hidden: Set<number>
  accent: string
  onPartHover?: (index: number | null) => void
}

const UP = new THREE.Vector3(0, 0, 1)

const PRESET_DIRECTION: Record<ViewPreset, [number, number, number]> = {
  iso: [1, -1.15, 0.8],
  front: [0, -1, 0],
  back: [0, 1, 0],
  top: [0, -0.0001, 1],
  right: [1, 0, 0]
}

export function ModelViewer({
  summary, mesh, options, fitSignal, preset, hidden, accent, onPartHover
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const state = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    root: THREE.Group
    grid: THREE.GridHelper | null
    box: THREE.Box3Helper | null
    materials: THREE.MeshStandardMaterial[]
    wire: THREE.LineSegments | null
    radius: number
    centre: THREE.Vector3
    frame: number
  } | null>(null)

  const [error, setError] = useState<string | null>(null)

  /* ── Scene setup. Runs once; the context is expensive to rebuild. ───────── */
  useEffect(() => {
    const container = host.current
    if (!container) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    } catch {
      setError('This machine does not have WebGL available, so the 3D viewport cannot start.')
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    renderer.setClearColor(0x000000, 0)
    renderer.shadowMap.enabled = false
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.92
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    // Metal needs something to reflect. A generated room costs one render at
    // start-up and does more for the surface than any number of extra lights.
    const pmrem = new THREE.PMREMGenerator(renderer)
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = environment.texture
    pmrem.dispose()

    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 40_000)
    camera.up.copy(UP)
    camera.position.set(120, -140, 90)

    // CAD convention: Z is up. Everything else follows from that.
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.85
    controls.panSpeed = 0.9
    controls.zoomSpeed = 0.9
    controls.screenSpacePanning = true
    controls.minDistance = 0.05
    controls.maxDistance = 30_000

    const key = new THREE.DirectionalLight(0xffffff, 2.4)
    key.position.set(1, -1.4, 1.6)
    const fill = new THREE.DirectionalLight(0x9fc4e8, 0.5)
    fill.position.set(-1.2, 0.8, 0.4)
    // A crimson rim is the only place the accent touches the model itself;
    // tinting the surface as well makes everything look like plastic.
    const rim = new THREE.DirectionalLight(0xff3350, 1.6)
    rim.position.set(-0.9, 1.3, -0.7)
    scene.add(key, fill, rim, new THREE.AmbientLight(0x1a2030, 0.5))

    const root = new THREE.Group()
    scene.add(root)

    state.current = {
      renderer, scene, camera, controls, root,
      grid: null, box: null, materials: [], wire: null,
      radius: 100, centre: new THREE.Vector3(), frame: 0
    }

    const resize = () => {
      const width = container.clientWidth
      const height = container.clientHeight
      if (!width || !height) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    let running = true
    const tick = () => {
      if (!running) return
      state.current!.frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      running = false
      cancelAnimationFrame(state.current?.frame ?? 0)
      observer.disconnect()
      controls.dispose()
      environment.texture.dispose()
      scene.environment = null
      scene.traverse((object) => {
        const any = object as THREE.Mesh
        any.geometry?.dispose?.()
        const material = any.material
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
        else material?.dispose?.()
      })
      renderer.dispose()
      renderer.domElement.remove()
      state.current = null
    }
  }, [])

  /* ── Frame the model: distance from its bounding sphere, not a guess. ───── */
  const frame = useCallback((direction?: [number, number, number]) => {
    const current = state.current
    if (!current) return
    const { camera, controls, radius, centre } = current
    const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.12
    const vector = new THREE.Vector3(...(direction ?? [
      camera.position.x - centre.x, camera.position.y - centre.y, camera.position.z - centre.z
    ]))
    if (vector.lengthSq() < 1e-9) vector.set(1, -1.15, 0.8)
    vector.normalize().multiplyScalar(Math.max(distance, 0.2))
    camera.position.copy(centre).add(vector)
    camera.near = Math.max(radius / 5000, 0.01)
    camera.far = Math.max(radius * 400, 100)
    camera.updateProjectionMatrix()
    controls.target.copy(centre)
    controls.update()
  }, [])

  /* ── New geometry. ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const current = state.current
    if (!current || !mesh || !summary) return

    const { root } = current
    for (const child of [...root.children]) {
      root.remove(child)
      const object = child as THREE.Mesh
      object.geometry?.dispose?.()
      const material = object.material
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
      else material?.dispose?.()
    }
    current.materials = []
    current.wire = null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))

    // One material per part, so a part can be dimmed or hidden on its own.
    const accentColour = new THREE.Color(accent)
    const groups = mesh.groups.length ? mesh.groups : [{ name: summary.name, start: 0, count: mesh.indices.length }]
    const materials = groups.map((_, index) => {
      // Brushed steel, with successive parts stepped in tone so an assembly
      // reads as separate pieces without colouring them arbitrarily.
      const base = new THREE.Color().setHSL(0.6, 0.05, 0.46 - (index % 3) * 0.07)
      return new THREE.MeshStandardMaterial({
        color: base,
        metalness: 0.86,
        roughness: 0.29,
        envMapIntensity: 1.15,
        flatShading: false,
        side: THREE.DoubleSide
      })
    })
    groups.forEach((group, index) => geometry.addGroup(group.start, group.count, index))

    const solid = new THREE.Mesh(geometry, materials)
    solid.frustumCulled = false
    root.add(solid)
    current.materials = materials

    // Wireframe is an overlay rather than a material flag: the shaded surface
    // stays readable underneath, which is how CAD viewers show it.
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({ color: accentColour, transparent: true, opacity: 0.28, depthTest: true })
    )
    wire.visible = false
    wire.frustumCulled = false
    root.add(wire)
    current.wire = wire

    const box = new THREE.Box3(
      new THREE.Vector3(...summary.bounds.min),
      new THREE.Vector3(...summary.bounds.max)
    )
    const helper = new THREE.Box3Helper(box, accentColour)
    ;(helper.material as THREE.LineBasicMaterial).transparent = true
    ;(helper.material as THREE.LineBasicMaterial).opacity = 0.35
    helper.visible = false
    root.add(helper)
    current.box = helper

    current.centre = box.getCenter(new THREE.Vector3())
    current.radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.001)

    // A ground grid sized to the part, sitting at its lowest point.
    if (current.grid) {
      current.scene.remove(current.grid)
      current.grid.geometry.dispose()
      ;(current.grid.material as THREE.Material).dispose()
    }
    const span = Math.max(current.radius * 4, 10)
    const step = niceStep(span / 10)
    const grid = new THREE.GridHelper(step * 20, 20, accentColour, 0x4a5568)
    grid.rotateX(Math.PI / 2)
    grid.position.set(current.centre.x, current.centre.y, summary.bounds.min[2])
    const gridMaterial = grid.material as THREE.Material | THREE.Material[]
    for (const material of Array.isArray(gridMaterial) ? gridMaterial : [gridMaterial]) {
      material.transparent = true
      material.opacity = 0.38
      material.depthWrite = false
    }
    grid.visible = options.grid
    current.scene.add(grid)
    current.grid = grid

    frame(PRESET_DIRECTION.iso)
  }, [mesh, summary, accent, frame])

  /* ── Display options. Cheap toggles, applied in place. ─────────────────── */
  useEffect(() => {
    const current = state.current
    if (!current) return
    if (current.wire) current.wire.visible = options.wireframe
    if (current.grid) current.grid.visible = options.grid
    if (current.box) current.box.visible = options.boundingBox
    current.controls.autoRotate = options.spin
    current.controls.autoRotateSpeed = 0.9
    for (const material of current.materials) {
      material.wireframe = false
      material.flatShading = !options.shaded
      material.needsUpdate = true
    }
  }, [options])

  useEffect(() => {
    const current = state.current
    if (!current) return
    current.materials.forEach((material, index) => {
      material.visible = !hidden.has(index)
    })
  }, [hidden, mesh])

  useEffect(() => {
    if (fitSignal > 0) frame()
  }, [fitSignal, frame])

  useEffect(() => {
    if (preset.signal > 0) frame(PRESET_DIRECTION[preset.name])
  }, [preset, frame])

  useEffect(() => {
    if (!onPartHover) return
    onPartHover(null)
  }, [mesh, onPartHover])

  if (error) {
    return (
      <div className="viewport-empty">
        <div className="viewport-empty-title">Viewport unavailable</div>
        <p className="viewport-empty-body">{error}</p>
      </div>
    )
  }

  return <div className="viewport-canvas" ref={host} />
}

/** Grid spacing a person would choose: 1, 2, 5, 10, 20, 50… */
function niceStep(raw: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))))
  const normalised = raw / magnitude
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
  return step * magnitude
}
