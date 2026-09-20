import type { DocumentRuntimeTarget } from "@koala-ai/core/document-runtime/target"
import path from "node:path"

const nativePackages = {
  "x86_64-apple-darwin": "@napi-rs/canvas-darwin-x64",
  "aarch64-apple-darwin": "@napi-rs/canvas-darwin-arm64",
  "x86_64-pc-windows-msvc": "@napi-rs/canvas-win32-x64-msvc",
  "aarch64-pc-windows-msvc": "@napi-rs/canvas-win32-arm64-msvc",
  "x86_64-unknown-linux-gnu": "@napi-rs/canvas-linux-x64-gnu",
  "aarch64-unknown-linux-gnu": "@napi-rs/canvas-linux-arm64-gnu",
} as const satisfies Record<DocumentRuntimeTarget.Target, string>

const nativeBinaries = {
  "x86_64-apple-darwin": "skia.darwin-x64.node",
  "aarch64-apple-darwin": "skia.darwin-arm64.node",
  "x86_64-pc-windows-msvc": "skia.win32-x64-msvc.node",
  "aarch64-pc-windows-msvc": "skia.win32-arm64-msvc.node",
  "x86_64-unknown-linux-gnu": "skia.linux-x64-gnu.node",
  "aarch64-unknown-linux-gnu": "skia.linux-arm64-gnu.node",
} as const satisfies Record<DocumentRuntimeTarget.Target, string>

export function runtimeNativePackage(target: DocumentRuntimeTarget.Target) {
  return nativePackages[target]
}

export function runtimeNativeBinary(target: DocumentRuntimeTarget.Target) {
  return nativeBinaries[target]
}

export function runtimePaths(root: string, target: DocumentRuntimeTarget.Target) {
  const nativePackage = runtimeNativePackage(target)
  return {
    bootstrap: path.join(root, "worker", "bootstrap.js"),
    worker: path.join(root, "worker", "worker.js"),
    tesseract: path.join(root, "bin", target.includes("windows") ? "tesseract.exe" : "tesseract"),
    tessdata: path.join(root, "tessdata"),
    pdfRoot: path.join(root, "node_modules", "pdfjs-dist"),
    canvasEntry: path.join(root, "node_modules", "@napi-rs", "canvas", "index.js"),
    canvasNativeRoot: path.join(root, "node_modules", ...nativePackage.split("/")),
  }
}

export function sanitizeNativeLoaderEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  delete environment.NAPI_RS_NATIVE_LIBRARY_PATH
  delete environment.NODE_OPTIONS
  delete environment.LD_LIBRARY_PATH
  delete environment.LD_PRELOAD
  delete environment.DYLD_INSERT_LIBRARIES
  delete environment.DYLD_LIBRARY_PATH
  environment.DISABLE_SYSTEM_FONTS_LOAD = "1"
}
