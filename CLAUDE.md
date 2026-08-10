# CLAUDE.md — constitución del proyecto

> **Estado e historia viven en [`CONTEXT.md`](CONTEXT.md). Leelo primero, todas las sesiones.**
> Este archivo dice _cómo se trabaja y qué no se puede romper_. `CONTEXT.md` dice _dónde estamos_.
> Si los dos se contradicen, gana el **código**, y quien lo note corrige el archivo en el mismo turno.

---

## 1 · Qué es

CRM de leads para **~50 vendedores de seguros de vida en EE.UU.** (Final Expense + IUL): cada
vendedor trabaja un libro aislado, las llamadas y SMS pasan por **Aloware**, y hay un
**leaderboard público de Earnings en tiempo real** que rankea a todo el equipo.

**Es un CRM para vendedores, no una plataforma de seguros.** El seguro de vida es el caso de uso
actual, no el eje de diseño. **El vendedor es el cliente** (D4): cada uno configura sus etapas y
cuáles cuentan como Earnings.

## 2 · Diferenciador vs. mesa

**El diferenciador es el tablero público de Earnings.** Es lo único que ningún CRM grande trae
nativo, y es lo que se muestra en el demo. Ahí va el esfuerzo de innovación: el ranking compartido,
el selector de período, la celebración, la ventana de undo de 5 s, y la propiedad de que
**un número en ese tablero nunca se corrige hacia abajo**.

**La mesa —pipeline, contactos, calendario, My Day, búsqueda global— tiene que ser excelente igual.**
Un vendedor abandona el CRM por un tablero lento o una tarjeta que miente mucho antes de llegar a
apreciar el leaderboard. **Diferenciador ≠ producto completo:** que una superficie no sea el foco
no la exime de sus cuatro estados, de sus permisos ni de su presupuesto.

## 3 · Reglas no-negociables (el contrato)

### La regla que da forma a todas las demás

**Jorge no lee código. Valida por comportamiento en pantalla. No hay revisor de código ni pull
request revisado.**

Entonces una regla es una regla sólo si es una de estas:

- una **restricción de base de datos**, un privilegio revocado o un trigger;
- un **tipo que no compila**;
- un **build que se pone rojo**;
- **un síntoma en la pantalla de un vendedor.**

Cualquier cosa sostenida por _"acordate de…"_, _"un PR que toca sólo este archivo"_ o un comentario
es **documentación, no una garantía** — y hay que decirlo así, no presentarlo como mecanismo.
Corolario: _"sólo el rol migrador puede debilitar esto"_ significa _"Claude escribe una migración y
nadie lee el diff"_. Sólo tres propiedades sobreviven a ese actor: **(a)** un síntoma en pantalla,
**(b)** un gate anclado fuera del árbol de trabajo, **(c)** re-aserción en el deploy y en el arranque.

### Las invariantes, cada una con su test mecánico

