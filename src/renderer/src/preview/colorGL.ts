// SPDX-License-Identifier: GPL-3.0-or-later
// WebGL2 color stage for the live preview (closes COLOR_GRADING_PLAN §9.5.12). The Canvas-2D
// `ctx.filter` path can't sample a 3D `.cube` LUT, so a graded clip looked uncolorized during
// playback. This renders one cropped source frame through a fragment shader that samples the `.cube`
// as a 3D texture and applies the same grade as the FFmpeg export — in the SAME order
// (LUT → intensity blend → eq → hue → colorbalance → curves), reusing the export's calibration
// constants — so what plays matches the paused still and the final render (LUT trilinear here vs
// FFmpeg tetrahedral: cosmetically identical for these film LUTs).
//
// It is a per-layer COLOR pass only: it returns a graded canvas that Preview.tsx composites with the
// existing 2D transform/crop/opacity/rotation/z-order. The compositor itself is untouched.

import {
  type ColorAdjustments,
  EXPOSURE_TO_BRIGHTNESS,
  TEMP_RB,
  TINT_G,
  TONAL_LIFT
} from '@core'

export interface CropRect {
  left: number
  top: number
  right: number
  bottom: number
}

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // Map clip [-1,1] → uv [0,1] with Y flipped so the rendered canvas reads upright when the 2D
  // compositor draws it (framebuffer top = clip y=+1 = source top row, which texImage2D puts at t=0).
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 frag;

uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform vec2 uUvMin;     // crop origin (fractions)
uniform vec2 uUvSize;    // crop size (fractions)
uniform bool uHasLut;
uniform float uLutIntensity;
uniform float uBrightness;   // brightness + exposure*k, additive
uniform float uContrast;     // pivot 0.5
uniform float uSaturation;
uniform float uGamma;
uniform float uHueRad;
uniform vec3 uCb;            // colorbalance midtone shift (rm, gm, bm)
uniform bool uHasCurve;
uniform float uTonalY[5];   // curve outputs at x = 0, 0.25, 0.75, 0.95, 1

float curve1(float x) {
  if (x <= 0.0) return uTonalY[0];
  if (x < 0.25) return mix(uTonalY[0], uTonalY[1], x / 0.25);
  if (x < 0.75) return mix(uTonalY[1], uTonalY[2], (x - 0.25) / 0.5);
  if (x < 0.95) return mix(uTonalY[2], uTonalY[3], (x - 0.75) / 0.2);
  if (x < 1.0) return mix(uTonalY[3], uTonalY[4], (x - 0.95) / 0.05);
  return uTonalY[4];
}

void main() {
  vec2 uv = uUvMin + vUv * uUvSize;
  vec3 c0 = texture(uSrc, uv).rgb;

  // LUT first (with intensity blend against the original), matching buildColorFilterChain.
  vec3 c = c0;
  if (uHasLut) {
    vec3 l = texture(uLut, clamp(c0, 0.0, 1.0)).rgb;
    c = mix(c0, l, uLutIntensity);
  }

  // eq: contrast (pivot 0.5) → +brightness → gamma → saturation (Rec.601 luma).
  c = (c - 0.5) * uContrast + 0.5;
  c += uBrightness;
  if (uGamma != 1.0) c = pow(max(c, 0.0), vec3(1.0 / uGamma));
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, uSaturation);

  // hue rotation (luma-preserving; matches the CSS hue-rotate the 2D fallback uses).
  if (uHueRad != 0.0) {
    float ca = cos(uHueRad);
    float sa = sin(uHueRad);
    mat3 h = mat3(
      0.213 + ca * 0.787 - sa * 0.213, 0.213 - ca * 0.213 + sa * 0.143, 0.213 - ca * 0.213 - sa * 0.787,
      0.715 - ca * 0.715 - sa * 0.715, 0.715 + ca * 0.285 + sa * 0.140, 0.715 - ca * 0.715 + sa * 0.715,
      0.072 - ca * 0.072 + sa * 0.928, 0.072 - ca * 0.072 - sa * 0.283, 0.072 + ca * 0.928 + sa * 0.072
    );
    c = h * c;
  }

  // colorbalance (temperature/tint) as a flat midtone shift (approx; the LUT carries the dominant look).
  c += uCb;

  if (uHasCurve) c = vec3(curve1(c.r), curve1(c.g), curve1(c.b));

  frag = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[colorGL] shader compile failed:', gl.getShaderInfoLog(sh))
    gl.deleteShader(sh)
    return null
  }
  return sh
}

