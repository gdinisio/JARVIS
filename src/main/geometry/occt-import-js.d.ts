/**
 * occt-import-js ships an Emscripten bundle with no type declarations.
 * This describes only the surface JARVIS uses: the default export is a factory
 * that resolves to the initialised WASM instance.
 */
declare module 'occt-import-js' {
  interface OcctAttribute {
    array: number[]
  }

  interface OcctMesh {
    name?: string
    color?: [number, number, number]
    attributes: {
      position: OcctAttribute
      normal?: OcctAttribute
    }
    index: OcctAttribute
  }

  interface OcctReadResult {
    success: boolean
    root?: unknown
    meshes: OcctMesh[]
  }

  interface OcctInstance {
    ReadStepFile(content: Uint8Array, params: unknown): OcctReadResult
    ReadIgesFile(content: Uint8Array, params: unknown): OcctReadResult
    ReadBrepFile(content: Uint8Array, params: unknown): OcctReadResult
  }

  const factory: (moduleOverrides?: Record<string, unknown>) => Promise<OcctInstance>
  export default factory
}
