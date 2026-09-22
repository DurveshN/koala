export * as DocumentRuntimeManifest from "./manifest.ts"

import { Schema } from "effect"
import { DocumentRuntimeTarget } from "./target.ts"

export const ManifestVersion = Schema.Literal(1)
export type ManifestVersion = typeof ManifestVersion.Type
export const SupportedProtocolVersion = Schema.Literal(1)
export const MaxRelativePathLength = 1_024
export const MaxComponents = 128
export const MaxFiles = 4_096
export const MaxDependencies = 512
export const MaxLicensesPerEntry = 32

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("DocumentRuntimeManifest.Digest"),
)
export type Digest = typeof Digest.Type

export const RelativePath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxRelativePathLength),
  Schema.makeFilter((value) => {
    if (value.includes("\0") || /[\u0001-\u001f\u007f]/.test(value)) return "Paths cannot contain control characters"
    if (value.includes("\\")) return "Paths must use forward slashes"
    if (value.startsWith("/") || /^[a-zA-Z]:/.test(value)) return "Paths must be relative"
    const segments = value.split("/")
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return "Paths must be normalized without empty or dot segments"
    }
    if (segments.some((segment) => segment.includes(":") || /[. ]$/.test(segment))) {
      return "Paths cannot use Windows streams or trailing dots and spaces"
    }
    return segments.some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))
      ? "Paths cannot use reserved Windows device names"
      : undefined
  }),
).pipe(Schema.brand("DocumentRuntimeManifest.RelativePath"))
export type RelativePath = typeof RelativePath.Type

export const Name = Schema.String.check(
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._+-]{0,62}\/)?[a-z0-9][a-z0-9._+-]{0,127}$/i),
)
export const Version = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._+-]{0,127}$/i))
export const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._+-]{0,127}$/i))
const LicensePaths = Schema.Array(RelativePath).check(
  Schema.isMaxLength(MaxLicensesPerEntry),
  uniquePaths("License paths"),
)

export const FileMode = Schema.Literals([0o644, 0o755])
export type FileMode = typeof FileMode.Type

export interface Component extends Schema.Schema.Type<typeof Component> {}
export const Component = Schema.Struct({
  name: Name,
  version: Version,
  sourceRevision: SourceRevision,
  sourceSha256: Digest,
  licenseFiles: LicensePaths,
}).annotate({ identifier: "DocumentRuntimeManifest.Component" })

export interface File extends Schema.Schema.Type<typeof File> {}
export const File = Schema.Struct({
  path: RelativePath,
  component: Name,
  sha256: Digest,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  mode: FileMode,
}).annotate({ identifier: "DocumentRuntimeManifest.File" })

export const Linkage = Schema.Literals(["static", "dynamic", "data", "javascript"])
export type Linkage = typeof Linkage.Type

export interface Dependency extends Schema.Schema.Type<typeof Dependency> {}
export const Dependency = Schema.Struct({
  name: Name,
  version: Version,
  component: Name,
  linkage: Linkage,
  licenseFiles: LicensePaths,
}).annotate({ identifier: "DocumentRuntimeManifest.Dependency" })

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  manifestVersion: ManifestVersion,
  protocolVersion: SupportedProtocolVersion,
  releaseReady: Schema.Boolean,
  runtimeVersion: Version,
  target: DocumentRuntimeTarget.Target,
  architecture: DocumentRuntimeTarget.Architecture,
  components: Schema.Array(Component).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MaxComponents),
    uniqueBy("Component names", (component) => component.name.toLowerCase()),
  ),
  files: Schema.Array(File).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MaxFiles),
    uniqueBy("File paths", (file) => file.path.toLowerCase()),
  ),
  dependencies: Schema.Array(Dependency).check(
    Schema.isMaxLength(MaxDependencies),
    uniqueBy("Dependencies", (dependency) => `${dependency.name.toLowerCase()}@${dependency.version}`),
  ),
})
  .check(
    Schema.makeFilter((manifest) =>
      manifest.architecture === DocumentRuntimeTarget.architecture(manifest.target)
        ? undefined
        : "Manifest architecture does not match its target",
    ),
    Schema.makeFilter((manifest) => {
      const components = new Set(manifest.components.map((component) => component.name.toLowerCase()))
      return manifest.files.every((file) => components.has(file.component.toLowerCase())) &&
        manifest.dependencies.every((dependency) => components.has(dependency.component.toLowerCase()))
        ? undefined
        : "Every file and dependency must reference a declared component"
    }),
    Schema.makeFilter((manifest) => {
      const files = new Set(manifest.files.map((file) => file.path.toLowerCase()))
      const licenses = manifest.components
        .flatMap((component) => component.licenseFiles)
        .concat(manifest.dependencies.flatMap((dependency) => dependency.licenseFiles))
      return licenses.every((license) => files.has(license.toLowerCase()))
        ? undefined
        : "Every license path must reference a hashed manifest file"
    }),
    Schema.makeFilter((manifest) =>
      !manifest.releaseReady ||
      (manifest.components.every((component) => component.licenseFiles.length > 0) &&
        manifest.dependencies.every((dependency) => dependency.licenseFiles.length > 0))
        ? undefined
        : "Release-ready manifests require license files for every component and dependency",
    ),
  )
  .annotate({ identifier: "DocumentRuntimeManifest.Manifest" })

function uniquePaths(label: string) {
  return uniqueBy(label, (path: string) => path.toLowerCase())
}

function uniqueBy<A>(label: string, key: (value: A) => string) {
  return Schema.makeFilter((values: ReadonlyArray<A>) =>
    new Set(values.map(key)).size === values.length ? undefined : `${label} must be unique`,
  )
}
