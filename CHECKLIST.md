# CHECKLIST — qué falta

**La fuente de verdad de _qué falta_.** Una línea por funcionalidad o escenario.
Se actualiza **después** de implementar y probar, nunca antes.

> **Regla anti-deriva.** Este archivo no puede convertirse en una cuarta fuente de verdad que se
> desincronice del código. Por eso cada línea dice **quién la verifica**:
>
> - 🤖 **Verificado por máquina** — el comando o el test que lo prueba está nombrado. Si mentís acá,
>   el build se pone rojo.
> - ✍️ **Mantenido a mano** — nadie lo chequea. Vale exactamente lo que valga la última revisión.
>
> Si una línea 🤖 y el código no coinciden, **gana el código** y esta línea se corrige en el acto.

Estado al **2026-08-07**. Verificado con `npm run verify` (243 tests verdes) y entrando al producto.

---

## 1 · Sprint 1 — las diez historias

|     | #   | Historia                            | Nota                                                                                                                                                                                                                                             |
| --- | --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [x] | 1   | Fundaciones de datos + arnés de RLS | 🤖 `silo.test.ts` · `harden()` genera las políticas                                                                                                                                                                                              |
| [x] | 2   | Auth, sesión y contexto de scope    | 🤖 `session-context.test.ts` · `auth-identity.test.ts`                                                                                                                                                                                           |
| [x] | 3   | Espina dorsal del dinero            | 🤖 `money-path.test.ts` — ledger, `ledger_append`, `annualize`, `leaderboard_read`                                                                                                                                                               |
| [x] | 4   | Contactos + dedupe                  | 🤖 `contacts-silo.test.ts` — fixture de colisión con canario a nivel de bytes                                                                                                                                                                    |
| [x] | 5   | Pipeline + ambos gates              | 🤖 `close-gate.test.ts` — gates como CHECK, `stage_move` atómico                                                                                                                                                                                 |
| [x] | 6   | Calendario + recordatorios          | 🤖 `scheduling.test.ts` · `job-dispatch.test.ts` — dominio **y** despachador                                                                                                                                                                     |
| [x] | 7   | Leaderboard público                 | 🤖 `leaderboard-standing.test.ts` · `celebration.test.ts` — undo honrado y celebración                                                                                                                                                           |
| [x] | 8   | My Day                              | 🤖 `home-setup.test.ts` · `rank-and-gap.spec.ts`                                                                                                                                                                                                 |
| [ ] | 9   | **Aloware**                         | ⛔ **Bloqueado por la Puerta 2 de Sprint 0 — necesita la cuenta real, y es de Jorge**                                                                                                                                                            |
| [~] | 10  | Datos demo                          | 🤖 `demo-protected.spec.ts` — siembra por el camino real, se niega a duplicarse, `lost_reason` sembrados, abarca los cuatro períodos con una reversa. **Falta:** negarse a correr en un entorno vivo (necesita `system_constant`, que no existe) |

**Extra, no planificado y ya en el árbol:** shell de navegación · CI en GitHub Actions · aserción de
arranque G4(a) · undo de 5 s · test de deriva de la Puerta 10 · gate de axe-core con su propio job ·
drag de escritorio · despachador de jobs · celebración · búsqueda global con `Ctrl+K` · quick-add ·
riel de salud · rank-and-gap · first-run checklist · tablero honesto con chip Demo.

---

## 2 · Sprint 0 — la escalera de puertas

