// SPDX-License-Identifier: GPL-3.0-or-later
// Orchestrates "take detection" in the main process (it holds the API key). Pipeline:
//   deterministic micro-cut pass (transcriptClean) → serialize the transcript with explicit word
//   indices → window if long → ONE forced-tool Claude call per window (structured JSON, not the chat
//   loop) → stitch chunks → resolve word indices to exact source ms + validate.
// Generous token budget; latency (not cost) is the constraint on this task.

import { z } from 'zod'
import {
  type CleanCut,
  type TakesPlanInput,
  type WordMs,
  alignScriptToTranscript,
  detectTranscriptCleanCuts,
  extractSpokenWords,
  planWindows,
  resolveAndValidatePlan,
  serializeWindow,
  splitScriptBlocks,
  stitchTakePlans,
  takesPlanSchema
} from '@core'
import type { AnalyzeTakesRequest, AnalyzeTakesResult } from '../../shared/ipc'
import { complete } from './anthropic'

// Sonnet 5 omits `thinking` → runs adaptive by default (unlike Opus 4.8, where omitting = off).
// Forcing a single tool via tool_choice is compatible with that on the direct Claude API (only
// Bedrock requires `thinking: {type:'disabled'}` alongside a forced tool_choice) — no other change needed.
const ANALYZE_MODEL = 'claude-sonnet-5'
const TOOL_NAME = 'emitir_plan'

/** Aggressive deterministic floor: short silence threshold + repeats. The LLM does the context-aware
 *  aggressive filler/repeat cutting; the blunt detector stays on its default (safe) filler list to
 *  avoid false positives on meaningful words. */
const AGGRESSIVE_CLEAN = { maxGapMs: 350, gapPaddingMs: 60, minRepeatRun: 2 }

const ANALYZE_TAKES_SYSTEM = [
  'Sos un asistente de edición de video que analiza la TRANSCRIPCIÓN de un clip crudo en español.',
  'El clip contiene VARIOS "guiones" o tomas grabados de corrido en un mismo archivo. Tu trabajo:',
  '1) SEGMENTAR en tomas: detectá dónde EMPIEZA y TERMINA cada guion (cambio de tema, "arranco de nuevo",',
  '   "esto es para otro video", "listo, ahora otra cosa"). Por cada toma devolvé startWordIndex,',
  '   endWordIndex, un title corto y un summary de 1-2 frases, en español.',
  '2) DETECTAR CORTES a eliminar DENTRO de cada toma, de forma AGRESIVA (ritmo tipo redes sociales):',
  '   falsos inicios, repeticiones (quedate con la MEJOR versión, normalmente la última), muletillas',
  '   ("eh", "este", "o sea", "digamos", "tipo", "nada" y "bueno" cuando son relleno), trabas/tartamudeos',
  '   y silencios largos. Por cada corte devolvé startWordIndex, endWordIndex, kind',
  '   (falso-inicio | repeticion | silencio | muletilla) y un reason breve en español.',
  '',
  'REGLAS DE PRECISIÓN (obligatorias):',
  '- Referenciá SIEMPRE por índice #N tal como aparece en el texto (#0, #1, ...). NUNCA inventes',
  '  milisegundos: el sistema convierte los índices a tiempo exacto.',
  '- Los rangos son inclusivos: endWordIndex es la última palabra incluida.',
  '- Un corte SIEMPRE cae dentro de una sola toma; nunca cruces el borde entre dos tomas.',
  '- Revisá los CANDIDATOS mecánicos que te paso: confirmalos, reetiquetalos o descartalos, y agregá los que falten.',
  '- Recortá agresivo muletillas y pausas, pero NUNCA cortes a mitad de una idea válida ni elimines contenido con sentido.',
  '- Devolvé el resultado ÚNICAMENTE llamando a la herramienta emitir_plan (no escribas texto).'
].join('\n')

