# Proceso de release (Windows + macOS)

Cómo se construye, verifica y publica Reelo. La distribución es **GitHub Releases**
(repo público `soysebas-reyes/reelo`) con **auto-update** vía `electron-updater`.
Las builds las hace **GitHub Actions** ([`release.yml`](../.github/workflows/release.yml));
la máquina de desarrollo (Windows) también puede construir su propio instalador local.

## Resumen

| Qué | Dónde |
|---|---|
| Config del empaquetado | [`electron-builder.yml`](../electron-builder.yml) — `win` (NSIS, per-user) y `mac` (dmg+zip arm64, hardened runtime, notarización) |
| Iconos | `build/icon.ico` (win) + `build/icon.icns` (mac), generados por [`scripts/make-icon.mjs`](../scripts/make-icon.mjs) (commiteados) |
| FFmpeg empaquetado | `resources/ffmpeg/` — `npm run fetch:ffmpeg` baja el de **esta** plataforma (win: BtbN; mac arm64: ffmpeg.martin-riedl.de, canal release). Gitignoreado. |
| CI | [`ci.yml`](../.github/workflows/ci.yml): typecheck + tests + build en `windows-latest` y `macos-15` en cada push |
| Artefactos Windows | `Reelo-<versión>-setup.exe` + `latest.yml` + `.blockmap` |
| Artefactos macOS | `Reelo-<versión>-arm64.dmg` + `Reelo-<versión>-arm64.zip` + `latest-mac.yml` (+ blockmaps) |
| Updates | La app consulta `latest.yml` / `latest-mac.yml` de la última Release al arrancar y desde Ajustes → Acerca de |

## Paso a paso (flujo CI, recomendado)

1. **Bump de versión** en `package.json` (semver: `0.x.y` mientras sea beta).
   Todo lo demás (UI, MCP, artefactos, telemetría) toma la versión de ahí.
2. **Verificación local**: `npm run typecheck && npm test && npm run build`.
3. **Commit** del bump (`chore(release): v0.x.y`), merge a `main`, push.
4. **Tag**: `git tag v0.x.y && git push origin v0.x.y` → corre `release.yml`:
   un job pre-crea el **draft** de la Release y luego los jobs de Windows y macOS
   suben sus artefactos al mismo draft.
5. **Smoke test** de ambos instaladores (ver abajo) y **publicar el draft**.

**Regla de oro del auto-update**: la Release publicada DEBE incluir `latest.yml`
(Windows) **y** `latest-mac.yml` (macOS) además de setup.exe/.blockmap/dmg/zip.
Sin su `latest*.yml`, las apps instaladas de esa plataforma no ven la versión nueva.

### Alternativa local (solo Windows, sin CI)

```bash
npm run release   # fetch ffmpeg + build + electron-builder --publish always (draft)
# o sin GH_TOKEN:
npm run dist
gh release create v0.x.y release/Reelo-*-setup.exe release/latest.yml release/*.blockmap \
  --title "Reelo v0.x.y" --notes "…" --draft
```

## Secrets del repo (Settings → Secrets → Actions)

| Secret | Qué es |
|---|---|
| `CSC_LINK` | Certificado **Developer ID Application** (.p12) en base64 |
| `CSC_KEY_PASSWORD` | Contraseña del .p12 |
| `APPLE_ID` | Apple ID de la cuenta de developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (appleid.apple.com) |
| `APPLE_TEAM_ID` | Team ID del portal de developer |

Sin estos secrets el job de mac igual compila, pero **sin firma**: la app requiere
clic derecho → Abrir y el auto-update de mac **no funciona** (Squirrel.Mac exige firma).

## Smoke test del instalador

### Windows
- `npm run pack` genera `release/win-unpacked/Reelo.exe` sin instalador (rápido).
- Instalá el `setup.exe` en una máquina/VM limpia y verificá:
  - arranca sin dev server ni `.env`;
  - importar un clip funciona (FFmpeg empaquetado);
  - Ajustes: guardar claves, toggle de medición, versión correcta;
  - primer arranque muestra el aviso de medición una sola vez;
  - `http://127.0.0.1:4399/mcp` responde (servidor MCP);
  - desinstalador presente en "Aplicaciones instaladas" (no borra `%APPDATA%\Reelo`).

### macOS (Apple Silicon)
- Descargá el **dmg desde el navegador** (adquiere el quarantine real) → abrir →
  arrastrar a Aplicaciones → el primer arranque NO debe pelear con Gatekeeper.
- `spctl -a -vv /Applications/Reelo.app` → `accepted … Notarized Developer ID`.
- `codesign --verify --deep --strict --verbose=2 /Applications/Reelo.app` OK, y
  `codesign -dv .../Contents/Resources/ffmpeg/ffmpeg` (y `ffprobe`) → firmados.
- Importar un clip → proxy → preview con scrubbing/seek fluido.
- Export en calidad `high` usa `h264_videotoolbox` (log del probe) sin colores
  lavados; `max` sigue en libx264. Comparar peso/calidad contra libx264 la primera
  vez (los `-q:v` de VideoToolbox son calibración inicial).
- ⌘C/⌘V en inputs, ⌘Q, cerrar la ventana y reabrir desde el Dock.
- Ajustes: la clave API se guarda en el **Keychain** (safeStorage).
- Handoff a CapCut aparece en CapCut mac (si está instalado).
- Icono correcto en Dock/Finder/dmg.

### Auto-update (ambas plataformas)
Se prueba publicando la versión siguiente: instalá la anterior, publicá la nueva,
abrí la app y esperá la notificación (o Ajustes → Buscar actualizaciones).

## Firma de código

**macOS**: cubierto arriba (Developer ID + notarización vía CI). Membresía del
Apple Developer Program: US$99/año.

**Windows (pendiente)**: el instalador **no está firmado**: SmartScreen muestra
"editor desconocido" la primera vez ("Más información → Ejecutar de todas formas").
Aceptable para testers de confianza. Para eliminarlo más adelante:

- **Azure Trusted Signing** (~US$10/mes): reputación SmartScreen casi inmediata;
  requiere cuenta Azure + validación de identidad. Integración:
  [electron-builder → azureSignOptions](https://www.electron.build/code-signing).
- **Certificado OV** (p. ej. Certum "Open Source Code Signing", ~€70/año — aplica
  porque Reelo es GPL): configurar `CSC_LINK`/`CSC_KEY_PASSWORD` o
  `win.certificateFile`. La reputación se gana con descargas.

Nada del pipeline cambia al firmar: solo se agregan credenciales al entorno.

## Cumplimiento GPL

- La app es GPL-3.0-or-later; el instalador de Windows muestra la licencia (página NSIS).
- FFmpeg se redistribuye en builds GPL; `fetch-ffmpeg.mjs` deja el `LICENSE.txt`
  junto a los binarios:
  - **Windows**: build de [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
    (incluye su license.txt; fuentes enlazadas en ese repo).
  - **macOS arm64**: build estático GPLv3 de [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de)
    (canal *release*); fuentes en [ffmpeg.org/releases](https://ffmpeg.org/releases/) y
    build script público en [git.martin-riedl.de/ffmpeg/build-script](https://git.martin-riedl.de/ffmpeg/build-script).
    Si la fuente no está disponible, `REELO_FFMPEG_SOURCES` permite apuntar a un mirror.
- Atribución del upstream en [`ATTRIBUTION.md`](../ATTRIBUTION.md).