|     | #   | Puerta                                 | Estado                                                                                                                                                                                                                     |
| --- | --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x] | 0   | Región EE.UU. en el plan a contratar   | ✍️ **Aprobado** — Ohio y Virginia en los tres tipos de recurso. `docs/sprint-0/g0-us-region.md`                                                                                                                            |
| [~] | 1   | Sonda de plataforma                    | ✍️ G1e cerrado (`btree_gin`/uuid probado con planner). **Faltan** `max_connections` real, PgBouncer en modo transacción, y si concede `CREATE EVENT TRIGGER` — **todo requiere la instancia de Render**                    |
| [ ] | 2   | **Aloware contra la cuenta real**      | ⛔ **Bloqueado — es de Jorge.** Bloquea la historia 9 y `DEMO-02 · 05 · 06`                                                                                                                                                |
| [~] | 3   | Camino del dinero                      | 🤖 `money-path.test.ts` — append-only por trigger de sentencia (incluye `TRUNCATE`), exactly-once, gate atómico. **Falta:** proceso muerto a mitad del gate sin dejar lock                                                 |
| [~] | 4   | Silo de punta a punta                  | 🤖 G4(a) cerrado (`boot-assert.test.ts`: se niega a arrancar si el usuario puede saltear RLS). **Falta:** contexto heredado entre job y request en la misma conexión pooleada                                              |
| [~] | 5   | Equivalencia plegado/separado          | ✍️ El pliegue **existe y corrió**: el worker arranca dentro del proceso web y produjo las mismas dos filas terminales que el separado. **Falta lo que da nombre a la puerta:** equivalencia **bajo carga y en los bordes** |
| [ ] | 6   | Tormenta de 20.000 webhooks            | ✍️ No empezado                                                                                                                                                                                                             |
| [ ] | 7   | SSE detrás del proxy                   | ✍️ No empezado                                                                                                                                                                                                             |
| [ ] | 8   | pg-boss bajo estrés de versión         | ✍️ No empezado                                                                                                                                                                                                             |
| [ ] | 9   | Simulacro de restauración              | ✍️ No empezado. Es la verificación pre-producción — **no hay staging, por decisión** (ADR-023)                                                                                                                             |
| [x] | 10  | Los 5000 ms en cuatro representaciones | 🤖 Test de deriva: compara **valores, nunca nombres**, incluida la aserción de que `celebrate_once` no menciona `projection_reveal_delay_ms`                                                                               |
| [x] | 11  | Bundle y primer paint medidos          | 🤖 `npm run perf` (P12 111.068/128.000 · P13 2.462/16.384) + `tests/e2e/tti.spec.ts` perfil `lh-ci` (P20 = 2.251 ms, presupuesto 2.300). **Falta sólo que el CRUCE corra en el CI** — ver §5                               |
| [x] | 12  | Drag a 60 fps con 500 tarjetas         | 🤖 Perfil `dnd-ci`, 2× throttle, contra el **build de producción**: p95 16,8 ms · cero frames perdidos · cero long tasks                                                                                                   |
| [x] | 13  | Publicar las contradicciones           | ✍️ `docs/sprint-0/g13-published-contradictions.md`                                                                                                                                                                         |

---

## 3 · La Lista Protegida — `DEMO-01..10`

🤖 **Todo este bloque lo verifica `scripts/protected-list.test.ts` sobre `contracts/protected-list.json`.**
Un `test` que nombra un id inexistente rompe el build; un `blocked` sin bloqueante rompe el build.
**`partial` no es un estado que pase** — existe para que un ítem a medias _lea_ como a medias en vez de
contar como hecho en silencio.

**Estado real, sin maquillaje: 3 cubiertos · 3 bloqueados · 4 parciales.**

|     | Id          | Detalle                                                                            |                                                                                                                           |
| --- | ----------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [x] | **DEMO-01** | El tablero público re-rankea en una **segunda pantalla** dentro de un poll         | Medido **6.063 ms**, dentro de P21 (6,5 s push / 10,5 s poll)                                                             |
| [ ] | **DEMO-02** | El banner de estado de llamada en los 5–15 segundos mudos del two-legged           | ⛔ Aloware                                                                                                                |
| [x] | **DEMO-03** | El tablero **RECHAZA** el drop en una columna _earning_ y abre la puerta de cierre | El sujeto es el **CHECK** de la base, no un service layer mockeado                                                        |
| [x] | **DEMO-04** | Not-found con scope de dueño — URL ajena pegada, **nunca un 403**                  | Id ajeno, inexistente y malformado son **indistinguibles**                                                                |
| [ ] | **DEMO-05** | Registro de llamada sin esfuerzo y hoja de wrap-up que se abre sola                | ⛔ Aloware — la hoja abre al cerrar el banner, y no hay banner sin call state                                             |
| [ ] | **DEMO-06** | Gate de cumplimiento server-side que bloquea fuera de la ventana legal             | ⛔ Aloware + `lead_local_tz` (llega con intake)                                                                           |
| [~] | **DEMO-07** | La tarjeta kanban como reporte completo — **6 de 7 hechos**                        | Ver §3.1                                                                                                                  |
| [~] | **DEMO-08** | Búsqueda global con `Ctrl+K`, **bajo 200 ms percibidos**                           | Ver §3.2                                                                                                                  |
| [~] | **DEMO-09** | El tablero honesto de go-live                                                      | **Falta** la franja de actividad de hoy (dials · contacts · appointments set) — cuenta desde `call.completed`, ⛔ Aloware |
| [~] | **DEMO-10** | Los primeros diez segundos                                                         | **Falta** que el seed se niegue a correr en un entorno **vivo** (necesita `system_constant`)                              |

