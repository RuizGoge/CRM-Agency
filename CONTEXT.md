# CONTEXT.md — Living Project Memory

> **La regla de oro:** si el contexto de la conversación se perdiera por completo, [`CLAUDE.md`](CLAUDE.md) + este archivo + [`docs/`](docs/) deben bastar para retomar el proyecto sin pérdida. Ya se puso a prueba una vez, cuando un lote de agentes falló a mitad de fase y el trabajo se recuperó desde el registro.
>
> **Antes de construir cualquier cosa, leé la cadena de precedencia más abajo.** El corpus son ~1,9 MB escritos en siete fases y doce afirmaciones aprobadas fueron tachadas después. Leer el texto viejo es el fallo de diseño más probable de este proyecto.

## Current State
<!-- qué fase va, qué está hecho, qué sigue -->

### 🟢 SPRINT 0 EN CURSO — G0 ✅ **APROBADO** (2026-08-01)
Evidencia completa: [`docs/sprint-0/g0-us-region.md`](docs/sprint-0/g0-us-region.md).

- **G0 · ✅ PASA, las dos mitades. LA DECISIÓN DE STACK QUEDA CONFIRMADA — B2 sigue en pie y ya no es condicional por región.**
- **Mitad documental:** Render ofrece 5 regiones — Oregon, **Ohio**, **Virginia**, Frankfurt, Singapore. El `region` del blueprint spec acepta las cinco tanto para servicios como para bases de datos, sin calificador de plan.
- **Mitad del formulario (la que decidía):** ejecutada contra el dashboard real, workspace **Hobby**, **sin crear ningún recurso**. **Los tres formularios ofrecen Ohio y Virginia**: Web Service (default Ohio), Background Worker (default Virginia), Postgres (default Oregon). La contradicción entre las dos auditorías queda resuelta a favor de la que decía que sí.
- **Tres hallazgos que el gate no pedía y valen:** **PostgreSQL 18 está en el selector de versión** (el stack lo exige y nadie lo había verificado, solo asumido) · **los Background Workers no tienen tier Free**, arrancan en Starter (confirma el modelo de costos) · el texto de ayuda del propio campo Region dice *"Your services in the same region can communicate over a private network"* — la regla de misma-región, en palabras de Render, en el formulario donde se cometería el error.
- **⚠️ Dos reglas operativas NUEVAS, ninguna estaba en el corpus, ambas son puertas de una sola dirección:** (1) **la región no se puede cambiar después de crear** un servicio o una base; (2) **servicios en regiones distintas no hablan por red privada** → los 3 procesos y el Postgres van todos en la MISMA región (Ohio o Virginia).
- **G0-hour · números de costo: ✅ el modelo de la arquitectura era correcto en TODAS las líneas.** Confirmados: storage **$0.30/GB/mes sin asignación incluida** (leído en vivo: 15 GB → $4,50/mes), egress Hobby **5 GB + $0.15/GB**, **PITR de 3 días en Hobby** (§9.4.2 ya lo decía), **Starter $7 a 0,5 vCPU** y **Basic-1gb $19**. **La línea innegociable sobrevive:** los backups son propiedad de la *instancia* pagada, no del *workspace* Pro. Dos confirmaciones colaterales: **Starter es 0,5 vCPU y no un núcleo** (la corrección que G6 ya cargaba) y **el salto Starter→Standard es exactamente +$18**, la válvula de escape que G6 había presupuestado. Y el campo Storage dice *"you can't decrease it"* — la frase que convierte el archivo en R2 en mecanismo de presupuesto y no en optimización.
- **Consecuencia para G9:** la ventana real de recuperación son **3 días de PITR**, no 7. Una corrupción del ledger descubierta al día 4 solo se recupera del dump horario a R2.

### 🧱 SPRINT 1 · ITEM 1 — Fundaciones de datos y arnés de RLS (2026-08-01)
**Primer código de producto del proyecto.** Tres migraciones aplicadas y verificadas contra Postgres 18 local.

- `0000_bootstrap` — extensiones (`citext`, `pg_trgm`, `btree_gin`), roles `crm_migrator` / `crm_app` (NOINHERIT, con `idle_in_transaction_session_timeout`), `security.table_registry`, `security.schema_policy`, `security.managed_relations()`, `security.refuse_mutation()` y **`security.harden()`**.
- `0001_tenancy_foundations` — generada por Drizzle: esquemas `app`/`ref`, enums `user_role` y `earnings_disposition`, tablas **`tenant`** y **`app_user`**.
- `0002_context_and_harden` — `app.current_tenant()`, `app.current_user_id()`, `app.scope_is_global()`, `app.scope_is_admin()`, el trigger de validación de `business_tz`, las filas de registro y la primera corrida de `harden()`.

**Las políticas se GENERAN, nunca se escriben.** `harden()` las deriva de la clasificación en `security.table_registry`. Como no hay dónde escribir una política, la falla de escribir `USING` sin `WITH CHECK` queda eliminada en el origen — que era el punto. **`FOR ALL` es la única forma permitida**, porque Postgres hace de `WITH CHECK` sobre `FOR SELECT` un error de sintaxis, y un gate insatisfacible se "arregla" debilitándolo.

**Verificado ejecutándose, no en papel** — nueve aserciones, todas verdes:
| # | Aserción | Resultado |
|---|---|---|
| A | FORCE RLS en toda relación gestionada | ✅ |
| B | Toda política es `FOR ALL` con `qual` **y** `with_check` | ✅ **0 violaciones** |
| C | `crm_app` sin `DELETE` en ningún lado | ✅ **0 grants** |
| D | Tabla sin clasificar → **`harden()` levanta HR001 y rompe el deploy** | ✅ |
| E | Tabla creada en `public` → también rompe el deploy | ✅ |
| F1 | Sin contexto de sesión → **cero filas, no un error** | ✅ |
| F2 | Ana ve sólo su propia fila | ✅ |
| F3 | **Ana escribiendo una fila de Ben → RECHAZADO** | ✅ el modo de falla de `USING`-only, cerrado |
| F4 | Ana no puede `DELETE` — privilegio, no política | ✅ |
| F5 | Vendedor forjando `scope_mode=tenant_read` → **no obtiene alcance global** | ✅ el GUC no se cree; se re-lee `app_user.role` |

