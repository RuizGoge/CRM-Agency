# CONTEXT.md — Living Project Memory

> Si el contexto de la conversación se perdiera, `CLAUDE.md` (aún no existe) + este archivo + `docs/` deben bastar para retomar el proyecto sin pérdida.

## Current State
<!-- qué fase va, qué está hecho, qué sigue -->
- **Fase actual:** ✅ **LEVANTAMIENTO COMPLETO. Fases 0–7 cerradas y aprobadas.** GATE 7 **aprobado** ("ok fase 7", 2026-07-31). GATE 6 **aprobado** ("ok", 2026-07-31). GATE 5 **aprobado** ("ok todo continuemos", 2026-07-31).

### 🤖 Fase 7 — Agentes, skills y comandos (COMPLETA)
Entregable: `docs/07-agents-skills.md` + artefactos en `.claude/`.

**7 agentes.** Juicio: `db-guardian` (Opus, esquema y migraciones), `security-auditor` (Opus, silo en rutas + gates de cumplimiento), `precedence-checker` (Sonnet, ¿esto está construido sobre texto tachado?), `ux-reviewer` (Sonnet, pantallas terminadas). Mini-agentes económicos: `event-checker`, `i18n-checker`, `context-keeper` (Haiku).

**7 skills:** `new-endpoint`, `new-module`, `new-component`, `db-migration`, `story-to-test`, `demo-data`, `release-check`. **1 comando nuevo:** `/sprint-status`.

**Criterio de admisión aplicado:** cada artefacto debía atrapar algo que de otro modo es **silencioso** y que requiere **juicio**. Corolario que descartó varios candidatos: *si un linter o un test de CI ya lo atrapa, un agente que lo repita es teatro* — la misma trampa que la revisión de la Fase 5 encontró en el primer borrador de arquitectura.

**Descartados con razón:** `architect-reviewer` (demasiado vago con 92 ADRs → reemplazado por `precedence-checker`, la versión concreta del mismo instinto), `ui-craftsman` (implementar no es verificar), `test-engineer` (es un procedimiento → pasó a ser la skill `story-to-test`), `perf-checker` (**el CI es el mecanismo**; además reportaría verde sobre los dos presupuestos de front-end que están deliberadamente sin fijar hasta la Puerta 8), `silo-auditor` (se plegó en `db-guardian` + `security-auditor`; tres revisores de la misma propiedad es cómo cada uno asume que otro la cubre).

**Regla de mantenimiento:** los artefactos son parte de las convenciones que hacen cumplir. Si cambia una convención, actualizar el artefacto es parte del cambio — un `db-guardian` con las reglas del mes pasado es peor que ninguno, porque produce un informe verde que no significa nada.

### 🏗️ Fase 6 — Fundación del repositorio (COMPLETA)
**El repositorio existe y el pipeline de calidad está en verde.** Nada de producto construido todavía.

| Verificación | Estado |
|---|---|
| `npm run typecheck` | ✅ strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, cero `any` |
| `npm run lint` | ✅ ESLint 10 type-checked, cero warnings toleradas |
| `npm run format:check` | ✅ Prettier |
| `npm run test` | ✅ **14/14** (el tipo `Money`) |
| `npm run build` | ✅ |
| `npm run dev` | ✅ **200 OK**, 23 tokens de la Fase 4 en la página, **0 hex sueltos** |

- **Stack instalado y fijado a versiones reales verificadas contra el registro npm** (no inventadas): React Router **8.3.0**, React **19.2.8**, Drizzle ORM **0.45.2** / Kit **0.31.10**, Vite **8.2.0**, Vitest **4.1.10**, zod **4.4.3**, ESLint **10.8.0**, Playwright **1.62.1**, postgres **3.4.9**. **TypeScript 5.9.3 a propósito**, no el 7.0.2 recién publicado: `typescript-eslint` todavía apunta a la línea 5.x y esta fase premia estabilidad sobre novedad.
- **Desviación documentada:** se usa **npm**, no pnpm. `corepack enable` requiere permisos de administrador en esta máquina. Es una decisión de herramienta, no de arquitectura; los nombres de script no cambian.
- **Estructura por MÓDULO DE DOMINIO** (los 13 de la Fase 2), nunca por tipo técnico.
- **Tokens de diseño canónicos implementados**: `primitives.css` (única fuente de hex del sistema), `theme.css` (capa semántica — los componentes solo leen esta), `motion.css`, `timing.ts`, `reset.css`.
- **`app/lib/money/money.ts`**: el tipo marcado `Money` en centavos `bigint`, con la regla ESLint que **rompe el build** ante `Number(`, `parseFloat(` o `Math.round(` fuera de ese directorio. El test prueba el caso exacto: $249.99 mensual × 12 = **$2,999.88** — en coma flotante daría 2999.8799999999997 en un tablero público.
- **Git inicializado.** Primer commit `84f4c68` — 150 archivos, 31.551 líneas. Hook `pre-commit` con husky corriendo `npm run verify`, **verificado ejecutándose de verdad** (un hook que nunca corrió es documentación, no un mecanismo).
- **Entregables:** `CLAUDE.md` (constitución), `README.md`, `.env.example`, `docker/docker-compose.yml` (Postgres 18 local, costo USD 0).

