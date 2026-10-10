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
 *
 * Frames are drawn continuously while the Workshop is open and the window is
 * visible. The component unmounts when you leave the Workshop and the loop
 * stops while the window is hidden, so the cost only exists while someone is
 * actually looking at a model — which is the case worth optimising for.
 */

export interface ViewerOptions {
  wireframe: boolean
  grid: boolean
  boundingBox: boolean
  spin: boolean
  shaded: boolean
  /** Cut the model open along an axis. `null` shows it whole. */
  section: { axis: 'x' | 'y' | 'z'; position: number; flip: boolean } | null
  measuring: boolean
}

export type ViewPreset = 'iso' | 'front' | 'back' | 'top' | 'right'

/** Two picked points and the distance between them. */
export interface Measurement {
  from: [number, number, number]
  to: [number, number, number] | null
  distance: number | null
  delta: [number, number, number] | null
}

interface Props {
  summary: ModelSummary | null
  mesh: (MeshPayload & { id: string }) | null
  options: ViewerOptions
  /** Bumped by the toolbar to re-frame the model. */
  fitSignal: number
  preset: { name: ViewPreset; signal: number }
  /** Bumped to ask for a PNG of what is on screen. */
  captureSignal: number
  hidden: Set<number>
  accent: string
  onMeasure?: (measurement: Measurement | null) => void
  onCapture?: (dataUrl: string) => void
}

const UP = new THREE.Vector3(0, 0, 1)

const PRESET_DIRECTION: Record<ViewPreset, [number, number, number]> = {
  iso: [1, -1.15, 0.8],
  front: [0, -1, 0],
  back: [0, 1, 0],
  top: [0, -0.0001, 1],
  right: [1, 0, 0]
}

const AXIS_NORMAL: Record<'x' | 'y' | 'z', THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1)
}

interface Scene {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  root: THREE.Group
  gizmo: { scene: THREE.Scene; camera: THREE.OrthographicCamera; group: THREE.Group }
  grid: THREE.GridHelper | null
  box: THREE.Box3Helper | null
  solid: THREE.Mesh | null
  cap: { group: THREE.Group; plane: THREE.Mesh; material: THREE.MeshStandardMaterial } | null
  materials: THREE.MeshStandardMaterial[]
  wire: THREE.LineSegments | null
  markers: THREE.Group
  clip: THREE.Plane
  bounds: THREE.Box3
  radius: number
  centre: THREE.Vector3
  frame: number
}