- **Trampa evitada y documentada:** `app_user` es la única tabla con dueño que es legible a nivel tenant a propósito. Si su `USING` llamara a `scope_is_global()` — que a su vez lee `app_user` — Postgres levanta *"infinite recursion detected in policy"*. La clase `tenant_scoped` genera un `USING` que no la llama.
- **Desviación documentada:** `policy_class` vive en el esquema `security`, no en `app` (05b §938). Es metadata que `crm_app` nunca puede leer y evita un peligro de orden en el bootstrap. Sin consecuencia de comportamiento.
- ✅ **AHORA SÍ ES UN MECANISMO.** Las aserciones son suite ejecutable en `tests/integration/silo.test.ts` — **12 tests, dentro de `npm run verify`, o sea dentro del hook `pre-commit`**. `globalSetup` tira y reconstruye la base `crm_test` en cada corrida y aplica **los mismos archivos de migración que corre el deploy**: nada del esquema bajo prueba lo construye el test.
- **La suite NO se auto-saltea si no hay base: tira error con el comando a correr.** Un test que se saltea solo queda verde en toda máquina que no puede correrlo — incluido el CI el día que alguien saque el bloque de servicios del workflow. Contrapartida asumida: **hay que tener Docker levantado para commitear.** Es un clic, y es correcto para un proyecto cuyas garantías centrales viven en la base.
- 🎯 **PROBADO POR MUTACIÓN, no sólo en verde.** Debilité `harden()` a propósito con el error clásico (`with_check` sin la comprobación de dueño) y la suite se puso **roja dos veces**: una en la escritura rechazada, y otra en el dato — `FORGED BY ANA` apareció en el libro de Ben. Ese segundo fallo es el síntoma real que un vendedor vería. Revertido. **Un test que pasa sin poder fallar no vale nada; este puede fallar.**
- **Dos aserciones más que agregó la suite:** un supervisor obtiene lectura global **pero la escritura le sigue siendo rechazada** (`USING` pasa, `WITH CHECK` falla — esa asimetría *es* el modelo de autorización, y es lo que hace que el caso del supervisor sea 403 y no un not-found), y el enum `user_role` tiene **exactamente tres etiquetas**, la forma mecánica de "no hay constructor de roles ni matriz de permisos".
- **También pendiente:** el trigger que rechaza `is_demo=true` en producción (necesita `system_constant`, que aún no existe) y la validación de `display_tz` en `app_user`.

### 🌅 SPRINT 1 · ITEM 8 — My Day (2026-08-02)
`app/routes/api/my-day.ts`, `app/routes/ui/my-day.tsx`, seed extendido. Cuatro secciones con conteo en el encabezado: **Needs outcome · Today's appointments · Due now · Later today**.

🔴 **LA TRAMPA DE ESTE MÓDULO, evitada a propósito:** la política `owner_scoped` es `owner = current_user **OR app.scope_is_global()**`. Correcto para un tablero que un supervisor debe leer entero — **exactamente equivocado acá**. Un supervisor abriendo My Day habría visto el trabajo de los cincuenta vendedores fusionado en una lista. La Fase 4 lo dice explícito: *"Supervisor sees their own My Day only — global visibility lives on the read-scoped board, never here."* Por eso **cada consulta filtra `owner_user_id = app.current_user_id()` EXPLÍCITAMENTE. La política es el piso, no la respuesta.**

🔴 **Y un defecto que introduje yo, encontrado mirando la pantalla — invisible hoy, roto en septiembre.** El `Clock` formateaba con `toLocaleTimeString` **sin** opción `timeZone`, o sea la zona del navegador. El servidor ya había decidido qué cuenta como "hoy" usando `app_user.display_tz`, así que una cita podía entrar como de hoy y **imprimirse con la hora de mañana**.

Lo que lo hace instructivo: **el navegador estaba en `America/Santiago` (UTC-4) y Nueva York en EDT (UTC-4) — hoy coinciden exactamente**, así que la pantalla se veía bien. Se habría roto cuando Chile pase a horario de verano. **Verificado el arreglo cambiando la zona de la vendedora a Los Angeles: los horarios se corrieron de 10:03 PM a 7:03 PM**, y las secciones cambiaron de contenido de forma coherente porque el filtro del servidor usa la misma zona.

- **Las tres reglas de zona horaria, en un mismo módulo y sin mezclarse:** `display_tz` decide qué es "hoy" y cómo se lee una hora · `business_tz` estampa `period_key` y nada más · la del lead decide la legalidad de una llamada.
- **"Needs outcome" va primero y no se puede descartar.** Una reunión cuya hora de fin pasó sin resultado registrado es dinero que quizá ya se ganó y no se anotó.
- Estado vacío global (*"You're clear. Nothing due right now."*) y por sección, error y sin-permiso.

### 🏆 SPRINT 1 · ITEM 7 — El leaderboard público, LA PRIMERA PANTALLA (2026-08-01)
Migración **0016**, `app/routes/ui/leaderboard.tsx`, `app/routes/ui/sign-in.tsx`, 3 componentes, `scripts/seed.ts`. **Verificado en pantalla, no en test.**

**Es la primera vez que el producto se ve.** Los seis ítems anteriores viven enteros en la base.

**Aritmética verificada contra la pantalla real** (sembrado por el camino real: `stage_move` pasando el gate y apendeando al ledger, nunca insertando totales):
| Vendedor | Mensual sumado | ×12 | En pantalla |
|---|---|---|---|
| Priya | 96.500¢ | 1.158.000¢ | **$11,580** ✓ |
| Renata | 75.249¢ | 902.988¢ | **$9,029.88** ✓ |
| Marcus | 67.400¢ | 808.800¢ | **$8,088** ✓ |
| Dana | 27.500¢ | 330.000¢ | **$3,300** ✓ |