### 📌 Fase 5 — GATE 5 APROBADO (2026-07-31)
  - **5A — Selección de stack: FIRMADA.** Ver "Decisión de stack" más abajo.
  - **5B — Arquitectura: COMPLETA.** Entregables escritos: **`docs/05-architecture.md`** (417 KB), **`docs/05b-data-model.md`** (151 KB, 45 tablas + ER Mermaid), **`docs/05c-closure-register.md`** (327 KB, el registro de correcciones) y **`docs/adr/`** (92 ADRs + README).
  - **Ciclo de calidad ejecutado:** 7 arquitectos diseñaron → 2 revisores encontraron ~80 defectos → 3 agentes de reconciliación cerraron 112 → un auditor de cierre **reprobó** el resultado (la reconciliación había reintroducido defectos de la misma clase) → pasada final de 12 objetos → segundo auditor **APRUEBA condicionalmente**.
  - **La aprobación es CONDICIONAL:** erratas **E1–E8** incorporadas literalmente (están en `05-architecture.md` §0.2, rango 1 de precedencia) + riesgos residuales **R1–R12** publicados a la vista (§0.3). **Si las erratas se tratan como opcionales, el veredicto es nulo.**
  - **Fase 6 recomendada: Sonnet · esfuerzo medio** (producción mecánica sobre decisiones aprobadas; revisar `CLAUDE.md` con cuidado extra antes del gate) — regla 4.6.

### 🏛️ Precedencia del corpus (crítico — leer antes de construir)
1. **Erratas E1–E8** (`05-architecture.md` §0.2) — ganan sobre todo, incluido Part I.
2. **Rulings P1–P8 de Fase 5** (`05-architecture.md` Part I).
3. **Rulings R1–R7 de Fase 4** (`04-ux-flows.md` Part I).
4. Secciones de arquitectura (Parts II–VII).
5. `05c-closure-register.md`.
6. Documentos aprobados de Fases 2–4, salvo lo tachado en §0.4.

### ⚠️ La regla que gobierna toda la implementación
Jorge **no lee código**; valida por comportamiento en pantalla. **No hay revisor de código ni PR revisado.** Por lo tanto una regla solo es regla si es *constraint de BD, privilegio revocado, trigger, tipo que no compila, build que se pone rojo, o síntoma en la pantalla de un vendedor.* Corolario (**NEW-7**): *"solo el rol migrador puede debilitar esto"* significa aquí *"el modelo escribe una migración y nadie lee el diff"*. Solo tres propiedades sobreviven a ese actor: **(a)** síntoma en pantalla, **(b)** gate anclado FUERA del árbol de código, **(c)** re-aserción en deploy y en arranque.

### 🔧 Los 12 documentos aprobados que la Fase 5 corrigió (§0.4)
Los tres que más importan: **(1)** el cambio de transporte — SSE lleva **exactamente dos** canales (estado de llamada + banners de tenant); el leaderboard y todo lo demás siguen en polling como se aprobó, y **el poll nunca se apaga: push es una pista, el poll es la verdad**. **(2)** *"board re-rank < 5 s"* es aritméticamente imposible (R1.3 retiene la fila 5,5 s + poll de 5 s) → el número honesto es ≈10,5 s, que R4.4 ya narraba. **(3)** *"recompute on stage-flag change"* queda **tachado**: el ledger es forward-only y no existe job de recompute.
- **Fase 4 COMPLETA y GATE 4 APROBADO** ("ok fase 4", 2026-07-31).

### ⚙️ Decisión de stack (Fase 5A — FIRMADA 2026-07-31)
**Ganador: variante B2** — una sola aplicación **TypeScript** corriendo como **procesos residentes** sobre **contenedores gestionados** en región EE.UU., con **Postgres gestionado**. Puntaje 7,76 vs 7,10 (Rails/DigitalOcean) vs 5,04 (Vercel serverless, **eliminada**).

| Capa | Elección |
|---|---|
| Lenguaje/runtime | TypeScript sobre Node 24 |
| Framework | React Router 8 (framework mode), SSR |
| Datos | Drizzle sobre PostgreSQL 18 gestionado (Render Postgres Basic) |
| Colas/scheduling | **pg-boss dentro del mismo Postgres** (sin Redis, sin broker, sin servicio gestionado) |
| Realtime | **SSE + LISTEN/NOTIFY** desde conexión dedicada (sin servicio de realtime gestionado) |
| Topología | 3 procesos (web/SSR+API+SSE · worker · ingesta dedicada como bulkhead) |
| Storage | Cloudflare R2 (jurisdicción US) para bóveda de payloads crudos |
| Auth | **better-auth** (NO Auth.js v5 — sigue en beta) |
| Observabilidad | Sentry (free + Spike Protection), Axiom, Better Stack |
| CI | GitHub Actions Free, repo privado, ubuntu-latest, **sin método de pago cargado** |
| Email transaccional | **fuera del MVP** (V1.1) → sin reset de contraseña autogestionado |
| Desarrollo | **100% local con Docker Compose**, misma imagen que producción |

**Por qué ganó:** el criterio de mayor peso (30/100) fue **visibilidad del error** — Jorge valida por comportamiento, no leyendo código, así que lo que decide es si un bug del modelo llega visible a la pantalla o corrompe dinero en silencio. **Vercel+Supabase quedó ELIMINADA** (no perdió por puntaje): su peor riesgo —respuesta cacheada de un vendedor servida a otro, o sea fuga cross-silo— es invisible para sus cuatro controles, invisible en desarrollo, e **incentivado por su propia cuenta de costos**.

**Escalera de costos (decisión de Jorge: pagar lo mínimo el mayor tiempo posible):**
| Escalón | Costo | Config |
|---|---|---|
| 0 · Desarrollo | **USD 0** | Todo local, sostenido, sin letra chica |
| 1 · Piloto 2-3 vendedores | USD 0–26 | Procesos plegados en uno |
| 2 · Producción 50 vendedores (mínimo) | USD 26 | 1 web + Postgres con backups |
| 2 · Producción (recomendado) | **USD 42,50** | 3 procesos + Postgres |
| Proyección 12 meses | ~USD 76,50 | Techo duro USD 100 · salto de workspace **PROHIBIDO** |