| #   | Regla                                                                                                                                                                                                                                                                                                                                                                                                                                                | Qué la hace cierta (test mecánico)                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `tenant_id` es la **columna líder de la PK** de toda tabla y **toda FK es compuesta**. Una referencia cross-tenant es imposible de escribir.                                                                                                                                                                                                                                                                                                         | `tests/integration/silo.test.ts` · `snapshot-chain.test.ts` (una tabla o un índice que ninguna migración declare rompe el build) |
| R2  | Toda tabla con **RLS `FORCE`**, y **toda policy declara `USING` _y_ `WITH CHECK`**. Una policy sólo-`USING` acota lecturas y deja las escrituras sueltas: el vendedor escribe una fila ajena, la escritura **funciona**, la fila desaparece de su vista y nadie se entera nunca.                                                                                                                                                                     | `silo.test.ts` + el loop de `harden()`                                                                                           |
| R3  | **Acceso cross-silo devuelve not-found con scope de dueño. Nunca 403** — un 403 confirma que el registro existe.                                                                                                                                                                                                                                                                                                                                     | `contacts-silo.test.ts` · `DEMO-04` en `contracts/protected-list.json`                                                           |
| R4  | La app **se niega a arrancar** si `DATABASE_URL` nombra un rol que puede saltear RLS. Dos roles en **todos** los entornos: `crm_app` corre, `crm_migrator` posee el esquema.                                                                                                                                                                                                                                                                         | `app/db/boot-assert.ts` · `boot-assert.test.ts` (Puerta G4(a))                                                                   |
| R5  | `earnings_ledger`, `audit_log` y `consent_ledger` son **append-only por trigger _y_ por privilegio revocado**. Forward-only: **no hay job de recomputo**, por diseño. Las correcciones son asientos compensatorios.                                                                                                                                                                                                                                  | `money-path.test.ts` (el trigger cubre `TRUNCATE`)                                                                               |
| R6  | **La plata es `bigint` de centavos detrás del tipo `Money`.** `Number(`, `parseFloat(` y `Math.round(` son **errores de build** fuera de `app/lib/money/**`. Cruza JSON como **string de centavos enteros**, nunca como número JS. **El cliente no hace aritmética de plata, jamás.**                                                                                                                                                                | `eslint.config.js` · `app/lib/money/money.test.ts`                                                                               |
| R7  | La anualización (**×12**) es **sólo del servidor**. Final Expense vende mensual y Earnings es anual: sin el ×12 el tablero público está mal por un factor de doce.                                                                                                                                                                                                                                                                                   | `money-path.test.ts` · `leaderboard-standing.test.ts`                                                                            |
| R8  | Los gates de win y de loss se enganchan a **`stage_type`** (`open \| earning \| lost`), **nunca al nombre de la etapa**. Renombrar una columna no cambia nada. Aplicado server-side en **todos** los caminos: drag, move-sheet, teclado, wrap-up, API cruda.                                                                                                                                                                                         | `close-gate.test.ts` (el sujeto es el **CHECK** de la base; mockear un service layer no probaría nada) · `DEMO-03`               |
| R9  | **Un evento fuera del catálogo canónico de 49 es un bug, no un feature.**                                                                                                                                                                                                                                                                                                                                                                            | `contracts/events/` genera `app/lib/events/**`; el agente `event-checker`                                                        |
| R10 | **Ningún presupuesto se afloja editando un archivo.** Todo va con el brazo `monotonic_down` y anclado en `ref.ci_ratchet`, **dentro de Postgres**. Un presupuesto `null` en un tier aplicado rompe el build (`PERF00x`).                                                                                                                                                                                                                             | `npm run perf` dentro de `npm run verify` · `ci-ratchet.test.ts` · `perf-budgets.test.ts`                                        |
| R11 | Un **componente no puede importar en runtime** `~/routes/**`, `~/db` ni `~/lib/auth/*`. Los `import type` sí.                                                                                                                                                                                                                                                                                                                                        | `scripts/client-server-boundary.test.ts` — probado por mutación con el import exacto que causó el incidente                      |
| R12 | **Un solo umbral de decay:** `cold_threshold_days`, default 7. **No existe** un "rot threshold" separado. Cualquier string, setting o code path que lo mencione rompe el build.                                                                                                                                                                                                                                                                      | `one-decay-threshold.test.ts` (mira el **motor** y el árbol)                                                                     |
| R13 | **La Lista Protegida es ejecutable o no está protegida.** Ningún ítem de MVP puede marcarse hecho con su aserción salteada. `partial` **no** es un estado que pase.                                                                                                                                                                                                                                                                                  | `scripts/protected-list.test.ts` sobre `contracts/protected-list.json`                                                           |
| R14 | Exactamente **un** loader SSR puede servir datos del tablero como HTML. Hoy hay tres, enumerados y acotados por el ratchet `ui.loader_whitelist` en modo `shrink_only`.                                                                                                                                                                                                                                                                              | `scripts/ui-loader-whitelist.test.ts` (`AP005`)                                                                                  |
| R15 | **La ventana de undo son 5000 ms y viven en `app/styles/tokens/timing.ts`.** Cuatro representaciones (TS, CSS, el predicado SQL de la proyección pública, el scheduler de la celebración) generadas de esa única fuente. Existen **dos** intervalos y **nunca** se les da un solo nombre: `undo_deadline` (5000) y `projection_reveal_delay` (5500). Confundirlos mata toda celebración o revela en público una venta que todavía se puede deshacer. | Test de deriva de la Puerta 10: compara **valores, nunca nombres**                                                               |
| R16 | Toda superficie envía **empty, loading, error y no-permission**. Una feature sin los cuatro **no existe**.                                                                                                                                                                                                                                                                                                                                           | `ux-reviewer` · la skill `new-component`                                                                                         |
| R17 | Los componentes leen **sólo la capa semántica** de tokens. Un `--p-*` primitivo fuera de `app/styles/tokens/` rompe el build. Los literales hex viven en **un** archivo.                                                                                                                                                                                                                                                                             | lint · `i18n-checker`                                                                                                            |
| R18 | **WCAG 2.1 AA es un gate:** foco visible, alcanzable por teclado, axe-core con **cero** hallazgos serious o critical. Corre en su propio job de CI.                                                                                                                                                                                                                                                                                                  | `tests/e2e/a11y.spec.ts`                                                                                                         |
| R19 | **Si el servidor no está de acuerdo con el estado optimista, la tarjeta se corrige Y aparece un mensaje visible.** Una corrección silenciosa es cómo un vendedor aprende a desconfiar del tablero.                                                                                                                                                                                                                                                   | `ux-reviewer` · specs de undo                                                                                                    |
| R20 | Las migraciones **no se editan después del merge**. **No hay down migrations: el rollback es la imagen anterior.**                                                                                                                                                                                                                                                                                                                                   | `db:generate` se niega (`DBGEN003`) si la cadena de snapshots está atrás                                                         |

### Definición de Hecho

Una historia está hecha cuando: los cuatro estados están construidos · los permisos se aplican
**del lado del servidor** · el test de aceptación Given/When/Then pasa · la performance está dentro
del presupuesto · el microcopy en en-US está revisado · los eventos emitidos coinciden con el
catálogo canónico · `npm run verify` está verde.

## 4 · Organización y módulos

```
app/
  routes/ui/**      rutas de documento. EXACTAMENTE UNA puede servir datos de tablero como HTML SSR.
  routes/api/**     resource routes — la ÚNICA API de servidor. Todo pasa por la endpoint factory
                    para que el registry generado alimente las suites de cache, silo, auth y topología.
  modules/<domain>/ los 13 módulos de dominio. Organizados POR DOMINIO, nunca por tipo técnico.
  db/schema/**      esquema Drizzle, un archivo por módulo
  db/migrations/**  SQL generado. NUNCA se edita a mano después del merge.
  lib/money/**      el ÚNICO lugar donde se permite aritmética de plata
  lib/events/**     el contrato de 49 eventos, generado desde contracts/events/
  styles/tokens/**  las capas de design tokens (+ timing.ts, la fuente de los 5000 ms)
contracts/          JSON Schema y registros ejecutables (protected-list, ui-loader-whitelist)
scripts/            gates que viven fuera de la app (perf, frontera cliente/servidor, guard de db:generate)
tests/e2e|integration|fixtures
docker/             Postgres local
```

### Límites duros

- **Un módulo comparte EVENTOS, no TABLAS.** Es alcanzable sólo por su entry point público. Meter
  mano en los datos de otro módulo es cómo se saltean el silo y el registro de plata.
- **Un componente no importa servidor en runtime** (R11). El síntoma cuando se rompe no se parece
  en nada a la causa: postgres viaja al bundle del navegador y el tablero de 500 tarjetas renderiza
  las 500 **y nunca arma el drag**, sin error en consola. Si necesitás un helper compartido, va a
  `app/lib/**`, que no importa nada del servidor.
- **`app/routes/api/**` es la única API.** Las rutas UI nunca exponen datos por su cuenta.
- **DDL sólo desde el rol migrador.** `crm_app` no puede crear una tabla, y eso es el punto.

