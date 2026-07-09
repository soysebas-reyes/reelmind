// SPDX-License-Identifier: GPL-3.0-or-later
// Telemetry TAXONOMY — the single source of truth of named, measurable actions.
// This is the BUILD-TIME guardrail (see taxonomy.test.ts): a new MCP tool or a new
// EditorController command literal that is not registered here fails `npm test`.
// It is NOT a runtime whitelist (see event.ts) — auto-captured events (e.g. io.<action>)
// stay valid without an entry so the "always-valid" doctrine holds.

import type { TelemetryCategory } from './event'

export interface TaxonomyEntry {
  /** Stable dotted id = the event.name. */
  id: string
  category: TelemetryCategory
  /** Human description (Spanish) — what this measures. */
  description: string
  /** For 'tool': the tool name. For 'command': the EditorController display label (exact) or a prefix. */
  source?: string
  /** True when `source` is a prefix that matches a parametric/dynamic label. */
  dynamic?: boolean
}

// ── Tools ─────────────────────────────────────────────────────────────────────────────────
// Hand-authored, kept in lockstep with `editorTools` (src/core/ai/tools.ts) by taxonomy.test.ts.
// If you add/remove an MCP/agent tool, update this list or the build fails.
export const TOOL_NAMES: readonly string[] = [
  'get_timeline', 'inspect_clip', 'add_track', 'remove_track', 'set_track_flag', 'add_clip', 'move_clip',
  'trim_clip', 'split_clip', 'remove_clips', 'ripple_delete', 'close_gaps', 'set_clip_speed',
  'set_clip_properties', 'set_clips_properties', 'set_clip_color', 'list_color_presets', 'apply_color_preset',
  'seek', 'set_resolution', 'set_fps', 'import_media', 'import_folder', 'export', 'remove_silences',
  'extract_audio', 'sync_angles', 'apply_auto_angles', 'set_keyframe', 'remove_keyframe', 'get_keyframes',
  'ripple_delete_range', 'add_text_clip', 'batch_operations', 'list_assets', 'get_frame_preview', 'undo',
  'redo', 'transcribe_clip', 'get_transcript', 'cut_to_angle', 'set_track_role', 'segment_by_scripts',
  'export_to_nle', 'new_project', 'open_project', 'save_project'
]

// ── Commands ──────────────────────────────────────────────────────────────────────────────
// EditorController display label → stable telemetry id. The 33 controller labels plus a curated
// set of notable store/renderer labels. taxonomy.test.ts source-scans EditorController.ts and
// requires every DIRECT `this.run('…')`/`this.transact('…')` literal to appear here.
const STATIC_COMMANDS: Readonly<Record<string, string>> = {
  // Project / tracks
  'Set Resolution': 'command.set_resolution',
  'Set FPS': 'command.set_fps',
  'Project Settings': 'command.project_settings',
  'Add Track': 'command.add_track',
  'Remove Track': 'command.remove_track',
  'Mute Track': 'command.mute_track',
  'Hide Track': 'command.hide_track',
  'Sync Lock Track': 'command.sync_lock_track',
  'Set Track Role': 'command.set_track_role',
  // Add / insert / move
  'Add Clip': 'command.add_clip',
  'Clear Region': 'command.clear_region',
  'Ripple Insert': 'command.ripple_insert',
  'Pegar': 'command.paste',
  'Duplicar': 'command.duplicate',
  'Move Clip': 'command.move_clip',
  'Move Clips': 'command.move_clips',
  // Trim / split / remove
  'Trim Clip': 'command.trim_clip',
  'Align Clip': 'command.align_clip',
  'Replace Media': 'command.replace_media',
  'Split Clip': 'command.split_clip',
  'Cortar en el playhead': 'command.razor',
  'Remove Clip': 'command.remove_clip',
  'Remove Clips': 'command.remove_clips',
  'Ripple Delete': 'command.ripple_delete',
  'Cerrar huecos': 'command.close_gaps',
  'Eliminar rango': 'command.ripple_delete_range',
  // Properties / color / audio / keyframes
  'Change Speed': 'command.change_speed',
  'Change Clip Property': 'command.change_clip_property',
  'Change Color': 'command.change_color',
  'Realzar audio': 'command.audio_enhance',
  'Keyframe': 'command.keyframe',
  'Quitar keyframe': 'command.remove_keyframe',
  'Quitar keyframes': 'command.clear_keyframes',
  // Notable store/renderer labels (best-effort readable ids; not required by the source-scan)
  'Cortar': 'command.cut_selection',
  'Añadir texto': 'command.add_text',
  'Remove silences': 'command.remove_silences',
  'Sincronizar ángulos': 'command.sync_angles',
  'Auto Ángulos (multicam)': 'command.auto_angles',
  'Silenciar ángulo': 'command.mute_angle',
  'Agrupar ángulos': 'command.group_angles',
  'Aislar voz (IA)': 'command.isolate_voice',
  'Transformar': 'command.transform',
  'Color grade': 'command.color_grade',
  'Aplicar look a todo el video': 'command.apply_look_all'
}

