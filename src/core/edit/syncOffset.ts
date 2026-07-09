// SPDX-License-Identifier: GPL-3.0-or-later
// Multicam sync-offset reconciliation (pure, no IO). Two independent estimators can measure the
// inter-camera offset: RMS envelope cross-correlation (audioSync.ts) and transcript word alignment
// (transcriptAlign.ts). Each can fail in its own way — RMS on low/ambiguous audio, the transcript
// aligner on repeated-script takes or a poisoned/duplicated transcript (the historical "offset 0 with
// high confidence" bug). Reconciling BOTH before baking anything into the timeline is the defense:
// a reliable RMS peak refutes a disagreeing transcript instead of silently losing to it.
// Also home of `findUnsyncedAnglePair`, the conservative scan used to auto-sync before segmenting.

import { type Timeline, clipEndFrame } from '../model/timeline'

/** RMS cross-correlation candidate (from `media:computeAudioOffset`). */
export interface RmsCandidate {
  /** B (lateral) relative to A (frontal); positive ⇒ lateral started later. */
  offsetSeconds: number
  confidence: number
  margin: number
  /** Confidence + margin both clear the warn thresholds (computed main-side). */
  reliable: boolean
}

/** Transcript word-alignment candidate (from `alignByTranscript`). */
export interface TranscriptCandidate {
  /** Same sign convention as RmsCandidate. */
  offsetSeconds: number
  confidence: number
  matched: number
}

export type SyncReconcileReason =
  | 'rms-only'
  | 'transcript-only'
  | 'agreement'
  | 'transcript-refuted'
  | 'disagreement-weak-rms'
  | 'both-weak'

export interface ReconciledSyncOffset {
  offsetSeconds: number
  /** Same union as the sync UI's method field. */
  method: 'transcript' | 'audio'
  confidence: number
  /** Whether the chosen offset is trustworthy enough to apply without a human looking at it. */
  reliable: boolean
  reason: SyncReconcileReason
  /** True when a reliable RMS peak contradicted (and overrode) the transcript offset. */
  transcriptRefuted: boolean
  /** |transcript − rms| in seconds, when both candidates existed. */
  deltaSeconds?: number
}

/** Two estimates within this window are "the same offset" (transcript then refines the RMS peak). */
export const SYNC_AGREE_TOLERANCE_SECONDS = 0.4
/** Gate for a transcript result to be considered at all (the pre-existing acceptance thresholds). */
export const TRANSCRIPT_MIN_CONFIDENCE = 0.2
export const TRANSCRIPT_MIN_MATCHED = 5
/** A transcript alone (no corroborating RMS) is reliable only above these. */
export const TRANSCRIPT_SOLO_RELIABLE_CONFIDENCE = 0.5
export const TRANSCRIPT_SOLO_RELIABLE_MATCHED = 12
/** When both estimators are weak and disagree, a transcript at/above this still wins the tiebreak. */
export const TRANSCRIPT_STRONG_CONFIDENCE = 0.35

export interface ReconcileOptions {
  agreeToleranceSeconds?: number
}

/**
 * Pick ONE offset from the two independent estimates. Never throws and never aborts on low
 * confidence — it always returns the best candidate with an honest `reliable` flag (or null when
 * there is nothing at all); applying an unreliable offset is the CALLER's policy decision.
 */