## 5 · Comandos

**Verificados en esta máquina el 2026-08-07**, en este worktree, contra Node v24.12.0, npm 11.6.2,
Docker 29.1.3. Sólo está acá lo que corrí y funcionó.

```bash
npm ci               # ✅ instala desde el lockfile
npm run db:up        # ✅ Postgres 18 en Docker, :5432 — mismo major que producción
npm run typecheck    # ✅ react-router typegen && tsc --noEmit
npm run lint         # ✅ eslint, cero warnings tolerados
npm run format:check # ✅ prettier --check
npm run test         # ✅ vitest — 26 archivos, 243 tests, ~53 s (unit + integración)
npm run perf         # ✅ build + presupuestos: P12 111.068/128.000 · P13 2.462/16.384,
                     #    y el cruce contra ref.ci_ratchet ("5 budgets agree")
npm run verify       # = typecheck && lint && format:check && test && perf. Antes de cada commit.
npm run db:generate  # ✅ reporta "No schema changes"; el guard se niega si la cadena está atrás
npm run dev          # ✅ arranca y sirve /sign-in con 200 (lo verifiqué en :3100, ver gotcha G8)
```

**No corrí `npm run test:e2e` a propósito, y la razón es una regla del producto:** cada corrida
completa acredita **$3.720 reales** en el ledger de Renata (`celebration.spec.ts` cierra un trato
de verdad, y el ledger es append-only sin recomputo). Correrlo deriva el tenant demo. Se corre
cuando hace falta, sabiendo eso, y se resetea antes de un demo comercial.

**`db:migrate`, `db:jobs` y `db:seed` ya estaban aplicados en esta máquina** — lo verifiqué
indirectamente: el cruce del ratchet leyó `ref.ci_ratchet`, y entré al producto con las credenciales
demo. **No los re-corrí** porque `db:seed` se niega si la base ya está sembrada, y con razón.
La secuencia completa desde cero está en [`docs/ARRANQUE.md`](docs/ARRANQUE.md).

**Comandos que existen y no verifiqué en este turno:** `db:down`, `db:reset`, `db:studio`,
`worker`, `start`, `build` (corre dentro de `perf`), `test:e2e`, `test:watch`, `lint:fix`, `format`.

### El orden importa y no es negociable

```bash
npm run db:up && npm run db:migrate && npm run db:jobs && npm run db:seed && npm run dev
```

`db:jobs` **va después de `db:migrate`**: al revés deja la base **irrecuperable** (`harden()` falla
cerrado sobre el esquema `pgboss` sin clasificar, y la migración 0020 es la que lo clasifica). Desde
el 2026-08-03 se niega con `JOBS003` en vez de romper. Y `db:jobs` **no es opcional**: con
`PROCESS_ROLES` incluyendo `worker`, el proceso web pliega el dispatcher adentro y **se niega a
arrancar con `JOBS002`** si pg-boss no tiene esquema.

### Entorno

`.env` está en `.gitignore`, así que **un clon nuevo (o un worktree nuevo) no lo trae y la app no
arranca sin él, por diseño de G4(a)**. Copiar de `.env.example` y generar `SESSION_SECRET` con
`openssl rand -base64 32`. Credenciales demo y datos de prueba: [`docs/ARRANQUE.md`](docs/ARRANQUE.md).

## 6 · Invariantes transversales

| Invariante                                                                                                                    | Archivo de referencia                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Los 5000 ms del undo tienen **una** fuente y cuatro representaciones generadas                                                | `app/styles/tokens/timing.ts` → `ref.timing_constant` |
| Toda aritmética de plata vive en un solo lugar; el resto la consume como string                                               | `app/lib/money/money.ts`                              |
| Los presupuestos se anclan **fuera del árbol**, en el motor                                                                   | `perf-budgets.json` ↔ `ref.ci_ratchet` (mig. 0022)    |
| Los registros ejecutables (qué está protegido, qué loader se tolera) son JSON con test                                        | `contracts/*.json` + su `.test.ts` en `scripts/`      |
| Toda ruta arranca con `app.begin_request` como **primera sentencia**                                                          | `app/db/client.ts` (ADR-015)                          |
| Los payloads de pg-boss son **no confiables**: el handler re-deriva tenancy                                                   | `app/jobs/worker.ts` (ADR-006)                        |
| **Push es una pista, el poll es la verdad.** SSE lleva exactamente **dos** canales y el poller **nunca** se detiene           | ADR-040                                               |
| Paginación **sólo keyset**, con cursores de posición sin firmar                                                               | ADR-019                                               |
| Tres reglas de timezone, **distintas**: tenant business (`period_key`) · user display · lead-local (ventana legal de llamada) | `docs/05-architecture.md`                             |
| Normalizar **no es** validar, y están separadas a propósito                                                                   | `app/lib/phone/e164.ts`                               |
| Los timestamps son `timestamptz`                                                                                              | `app/db/schema/_shared.ts`                            |

### Convenciones

- **Código, esquema, comentarios, commits y docs técnicos en inglés. Strings de UI en en-US.**
  **Conversación con Jorge en español, y este archivo también** (ver §9).
- Named exports. `~/` mapea a `app/`. `import type` para imports de sólo tipo (enforced).
- **Sin `any`**, implícito o explícito. `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`: el acceso por índice es `T | undefined` y hay que manejarlo.
- Errores: lanzá errores de dominio tipados; el boundary de la ruta los convierte en status.
  **Nunca** `catch {}` para hacer pasar un test.
- Archivos `kebab-case.ts`, componentes React `PascalCase.tsx`, **un componente por archivo**.
- Skeletons, no spinners. Drag **sólo en escritorio** (`≥1024px` y `pointer: fine`); move-sheet en
  todo lo demás, y para teclado y tecnología asistiva.
- UI optimista con undo de 5 s en lugar de diálogos de confirmación, donde sea seguro.

### Presupuestos de performance — rompen el build