export function ModelViewer({
  summary, mesh, options, fitSignal, preset, captureSignal, hidden, accent, onMeasure, onCapture
}: Props): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  const state = useRef<Scene | null>(null)
  const picks = useRef<THREE.Vector3[]>([])
  const [error, setError] = useState<string | null>(null)

  /* ── Scene setup. Runs once; the context is expensive to rebuild. ───────── */
  useEffect(() => {
    const container = host.current
    if (!container) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
        // Recent three.js versions default this off, and the section cap is a
        // stencil mask — without the buffer it would paint over everything.
        stencil: true
      })
    } catch {
      setError('This machine does not have WebGL available, so the 3D viewport cannot start.')
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(container.clientWidth || 1, container.clientHeight || 1)
    renderer.setClearColor(0x000000, 0)
    renderer.shadowMap.enabled = false
    renderer.localClippingEnabled = true
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
    const markers = new THREE.Group()
    scene.add(root, markers)

    state.current = {
      renderer, scene, camera, controls, root, markers,
      gizmo: buildGizmo(),
      grid: null, box: null, solid: null, cap: null, materials: [], wire: null,
      clip: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
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
      const current = state.current!
      current.frame = requestAnimationFrame(tick)
      controls.update()
      draw(current)
    }
    tick()

    const onVisibility = () => {
      const current = state.current
      if (!current) return
      if (document.hidden) {
        running = false
        cancelAnimationFrame(current.frame)
      } else if (!running) {
        running = true
        tick()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      running = false
      cancelAnimationFrame(state.current?.frame ?? 0)
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      controls.dispose()
      environment.texture.dispose()
      scene.environment = null
      disposeTree(scene)
      disposeTree(state.current!.gizmo.scene)
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

  const clearPicks = useCallback(() => {
    picks.current = []
    const current = state.current
    if (!current) return
    disposeTree(current.markers)
    current.markers.clear()
    onMeasure?.(null)
  }, [onMeasure])

  /* ── New geometry. ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const current = state.current
    // The summary arrives from the store the instant the selection changes;
    // the geometry is fetched and lands a tick later. Building in between
    // would draw the old mesh framed for the new part.
    if (!current || !mesh || !summary || mesh.id !== summary.id) return

    const { root } = current
    disposeTree(root)
    root.clear()
    current.materials = []
    current.wire = null
    current.solid = null

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
    current.solid = solid

    if (hasStencil(current.renderer)) {
      current.cap = buildCap(geometry, current.clip)
      current.cap.group.visible = false
      root.add(current.cap.group)
    }

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

    current.bounds = box
    current.centre = box.getCenter(new THREE.Vector3())
    current.radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.001)

    // A ground grid sized to the part, sitting at its lowest point.
    if (current.grid) {
      current.scene.remove(current.grid)
      current.grid.geometry.dispose()
      ;(current.grid.material as THREE.Material).dispose()
    }
    const step = niceStep(Math.max(current.radius * 4, 10) / 10)
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

    clearPicks()
    frame(PRESET_DIRECTION.iso)
  }, [mesh, summary, accent, frame, clearPicks])

  /* ── Display options. Cheap toggles, applied in place. ─────────────────── */
  useEffect(() => {
    const current = state.current
    if (!current) return
    if (current.wire) current.wire.visible = options.wireframe
    if (current.grid) current.grid.visible = options.grid
    if (current.box) current.box.visible = options.boundingBox
    current.controls.autoRotate = options.spin
    current.controls.autoRotateSpeed = 0.9

    // Sectioning uses a single clipping plane. Both faces of the mesh are
    // drawn, so the cut shows the inside walls rather than an empty shell.
    const section = options.section
    let planes: THREE.Plane[] = []
    if (section) {
      const normal = AXIS_NORMAL[section.axis].clone().multiplyScalar(section.flip ? 1 : -1)
      const min = current.bounds.min.getComponent('xyz'.indexOf(section.axis))
      const max = current.bounds.max.getComponent('xyz'.indexOf(section.axis))
      const at = min + (max - min) * section.position
      current.clip.set(normal, section.flip ? -at : at)
      planes = [current.clip]
    }

    for (const material of current.materials) {
      material.flatShading = !options.shaded
      material.clippingPlanes = planes
      material.clipShadows = true
      material.needsUpdate = true
    }

    if (current.cap) {
      current.cap.group.visible = !!section
      if (section) {
        // The cap quad has to sit on the cut and face along it, and be large
        // enough to cover whatever the stencil marks as solid.
        const size = current.radius * 4
        current.cap.plane.scale.setScalar(size)
        current.cap.plane.position.copy(current.centre).projectOnPlane(current.clip.normal)
        current.cap.plane.position.addScaledVector(current.clip.normal, -current.clip.constant)
        current.cap.plane.lookAt(current.cap.plane.position.clone().add(current.clip.normal))
        current.cap.material.color.set(accent).lerp(new THREE.Color(0xffffff), 0.25)
      }
    }
    // `mesh` is a dependency because new geometry arrives with fresh materials
    // and a fresh cap, neither of which knows about an active section yet.
  }, [options, accent, mesh])

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

  /* ── Capture. Render first so the buffer is guaranteed to hold a frame. ── */
  useEffect(() => {
    const current = state.current
    if (!current || captureSignal <= 0 || !onCapture) return
    draw(current)
    try {
      onCapture(current.renderer.domElement.toDataURL('image/png'))
    } catch {
      /* a lost context cannot be read back; the caller shows the failure */
    }
  }, [captureSignal, onCapture])

  /* ── Measuring. A click is a press and release in the same place. ─────── */
  useEffect(() => {
    const current = state.current
    if (!current) return
    const canvas = current.renderer.domElement
    if (!options.measuring) {
      canvas.style.cursor = ''
      return
    }
    canvas.style.cursor = 'crosshair'

    let downAt: { x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      if (!downAt) return
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
      downAt = null
      if (moved > 4 || !current.solid) return

      const rect = canvas.getBoundingClientRect()
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      )
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(pointer, current.camera)
      const [hit] = raycaster.intersectObject(current.solid, false)
      if (!hit) return

      if (picks.current.length >= 2) {
        picks.current = []
        disposeTree(current.markers)
        current.markers.clear()
      }
      picks.current.push(hit.point.clone())
      drawMeasurement(current, picks.current, accent)

      const [a, b] = picks.current
      onMeasure?.(
        b
          ? {
              from: a.toArray() as [number, number, number],
              to: b.toArray() as [number, number, number],
              distance: a.distanceTo(b),
              delta: [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)]
            }
          : { from: a.toArray() as [number, number, number], to: null, distance: null, delta: null }
      )
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.style.cursor = ''
    }
  }, [options.measuring, accent, onMeasure])

  useEffect(() => {
    if (!options.measuring) clearPicks()
  }, [options.measuring, clearPicks])

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

/* ─────────────────────────────── Rendering ──────────────────────────────── */

/** One frame: the scene, then the orientation triad over the bottom-left corner. */
function draw(current: Scene): void {
  const { renderer, scene, camera, gizmo } = current
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, renderer.domElement.width, renderer.domElement.height)
  renderer.render(scene, camera)

  const size = Math.round(Math.min(96, renderer.domElement.width * 0.14))
  const inset = Math.round(size * 0.18)
  gizmo.group.quaternion.copy(camera.quaternion).invert()
  renderer.clearDepth()
  renderer.setScissorTest(true)
  renderer.setScissor(inset, inset, size, size)
  renderer.setViewport(inset, inset, size, size)
  renderer.render(gizmo.scene, gizmo.camera)
  renderer.setScissorTest(false)
}