**La única línea innegociable: Postgres de pago con backups (USD 19).** El `earnings_ledger` es append-only, all-time y **por diseño no tiene job de recomputo**: perderlo es pérdida total y definitiva del registro de comisiones. Los tiers gratuitos no sirven (Render borra la BD a los 30 días y su doc dice que no la uses en producción; Supabase pausa a los 7 días y no trae backups).

**Consecuencia de diseño exigida por Jorge:** la separación en tres procesos es **configuración de despliegue, no supuesto arquitectónico** — debe poder desplegarse plegado en uno y separarse después sin rediseño ni migración.

**⚠️ RIESGO ABIERTO QUE PUEDE DAR VUELTA LA DECISIÓN:** falta verificar que **Render ofrece región EE.UU. en el plan a contratar** (las dos auditorías se contradicen). Si no lo ofrece, B2 cae por la puerta de región y **gana automáticamente Rails sobre DigitalOcean**. Es el **primer ítem del Sprint 0**, antes de crear ningún recurso.

**Hallazgo legal relevante:** el tier Hobby de **Vercel prohíbe explícitamente el uso comercial** ("any Deployment ... for the purpose of financial gain of anyone involved in any part of the production of the project, including a paid employee or consultant writing the code"). Por eso el desarrollo gratis se resuelve en local, no en un tier gratuito de hosting.

**Evidencia completa** (614 KB, scratchpad de la sesión — destilar a `docs/` y ADRs antes de cerrar el gate): `arr.md` (127 requisitos con trazabilidad), `proposals.md`, `adversary.md`/`adversary-v2.md`, `price-audit.md`, `freetier-*.md`, `variants-v2.md`, `decision-final.json`, `thesis.md`.
- **Fase 4 hecha:** workflows `ux-design-phase4` (12/12 agentes) + `design-system-reconciliation` (3/3). Entregables: **`docs/04-ux-flows.md`** (217 KB: rulings normativos R1–R7 + 6 flujos end-to-end + lista protegida de 10 detalles) y **`docs/04b-design-system.md`** (323 KB: tokens canónicos, componentes, interacción/a11y/performance, tabla de strings en-US).
- **Incidente resuelto:** los 4 agentes de diseño produjeron TRES design systems incompatibles (tokens duplicados, 3 alturas de tarjeta, 2 veredictos de contraste opuestos). Reconciliados en uno; al recalcular contrastes desde el hex se descubrió que 2 valores REPROBABAN WCAG (borde 2.49:1, riel going-cold 2.35:1).
- **Catálogo de eventos ampliado a 49** (amendment 1 en `02b`): 9 eventos promovidos, el resto remapeados o rechazados con razón.
- **Fase 3 hecha:** workflow `mvp-definition-phase3` (run `wf_0cbf9d68-970`, 14/14 agentes OK). **549 items puntuados → MVP de 68**. Entregables: `docs/03-mvp-definition.md` (maestro) + `03-mvp-stories.md` (43 historias Given/When/Then) + `03-dod-roadmap.md` (DoD + V1.1/V2 + camino SaaS) + `03-scoring-appendix.md` (tabla completa de 549).
- **D7/D8/D9 RESUELTAS:** D7 **sí** → selector de período (Hoy/Semana/Mes/All-time, default all-time) sobre un solo tablero, un solo número. D8 **no** → el ledger arranca en el go-live, tablero rotulado honestamente; historia solo como saldos iniciales admin auditados. D9 → verificar el aviso de grabación en el spike de Sprint 0; si no se dispara, desactivar grabación a nivel de cuenta Aloware en el MVP.
- **Sprint 0 obligatorio antes de cualquier UI dependiente:** spike de integración Aloware. Y **iniciar registro 10DLC YA** (tarda semanas, puede ser rechazado).

### Historial
- **Fase 2 — Mapa funcional:** COMPLETA y aprobada.
- **Hecho:** Workflow `functional-map-phase2` (run `wf_b23a77a0-4ba`): 12 specs de módulo (Opus/alto) + 12 críticas adversariales (sales-ops US life) + 26 capacidades transversales + auditoría de eventos. Consolidado en **`docs/02-functional-map.md`**, **`docs/02b-integration-map.md`** y 13 docs de detalle en **`docs/02-modules/`** (~1.1 MB).
- **Incidente:** los 13 agentes escritores + re-run de auditoría fallaron por **límite de sesión**; consolidé yo desde el journal. La reconciliación de eventos se recomputó **mecánicamente** contra los 12 specs reales (262 emitidos → 40 canónicos; 66 fantasmas).
- **Sigue:** aprobación **OK FASE 2** → Fase 3 (Definición del MVP), que recomienda **Opus · esfuerzo alto** (ya activo).
- **D1–D6 RESUELTAS** por Jorge (2026-07-31) y aplicadas a `docs/02-functional-map.md` §6 + `02b` §8. Ya no bloquean.
- **⚠️ Lo más importante para Fase 3:** la **recalibración de alcance** — CRM de vendedores, no plataforma de seguros. Gran parte de la profundidad vertical catalogada sale del alcance.
- **OQ abiertas:** OQ-2 (canales/volumen reales), OQ-4 (herramientas/etapas de hoy). No bloquean.