API p95 < 300 ms · búsqueda global < 200 ms · LCP < 1,5 s con 500 leads · feedback de interacción
< 100 ms · drag a 60 fps sin long task > 50 ms.

Los números aprobados originalmente (250 KB gzip y 2,0 s TTI) son **mutuamente insatisfacibles**, así
que la errata **E6** los tachó: **la medición fija el número, no la aspiración.** El gate que mide es
la **Puerta 11 de Sprint 0**, no la Puerta 8.

| Id  | Qué                           | Medido         | Presupuesto                 | Lo corre                    |
| --- | ----------------------------- | -------------- | --------------------------- | --------------------------- |
| P12 | JS inicial, ruta pipeline     | 111.068 B gzip | 128.000                     | `npm run perf`              |
| P13 | CSS inicial, ruta pipeline    | 2.462 B gzip   | 16.384                      | `npm run perf`              |
| P6  | Drag, 500 tarjetas            | p95 16,8 ms    | 20 / frame 34 / longtask 50 | `test:e2e`, perfil `dnd-ci` |
| P20 | TTI móvil, `/pipeline`        | 2.251 ms       | 2.300 (techo 3.000)         | `test:e2e`, perfil `lh-ci`  |
| N13 | Búsqueda global, p95 servidor | 59,7 ms        | 120                         | `npm run test`, integración |

⚠️ **P20 depende de la máquina** (P12/P13 cuentan bytes; P20 multiplica duraciones observadas). Un
runner más lento mide más, se pone rojo, y `monotonic_down` **se niega** a aflojarlo. Eso es el brazo
funcionando. ⚠️ **P6 está al borde:** la mediana pasa con 0,6 ms de margen y una de cada tres corridas
se pasa con la máquina ocupada. El presupuesto **no se mueve**; la respuesta real es virtualizar el tablero.

## 7 · Alcance

### En alcance — activo / próximo

1. **Virtualización del tablero — cerrar una brecha con el diseño de Fase 4, no una idea nueva.**
   `04b-design-system.md` §2.1 ya especifica _"columns virtualize above 30 cards"_ con la aritmética
   completa (altura de fila fija → offset por índice sin medir layout → ventana de ~60 nodos en
   pantalla sin importar si el tablero tiene 40 o 500 leads). **El código de hoy no lo implementa:**
   `pipeline-columns.tsx` hace `.map()` sobre las 500 tarjetas reales — verificado leyendo el
   componente, no supuesto. Es la brecha la que explica por qué P6 pasa raspando (0,6 ms de margen)
   y por qué el reloj `NEW` tictaqueando falló dos veces (116,7 ms todo, 50,0 ms acotado a lo
   visible con IntersectionObserver, contra 34 de presupuesto): limitar **qué se actualiza** no
   remueve los 500 nodos del DOM, y el presupuesto se diseñó asumiendo que nunca existieran. Con
   virtualización real el problema se disuelve solo.
2. **Cerrar el cruce del ratchet en el CI.** El checker ya falla con `PERF006` cuando el archivo y el
   motor discrepan. Falta sólo lo que es de Jorge: darle a `crm_ci` LOGIN y contraseña **fuera de banda**
   y poner la cadena como secreto `CI_RATCHET_DATABASE_URL`. Hasta entonces el CI imprime "el cruce no corrió".
3. **La mitad percibida del presupuesto de búsqueda.** N13 mide el **servidor** (59,7 ms); nadie mide
   lo que el ojo de la vendedora espera. Es el número de `US-LCP-08`, y P5.3 lo llama una _consecuencia_.
4. **Cerrar los tres `partial` de la Lista Protegida** (`DEMO-07 · 09 · 10`), con sus faltantes escritos
   en `contracts/protected-list.json`.

### Más adelante — dirección declarada, no ahora

- **Módulo Aloware** (Sprint 1 ítem 9) y todo lo que cuelga: la franja de actividad de hoy
  (`day.strip.*`), `DEMO-02 · 05 · 06`, `Save & call`. **Bloqueado por la Puerta 2, que necesita la
  cuenta real y es de Jorge. Tratado como indefinido, no como "por venir pronto"** (confirmado
  2026-08-09): no se vuelve a preguntar el ETA cada sesión, y el trabajo que no depende de Aloware
  (virtualización, loaders, etc.) tiene prioridad sobre esperar.
- **Registro 10DLC** — semanas de trámite, puede ser rechazado. **Aparcado por decisión de Jorge
  (2026-08-01).** El producto lanza SMS-dark igual, así que no bloquea la construcción, sólo la fecha del SMS.
- Módulo de intake (trae `lead_source_id`), reporting, notificaciones, automations (catálogo cerrado).
- Puertas de Sprint 0 sin empezar: **6** (tormenta de 20.000 webhooks), **7** (SSE detrás del proxy),
  **8** (pg-boss bajo estrés de versión), **9** (simulacro de restauración).
- `ref.capability_probe` (E9 está firmada, no implementada) — llega con Aloware.

### No-va — permanente, por decisión

Cada ausencia es una decisión, no un pendiente. **No se relitiga salvo que Jorge lo reabra.**

- **Sin Redis, sin message broker, sin servicio de realtime gestionado.** pg-boss vive _dentro del
  mismo Postgres_.
- **Sin email transaccional en el MVP** (consecuencia asumida: no hay reset de contraseña autogestionado).
- **Sin job de recomputo del ledger.** Forward-only, correcciones por asientos compensatorios.
- **Sin down migrations.** El rollback es la imagen anterior (ADR-025).
- **Sin 403** para un registro que el vendedor no posee.
- **Sin escritura al timeline** — es una proyección derivada.
- **Sin transporte de push adicional.** SSE lleva exactamente dos canales; todo lo demás es polling
  con GET condicional, y el poller no se detiene cuando el push está conectado.