export function reconcileSyncOffset(
  rms: RmsCandidate | null,
  transcript: TranscriptCandidate | null,
  opts: ReconcileOptions = {}
): ReconciledSyncOffset | null {
  const tolerance = opts.agreeToleranceSeconds ?? SYNC_AGREE_TOLERANCE_SECONDS
  const usableTranscript =
    transcript && transcript.confidence >= TRANSCRIPT_MIN_CONFIDENCE && transcript.matched >= TRANSCRIPT_MIN_MATCHED
      ? transcript
      : null

  if (!rms && !usableTranscript) return null

  if (rms && !usableTranscript) {
    return {
      offsetSeconds: rms.offsetSeconds,
      method: 'audio',
      confidence: rms.confidence,
      reliable: rms.reliable,
      reason: 'rms-only',
      transcriptRefuted: false
    }
  }

  if (!rms && usableTranscript) {
    return {
      offsetSeconds: usableTranscript.offsetSeconds,
      method: 'transcript',
      confidence: usableTranscript.confidence,
      reliable:
        usableTranscript.confidence >= TRANSCRIPT_SOLO_RELIABLE_CONFIDENCE &&
        usableTranscript.matched >= TRANSCRIPT_SOLO_RELIABLE_MATCHED,
      reason: 'transcript-only',
      transcriptRefuted: false
    }
  }

  // Both present from here on.
  const r = rms as RmsCandidate
  const t = usableTranscript as TranscriptCandidate
  const deltaSeconds = Math.abs(t.offsetSeconds - r.offsetSeconds)

  if (deltaSeconds <= tolerance) {
    // Two independent methods landing on the same offset is stronger evidence than either alone.
    return {
      offsetSeconds: t.offsetSeconds, // word timestamps are the finer landmark — refine with them
      method: 'transcript',
      confidence: Math.max(t.confidence, r.confidence),
      reliable: true,
      reason: 'agreement',
      transcriptRefuted: false,
      deltaSeconds
    }
  }

  if (r.reliable) {
    // A sharp, unambiguous correlation peak contradicts the transcript ⇒ the transcript lied
    // (duplicated/poisoned transcript or repeated-take word collisions). RMS wins.
    return {
      offsetSeconds: r.offsetSeconds,
      method: 'audio',
      confidence: r.confidence,
      reliable: true,
      reason: 'transcript-refuted',
      transcriptRefuted: true,
      deltaSeconds
    }
  }

  if (t.confidence >= TRANSCRIPT_STRONG_CONFIDENCE) {
    // RMS is weak and the transcript is decent — prefer it, but the disagreement is a yellow flag.
    return {
      offsetSeconds: t.offsetSeconds,
      method: 'transcript',
      confidence: t.confidence,
      reliable: false,
      reason: 'disagreement-weak-rms',
      transcriptRefuted: false,
      deltaSeconds
    }
  }

  return {
    offsetSeconds: r.offsetSeconds,
    method: 'audio',
    confidence: r.confidence,
    reliable: false,
    reason: 'both-weak',
    transcriptRefuted: false,
    deltaSeconds
  }
}

/** Result of scanning a timeline for the unambiguous "two raw angles, not yet synced" state. */
export type AnglePairScan =
  | { kind: 'pair'; frontalClipId: string; lateralClipId: string }
  | { kind: 'synced' }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string }

/**
 * Detect the ONE state where auto-sync is safe: exactly two video clips, on two different video
 * tracks, overlapping in timeline time, with no shared `linkGroupId` (a shared group id is the only
 * proof `applySyncAngles` already ran — track roles can go stale, so they are ignored here).
 * `frontalClipId` is the clip on the UPPER video track (lower index), matching where
 * `applySyncAngles` places the frontal. Anything else → `ambiguous` (caller warns, never guesses).
 */
export function findUnsyncedAnglePair(tl: Timeline): AnglePairScan {
  const found: { clipId: string; trackIndex: number; startFrame: number; endFrame: number; linkGroupId?: string }[] = []
  tl.tracks.forEach((track, trackIndex) => {
    if (track.type !== 'video') return
    for (const clip of track.clips) {
      if (clip.mediaType !== 'video') continue
      found.push({
        clipId: clip.id,
        trackIndex,
        startFrame: clip.startFrame,
        endFrame: clipEndFrame(clip),
        linkGroupId: clip.linkGroupId
      })
    }
  })

  if (found.length <= 1) return { kind: 'none' }
  if (found.length > 2) return { kind: 'ambiguous', reason: 'más de 2 clips de video' }

  const [a, b] = found
  if (a.linkGroupId && a.linkGroupId === b.linkGroupId) return { kind: 'synced' }
  if (a.trackIndex === b.trackIndex) return { kind: 'ambiguous', reason: 'ambos clips en la misma pista' }
  if (a.linkGroupId || b.linkGroupId) return { kind: 'ambiguous', reason: 'agrupación de clips no estándar' }
  const overlap = Math.min(a.endFrame, b.endFrame) - Math.max(a.startFrame, b.startFrame)
  if (overlap <= 0) return { kind: 'ambiguous', reason: 'los clips no se solapan en el tiempo' }

  const [upper, lower] = a.trackIndex < b.trackIndex ? [a, b] : [b, a]
  return { kind: 'pair', frontalClipId: upper.clipId, lateralClipId: lower.clipId }
}