## Key Decisions Log
<!-- fecha | decisión | por qué | alternativas descartadas -->
| Fecha | Decisión | Por qué | Alternativas descartadas |
|---|---|---|---|
| 2026-07-30 | Producto: sistema web de captura/gestión/seguimiento de leads (entrada → ganado/perdido → medición) | Prompt maestro | — |
| 2026-07-30 | Referencia principal: GoHighLevel (patrones sí, bloat no) | Prompt maestro | Copiar 1:1 GHL |
| 2026-07-30 | Anclas MVP: **Pipeline** + **Calendario integrado** | Prompt maestro | — |
| 2026-07-30 | Stack se decide en **Fase 5**; metodología **vibecoding**, sin horas-hombre | Prompt maestro | — |
| 2026-07-31 | **Usuarios = vendedores EE.UU.**, ~**50**; **USD**; roles admin/supervisor/vendedor; responsive | Fase 0 · B1 | Mercado CL; CLP |
| 2026-07-31 | **Cierre/profit:** columnas configurables como "cerradas" suman **profit = valor del deal** por vendedor; comisión post-MVP | Fase 0 · B1/B2 | Estado ganado fijo; comisión en MVP |
| 2026-07-31 | **Vertical inicial Seguros**, core **agnóstico** (pipeline/etapas/campos configurables) | Fase 0 · B2 | Hardcodear seguros |
| 2026-07-31 | **Multi-tenant-ready**; hoy single-tenant | Fase 0 · B2 | Solo tenant único |
| 2026-07-31 | **UI en-US**, i18n-ready; código/datos/docs EN; conversación ES | Fase 0 · B2 | UI es-CL |
| 2026-07-31 | **Comms:** SMS+email+llamada; WhatsApp futuro; **Aloware** integración llamadas/SMS (contratado) | Fase 0 · B2 | WhatsApp-first |
| 2026-07-31 | **Modelo de aislamiento:** NO hay asignación/ruteo central en MVP. **Cada vendedor es un espacio aislado**: sus leads, sus llamadas, su pipeline; **solo ve lo suyo**. (Visibilidad de supervisor/admin y si el pipeline es per-user configurable → confirmar en B4) | Fase 0 · B3 (Q2) | Round-robin / cola compartida / asignación por supervisor |
| 2026-07-31 | **Deal value = prima anual** (editable), el pipeline lo suma por vendedor | Fase 0 · B3 (Q4) | Prima mensual / face value / manual |
| 2026-07-31 | **Agendamiento:** hoy por llamada + manual; **Google Calendar sync deseado**; MVP = calendario interno + recordatorios + registro no-show; telefónico como caso principal (Aloware) | Fase 0 · B3 (Q5) | Booking link auto en MVP; Outlook |
| 2026-07-31 | **Visibilidad:** vendedor ve solo lo suyo; supervisor/admin vista global. **Ranking = módulo público** para TODOS (podio 1-2-3 + listado por ganancias), fin **motivacional** | Fase 0 · B4 (Q1a) | Ranking solo para admin |
| 2026-07-31 | **Pipeline:** plantilla común configurable + ajuste del propio por vendedor | Fase 0 · B4 (Q1b) | Pipeline 100% per-user desde cero |
| 2026-07-31 | **Línea:** Life — **Final Expense + producto de vida con inversión (interpretado IUL/cash-value)**; demo sobre línea representativa | Fase 0 · B4 (Q2) | Auto/home P&C; commercial P&C |
| 2026-07-31 | **Reglas:** enfriado = 7d sin actividad (config); motivos de pérdida base editables; reciclaje = acción manual en MVP | Fase 0 · B4 (Q3) | — |
| 2026-07-31 | **Dashboards:** vendedor = mi día + mi funnel + mis ganancias; admin = ranking + funnel agregado + ganancias equipo | Fase 0 · B4 (Q4) | — |
| 2026-07-31 | **Restricciones:** infra < $100/mes inicial; **TCPA + CCPA** desde diseño; sin hitos de fecha; diferenciador = simplicidad + velocidad + pipeline por vendedor + ranking en vivo | Fase 0 · B4 (Q5) | — |
| 2026-07-31 | **Término UI:** métrica del vendedor = **"Earnings"** (no "Profit") | Fase 0 · B4 (Q1a) | "Profit" en UI |
| 2026-07-31 | **OQ-1 resuelta: el segundo producto es IUL** (vida con valor en efectivo), no commercial P&C | Respuesta de Jorge | Commercial P&C |
| 2026-07-31 | **OQ-3 resuelta: leaderboard ALL-TIME + TIEMPO REAL** en v1 | Respuesta de Jorge | Reset mensual en v1 |
| 2026-07-31 | **Consecuencia de diseño:** `period_key` se escribe en CADA fila del ledger desde el día 1 → un reset mensual futuro es un cambio de config, nunca una migración | Fase 2 | Solo total all-time |
| 2026-07-31 | **Ledger de Earnings = append-only de deltas firmados**, dueño único: módulo 7 (Earnings & Leaderboard). Pipeline emite, nunca totaliza; Reporting lee | Fase 2 · rulings | Ledger en Pipeline / en Reporting |
| 2026-07-31 | **Módulo "Scoring y Asignación" ELIMINADO**; sobrevive solo "Priority & Work Queue" (priorización dentro de la cartera propia, sin ruteo) | Fase 2 | Round-robin/colas compartidas |
| 2026-07-31 | **Conversaciones + puente Aloware = UN módulo** (`Communications`) | Fase 2 | Módulos separados (2 puntos de consentimiento) |
| 2026-07-31 | **Una sola autoridad de consentimiento:** Contacts 360 emite `consent.updated`; los demás son enforcers | Fase 2 | Consentimiento repartido |
| 2026-07-31 | **Un solo objeto `activity`** (módulo 5); Calendar posee `meeting` y enlaza | Fase 2 | Task list separada del timeline |
| 2026-07-31 | **Timeline derivado (proyección), nunca escrito directo** → WhatsApp futuro no toca consumidores | Fase 2 | Escritura directa al timeline |
| 2026-07-31 | **Automatizaciones = Playbooks curados** (catálogo cerrado + vocabulario plain-English); constructor de condiciones genérico CORTADO | Fase 2 | Blank-canvas builder tipo GHL |
| 2026-07-31 | **Una automatización NUNCA puede cerrar un deal** (no puede escribir en el leaderboard público) | Fase 2 | Automatizar cambios a Closed |
| 2026-07-31 | **Supresión/DNC a nivel tenant por teléfono E.164**, pero respondiendo solo "bloqueado/no bloqueado" sin atribución (resuelve el choque TCPA vs silo) | Fase 2 | Mensaje con detalle → fuga cross-silo |
| 2026-07-31 | **Merge de contactos entre dueños distintos: prohibido por defecto** (mueve dinero en un tablero público); solo admin, auditado, con corrección de earnings | Fase 2 | Merge automático |
| 2026-07-31 | **Envelope obligatorio en todo evento** (event_id, tenant_id, owner_user_id, actor, occurred/recorded_at, schema_version, source_system, correlation_id) + idempotencia por clave natural | Fase 2 | Eventos sin envelope (ninguno lo traía) |
| 2026-07-31 | **⚠️ RECALIBRACIÓN DE ALCANCE: esto es un CRM de VENDEDORES, no una plataforma de seguros.** El seguro es el caso de uso actual, no el eje del diseño. La profundidad vertical (tele-app con carrier, underwriting chase, placement/persistencia, draft dates, segmentación FE/IUL) queda **documentada como profundidad futura, fuera de alcance**. Solo sobrevive lo que protege el dinero o la ley: speed-to-lead, TCPA/DNC/ventanas de llamada y el guard de unidad de prima | Jorge, respuesta a D1/D3 | Producto insurance-specific |
| 2026-07-31 | **D1: Earnings = entrar a una columna marcada como "cuenta como Earning"**; sin submitted/issued ni placement | Jorge · D1 | Acreditar en issued; doble columna |
| 2026-07-31 | **D3: UN tablero, un número** (sin pestañas por producto) | Jorge · D3 | Tableros por línea FE/IUL |
| 2026-07-31 | **D4: el VENDEDOR ES EL CLIENTE** → libertad total para configurar sus etapas y qué columnas cuentan como Earnings; ranking se actualiza al instante. Se revoca la restricción del crítico | Jorge · D4 | Etapas fijas por plantilla |
| 2026-07-31 | **Guardarraíles de D4** (no restringen a Jorge): el gate exige valor del deal antes de entrar a columna de Earnings, y todo cambio de flag emite `pipeline.stage_config_changed` + recalcula el ledger de ese vendedor | Fase 2 · consecuencia de D4 | Números públicos sin explicación ni auditoría |
| 2026-07-31 | **MVP = 68 items** (de 549 puntuados). Composición: −17 de pulido, +19 de plomería que sostiene el flujo y el número público | Fase 3 · doble crítica | MVP de 229 items (lo que proponían los scorers) |
| 2026-07-31 | **Etapas tienen `stage_type` (open/earning/lost); AMBOS gates (prima y motivo de pérdida) se enganchan al TIPO, nunca al nombre** | Fase 3 · crítico B | Gate atado al nombre "Closed-Won" → renombrar la columna lo evadía |
| 2026-07-31 | **Ledger forward-only y no retroactivo:** desmarcar una etapa NO borra deltas ya acreditados; marcarla NO re-puntúa tarjetas ya dentro. Correcciones solo vía `value_correction`/`reversal`/`manual_adjustment` | Fase 3 · ruling | Recomputo silencioso retroactivo |
| 2026-07-31 | **UNA sola implementación de idempotencia** (webhook upsert + earnings exactly-once + celebración una vez + reversa) con un solo test suite | Fase 3 · ambos críticos | 4 implementaciones en 4 módulos |
| 2026-07-31 | **Sprint 0 = spike de Aloware** antes de construir UI dependiente; **10DLC se registra ya** + modo de lanzamiento sin SMS especificado | Fase 3 · ambos críticos | Aloware tratado como plomería (complejidad 12) |
| 2026-07-31 | **Bloqueo duro fuera de la ventana horaria del lead** (se elimina la atestación ámbar: generaba prueba en contra) + **break-glass admin auditado** en el gate | Fase 3 · crítico B | Warn ámbar con checkbox |
| 2026-07-31 | **Añadidos críticos:** búsqueda global, hoja de cierre post-llamada con próximo paso obligatorio, `attempt_count` en la tarjeta, edición de valor del deal, verbo "nueva oportunidad sobre contacto existente", edición de contacto, transferencia de propiedad auditada, modo degradado del dialer + UI de estado de llamada, datos demo sembrados | Fase 3 · crítico B | Flujo que obliga a salir del producto |
| 2026-07-31 | **Cortados:** kiosco/TV, SSE (→ polling 5s), wizard CSV, pantalla de config admin, librería de plantillas, escalera de recordatorios (→1 envío), push PWA + SMS al vendedor, 7 colas (→2 superficies), lista de excepciones del supervisor, snooze | Fase 3 · crítico A | MVP inflado de pulido |
| 2026-07-31 | **Email diferido a V1.1**; notificaciones móviles = in-app + escritorio (costo real de speed-to-lead declarado, no escondido) | Fase 3 | Email en MVP; push móvil |
| 2026-07-31 | **Drag & drop se mantiene en escritorio** (rechazo la propuesta de cortarlo); la carrera undo-vs-celebración se resuelve **retrasando la celebración por la ventana de undo (5s)** | Fase 3 · rechazo a crítico A | Move-sheet en todos los dispositivos |
| 2026-07-31 | **OQ-1 RESUELTA:** el producto "con inversión" es **IUL** (Indexed Universal Life), no commercial P&C. Línea = **Final Expense + IUL** | Jorge, post-GATE 1 | Commercial P&C |
| 2026-07-31 | **OQ-3 RESUELTA:** leaderboard **all-time y en tiempo real** por ahora. Reset mensual queda como **opción futura** (diseñar el modelo de datos para permitirlo sin rediseño) | Jorge, post-GATE 1 | Reset mensual desde v1 (recomendado por investigación) |
| 2026-07-31 | **Jorge NO lee ni valida código: valida por COMPORTAMIENTO en pantalla.** Consecuencia de primer orden: toda garantía debe ser **mecánica** (constraint de BD, trigger, test que rompe el build, invariante en producción o síntoma visible). Una regla que depende de que alguien se acuerde NO es una garantía | Jorge · P1 Fase 5 | Revisión humana de código como control de calidad |
| 2026-07-31 | **Stack = variante B2:** TypeScript/Node 24 + React Router 8 + Drizzle + Postgres gestionado + pg-boss + SSE/LISTEN-NOTIFY + R2 + better-auth, sobre contenedores gestionados en EE.UU. | Fase 5A · 7,76 vs 7,10 vs 5,04 | Rails/DigitalOcean (2º) · Vercel+Supabase (eliminada) |
| 2026-07-31 | **Vercel + Supabase ELIMINADA, no puntuada a la baja:** su fuga cross-silo por caché de borde es invisible para sus 4 controles, invisible en desarrollo y **incentivada por su propio modelo de costos** | Fase 5A · puerta de visibilidad del error | Serverless por velocidad de construcción |
| 2026-07-31 | **Cero servidores que administrar** (plataforma gestionada obligatoria) + **datos y cómputo en región EE.UU.** + **desarrollo a costo cero** = puertas duras, no preferencias. Eliminaron el VPS que había ganado el veredicto previo | Jorge · P2/P3/P5 Fase 5 | VPS con Kamal (más barato pero exige operador) |
| 2026-07-31 | **Cómputo en EE.UU. se mantiene** aunque Jorge dijo "da igual si es gratis": la alternativa barata (Cloudflare, ~USD 5) tampoco es $0, no sostiene proceso residente y reintroduce la fuga cross-silo. No compra el $0 buscado | Fase 5A · decisión de Claude, delegada por Jorge | Cómputo global con datos en EE.UU. |
| 2026-07-31 | **Topología PLEGABLE:** los 3 procesos son configuración de despliegue, no supuesto arquitectónico. Se despliega como 1 en el escalón barato y se separa después sin rediseño | Jorge · presión de costo | 3 procesos fijos desde el día 1 |
| 2026-07-31 | **El Postgres de pago con backups (USD 19) es la única línea innegociable.** Ledger append-only sin job de recomputo: perderlo es pérdida total y definitiva | Fase 5A | MVP 100% en tiers gratuitos |
| 2026-07-31 | **Dos documentos aprobados tienen bugs de especificación**, declarados como corrección explícita: (1) los presupuestos de bundle/TTI de Fase 4 son **mutuamente insatisfacibles** (250 KB gzip → TTI ~2,4-3,0s contra requisito de 2,0s; harían falta ~120-150 KB); (2) la promesa de leaderboard **sub-2s es imposible por construcción**, porque R1.3 excluye asientos de menos de 5s. Fase 5 publica UNA tabla de números y declara cuál se movió | Fase 5A · ARR | Arreglarlos en silencio |