### 3.1 · DEMO-07 — la tarjeta

|     | Hecho de `04b` §2.4                                                                        |                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x] | Prima anualizada · días sin tocar · conteo de intentos (`Not called yet`, no `0 attempts`) | 🤖                                                                                                                                                                                                                                                        |
| [x] | Próxima actividad · riel de salud · slot de señal — **los dos calculados en el servidor**  | 🤖 9 tests de integración + 3 e2e, probados por mutación                                                                                                                                                                                                  |
| [x] | Altura fija de tarjeta (120px desktop / 156px móvil, ruling N17)                           | 🤖 `card-height.test.ts` + `card-anatomy.spec.ts`, clavada en `ref.ci_ratchet` (mig. 0024)                                                                                                                                                                |
| [ ] | **Lead source**                                                                            | Diferido a propósito: `lead_source_id` es del módulo de intake. §2.4 dice **no renderizarlo**, no mostrar `Unknown`                                                                                                                                       |
| [ ] | **Chip de contacto reciente** y **`needs reply`**                                          | ⛔ Aloware (historial de llamadas del tenant / SMS entrante). El estado `blocked` espera el mismo gate                                                                                                                                                    |
| [ ] | **Nunca sobre tarjetas importadas** (2ª mitad de la supresión)                             | Necesita `imported_at`, que llega con intake. ⚠️ **El día que aterrice un import CSV, mil tarjetas sin tocar se ponen ámbar a la vez** si no se agrega esa cláusula                                                                                       |
| [ ] | **El reloj `NEW` que tictaquea**                                                           | 🤖 **Rechazado por medición, no diferido.** Tictaqueando todo: 116,7 ms / 84 ms. Acotado a lo visible: 50,0 ms / 53,0 ms. Presupuesto: 34 / 50. **Necesita virtualización o escritura al DOM fuera de React.** El próximo intento arranca de esos números |

### 3.2 · DEMO-08 — la búsqueda

|     |                                                                                                     |                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [x] | La mitad del servidor: `/api/search` sobre nombre, teléfono y email, con scope de dueño             | 🤖                                                                                                                                    |
| [x] | Normalización E.164 (cinco formatos + los últimos cuatro dígitos)                                   | 🤖 **Normalizar no es validar**: un typo devuelve nada, no un rechazo                                                                 |
| [x] | El overlay `Ctrl/Cmd+K` **en el shell**, con sus cuatro estados y `Escape` devolviendo el foco      | 🤖 Asertado en tres pantallas · axe limpio                                                                                            |
| [x] | La ficha de contacto que abre, **sin loader** (el motor forzó la arquitectura que §1.1 quería)      | 🤖 6 tests de integración + navegador                                                                                                 |
| [x] | **N13 — presupuesto del servidor: 59,7 ms p95** sobre 25.000 contactos en 50 libros                 | 🤖 En `ref.ci_ratchet`, brazo `monotonic_down`. El fixture assertea su propio tamaño antes de medir                                   |
| [x] | `Quick-add this number` como **control**, con el duplicado rechazado por una **restricción UNIQUE** | 🤖 Si la fila no es legible, se reporta **sin nombre** — nombrarla sería una filtración entre silos                                   |
| [ ] | Dos de los cuatro campos de §4.11 (`lead_source_id`, nota) y **`Save & call`**                      | Sin columna donde caer / ⛔ Aloware. **Un campo que descarta en silencio lo que la vendedora tipeó es peor que un campo que no está** |
| [ ] | **La mitad _percibida_** — los 200 ms del título del ítem                                           | Es el número de `US-LCP-08`, que P5.3 llama una **consecuencia**, no un presupuesto. **Este ítem está parcial por esto**              |