- **Sin automatización que cierre un trato o escriba al leaderboard.**
- **Sin constructor de automatizaciones en lienzo en blanco.** Catálogo cerrado y curado.
- **Sin entorno de staging** (ADR-023): el simulacro de restauración mensual es la verificación pre-producción.
- **Sin cifrado de campo a nivel de aplicación** (ADR-031).
- **Sin tier nocturno de GitHub Actions.** No se pospuso: se **descartó**. §9.4.1 hace que el control
  de costo de este proyecto sea la **ausencia de método de pago**, así que un job programado es un
  gate que se apaga antes de atrapar nada.
- **Sin segundo umbral de decay** (R12), sin pestañas FE/IUL, sin distinción submitted/issued (D1),
  sin maquinaria de chargeback (D6: campos sí, maquinaria no).
- **Sin `any` generado por el ORM.**

### Histórico — ya construido, no lo redescubras

**Sprint 1: 8 de 10 historias cerradas.** Fundaciones de datos + arnés de RLS · auth, sesión y
contexto de scope · espina dorsal del dinero (ledger, `ledger_append`, `annualize`, `leaderboard_read`)
· contactos + dedupe · pipeline + ambos gates · calendario + recordatorios (dominio **y** despachador)
· leaderboard público con undo honrado y celebración · My Day. Falta la **9 (Aloware, bloqueada)** y
la **10 (datos demo, 🟡)**.

**Extra, no planificado y ya en el árbol:** shell de navegación · CI en GitHub Actions · aserción de
arranque G4(a) · undo de 5 s · test de deriva de la Puerta 10 · gate de axe-core con su job · drag de
escritorio · despachador de jobs · celebración · búsqueda global con overlay `Ctrl+K` · quick-add ·
riel de salud de la tarjeta · rank-and-gap · first-run checklist · tablero honesto con chip Demo.

**Puertas de Sprint 0 cerradas:** **0** (región EE.UU. aprobada — Ohio y Virginia) · **3** (camino del
dinero, mayormente) · **10** (los 5000 ms en cuatro representaciones) · **11** (bundle y primer paint
medidos) · **12** (drag a 60 fps con 500 tarjetas) · **13** (contradicciones publicadas).
Parciales: **1** (G1e cerrado), **4** (G4(a) cerrado), **5** (el pliegue existe y corrió).

**Levantamiento completo (Fases 0–7) cerrado y aprobado el 2026-07-31.** 92 ADRs, 45 tablas, 68 ítems
de MVP, 49 eventos, 43 criterios de aceptación. **Eso no se rehace.**

## 8 · Orquestación

**Delegación de un solo nivel: los subagentes no se llaman entre sí.** Cada artefacto existe contra un
fallo real y demostrado de este proyecto; si un linter o una aserción de CI ya lo atrapa, un agente que
repite el check es **teatro**. El razonamiento completo, incluido **qué se descartó y por qué**, está en
[`docs/07-agents-skills.md`](docs/07-agents-skills.md).

### Los 7 agentes (`.claude/agents/`)

| Agente               | Modelo | Cuándo                                                                                                           |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `db-guardian`        | Opus   | **Antes de que aterrice** cualquier cambio a `app/db/schema/**`, `app/db/migrations/**` o SQL crudo              |
| `security-auditor`   | Opus   | Auth, permisos, el silo en la capa de rutas, datos personales, gates de cumplimiento, ingesta de webhooks        |
| `precedence-checker` | Sonnet | **Antes de implementar** algo especificado en un doc de Fase 2–4, y cada vez que se cita un requisito de `docs/` |
| `ux-reviewer`        | Sonnet | Cuando una superficie de UI está terminada, antes de llamarla hecha                                              |
| `event-checker`      | Haiku  | Después de cualquier cambio que emita, consuma o nombre un evento                                                |
| `i18n-checker`       | Haiku  | Después de construir cualquier superficie de UI                                                                  |
| `context-keeper`     | Haiku  | Al cierre de toda sesión donde se tomó una decisión o avanzó una fase                                            |

### Las 7 skills (`.claude/skills/`)

`new-endpoint` · `new-module` · `new-component` · `db-migration` · `story-to-test` · `demo-data` ·
`release-check`. Más los comandos `/sprint-status` y `/handoff`.

### Secuencia típica

**Cambio de esquema:** `precedence-checker` → skill `db-migration` → `db-guardian` → `npm run verify`
→ `context-keeper`.
**Superficie de UI nueva:** `precedence-checker` → skill `new-component` → `i18n-checker` →
`ux-reviewer` → `story-to-test` → `context-keeper`.
**Endpoint nuevo:** skill `new-endpoint` → `security-auditor` → `event-checker` → `story-to-test`.
**Antes de mergear:** skill `release-check`.

### Modelo y esfuerzo por tipo de tarea

Implementar una historia especificada → **Sonnet, medio**. Migraciones y cualquier cosa que toque
plata, consentimiento o el silo → **Opus, alto**. Arquitectura o revertir una decisión firmada →
**Opus, máximo**. Verificación repetitiva → **Haiku**.

**Nunca estimes horas-persona, días, sprints ni esfuerzo de equipo.** Este proyecto se construye
vibecodeando; la única noción de costo permitida es **complejidad técnica relativa**
(simple / media / alta) con sus riesgos y dependencias.

## 9 · Decisiones que se apartan de los documentos

**Regla: si un documento dice lo contrario de lo que hay acá, gana esto.** Las decisiones revertidas
se dejan **tachadas con la razón**, no se borran.

- **La cadena de precedencia manda sobre todo.** El corpus son ~1,9 MB escritos en siete fases y
  **doce afirmaciones aprobadas fueron tachadas después**. Antes de diseñar nada, mirá
  `docs/05-architecture.md` **§0.2 (errata)** y **Parte I (rulings)**: superan a cualquier otro
  documento, incluidas las Fases 2–4. **Leer el texto viejo es el fallo de diseño más probable de
  este proyecto**, y no pone nada en rojo cuando pasa.
- **~~250 KB gzip y 2,0 s TTI~~** — tachados por la errata **E6**: son mutuamente insatisfacibles.
  La medición fija el número. **~~El gate es la Puerta 8~~** → es la **Puerta 11**; G13 publicó la corrección.