Los centavos de Renata sobreviven exactos — en coma flotante eso sería `9029.879999…` en un tablero público.

🔍 **Leer el árbol de accesibilidad del primer render encontró dos defectos que una captura no habría mostrado:** el número de rango del podio **no tenía etiqueta** (un "2" leído después de un nombre y un monto es ambiguo, y la altura del escalón no comunica nada a un lector de pantalla) y **el vendedor conectado no se distinguía en el podio** — el resaltado existía sólo en las filas de lista. Los dos corregidos y verificados.

- **Las cuatro pantallas obligatorias existen:** vacío (con copy distinto para all-time que para un período), cargando (**skeleton, nunca spinner**), error y sin-permiso — y las dos últimas **no se ven iguales**, porque son respuestas distintas.
- **El dinero cruza como string de centavos.** El cliente formatea con `format(fromWireString(…))` y **no hace aritmética**, nunca.
- **El poll se detiene con la pestaña oculta y dispara al volver al foco.** Un tablero en segundo plano son 50 requests por minuto que nadie lee.
- **ETag derivado del cuerpo renderizado, a propósito.** El valor público es dependiente del tiempo (las entradas dentro de la ventana de undo se excluyen), así que un ETag puramente derivado de escrituras respondería 304 mientras el número visible cambia al envejecer una entrada pendiente. Formas más baratas existen; ninguna puede perder esa propiedad.
- **`sign-in` con un solo mensaje de error** para dirección equivocada y contraseña equivocada — dos mensajes son un oráculo de enumeración de cuentas. Y dice la verdad sobre el reset: *"An admin can set a new one for you."*
- ⚠️ **Patrón que ya me costó tres veces: los UUID de prueba deben ser HEX.** `dev1`, `s1`, `t1` no lo son.

#### 🔴 Dos defectos que SÓLO aparecieron mirando la pantalla (migración 0017 + fix del seed)
Ninguno de los dos lo habría atrapado un test escrito desde la especificación, porque la especificación describe el ranking y **no dice nada sobre quién falta**.

1. **Un vendedor con cero ventas no estaba en el tablero. Ausente, no en $0.** El board joineaba DESDE `leaderboard_projection`, y sin fila de ledger no hay fila de proyección. En un tablero cuyo propósito entero es motivar, **el vendedor con menos para celebrar era el único que no podía encontrarse**. Corregido invirtiendo el join: se parte del roster y se hace `LEFT JOIN` a los totales. Sólo `role = 'seller'` — supervisores y admins no pueden escribir en el libro de un vendedor, así que ponerlos en $0 para siempre se leería como último puesto y no como "no compite".
2. **El seed generaba `tomás@demo.test` y el propio formulario de login lo rechaza.** `<input type="email">` valida contra la gramática HTML5, que es **ASCII-only antes del `@`** — `validity.typeMismatch = true` y el navegador simplemente **no hace el POST, sin ningún error que la página pueda mostrar**. Peor: **better-auth aceptó el alta**, así que el servidor admite una dirección que el cliente estructuralmente no puede enviar. El seed ahora pliega acentos. **Es el tenant que se muestra en un demo comercial: una cuenta en la que nadie puede entrar es el peor momento para descubrirlo.**

- ⏳ **Debido, observado en pantalla y no corregido todavía:** las filas fuera del podio no tienen contenedor (la fila propia sí, porque está resaltada, así que las demás se ven sin terminar al lado); **no hay encabezado, navegación ni cerrar sesión en ninguna parte** — la pantalla es una isla; y las líneas base de nombre/monto del podio quedan desparejas.
- ⏳ **También debido:** la celebración (confetti tras la ventana de undo), el patrón top10+2 con vecinos, y `npm run test:e2e` con axe-core.

### 📅 SPRINT 1 · ITEM 6 — Calendario y recordatorios (2026-08-01)
Migraciones **0014–0015**, `app/db/schema/calendar.ts`, **12 tests**. Total: **98**.

**El tema del módulo: un recordatorio es un artefacto legal, no una comodidad.** Tiene que disparar una vez, en el instante correcto, en una zona horaria que no se pueda reescribir después — y cuando no dispara, la razón tiene que sobrevivir.

🎯 **Resuelto el riesgo residual #2 de §9.6, que tiene filo legal y no sólo operativo.** Ordenar los jobs sólo por `fire_at` a través de todos los tenants deja que la tormenta de recuperación de **un** tenant **hambree los recordatorios T-1h de todos los demás** — y un recordatorio que dispara tarde puede disparar **fuera de la ventana legal de llamada**. Vecino ruidoso con un demandante adjunto. `scheduled_job_claim` usa `DISTINCT ON (tenant_id)`: cada tenant recibe su job más viejo antes de que ninguno reciba un segundo. **Probado por mutación:** quitando la equidad, el tenant tranquilo queda fuera del primer lote detrás de una cola de 60.

