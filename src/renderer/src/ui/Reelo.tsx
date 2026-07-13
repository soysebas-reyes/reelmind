// SPDX-License-Identifier: GPL-3.0-or-later
// Reelo — the app's mascot (and namesake): an 8-bit clapperboard rendered as pixel-art on a <canvas>. It replaces the
// generic spinner and headlines the progress modal, giving every loading/interaction moment a character.
// The sprite is drawn cell-by-cell on a 22×24 grid and animated by FRAMES (the clap is a hinge shear, not
// a CSS rotation), so it stays crisp from 24px up. One shared requestAnimationFrame ticks every mounted
// instance; components register on mount and unregister on unmount. Honors prefers-reduced-motion.

import { useEffect, useRef } from 'react'

export type ReeloState = 'idle' | 'loading' | 'progress' | 'success'

/** Cinema-themed loading lines for the progress modal (rotate while working). */
export const REELO_MESSAGES = [
  'Enrollando el film…',
  'Diciendo ¡acción!…',
  'Sincronizando ángulos…',
  'Puliendo cada toma…',
  'Iluminando la escena…',
  'Coloreando fotogramas…',
  'Mezclando el audio…',
  'Cortando lo que sobra…'
]

// ── Pixel palette (mirrors App.css tokens so Reelo lives in the app's world) ───────────────────────
const C: Record<number, string> = {
  1: '#2f2f37', // slate body
  2: '#191920', // slate shadow / outline
  3: '#f3f2ee', // chalk
  4: '#0a84ff', // accent iris
  5: '#ff453a', // rec red
  6: '#0a0a0c', // pupil
  7: '#30d158', // green
  8: '#ffd60a', // spark
  9: '#3a3a44' // slate light edge
}
const GW = 22
const GH = 24

interface Anim {
  bob: number
  clap: number
  blink: boolean
  rec: boolean
  lookX: number
  lookY: number
  expr: 'flat' | 'o' | 'smile'
  spark: number
}

function drawMascot(ctx: CanvasRenderingContext2D, Q: number, a: Anim): void {
  ctx.clearRect(0, 0, GW * Q, GH * Q)
  const bob = a.bob | 0
  const px = (x: number, y: number, c: number): void => {
    if (!c) return
    ctx.fillStyle = C[c]
    ctx.fillRect(x * Q, (y + bob) * Q, Q, Q)
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, c)
  }

  // ground shadow (does not bob)
  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.fillRect(6 * Q, 22 * Q, 10 * Q, Q)

  // feet
  rect(6, 21, 8, 22, 2)
  rect(13, 21, 15, 22, 2)

  // body slate + light top edge + outline
  rect(4, 6, 17, 20, 1)
  rect(4, 6, 17, 6, 9)
  for (let x = 4; x <= 17; x++) px(x, 20, 2)
  for (let y = 6; y <= 20; y++) {
    px(4, y, 2)
    px(17, y, 2)
  }

  // chalk "scale" baseline with tick marks
  for (let x = 5; x <= 16; x++) px(x, 18, 3)
  for (let x = 5; x <= 16; x += 2) px(x, 17, 3)

  // REC dot (blinks red while loading)
  if (a.rec) rect(14, 8, 15, 9, 5)

  // eyes: chalk whites + iris/pupil, with look offset + blink
  const lx = a.lookX | 0
  const ly = a.lookY | 0
  const eye = (ex: number, ey: number): void => {
    rect(ex, ey, ex + 2, ey + 2, 3)
    if (!a.blink) {
      const ix = ex + 1 + lx
      const iy = ey + 1 + ly
      px(ix, iy, 4)
      px(ix, iy, 6)
    } else {
      rect(ex, ey, ex + 2, ey + 1, 1)
      rect(ex, ey + 1, ex + 2, ey + 1, 9)
    }
  }
  eye(6, 9)
  eye(12, 9)

  // mouth / expression
  if (a.expr === 'smile') {
    px(9, 15, 3)
    px(10, 16, 3)
    px(11, 16, 3)
    px(12, 15, 3)
  } else if (a.expr === 'o') {
    rect(10, 15, 11, 16, 3)
  } else {
    rect(9, 15, 12, 15, 3)
  }

  // clap stick: hinged at left (x=3), sheared up on the right by clap amount
  const clap = a.clap
  const maxLift = 6
  for (let x = 3; x <= 19; x++) {
    const t = (x - 3) / (19 - 3)
    const lift = Math.round(clap * t * maxLift)
    for (let y = 3; y <= 5; y++) {
      const yy = y - lift
      const stripe = (x + y) % 4 < 2 ? 3 : 2
      px(x, yy, stripe)
    }
    if (lift > 0) px(x, 6, 2)
  }
  px(3, 4, 9)
  px(3, 5, 9)

  // sparkles on success
  if (a.spark) {
    const s = a.spark
    const puffs = [
      [2, 6],
      [19, 7],
      [1, 12],
      [20, 13],
      [3, 2],
      [18, 2]
    ]
    for (let i = 0; i < puffs.length; i++) {
      if (((s * 6) | 0) % puffs.length === i || s > 0.6) px(puffs[i][0], puffs[i][1], 8)
    }
  }
}