- **~~El tablero público re-rankea "en 5 s" (§7)~~** — **aritméticamente imposible en un producto
  correcto**: la proyección pública retiene toda entrada más joven que 5000 + 500 ms. Reemplazado por
  **P21** (6,5 s push / 10,5 s poll-fallback). Asertar el número viejo habría fallado para siempre y
  el "arreglo" habría sido romper el undo.
- **~~Dos umbrales de decay (`rotting_threshold_days` + `cold_threshold_days`)~~** — borrados por **R6**,
  pero seguían **vivos en la base** desde la migración 0001, con su CHECK. Nadie leía la columna, así que
  nada podía notarlo. La migración **0025** los eliminó. Hoy R12 lo hace romper el build.
- **~~Tier nocturno de Actions para P20 y la búsqueda percibida~~** — **descartado, no pospuesto** (§9.4.1).
- **~~"El loader del leaderboard se conserva porque DEMO-10 quiere rango y brecha arriba del pliegue"~~**
  — **era falso**, corregido: §7 pone los primeros diez segundos en la pantalla de inicio del vendedor,
  y el rank-and-gap ya vive en My Day. Lo que ese loader compra es el primer pintado de `/earnings`,
  que es la **segunda** pantalla del demo.
- **~~`SMS_ENABLED` como variable de entorno~~** — es una **columna en `tenant`**. §10.16 prohíbe
  `process.env.SMS*` en todo el árbol; la bandera es alcanzable sólo por `app.compliance_check()`.
- **Este archivo está en español**, contra la convención de §6 que pide docs técnicos en inglés.
  Decisión de Jorge (2026-08-07), porque es el documento que él lee. Los agentes, las skills y los
  docs de `docs/` siguen en inglés. **El código, el esquema, los comentarios y los commits no cambian.**
- **D1–D6 resueltas por Jorge el 2026-07-31**, detalle en `docs/02-functional-map.md` §6. **D7 sí**
  (selector de período sobre un solo tablero) · **D8 no** (el ledger arranca en el go-live) · **D9** se
  verifica en el spike de Aloware. **D5 diferida** a post-MVP.
- **`/earnings` NO debe ser alcanzable sin sesión** — decidido por Jorge (2026-08-09). El ítem
  protegido 1 lo llama _"el tablero público"_, pero "público" significa **dentro de la agencia**, no
  internet abierto: son nombres y ganancias de vendedores identificables. El layout `shell` sigue
  redirigiendo sin cuenta, tal como está hoy. **Pendiente, no bloqueante:** reescribir el título del
  ítem protegido en `contracts/protected-list.json` / `04-ux-flows.md` §7 para que diga "segunda
  pantalla con sesión" en vez de "tablero público", porque el texto viejo sugiere lo contrario de lo
  decidido.

### Decisiones abiertas que son de Jorge, no mías

1. **Cuál de los tres loaders SSR fuera de presupuesto se saca — de baja prioridad, verificado
   2026-08-09.** `scripts/ui-loader-whitelist.test.ts` no empuja a sacar ninguno: pasa en verde
   con los dos "over-budget" tal como están, indefinidamente — sólo se pone rojo si aparece un
   **cuarto**. No hay presupuesto de bytes violado (P12/P13 sólo miden la ruta `/board`; `/earnings`
   y `/my-day` no tienen presupuesto propio). El undo (razón 1 de §1.1) **no aplica a ninguno de los
   dos** — es sobre el move de etapa, no sobre un loader de lectura. La razón real es la 2
   (bloques independientes): confirmado leyendo `my-day.tsx`, el loader hace **un solo** `readMyDay()`
   para toda la página, así que si esa lectura falla hoy se cae **toda** My Day, no sólo el bloque de
   ranking — riesgo estructural real, pero **no confirmado como bug en vivo** (nadie lo disparó ni
   hay test que lo prueba). El del leaderboard no tiene ninguna de las cuatro razones a favor, sólo
   compra el primer pintado de la segunda pantalla del demo. **Reco: no vale la pena todavía** — sin
   build rojo ni síntoma demostrado, rinde menos que los ítems de §7 que sí dependen de nadie.
2. **Propiedad del registro 10DLC** (agencia del cliente vs. nuestra) — reco: la del cliente.
3. **Grabación de llamadas** si el aviso legal no se dispara en el two-legged — reco: desactivar a
   nivel de cuenta.
4. **Atajos de una tecla** — reco: apagados por defecto los primeros 30 días.

## 10 · Gotchas y versiones clavadas

Cada línea es **tiempo que ya se pagó**. Síntoma → causa → regla.