- **`UNIQUE (tenant_id, kind, idempotency_key) WHERE canceled_at IS NULL`** — un solo índice parcial carga **toda** la idempotencia por episodio del producto: el recordatorio T-1h, el episodio de enfriamiento y la escalada de actividad. Reagendar cancela e inserta, así que **existe exactamente un job vivo por (sujeto, kind)** y un segundo encolado es imposible, no meramente improbable. La fila superseded se retiene: es la evidencia de qué se agendó y cuándo dejó de estarlo.
- **`skipped` es estado terminal de primera clase, no un error.** Eso es exactamente lo que permite que el ensayo SMS-dark pase sin que ningún camino falle, y es la prueba de que un recordatorio fue **omitido y no perdido**.
- **`meeting.contact_timezone` es SNAPSHOT, nunca un join.** Una edición posterior del contacto no debe mover la hora local de una reunión pasada — ni, mucho peor, cambiar retroactivamente si un recordatorio que ya salió era legal. Con test.
- **`needs_outcome` es predicado derivado, nunca columna**, así que no puede quedar rancio entre que la reunión termina y que un job lo note.
- **La UNA actividad:** `app.task` es vista `security_invoker` sobre `activity WHERE type='task'` — el nombre existe para quien lo llame, sin un segundo objeto y **sin una segunda fuente de verdad para `last_activity_at`**.
- Dos CHECK que valen: una tarea **exige** `due_at` (sin él My Day no tiene dónde ponerla) y **todo trabajo creado por una máquina debe poder decir por qué existe** (`source_event_name`), que es lo que deja a un vendedor preguntar "¿por qué está esto en mi lista hoy?" y obtener respuesta.
- **La intención de agendado la escriben sólo definers.** `crm_app` no tiene INSERT ni puede tocar `status`/`fire_at`/`terminal_reason`. Leer sí, para que My Day explique por qué se omitió algo; **cambiar esa respuesta, no.**
- ⏳ **Debido:** cablear pg-boss al claim. Hoy existe la capa de dominio (intención, idempotencia, estados terminales, equidad); falta el proceso que la consuma.

### 🎯 SPRINT 1 · ITEM 5 — Pipeline y el gate de cierre (2026-08-01) · Opus · alto
Migraciones **0012–0013**, `app/db/schema/pipeline.ts`, **16 tests**. Total: **86**.

**Los dos gates son CHECK constraints, no middleware.** `current_stage_type <> 'earning' OR premium_annual_cents IS NOT NULL` y `current_stage_type <> 'lost' OR lost_reason_id IS NOT NULL`. Una llamada cruda de API, un import CSV, una automatización o una ruta escrita el año que viene **no pueden producir la fila** — no "son rechazadas", no existen.

**La FK compuesta es el mecanismo central:** `(tenant_id, stage_id, current_stage_type)` referencia `stage(tenant_id, id, stage_type)`. El tipo denormalizado **no puede mentir** sobre la etapa a la que apunta, sin trigger y sin join.

🎯 **Mutación: até el gate al NOMBRE de la etapa —el bug histórico exacto— y el resultado fue mejor que un rojo simple.** Falló **un solo** test (el de renombre), que es justo la forma del bug: parece funcionar hasta que alguien renombra la columna. Y lo que frenó el movimiento fue **la restricción `opportunity_win_gate` de la base**. El gate del servicio quedó evadido; el de la base no. Defensa en profundidad demostrada, no afirmada.

🔴 **Hueco encontrado al diseñar, y un error mío de PostgreSQL corregido:** `opportunity` es `owner_scoped`, así que `crm_app` tenía `UPDATE` — o sea que una tarjeta podía moverse con un `UPDATE` plano, **sin transición y sin fila de ledger**: el tablero y el dinero divergiendo en silencio, sin job de recomputo que los reconcilie. Lo cerré con **columnas protegidas en el registro**, aplicadas por `harden()`. Pero mi primera versión estaba mal: **PostgreSQL no descompone un grant a nivel de tabla**, así que `GRANT UPDATE ON t` + `REVOKE UPDATE (c) ON t` deja `c` escribible. La forma que sí sostiene es **enumerar las columnas permitidas** — y una columna agregada después queda protegida por default.

- **`stage_type` es inmutable por trigger.** Ese único trigger borra una clase entera de catástrofe: si un tipo nunca puede cambiar, un ajuste de tablero de un vendedor **nunca puede mover dinero en un leaderboard público**, y "recomputar al cambiar el flag" contra "no existe job de recomputo" se resuelve a favor del segundo sin ambigüedad.
- **`CHECK (to_stage_type <> 'earning' OR actor_type = 'human')`** — un import, un webhook, un job de recordatorios o un token de API **físicamente no pueden** escribir una fila que acredite dinero.
- **Atomicidad probada:** con una prima bajo el piso de $1, el `UPDATE` falla dentro de `stage_move` y **la tarjeta no se movió y no hay transición**. Todo o nada.
- Idempotencia de sendBeacon por `client_move_key`; salir de una etapa earning **revierte** con delta exactamente opuesto.
- Cross-silo → **SM404, nunca 403**.
- ⚠️ **Dos trampas de herramienta que costaron tiempo y quedan anotadas:** Drizzle emite las FK **después** de los índices, así que un target de FK compuesta debe declararse como `unique()` (constraint, va inline en el `CREATE TABLE`) y no como `uniqueIndex()`. Y `Out-File -Encoding utf8` en PowerShell 5.1 escribe **BOM**, que rompe el `_journal.json` de drizzle-kit.

### 👥 SPRINT 1 · ITEM 4 — Contactos y el fixture de colisión (2026-08-01)
Migraciones **0010–0011**, `app/db/schema/contacts.ts`, **11 tests**. Total: **70**.

🔴 **EL CANARIO ATRAPÓ UNA FUGA REAL, Y ERA MÍA.** El fixture de §7.7.1 —dos vendedores con el mismo consumidor, tokens `ZZQA-` en los campos de Ana, aserción **a nivel de bytes sobre la respuesta serializada entera**— mostró las filas de Ana dentro de la búsqueda de Ben la primera vez que corrió.

**Causa:** `withTenant` fijaba las tres GUCs pero **no bajaba de rol**. Un superusuario —o cualquier rol dueño del esquema— **saltea RLS por completo, FORCE incluido**. En producción la app conecta como `crm_app` y funciona; pero eso significaba que **el silo dependía de qué usuario dijera `DATABASE_URL`**, y el string que `docker compose` entrega por defecto es exactamente ese superusuario. El entorno de desarrollo entrenaba la configuración rota con fidelidad perfecta, y el fallo no tiene síntoma: todas las páginas renderizan, con las filas de todos.

