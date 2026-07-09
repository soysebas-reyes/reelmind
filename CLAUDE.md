# ReelMind — instrucciones para agentes

Editor de video AI-native para Windows (Electron + TypeScript + React). Detalle del producto en
[`README.md`](./README.md).

**Lectura obligatoria antes de tocar código:**
1. [`docs/PROJECT_PLAN.md`](./docs/PROJECT_PLAN.md) — fuente de verdad del estado del proyecto (fases P0–P16).
2. [`docs/TOTAL_MEASUREMENT_PLAN.md`](./docs/TOTAL_MEASUREMENT_PLAN.md) — **cómo y por qué se mide todo.** Leelo antes de tocar UI o comandos.

Si vas a agregar o cambiar **cualquier cosa visible** o **cualquier comando/tool**, el contrato de
abajo es obligatorio.

---

## 🔴 MEDICIÓN TOTAL — CONTRATO (no negociable)

> **Toda funcionalidad nueva o cambio de UI DEBE instrumentarse en el sistema de medición ANTES de
> considerarse terminada.** Una feature sin telemetría está *incompleta*: no entra a `main`, no pasa
> `npm test`, y no se acepta en review.

> **La medición no es opcional ni "para después": es parte de la _definition of done_.** El repo
> tiene un **guardrail automático** (`src/core/telemetry/taxonomy.test.ts`) que **rompe la build** si
> agregás un comando de `EditorController` o una tool de `editorTools` sin registrarla en el taxonomy.

Medimos **comportamiento** (qué se usa, cuándo, cuántas veces, con qué resultado, cuánto tiempo),
**jamás contenido** (nunca frames/audio, rutas de archivo, nombres de medios/proyecto,
transcripciones, ni texto de chat/prompt). Ver la tabla de privacidad en el plan de medición.

## ✅ Definition of Done (checklist — copiá/pegá al terminar)

- [ ] ¿Agregaste un **elemento interactivo** (botón, menú, slider, tab, atajo)? → poné
      `data-tel="<area>.<accion>"` en el elemento (ej. `data-tel="topbar.export"`). La captura física
      ya lo registra igual; `data-tel` le da un nombre legible.
- [ ] ¿Agregaste o renombraste un **comando de `EditorController`** (un literal de `this.run('…')` /
      `this.transact('…')`)? → registrá su etiqueta en `STATIC_COMMANDS` de
      `src/core/telemetry/taxonomy.ts`.
- [ ] ¿Agregaste una **tool** a `editorTools` (`src/core/ai/tools.ts`)? → agregá su nombre a
      `TOOL_NAMES` en `src/core/telemetry/taxonomy.ts`.
- [ ] ¿Agregaste un **evento con nombre propio** (session/physical/error…)? → agregalo al `TAXONOMY`.
- [ ] Corré `npm test`: el **guardrail** debe pasar (te dice exactamente qué falta si algo quedó sin registrar).
- [ ] **NUNCA** loguees: frames/audio, rutas, nombres de medios/proyecto, transcripciones, texto de
      chat/prompt, ni PII. Solo comportamiento. (La redacción en `src/core/telemetry/redact.ts` es una
      red de seguridad, no una licencia para pasar contenido.)
- [ ] Convenciones del repo: header `// SPDX-License-Identifier: GPL-3.0-or-later` en cada archivo;
      commit `type(scope): descripción` **en español**; identificadores en inglés.

## Por qué esto SIEMPRE queda válido (3 pilares)

1. **Captura física genérica (DOM):** mide cualquier elemento nuevo *sin tocar código*.
2. **Choke points semánticos:** toda edición pasa por `EditorController.run()` y toda acción de
   IA/MCP por `runEditorTool()`, así que las features nuevas se capturan solas.
3. **Guardrail + este contrato:** obligan a ponerle un **nombre legible** a lo nuevo.

Por eso la medición no se rompe cuando la app cambia: solo tenés que darle un nombre a lo nuevo, y el
guardrail te obliga a hacerlo. Lo no registrado igual se mide (cae en `command.other` / `io.<action>`
/ target genérico), nunca queda sin medir.

## Verificación

```
npm run typecheck   # node + web
npm run build       # electron-vite
npm test            # incluye el guardrail de medición
```

## Convenciones (no dupliques; ver PROJECT_PLAN §2)

GPL-3.0-or-later (derivado de palmier-pro; ver [`ATTRIBUTION.md`](./ATTRIBUTION.md)). Docs y mensajes
de usuario en español; identificadores en inglés. Superficie de tools para agentes externos en
[`MCP.md`](./MCP.md). Sin `"type": "module"`; pines de versión y demás decisiones en `PROJECT_PLAN §2`.