## Domain Glossary
| ES | EN | Definición (provisional) |
|---|---|---|
| Lead | Lead | Contacto potencial que entra al sistema |
| Oportunidad | Opportunity | Proceso de venta concreto asociado a un contacto |
| Cartera | Book of business | Leads/oportunidades de las que un vendedor es dueño (aislada por usuario) |
| Etapa / Columna | Stage / Column | Fase del pipeline; algunas marcadas como "cerradas" |
| Profit | Profit | Suma de deal values cerrados por vendedor |
| Deal value | Deal value | Prima anual de la póliza (editable) |
| No-show | No-show | Reunión agendada a la que el lead no asiste |

## Integrations (targets)
- **Aloware** — dialer/contact-center US (llamadas + SMS). Contratado. **Realidad de integración (Fase 1):** NO hay softphone embebible (iframe/SDK) para apps custom — eso es solo para partners nativos (HubSpot/SF/GHL/Pipedrive/Zoho). Para nosotros: **(a)** extensión Chrome "Aloware Talk" (click-to-call), **(b)** APIs por token (Two-Legged Call, Lead/Form, Contact Lookup, SMS, Sequence, Power Dialer), **(c)** **webhooks** (disposition, recording, transcript, AloAi summary, SMS). El registro automático de llamadas es NUESTRO build sobre esos webhooks. **Compliance nativo:** STIR/SHAKEN, A2P 10DLC, DNC, gating TCPA antes de SMS, STOP/opt-out. **Power Dialer** (no predictivo → evita riesgo TCPA). Ojo: overage ~$0.02–0.04/min.
- **Google Calendar** — sync deseado; conexión por-usuario self-service; reserva auto-crea actividad ligada al deal. Prioridad MVP vs V1.1 → Fase 3.

