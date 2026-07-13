// Smoke test del flujo completo por MCP (con la app Reelo abierta):
//   importar carpeta → sincronizar ángulos → colorizar → segmentar por guiones → exportar a NLE.
// Uso: node mcp_flow.mjs "<carpeta-crudos>" "<carpeta-salida>"
// Los guiones se pegan en la constante SCRIPTS de abajo (o dejalos vacíos para auto-detección).
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const [, , FOLDER, OUT_DIR] = process.argv
const SCRIPTS = `` // pegá acá tus guiones (un bloque por guión), o dejalo vacío.

if (!FOLDER || !OUT_DIR) {
  console.error('Uso: node mcp_flow.mjs "<carpeta-crudos>" "<carpeta-salida>"')
  process.exit(1)
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args })
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}'
  const parsed = JSON.parse(text)
  if (res.isError) throw new Error(`${name}: ${parsed.error ?? text}`)
  return parsed
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4399/mcp'))
  const client = new Client({ name: 'reelo-flow', version: '1.0' }, { capabilities: {} })
  await client.connect(transport)
  console.log('Conectado al MCP de Reelo.')

  console.log(`1) Importando carpeta: ${FOLDER}`)
  const imported = await call(client, 'import_folder', { folderPath: FOLDER })
  const assets = imported.assets ?? []
  console.log(`   ${assets.length} assets importados.`)

  const tl = await call(client, 'get_timeline')
  const fps = tl.fps

  // Coloca los dos primeros clips en dos pistas para poder sincronizar.
  if (assets.length >= 2) {
    const [a, b] = assets
    const t1 = (await call(client, 'add_track', { type: 'video' })).trackId
    const t2 = (await call(client, 'add_track', { type: 'video' })).trackId
    const c1 = (await call(client, 'add_clip', { trackId: t1, mediaRef: a.assetId, startFrame: 0, durationFrames: Math.round(a.durationSeconds * fps) })).clipId
    const c2 = (await call(client, 'add_clip', { trackId: t2, mediaRef: b.assetId, startFrame: 0, durationFrames: Math.round(b.durationSeconds * fps) })).clipId
    console.log('2) Sincronizando ángulos por audio…')
    const sync = await call(client, 'sync_angles', { clipIds: [c1, c2], keepAudioOf: 'first', autoColor: true })
    console.log(`   offset ${sync.offsetSeconds}s (confianza ${sync.confidence}).`)
  } else {
    console.log('2) (menos de 2 clips: salto la sincronización)')
  }

  console.log('3) Segmentando por guiones…')
  const seg = await call(client, 'segment_by_scripts', { scripts: SCRIPTS || undefined, cleanCuts: false, apply: true })
  console.log(`   ${seg.takes} tomas · ${seg.cuts} cortes · aplicado=${seg.applied}`)

  console.log(`4) Exportando a editor en: ${OUT_DIR}`)
  const out = await call(client, 'export_to_nle', { outDir: OUT_DIR, target: 'premiere' })
  console.log(`   Listo → ${out.folder}`)
  console.log(`   ${out.clipItemCount} clips · ${out.bakedCount} horneados · ${out.referencedCount} referenciados`)
  if (out.warnings?.length) console.log('   Avisos:', out.warnings)

  process.exit(0)
}

main().catch((e) => {
  console.error('Fallo el flujo:', e.message)
  process.exit(1)
})