**Cerrado:** `withTenant` y `withSystemWork` ahora hacen `SET LOCAL ROLE crm_app` tras establecer contexto. Es defensa en profundidad — **G4(a) sigue debiendo la aserción de arranque que se niega a bootear si el usuario de conexión es dueño del esquema.**

- **La aserción a nivel de bytes es el mejor test del corpus** y ahora está construida: no dice "ninguna fila con otro `owner_user_id`", dice **ninguna aparición del token en toda la respuesta** — así atrapa una fuga por una columna que se agregue dentro de seis meses y que ningún test conozca. Con su control positivo: las filas de Ana **sí** llevan el canario.
- **La identidad es owner-scoped a propósito:** dos vendedores que compraron el mismo consumidor tienen dos filas y ninguno ve la del otro. Eso *es* el requisito, no un duplicado tolerado. La suppression, en cambio, es tenant-wide — por eso `contact_phone` es tabla aparte.
- **`contact_live` es `security_invoker`.** Sin esa palabra, una vista propiedad del migrador lee con la política del migrador —`USING (true)`— o sea un bypass total del silo disfrazado de "vista". Hay test que lo asegura.
- E.164 y la coherencia de zona horaria son **constraints**, no helpers: una zona `high` con valor NULL es la forma exacta en que una llamada ilegal parece permitida.
- **Ajuste de test honesto:** la aserción de plan sobre el índice trigram se cambió por una estructural. Con seis filas el planner prefiere correctamente la PK, así que un `EXPLAIN` ahí testearía el modelo de costos de Postgres, no nuestro índice. G1e ya probó el plan contra 20.000 filas; esto cuida que nadie saque `owner_user_id` de la clave.
- ⏳ **Debido:** el trigger diferido "un lead nunca existe sin tarjeta" (necesita `opportunity`, ítem 5) y `lead_source_id` (llega con el módulo de intake). **Omitidos en vez de construidos a medias.**

### 💰 SPRINT 1 · ITEM 3 — La espina dorsal del dinero (2026-08-01) · Opus · máximo
Migraciones **0006–0009**, `app/db/schema/earnings.ts`, **15 tests nuevos**. Total: **59**.

**Tres defectos de mi propio `harden()` del ítem 1, encontrados leyendo `05b` §674-712 contra lo que 0000 realmente generaba:**
1. 🔴 **El trigger de inmutabilidad era por FILA. La spec exige por SENTENCIA sobre `UPDATE OR DELETE OR TRUNCATE`.** Un `DELETE ... WHERE false` no dispara trigger de fila, y **`TRUNCATE` saltea triggers de fila Y el privilegio DELETE por completo**. Probado por mutación: con el trigger viejo, **el `TRUNCATE` pasó y vació el ledger** — la pérdida total y permanente que todo el diseño existe para prevenir.
2. `append_only_*` generaba `WITH CHECK (owner = current_user)`. La spec exige **`WITH CHECK (false)`**: el rol de la app no escribe el ledger por ninguna vía.
3. Las tablas append-only recibían `GRANT INSERT`. Ahora **no reciben DML alguno**: `crm_app` sobre `earnings_ledger` tiene exactamente `SELECT`.

**Trampa de precedencia atrapada:** `05b` §678 exige `CHECK (delta_cents <> 0)`, pero la **errata E3** (rango 1) dice que `projection_repair` lleva `delta_cents = 0`. **Gana la errata** — seguir el texto viejo habría hecho imposible insertar toda reparación de proyección. La restricción quedó `delta_cents <> 0 OR entry_type = 'projection_repair'`.

**`policy_class` dejó de ser ENUM y pasó a `text`.** No es workaround: **drizzle-kit aplica TODAS las migraciones pendientes en UNA transacción**, y `ALTER TYPE ... ADD VALUE` no permite usar la etiqueta nueva hasta que esa transacción commitee. O sea que "una migración agrega una clase, la siguiente clasifica una tabla con ella" **es irrejecutable, y falla en el DEPLOY** — después de la revisión, en el único camino que nadie mira. Exactamente el modo de falla que este proyecto no absorbe. Sin `CHECK` de valores válidos a propósito: sería una segunda lista que mantener de acuerdo con la primera, y `harden()` ya levanta HR002 nombrando la clase.

**Lo construido:** `earnings_ledger` (append-only, delta firmado, exactly-once por `source_event_id`, tres period keys coherentes por CHECK) · `leaderboard_projection` (agregado mantenido; el tablero nunca suma el ledger) · **`app.ledger_append()` como única puerta de escritura** · `app.annualize()` · `app.leaderboard_read()` con la ventana de undo excluida · `ref.timing_constant` con **los dos intervalos que nunca comparten nombre** (`undo_deadline_ms` 5000, `projection_reveal_delay_ms` 5500).

**La segunda entrega del mismo `source_event_id` es camino de ÉXITO, no error:** devuelve el id existente con `was_duplicate = true`, el total no se mueve y no se le muestra nada al vendedor. Doble tap, reintento del proveedor y replay caen todos ahí.

🎯 **Un test pasaba VACUAMENTE y lo detecté.** `leaderboard_read` es definer y scopea por `app.current_tenant()`; llamándolo desde la conexión cruda devuelve **cero filas**, así que dos aserciones comparaban 0 con 0 y pasaban por la razón equivocada. Reescrito para correr dentro de `withTenant`.

⚠️ **Corregí una guarda de lint que estaba MAL.** Mi regex de `SET` pelado matcheaba el `SET` de `UPDATE tabla SET columna` — así escrita habría bloqueado todo `UPDATE` del proyecto. Acotada a `SET ROLE` y `SET app.<guc>`. **Una guarda que marca código correcto termina desactivada, y eso es peor que no tenerla.**