## Research-derived design guidance (Fase 1)
- **Leaderboard nativo = diferenciador #1**: NINGÚN CRM grande (ni GHL) lo trae nativo; siempre es add-on pagado o ausente. DigitalBGA valida el ranking público en telesales de Final Expense.
- **Leaderboard bien hecho:** default **reset mensual** + toggle All-Time; podio 1-2-3 + **auto-rank del que mira** aunque esté fuera del podio (patrón Close top10+2); categoría secundaria "Most Improved"; celebración por evento al entrar a columna Closed; vista kiosco full-screen para TV.
- **Closed→Earnings:** un solo gesto (drop de tarjeta en columna Closed) actualiza estado + Earnings + re-rankea; **exigir prima anual antes de entrar a Closed** (gating por campo requerido, patrón HubSpot).
- **Intake seguros:** leads comprados llegan por **ping-post** y se enfrían en minutos → **speed-to-lead** = palanca #1; botón "Call now" 1-tap (Aloware) al aterrizar; guardar **certificado de consentimiento del vendor** + **flag TCPA** que viaja a cada llamada/SMS.
- **UX núcleo:** timeline unificado por lead (call+SMS+email+notas), vista "My Day", Cmd+K que busca y ejecuta, tarjeta kanban con valor/días-sin-tocar/próxima actividad, alerta de estancamiento en el tablero.
- **Permisos:** evitar el binario de GHL (todo vs mío) — necesitamos la capa intermedia supervisor/admin = global.
- **Simplicidad:** single-tier (el producto base es TODO), sin bloat de agencia, mobile first-class, dedupe en el punto de entrada.

