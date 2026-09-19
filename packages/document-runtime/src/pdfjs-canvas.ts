import type { Canvas } from "@napi-rs/canvas"

// PDF.js types require the browser canvas surface, while its Node renderer only
// consumes the compatible 2D methods implemented by @napi-rs/canvas.
export function pdfjsCanvas(canvas: Canvas): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement
}