| #   | Síntoma                                                                                                        | Causa                                                                                                                                                                                          | Regla                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | El tablero renderiza las 500 tarjetas y **nunca arma el drag**. Sin error, sin consola, nada.                  | Un componente importó un helper desde `app/routes/api/**` y arrastró postgres + drizzle + better-auth al bundle del **cliente**. También aparece como `ReferenceError: Buffer is not defined`. | R11. Los helpers compartidos van a `app/lib/**`. **Atrapó a Claude dos veces en la misma sesión, y la nota que existía no lo detuvo** — ésa es la diferencia entre una nota y un mecanismo.                                                                       |
| G2  | `npm run dev` muere con `JOBS002`.                                                                             | Falta `npm run db:jobs`.                                                                                                                                                                       | El mensaje nombra el comando. Para servir web sin worker: `PROCESS_ROLES=web,ingest`.                                                                                                                                                                             |
| G3  | La base queda **irrecuperable** después de instalar los jobs.                                                  | `db:jobs` corrido **antes** de `db:migrate`: `harden()` falla cerrado sobre el esquema `pgboss` sin clasificar.                                                                                | El orden es `db:migrate` → `db:jobs`. Desde 2026-08-03 se niega con `JOBS003`.                                                                                                                                                                                    |
| G4  | Migración falla con _"already exists"_ y **revierte la cadena entera** — `crm_test` queda con **cero tablas**. | Un índice creado a mano y nunca declarado en un snapshot; el generador lo propone de nuevo. El migrador de drizzle es **UNA transacción**.                                                     | `snapshot-chain.test.ts`. **Un índice sin declarar es peor que una tabla sin declarar:** la tabla queda sin gestionar, el índice deja la base nueva **inaplicable**.                                                                                              |
| G5  | Una restricción UNIQUE dispara perfecto y la app devuelve **500** en vez de su mensaje diseñado.               | Drizzle **reenvuelve** el error del driver: el SQLSTATE queda un nivel abajo, en `cause`.                                                                                                      | **Una garantía en la base es media garantía hasta que la aplicación sabe reconocer la negativa.** Y una violación **aborta la transacción**: atrapar la negativa y después preguntar el nombre del duplicado son **siempre dos unidades de trabajo** en Postgres. |
| G6  | Búsqueda a **1.053 ms** con el índice correcto ya existente.                                                   | Acotar en un CTE y machear en un LATERAL fuerza scan secuencial del tenant en cada tecla.                                                                                                      | Reescrita como ramas indexadas con `UNION` + `DISTINCT ON` → **59,7 ms**. **El índice ya estaba desde la 0011; el problema era la consulta.**                                                                                                                     |
| G7  | Un e2e verde durante semanas se pone rojo de golpe, sin cambios de código.                                     | `fresh` es cero intentos **Y** llegada de **menos de 60 minutos**. El seed da _"llegó cuando corrió el seed"_: la aserción era cierta una hora y falsa para siempre.                           | **La ventana no se ensancha.** Consecuencia de producto, no sólo de test: **un tablero mostrado más de una hora después de `db:seed` no tiene ninguna tarjeta fresca** — ni riel azul ni `NEW`. Si el demo va a mostrar ese estado, sembrar antes.                |
| G8  | El puerto 3000 está tomado por otra sesión de Claude Code.                                                     | Varios chats levantan dev servers.                                                                                                                                                             | `APP_URL` asume :3000. Para verificar sin conflicto: `npx react-router dev --port 3100`.                                                                                                                                                                          |
| G9  | El webServer de Playwright sale con código 1 y `ECONNRESET` en :3000.                                          | **Docker Desktop se cayó solo.** El dev server anuncia el puerto y **muere en el primer request** cuando no llega a Postgres (pliegue perezoso en dev).                                        | **No es el código.** Reconocerlo rápido.                                                                                                                                                                                                                          |
| G10 | Un test pasa solo y falla en la suite completa.                                                                | **Estado compartido en `crm_test`.** Pasó **tres veces**: ids de tenant asignados a mano que colisionan, `silo.test.ts` creando tablas a propósito, y contaminación entre specs de dinero.     | Hacé la pregunta estática si podés (leer archivos de migración en vez de `information_schema`). Los specs que necesitan un número que no se mueve leen a **Priya**, a la que ningún spec toca.                                                                    |
| G11 | `Ctrl+K did nothing` en un spec, mientras el único test que hacía `focus()` primero pasaba.                    | El spec presiona la tecla **antes de la hidratación**.                                                                                                                                         | Mismo accidente que registra `undo-keyboard.spec` desde el otro lado.                                                                                                                                                                                             |
| G12 | La barra de undo era el **último** elemento enfocable de la pantalla.                                          | Orden del DOM.                                                                                                                                                                                 | Ya arreglado; queda como recordatorio de que el teclado no lo prueba un mouse.                                                                                                                                                                                    |
| G13 | El primer CI falló.                                                                                            | El lockfile era **sólo de Windows** y el CI usaba otro locale.                                                                                                                                 | El compose local y el CI usan **los mismos `POSTGRES_INITDB_ARGS`** (`--locale-provider=icu --icu-locale=en-US`). Sin eso, un orden correcto localmente puede estar mal en la pantalla de un vendedor.                                                            |
| G14 | Un chunk `db-*.js` / `identity-*.js` aparece en el directorio del cliente.                                     | Infraestructura de servidor emitida al directorio del cliente.                                                                                                                                 | **Verificado, no supuesto: ninguna ruta lo descarga.** Cuesta tamaño de deploy, no bytes del vendedor.                                                                                                                                                            |
| G15 | `npm run test:e2e` deja el demo derivado.                                                                      | `celebration.spec.ts` cierra un trato **real**: **$310 × 12 = $3.720** al vendedor con el que entra, y cae en **hoy**.                                                                         | Por diseño — no existe versión que no toque el ledger. **Reseteá antes de un demo comercial.** El CI corre contra su propia base efímera.                                                                                                                         |
| G16 | `db:down` "no borra nada".                                                                                     | Deja el volumen y las filas vuelven.                                                                                                                                                           | Para empezar de verdad: `db:reset && db:up && db:migrate && db:seed`.                                                                                                                                                                                             |
| G17 | Un test se pone verde y "confirma" el silo.                                                                    | Abrir el predicado de dueño del endpoint a `true` **dejó todo pasando**: la policy RLS ya había acotado las filas.                                                                             | **El silo lo sostiene la base**; el predicado es la segunda capa. Los tests prueban la propiedad, no qué capa la entrega. Probá por **mutación** o no probaste nada.                                                                                              |
| G18 | `setState` en el cuerpo de un efecto.                                                                          | Guardar lo que se puede derivar.                                                                                                                                                               | **Derivá** en vez de guardar. Y cargá la consulta junto con la respuesta, para descartar una respuesta tardía de algo que la vendedora ya dejó atrás.                                                                                                             |

### Versiones clavadas y por qué no se suben

- **Node 24+** (`engines`), **PostgreSQL 18** local y en CI — **el mismo major que producción**. La
  suite de integración assertea comportamiento del motor (FORCE RLS, triggers de sentencia, un opclass
  uuid para GIN), así que otro major estaría probando otro producto.