---

## 4 · Gates transversales — los mecanismos que sostienen el contrato

Todo este bloque es 🤖. Si una línea está en `[x]`, hay algo que se pone rojo.

|     | Gate                                                                                                   | Lo prueba                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [x] | `tenant_id` líder de PK y FKs compuestas                                                               | `silo.test.ts`                                                                                       |
| [x] | RLS `FORCE` + `USING` **y** `WITH CHECK` en toda policy                                                | `silo.test.ts` + `harden()`                                                                          |
| [x] | Not-found con scope de dueño, nunca 403                                                                | `contacts-silo.test.ts` · `DEMO-04`                                                                  |
| [x] | La app se niega a arrancar con un rol que saltea RLS                                                   | `boot-assert.test.ts` (G4(a))                                                                        |
| [x] | Ledger append-only por trigger **y** por privilegio revocado                                           | `money-path.test.ts`                                                                                 |
| [x] | Plata como `bigint` de centavos; `Number(`/`parseFloat(`/`Math.round(` prohibidos fuera de `lib/money` | `eslint.config.js` · `money.test.ts`                                                                 |
| [x] | Los gates atados a `stage_type`, nunca al nombre de la etapa                                           | `close-gate.test.ts`                                                                                 |
| [x] | Ningún presupuesto se afloja editando un archivo (`monotonic_down` en `ref.ci_ratchet`)                | `ci-ratchet.test.ts` · `perf-budgets.test.ts` · `npm run perf`                                       |
| [x] | Un presupuesto `null` en un tier aplicado rompe el build                                               | `PERF006` / `PERF007`                                                                                |
| [x] | Un componente no importa servidor en runtime                                                           | `scripts/client-server-boundary.test.ts` — probado por mutación con el import que causó el incidente |
| [x] | Un solo umbral de decay; `rot_threshold` rompe el build                                                | `one-decay-threshold.test.ts` (mira el **motor** y el árbol)                                         |
| [x] | La cadena de snapshots de Drizzle no puede quedar atrás                                                | `snapshot-chain.test.ts` · `db:generate` se niega con `DBGEN003`                                     |
| [x] | Máximo un loader SSR de datos de tablero (hoy 3, `shrink_only`)                                        | `ui-loader-whitelist.test.ts` (`AP005`)                                                              |
| [x] | Altura de tarjeta clavada                                                                              | `card-height.test.ts` (`AP004`)                                                                      |
| [x] | Los 5000 ms en cuatro representaciones, comparados por **valor**                                       | Test de deriva de la Puerta 10                                                                       |
| [x] | Los cuatro estados vacíos del leaderboard no colapsan en un string interpolado                         | `empty-copy.test.ts`                                                                                 |
| [x] | WCAG 2.1 AA, cero hallazgos serious/critical                                                           | `tests/e2e/a11y.spec.ts`, **job de CI propio**                                                       |
| [x] | La Lista Protegida es ejecutable                                                                       | `scripts/protected-list.test.ts`                                                                     |
| [x] | El CI corre `verify` + e2e sobre Postgres 18 con el **mismo locale ICU** que local                     | `.github/workflows/verify.yml`                                                                       |
| [ ] | **El cruce del ratchet corriendo EN EL CI**                                                            | Ver §5.1 — falta el paso de Jorge                                                                    |
| [ ] | Trigger diferido _"un lead nunca existe sin tarjeta"_                                                  | Necesita cruzar `contact` y `opportunity`                                                            |

---

## 5 · Bloqueado, y en quién

### 5.1 · En Jorge