// Parametric labels built with template strings elsewhere (tools.ts, ClipInspector, …).
const DYNAMIC_COMMANDS: readonly { prefix: string; id: string }[] = [
  { prefix: 'Color:', id: 'command.color_preset' },
  { prefix: 'Batch (', id: 'command.batch' },
  { prefix: 'Editar propiedades', id: 'command.edit_properties' },
  { prefix: 'Cut to ', id: 'command.cut_to_angle' }
]

/** Fallback id for any command label not catalogued above — measured, but generic. */
export const COMMAND_OTHER = 'command.other'

/** All display labels catalogued as exact matches (used by the source-scan guardrail). */
export const MEASURED_COMMAND_LABELS: ReadonlySet<string> = new Set(Object.keys(STATIC_COMMANDS))

/**
 * Map an EditorController display label to a stable telemetry id.
 * Exact match → its id; known prefix → dynamic id; otherwise `command.other` (never unmeasured).
 */
export function normalizeCommandLabel(label: string): string {
  const exact = STATIC_COMMANDS[label]
  if (exact) return exact
  for (const d of DYNAMIC_COMMANDS) if (label.startsWith(d.prefix)) return d.id
  return COMMAND_OTHER
}

// ── Fixed lifecycle / physical / error events ───────────────────────────────────────────────
const FIXED_ENTRIES: readonly TaxonomyEntry[] = [
  { id: 'session.start', category: 'session', description: 'Arranque de la app (una vez por lanzamiento)' },
  { id: 'session.heartbeat', category: 'session', description: 'Latido periódico con tiempo activo/inactivo/total' },
  { id: 'session.idle', category: 'session', description: 'El usuario pasó a inactivo (sin interacción)' },
  { id: 'session.resume', category: 'session', description: 'Primera interacción tras estar inactivo' },
  { id: 'session.visibility', category: 'session', description: 'Cambio de visibilidad/foco de la ventana' },
  { id: 'session.end', category: 'session', description: 'Cierre de la sesión (pagehide/quit)' },
  { id: 'physical.click', category: 'physical', description: 'Clic/contextmenu: coordenadas normalizadas + panel/objetivo' },
  { id: 'physical.pointer', category: 'physical', description: 'Muestra de movimiento del puntero (muestreada)' },
  { id: 'physical.key', category: 'physical', description: 'Tecla de atajo o bucket de tecleo (nunca el texto)' },
  { id: 'physical.wheel', category: 'physical', description: 'Rueda/scroll (throttled): panel + signo' },
  { id: 'physical.dwell', category: 'physical', description: 'Tiempo de permanencia en un panel' },
  { id: 'error.exception', category: 'error', description: 'Error no controlado capturado en el renderer (categoría, nunca contenido)' },
  { id: 'io.sync_offset', category: 'io', description: 'Reconciliación del offset multicám (RMS vs transcript): método elegido, razón y confiabilidad — nunca contenido' },
  { id: 'io.take_align_fix', category: 'io', description: 'Corrección post-build de la co-alineación de clips vinculados en una pestaña de toma' },
  { id: 'io.clean_cuts', category: 'io', description: 'Resumen de cortes limpios al segmentar: conteos por tipo/fuente y ms totales cortados — solo comportamiento, nunca texto/paths' }
]

// ── Assembled taxonomy ──────────────────────────────────────────────────────────────────────
export const TAXONOMY: readonly TaxonomyEntry[] = [
  ...FIXED_ENTRIES,
  ...TOOL_NAMES.map(
    (n): TaxonomyEntry => ({ id: `tool.${n}`, category: 'tool', description: `Tool IA/MCP: ${n}`, source: n })
  ),
  ...Object.entries(STATIC_COMMANDS).map(
    ([label, id]): TaxonomyEntry => ({ id, category: 'command', description: `Comando: ${label}`, source: label })
  ),
  ...DYNAMIC_COMMANDS.map(
    (d): TaxonomyEntry => ({
      id: d.id,
      category: 'command',
      description: `Comando dinámico: «${d.prefix}…»`,
      source: d.prefix,
      dynamic: true
    })
  ),
  { id: COMMAND_OTHER, category: 'command', description: 'Comando con etiqueta libre no catalogada' }
]

/** Every registered event id (used by the guardrail test and dev tooling). */
export const TAXONOMY_IDS: ReadonlySet<string> = new Set(TAXONOMY.map((e) => e.id))

/** Registered tool event ids, e.g. 'tool.split_clip'. */
export const TOOL_EVENT_IDS: ReadonlySet<string> = new Set(TOOL_NAMES.map((n) => `tool.${n}`))