/** A labelled X/Y/Z triad, drawn in its own tiny viewport so it never scales. */
function buildGizmo(): Scene['gizmo'] {
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10)
  camera.position.set(0, 0, 4)
  const group = new THREE.Group()

  const axes: Array<[THREE.Vector3, number, string]> = [
    [new THREE.Vector3(1, 0, 0), 0xff4d63, 'X'],
    [new THREE.Vector3(0, 1, 0), 0x4ade80, 'Y'],
    [new THREE.Vector3(0, 0, 1), 0x60a5fa, 'Z']
  ]
  for (const [direction, colour, label] of axes) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), direction.clone()]),
      new THREE.LineBasicMaterial({ color: colour })
    )
    group.add(line)

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTexture(label, colour), transparent: true, depthTest: false })
    )
    sprite.position.copy(direction).multiplyScalar(1.3)
    sprite.scale.setScalar(0.7)
    group.add(sprite)
  }
  scene.add(group)
  return { scene, camera, group }
}

/**
 * Caps a section cut so it reads as solid material rather than a hollow shell.
 *
 * Front and back faces of the clipped solid are counted into the stencil
 * buffer without drawing anything; wherever the counts disagree the view is
 * inside the material, and a quad lying on the cut plane is painted there.
 * Without this, sectioning a part looks like someone deleted half of it.
 */
function buildCap(geometry: THREE.BufferGeometry, plane: THREE.Plane): NonNullable<Scene['cap']> {
  const group = new THREE.Group()

  const stencilMaterial = (side: THREE.Side, op: THREE.StencilOp) =>
    new THREE.MeshBasicMaterial({
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      side,
      stencilFail: op,
      stencilZFail: op,
      stencilZPass: op,
      clippingPlanes: [plane]
    })

  const back = new THREE.Mesh(geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp))
  const front = new THREE.Mesh(geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp))
  for (const mesh of [back, front]) {
    mesh.renderOrder = 1
    mesh.frustumCulled = false
    group.add(mesh)
  }

  const material = new THREE.MeshStandardMaterial({
    metalness: 0.2,
    roughness: 0.62,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp
  })
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  quad.renderOrder = 2
  quad.frustumCulled = false
  // The quad only paints where the stencil says "inside", so it must not be
  // clipped by the very plane it represents.
  quad.onAfterRender = (renderer) => renderer.clearStencil()
  group.add(quad)

  return { group, plane: quad, material }
}

/** Driver or platform may refuse a stencil buffer; then sectioning goes uncapped. */
function hasStencil(renderer: THREE.WebGLRenderer): boolean {
  try {
    return renderer.getContext().getContextAttributes()?.stencil === true
  } catch {
    return false
  }
}

function labelTexture(text: string, colour: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (context) {
    context.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
    context.font = 'bold 42px ui-monospace, monospace'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 32, 34)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** Endpoint markers and the line between them, scaled to the model. */
function drawMeasurement(current: Scene, points: THREE.Vector3[], accent: string): void {
  disposeTree(current.markers)
  current.markers.clear()
  if (!points.length) return

  const colour = new THREE.Color(accent)
  const size = Math.max(current.radius * 0.012, 1e-4)
  for (const point of points) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(size, 16, 12),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false })
    )
    dot.position.copy(point)
    dot.renderOrder = 10
    current.markers.add(dot)
  }
  if (points.length === 2) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false })
    )
    line.renderOrder = 10
    current.markers.add(line)
  }
}

/** Frees every geometry and material under an object, leaving the object itself. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose?.()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
    else material?.dispose?.()
  })
}

/** Grid spacing a person would choose: 1, 2, 5, 10, 20, 50… */
function niceStep(raw: number): number {
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))))
  const normalised = raw / magnitude
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10
  return step * magnitude
}