// Script-driven variant: the user pasted the actual guiones; the model aligns each one to its span.
const ANALYZE_TAKES_SYSTEM_SCRIPTS = [
  'Sos un asistente de edición de video. Tenés (a) la TRANSCRIPCIÓN de un clip crudo en español (varios',
  'guiones grabados de corrido) y (b) los GUIONES que el usuario grabó, pegados como texto (uno por bloque).',
  'Tu trabajo: para CADA guión, en el mismo orden en que aparece, ubicá en la transcripción el TRAMO donde',
  'ese guión fue dicho (la mejor/última versión completa) y devolvé UNA toma con startWordIndex y endWordIndex',
  '(inclusive), un title corto tomado del guión, un summary de 1-2 frases en español y scriptIndex = la',
  'posición 0-based del guión pegado al que corresponde la toma (el primer bloque es 0, el segundo 1, etc.).',
  'startWordIndex debe apuntar a la PRIMERA palabra del guión (incluí el saludo/intro; no arranques a mitad).',
  'Además, DENTRO de cada toma, marcá cortes a eliminar de forma AGRESIVA (falsos inicios, repeticiones —quedate',
  'con la mejor—, muletillas, trabas, silencios largos) con kind (falso-inicio | repeticion | silencio | muletilla)',
  'y un reason breve.',
  '',
  'REGLAS DE PRECISIÓN (obligatorias):',
  '- La transcripción es hablada: NO coincide palabra por palabra con el guión (hay titubeos, repeticiones,',
  '  muletillas, orden distinto). Alineá por CONTENIDO/significado, no por texto exacto.',
  '- Lo que quede ENTRE guiones (charla, coordinación entre personas, "esto es para otro video") NO pertenece a',
  '  ninguna toma: dejalo AFUERA (no lo incluyas en ningún span).',
  '- Devolvé una toma por guión, en orden. Si un guión no aparece en la transcripción, omitilo.',
  '- Referenciá SIEMPRE por índice #N tal como aparece en el texto. NUNCA inventes milisegundos.',
  '- endWordIndex es la última palabra incluida; un corte SIEMPRE cae dentro de una sola toma.',
  '- Revisá los CANDIDATOS mecánicos: confirmalos, reetiquetalos o descartalos, y agregá los que falten.',
  '- Devolvé el resultado ÚNICAMENTE llamando a la herramienta emitir_plan (no escribas texto).'
].join('\n')

/** The plan schema as an Anthropic tool (JSON Schema, `$schema` stripped like `anthropicTools()`). */
function forcedTool(): { name: string; description: string; input_schema: Record<string, unknown> } {
  const schema = z.toJSONSchema(takesPlanSchema) as Record<string, unknown>
  delete schema.$schema
  return { name: TOOL_NAME, description: 'Devuelve el plan de tomas y cortes detectados.', input_schema: schema }
}

/** Render the deterministic cuts (in ms) as word-index candidates within [start, end). */
function candidatesText(cuts: CleanCut[], wordIndexToMs: WordMs[], start: number, end: number): string {
  const lines: string[] = []
  for (const c of cuts) {
    if (c.kind === 'silencio') {
      let k = -1
      for (let i = start; i < end; i++) if (wordIndexToMs[i].endMs <= c.startMs) k = i
      if (k >= 0) lines.push(`- silencio (pausa tras #${k})`)
      continue
    }
    const idxs: number[] = []
    for (let i = start; i < end; i++) {
      const w = wordIndexToMs[i]
      if (w.startMs < c.endMs && c.startMs < w.endMs) idxs.push(i)
    }
    if (idxs.length) lines.push(`- ${c.kind} #${idxs[0]}–#${idxs[idxs.length - 1]} "${c.text}"`)
  }
  return lines.length ? `CANDIDATOS (detección mecánica; confirmá/reetiquetá/agregá):\n${lines.join('\n')}` : ''
}

/** Map a resolved take's [startMs, endMs] back to a spoken-word index span, to scope script alignment. */
function msSpanToWordHint(startMs: number, endMs: number, wordIndexToMs: WordMs[]): { startIndex: number; endIndex: number } {
  let startIndex = wordIndexToMs.findIndex((w) => w.endMs > startMs)
  if (startIndex < 0) startIndex = 0
  let endIndex = startIndex
  for (let i = 0; i < wordIndexToMs.length; i++) if (wordIndexToMs[i].startMs < endMs) endIndex = i
  return { startIndex, endIndex }
}