/** WebGL2 color renderer. One offscreen canvas + program, reused across frames. LUTs are uploaded
 *  once and cached by key (lutRef). `render` returns the canvas (already graded) or null if WebGL2 is
 *  unavailable, so the caller can fall back to the Canvas-2D approximation. */
export class ColorGL {
  private gl: WebGL2RenderingContext
  readonly canvas: HTMLCanvasElement
  private program: WebGLProgram
  private srcTex: WebGLTexture
  private luts = new Map<string, { tex: WebGLTexture; size: number }>()
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private lost = false
  // Downscale oversized frames (e.g. 4K) before uploading: the preview renders small, so a full-res
  // per-frame texture upload is wasted bandwidth. Long-side cap in source pixels.
  private static readonly UPLOAD_CAP = 1280
  private uploadCanvas = document.createElement('canvas')
  private uploadCtx = this.uploadCanvas.getContext('2d')
  private dummyLut: WebGLTexture | null = null

  private constructor(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, program: WebGLProgram, srcTex: WebGLTexture) {
    this.gl = gl
    this.canvas = canvas
    this.program = program
    this.srcTex = srcTex
    canvas.addEventListener('webglcontextlost', () => {
      this.lost = true
    })
    for (const name of [
      'uSrc', 'uLut', 'uUvMin', 'uUvSize', 'uHasLut', 'uLutIntensity', 'uBrightness',
      'uContrast', 'uSaturation', 'uGamma', 'uHueRad', 'uCb', 'uHasCurve', 'uTonalY'
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }
  }

  static create(): ColorGL | null {
    try {
      return ColorGL.createInner()
    } catch (e) {
      console.error('[colorGL] create failed:', e)
      return null
    }
  }

  private static createInner(): ColorGL | null {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false, antialias: false })
    if (!gl) return null
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return null
    const program = gl.createProgram()
    if (!program) return null
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[colorGL] link failed:', gl.getProgramInfoLog(program))
      return null
    }

    // Full-screen quad (triangle strip).
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    const srcTex = gl.createTexture()
    if (!srcTex) return null
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    return new ColorGL(gl, canvas, program, srcTex)
  }

  isDead(): boolean {
    return this.lost
  }

  hasLut(key: string): boolean {
    return this.luts.has(key)
  }

  /** Upload a parsed `.cube` (size³ RGB triplets, red fastest) as a LINEAR 3D texture, cached by key. */
  setLut(key: string, size: number, rgb: Float32Array): void {
    try {
      this.uploadLut(key, size, rgb)
    } catch (e) {
      console.error('[colorGL] setLut failed:', e)
    }
  }

  private uploadLut(key: string, size: number, rgb: Float32Array): void {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) return
    const n = size * size * size
    const rgba = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = rgb[i * 3]
      rgba[i * 4 + 1] = rgb[i * 3 + 1]
      rgba[i * 4 + 2] = rgb[i * 3 + 2]
      rgba[i * 4 + 3] = 1
    }
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    // RGBA16F is core-filterable in WebGL2 (no float-linear extension needed); FLOAT data is accepted.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba)
    this.luts.set(key, { tex, size })
  }

  /** Render `source` (cropped) through the grade into the offscreen canvas at `outW`×`outH`.
   *  Pass `lutKey = null` to render the grade without a LUT (graceful when the LUT isn't loaded). */
  render(
    source: TexImageSource,
    crop: CropRect,
    color: ColorAdjustments,
    lutKey: string | null,
    outW: number,
    outH: number
  ): HTMLCanvasElement | null {
    if (this.lost) return null
    try {
      return this.renderInner(source, crop, color, lutKey, outW, outH)
    } catch (e) {
      // e.g. a tainted source (SecurityError) — never let it crash the renderer; the caller falls back.
      console.error('[colorGL] render failed:', e)
      this.lost = true
      return null
    }
  }

  /** A 1×1×1 identity 3D texture kept bound to unit 1 when no real LUT is active, so the sampler3D
   *  uniform never aliases the 2D source sampler. Created once. */
  private ensureDummyLut(): WebGLTexture | null {
    if (this.dummyLut) return this.dummyLut
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 0, 0, 1]))
    this.dummyLut = tex
    return tex
  }

  /** If `source` is larger than the upload cap, draw it (downscaled) into a reused 2D canvas and
   *  return that; otherwise return the source unchanged. Bounds per-frame texture-upload cost. */
  private cappedSource(source: TexImageSource): TexImageSource {
    const s = source as Partial<{
      videoWidth: number
      naturalWidth: number
      width: number
      videoHeight: number
      naturalHeight: number
      height: number
    }>
    const sw = s.videoWidth ?? s.naturalWidth ?? s.width ?? 0
    const sh = s.videoHeight ?? s.naturalHeight ?? s.height ?? 0
    const long = Math.max(sw, sh)
    if (!this.uploadCtx || sw === 0 || sh === 0 || long <= ColorGL.UPLOAD_CAP) return source
    const scale = ColorGL.UPLOAD_CAP / long
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    if (this.uploadCanvas.width !== w || this.uploadCanvas.height !== h) {
      this.uploadCanvas.width = w
      this.uploadCanvas.height = h
    }
    this.uploadCtx.drawImage(source as CanvasImageSource, 0, 0, w, h)
    return this.uploadCanvas
  }

  private renderInner(
    source: TexImageSource,
    crop: CropRect,
    color: ColorAdjustments,
    lutKey: string | null,
    outW: number,
    outH: number
  ): HTMLCanvasElement {
    const gl = this.gl
    const u = this.uniforms
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW
      this.canvas.height = outH
    }
    gl.viewport(0, 0, outW, outH)
    gl.useProgram(this.program)

    // Source frame → unit 0 (downscaled first if it's much larger than the preview).
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.cappedSource(source))
    gl.uniform1i(u.uSrc, 0)

    // uLut must ALWAYS point to a bound 3D texture on its own unit — even when unused — otherwise it
    // defaults to unit 0 and collides with the 2D uSrc (GL_INVALID_OPERATION: mixed sampler types).
    const lut = lutKey ? this.luts.get(lutKey) : undefined
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, lut ? lut.tex : this.ensureDummyLut())
    gl.uniform1i(u.uLut, 1)
    gl.uniform1i(u.uHasLut, lut ? 1 : 0)
    gl.uniform1f(u.uLutIntensity, color.lutIntensity)

    gl.uniform2f(u.uUvMin, crop.left, crop.top)
    gl.uniform2f(u.uUvSize, 1 - crop.left - crop.right, 1 - crop.top - crop.bottom)

    gl.uniform1f(u.uBrightness, color.brightness + color.exposure * EXPOSURE_TO_BRIGHTNESS)
    gl.uniform1f(u.uContrast, color.contrast)
    gl.uniform1f(u.uSaturation, color.saturation)
    gl.uniform1f(u.uGamma, color.gamma)
    gl.uniform1f(u.uHueRad, (color.hue * Math.PI) / 180)
    gl.uniform3f(u.uCb, color.temperature * TEMP_RB, -color.tint * TINT_G, -color.temperature * TEMP_RB)

    const hasCurve =
      color.blacks !== 0 || color.shadows !== 0 || color.highlights !== 0 || color.whites !== 0
    gl.uniform1i(u.uHasCurve, hasCurve ? 1 : 0)
    gl.uniform1fv(
      u.uTonalY,
      new Float32Array([
        clamp01(color.blacks * TONAL_LIFT),
        color.shadows !== 0 ? clamp01(0.25 + color.shadows * TONAL_LIFT) : 0.25,
        color.highlights !== 0 ? clamp01(0.75 + color.highlights * TONAL_LIFT) : 0.75,
        color.whites !== 0 ? clamp01(0.95 + color.whites * TONAL_LIFT) : 0.95,
        1
      ])
    )

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return this.canvas
  }
}

let singleton: ColorGL | null = null
let tried = false

/** Lazily create (once) the shared WebGL2 color renderer, or null if unsupported. Recreates after a
 *  GPU context loss. */
export function getColorGL(): ColorGL | null {
  if (singleton && singleton.isDead()) {
    singleton = null
    tried = false
  }
  if (!singleton && !tried) {
    tried = true
    singleton = ColorGL.create()
  }
  return singleton
}
