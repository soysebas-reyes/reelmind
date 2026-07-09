// SPDX-License-Identifier: GPL-3.0-or-later
// Schema + types for "take detection": an LLM segments a raw clip's transcript into distinct takes
// (guiones grabados de corrido) and marks the spans to cut (false starts, repeats, stutters, fillers,
// silences). The model speaks in WORD INDICES only — never milliseconds. Post-processing resolves those
// indices to exact source ms from the transcript (see takesPostprocess.ts), so the model can't hallucinate
// timestamps. The forced-tool call (main/ai/analyzeTakes.ts) uses `takesPlanSchema` as the tool input.

import { z } from 'zod'

/** Kinds of span we mark for removal. Identical to transcriptClean's `CleanCutKind`. */
export const CUT_KINDS = ['falso-inicio', 'repeticion', 'silencio', 'muletilla'] as const
export type CutKind = (typeof CUT_KINDS)[number]

// NOTE: string fields are intentionally unconstrained (no min/max length). We validate the model's
// output with `safeParse`, so a hard length cap here would reject an otherwise-good plan over a trivial
// overage. Brevity ("title corto", "summary de 1-2 frases") is guided by the prompt instead. Structural
// checks that matter — integer indices and the cut-kind enum — are kept.

/** One take, referenced by the first/last spoken-word index (half-open range is resolved to ms later). */
export const takeInputSchema = z.object({
  startWordIndex: z.number().int().nonnegative(),
  endWordIndex: z.number().int().nonnegative(),
  title: z.string(),
  summary: z.string(),
  /** Set when the take runs past the end of a windowed chunk (its end is unknown here). */
  openEnded: z.boolean().optional(),
  /** Script-driven mode only: 0-based index of the pasted guión this take corresponds to. Lets the
   *  renderer pair each take with its script for coverage verification (indices survive the ms sort). */
  scriptIndex: z.number().int().nonnegative().optional()
})

/** One span to cut, referenced by spoken-word index. */
export const cutInputSchema = z.object({
  startWordIndex: z.number().int().nonnegative(),
  endWordIndex: z.number().int().nonnegative(),
  kind: z.enum(CUT_KINDS),
  reason: z.string(),
  text: z.string().optional()
})

/** The whole plan the model must emit via the forced `emitir_plan` tool. */
export const takesPlanSchema = z.object({
  takes: z.array(takeInputSchema),
  cuts: z.array(cutInputSchema)
})

export type TakeInput = z.infer<typeof takeInputSchema>
export type CutInput = z.infer<typeof cutInputSchema>
export type TakesPlanInput = z.infer<typeof takesPlanSchema>

/** Where a resolved cut came from after the deterministic ∪ LLM union. */
export type CutSource = 'deterministic' | 'llm' | 'both'

/** How much of a pasted guión was found, in order, in the transcript span. */
export interface TakeCoverage {
  matched: number
  total: number
  /** matched / total, 0..1. */
  fraction: number
}

/** A resolved take: absolute SOURCE-time span (ms) + label. `index` is the 1-based START-SORTED position
 *  and is the JOIN KEY cuts reference via `PlannedCut.takeIndex` — do NOT reuse it for display numbering. */
export interface PlannedTake {
  index: number
  startMs: number
  endMs: number
  title: string
  summary: string
  /** Script-driven mode: which pasted guión (0-based) this take matched. */
  scriptIndex?: number
  /** Script-driven display number = `scriptIndex + 1` (the guión the user pasted). The UI shows
   *  `guionNumber ?? index` so "Guión 4" is always the 4th pasted script, independent of resolve order.
   *  Undefined in inference mode (no scripts). */
  guionNumber?: number
  /** Script-driven mode: coverage of that guión against the transcript (for the verification UI). */
  coverage?: TakeCoverage
  /** True when the deterministic aligner moved the start earlier to recover a skipped intro. */
  startCorrected?: boolean
  /** True when this take was NOT returned by the model but recovered by deterministic alignment (or is a
   *  low-confidence "no encontrado" placeholder for a guión the model omitted). Drives the review badge. */
  reconstructed?: boolean
  /** True once the user manually adjusted this take's bounds in the editable preview. Invalidates the
   *  script coverage/`startCorrected` provenance (both were computed for the AI's original span). */
  edited?: boolean
}

/** A resolved cut: absolute SOURCE-time span (ms), the take it belongs to, and provenance. */
export interface PlannedCut {
  startMs: number
  endMs: number
  kind: CutKind
  reason: string
  text: string
  takeIndex: number
  source: CutSource
}

/** The validated, ms-based plan the renderer/UI consumes. */
export interface TakesPlanResult {
  takes: PlannedTake[]
  cuts: PlannedCut[]
  /** End of the last spoken word (ms) — the effective transcript length. */
  durationMs: number
}
