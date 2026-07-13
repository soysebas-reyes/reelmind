# Proceso de release (Windows)

Cómo se construye, verifica y publica un instalador de Reelo. La distribución es
**GitHub Releases** (repo público `soysebas-reyes/reelo`) con **auto-update** vía
`electron-updater`.

## Resumen

| Qué | Dónde |
|---|---|
| Config del instalador | [`electron-builder.yml`](../electron-builder.yml) (NSIS, per-user, icono, licencia GPL) |
| Icono | `build/icon.ico`, generado por [`scripts/make-icon.mjs`](../scripts/make-icon.mjs) (commiteado) |
| FFmpeg empaquetado | `resources/ffmpeg/` — lo baja `npm run fetch:ffmpeg` (gitignoreado; los scripts `pack`/`dist`/`release` lo corren solos) |
| Artefactos | `release/Reelo-<versión>-setup.exe` + `latest.yml` + `.blockmap` |
| Updates | La app instalada consulta `latest.yml` de la última Release al arrancar y desde Ajustes → Acerca de |

## Paso a paso

1. **Bump de versión** en `package.json` (semver: `0.x.y` mientras sea beta).
   Todo lo demás (UI, MCP, artefactos, telemetría) toma la versión de ahí.
2. **Verificación**: `npm run typecheck && npm test && npm run build`.
3. **Commit** del bump (`chore(release): v0.x.y`) y merge a `main`.
4. **Construir + publicar** (necesita `GH_TOKEN` con scope `repo`):

   ```bash
   npm run release   # fetch ffmpeg + build + electron-builder --publish always
   ```

   electron-builder crea la **Release como borrador** con tag `v<versión>` y sube los
   3 artefactos. Revisala en GitHub y publicala.

   **Alternativa manual** (sin `GH_TOKEN`): `npm run dist` y después

   ```bash
   gh release create v0.x.y release/Reelo-*-setup.exe release/latest.yml release/*.blockmap \
     --title "Reelo v0.x.y" --notes "…" --draft
   ```

5. **Regla de oro del auto-update**: la Release DEBE incluir `latest.yml` y el
   `.blockmap` además del `setup.exe`. Sin `latest.yml`, las apps instaladas no ven
   la versión nueva; el `.blockmap` habilita descargas diferenciales.

## Verificación del instalador (smoke test)

- `npm run pack` genera `release/win-unpacked/Reelo.exe` sin instalador (rápido).
- Instalá el `setup.exe` en una máquina/VM limpia y verificá:
  - arranca sin dev server ni `.env`;
  - importar un clip funciona (FFmpeg empaquetado);
  - Ajustes: guardar claves, toggle de medición, versión correcta;
  - primer arranque muestra el aviso de medición una sola vez;
  - `http://127.0.0.1:4399/mcp` responde (servidor MCP);
  - desinstalador presente en "Aplicaciones instaladas" (no borra `%APPDATA%\Reelo`).
- El flujo completo de auto-update se prueba publicando la versión siguiente:
  instalá la anterior, publicá la nueva, abrí la app y esperá la notificación
  (o Ajustes → Buscar actualizaciones).

## SmartScreen y firma de código (pendiente)

El instalador **no está firmado**: Windows SmartScreen muestra "editor desconocido"
la primera vez ("Más información → Ejecutar de todas formas"). Aceptable para
testers de confianza. Para eliminarlo más adelante:

- **Azure Trusted Signing** (~US$10/mes): reputación SmartScreen casi inmediata;
  requiere cuenta Azure + validación de identidad. Integración:
  [electron-builder → azureSignOptions](https://www.electron.build/code-signing).
- **Certificado OV** (p. ej. Certum "Open Source Code Signing", ~€70/año — aplica
  porque Reelo es GPL): configurar `CSC_LINK`/`CSC_KEY_PASSWORD` o
  `win.certificateFile`. La reputación se gana con descargas.

Nada del pipeline cambia al firmar: solo se agregan credenciales al entorno.

## Cumplimiento GPL

- La app es GPL-3.0-or-later; el instalador muestra la licencia (página NSIS).
- FFmpeg se redistribuye en su build GPL (BtbN); `fetch-ffmpeg.mjs` incluye su
  `LICENSE.txt` junto a los binarios y las fuentes están enlazadas en
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Atribución del upstream en [`ATTRIBUTION.md`](../ATTRIBUTION.md).
