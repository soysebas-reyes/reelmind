// SPDX-License-Identifier: GPL-3.0-or-later
// THE GUARDRAIL. This test makes instrumentation obligatory: if you add an MCP/agent tool or a
// new EditorController command literal without registering it in taxonomy.ts, `npm test` fails.
// See docs/TOTAL_MEASUREMENT_PLAN.md and CLAUDE.md (definition of done).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { editorTools } from '../ai/tools'
import {
  COMMAND_OTHER,
  MEASURED_COMMAND_LABELS,
  normalizeCommandLabel,
  TAXONOMY,
  TAXONOMY_IDS,
  TOOL_EVENT_IDS,
  TOOL_NAMES
} from './taxonomy'

describe('telemetry taxonomy integrity', () => {
  it('has unique ids', () => {
    const ids = TAXONOMY.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry has a valid category and a non-empty description', () => {
    const categories = new Set(['session', 'physical', 'command', 'tool', 'io', 'error', 'perf'])
    for (const e of TAXONOMY) {
      expect(categories.has(e.category), `bad category on ${e.id}`).toBe(true)
      expect(e.description.trim().length, `empty description on ${e.id}`).toBeGreaterThan(0)
    }
  })

  it('is JSON-serializable', () => {
    expect(() => JSON.stringify(TAXONOMY)).not.toThrow()
  })
})

describe('telemetry guardrail — TOOLS must be a bijection with editorTools', () => {
  const toolNames = editorTools.map((t) => t.name)

  it('every editorTools tool is registered in the taxonomy', () => {
    const registered = new Set(TOOL_NAMES)
    for (const name of toolNames) {
      expect(
        registered.has(name),
        `Tool "${name}" is not in the telemetry taxonomy.\n` +
          `Add "${name}" to TOOL_NAMES in src/core/telemetry/taxonomy.ts.`
      ).toBe(true)
    }
  })

  it('has no stale tool entries (taxonomy tool not in editorTools)', () => {
    const live = new Set(toolNames)
    for (const name of TOOL_NAMES) {
      expect(live.has(name), `Stale telemetry tool "${name}" — no such editorTools tool.`).toBe(true)
    }
  })

  it('exposes a tool event id per tool', () => {
    for (const name of toolNames) expect(TOOL_EVENT_IDS.has(`tool.${name}`)).toBe(true)
  })
})

describe('telemetry guardrail — EditorController command coverage (source-scan)', () => {
  const controllerSrc = readFileSync(
    fileURLToPath(new URL('../controller/EditorController.ts', import.meta.url)),
    'utf8'
  )
  // Direct string literals passed to this.run('…') / this.transact('…'). Variable/ternary/default
  // labels are intentionally not scanned; they are captured at runtime and fall back to command.other.
  const literals = Array.from(controllerSrc.matchAll(/this\.(?:run|transact)\(\s*'([^']+)'/g)).map((m) => m[1])

  it('finds the known command literals (scan sanity check)', () => {
    expect(literals).toContain('Split Clip')
    expect(literals.length).toBeGreaterThanOrEqual(15)
  })

  it('every EditorController command literal is registered', () => {
    for (const label of literals) {
      expect(
        MEASURED_COMMAND_LABELS.has(label),
        `EditorController command "${label}" has no telemetry taxonomy entry.\n` +
          `Add it to STATIC_COMMANDS in src/core/telemetry/taxonomy.ts, e.g.\n` +
          `  '${label}': 'command.<snake_case_id>',`
      ).toBe(true)
    }
  })
})

describe('normalizeCommandLabel', () => {
  it('maps exact labels to their stable id', () => {
    expect(normalizeCommandLabel('Split Clip')).toBe('command.split_clip')
    expect(normalizeCommandLabel('Move Clips')).toBe('command.move_clips')
    expect(normalizeCommandLabel('Realzar audio')).toBe('command.audio_enhance')
  })

  it('maps parametric labels by prefix', () => {
    expect(normalizeCommandLabel('Color: DaVinci')).toBe('command.color_preset')
    expect(normalizeCommandLabel('Batch (5 ops)')).toBe('command.batch')
    expect(normalizeCommandLabel('Editar propiedades (3 clips)')).toBe('command.edit_properties')
    expect(normalizeCommandLabel('Cut to lateral (1s–2s)')).toBe('command.cut_to_angle')
  })

  it('falls back to command.other for unknown labels (never unmeasured)', () => {
    expect(normalizeCommandLabel('Alguna etiqueta nueva')).toBe(COMMAND_OTHER)
  })

  it('always returns a registered taxonomy id', () => {
    for (const label of [...MEASURED_COMMAND_LABELS, 'Color: X', 'Batch (2 ops)', 'desconocida']) {
      expect(TAXONOMY_IDS.has(normalizeCommandLabel(label))).toBe(true)
    }
  })
})