- **Sin `^` en el núcleo:** `react-router` / `@react-router/*` `8.3.0`, `react` / `react-dom` `19.2.8`,
  `drizzle-orm` `0.45.2`, `drizzle-kit` `0.31.10`, `better-auth` `1.6.25`, `postgres` `3.4.9`,
  `zod` `4.4.3`, `playwright` `1.62.1`, `typescript` `5.9.3`, `vite` `8.2.0`, `vitest` `4.1.10`.
  Un bump acá se decide, no se hereda de un `npm install`.
- **`pg-boss` `^12.26.4`** es de los pocos con rango, y tiene su propia puerta pendiente
  (Sprint 0 · Puerta 8: pg-boss bajo estrés de versión).

## 11 · Referencias

No pegar contenido de estos archivos acá — apuntar.

|                                                                                                          |                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`CONTEXT.md`](CONTEXT.md)                                                                               | **Memoria viva.** Estado actual y cada decisión con su razón. Se lee primero, siempre.      |
| [`docs/05-architecture.md`](docs/05-architecture.md)                                                     | **§0.2 errata y Parte I rulings superan todo lo demás.** Riesgo residual declarado en §0.3. |
| [`docs/05b-data-model.md`](docs/05b-data-model.md)                                                       | 45 tablas, ER, diseño del aislamiento                                                       |
| [`docs/05c-closure-register.md`](docs/05c-closure-register.md)                                           | Qué encontraron los revisores y cómo se cerró                                               |
| [`docs/adr/`](docs/adr/)                                                                                 | 92 ADRs                                                                                     |
| [`docs/02b-integration-map.md`](docs/02b-integration-map.md)                                             | El catálogo de 49 eventos                                                                   |
| [`docs/03-mvp-definition.md`](docs/03-mvp-definition.md) · [`03-mvp-stories.md`](docs/03-mvp-stories.md) | Los 68 ítems y los criterios Given/When/Then                                                |
| [`docs/04-ux-flows.md`](docs/04-ux-flows.md) · [`04b-design-system.md`](docs/04b-design-system.md)       | Rulings normativos de UX y el design system                                                 |
| [`docs/07-agents-skills.md`](docs/07-agents-skills.md)                                                   | Por qué existe cada agente y cada skill, y **qué se descartó**                              |
| [`docs/sprint-0/`](docs/sprint-0/)                                                                       | Evidencia de las puertas: G0, G1, G13, R8                                                   |
| [`docs/ARRANQUE.md`](docs/ARRANQUE.md)                                                                   | Levantar el entorno local paso a paso                                                       |
| [`CHECKLIST.md`](CHECKLIST.md)                                                                           | Qué falta, una línea por escenario                                                          |

---

# Cómo trabajar en este repo, cada sesión

## Dinamismo

- **Cuando tengas lo suficiente para actuar, actuá.** No pidas permiso para lo obvio.
- Si hay que elegir, **recomendá una opción y ejecutala**, con la razón en una línea. No presentes
  tres alternativas salvo que la decisión sea realmente de Jorge (negocio, plata, riesgo, algo irreversible).
- **No relitigues lo decidido.** Si está en "No-va" o en "Más adelante", no vuelve a la mesa salvo
  que Jorge lo reabra.
- Preguntas bloqueantes (parar sin entregar nada) **sólo** si avanzar bajo cualquier supuesto sería
  inseguro o dejaría el trabajo inservible. En cualquier otro caso: **hacé todo lo que no dependa de
  la respuesta, y después preguntá.**
- No narres opciones que no vas a tomar ni resumas lo que Jorge ya sabe.

## Verificar en vivo, no suponer

- **El código manda** sobre los docs y sobre este archivo. Antes de dar algo por pendiente,
  comprobalo **corriendo la app o el test — no con un `grep`**.
- **Nada se marca como hecho sin evidencia:** test que pasa, pantalla que se ve, endpoint que responde.
- Si probás con datos de ejemplo, que sean **a escala realista**. Los sets chicos esconden bugs — este
  repo tiene el fixture `perf-500` y 25.000 contactos en cincuenta libros justamente por eso.
- **Probá por mutación.** Un test verde no prueba nada hasta que lo viste ponerse rojo por la razón
  correcta (ver G17). En este proyecto es la norma, no un extra.

## Ritmo

- **Un incremento verificado por turno.** Mejor cinco entregas chicas y probadas que un plan grande
  sin nada corriendo.
- Terminá **cada turno** con estas tres líneas, en este formato:
  - `Hecho:` qué quedó funcionando.
  - `Verificado con:` el comando o la comprobación concreta.
  - `Siguiente:` **un solo** paso, el más chico que aporte valor.
- Actualizá [`CHECKLIST.md`](CHECKLIST.md) **en el mismo turno** en que terminás algo.

## Memoria del proyecto

- **Toda decisión que se tome en la conversación se escribe en este archivo o en `CONTEXT.md` en ese
  mismo turno.** Si no está escrita, no existe, y la próxima sesión la va a volver a discutir.
- Cada bug no obvio que cueste más de un intento → **una línea en §10**.
- Cuando algo de este archivo quede desmentido por el código, **corregilo ahí mismo y decilo**.
- Al cierre de sesión: `context-keeper`. La regla de oro es que **`CLAUDE.md` + `CONTEXT.md` + `docs/`
  basten para retomar sin pérdida** — ya se puso a prueba una vez, cuando un lote de agentes falló a
  mitad de fase.

## Honestidad

- Si un test falla, **lo decís con la salida**. Si salteaste un paso, lo decís. Si algo quedó fuera de
  alcance, lo decís explícitamente **y por qué**.
- No adornes: **"listo" sólo cuando esté probado.**
- **No debilites un presupuesto, un ratchet ni una lista de excepciones para que un build pase.** Ése
  es exactamente el modo de fallo que todo este diseño existe para prevenir.

## Flujo

1. Leé `CONTEXT.md`. Chequeá `docs/05-architecture.md` §0.2 y Parte I **antes de diseñar nada**.
2. Construí. Corré `npm run verify` antes de commitear.
3. Actualizá `CONTEXT.md` y `CHECKLIST.md` al cierre de sesión.
4. **Las puertas de fase son de Jorge. Nunca avances una fase sin un OK explícito.**
