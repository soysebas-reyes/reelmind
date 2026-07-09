# Medición Total — plan técnico (P16)

> Companion de [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) y contraparte técnica del contrato en
> [`../CLAUDE.md`](../CLAUDE.md). **Objetivo:** instrumentar cada interacción (comportamiento, nunca
> contenido), **local hoy** (JSONL en `userData`), con arquitectura lista para **Supabase + cuentas**
> mañana sin reescribir el cliente. Cada paso ship-ea verde; el core va antes que la UI.

---

## 1. Objetivo

Saber **cómo se usa la herramienta de verdad**: qué botones/comandos/tools se usan y cuáles se
ignoran, en qué orden, con qué éxito, cuánto tiempo se queda la gente, dónde abandona un flujo, y qué
hace el usuario vs. el agente de IA. Con eso podemos optimizar la app y decidir qué construir.

**Qué NO es:** no es analítica de marketing, no rastrea contenido, y no sube nada a la nube en la fase
local. No guardamos la información de los videos (que pesa y es privada) — solo *cómo* se usa la herramienta.

## 2. Privacidad — qué se mide / qué NUNCA se mide

| SE MIDE (comportamiento) | NUNCA se mide (contenido / PII) |
|---|---|
| Qué botón/comando/tool se usó, cuándo, cuántas veces | Frames de video / muestras de audio |
| Duraciones, secuencias, éxito/fallo, categoría de error | **Rutas de archivo**, nombres de medios/proyecto |
| Dimensiones gruesas (nº de args, `origin` user/agent) | Transcripciones, guiones, texto de chat/prompt |
| Coordenadas normalizadas 0–1, teclas de atajo | **Caracteres tecleados** (solo un bucket de conteo) |
| `anonymousId`, `sessionId`, `appVersion`, `platform` | Nombres de LUT confidenciales, cualquier texto libre |

**Mecanismo (defensa en profundidad):**
- **Allowlist de forma:** el envelope Zod (`src/core/telemetry/event.ts`) solo admite `props` de tipo
  primitivo (`string | number | boolean | null`); rechaza objetos/arrays anidados.
- **Scrub de valores** (`src/core/telemetry/redact.ts`): cualquier string tipo ruta / UNC / `file:` /
  `http(s)` / `data:` / archivo con extensión de medio / email se reemplaza por `[redacted:path]` o
  `[redacted:email]`; se truncan strings largos; se dropea lo no-primitivo.
- **Doble barrera:** la redacción corre **en el renderer** (las rutas nunca cruzan el IPC) y main
  **re-valida** con el mismo schema Zod.

## 3. Arquitectura

### 3.1 Core puro — `src/core/telemetry/` (framework-free; corre en renderer, main y tests)
- **`event.ts`** — el **envelope** Zod + `TELEMETRY_SCHEMA_VERSION`. Es la única fuente de verdad de
  la forma del evento (mapea 1:1 a la fila `events` de Supabase en §9). Campos: `v, id, name, category,
  ts, sessionId, anonymousId, userId?, appVersion, platform?, projectId?, props`. El schema valida
  **forma, no una whitelist de `name`** — así un evento nuevo (p. ej. `io.<acción>` de una acción de
  store recién agregada) se captura solo y nunca se dropea.
- **`taxonomy.ts`** — el registro de acciones con nombre (`TAXONOMY`) + `TOOL_NAMES` +
  `normalizeCommandLabel()`. Es el **guardrail de build**, no un gate de runtime (§6).
- **`redact.ts`** — la redacción/scrub (§2).

### 3.2 Capa 1 — captura física (renderer, agnóstica de features)
`src/renderer/src/telemetry/physical.ts`. Listeners globales en **fase de captura** (mismo patrón que
los `window.addEventListener('drop', …)` de `main.tsx`), pasivos y envueltos en try/catch (un fallo
de telemetría no puede romper la edición; nunca hacemos `preventDefault`/`stopPropagation`).
- `click` / `contextmenu`: coordenadas normalizadas + descriptor del objetivo (`data-tel` si existe,
  si no `{tag, role}`) + panel (vía `closest('.timeline,.bin,.stage,.right-panel,.toolbar,…')`).
- `pointermove`: **no emite por evento** — acumula O(1) y un único bucle `requestAnimationFrame`
  muestrea (~100 ms en drag / ~500 ms en hover) → un `physical.pointer` al buffer.
- `keydown`: **gate de privacidad** — en un campo de texto sin Ctrl/Meta/Alt NO se registra la tecla,
  solo un bucket de conteo de caracteres (`physical.key {typing:true, chars}`); fuera de campos, o con
  modificador de comando, se registra el atajo (`key`/`code`/mods).
- `wheel` (throttled), `focusin`, `visibilitychange`.

### 3.3 Capa 2 — captura semántica de comandos (choke point del controller)
`src/renderer/src/telemetry/semantic.ts` + el hook IoC `setCommitObserver` en
`EditorController.run()` (@core, **sin importar telemetría**). Cada comando commit-eado dispara el
observer con `{label, origin, coalesceKey}`; `normalizeCommandLabel()` mapea la etiqueta de display a
un id estable (`command.split_clip`; prefijos dinámicos → `command.color_preset`/`command.batch`/…;
libre → `command.other`). `origin` (`user`/`agent`) sale gratis del controller. Gestos rápidos
idénticos (sliders) se coalescen en un evento.