|     | Qué                                                                                                    | Por qué bloquea                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] | **Cuenta real de Aloware** (Puerta 2)                                                                  | Bloquea la historia 9, `DEMO-02 · 05 · 06`, la franja de actividad de `DEMO-09`, el chip de contacto reciente y `needs reply` de `DEMO-07`, y `Save & call`. **Es el bloqueante más grande del proyecto. Tratado como indefinido** (confirmado 2026-08-09) — no tiene ETA y no se re-pregunta cada sesión              |
| [ ] | **`crm_ci` con LOGIN + contraseña fuera de banda**, y la cadena como secreto `CI_RATCHET_DATABASE_URL` | Cierra el cruce del ratchet en el CI. **Verificado en el motor el 2026-08-07: el rol `crm_ci` YA EXISTE con `rolcanlogin = false`** — falta exactamente un `ALTER ROLE crm_ci WITH LOGIN PASSWORD '…'` fuera de banda, no crear nada. Hoy el cruce corre en el hook de pre-commit y el CI imprime "el cruce no corrió" |
| [ ] | **Instancia de Render**                                                                                | Cierra la Puerta 1 (`max_connections`, PgBouncer, `CREATE EVENT TRIGGER`)                                                                                                                                                                                                                                              |
| [ ] | **Cuál de los tres loaders SSR se saca**                                                               | My Day es el que el registro pide por su propio texto. El motor sólo garantiza que no puedan volverse cuatro                                                                                                                                                                                                           |
| [ ] | Propiedad del registro **10DLC** · grabación de llamadas · atajos de una tecla                         | Recomendaciones en `CLAUDE.md` §9. Ninguna bloquea construcción                                                                                                                                                                                                                                                        |

### 5.2 · Externo, con reloj propio

|     |                    |                                                                                                                                                                                                           |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ ] | **Registro 10DLC** | Semanas de trámite, puede ser rechazado. **Aparcado por decisión de Jorge (2026-08-01).** El producto lanza SMS-dark igual: no bloquea la construcción, **sólo la fecha en que el SMS se puede encender** |

---

## 6 · Deuda técnica declarada

|     |                                                                                                                                      |                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [ ] | **E9 firmada pero NO implementada** — no existe `ref.capability_probe`                                                               | Llega con el módulo Aloware                                                                           |
| [ ] | **R13 abierto** — `raw_payload_vault` purga por drop de partición mientras `dead_letter` tiene FK hacia ella                         |                                                                                                       |
| [ ] | **Tres loaders SSR** donde §1.2 sanciona uno                                                                                         | Acotado por el ratchet; falta la decisión de cuál sacar (§5.1)                                        |
| [ ] | **Ids de tenant de los tests de integración asignados a mano** sobre la base compartida `crm_test`, sin nada que impida colisión     | Ya chocaron una vez; el síntoma fue `duplicate key` en `beforeAll`, no algo que se lea como lo que es |
| [ ] | **`04b` §4.8 se contradice** sobre la nota al pie del tablero (`lb.footnote.golive` permanente vs. `tracked_since` que la reemplaza) | Hoy se renderizan las dos. **Sin resolver, a propósito**                                              |
| [ ] | **`lead_source_id` omitido** en `contact` a propósito                                                                                | Llega con intake                                                                                      |
| [ ] | **P6 al borde** — la mediana pasa con 0,6 ms de margen; 1 de cada 3 corridas se pasa con la máquina ocupada                          | El presupuesto **no se mueve**. La respuesta real es virtualizar el tablero                           |

---

## 7 · Lo siguiente, en orden

Lo que **no depende de nadie**:

1. [ ] **Virtualización del tablero.** Desbloquea el reloj `NEW`, le da margen a P6, y con ella el
       problema de los 500 relojes **se disuelve solo** — dejan de existir 500 nodos.
2. [ ] **La mitad percibida del presupuesto de búsqueda** (`US-LCP-08`).
3. [ ] **Cerrar los `partial` que no esperan a Aloware**: `DEMO-10` (el seed negándose en entorno vivo).

Todo lo demás de la lista espera a Aloware o a una decisión de Jorge (§5).