## Pipeline hypothesis (provisional — validar en Fase 1)
Propuesta de etapas para el vertical Seguros (US), a refinar:
`New Lead → Attempted/Contacted → Engaged (Qualified) → Quoted → Application/Underwriting → Closed Won (Policy Issued) → Closed Lost`. Columnas "cerradas" = *Closed Won* (suma profit) y *Closed Lost* (con motivo tipificado).

## Assumptions
- (VALIDADO) UI en-US; WhatsApp-first descartado; sin motor de ruteo en MVP.
- (PENDIENTE-default) Canales de lead: mayoría comprados + referidos + inbound (Jorge no precisó; validar).
- (PENDIENTE) Línea de seguro específica (auto/home, life, final expense, health/Medicare, commercial) → afecta ticket, ciclo y etapas. Confirmar B4.
- (PENDIENTE) Ticket/ciclo en USD sin número duro → usar rangos de industria de Fase 1.
- (PENDIENTE) Ley de datos EE.UU.: TCPA (consentimiento SMS/llamadas vía Aloware), CCPA. Confirmar B4.

## Open Questions
- ~~OQ-1~~ **RESUELTA: IUL.** · ~~OQ-3~~ **RESUELTA: all-time + tiempo real.**
- **OQ-2:** Canales reales de lead + volumen mensual + calidad.
- **OQ-4:** Herramientas actuales y etapas reales de hoy.

### Decisiones D1–D6 — RESUELTAS por Jorge (2026-07-31) · detalle en `docs/02-functional-map.md` §6
- **D1 · Earnings se acredita al entrar el lead a una columna configurada como "cuenta como Earning". Punto.** Sin distinción submitted/issued, sin columna "Issued AP", sin maquinaria de placement. Puede existir un campo descriptivo `policy_type` y hasta ahí.
- **D2 · ADOPTADO:** el gate pregunta *mensual o anual*, guarda ambos, muestra el anual (evita el error 12×).
- **D3 · UN solo tablero, un solo número.** Sin pestañas FE/IUL, sin tablero de pólizas ganadas. "Vendedor consigue ventas y listo."
- **D4 · Libertad total de configuración por vendedor — EL VENDEDOR ES EL CLIENTE.** Cada uno configura sus etapas Y qué columnas cuentan como Earnings; al caer un lead ahí, su total y su puesto se actualizan en el ranking compartido. Se **revoca** la restricción que pedía el crítico.
- **D5 · Diferido a post-MVP** (sin modelo de turnos/presencia en v1).
- **D6 · Campos `carrier`, `policy_number`, `draft_date` capturados desde el día 1, pero SIN flujo de chargeback/persistencia/conciliación.** Campos, no maquinaria.

## Next Steps

### ✅ LEVANTAMIENTO COMPLETO — Fases 0 a 7 cerradas y aprobadas (2026-07-31)
El proceso del `PROMPT-MAESTRO` terminó. Lo que sigue es construcción.

### 🔴 SPRINT 0 — va ANTES del Sprint 1, y bloquea
Ninguna UI dependiente de llamadas/SMS se planifica como si Aloware fuera plomería resuelta.

| # | Puerta | Por qué bloquea |
|---|---|---|
| **0** | **Verificar región EE.UU. en el plan de hosting a contratar** | **Puede DAR VUELTA la decisión de stack** hacia Rails/DigitalOcean. Va antes de crear ningún recurso y antes de escribir una línea. |
| 1 | El silo de punta a punta: contexto fijado como primera sentencia en CADA unidad de trabajo (request, job, relay, importador, webhook, export) | Si no pasa, no se firma nada más |
| 2 | El puente de codegen de eventos: JSON Schema → tipos TS + enum PG + CHECK | Agregar un campo sin regenerar debe ROMPER el build |
| 3 | Tormenta de reintentos: 20.000 webhooks en 60 s contra el proceso de ingesta | Decide si el bulkhead alcanza |
| 4 | SSE detrás del proxy del proveedor | No está documentado; si no sobrevive, hay que identificar el reemplazo AHORA |
| 5 | Bundle y primer paint MEDIDOS | **Fija los dos presupuestos que hoy están sin número** (E6/R7) |
| 6 | Drag a 60 fps con 500 tarjetas reales | También revalida la altura de tarjeta 120/156 |
| 8 | El camino del dinero probado ANTES de escribir una pantalla | Round-trip exacto, transacción del gate, rechazo del UPDATE por privilegio |
| 9 | Simulacro de restauración cronometrado | El ledger es irreconstruible |
| 11 | **Aloware contra la cuenta real** | Firma de webhooks, reintentos, orden, vocabulario de disposiciones, aviso de grabación, forma real de la ráfaga |

**En paralelo y con reloj externo: el registro 10DLC.** Semanas de trámite, puede ser rechazado. **Bloqueado esperando que Jorge decida quién firma** (la entidad de la agencia del cliente o la nuestra).