⏳ **Pendiente de G3 que no se puede cerrar todavía:** la transacción del gate de cierre como unidad atómica (necesita `opportunity`/`stage`, ítem 5) y `idle_in_transaction_session_timeout` verificado bajo un proceso muerto a mitad del gate.

### 🔐 SPRINT 1 · ITEM 2 (mitad) — Contexto de scope por unidad de trabajo (2026-08-01)
`0004…` no: migración **`0003_begin_request`** + `app/db/client.ts` + guardas de ESLint + **11 tests**. Total de la suite: **37**.

- **`app.begin_request(tenant_id, user_id)` es un definer, no TypeScript, y ahí está el punto: el que llama NO puede elegir su scope — no hay parámetro para eso.** Le pasás quién sos; el motor lee `app_user.role` y decide qué significa (`seller`→`owner`, `supervisor`→`tenant_read`, `admin`→`tenant_admin`). Si el scope fuera un argumento, cada ruta, job y consumidor de webhook estaría a un literal equivocado de auto-concederse lectura de todo el tenant, y nada se pondría rojo.
- **`CTX001`, el detector de contexto filtrado.** Como todo se fija con `set_config(..., true)`, encontrar contexto ya puesto al empezar una unidad de trabajo significa una de dos cosas: alguien usó un `SET` pelado (que sobrevive a la transacción) o **el pooler está en modo sesión y nos entregó una conexión con la identidad de otro vendedor**. Levanta excepción en el **primer** request filtrado en vez de renderizar páginas perfectas con las filas equivocadas.
- **`CTX002`** rechaza usuario inexistente o desactivado, **sin decir cuál de las dos mitades estaba mal**.
- **El pool es privado del módulo.** Única puerta: `withTenant` / `withSystemWork` vía `~/db`. `fn` recibe sólo el handle de transacción, así que **no puede ejecutar nada antes de que el contexto esté fijado** — es estructural, no disciplina.
- **Dos guardas nuevas de build:** importar `~/db/client`, `postgres` o `drizzle-orm/postgres-js` desde fuera de `app/db/**` **rompe el lint**; y `set_config(..., false)` o un `SET` pelado en cualquier template literal también. `prepare: false` fijo en el pool, porque los prepared statements no sobreviven a un pooler en modo transacción.
- 🎯 **Probado por mutación otra vez.** Desactivé el detector `CTX001` y el test se puso rojo: `begin_request` devolvía `"owner"` tranquilamente sobre una conexión envenenada. Revertido.
- **Hallazgo que va a importar después:** Drizzle envuelve el error del driver en `"Failed query: …"` y deja el de Postgres en `cause`. **El borde de rutas que mapee SQLSTATE a status HTTP tiene que recorrer esa cadena**, o un `42501` (el 403 del supervisor) llega disfrazado de 500 sin clasificar.
### 🔑 SPRINT 1 · ITEM 2 (completo) — Auth con better-auth (2026-08-01)
Migraciones **`0004_auth_tables`** + **`0005_auth_bridge`**, `app/lib/auth/**`, ruta `api/auth/*` y **7 tests**. Total: **44**.

- **`better-auth` 1.6.25** (estable; la 1.7 está en beta/rc — mismo criterio de la Fase 6). **Sólo email + contraseña**, sin proveedores sociales.
- ✅ **DECISIÓN CONFIRMADA por Jorge ("ok", 2026-08-01): sin email transaccional NO hay reset de contraseña autogestionado.** `sendResetPassword` queda **deliberadamente sin configurar**, y su ausencia *es* la decisión: cablearlo mostraría una pantalla de "revisá tu correo" por un mail que nunca llega. **Reponer una clave es acción de admin** hasta que el email llegue en V1.1.
- **El esquema `auth` va exento**, con su razón escrita en la migración: sus tablas no tienen dimensión de tenant (una identidad de login precede al contexto de tenant) y **RLS no puede protegerlas** — en el momento de validar una sesión no hay contexto por el cual scopear. ⚠️ **Residual declarado, no escondido** (en `app/db/auth-client.ts`): `crm_app` puede leer hashes de contraseña y tokens de sesión. Cerrarlo de verdad exige un cuarto rol de Postgres sólo para auth; hoy no se toma.
- **El puente:** `app_user.auth_user_id` (UNIQUE, FK **sin cascade** — el ledger ancla en `app_user`, así que borrar un login debe quedar bloqueado, no huerfanar el tablero all-time) + **`app.resolve_identity()` como definer**. Tiene que ser definer: la resolución ocurre **antes** de `begin_request`, o sea sin contexto, así que un `SELECT` común lo negaría la política y devolvería cero filas — un login que nunca resuelve, en silencio.
- **La cookie decide sólo QUIÉN entró.** Qué asiento es eso, y qué puede ver, se leen de la base después. Un vendedor desactivado con cookie válida lee como "no conectado", sin confirmar que la cuenta existe.
- **Excepción versionada de lint, con su razón:** sólo `app/lib/auth/**` alcanza el handle sin contexto. El pool y `withTenant` le siguen vedados.
- 🎯 **El gate atrapó mi propio cambio.** Había concedido `DELETE` sobre todo el esquema `auth` y la aserción "crm_app sin DELETE" se puso roja. Correcto: lo estreché a **exactamente dos tablas** (`auth.session` y `auth.verification`, que se auto-podan) y la aserción ahora **enumera la lista permitida**, así que ampliarla —por ejemplo `DELETE` sobre `auth.user`, que dejaría a un vendedor sin login bajo su historial de ledger— vuelve a ponerla roja.
- **Deuda menor:** el `max` del pool (8) es **provisional** y lo fija G1(d) contra el techo medido con 2× de holgura. Hoy G1(a) sigue sin medir.

### 🟡 G1 PARCIALMENTE CERRADO — 2026-08-01
Sonda contra `postgres:18-alpine` local (server **18.4**). Evidencia: [`docs/sprint-0/g1-platform-probe.md`](docs/sprint-0/g1-platform-probe.md).