### 3.4 Capa 3 — captura semántica de sistema (IO / IA / MCP)
`src/renderer/src/telemetry/io.ts` auto-envuelve **una vez** las acciones del store de Zustand
(import/save/open/export/sync/transcribe/takes/ángulos/audio/tabs/inspectores…) → `io.<acción>` con
`ok`/`ms`/nombres de args (nunca valores). Acciones de alta frecuencia/internas (progreso, playback)
se excluyen. El único seam de IA/MCP es `runEditorTool()` (`src/renderer/src/ai/runTool.ts`), que
emite `tool.<name>` con `origin` (`agent`/`mcp`), `ok`, `ms` y nombres de args — cubre las ~47 tools.

### 3.5 Sink en main — `src/main/telemetry/`
El renderer manda lotes por IPC **fire-and-forget** (`telemetry:events`, espeja `sendMcpResult`). Main
es el **límite de confianza**: valida con Zod (`z.array(schema).max(500)`, nunca lanza a través de
IPC), **sobre-escribe** `anonymousId`/`userId`/`appVersion`/`v`/`platform` con sus fuentes autoritativas
y clampa relojes imposibles. Escribe **JSONL append-only** en `userData/telemetry/events-YYYY-MM-DD.jsonl`
detrás de la interfaz `TelemetrySink`. Handlers `invoke`: `telemetry:getContext` (identidad+config),
`telemetry:setConfig` (toggle), `telemetry:recent` (inspección dev). Flush final síncrono en `before-quit`.

**JSONL sobre SQLite:** no hay infra de módulos nativos en el repo (sin electron-rebuild/asarUnpack),
JSONL es append O(1), tolerante a crash (una línea final rota se ignora al leer) y **es el buffer
durable** que el futuro syncer de Supabase leerá con un cursor. Archivos por día + sharding a 32 MB +
retención 30 días.

## 4. Modelo de identidad — `src/main/telemetry/identity.ts`
- **`anonymousId`** — UUID persistente por instalación (`userData/telemetry/identity.json`, JSON plano;
  es pseudónimo, no un secreto → no usa `safeStorage`). **Nunca rota.** Es la **FK futura** a la cuenta.
- **`sessionId`** — UUID por lanzamiento (memoria).
- **`userId`** — `undefined` hoy; `setUser()` lo persiste cuando existan cuentas (§9.4).

## 5. Taxonomy registry
`TAXONOMY: TaxonomyEntry[]` = `{ id, category, description, source?, dynamic? }`. Incluye: una entrada
por cada tool (`tool.<name>`), una por etiqueta de comando (`command.<id>`, estáticas + prefijos
dinámicos + `command.other`), y los eventos fijos `session.*` / `physical.*` / `error.*`. La categoría
`io` es dinámica (`io.<acción>`) y no requiere entrada (auto-capturada, auto-documentada por el nombre).

## 6. Guardrail / mecanismo "always-valid" — `src/core/telemetry/taxonomy.test.ts`
Parte del `npm test` bar existente. Chequea:
1. **Tools (biyección dura):** cada `editorTools[].name` tiene entrada en `TOOL_NAMES` y no hay huérfanas.
2. **Comandos (source-scan):** lee `EditorController.ts` y exige que cada literal directo
   `this.run('…')`/`this.transact('…')` esté en `STATIC_COMMANDS`. Un `this.run('Etiqueta Nueva')`
   sin registrar rompe `npm test` (con mensaje copy-pasteable).
3. **Integridad:** ids únicos, `category` válida, `description` no vacía; `normalizeCommandLabel`
   siempre devuelve un id registrado.

**Los 3 pilares del "always-valid"** (por qué la medición no se rompe cuando la app cambia):
- **I. Captura física genérica** — cualquier UI nueva se mide sin tocar código.
- **II. Choke points** (`EditorController.run`, `runEditorTool`) — features nuevas se capturan solas.
- **III. Guardrail + contrato** — obligan a darle un **nombre legible** a lo nuevo.

Lo no registrado **igual se mide** (cae en `command.other` / `io.<acción>` / target genérico); el paso
manual mínimo (un `data-tel` y/o una línea en `taxonomy.ts`) solo le pone un nombre humano, y el
guardrail lo hace obligatorio.

## 7. Contrato de mantenimiento
Espejo del checklist de [`../CLAUDE.md`](../CLAUDE.md). Además:
- **Evento nuevo:** definí su `name` dotted, elegí `category`, agregalo al `TAXONOMY`, y emití con
  props primitivos y seguros.
- **Versión de schema:** si cambia la forma del envelope, subí `TELEMETRY_SCHEMA_VERSION` y dejá una
  nota de migración. Un solo envelope es la fuente de verdad para JSONL y para Supabase.