// ── Per-instance runtime state ─────────────────────────────────────────────────────────────────────
interface Instance {
  ctx: CanvasRenderingContext2D
  Q: number
  state: ReeloState
  progress: number
  autoLoop: boolean
  look: { x: number; y: number }
  targetLook: { x: number; y: number }
  blinkT: number
  blinkPhase: number
  clapPulse: number
  successT: number
  seed: number
}

function computeFrame(inst: Instance, t: number, dt: number): Anim {
  const a: Anim = { bob: 0, clap: 0, blink: false, rec: false, lookX: 0, lookY: 0, expr: 'flat', spark: 0 }
  const st = inst.state

  inst.blinkT -= dt
  if (inst.blinkT <= 0) {
    inst.blinkT = 2.2 + Math.random() * 3.4
    inst.blinkPhase = 0.14
  }
  if (inst.blinkPhase > 0) {
    inst.blinkPhase -= dt
    a.blink = true
  }

  inst.look.x += (inst.targetLook.x - inst.look.x) * Math.min(1, dt * 8)
  inst.look.y += (inst.targetLook.y - inst.look.y) * Math.min(1, dt * 8)
  a.lookX = Math.max(-1, Math.min(1, Math.round(inst.look.x)))
  a.lookY = Math.max(-1, Math.min(1, Math.round(inst.look.y)))

  if (inst.clapPulse > 0) inst.clapPulse = Math.max(0, inst.clapPulse - dt * 3.2)

  if (st === 'idle') {
    a.bob = Math.round(Math.sin(t * 1.6 + inst.seed) * 0.6 - 0.3)
    const cyc = (t * 0.22 + inst.seed) % 1
    const gentle = cyc > 0.9 ? Math.sin(((cyc - 0.9) / 0.1) * Math.PI) * 0.5 : 0
    a.clap = Math.max(gentle, inst.clapPulse)
    if (a.clap > 0.5) a.expr = 'o'
  } else if (st === 'loading') {
    a.bob = Math.round(Math.sin(t * 6) * 0.6 - 0.3)
    const tri = Math.abs(((t * 2.2) % 1) * 2 - 1)
    a.clap = 1 - tri
    a.rec = Math.floor(t * 2) % 2 === 0
    a.expr = a.clap > 0.55 ? 'o' : 'flat'
    inst.targetLook = { x: Math.sin(t * 3) * 1.1, y: 0 }
  } else if (st === 'progress') {
    a.bob = Math.round(Math.sin(t * 3) * 0.6 - 0.3)
    const p = inst.progress
    const rate = 1.2 + p * 2.4
    const tri = Math.abs(((t * rate) % 1) * 2 - 1)
    a.clap = (1 - tri) * (0.5 + p * 0.5)
    a.rec = Math.floor(t * 3) % 2 === 0
    a.expr = p > 0.85 ? 'smile' : a.clap > 0.6 ? 'o' : 'flat'
  } else if (st === 'success') {
    inst.successT += dt
    const s = inst.successT
    const jump = Math.max(0, Math.sin((Math.min(s, 0.5) / 0.5) * Math.PI)) * 3
    a.bob = -Math.round(jump)
    a.clap = s < 0.18 ? 1 : Math.max(0, 0.4 - (s - 0.18))
    a.expr = 'smile'
    a.spark = Math.max(0, 1 - s * 0.9)
    inst.targetLook = { x: 0, y: -1 }
    if (s > 2.2 && inst.autoLoop) inst.successT = 0
  }

  if (inst.clapPulse > 0 && st !== 'success') {
    a.clap = Math.max(a.clap, inst.clapPulse)
    if (a.clap > 0.5) a.expr = 'o'
  }
  return a
}

