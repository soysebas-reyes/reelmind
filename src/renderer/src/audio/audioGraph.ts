// SPDX-License-Identifier: GPL-3.0-or-later
// Live-preview approximation of the audio-enhance chain, built from Web Audio nodes so parameter changes
// are AUDIBLE during normal timeline playback (not just in the modal A/B). The EXACT result — including
// spectral denoise (afftdn), noise gate and true LUFS loudness — is produced by FFmpeg on export
// (core/model/audioEnhanceChain.ts); here we cover the parts the browser can do cheaply and faithfully:
// high-pass / low-pass, a 4-band parametric EQ, a compressor, a brick-wall limiter and output gain.
//
// A MediaElementAudioSourceNode can be created only ONCE per <audio>/<video> element, after which the
// element's audio routes through our graph instead of the default output — so we build lazily and cache
// per element. Elements that are never enhanced are left untouched (they keep playing on the default
// output with no overhead). `el.volume`/`el.muted` still apply (per-clip gain + track mute) BEFORE the graph.

import { type AudioEnhanceSettings, audioEnhanceIsIdentity } from '@core'

interface EnhanceGraph {
  highpass: BiquadFilterNode
  lowpass: BiquadFilterNode
  lowShelf: BiquadFilterNode
  mud: BiquadFilterNode
  presence: BiquadFilterNode
  air: BiquadFilterNode
  comp: DynamicsCompressorNode
  limiter: DynamicsCompressorNode
  output: GainNode
}

let ctx: AudioContext | null = null
const graphs = new WeakMap<HTMLMediaElement, EnhanceGraph>()

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

function dbToLin(db: number): number {
  return Math.pow(10, db / 20)
}

/** Build (once) the node chain for an element and route source → … → destination. */
function build(el: HTMLMediaElement): EnhanceGraph {
  const c = getCtx()
  const source = c.createMediaElementSource(el)
  const highpass = c.createBiquadFilter()
  highpass.type = 'highpass'
  const lowpass = c.createBiquadFilter()
  lowpass.type = 'lowpass'
  const lowShelf = c.createBiquadFilter()
  lowShelf.type = 'lowshelf'
  lowShelf.frequency.value = 120
  const mud = c.createBiquadFilter()
  mud.type = 'peaking'
  mud.frequency.value = 250
  mud.Q.value = 1.2
  const presence = c.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 4000
  presence.Q.value = 1.0
  const air = c.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 12000
  const comp = c.createDynamicsCompressor()
  const limiter = c.createDynamicsCompressor()
  const output = c.createGain()

  source
    .connect(highpass)
    .connect(lowpass)
    .connect(lowShelf)
    .connect(mud)
    .connect(presence)
    .connect(air)
    .connect(comp)
    .connect(limiter)
    .connect(output)
    .connect(c.destination)

  const g: EnhanceGraph = { highpass, lowpass, lowShelf, mud, presence, air, comp, limiter, output }
  graphs.set(el, g)
  return g
}

/** Set every node to a transparent passthrough (used when enhancement is disabled but the element was
 *  already routed through the graph — we can't un-route a MediaElementAudioSourceNode). */
function flatten(g: EnhanceGraph): void {
  g.highpass.frequency.value = 10
  g.lowpass.frequency.value = 20000
  for (const eq of [g.lowShelf, g.mud, g.presence, g.air]) eq.gain.value = 0
  g.comp.threshold.value = 0
  g.comp.ratio.value = 1
  g.limiter.threshold.value = 0
  g.limiter.ratio.value = 1
  g.output.gain.value = 1
}

function applySettings(g: EnhanceGraph, s: AudioEnhanceSettings): void {
  g.highpass.frequency.value = s.highpassHz > 0 ? s.highpassHz : 10
  g.lowpass.frequency.value = s.lowpassHz > 0 ? s.lowpassHz : 20000
  g.lowShelf.gain.value = s.lowShelfDb
  g.mud.gain.value = s.mudDb
  g.presence.gain.value = s.presenceDb
  g.air.gain.value = s.airDb
  // Compressor.
  g.comp.threshold.value = Math.max(-100, Math.min(0, s.compThreshold))
  g.comp.ratio.value = Math.max(1, Math.min(20, s.compRatio))
  g.comp.attack.value = Math.max(0, s.compAttack / 1000)
  g.comp.release.value = Math.max(0, s.compRelease / 1000)
  g.comp.knee.value = 6
  // Brick-wall limiter (or transparent when off).
  if (s.limiter) {
    g.limiter.threshold.value = Math.max(-20, Math.min(0, s.limitDb))
    g.limiter.ratio.value = 20
    g.limiter.attack.value = 0.001
    g.limiter.release.value = 0.05
    g.limiter.knee.value = 0
  } else {
    g.limiter.threshold.value = 0
    g.limiter.ratio.value = 1
  }
  // Output: make-up + final trim. (True LUFS loudnorm is applied exactly on export.)
  g.output.gain.value = dbToLin(Math.max(0, s.compMakeupDb) + s.outputGainDb)
}

/** Route `el` through the enhance graph and apply `settings`. When settings are missing/disabled and the
 *  element was never enhanced, this is a no-op (raw playback). When it was enhanced before, the graph is
 *  flattened to transparent. Resumes the AudioContext (suspended until the first user gesture). */
export function applyAudioEnhance(el: HTMLMediaElement, settings: AudioEnhanceSettings | undefined): void {
  if (audioEnhanceIsIdentity(settings)) {
    const existing = graphs.get(el)
    if (existing) flatten(existing)
    return
  }
  const g = graphs.get(el) ?? build(el)
  const c = getCtx()
  if (c.state === 'suspended') void c.resume()
  applySettings(g, settings as AudioEnhanceSettings)
}