export async function analyzeTakes(
  req: AnalyzeTakesRequest,
  onProgress?: (line: string) => void
): Promise<AnalyzeTakesResult> {
  try {
    const { W, wordIndexToMs } = extractSpokenWords(req.words)
    if (W.length === 0) return { ok: false, error: 'La transcripción no tiene palabras para analizar.' }
    // A cached transcript from a broken parse has NaN times: the LLM would segment fine (it only sees
    // indices) but every resolved span would be NaN. Fail here, before spending the model call.
    if (wordIndexToMs.some((w) => !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs))) {
      return { ok: false, error: 'La transcripción no tiene timestamps válidos. Volvé a transcribir el clip.' }
    }

    // Cuts are opt-in: when off, bring each guión's whole fragment uncut (repeats and all). Skip the
    // deterministic detector entirely and strip any LLM cuts below.
    const cleanCuts = req.cleanCuts ?? false
    const det = cleanCuts ? detectTranscriptCleanCuts(req.words, AGGRESSIVE_CLEAN) : []
    const windows = planWindows(W)
    const tool = forcedTool()
    const chunks: TakesPlanInput[] = []

    // Script-driven when the user pasted guiones; otherwise infer take boundaries.
    const scripts = req.scripts?.trim()
    const system = scripts ? ANALYZE_TAKES_SYSTEM_SCRIPTS : ANALYZE_TAKES_SYSTEM
    const scriptsSection = scripts ? `GUIONES (pegados por el usuario, en orden):\n${scripts}\n\n` : ''

    for (let wi = 0; wi < windows.length; wi++) {
      const { startIndex, endIndex } = windows[wi]
      onProgress?.(`Analizando tomas (${wi + 1}/${windows.length})…`)
      const prefix =
        windows.length > 1
          ? `Esta es la ventana de palabras #${startIndex} a #${endIndex - 1} de una transcripción más larga. ` +
            'Si una toma sigue más allá del final de la ventana, marcala con openEnded:true y no adivines su fin.\n\n'
          : ''
      const body = serializeWindow(W, startIndex, endIndex)
      const cand = candidatesText(det, wordIndexToMs, startIndex, endIndex)
      const userText = `${prefix}${scriptsSection}TRANSCRIPCIÓN (índices de palabra):\n${body}${cand ? `\n\n${cand}` : ''}`

      const res = await complete({
        system,
        messages: [{ role: 'user', content: userText }],
        tools: [tool],
        toolChoice: { type: 'tool', name: TOOL_NAME },
        model: ANALYZE_MODEL,
        maxTokens: 8192
      })
      if (!res.ok) return { ok: false, error: res.error ?? 'La llamada al modelo falló.' }
      const blocks = (res.content ?? []) as Array<{ type?: string; name?: string; input?: unknown }>
      const block = blocks.find((b) => b?.type === 'tool_use' && b?.name === TOOL_NAME)
      if (!block) return { ok: false, error: 'El modelo no devolvió un plan estructurado.' }
      const parsed = takesPlanSchema.safeParse(block.input)
      if (!parsed.success) return { ok: false, error: 'El plan del modelo no pasó la validación.' }
      chunks.push(parsed.data)
    }

    const merged = stitchTakePlans(chunks)
    const plan = resolveAndValidatePlan(merged, wordIndexToMs, W, { deterministicCuts: det })
    if (plan.takes.length === 0) return { ok: false, error: 'No se detectaron tomas en la transcripción.' }
    // Cuts off → discard any the model volunteered, so each take keeps its full recorded fragment.
    if (!cleanCuts) plan.cuts = []

    // Script-driven mode: deterministically verify each take against its pasted guión — measure coverage
    // and, when the opening tokens anchor confidently, snap the start to the guión's real first word so a
    // take can't begin mid-intro. Only touches metadata + startMs; leaves inference-mode plans untouched.
    if (scripts) {
      const blocks = splitScriptBlocks(scripts)
      for (const take of plan.takes) {
        let si = take.scriptIndex
        if (si == null && blocks.length === 1 && plan.takes.length === 1) si = 0
        if (si == null || si < 0 || si >= blocks.length) continue
        const al = alignScriptToTranscript(blocks[si], W, wordIndexToMs, msSpanToWordHint(take.startMs, take.endMs, wordIndexToMs))
        take.scriptIndex = si
        take.coverage = { matched: al.matchedCount, total: al.totalCount, fraction: al.coverage }
        if (al.confident && al.matchedCount > 0) {
          take.startMs = wordIndexToMs[al.trueStartWordIndex].startMs
          take.startCorrected = al.startCorrected
        }
      }
    }
    return { ok: true, plan }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