// ── Shared ticker ───────────────────────────────────────────────────────────────────────────────────
const registry = new Set<Instance>()
let rafId = 0
let last = 0
const REDUCED = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function staticFrame(inst: Instance): Anim {
  return {
    bob: 0,
    clap: inst.state === 'success' ? 0.3 : 0,
    blink: false,
    rec: false,
    lookX: 0,
    lookY: 0,
    expr: inst.state === 'success' ? 'smile' : 'flat',
    spark: inst.state === 'success' ? 0.7 : 0
  }
}

function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  const t = now / 1000
  for (const inst of registry) drawMascot(inst.ctx, inst.Q, computeFrame(inst, t, dt))
  rafId = registry.size > 0 ? requestAnimationFrame(tick) : 0
}

function ensureLoop(): void {
  if (REDUCED) return
  if (rafId === 0) {
    last = performance.now()
    rafId = requestAnimationFrame(tick)
  }
}

interface ReeloProps {
  state?: ReeloState
  /** Displayed width in px (height scales to keep the sprite's aspect). Default 30 (spinner size). */
  size?: number
  /** 0..1 — drives the eagerness of the `progress` state. */
  progress?: number
  /** Follow the cursor + clap on click. */
  interactive?: boolean
  onCheer?: () => void
  className?: string
  ariaLabel?: string
}

/** The app's mascot. Drop-in for a spinner: `<Reelo state="loading" size={30} />`. */
export function Reelo({
  state = 'loading',
  size = 30,
  progress = 0.5,
  interactive = false,
  onCheer,
  className,
  ariaLabel = 'Reelo'
}: ReeloProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const instRef = useRef<Instance | null>(null)

  // Register the instance once (canvas + derived scale); the ticker drives it thereafter.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const Q = Math.max(1, Math.floor(size / GW))
    canvas.width = GW * Q
    canvas.height = GH * Q
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    const inst: Instance = {
      ctx,
      Q,
      state,
      progress,
      autoLoop: true,
      look: { x: 0, y: 0 },
      targetLook: { x: 0, y: 0 },
      blinkT: 1 + Math.random() * 3,
      blinkPhase: 0,
      clapPulse: 0,
      successT: 0,
      seed: Math.random() * 10
    }
    instRef.current = inst
    if (REDUCED) {
      drawMascot(ctx, Q, staticFrame(inst))
      return
    }
    registry.add(inst)
    ensureLoop()
    return () => {
      registry.delete(inst)
      instRef.current = null
    }
  }, [size])

  // Keep live props in sync without re-registering.
  useEffect(() => {
    const inst = instRef.current
    if (!inst) return
    if (inst.state !== state && state === 'success') inst.successT = 0
    inst.state = state
    inst.progress = progress
    if (REDUCED) drawMascot(inst.ctx, inst.Q, staticFrame(inst))
  }, [state, progress])

  const onPointerMove = interactive
    ? (e: React.PointerEvent<HTMLCanvasElement>): void => {
        const inst = instRef.current
        if (!inst) return
        const r = e.currentTarget.getBoundingClientRect()
        inst.targetLook = {
          x: ((e.clientX - r.left) / r.width - 0.5) * 2.4,
          y: ((e.clientY - r.top) / r.height - 0.5) * 2.4
        }
      }
    : undefined
  const onPointerLeave = interactive
    ? (): void => {
        const inst = instRef.current
        if (inst) inst.targetLook = { x: 0, y: 0 }
      }
    : undefined
  const onClick = interactive
    ? (): void => {
        const inst = instRef.current
        if (inst) inst.clapPulse = 1
        onCheer?.()
      }
    : undefined

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={ariaLabel}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
      style={{
        width: size,
        height: Math.round((size * GH) / GW),
        imageRendering: 'pixelated',
        cursor: interactive ? 'pointer' : undefined,
        touchAction: interactive ? 'none' : undefined,
        flex: 'none'
      }}
    />
  )
}