### 🟢 SPRINT 1 — orden de construcción por dependencias (nunca por tiempo)

| # | Historia | Skill / agente | Modelo · esfuerzo |
|---|---|---|---|
| 1 | Fundaciones de datos: `tenant`, `app_user`, el arnés de RLS, el loop de endurecimiento y los gates de esquema en CI | `db-migration` + `db-guardian` | Opus · alto |
| 2 | Auth, sesión y el contexto de scope por unidad de trabajo | `security-auditor` | Opus · alto |
| 3 | **La espina dorsal del dinero:** `earnings_ledger`, triggers append-only, revokes, los definers, `leaderboard_read` | `db-migration` + `db-guardian` + `story-to-test` | **Opus · máximo** |
| 4 | Contactos + intake (con dedupe) | `new-module` | Sonnet · medio |
| 5 | Pipeline kanban: etapas, `stage_type`, **ambos gates** | `new-module` + `ux-reviewer` | Opus · alto |
| 6 | Calendario + recordatorios (worker) | `new-module` | Sonnet · medio |
| 7 | Leaderboard público + celebración | `new-component` + `ux-reviewer` | Sonnet · alto |
| 8 | My Day + notificaciones | `new-module` | Sonnet · medio |
| 9 | Integración Aloware (**bloqueada por la Puerta 11**) | `new-endpoint` + `security-auditor` | Opus · alto |
| 10 | Datos demo sembrados | `demo-data` | Sonnet · medio |

**Por qué ese orden:** el dinero va tercero, antes que cualquier pantalla, porque el ledger es el único artefacto que el producto no puede reconstruir. Y va después de auth porque necesita el contexto de scope para probar el silo.

### Decisiones abiertas que Jorge confirma cuando quiera (ninguna bloquea la escritura; van con mi recomendación): propiedad del registro 10DLC (agencia del cliente vs nuestra); grabación de llamadas si el aviso no se dispara en el two-legged → *reco: desactivar a nivel de cuenta*; retención de payloads crudos → *reco: 60 días*; atajos de una tecla → *reco: apagados por defecto los primeros 30 días*; Sentry Team USD 26 pre-aprobado para activar el día del primer incidente; confirmar que sin email no hay reset de contraseña autogestionado; y si habrá una 2ª persona con acceso en 12 meses (dispara +USD 51 de saltos de plan).
4. **Sprint 0 — primer ítem, antes de crear ningún recurso:** verificar región EE.UU. en el plan de hosting a contratar. Si falla, la decisión de stack se da vuelta hacia Rails/DigitalOcean.
5. **10DLC: arrancar YA**, en paralelo, no después. Semanas de trámite y puede ser rechazado.
6. **Insumos que Fase 5 hereda y NO puede ignorar:**
   - El spike de Aloware es Sprint 0 y bloquea todo lo dependiente; **10DLC hay que registrarlo ya**.
   - La proyección pública del leaderboard **excluye asientos más jóvenes que la ventana de undo (5s)** — así se cierra la carrera undo/celebración sin retrasar la escritura.
   - Los gates se enganchan a `stage_type`, nunca al nombre de la etapa, y se validan **server-side en todas las rutas** (drag, move-sheet, teclado, wrap-up "Sold", API cruda).
   - El silo es **scoping a nivel de fila en la capa de datos** con not-found (nunca 403, porque un 403 confirma que el registro existe).
   - Transporte de eventos (dispatcher in-process vs cola durable) = decisión de Fase 5; el catálogo de 49 eventos es agnóstico al transporte pero exige idempotencia y replay.
   - Presupuestos de performance de R6 van al CI y **rompen el build**.
   - La lista protegida de 10 detalles se convierte en aserciones `DEMO-01..DEMO-10` en la suite de aceptación.

### Pendientes menores de Fase 4 (no bloquean)
- Altura fija de tarjeta 120px desktop / 156px móvil: revalidar contra un render real de 500 tarjetas durante el spike.
- Fuente de datos para resolver zona horaria del lead (tabla zip→tz vs código de área): decidir en Fase 5.
- El chip de contacto reciente quedó azul (no ámbar) para no degradar la señal de bloqueo — confirmar con quien lleve la narrativa de cumplimiento.

### D7–D9 abiertas
- **D7 · Selector de período en el ranking** (Today/Week/Month/All-time, default All-time). *Reco: adoptar* — el tablero all-time el día 1 son 50 filas de $0 y el demo muere; `period_key` ya está en cada fila del ledger. Es un filtro, no un segundo tablero.
- **D8 · ¿Las ventas históricas importadas escriben en el ledger?** *Reco: NO* — el ledger arranca en el go-live y el tablero se rotula honestamente ("Desde el lanzamiento"). Si quieres historia, va como saldos iniciales ingresados por admin y auditados.
- **D9 · Grabación de llamadas:** Aloware graba a nivel de CUENTA y no está verificado si el aviso legal se dispara en la llamada por API. CA/FL/PA/IL/WA/MA exigen consentimiento de ambas partes. *Reco:* verificar en el spike; si no se dispara, **desactivar grabación a nivel de cuenta** para el MVP.

## Archivo (fases cerradas)
1. ~~GATE 1~~ y ~~GATE 2~~ aprobados.
2. Fase 2 (Opus/alto): mapa funcional completo por módulo (propósito, funcionalidades, pantallas+estados, datos, eventos emit/consume, automatizaciones, permisos, KPIs) + capacidades transversales → `docs/02-functional-map.md` y `docs/02b-integration-map.md` (catálogo de eventos + Mermaid + 3–5 historias de integración).
3. Anclar todo en Fase 0 (silos, Earnings, Aloware, leaderboard) y Fase 1 (Top 20 patrones, diferenciadores).