- ✅ **G1e CERRADO, y la pregunta abierta desde §3215 se responde QUE SÍ.** Existe **opclass GIN para `uuid` (`uuid_ops`, y es la default)**. O sea que **el predicado de propiedad va DENTRO del índice de búsqueda** y el fallback documentado (trigram GIN + recheck de dueño) **no hace falta construirlo**. Probado con planner, no solo con catálogo: sobre 20.000 filas y 50 vendedores, el índice `gin (tenant_id, owner_user_id, full_name gin_trgm_ops)` compila y las **tres** condiciones aparecen en `Index Cond`, no como filtro posterior. De eso dependía el p95 de 200 ms de la búsqueda global.
- ✅ `pg_trgm` 1.6, `citext` 1.8, `btree_gin` 1.3 disponibles e instalan limpio. **`uuidv7()` es nativo en PG 18** — no hace falta `uuid-ossp` y no se debe agregar.
- 🔴 **Sigue abierto y NO se puede falsear en local:** el `max_connections` real de Basic-1gb · el redespliegue rodante sin `too many connections` · **si PgBouncer en modo transacción preserva el `SET LOCAL` sin filtrarlo entre requests** (el más importante: es el supuesto que sostiene el silo, y en Docker no hay pooler, así que un verde local sería falso) · el `max` por pool · si concede `CREATE EVENT TRIGGER` (el rol local es superusuario, así que no prueba nada — y **E9 ya sacó la dependencia del diseño**).
- ⚠️ **DEFECTO ENCONTRADO Y CORREGIDO: el `docker-compose.yml` de la Fase 6 nunca se había ejecutado.** Montaba el volumen en `/var/lib/postgresql/data`, la convención de PG ≤17; desde 18 la imagen oficial **se niega a arrancar** y entra en bucle de reinicio. Corregido al padre `/var/lib/postgresql`, con el porqué en la línea. **Lección: el "pipeline en verde" de la Fase 6 cubría typecheck/lint/tests/build/dev server y NO cubría levantar la base.** Un archivo de configuración que nunca corrió no es infraestructura verificada — es un documento verosímil.

### 🔬 R8 DESCARGADO — 2026-08-01
Los 5 ítems que el auditor juzgó sobre **texto truncado** fueron leídos completos. Evidencia: [`docs/sprint-0/r8-truncated-closure-verification.md`](docs/sprint-0/r8-truncated-closure-verification.md).

- ✅ **Cerrados 4 de 5:** §7.7.1 (silo de endpoints sin id — la aserción a nivel de bytes sobre la respuesta serializada es el mejor test del corpus), §7.7.2 (`defineEndpoint` como hecho de build), §10.5 (el gate de 49 nombres, con su gate de dos lados), §10.16 (SMS-dark como línea base). Cada uno con una corrección chica anotada para cuando se implemente.
- ❌ **§7.7.6 NO SE PUEDE DAR POR CERRADO. La clausura borra su propia evidencia.** La aserción de arranque exige que el `response_digest` del probe coincida con `raw_payload_vault.body_sha256`, pero la bóveda **purga por drop de partición** (`purge_after` NOT NULL, 60d ilustrados, ventana formal sin resolver 30/45/90). Entre 30 y 90 días después del spike de Aloware **producción deja de arrancar** (`exit` distinto de cero) y nada en la escalera lo atrapa: la aserción es exclusiva de producción, así que es invisible en dev y en CI. Las dos mecánicas son correctas por separado y las escribieron agentes distintos en secciones distintas.
- ⚠️ **Ítem transversal nuevo:** `raw_payload_vault` purga por **drop de partición** mientras al menos dos tablas (`dead_letter` y el `capability_probe` de §7.7.6) tienen FK hacia ella. Esa reconciliación se debe sin importar cómo se resuelva §7.7.6.
- ✅ **RESUELTO: firmado como errata E9** ("ok go", 2026-08-01), rango 1 de precedencia. La evidencia de probe y los payloads de consumidor pasan a **relojes separados**, porque existen por razones opuestas: la ventana corta es minimización CCPA de PII, y un probe es evidencia operativa que debe sobrevivir a lo que certifica. `ref.capability_probe` gana su propio `response_body bytea NOT NULL` y **elimina `raw_payload_id`**; la aserción de arranque compara contra `sha256(response_body)` **en la misma fila**, sin depender de la retención de ninguna otra tabla. Los probes se capturan **solo contra sujetos sintéticos**. La propiedad anti-falsificación queda intacta.
- ⚠️ **R13 declarado** (riesgo residual nuevo): E9 saca la referencia del probe, pero **`dead_letter` sigue con FK hacia `raw_payload_vault`**, que purga por drop de partición. Cierra en Sprint 0 junto a G1.
- **Cadena de precedencia actualizada a E1–E9 / R1–R13** en `05-architecture.md`, `CONTEXT.md` y el agente `precedence-checker`. El veredicto del auditor en `05c` se deja intacto: se dictó sobre E1–E8 y es registro histórico.

### 📐 G13 PUBLICADO — 2026-08-01
Las contradicciones del corpus, resueltas y publicadas **antes** de que alguien construya sobre ellas: [`docs/sprint-0/g13-published-contradictions.md`](docs/sprint-0/g13-published-contradictions.md). **Es la autoridad única sobre sus once ítems**; le gana a cualquier doc de Fase 2–4 y pierde solo contra las erratas E1–E9.

