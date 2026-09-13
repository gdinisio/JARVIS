/**
 * Problems the user can understand and act on: a file that is not what its
 * extension claims, dimensions beyond what the kernel will model, a
 * description that cuts away all its own material.
 *
 * These are reported in plain language and logged as warnings. Anything that
 * is *not* one of these is a genuine fault and gets logged as an error.
 */
export class GeometryError extends Error {}

/** A file that could not be read as the format it claims to be. */
export class ParseError extends GeometryError {}
