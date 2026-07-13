# Reelo + Claude Code (MCP)

Reelo expone su editor por **MCP** (Model Context Protocol) para que puedas manejarlo en
lenguaje natural desde **Claude Code** u otro cliente MCP: cargar una carpeta, descargar videos,
sincronizar ángulos, colorizar, segmentar por guiones y exportar a tu editor (Premiere / DaVinci /
Final Cut / CapCut).

## Conectar Claude Code

1. Abrí Reelo (el servidor MCP arranca solo con la app y queda escuchando en
   `http://127.0.0.1:4399/mcp`). Al iniciar, la consola imprime:
   `[reelo] MCP server listening at http://127.0.0.1:4399/mcp`.
2. Registrá el servidor en Claude Code (transporte HTTP):

   ```sh
   claude mcp add --transport http reelo http://127.0.0.1:4399/mcp
   ```

3. Listo. En Claude Code, verificá con `/mcp` que aparezca `reelo` conectado.

**Config manual** (equivalente, en `.mcp.json` / config del cliente):

```json
{
  "mcpServers": {
    "reelo": { "type": "http", "url": "http://127.0.0.1:4399/mcp" }
  }
}
```

### Variables de entorno

- `REELO_MCP_PORT` — cambia el puerto (default `4399`).
- `REELO_NO_MCP` — deshabilita el servidor MCP.
- `REELO_YTDLP` — ruta a `yt-dlp` (default: `yt-dlp` en el PATH).

> La ventana de la app debe estar abierta: los tools se ejecutan contra el editor en vivo. Si no hay
> ventana, los tools devuelven `"No editor window is open"`.

## Descargar videos (URLs)

`import_media` / `import_folder` aceptan rutas locales, carpetas y URLs `http(s)`:

- **Enlaces directos** a un archivo de video → se descargan con `fetch`.
- **Plataformas** (YouTube, Instagram, TikTok, Vimeo, X/Twitter, Facebook, Twitch, Dailymotion,
  Google Drive) → se descargan con **yt-dlp** (remux a `.mp4`). Requiere `yt-dlp` instalado
  (https://github.com/yt-dlp/yt-dlp); si falta, el tool lo avisa con un mensaje claro.

## Flujo típico (el que hace Reelo bien)

Nosotros hacemos lo técnico; tu editor hace subtítulos y efectos.

1. `import_folder { folderPath }` — o `import_media { sources: [...] }` con URLs.
2. `sync_angles { clipIds: [a, b], keepAudioOf, autoColor, force? }` — sincroniza 2 ángulos por audio.
   El offset se calcula con correlación RMS **y** alineación por transcript, reconciliados (un pico
   de correlación confiable refuta un transcript que discrepa). Si la confianza es baja **no aplica**
   y devuelve el candidato en el error; `force: true` lo aplica igual. Sin `clipIds` ni selección usa
   el único par de ángulos sin sincronizar de la timeline.
3. `apply_color_preset { clipIds, presetId }` — colorización (ver `list_color_presets`).
4. `segment_by_scripts { clipId?, scripts, cleanCuts?, apply?, keepAudioClipId?, airMs? }` — segmenta
   por guiones: transcribe, alinea cada guión a su tramo y arma las tomas. Pasá los guiones pegados en
   `scripts`. Con `cleanCuts: true` corta muletillas/silencios/repeticiones (revisables antes de
   aplicar) y refina los cortes contra el silencio acústico real; `airMs` controla el "aire" que se
   conserva entre frases (default 250 ms; ~120 más ajustado, ~450 más relajado). Si la timeline tiene
   exactamente 2 ángulos de video sin sincronizar, los **sincroniza automáticamente** antes de
   segmentar (`keepAudioClipId` elige de quién se conserva el audio; default el clip de la pista de
   video superior) y el resultado reporta `syncApplied` / `syncWarning`. El paso 2 sigue siendo útil
   para elegir audio/LUT con control fino.
5. `export_to_nle { outDir, target?, fullLength? }` — exporta un proyecto EDITABLE + media horneada
   (color + audio ya aplicados). Con `target` en `premiere`/`resolve`/`finalcut`/`universal` escribe un
   FCP7 xmeml en `outDir/handoff/<nombre>-<fecha>/` (abrí el `.xml` en Premiere/DaVinci/Final Cut). Con
   `target: 'capcut'` escribe un **borrador de CapCut** (`<nombre>-<fecha>/` con `draft_content.json` +
   `draft_meta_info.json` + `media/`) que CapCut abre directo — se coloca en la carpeta de borradores de
   CapCut si se detecta, si no en `outDir` con instrucciones en el README.

Ejemplo de humo end-to-end: `node mcp_flow.mjs` (con la app abierta). Ver también `mcp_import.mjs`
y `call_mcp.mjs`.

## Tools disponibles

`get_timeline`, `inspect_clip`, `list_assets`, `get_frame_preview`, `import_media`, `import_folder`,
`add_track`, `add_clip`, `move_clip`, `trim_clip`, `split_clip`, `remove_clips`, `ripple_delete`,
`close_gaps`, `set_clip_speed`, `set_clip_properties`, `set_clip_color`, `list_color_presets`,
`apply_color_preset`, `sync_angles`, `apply_auto_angles`, `cut_to_angle`, `set_track_role`,
`remove_silences`, `extract_audio`, `transcribe_clip`, `get_transcript`, `segment_by_scripts`,
`set_keyframe`, `remove_keyframe`, `get_keyframes`, `add_text_clip`, `batch_operations`, `seek`,
`set_resolution`, `set_fps`, `export`, `export_to_nle`, `new_project`, `open_project`, `save_project`.