- **El hallazgo del pase:** el re-rank del tablero estaba publicado con **cinco números distintos** — `< 5 s` (`04-ux-flows` §76), `≤ 3 s` (`03-dod-roadmap` §85), "dentro de 5 segundos" (`03-mvp-stories` §571), `p95 < 2 s` (ARR-EVT-24) y `~10 segundos` (R4.4). **El correcto era el de R4.4**: ≈10,5 s = 5,5 s de reveal delay + 5 s de poll. Los otros cuatro los escribió gente que no hizo la suma. No es un defecto de performance: es la garantía de undo y la del tablero público, expresadas en segundos.
- **API p95 queda en < 300 ms** (ARR-MVP-25 decía 400; toda la aritmética de la arquitectura se calculó contra el número más ajustado, así que manda ese).
- **Bundle y TTI siguen SIN NÚMERO** hasta que G11 mida. Presupuesto nulo = build en rojo, y ese rojo *es* el gate. **No escribir un número para que un build pase.**
- Publicados además: la matriz de códigos (404 siempre para lo ajeno, **incluidas rutas de admin**; 403 solo para quien ya puede leer legítimamente e intenta escribir — **un admin no es un súper-vendedor**), la ventana de llamada como bloqueo duro **sin ruta de atestación** (la atestación empeoraba la posición legal: fabricaba el exhibit del demandante), un solo punto de parada de speed-to-lead, `call.initiated` **antes** de la confirmación, ARR-EVT-24 reformulado **por canal**, los 9 eventos de Amendment 1, `contact.owner_changed` excluido del ledger por `CHECK`, `last_activity_at` bajo `GREATEST()` y §4 de `03-mvp-definition.md` marcado como apéndice narrativo.
- **Deriva corregida en el camino:** el corpus describe la config de lanzamiento como `SMS_ENABLED=false` (variable de entorno); §10.16 la hace **columna en `tenant`** y **prohíbe `process.env.SMS*`** en todo el árbol. Manda §10.16.

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
  - **La aprobación es CONDICIONAL:** erratas **E1–E8** incorporadas literalmente (están en `05-architecture.md` §0.2, rango 1 de precedencia) + riesgos residuales **R1–R12** publicados a la vista (§0.3). **Si las erratas se tratan como opcionales, el veredicto es nulo.** *(El veredicto del auditor se dictó sobre E1–E8 y R1–R12 y se deja intacto como registro histórico. Después se agregaron **E9** y **R13**, del mismo rango — la serie viva hoy es E1–E9 / R1–R13.)*
  - **Fase 6 recomendada: Sonnet · esfuerzo medio** (producción mecánica sobre decisiones aprobadas; revisar `CLAUDE.md` con cuidado extra antes del gate) — regla 4.6.

### 🏛️ Precedencia del corpus (crítico — leer antes de construir)
1. **Erratas E1–E9** (`05-architecture.md` §0.2) — ganan sobre todo, incluido Part I. **E9 se agregó el 2026-08-01** (pase de verificación R8) y tiene el mismo rango que las ocho originales.
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

**✅ RIESGO CERRADO (2026-08-01):** se verificó que **Render ofrece Ohio y Virginia en los tres tipos de recurso, en el plan Hobby a contratar** — formulario de creación real, sin crear nada. B2 **no cae** por la puerta de región y Rails/DigitalOcean queda archivado como segundo. Detalle en [`docs/sprint-0/g0-us-region.md`](docs/sprint-0/g0-us-region.md).

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
| ~~**0**~~ | ~~Verificar región EE.UU. en el plan de hosting a contratar~~ | ✅ **APROBADO 2026-08-01.** Ohio y Virginia disponibles en Web Service, Background Worker y Postgres sobre workspace Hobby. La decisión de stack queda confirmada. |
| 1 | El silo de punta a punta: contexto fijado como primera sentencia en CADA unidad de trabajo (request, job, relay, importador, webhook, export) | Si no pasa, no se firma nada más |
| 2 | El puente de codegen de eventos: JSON Schema → tipos TS + enum PG + CHECK | Agregar un campo sin regenerar debe ROMPER el build |
| 3 | Tormenta de reintentos: 20.000 webhooks en 60 s contra el proceso de ingesta | Decide si el bulkhead alcanza |
| 4 | SSE detrás del proxy del proveedor | No está documentado; si no sobrevive, hay que identificar el reemplazo AHORA |
| 5 | Bundle y primer paint MEDIDOS | **Fija los dos presupuestos que hoy están sin número** (E6/R7) |
| 6 | Drag a 60 fps con 500 tarjetas reales | También revalida la altura de tarjeta 120/156 |
| 8 | El camino del dinero probado ANTES de escribir una pantalla | Round-trip exacto, transacción del gate, rechazo del UPDATE por privilegio |
| 9 | Simulacro de restauración cronometrado | El ledger es irreconstruible |
| 11 | **Aloware contra la cuenta real** | Firma de webhooks, reintentos, orden, vocabulario de disposiciones, aviso de grabación, forma real de la ráfaga |

**En paralelo y con reloj externo: el registro 10DLC.** Semanas de trámite, puede ser rechazado. **APARCADO por decisión de Jorge (2026-08-01):** "por ahora dejemos eso para después". Sigue sin decidirse quién firma (reco: la entidad de la agencia del cliente). **Consecuencia asumida:** el reloj externo no arranca, así que la fecha en que el SMS se puede encender se corre junto con esta decisión. El producto lanza en `sms_enabled = false` de todos modos, así que esto no bloquea la construcción — solo la fecha del SMS.

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

### Decisiones abiertas que Jorge confirma cuando quiera (ninguna bloquea la escritura; van con mi recomendación): propiedad del registro 10DLC (agencia del cliente vs nuestra); grabación de llamadas si el aviso no se dispara en el two-legged → *reco: desactivar a nivel de cuenta*; retención de payloads crudos → *reco: 60 días*; atajos de una tecla → *reco: apagados por defecto los primeros 30 días*; Sentry Team USD 26 pre-aprobado para activar el día del primer incidente; confirmar que sin email no hay reset de contraseña autogestionado; y si habrá una 2ª persona con acceso en 12 meses (**+USD 25/mes planos** — corregido en G0 desde el "+USD 51" que decía antes; Render reemplazó sus planes de workspace el 2026-04-23 y Pro dejó de cobrar por asiento. La prohibición de §9.4.5 no cambia, solo su aritmética).
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