- **Opt-out:** local = habilitado por defecto, cero egress; `REELMIND_NO_TELEMETRY=1` lo apaga.

## 8. Hoja de ruta
- **P16.0 — Captura local + JSONL.** ✅ hecho: 3 capas + core + sink JSONL + identidad + guardrail +
  docs. Sin red.
- **P16.1 — Inspección/dashboard local.** `telemetry:recent` + un reporte dev (conteos/funnels/user-vs-
  agent) leyendo el JSONL, y una **auditoría de redacción** que escanea el JSONL por fugas de ruta/PII.
- **P16.2 — Supabase + cuentas.** §9.

## 9. Arquitectura futura — Supabase + cuentas (diseñar ahora, construir en P16.2)

### 9.1 Tabla `events` (mapea el envelope 1:1)
```sql
create table public.events (
  id             uuid primary key,                    -- envelope.id (dedup key)
  ts             timestamptz not null,                -- hora del cliente
  received_at    timestamptz not null default now(),  -- hora de ingest (guarda contra clock skew)
  session_id     uuid not null,
  anonymous_id   uuid not null,
  user_id        uuid references auth.users(id) on delete cascade,  -- null hasta vincular
  app_version    text not null,
  platform       text not null,
  category       text not null,   -- 'session'|'physical'|'command'|'tool'|'io'|'error'|'perf'
  name           text not null,   -- id del taxonomy, ej. 'command.split_clip'
  props          jsonb not null default '{}'::jsonb,   -- redactado, allowlisted
  schema_version int  not null
);
create index events_anon_ts_idx on public.events (anonymous_id, ts desc);
create index events_user_ts_idx on public.events (user_id, ts desc);
create index events_name_ts_idx on public.events (name, ts desc);

-- Agrupa varios anonymous_id (multi-dispositivo) bajo una cuenta.
create table public.identities (
  anonymous_id uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  linked_at    timestamptz not null default now()
);
```
**Idempotencia:** `id` es la PK ⇒ `insert … on conflict (id) do nothing` hace la subida
at-least-once segura (duplicados se descartan). Es la clave del outbox.

### 9.2 Auth (Supabase Auth / GoTrue)
Signup (email+password o magic link) → login → la app "interactúa" y los eventos empiezan a llevar
`userId`. **Los tokens viven en MAIN, cifrados con `safeStorage`** (mismo patrón que
`src/main/ai/secrets.ts`); el renderer nunca los toca (y el CSP le bloquea llamar a Supabase directo).
El renderer dispara auth por IPC (`auth:signUp`/`signIn`/`signOut`/`status`), main hace el HTTPS (toda
la red externa ya va por main) y solo expone booleanos/estado.

### 9.3 RLS
```sql
alter table public.events enable row level security;
create policy events_select_own on public.events for select using (user_id = auth.uid());
create policy events_insert_own on public.events for insert with check (user_id = auth.uid());
```
**Sin inserts anónimos en la nube:** los eventos pre-login nunca salen del dispositivo; suben solo tras
crear cuenta, ya sellados con `user_id`. El `service_role` (solo servidor) agrega/administra.

### 9.4 Linkage `anonymousId → userId`
`anonymousId` se captura desde el día 1 (local). Al primer login, el worker de sync lee el backlog
JSONL no subido, **sella `user_id`** en cada evento y lo sube; escribe una fila en `identities`. Así la
nube solo contiene filas atribuidas al usuario, y su comportamiento pre-cuenta se preserva y atribuye
una vez que consiente al registrarse. Multi-instalación: cada install tiene su `anonymousId`;
`identities` los agrupa bajo un `user_id`.

### 9.5 Outbox / sync (offline-first)
El JSONL append-only **es** el buffer durable y el outbox. Un cursor (`userData/telemetry/sync-cursor.json`
= `{file, byteOffset}`) marca lo ya subido. Un worker en main (activo solo *logueado* + *con consent* +
*online*) lee lo nuevo, lo sube por lotes (~500) con el JWT del usuario vía `fetch` de main (sin
problema de CSP), avanza el cursor al recibir 2xx, y reintenta con backoff. At-least-once + upsert
idempotente por `id`. La retención local no debe borrar archivos que el cursor no pasó.

## 10. Riesgos
- **Contrato ignorado si queda enterrado.** `CLAUDE.md` se mantiene corto con el CONTRATO arriba; el
  respaldo es **mecánico** (el guardrail rompe la build aunque nadie lea la prosa).
- **Bypass del guardrail.** Chequea presencia + forma; vive en el `npm test` bar; borrar/`skip` el test
  se bloquea en review por el contrato.
- **`anonymousId` bajo GDPR al ir a nube.** Es pseudónimo → dato personal una vez vinculable. Nube
  apagada por defecto, opt-in con consentimiento, borrado por id (`on delete cascade`), sin ingest
  anónimo; no shippear P16.2 sin política de privacidad.
- **Drift JSONL ↔ Supabase.** El envelope Zod es la única fuente de verdad; ambos derivan de él; cada
  fila estampa `schema_version`; el ingest valida contra un rango soportado.
