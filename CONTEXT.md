# CONTEXT.md — Living Project Memory

> **La regla de oro:** si el contexto de la conversación se perdiera por completo, [`CLAUDE.md`](CLAUDE.md) + este archivo + [`docs/`](docs/) deben bastar para retomar el proyecto sin pérdida. Ya se puso a prueba una vez, cuando un lote de agentes falló a mitad de fase y el trabajo se recuperó desde el registro.
>
> **Antes de construir cualquier cosa, leé la cadena de precedencia más abajo.** El corpus son ~1,9 MB escritos en siete fases y doce afirmaciones aprobadas fueron tachadas después. Leer el texto viejo es el fallo de diseño más probable de este proyecto.

## Current State
<!-- qué fase va, qué está hecho, qué sigue -->

### 📕 MY BOOK, LA EXTRACCIÓN DE `healthOf`, Y TRES RAMAS ESCRIBIENDO LA MISMA MIGRACIÓN (2026-08-10)
`app/lib/card-health/**` · `app/routes/api/my-book.ts` · `app/routes/ui/my-book.tsx` · `app/components/book/**` · `tests/integration/my-book.test.ts`. **464 → 472 tests · 44 → 45 archivos.** Ítem 24. **Ruta B completa.**

**`healthOf` SALE DE LA RUTA Y ENTRA A `app/lib/`.** Vivía en `app/routes/api/board.ts`, que importa `~/db` y `~/lib/auth` — así que la primera superficie que la necesitara habría arrastrado postgres, drizzle y better-auth al bundle del cliente. **No es hipotético: `client-server-boundary.test.ts` existe PORQUE pasó, dos veces**, y su mensaje de error nombra exactamente este remedio. Extraída textual, comentarios incluidos, porque los comentarios llevan los rulings. P12 no se movió un byte.

🔴 **Y LA TABLA DE FASE 4 QUE DEFINE EL CHIP TIENE TEXTO TACHADO.** `04-ux-flows.md` §675 da los chips de My Book y dos de sus filas están muertas: una usa **`2 × cold_threshold_days` — default 14**, que es el diseño de dos niveles que **R6 borró** y **R1.7** reemplazó por *"un solo umbral, default 7"* (la migración 0025 ya dropeó esa columna), y otra escribe la palabra que **R11 prohíbe** y que `one-decay-threshold.test.ts` grepea. `CLAUDE.md` dice que los rulings de Parte I outrankean Fase 2–4. **Implementado sólo lo que sobrevive**, y anotado en el módulo para que el próximo que lea esa tabla no la siga.

- **El chip se computa en el SERVIDOR**, del mismo dato de touch que lee el tablero: `04b` §1253 exige que tablero, My Book y My Day sean byte a byte idénticos sobre el estado de un lead, y tres pantallas coinciden sólo si ninguna decide.
- **Precedencia: `client` > `uncalled` > `no_open_deal` > `going_cold` > `working`.** `client` gana sobre todo porque es un hecho sobre la relación y no sobre el trabajo — un cliente sin tocar hace nueve días sigue siendo cliente, y llamarlo `Uncalled` sería un reproche por trabajo terminado. `uncalled` gana sobre el deterioro porque **el import de onboarding crea contactos y a propósito ninguna oportunidad**: un libro de 400 filas no puede volverse 400 filas deteriorándose al instante.
- **SIN LOADER, y no por estilo:** `ui.loader_whitelist` sanciona uno y ya lleva dos sobre presupuesto; un cuarto lo rechaza `AP005`. La pantalla busca su propio dato — **el ratchet forzó la arquitectura que §1.1 quería igual**, igual que en la pantalla de contacto.
- **Un número marcado malo NO se ofrece:** la fila muestra `Bad number` en vez de los dígitos. Si se renderizara igual, la marca sería decorativa.
- ⚠️ **`Callback due` y `No answer` NO están**, y están nombrados en el módulo en vez de omitidos: necesitan un callback futuro y un resultado de llamada, que llegan con la otra mitad del bucle diario.

🔴🔴 **EL HALLAZGO MÁS SERIO DE LA SESIÓN, Y NO ES DE CÓDIGO: TRES WORKTREES ESTÁN ESCRIBIENDO MIGRACIONES EN EL MISMO RANGO.**

| Worktree | Migraciones 0035+ |
|---|---|
| `aloware-puerta-2-spike` | **0035** webhook_ingest · **0036** call_merge · **0037** dead_letter_and_alerts · **0038** message_merge — **sin commitear** |
| `crm-strategy-discussion` | **0035–0044** (este trabajo) |
| `virtualizacion-tablero` | **0043** leaderboard_read_hoists_its_clock · **0044** leaderboard_poll_budget |

**Colisionan 0035–0038 y 0043–0044.** Y las tres sesiones vienen aplicándolas a **la misma `crm_dev`**, que quedó con `app.call` y `app.message` de una rama y las tablas de compliance de otra. El síntoma que lo destapó: `npm run db:migrate` falla con **`HR002: policy_class owner_scoped_read has no generator`** — una rama registró una clase de política que el `harden()` de la otra no conoce. **drizzle-kit se traga el error**; sólo apareció corriendo el migrador a mano con las causas encadenadas.

- ⚠️ **Lo que yo le hice a `crm_dev` y hay que decirlo:** apliqué la 0039 a mano para diagnosticar, sin registrarla en el journal, y después la revertí quirúrgicamente (`recent_contact_signal`, `tenant_lookup_meter`, `lookup_kind`, su fila de registro). **La base quedó como estaba antes de que yo tocara** — rota por la colisión de ramas, no por eso.
- **Mi rama está verificada contra su propia base aislada**, construida sólo con mis migraciones: 45 archivos, 472 tests. La colisión es un problema de merge, no de este código.
- **No hay mecanismo que lo prevenga.** El número de migración se elige mirando el árbol propio, y un worktree no ve los otros.

### ✏️ LA MARCA DE NÚMERO MALO POR FIN TIENE ESCRITOR (2026-08-10)
Migración **0044** · `tests/integration/contact-editing.test.ts`. **454 → 464 tests · 43 → 44 archivos.** Mitad de servidor del ítem 27 (ruta B).

**`contact_phone.bad_number_at` era la segunda columna muerta**, y su consecuencia era concreta: **un número que ya rebotó se seguía ofreciendo para discar**, así que la vendedora quemaba intentos en una línea que no puede conectar y la tasa de calidad del vendor era inmedible. Ahora tiene escritor, con razón obligatoria — *"bad" no es una razón*, y una cadena vacía es cómo un campo requerido se vuelve opcional en la práctica.

- **La PRIMERA marca gana.** `bad_number_at` es cuándo nos **enteramos** de que el número era malo; un discado fallido posterior no lo vuelve nuevamente malo, y sobrescribir movería en silencio la evidencia de cuándo el vendor nos vendió una línea muerta. **Y se puede levantar**, porque una marca que nadie puede sacar es un lead que nadie puede volver a llamar nunca — con verbo propio, para que no ocurra por pasarle el valor equivocado a la marca.
- 🎯 **Las dos funciones son `SECURITY INVOKER` a propósito, y la mutación lo prueba:** convertirlas en `DEFINER` pone rojo *"cannot flag a number in another seller's book"* — Ana marcando el número de Ben. **El silo sale del RLS, no de un predicado que alguien escribió**, que es el mismo patrón que salió mejor de lo especificado en la ventana de llamada.
- **Un ZIP editado mueve la ventana de llamada**, y hay un test que lo assertea: no es un campo cosmético, cambia **cuándo se puede llamar legalmente a ese lead**.

🔴 **QUINTA VEZ QUE ESTE PROYECTO PAGA LA BASE COMPARTIDA, Y ESTA VEZ LA CAUSÉ YO — en una tabla `ref`, no en un id de tenant.** Mi fixture sembraba `33101` en `ref.zip_timezone`, que es **la fila exacta que `calling-window.test.ts` inserta sin `ON CONFLICT`**: el archivo que corriera segundo moría con clave duplicada y **se llevaba puesto su fixture entero** — 12 tests saltados, no fallados, que es la forma en que este fallo se disfraza. Las cuatro anteriores fueron ids de tenant asignados a mano; ésta fue **datos de referencia**, que nadie estaba mirando. Sigue sin haber mecanismo: sólo el hábito de que cada suite sea dueña de sus filas.

📐 **HALLAZGO SOBRE MY BOOK (ítem 24), que no hay que inventar:** `04b` §1253 dice que el chip es **el enum `health` computado en el SERVIDOR**, *"so the board, My Book and My Day are byte-identical"*. O sea que My Book **no define un estado nuevo** — comparte el que el tablero ya calcula. Pero hoy `healthOf()` vive dentro de `app/routes/api/board.ts`, y §2.8 es explícito en que tres pantallas decidiendo por su cuenta son tres respuestas a una pregunta que el vendedor hace una vez. **La precondición de My Book es extraer esa función a `app/lib/**`** — que es además exactamente lo que el test de frontera cliente-servidor pide cuando algo de una ruta se necesita en otro lado, trampa que este proyecto ya pagó dos veces.

### 📦 EL ALMACÉN DE EVENTOS Y EL OUTBOX: RUTA A COMPLETA (2026-08-10)
`app/db/schema/event-store.ts` · migración **0043** · `tests/integration/event-store.test.ts`. **444 → 454 tests · 42 → 43 archivos.** **El transporte de eventos existe. El timeline (ítem 20) queda desbloqueado.**

**LA FILA DEL EVENTO Y SUS FILAS DE FAN-OUT SE ESCRIBEN EN UNA SOLA TRANSACCIÓN**, que es el argumento entero del outbox: sin él, *"la venta ocurrió"* y *"a los consumidores se les avisó"* son dos commits, y un worker que muere entre ellos pierde una celebración o un append al ledger **en silencio, y sólo para los eventos que ocurrieron durante la caída**. La división con pg-boss es total: **el outbox es dueño del fan-out, pg-boss del scheduling.** Dos sistemas que ambos creen que entregan es cómo un lead recibe dos mensajes.

🔴 **UN BUG DE DISEÑO MÍO, QUE HABRÍA CONTADO UNA VENTA DOS VECES.** Puse la idempotencia en `ON CONFLICT` sobre la **primary key** — y la PK incluye `occurred_at`, que la función misma genera con `clock_timestamp()`. La segunda emisión del **mismo `event_id`** llegaba con otra clave de partición, otra PK, y entraba como fila nueva: **Earnings se habría enterado de una venta dos veces.** `05b` ya tenía la respuesta escrita y yo no la había aplicado: *"the dedupe that actually matters for external redelivery is the natural key"* — Aloware reentregando una llamada no reusa nuestro uuid, reusa `aloware_call_id`. Movido a `(tenant, event_name, idempotency_key)`. 🎯 Mutación: sacar ese chequeo → rojo, con 2 donde debía haber 1.

🔴 **Y UNA CORRECCIÓN QUE ME HIZO EL GUARDIÁN DEL SILO EN UNA CORRIDA.** `harden()` levantó `HR001` pidiendo fila de registro para `event_log_2026_08`. Mi primer arreglo fue **excluir los hijos de partición** de `security.managed_relations()` — y `silo.test.ts` se puso rojo al instante: *"app.event_log_2026_08 has RLS disabled"*. **Excluirlos habría dejado una relación gestionada sin FORCE RLS: cambiar una invariante real por una comodidad.** El arreglo correcto es que **la partición HEREDE la clasificación del padre**: `harden()` ahora resuelve el padre vía `pg_inherits` cuando la relación es una partición. Cada partición queda endurecida con exactamente la política del padre, y una tabla sin clasificar que **no** sea partición sigue levantando `HR001`.

- **Las particiones se crean con `format()`**, así que el regex de `snapshot-chain` no las ve — y es correcto, no una evasión: una partición es **almacenamiento de un padre declarado**, y `event_log_2026_08` no tiene por qué estar en un archivo de esquema mientras `event_log` sí lo está. Hay un test que lo afirma en vez de dejarlo implícito. **Sin partición DEFAULT a propósito:** absorbería en silencio filas de un mes que nadie creó, y lo primero que se notaría sería un planner escaneándola para siempre.
- **`app.outbox_claim` es el SEGUNDO de los cuatro caminos cross-tenant sancionados**, y está en la lista de excepciones del gate de definers con su razón: el despachador tiene que **encontrar trabajo en todas las agencias antes de saber de quién es**. Devuelve **cuatro columnas y ningún payload** — hay un test que lee `pg_proc` y lo assertea. Un claim que devolviera el cuerpo del evento sería una lectura cross-tenant de todo el sistema disfrazada de cola.
- **Una fila de fan-out para un consumidor que no existe la rechaza una FK**, no un chequeo que alguien recuerda.

### 🔤 UN EVENTO INVENTADO YA NO SE PUEDE ESCRIBIR, NO SÓLO NO COMPILA (2026-08-10)
`app/db/schema/events.ts` · migración **0042** · `tests/integration/event-vocabulary.test.ts`. **437 → 444 tests · 41 → 42 archivos.** Primera mitad del transporte de eventos (ruta A).

**`app.event_name` es un ENUM de 49 etiquetas generado del MISMO registro que genera la unión de TypeScript.** La unión ya hacía de un nombre inventado un error de build **para el código que escribimos nosotros**; no hacía nada contra un nombre que llega como **DATO**: un cuerpo de webhook, un payload de job replayado, un `INSERT` a mano a las 2 de la mañana durante un incidente. **Un enum los rechaza a todos, a cualquier hora, por cualquier actor** — que es la diferencia entre una regla y un mecanismo. `'opportunity.closed_won'::app.event_name` ahora falla; hay un test que lo assertea y otro de control positivo con `opportunity.won`, porque sin él la aserción pasaría igual sobre un tipo que no existe.

**`app.event_consumer`: 268 pares (consumidor, evento) sembrados desde el catálogo.** Es lo que convierte la columna `consumers` de documentación en restricción — el outbox lleva FK acá, así que **una fila de fan-out para un consumidor que no existe no se puede escribir**. El test compara contra el registro **en las dos direcciones**: declarado y ausente, o presente y no declarado. 🎯 Mutación: sacar `earnings` de los consumidores de `opportunity.won` → rojo por el lado *"declared nowhere"*, que es el que no se prueba solo.

- **Comparado EN ORDEN, no como conjunto.** Postgres ordena un enum por declaración y la suite de ventana de llamada ya pagó eso una vez; un `sort()` previo escondería un reordenamiento que cambia cualquier `ORDER BY` sobre esa columna.
- 🔴 **Un error mío corregido antes de que llegara a producción:** la primera versión del esquema leía `contracts/events/catalog.json` con `node:fs` **en tiempo de módulo**, atando el esquema —y el server— al directorio de trabajo del proceso. Anda desde la raíz del repo y habría fallado en la imagen construida. Ahora importa `catalog.generated.ts`, que es el artefacto que la puerta del contrato ya mantiene honesto.
- 📐 **P12 subió a 112.958 y NO fue mío: medido contra el commit anterior da el MISMO número.** El salto desde 111.068 es el drawer del Módulo 9 entrando al grafo de la ruta, que su propia entrada ya había registrado en 112.924. **El catálogo no está en el bundle del cliente**, verificado buscando un nombre de evento en los chunks.

⚠️ **LO QUE FALTA DEL TRANSPORTE, y es la mitad más cara:** `event_log` **particionado por mes** con `app.event_seq`, `event_outbox` **particionado por día**, `app.event_emit()` —que escribe la fila del evento **y** sus filas de fan-out en la MISMA transacción— y el relay. Sin eso el timeline (ítem 20) sigue bloqueado.

### ⚖️ FALLO: EL CONSENTIMIENTO NO ENTRA A LA PUERTA · Y EL TIMELINE CUELGA DEL TRANSPORTE (2026-08-10)
Sin código. Un fallo de Jorge y un hallazgo de orden que cambia qué sigue.

**FALLO DE JORGE — el consentimiento NO es un paso de la puerta de compliance, por ahora.** Cierra la contradicción que quedó abierta al construir el ítem 11: D-SEC-4 encadena `sms_disabled → suppressed → zona → ventana → grabación → allow` **sin nodo de consentimiento**, mientras el vocabulario ratificado de `compliance.send_blocked` sí trae `no_consent`. Dos textos aprobados que no coincidían. **Manda el diagrama.** El `consent_ledger` sigue registrando y `app.consent_state()` sigue contestando; lo que no hace es bloquear un discado. Si esto se revisa, es una migración chica y un veredicto más — no un rediseño.

🔴 **EL TIMELINE (ÍTEM 20) NO ES "UNA TABLA MÁS": CUELGA DEL TRANSPORTE DE EVENTOS.** `timeline_entry` es una **proyección derivada** cuya columna `built_from_event_id` es **NOT NULL** — cada fila reclama proveniencia de un evento — y su único escritor es `app.timeline_upsert()`, llamado por el **proyector** sobre `event_log`. Y `event_log` no es una tabla suelta: va **particionada por mes**, con `event_outbox` y un relay aparte.

- **Consecuencia de orden:** el bus de eventos que shippeé el 09-08 es **contrato, tipos y puerta, sin transporte** — y eso, que anoté entonces como deuda, es ahora el bloqueo del bucle diario. Construir el timeline antes obligaría a aflojar un `NOT NULL` de proveniencia para poner un id de evento que nunca existió, que es exactamente la forma de arreglo que este proyecto rechaza.
- **Lo que del bucle diario NO depende de eventos, verificado y no supuesto:** el ítem **24** (My Book) y el ítem **27** (edición de campos + marca de número malo). Ninguno referencia `event_log`.
- **La frase del spec que decide el diseño del timeline cuando se construya:** *"the timeline is for the seller, the audit log is for the lawyer"* — el timeline lleva **una** entrada por veredicto por contacto por ventana de 60 s; el audit log lleva una fila por **cada** intento. Dos caminos de escritura con semánticas de deduplicación distintas desde una sola evaluación.

⚠️ **Y UNA SEGUNDA COLUMNA MUERTA, encontrada por el mismo método que la primera: `contact_phone.bad_number_at`.** Declarada desde la 0010, no la escribe nadie. Es la mitad del ítem 27, y su ausencia significa que hoy **un número que rebotó se sigue ofreciendo para discar**. Van dos de dos: cada vez que fui a ver de dónde iba a leer una feature, la columna estaba declarada y muerta. **Vale como método, no como anécdota** — antes de construir sobre una columna, preguntar quién la escribe.

### 🫱 EL MOTOR DE TOUCH, Y UNA COLUMNA MUERTA QUE HACÍA IMPOSIBLE AL ÍTEM 13 (2026-08-10)
`app/db/schema/pipeline.ts` · `calendar.ts` · migración **0041** · `tests/integration/touch-engine.test.ts`. **428 → 437 tests · 40 → 41 archivos.** Ítem 25 — **primer trabajo del bucle diario**.

🔴 **EL HALLAZGO, y salió de mirar de dónde iba a leer el motor: `contact.last_touch_at` está declarada desde la migración 0010 y NADIE la escribe.** La leen `app.recent_contact_signal` (0039) y la ruta de contacto — y ningún camino del árbol la seteaba jamás. **O sea que el ítem 13 que cerré hace dos horas no podía disparar nunca en producción, mientras pasaba sus diez tests**, porque los fixtures la escribían a mano. *Una columna que nadie escribe es una columna que no existe* — el registro ya anotó exactamente esto con `tenant.is_demo`. **Por eso el motor de touch va primero y no espera al módulo de comunicaciones.**

**EL FALLO DE `05b`, APLICADO: cinco eventos reclamaban el derecho a resetear `last_activity_at`, y la respuesta es un `max()` determinista.** UNA función de trigger, registrada por tabla con la columna que esa tabla llama *"cuándo ocurrió"*, escribiendo `GREATEST(viejo, nuevo)` — **monótono, nunca decrementado**.

- **Monótono no es código defensivo:** `last_activity_at` es la entrada de la clave de episodio frío, y un valor que puede ir para atrás hace que `opportunity.went_cold` dispare **dos veces por un episodio**. Es la diferencia entre una insignia y una manguera de notificaciones. 🎯 Mutación: sacar el `GREATEST` → rojo sobre un webhook tardío que llega con una fecha vieja.
- **DOS columnas, y la segunda tiene una razón que no es simetría.** `last_activity_at` se mueve con cualquier touch; **`last_human_touch_at` sólo con `created_by = 'human'`**. Si el frío se colgara del primero, una secuencia texteando un lead muerto cada cuatro días lo mantendría tibio para siempre: **la automatización enmascararía el abandono**, que es exactamente lo contrario de lo que la señal de enfriamiento existe para mostrar. 🎯 Mutación: hacer humano todo → rojo.
- **Una actividad toca cuando se COMPLETA, no cuando se crea.** Trabajo agendado para el jueves no es trabajo hecho, y contarlo resetearía el reloj frío de un lead con el que nadie habló. Una reunión toca en `outcome_at` y cuenta como humana, porque nada automatizado asiste a una.
- **`contact.last_touch_at` se mueve con CUALQUIER touch**, automatizado incluido: *"esta oficina contactó a este hogar"* es cierto lo haya hecho una persona o una secuencia.
- ✅ **Un test de punta a punta cierra el bucle con el ítem 13:** una actividad completada de verdad mueve la columna, y la señal —preguntada por el OTRO vendedor, así que ejercita la mitad entre silos— la ve.
- **El conjunto de fuentes de touch está FIJADO.** `05b` nombra cuatro (`activity`, `call`, `message`, `meeting`); existen dos. Agregar las otras dos es registrarlas contra la misma función, y fijar el set es lo que hace que **olvidarlas** sea un build rojo en vez de un lead que calladamente nunca se enfría.

➕ **`note` entra al enum `activity_type`**, que es el prerequisito del ítem 23 y algo que el registro venía marcando desde el alta rápida — la hoja tuvo que descartar el campo de nota porque no había dónde ponerlo. Un objeto de actividad único descarta una tabla de notas aparte.

⚠️ **Dos restricciones que ya existían y que no conocía, las dos buenas:** `activity_machine_work_is_explainable` (trabajo creado por máquina exige `source_event_name` — la forma-constraint de que *"¿por qué esto está en mi lista?"* siempre tenga respuesta) y **`TZ002`**, que rechaza una reunión sin `contact_timezone`, porque sin eso el recordatorio no se puede disparar en la hora local del lead.

### 🤫 LA SEÑAL QUE CRUZA EL SILO SIN DECIR QUIÉN, Y N13 ES EL TERCER PRESUPUESTO DEPENDIENTE DE MÁQUINA (2026-08-10)
`app/db/schema/lookup-meter.ts` · migración **0039** · `tests/integration/recent-contact-signal.test.ts`. **414 → 424 tests · 38 → 39 archivos.** Ítem 13. **El núcleo de compliance (8–13) queda cerrado.**

**EL DATO CRUZA EL SILO Y LA RESPUESTA NO, y ésa es la forma entera de la feature.** Ping-post revende al mismo consumidor a dos vendedores de la misma agencia, seguido dentro de la hora. Ben necesita saber que la oficina ya alcanzó ese hogar — y no debe enterarse de que el otro lead es de Ana, ni de que existe como registro, ni de nada que le sirva para encontrarlo.

- **Devuelve exactamente dos columnas: `status` y `minutes_ago`.** Sin nombre, sin id, sin dueño, y **deliberadamente sin un conteo**: que dos colegas tengan ese hogar es un hecho sobre el libro de la agencia, y nadie lo necesita para decidir no discar. **Un test lee `pg_proc` y assertea esas dos columnas**, así que volverla atributiva rompe el build en vez de ser una regla sobre lo que la UI dibuja.
- **No dispara sobre la actividad propia** (`c.owner_user_id <> v_user`). Un vendedor ya ve sus llamadas en el timeline; una señal que sonara sobre su propia llamada sería ruido en cada tarjeta que trabaja, y el ruido es lo que enseña a dejar de leer un chip. 🎯 Mutación: quitar esa exclusión → rojo.
- **Un contacto ajeno devuelve `none`, idéntico a "nadie tocó este hogar".** Una respuesta distinta para *"no es tuyo"* confirmaría que el registro existe.

✅ **`tenant_lookup_meter`: 60/min por usuario por tipo, incrementado DENTRO de la misma función definer.** Esto es un **oráculo de privacidad** — preguntá una vez y sabés un hecho; preguntá sesenta mil veces y enumeraste el libro entero de la agencia, número por número, sin leer jamás una fila a la que no tuvieras derecho. **Quick-add hace barato el ataque** (un vendedor puede inventar un contacto con cualquier número y preguntar), así que *"sólo tus contactos"* es un lomo de burro y no el límite. El límite es el medidor, y `crm_app` **no tiene ningún privilegio** sobre esa tabla: no hay otra puerta que olvidarse de medir. 🎯 Mutación: sacar el tope → rojo. **El medidor corre ANTES de la lectura**, así que una consulta rechazada también gasta un tick.

- ⚠️ **`05b` pide particionado diario con drop a 30 días; no está.** A cincuenta vendedores son ~72k filas/día en el peor caso que no ocurre, y un esquema de particiones es maquinaria operativa que debería llegar con una medición y no antes.

🔴 **N13 SE PUSO ROJO Y NO ERA EL CÓDIGO: EL HOST ESTABA AL 77% DE CPU CON UN JUEGO ABIERTO.** Vale escribirlo porque el diagnóstico me llevó cuatro pasos y el primero fue equivocado.

- **Mi primera lectura —"contención de máquina"— la desmintió la bisección**, y la segunda bisección fue **incompleta**: comparé sólo contra el ítem 11, que ya tenía mis cinco migraciones. Al medir contra `aae54fd`, **anterior a todo el trabajo de compliance**, dio **144,8 ms** — peor que con mis cambios (128–133 ms). **Inverso a lo que agregué: la firma del ruido, no de una regresión.**
- **Lo decisivo fue separar CPU de I/O dentro de Postgres:** `count(*)` sobre 5 millones de filas tardó **1,5 s** (en máquina sana ~0,5) mientras un scan de 35 MB tardó **9,4 ms**. CPU a un tercio, disco perfecto. De ahí a mirar los procesos del host, donde estaban los tres de League of Legends.
- **Cerrado el juego: `verify` verde a la primera, 424 tests, todos los presupuestos.**
✅ **Y LA AUSENCIA DEL DATASET DE ZIP DEJA DE SER SILENCIOSA (migración 0040, `tz-dataset.test.ts`, 424 → 428 tests · 40 archivos).** La 0037 shippeó `ref.zip_timezone` vacía a propósito, pero **nada lo registraba** — y una tabla vacía se ve idéntica a una cuya siembra falló: en los dos casos el resolver degrada callado a área y después a estado. Ahora `system_constant['tz_dataset_version'] = 'absent'` lo declara, con la razón que dice **qué lo desbloquea** (fuentes Census/ZCTA con checksums) y no sólo que está bloqueado.

- **El test pregunta en las DOS direcciones y lo hace ESTÁTICAMENTE, leyendo las migraciones.** Sembrar el dataset sin actualizar la constante es rojo; declarar una versión con la tabla vacía es el mismo rojo por el motivo opuesto. Estático porque `calling-window.test.ts` inserta una fila de ZIP como fixture y `crm_test` es compartida: preguntarle a la tabla viva daría respuestas distintas según qué archivo corrió primero. **Cuarta vez que la respuesta correcta es leer los archivos.** 🎯 Mutación: agregar un `INSERT INTO ref.zip_timezone` → rojo nombrando la contradicción.

- 📐 **N13 se suma a P6 y P20 como presupuesto DEPENDIENTE DE MÁQUINA**, y es el tercero. La respuesta que el proyecto ya usa para P6 es **la mediana de tres corridas**; N13 toma **una sola medición**. Darle la misma metodología **no afloja el número** —los 120 ms no se mueven y una regresión real aparece en las tres— pero hoy no habría salvado nada: con la máquina así, la mediana también era ~130. **Queda propuesto, no hecho:** cambiar cómo mide un gate es una decisión de Jorge.

### 🚦 LA PUERTA ÚNICA, Y UNA FUGA DE SILO QUE ME ENCONTRÓ UN TEST (2026-08-09)
`app/db/schema/compliance.ts` · migración **0038** · `tests/integration/compliance-gate.test.ts`. **393 → 414 tests · 37 → 38 archivos.** Ítems **11 y 12** del MVP, construidos juntos porque la puerta no puede ser correcta sin saber si hay un override activo. **El núcleo de compliance queda cerrado salvo una pregunta abierta, abajo.**

**EL ORDEN ES LA SEGURIDAD, y la mayor parte de la suite assertea precedencia y no veredictos sueltos.** `blocked_suppressed` se evalúa **antes** que el reloj, así que un STOP se rechaza a las 7:30 de la tarde por la misma razón que a medianoche. Y los dos veredictos de reloj van **últimos** entre los bloqueos, porque son los únicos dos que break-glass libera: ponerlos primero habría dejado que un override alcance una pregunta que nunca debe contestar.

🔴 **UNA FUGA DE SILO QUE INTRODUJE YO Y ATRAPÓ UN TEST: Ana obtuvo `allow` sobre el lead de Ben.** La causa es exacta y vale escribirla porque se va a repetir: `compliance_check` es **definer**, así que cuando delegaba en `app.calling_window_check` —que es **invoker** y saca su silo del RLS— la función interna heredaba el contexto del definer, **corría sin RLS y volvía a leer el contacto sin filtro**. Mi predicado de dueño estaba bien escrito y era decorativo. **Un invoker llamado desde adentro de un definer deja de estar acotado**, y eso no se ve leyendo ninguna de las dos funciones por separado. Cerrado con una salida temprana por visibilidad, antes de delegar.

- 🎯 **Probado por mutación:** sacar esa salida temprana pone rojo exactamente ese test, con `allow` donde debía decir `blocked_timezone_unknown`.
- 🎯 **Segunda mutación, la que la constitución prohíbe:** hacer que break-glass libere también la supresión → rojo sobre *"DOES NOT release a suppressed number"*. **Un admin bajo break-glass sigue sin poder discar un STOP, y la razón es estructural y no procedimental:** `override_scope` es un enum de **un solo valor**, así que no existe etiqueta que signifique *"levantá la supresión"*. Agregar una es `ALTER TYPE` — migración, diff y decisión deliberada.

🔴 **`05b` PIDE UNA COLUMNA GENERADA QUE POSTGRES RECHAZA.** `GENERATED ALWAYS AS (started_at + interval '60 minutes') STORED` falla con *"generation expression is not immutable"*: `timestamptz + interval` está marcada **STABLE**, porque un intervalo con meses o días sí depende de la zona (un "día" cruzando DST no siempre son 24 horas). Para un intervalo **fijo y sub-diario** es genuinamente inmutable, así que se declara `app.override_expiry()` como `IMMUTABLE` —una afirmación **verdadera**, no una mentira conveniente— y la columna sigue siendo generada y almacenada, que es lo que el ruling realmente quería: **un vencimiento que nadie puede extender**. Sin job: se computa en cada lectura.

⚠️ **Y CORREGÍ UN DEFECTO MÍO EN EL CONTRATO DE EVENTOS.** `compliance.send_blocked` lo había derivado de `02b` §4b; **`05-architecture.md` §5 trae el payload ratificado y outranks a Fase 2**. Tenía tres cosas mal: el campo es `verdict` y no `reason`, el vocabulario son **ocho** valores y no seis (faltaban `unknown_timezone` y `unverified_mapping`, que son justo los dos que este trabajo necesita), y faltaban `contact_phone_id` y `override_id`. **La marca `"payload": "derived"` hizo su trabajo** — por eso era encontrable.

**El guardián de grabación es proporcionado y no un freno de piso:** mientras `recording_guard` está `tripped`, sólo se rechazan llamadas a estados **all-party** (CA·FL·PA·IL·WA·MA, en `ref.state_recording_regime`, en **datos** y no en un `if`). Nueva York procede. Parar cincuenta vendedores por una configuración de proveedor sin verificar es un daño mayor que la exposición que quita.

- ⚠️ **Una trampa de fixture que vale registrar: Florida no sirve para probar break-glass.** Liberada de la ventana cae en `blocked_recording_unverified`, porque FL **es** all-party. La puerta tenía razón y el fixture estaba mal; los tests de override usan **Texas**, que también es de dos zonas pero one-party.

❓ **LA PREGUNTA ABIERTA, y no la resolví inventando: el consentimiento NO es un paso de la cadena.** El diagrama D-SEC-4 va `sms_disabled → suppressed → zona → ventana → grabación → allow`, sin nodo de consentimiento — pero el vocabulario ratificado de `compliance.send_blocked` **incluye `no_consent`**. Son dos textos aprobados que no coinciden. Construí **la cadena que el diagrama especifica** y dejo la contradicción anotada en vez de agregarle un veredicto por mi cuenta: meter consentimiento en el choke point es un ruling, y los rulings son de Jorge.

### 🕘 LA VENTANA DE LLAMADA: LA INTERSECCIÓN, NO UNA ELECCIÓN (2026-08-09)
`app/db/schema/timezone.ts` · migración **0037** · `tests/integration/calling-window.test.ts`. **381 → 393 tests · 36 → 37 archivos.** Ítem 10 del MVP. Construido contra **§SEC-9**, que es rango Parte I y cierra la decisión de fuente de datos.

**LA PARTE FILOSA, Y ES CONTRAINTUITIVA: un ZIP o un estado que abarca dos zonas NO se puede colapsar a una respuesta, porque el colapso intuitivo se equivoca en UNA SOLA dirección del día.** Para un lead de Florida —Eastern y Central— elegir Eastern cierra la ventana temprano a la tarde (conservador) y la **abre antes de las 9:00 AM Central** (permisivo). Elegir Central invierte los dos errores. **Ninguna zona sola es conservadora en las dos puntas.** Por eso el resolver devuelve un CONJUNTO y la ventana es la **intersección**: `bool_and` sobre todos los candidatos.

- 🎯 **Probado por mutación con las dos formas realistas de romperlo, y las dos caen sobre el mismo caso: Florida a las 9:30 Eastern.** (1) `bool_and` → `bool_or` (*"alcanza con que una zona esté abierta"*). (2) Colapsar el conjunto a una zona con `LIMIT 1` (*"elegí Eastern para Florida, que es lo poblado y defendible"*). **Ninguna otra aserción de la suite atrapa eso** — y sería un discado ilegal para cada consumidor del Panhandle en el libro.
- ✅ **El evaluador es tzdata de verdad, no un offset fijo, y hay un test que lo prueba:** 13:30 UTC son 09:30 EDT en julio y 08:30 EST en enero — **misma hora UTC, veredictos opuestos**. §SEC-9 nombra exactamente ese fallo como la razón de que esto viva en Postgres y no en JavaScript: un offset a mano da la misma respuesta las dos veces y se equivoca para cada lead en los dos días de transición de DST al año.

🟢 **DOS DECISIONES DE DISEÑO QUE SALIERON MEJOR DE LO ESPECIFICADO, las dos por quitar definers.** Las tres tablas son clase `reference`, que `crm_app` ya puede leer, así que **el resolver no necesita ser `SECURITY DEFINER`**: no hay privilegio que pedir prestado ni tenant que afirmar. Y `calling_window_check` es **invoker sobre tablas `owner_scoped`**, así que **el RLS le pone el silo sin una sola línea de predicado escrita a mano** — un contacto ajeno no resuelve a nada y la respuesta es `blocked_timezone_unknown`, indistinguible de un contacto inexistente, y **falla cerrado** que es la dirección correcta para un accidente. Un definer menos es un lugar menos donde el silo se puede apagar sin querer.

🔴 **DOS DE LAS TRES TABLAS SHIPPEAN VACÍAS, Y ES DELIBERADO, NO UN PENDIENTE OLVIDADO.**
- **`ref.zip_timezone` (~41k filas) vacía.** §SEC-9 exige que se genere **sólo de fuentes de dominio público redistribuibles** —relaciones ZCTA del Census unidas a `tzdata` de IANA—, con un generador que emita URLs y checksums y un chequeo de CI que compare el encabezado. **Escribir 41.000 filas de memoria sería un dataset plausiblemente-mal alimentando un BLOQUEO DURO**, que es exactamente el fallo que este proyecto existe para rechazar.
- **`ref.area_code_timezone` (~340) vacía, y por una segunda razón encima de la procedencia:** esa capa **está mal para móviles portados**, que son comunes en el mercado de final expense —quien se mudó de Nueva York a Florida se queda con su 718—, y por eso §SEC-9 le fija la confianza en `low` **siempre**. Una tabla parcialmente sembrada sería **peor que vacía**: una falla cae al estado y sigue conservadora, un acierto equivocado da una respuesta confiada y falsa.
- **Vacío es seguro, no roto:** la cadena degrada a estado y lo no resuelto **falla cerrado**.

**`ref.state_timezone` SÍ sembrada, 51 códigos.** Es la única capa chica y estable como para escribirse a mano. ⚠️ **Lleva TRES straddles más que los doce que nombra el ruling, y es un agregado deliberado y no una corrección:** `AZ` (el estado no observa DST, la Nación Navajo adentro sí), `NV` (Pacific salvo West Wendover) y `AK` (salvo las Aleutianas occidentales). **La aritmética del propio diseño decide la dirección: sumar un candidato sólo puede ACHICAR la ventana.** Un straddle omitido es el único error que produce un discado ilegal; uno agregado cuesta un poco de tiempo legal de llamada, que es el intercambio que el ruling ya aceptó por escrito.

- ✅ **`TZ001`: una zona que la base no conoce no se puede guardar.** Un typo acá no es un problema de calidad de datos — la fila nunca matchea, el resolver cae o devuelve nada, y **un lead queda permanentemente inllamable sin que nada tire error**. Validado contra `pg_timezone_names`, que es el mismo catálogo que evalúa `AT TIME ZONE`.

⚠️ **LO QUE FALTA PARA EL ÍTEM 11, y el diagrama D-SEC-4 lo da entero:** la puerta única encadena `blocked_sms_disabled` → `blocked_suppressed` → resolución de zona → **esta ventana** → `blocked_recording_unverified` → allow. Existen los eslabones 3 y 4. Faltan el orden, los otros tres veredictos, el break-glass —que libera **exactamente** `blocked_timezone_unknown` y `blocked_calling_window`, y nada más— y la razón en inglés llano escrita al timeline.

### 🚫 LA LISTA DE SUPRESIÓN, Y UNA PUERTA QUE SU PROPIO COMENTARIO DERROTABA (2026-08-09)
`app/db/schema/suppression.ts` · migración **0036** · `tests/integration/suppression-list.test.ts` · `definer-tenancy.test.ts`. **366 → 381 tests · 34 → 36 archivos.** Ítem 9 del MVP.

**LA TABLA ES TENANT-WIDE A PROPÓSITO, y es lo contrario de todo lo demás en este esquema.** Ping-post revende al mismo consumidor a dos vendedores de la misma agencia, así que un STOP que recibe Ana **tiene que apagar el discador de Ben** —de inmediato, y sin que Ben se entere nunca de que Ana tiene ese lead. Acotarla por dueño produciría un producto que honra el STOP para quien lo recibió y sigue discando desde el escritorio de al lado: una violación TCPA con el documento de diseño que prueba que fue deliberada.

- **Las aserciones corren en dos direcciones a la vez, que es raro: el DATO tiene que cruzar el silo, la CONSULTA no.** `definer_only` otra vez, porque `stop` significa *un consumidor le contestó STOP a alguien de esta agencia* — así que contestar *"¿este número está suprimido?"* sobre un número arbitrario contesta *"¿hay un colega trabajando a este consumidor?"*.
- **La forma estructural de la regla: no hay columna de dueño donde escribir.** El test assertea la ausencia de `owner_user_id` **y** que la fila de registro tiene `owner_column NULL`, que es lo que impide que una migración futura la reclasifique como `owner_scoped` y vuelva el STOP local al vendedor sin que nada se ponga rojo.
- **Un START no borra el STOP**, appendea y la fila anterior queda. *"¿Este número estaba suprimido el día 14?"* tiene que seguir contestando que sí para siempre.
- **Siete `kind`, y no son severidades sino PROCEDENCIAS**: `stop` es la palabra del consumidor, `dnc_federal`/`dnc_state` vienen de una lista que no escribimos nosotros, `litigator` es una decisión comercial y no una obligación legal, y `carrier_block` es la red diciendo que el mensaje nunca llegó — que no es consentimiento en absoluto. Colapsarlas a un booleano las vuelve indistinguibles el día que haya que explicarle una a un regulador.

✅ **LA PUERTA SOBRE `pg_proc` QUE `05b` PEDÍA POR ESCRITO Y NO EXISTÍA.** *"Every SECURITY DEFINER function's body must contain `app.current_tenant()`, asserted by a CI query over `pg_proc.prosrc`."* Adentro de un definer el RLS que acota todo lo demás **está apagado** —corre como `crm_migrator`, cuya política `p_sys` es `USING (true)`—, así que la frontera de tenant deja de ser estructural y pasa a ser lo que diga el cuerpo. Un cuerpo que se olvida no falla con un error: filtra las filas de una agencia a otra, en silencio, para siempre.

- **Cuatro excepciones, cada una con su razón, y la lista está FIJADA:** `begin_request` y `begin_system_work` **son** la llamada que establece (exigirles leer lo que ellas escriben sería circular), `resolve_identity` corre **antes** de que exista un tenant, y `scheduled_job_claim` es un camino cross-tenant **sancionado** —abanica sobre todos los tenants a propósito, `DISTINCT ON (tenant_id)` es equidad para que una agencia ocupada no deje sin turno al resto— y devuelve sólo coordenadas de job, ningún dato de contacto ni de dinero.

🔴 **Y LA MUTACIÓN ENCONTRÓ QUE MI PROPIA PUERTA ERA FALSA.** Cambié `app.current_tenant()` por `current_setting('app.tenant_id', true)::uuid` en `suppression_append` —mismo comportamiento, sin la llamada nombrada, que es el fallo realista— y **el gate pasó igual**. La causa: **`prosrc` es el texto crudo del cuerpo, comentarios incluidos**, y el comentario que satisfacía al grep era el que explica esta misma regla. **Una puerta derrotada por su propia documentación pasa para siempre.** Ahora la consulta despoja comentarios de línea y de bloque antes de machear; con la mutación puesta se pone roja nombrando la función con su firma completa, y vuelve a verde al revertir.

⚠️ **NO SHIPPEA LECTOR, y la ausencia es el diseño.** `app.suppression_state(phone)` sería el compañero obvio y es exactamente el oráculo entre silos que esta clase existe para prevenir. El único lector sancionado es `app.compliance_check()`, y **no se puede escribir hasta que exista la ventana de llamada local al lead (ítem 10)**: una puerta que contesta sobre consentimiento y supresión ignorando el reloj devolvería *"se puede enviar"* a las 2 de la mañana en la zona horaria del lead. **Hasta entonces la tabla registra y no contesta** — y registrar desde el día uno es lo que hace que la puerta sea correcta el día que aterriza, en vez de correcta de ahí en adelante.

### 🔒 EL LEDGER DE CONSENTIMIENTO, Y LA PRIMERA TABLA QUE NADIE PUEDE LEER (2026-08-09)
`app/db/schema/consent.ts` · migración **0035** · `tests/integration/consent-ledger.test.ts`. **349 → 366 tests · 33 → 34 archivos.** Ítem 8 del MVP. Primer trabajo sobre el `master` consolidado.

**LA PREGUNTA QUE ESTA TABLA CONTESTA NO ES *"¿podemos contactar a esta persona hoy?"*, es *"¿qué era cierto a las 14:07 de un martes hace diecinueve meses?"*** — y una columna de estado mutable no la contesta a ningún precio. Por eso una revocación es **una fila nueva**, la tabla es inmutable por trigger **y** por privilegio revocado, y el único escritor es `app.consent_append()`.

🔴 **CAMBIÓ EL MOTOR, NO SÓLO SE AGREGÓ UNA TABLA. `harden()` otorgaba `GRANT SELECT` incondicionalmente** y confiaba en que `USING (false)` devolviera cero filas. Desde la 0035 no lo otorga para `definer_only` ni `system_cross_tenant`. **Se lee igual desde la aplicación y no es lo mismo:** un privilegio que sólo una política neutraliza está a **una política borrada** de ser una lectura tenant-wide del historial de consentimiento de cada consumidor. La constitución pone la revocación por encima de la política; `consent_ledger` es la primera tabla que necesita ese orden porque es la primera `definer_only` que existe. **Radio de explosión cero: ninguna otra tabla usa esas clases.**

- **`definer_only`, no `append_only_tenant`**, que era el calce cómodo: esa clase genera `USING (tenant_id = app.current_tenant())`, o sea **legible tenant-wide**. El consentimiento es tenant-wide por necesidad —un STOP silencia un número para todos los vendedores— así que una tabla de consentimiento legible es **un oráculo entre silos**: preguntá por un número y enterate de si otro del piso está trabajando a ese consumidor.
- **El valor se normaliza ADENTRO de la función.** Seis puntos de entrada llegan al consentimiento y un helper que los seis tienen que acordarse de llamar es un helper que uno no va a llamar. `+1 305 555 0171` que no matchea `+13055550171` es un STOP que calladamente no aplica.
- **`previous_status` se DERIVA, nunca se pasa.** Un caller capaz de declararlo es un caller capaz de declararlo mal, y esa columna se lee como evidencia de una transición. Igual el actor: sale de `app.current_user_id()`, y `NULL` es el valor honesto para un STOP que llega del proveedor.
- **La propiedad del silo vive DENTRO del definer**, porque un definer corre como `crm_migrator` y ahí el RLS que acota todo lo demás está apagado. Un contacto ajeno devuelve **cero filas, nunca un error**: un error confirmaría que el registro existe, que es la misma filtración con un código de estado puesto.

🎯 **DOS MUTACIONES, Y LA PRIMERA ENCONTRÓ QUE MI PROPIO TEST NO SERVÍA.** Saqué el predicado de dueño de `consent_state` y **la suite quedó VERDE**. La razón: sembré consentimiento sólo para el teléfono de Ana, así que *"Ana no ve nada del contacto de Ben"* lo satisfacía **una tabla vacía**, no el predicado. Agregado el control positivo —Ben leyendo su propia fila— la misma mutación se pone roja con el síntoma real: Ana leyendo la fila de Ben. **Un test que pasa sin poder fallar no vale nada, y la única forma de descubrirlo fue mutarlo.**

- 🎯 **Segunda mutación: `harden()` de vuelta a `GRANT SELECT` incondicional → dos rojos**, y el mensaje del segundo es el que vale: *"the read was not refused at all"*. Con el privilegio restaurado la lectura **tiene éxito y devuelve vacío** por la política, en vez de ser rechazada. Ésa es exactamente la distinción que ese test existe para sostener, y es la que un test escrito contra *"devuelve vacío"* no puede ver.

⚠️ **TRES TRAMPAS DE POSTGRES/DRIZZLE QUE ESTE PROYECTO YA HABÍA PAGADO, y volví a pagar las tres:**
1. **Drizzle reenvuelve el error del driver**, así que `permission denied` queda un nivel abajo en `cause`. La aserción miraba el nivel equivocado mientras la negativa funcionaba perfecto.
2. **Una sentencia rechazada ABORTA la transacción**, así que atraparla adentro del callback deja la sesión envenenada y revienta al salir. Atrapar y después preguntar son **siempre dos unidades de trabajo**.
3. **Postgres ordena un enum por orden de DECLARACIÓN, no alfabético** — `ORDER BY channel` da `sms` antes que `call`. El test ordena por `channel::text` y lo deja anotado en vez de codificar una expectativa que depende del orden en que alguien escribió los miembros.

⚠️ **LO QUE NO ESTÁ, dicho y no insinuado:** `suppression_list` (ítem 9) y `app.compliance_check()` (ítem 11). El spec dice que `crm_app` sólo puede ejecutar `compliance_check` y `consent_state`; hoy existe la segunda. **`compliance_check` necesita la supresión para poder contestar**, así que escribirla ahora sería una puerta que contesta media pregunta — y una puerta de compliance que contesta de más es peor que ninguna.

### 🚌 EL BUS DE EVENTOS EXISTE, Y DOS PUERTAS QUE NO FUNCIONABAN EN UN WORKTREE (2026-08-09)
`contracts/events/catalog.json` · `scripts/generate-events.ts` · `app/lib/events/catalog.generated.ts` · `app/lib/events/events.ts` · `scripts/events-contract.test.ts` · `tests/integration/setup/urls.ts` · `scripts/check-perf-budgets.ts`. **243 → 261 tests · 26 → 27 archivos.** Paso 1 del orden revisado, cerrado.

**EL CONTRATO DE 49 EVENTOS DEJA DE SER PROSA.** `CLAUDE.md` describía `app/lib/events/**` como *"generated from contracts/events/"* y declaraba que *"an event outside the canonical 49 is a bug"*. **Ninguno de los dos directorios existía** y el catálogo vivía sólo como una tabla markdown en un documento de 57 KB — o sea que la regla era documentación, y por el propio test de la constitución eso hay que decirlo en vez de presentarlo como mecanismo. Ahora: una fuente JSON, un generador, tipos generados y una puerta que se pone roja en las dos direcciones.

- 🎯 **PROBADO POR MUTACIÓN, las dos mitades.** (1) Escribí `'opportunity.closed_won'` en un archivo de `app/` → rojo nombrando **archivo, fantasma, reemplazo y consecuencia** (*"Six modules were waiting for this name…"*). (2) Edité a mano el archivo generado → rojo con el comando a correr. **Un test que pasa sin poder fallar no vale nada.**
- 🔴 **LOS FANTASMAS SON LA MITAD QUE DE VERDAD ATRAPA COSAS, y por eso están en el contrato: 33 nombres descartados, cada uno con su remapeo y su consecuencia.** §2 los llama *el hallazgo real*: un módulo esperando `opportunity.closed_won` **nunca dispara con una venta y nada se pone rojo** — la venta simplemente no se celebra. Un registro positivo no puede atrapar eso: ve un nombre que no conoce, no un nombre que fue **descartado**. Se escanean literales entrecomillados en `app/**` y `scripts/**`; la prosa en un comentario sigue permitida a propósito, porque prohibirla se "arregla" borrando la explicación.
- **Cuatro de los 49 ya son de motor** (`sequence.*`, `automation.executed`), que es la evidencia de que la reversión de abajo sale barata.
- 🔴 **DOS DESVÍOS DEL DOCUMENTO, los dos deliberados y anotados en el `$about`.** (1) §4 nombra el dinero con sufijo `_usd` —`delta_usd`, `amount_usd`— y **ese sufijo es una invitación a poner dólares en un number**; acá todos son `money` y generan el tipo `Money` branded. **15 campos de dinero, en una lista FIJADA** — no adivinada por el nombre. (2) El envelope se declara **una sola vez**: §4 lo escribe entero adentro del payload de `lead.created` y copiarlo daría dos definiciones de `tenant_id`, y la que se desvía siempre es la copia.
- ⚠️ **PROVENIENCIA MARCADA, porque las dos mitades no se especificaron igual.** Los 40 de §4 traen lista de campos ratificada; los **9 de la Enmienda 1 NO traen tabla de payload**, así que sus campos están **derivados de tres frases** y marcados `"payload": "derived"`. Un payload derivado es una propuesta que compila, no un contrato ratificado.
- **Lo que NO es todavía: no hay transporte.** Esto es el contrato, los tipos y la puerta. El outbox y el despacho necesitan migración, y la numeración de migraciones es justo donde dos sesiones en paralelo chocan.

🔴 **UN WORKTREE AÍSLA ARCHIVOS Y NO LA BASE — CUARTA VEZ QUE ESTE PROYECTO PAGA LA FIRMA DEL ESTADO COMPARTIDO, y la primera por worktrees en vez de por archivos.** `TEST_DB` era la constante `'crm_test'` para todo checkout de la máquina, y `globalSetup` la **dropea y reconstruye en cada corrida**. Dos worktrees corriendo vitest a la vez = cada uno le borra el esquema al otro a mitad de vuelo.

- **El síntoma es lo que hace caro esto: `duplicate key value violates unique constraint "tenant_pkey"`, `write CONNECTION_CLOSED` y timeouts de hook, sobre un conjunto de archivos DISTINTO en cada corrida, mientras cada suite pasa sola.** Un rojo que nombra una víctima distinta cada vez cuesta una hora antes de que alguien sospeche del arnés en vez del cambio.
- ⚠️ **Y me llevó a una conclusión equivocada antes de medirlo bien:** lo atribuí a "contención de máquina" después de ver `search-perf` pasar aislada, y **la bisección lo desmintió** — HEAD limpio pasaba a la primera. Lo decisivo no fue razonar sino mirar los procesos: `vitest run` corriendo desde `worktrees/virtualizacion-tablero-304005` al mismo tiempo. **El método falló antes que el código.**
- **Arreglo: `TEST_DB` se deriva del worktree** (`crm_test_<slug>`). Radio de explosión chico a propósito — un checkout plano y el CI caen a `crm_test` y se comportan igual que antes. **El rebuild por corrida se queda**: es correcto, y sólo era inseguro cuando dos corridas comparten el destino.

🔴 **Y LA PUERTA DE PERFORMANCE NUNCA HABÍA CORRIDO DENTRO DE UN WORKTREE.** `npm run perf` levantaba **PERF003** en HEAD limpio también — verificado por bisección, no supuesto. La causa: `node_modules` está hoisteado al padre del repositorio, así que un build desde `.claude/worktrees/<name>/` —tres niveles abajo— emite la clave del manifest como `../../../node_modules/@react-router/dev/…` mientras un checkout plano la emite sin prefijo.

- **La ironía que lo hace urgente: la sesión de virtualización trabaja en un worktree sobre P6, y no podía correr el gate que la mide.**
- ✅ **`resolveClientEntry()` RESUELVE la clave, no afloja el check.** Una entrada de verdad ausente sigue siendo PERF003, y **dos candidatas fallan con `PERF008` en vez de elegir una** — medir la entrada equivocada es exactamente lo que este checker existe para prevenir, y adivinar en silencio sería peor que no medir. `CLAUDE.md`: *"do not weaken a budget… to make a build pass"*.
- **Primera medición de P12 desde un worktree: 111.068 / 128.000 bytes (87%).** El bus de eventos suma **cero al bundle del cliente** — nada lo importa todavía y su único import es `import type`.

⚖️ **DOS SESIONES ARREGLARON PERF003 DE FORMA DISTINTA, Y LA ENTRADA DE MÓDULO 9 DICE QUE LA MÍA ESTÁ PROHIBIDA. Reconciliado acá en vez de dejar las dos afirmaciones vivas a la vez, que es el modo de fallo que este archivo existe para prevenir.**

- **Lo que dice esa entrada:** *"el arreglo tentador era hacer al checker tolerante al prefijo `../`, y es exactamente el movimiento que la constitución prohíbe"*, y arregló el **entorno** — `npm ci` adentro del worktree, que le da `node_modules` propio y hace que la clave salga sin prefijo.
- **Por qué la objeción no aplica a lo que se commiteó:** `resolveClientEntry` **no es tolerancia, es resolución**. Una entrada de verdad ausente sigue siendo `PERF003`, y dos candidatas fallan con `PERF008` en vez de elegir. No se saltea ningún chunk ni se mide un grafo más chico.
- 🎯 **Y lo zanja un número, no un argumento: las dos rutas miden `P12 = 111.068 bytes`, idéntico.** Esa coincidencia exacta es la evidencia de que la clave resuelta apunta al mismo grafo — que era justo la preocupación legítima detrás de la objeción.
- **La diferencia real es de mecanismo, y es la razón para quedarse con las dos:** su propia entrada anota *"toda sesión futura en un worktree se lo come"*. `npm ci` por worktree es un ritual que hay que **acordarse**; la resolución de la clave hace que la recurrencia sea imposible. Las dos conviven sin costo: un worktree con `node_modules` propio nunca entra a la rama de resolución.
- ⚠️ **Y las dos sesiones chocaron además con `crm_test` compartida (ellos lo llaman *"cuarta vez"* y anotan *"sigue sin haber mecanismo, sólo el hábito de acordarse"*).** El `TEST_DB` por worktree de arriba **es** ese mecanismo.

### ↩️ REVERSIÓN FIRMADA: LOS MOTORES ENTRAN AL ALCANCE (2026-08-09)
**Decisión de Jorge, sin código escrito.** Sesión de estrategia, no de build. **Revierte el corte de Fase 3 sobre dos ítems de V1.1** y deja el resto de las 71 diferidas donde estaba.

**LO QUE JORGE DECIDIÓ, en sus dos respuestas:**
1. **De V1.1 sólo se promueven las baratas:** **Cmd+K ejecutable** (el overlay ya vive en el shell desde la búsqueda global, así que lo diferido era el *ejecuta*, no el *busca*) y **filtros de tipo en el timeline** (triviales una vez que el timeline exista). El resto del pulido —vista lista, filtros de tablero, acciones masivas, tags, reportes, sync de Google Calendar, email— **sigue diferido**.
2. **El motor de secuencias/cadencias y el motor de automatizaciones ENTRAN al alcance.** Eran las dos filas más caras de V1.1 y la razón escrita para diferirlas era *"the single biggest complexity and compliance surface in the product"*. Jorge la leyó y decidió igual. **Es su puerta de fase, y queda anotada como reversión y no como deriva.**

🟢 **Y LA REVERSIÓN ES MÁS BARATA DE LO QUE EL CORTE SUGERÍA, verificado en `02b` y no supuesto: el corpus ya había diseñado para los motores.**
- **Cuatro de los 49 eventos canónicos ya son de motor** —`sequence.enrolled`, `sequence.paused`, `sequence.completed`, `automation.executed`— y están en el catálogo **original de 40**, no en la enmienda de Fase 4.
- **`message.received` lleva el enum `channel` por esta razón exacta**, escrita en la tabla de fantasmas: *"Sequences never auto-pause on reply → robots text people who already answered."*
- 🎯 **El hallazgo que más vale: `automation.action_requested` fue BORRADO a propósito.** Cuatro módulos lo esperaban. La razón: *"automations call the owning module's command path"*, porque un evento de acción propio sería *"a parallel write path bypassing every gate."* **Ésa es la regla que hace sobrevivible un motor sobre una superficie TCPA** —una automatización nunca escribe por su cuenta, llama al mismo camino que un humano y pasa por la misma puerta— y ya estaba decidida. No hay que inventarla.

⚠️ **LO QUE ESTA DECISIÓN NO REVIERTE, y hace falta decirlo:** `CLAUDE.md` prohíbe el *builder* de lienzo en blanco — *"Automations are a closed, curated catalog."* Traer el **motor** al alcance no toca esa línea. Catálogo curado salvo reversión explícita **aparte**.

🔴 **LO QUE SÍ AGREGA AL CAMINO CRÍTICO: EL BUS DE EVENTOS NO EXISTE.** `contracts/events/` y `app/lib/events/` **no están en el árbol** — `contracts/` sólo tiene `protected-list.json` y `ui-loader-whitelist.json`. `CLAUDE.md` los describe como si existieran (*"the 49-event contract, generated from contracts/events/"*) y hoy el contrato vive **sólo en prosa** en `docs/02b`. Era deuda tolerable mientras nada fuera event-driven; con los motores adentro es **prerequisito**.

**ORDEN REVISADO, y es dependencia y no preferencia** —una secuencia inscribe un contacto, manda SMS por la puerta, se pausa con `message.received` y escribe en el timeline; las cuatro cosas no existen:
1. **Bus de eventos** (`contracts/events/` → `app/lib/events/`) — nuevo en el camino crítico
2. **Núcleo de compliance** (ítems 8–13) — consent ledger, supresión, ventana lead-local, **la puerta única**, break-glass
3. **Bucle diario** (20–27, 58–59) + los dos promovidos
4. **Aloware** (40–50) — 🔴 sigue bloqueado en Jorge, y con esto lo bloqueado creció
5. **Calendario** (51–57)
6. **Los motores** — últimos, porque orquestan todo lo anterior

📌 **El paso 2 cambia de peso, y ése es el costo real de la reversión.** El núcleo de compliance era una sección más del MVP; ahora es lo que sostiene la mayor superficie de exposición legal del producto. **Una secuencia que manda sin pasar por la puerta es la diferencia entre un CRM y una demanda TCPA.**

⚠️ **PENDIENTE DE JORGE, no hecho acá:** la enmienda formal a `03-mvp-definition.md` §6 —las dos filas promovidas siguen listadas como V1.1 con su razón vieja— y su fila en el registro de erratas. **No se editó un documento firmado de Fase 3 en silencio**, que es exactamente el fallo que la cadena de precedencia existe para prevenir.

📋 **Contexto de estado que motivó la conversación:** van ~20 de los 68 ítems del MVP, **2 de los 13 módulos** tienen carpeta con un archivo adentro, y el **bucle diario está en cero** —sin timeline, sin notas, sin registro de actividad; `app/routes/ui/contact.tsx` son 252 líneas sin historial, y `activity_type` no tiene miembro `note`. La pregunta de Jorge fue si convenía terminar esto o empezar un "CRM normal" primero. **La respuesta fue terminar éste**, por asimetría: lo construido (silo por RLS, dinero en `bigint`, ledger append-only) es lo que **no se puede agregar después**, y lo que falta es aditivo.
### 📞 MÓDULO 9 ARRANCA: EL CANDADO DE TIPO, LA EVIDENCIA ENTRANTE Y LA SUPERFICIE DE LLAMADA (2026-08-06)
`app/modules/communications/**` · `app/db/capability-registry.ts` · `app/routes/api/calls.ts` · `app/components/contacts/contact-drawer.tsx` · `app/components/communications/aloware-capture-panel.tsx` · migración **0031**. **259 → 272 tests · 28 → 29 archivos.** P12 sube de 111.068 a **112.924 bytes** (el drawer, +1.856 B; 88% del presupuesto). La rama de la Puerta 2 quedó **fusionada** acá (fast-forward a `ffa5c9f`).

🔴 **`alowareCapability()` NO EXISTÍA, en ninguna de las dos ramas.** Está especificado en §3 desde Fase 5 y nadie lo había escrito: la 0030 promovió `two_legged_call` a `verified` **en la base** mientras el árbol no tenía nada que lo leyera. **Una fila que dice `verified` sin un tipo que la lea es un candado sin puerta.** Ahora existe, y sólo la variante `verified` tiene `.call`.

- 🎯 **Probado por mutación, y es la única prueba que importa acá.** Colapsé la unión discriminada a `{ status, call? }` —que es exactamente cómo se pierde este gate sin que nadie lo note, porque compila y **todas las aserciones de runtime siguen pasando**— y el typecheck se puso rojo: `TS2578: Unused '@ts-expect-error' directive`. Verificado además que `tsconfig` incluye `**/*.ts`, o si no el `@ts-expect-error` no probaría nada.
- **`.call` es `never` para las ocho capacidades, `two_legged_call` incluida.** El dial tiene que llegar con el token `RequestScoped` de P3.1, así que ensanchar ese tipo **es** el cambio que lo admite.
- **Llamar al gate antes de instalar el registro tira `CAP101`.** Devolver `unknown` falla cerrado en lo angosto y **abierto en lo que importa**: un bug de cableado sería indistinguible de una capacidad que el spike nunca probó, y el producto se quedaría sin discador en silencio mientras la pantalla de admin le echa la culpa a Aloware.

🔓 **MIGRACIÓN 0031 — LA FORMA QUE FALTABA PARA UNA CAPACIDAD DE ENTRADA.** `ref.capability_probe` modela una petición **saliente**; un webhook es **entrante**. `ref.capability_delivery` es el par, con las mismas garantías (`reference` + `immutable` + CHECK de digest). `webhook_subscription` pasa a `verified`.

- **La evidencia es el `{"test_payload":true}` de 21 bytes que mandó el propio Aloware**, y es la única de las 22 entregas **lícita de transcribir**: las otras llevan el teléfono de un lead real del libro de producción, y esta fila no se purga nunca. Es además la evidencia **correcta**: lo que esa capacidad afirma es que Aloware puede configurarse para entregar en una URL nuestra, y eso es exactamente lo que ese payload prueba.
- 🔴 **NO copié `CAP003` al lado entrante, y copiarlo habría sido el error.** Un 2xx saliente es el proveedor diciendo que el endpoint existe; **nuestro** status de respuesta no dice nada sobre la capacidad de ellos de entregar. La Puerta 2 lo probó contestando `500` a seis entregas que ya habían sido entregadas. Esa exigencia habría rechazado justo la evidencia que contestó la peor aserción del gate.
- **`num_nonnulls(...) = 1`**, no dos cláusulas con OR: una fila que apunte a un probe **y** a una entrega afirma que dos cosas distintas probaron lo mismo, y la que alguien lee después es la que el JOIN haya agarrado.
- **Un CHECK que se niega a guardar `authorization` o `cookie` en los headers.** El formulario de Aloware ofrece `Basic`/`Bearer`, así que una suscripción configurada así nos devuelve una credencial estática en un header — en una fila permanente. Un comentario que diga "acordate de redactar" es documentación; esto es una negativa.

🔴 **TRES GUARDIANES SE PUSIERON ROJOS Y LOS TRES TENÍAN RAZÓN.** El de `capability-probe.test.ts` asserteaba *una* capacidad verificada; los dos míos, dos hechos que la 0031 movió. Cada uno se **editó al hecho nuevo**, ninguno se aflojó. Es la segunda vez que esa línea se mueve y las dos veces fue el guardián funcionando.

🔴 **LA FIRMA DEL ESTADO COMPARTIDO, CUARTA VEZ.** Mis aserciones contra el registro real **pasaban aisladas y fallaban en la suite**: `zz_test_happy` es una fila que siembra otro archivo, y `crm_test` es compartida. Arreglado como lo arregló `snapshot-chain.test.ts` — la pregunta *"¿el árbol y el esquema nombran las mismas capacidades?"* es **estática**, así que se contesta leyendo la migración 0029. Sin base, sin orden, sin limpieza. **Sigue sin haber mecanismo, sólo el hábito de acordarse.**

🔴 **LA PUERTA DE ACCESO A DATOS ME CORRIGIÓ DÓNDE PUSE UN ARCHIVO.** `readCapabilities` importaba el driver desde un módulo de dominio y el DATA-ACCESS GUARD lo rechazó por nombre. **No tomé la excepción versionada que la regla ofrece** — habría comprado nada más que mantener dos párrafos juntos. Los tipos se quedaron en el módulo (nombre y estado de una capacidad son vocabulario de dominio), la lectura se fue a `app/db/`. **Es §1.1 aplicándose sin que §1.1 exista en este árbol:** su tabla habla de `src/adapters/**`, que acá no hay.

📊 **TRES HALLAZGOS NUEVOS, de releer la captura cruda — ninguno estaba en `g2-aloware.md`.**

- 🔴 **`Call-Disposed` DUPLICA la disposición.** Mismo id, mismo `current_status2`, mismo `disposition_status2`, mismos 63 s de conversación, **6,6 s después**. Bytes distintos (el nombre del evento va en el cuerpo) → sha256 distinto → **los dos pasan el dedupe de transporte**. Mapear los dos nombres a `call.completed` cuenta el marcado dos veces; mapear uno solo pierde el otro si llega solo. Observado una vez, en la saliente completada y no en las entrantes.
- 🔴 **Los eventos `transcription.*` no tienen `body.id`.** Su envoltorio es `body.{summary, transcription, contact, communication}` y el id de llamada está **dos niveles adentro**. §4.2 regla 2 especifica extracción **superficial** de claves para poblar `aloware_call_id`; superficial devuelve null ahí, y `call.enriched [ai_summary]` se queda sin clave natural.
- 🔴 **El conjunto de campos cambia dentro de la misma familia.** `OutboundPhoneCall` no tiene `current_status`, `disposition_status`, `direct_recording_url` ni `call_disposition` — **no son null, no existen como claves**. Un mapeador escrito contra el evento de cierre y aplicado a la familia lee `undefined` y lo llama `null`.

📐 **Y DOS NÚMEROS QUE CONTRADICEN TEXTO APROBADO.** `wait_time` medido: **2 s** cuando el vendedor atendió su propia pierna, **30 s** cuando la abandonó. §6 dice *"5–15 segundos"* y fija `--time-dial-silence-max = 15000ms`. El corte real del agente son **30 s**, así que la ámbar de t=20s dispara **mientras Aloware todavía está sonando**.

🔴 **EL CANAL SSE DE ESTADO EN VIVO: MEDIDO, NO INFERIDO.** Entre `OutboundPhoneCall` y `OutboundPhoneCall-DispositionCompleted` hay **70,4 segundos de silencio absoluto** sobre una llamada con 63 s de conversación. **Toda la porción viva de la llamada produjo cero webhooks.** La fila `connected · {timer}` de §6.1 **no tiene fuente** y queda tachada por decisión de Jorge: la banner conserva `initiated` y `completed`, que son los dos estados que el proveedor reporta. **El canal no cae, adelgaza.**

📞 **LA SUPERFICIE DE LLAMADA, con las tres ramas que el 422 hace posibles.** `POST /api/calls` distingue `no_agent` (422, ~2187 ms, **no se crea llamada**) de `degraded` (5xx/timeout). Dos consecuencias sobre reglas ya firmadas:

- **El 422 NO abre el breaker.** Abre a los 3 fallos consecutivos en 60 s (P3.4), así que un vendedor con la app cerrada tocando `Call` tres veces le mostraría **a los cincuenta** un banner de caída del tenant por un problema de una sola app.
- **La fila `call` quedaría inmortal.** P3.2 commitea la fila y `call.initiated` **antes** del dial. Con un 422 la llamada no existe en Aloware y **nunca llega un webhook**: quedaría en `initiated` para siempre, contando como intento y corrompiendo `last_activity_at`, la regla de 7 días y el riel. **ARR-EVT-18 no se revierte** — se cierra la fila con una escritura compensatoria en el mismo request.

⚠️ **EL DIAL NO ESTÁ CABLEADO A PROPÓSITO, y el endpoint lo dice en su resultado en vez de fingir.** Dos razones independientes: `aloware_number_mapping` no existe, así que ningún vendedor tiene número que presentar; y **cada marcado es facturable contra una cuenta en mora**. Lo que sí está es todo el camino de decisión hasta el socket, así que la superficie, sus estados y su copy son reales y testeables hoy.

🖥️ **LO QUE SE VE EN PANTALLA.** El nombre del contacto en la tarjeta abre un **drawer** (`?contact=<id>`, en la URL por la misma razón que `?move=`: back lo cierra y un link pegado sobrevive) con la primera vista, el control `Call` y sus mensajes. **El nombre es el disparador, no la tarjeta entera** — un blanco de clic de tarjeta completa pelearía con el drag por el mismo puntero. Una tarjeta cuyo contacto no es legible renderiza texto plano en vez de un link muerto.

🔬 **Y EL PANEL DE INSPECCIÓN DE ALOWARE**, en la ficha completa: la secuencia real de las seis entregas con el hueco de 70,4 s dibujado, los 40+ campos agrupados con **qué hacemos con cada uno — o que no hacemos nada**, los 13 nombres de evento con sus tres convenciones, y las cuatro garantías del proveedor. **Su primer párrafo dice que es evidencia capturada y no un feed vivo**, y no es colapsable.

- ⚠️ **NO ES LIVE Y NO PUEDE SERLO HOY:** el spike **borró la suscripción de webhooks** al desarmarse, así que una llamada hecha ahora no entrega nada en ningún lado. Recrearla es tocar Aloware, y la instrucción es no tocarlo.
- **El sujeto es un contacto dummy sembrado** (`Aloware Capture (demo)`, `+1 202 555 0142`, del rango ficticio reservado) porque la llamada capturada marcó a un lead real del libro de producción. **Todos los valores no personales son reales y sin modificar.**

### 🗄️ LAS DOS TABLAS DEL INGEST, Y EL MISMO ERROR MÍO DOS VECES EN UNA HORA (2026-08-06)
`app/db/schema/communications.ts` · migración **0034** · `webhook-ingest-tables.test.ts`. **285 → 331 tests · 30 → 32 archivos.**

`app.raw_payload_vault` y `app.inbound_webhook_event`. Lo que fija el motor:

- **`crm_app` no puede escribir ninguna de las dos.** §4.2 regla 1 pide que la escritura al vault, el insert de dedupe y el encolado sean **una llamada en una transacción** — `app.webhook_ingest()`, que no existe todavía. **Otorgar INSERT antes de que exista es cómo el atajo se convierte en el diseño.**
- **El digest se verifica en el INSERT.** Y ese digest **es** `provider_event_id`: el envoltorio de Aloware no trae `event_id`, `delivery_id` ni `webhook_id` en ningún lado, así que la clave se **construye**, no se recibe.
- **El índice único de transporte es un CONTROL DE SEGURIDAD**, no una comodidad de idempotencia. Aloware no firma, nada en la request prueba frescura, y una request capturada se reproduce para siempre. Ese índice es lo único que se interpone.
- **Una entrega que no parsea SE GUARDA**, con claves nulas. Un parser que rechazara convertiría un bug de mapeo en pérdida permanente — y G2 lo empeoró: sin reintentos, lo que el borde rechaza no vuelve.
- **Una clave truncada se rechaza:** colisiona entre entregas no relacionadas, y sobre *este* índice una colisión significa descartar un evento real como duplicado.
- **NO son `owner_scoped`, y la razón importa:** un webhook llega **antes** de que nadie sepa de quién es el lead. El dueño lo resuelve el merge contra `call`, así que un predicado de dueño acá tendría que satisfacerse con una columna que el borde no puede llenar — y el borde descartaría entregas que no puede atribuir.

🔴 **COMETÍ EL MISMO ERROR DE CLASIFICACIÓN QUE EN LA 0033, UNA HORA DESPUÉS DE DOCUMENTARLO.** Puse `tenant_scoped` + `app_can_insert = false` y volvió a otorgar UPDATE. **La lección estaba escrita en un comentario de la migración anterior y no se pegó** — que es, literalmente, la tesis de este proyecto sobre por qué un comentario no es un mecanismo, demostrada sobre mí mismo por segunda vez en una sesión. **Lo atrapó el test, no yo.** Vale como regla operativa: `app_can_insert` gobierna el INSERT y sólo el INSERT; la clase que no otorga escritura ninguna es `tenant_scoped_read`.

### 🔌 EL EXTRACTOR DEL BORDE, Y LOS TRES HALLAZGOS CONVERTIDOS EN COMPORTAMIENTO (2026-08-06)
`app/modules/communications/aloware-ingest.ts` · `aloware-ingest.test.ts`. **38 aserciones.** Puro, sin base, sin red.

§4.2 regla 2 pide **extracción superficial de claves** y la captura probó que superficial no alcanza. Los tres hallazgos ahora son comportamiento y no notas:

- **Tabla exhaustiva, sin patrón.** Un regex sobre `-Disposition` sería más corto y **se tragaría un nombre que el proveedor agregue el mes que viene**, mapeándolo con confianza y mal. Un nombre no listado devuelve `canonical: null` — una entrega sin mapear visible en vez de una respuesta plausible. Y los nombres son los **del cable**, no los checkboxes del formulario de suscripción: un mapa construido desde la lista de checkboxes no machea nada.
- **El id se busca en DOS niveles.** `transcription.*` no trae `body.id`; está en `body.communication.id`.
- **`Call-Disposed` queda marcado `restatesDisposition`.** El merge está acotado por `aloware_call_id`, así que la fila está a salvo; lo que no lo está es todo lo que **cuenta** disposiciones — la franja de marcados del día, los totales de intentos.

🔴 **DOS DEFECTOS MÍOS QUE ENCONTRARON LOS TESTS:**

1. **Un arreglo `[]` pasaba como envoltorio válido.** Es `typeof 'object'`, así que se leía como *"entrega bien formada sin evento"* — **indistinguible del `{"test_payload":true}` del propio Aloware, que sí es una entrega legítima.** Si `parsed` no significa *"ésta era la forma del envoltorio"*, el contador de `unparsed` de la pantalla de admin deja de contar lo que nombra.
2. **Un id mayor a 2⁵³ se habría redondeado en silencio.** `9007199254740993` no sobrevive un viaje por JSON, y guardar el redondeo ata un webhook a **otra llamada** — sin error, y sólo para ids grandes.

**El bloque adversario son 25 entradas** — JSON truncado, no-JSON, arreglos donde van objetos, `body` nulo, anidamiento de 200 niveles, claves duplicadas, `1e400`. **La propiedad portante es que nunca tira:** Aloware no reintenta, así que una entrega que el borde rechaza se pierde para siempre. (Sin `fast-check` en el árbol, las entradas van a mano.)

### 📇 LA IDENTIDAD SALIENTE DEL VENDEDOR, Y UNA CLASIFICACIÓN MÍA QUE ESTABA MAL (2026-08-06)
`app/db/schema/communications.ts` · migración **0033** · `app/routes/api/calls.ts` · `dial.test.ts`. **280 → 285 tests.**

`app.aloware_number_mapping` (§5, US-601): **un número, exactamente un vendedor; un mapeo vivo por vendedor**, los dos como índices únicos parciales. Con el mapeo sembrado, `POST /api/calls` pasa de `no_number` a `no_credentials` — un paso más cerca del socket, y la razón que queda señala lo que falta de afuera.

🔴 **LA CLASIFIQUÉ MAL Y EL COMENTARIO AFIRMABA LO CONTRARIO DE LO QUE HACÍA EL MOTOR.** Puse `owner_scoped` + `app_can_insert = false` y escribí *"`crm_app` recibe SELECT y nada más"*. Leer los grants de vuelta dijo **SELECT y UPDATE**: `app_can_insert` gobierna el INSERT y sólo el INSERT, y `harden()` otorga UPDATE a toda clase que no sea inmutable ni de sólo lectura.

- **Un vendedor con UPDATE sobre SU PROPIA fila —que RLS acota, lo que suena seguro y no lo es— puede apuntarla a un número que nadie le verificó, o escribirse su propio `verified_at`.** La fila decide qué caller ID presenta y a quién le rutean las devoluciones. **Es exactamente el fallo que mi comentario decía prevenir.**
- **Los otros dos caminos eran peores.** `immutable = true` instala una negativa a nivel sentencia que ata también al dueño, así que revocar y verificar —escrituras administrativas legítimas— se vuelven imposibles. Listar todas las columnas en `protected_columns` hace que `harden()` construya `GRANT UPDATE ()`, un error de sintaxis que tira toda la pasada de endurecimiento.
- ✅ **`tenant_scoped_read`**: SELECT y ninguna escritura. Las filas llegan por migración, por seed, o por el flujo de verificación de ADR-042 — que será una función `SECURITY DEFINER` como `app.ledger_append()` y no un endpoint con un grant.
- ⚠️ **LO QUE CUESTA, dicho y no maquillado:** la lectura se acota al **tenant** y no al dueño, así que todo vendedor puede leer el mapeo de todos. Aceptado a propósito — un número saliente de la empresa es infraestructura y no dato del lead, y el roster ya es público en el tablero. Es un ensanchamiento real del alcance de lectura y es el precio de no tener grant de escritura.
- 🎯 **AHORA HAY UN MECANISMO DONDE HABÍA UN COMENTARIO.** Dos tests fijan los grants, **probados por mutación**: devolviendo la clase a `owner_scoped` los dos se ponen rojos. **El segundo no es redundante** — atrapó **9 columnas** con UPDATE a nivel columna, que un chequeo de tabla habría pasado por alto porque Postgres no descompone un grant de tabla.

⚠️ **EL PREDICADO DE DUEÑO EN LA CONSULTA DEL DIAL ES PORTANTE, y es el único de este árbol que lo es.** Todo el resto puede tratar su cláusula de dueño como segunda capa porque la política ya aplicó una. Ésta no: con `tenant_scoped_read`, sacarla hace que un vendedor disque presentando el caller ID de un colega.

🔴 **`drizzle-kit migrate` SALIÓ CON CÓDIGO 0, SIN IMPRIMIR NADA, Y SIN APLICAR LA MIGRACIÓN.** El error real —`owner_scoped_needs_owner_column`, el registro exige nombrar la columna de dueño— sólo apareció corriendo el SQL a mano contra la base. **Una migración que falla en silencio es peor que una que revienta**, porque el árbol y la base divergen sin que nada lo diga. Vale como método: cuando `db:migrate` no imprime *"migrations applied successfully"*, no aplicó.

⚠️ **Y el dev server sobrevivió a `TaskStop` otra vez**, siguió escuchando en 3000 y bloqueó `harden()` — la migración se colgó en "applying migrations". Mismo patrón que el receptor huérfano del spike. **Se mata por PID.**

### 🚦 LA ASERCIÓN DE BOOT DE §3, POR FIN CABLEADA (2026-08-06)
`app/db/schema/system.ts` · `app/db/capability-registry.ts` · `pool.ts` · migración **0032** · `tests/integration/capability-boot.test.ts`. **272 → 280 tests.**

**`ref.system_constant` existía como nombre desde Fase 5 y no como tabla.** CONTEXT.md la cargaba como bloqueante de **dos** gates desde el ítem 1 del Sprint 1: el trigger de `is_demo` en producción y esta aserción. Ahora el proceso **se niega a servir** si una capacidad `mvp_required` no está verificada y la base dice que es producción.

- **El candado de tipo y el de boot fallan en momentos distintos, a propósito:** `alowareCapability` hace **incallable** una capacidad no verificada (typecheck); esto la hace **inservible** (arranque).
- 🔴 **LA ÚNICA DECISIÓN INTERESANTE ES HACIA QUÉ LADO FALLA, y la cómoda es la equivocada.** Una base sin clasificar podría asumirse `development` o `production`. **Asumir development deja todo gate colgado de esta constante en silencio justo en la máquina que existe para proteger** — porque una base de producción real está sin clasificar el día que se crea, y nada en esa máquina se vería roto. Así que una base sin clasificar **es producción y se niega**.
- ⚠️ **Y la clasificación se DERIVA, no se pregunta.** Un paso que alguien tiene que acordarse no es un mecanismo, y éste se recordaría en todas las máquinas menos en la nueva. `app.tenant.is_demo` ya es el hecho: **una base que tiene un tenant demo no es producción.** Tu base de desarrollo se clasificó sola como `development` al aplicar la 0032, sin que nadie tocara nada.
- 🔴 **UN AGUJERO QUE APARECIÓ ANTES DE QUE MORDIERA:** en una instalación limpia `db:migrate` corre **antes** de `db:seed`, así que la 0032 no ve tenant demo todavía, clasifica `production`, y el `ON CONFLICT DO NOTHING` lo deja así para siempre. El seed crea el tenant un momento después y ya no lo mueve. **La cadena documentada de instalación terminaba con un dev server que no arranca por `CAP200`, y la causa no se habría parecido en nada al síntoma.** El seed ahora lo declara.
- 🔴 **`crm_test` tampoco tiene tenant demo**, así que se habría clasificado producción — y el síntoma no habría sido una aserción roja: `pool.ts` dispara el gate como efecto de import y su modo de falla es `process.exit(1)`, así que **el primer archivo de test que importara algo de `~/db` se habría llevado puesto al runner**. `global-setup.ts` ahora lo declara `test`.
- **El ciclo de imports se rompió antes de escribirlo, no después.** `pool.ts` → `capability-registry.ts` → `pool.ts` habría corrido el chequeo de boot contra un módulo a medio inicializar. ESM probablemente lo sobreviviría por hoisting de declaraciones de función; *"probablemente"* no es una propiedad de la que colgar un gate de arranque. `capability-registry.ts` **no importa el pool** y cada función recibe su `sql`.
- ✅ **Ocho aserciones, y la que vale es la última:** con la base diciendo `production`, el predicado real contra el registro real **rechaza nombrando `call_list`**. Este gate es **silencioso en toda máquina que lo corre** —dev, CI, esta suite— así que los tests afirman producción explícitamente. Un gate ejercitado sólo donde no hace nada es un gate que nadie probó.
- **También assertea el camino feliz** (todo verificado en producción → pasa) y que un hueco `mvp_optional` **no** frena el arranque. Un gate que sólo niega no se distingue de uno roto.

⚠️ **PENDIENTES DE ESTA TANDA, dichos y no escondidos:**

1. ~~**La aserción de boot de §3 sigue sin cablear**~~ — **HECHA**, ver la entrada de arriba.
2. 🔴 **`call_list` BLOQUEA PRODUCCIÓN HOY — y desde la 0032 eso dejó de ser teórico: hay un gate que lo ejecuta.** Es `mvp_required` y G2 no lo pudo documentar ni descubrir, mientras la celda *"si el spike devuelve absent"* de esa misma fila describe un control compensatorio **y el MVP saliendo igual**. Las dos cosas no pueden ser ciertas.

   **La salida analizada, y NO es reclasificar.** Las otras dos filas `mvp_required` dicen *"el MVP no es entregable"*; ésta prescribe una degradación con nombre y sigue. Tampoco es `mvp_optional`: la celda de `sms_send` dice *"nada más se mueve"*, y acá un webhook perdido borra una llamada del historial y corrompe `last_activity_at`, la regla de 7 días y el riel. **Lo que falta es un tercer estado que vuelva PORTANTE al fallback:** producción arranca sin `call_list` sólo si el control compensatorio existe de verdad —la fila `admin_alert(kind='reconciliation_unavailable')` permanente y no reconocible— chequeada en el boot junto con la capacidad.

   **Eso es más fuerte que lo escrito, no más débil:** hoy **nada** verifica el control compensatorio; la celda lo prescribe y ningún mecanismo lo produce. Bajar el tier a `mvp_optional` haría que ese control **no se construya nunca** y el hueco de reconciliación quede invisible para siempre.

   ⚠️ **Y un matiz que hoy el gate no hace: `call_list` está en `unknown`, no en `absent`.** El fallback está escrito para *absent*. Bajo esa propuesta, `absent` + control compensatorio arrancaría y **`unknown` seguiría rechazando**, porque `unknown` significa que nadie preguntó. El gate hoy los trata igual (`status !== 'verified'`) — correcto para `two_legged_call`, impreciso para éste.

   **Costo:** `ALTER TYPE app.capability_tier ADD VALUE` (ver la nota de la 0006) más construir `admin_alert`, que no existe. **Lo que lo haría innecesario:** que soporte de Aloware confirme el endpoint de listado — G2 lo dejó *no documentado y no descubrible*, que **no es lo mismo que probado ausente**.
3. **La cuenta se suspende el 15/08.** Todo lo que necesite la cuenta real —el vocabulario de disposiciones sin cerrar, si `Call-Disposed` siempre acompaña, si hay configuración de anuncio saliente— hay que sacarlo antes.
4. ⚠️ **`react-router dev` ignora el puerto que le asigna el harness** y hace su propio fallback a **3001**, que es el puerto del build de producción para Lighthouse. Un dev server vivo choca con el perfil `lh-ci`.

🔴 **UN WORKTREE NO TIENE `.env`, Y EL SÍNTOMA NO SE PARECE A LA CAUSA.** `git worktree add` no copia archivos ignorados por git, así que el dev server arrancaba, anunciaba el puerto y **moría en segundos** — el navegador decía *"sin conexión"* y `preview_list` quedaba vacío. La causa estaba en la salida del propio proceso, que el harness no conservaba: `JOBS002: refusing to start… the worker needs DATABASE_URL, and it must name crm_app`. **El guard hizo exactamente lo que se escribió para hacer** —negarse a servir páginas mientras nada dispara recordatorios— y sin ver su mensaje era indistinguible de un árbol roto.

- **Perdí tres intentos de verificación en pantalla sospechando de mi propio gate de boot antes de mirar la salida del proceso.** Descartarlo fue correcto y fue el segundo paso, no el primero. **El primero debió ser leer lo que el proceso imprimió al morir.** Es el mismo fallo de método que la retractación de `Test & Validate`: una observación que no distingue *"no funciona"* de *"no miré"*.
- **Es la SEGUNDA cosa que toda sesión futura en un worktree se come**, junto con el `node_modules` vacío que ya estaba anotado. Las dos se arreglan igual: copiar del checkout padre.

### ⚠️ N13 TAMBIÉN DEPENDE DE LA MÁQUINA, y nadie lo había marcado (2026-08-05)
`search-perf.test.ts` se puso rojo a las 12:09 con **199 ms contra un presupuesto de 120**. **No es mío y no es ruido.**

- **Aislado falla igual y consistente:** 180,6 · 188,1 · 159,0 ms. Tres corridas, sin la suite alrededor.
- 🎯 **Bisecado contra `HEAD` limpio (`git stash -u`): 184,8 ms.** Sin la migración 0029, sin nada de la Puerta 2. La regresión es del entorno.
- **Y pasó verde dos veces esta misma madrugada en esta misma máquina**, después del reset de la base — 23:52 y 00:5x, ambas con la suite entera en verde. Lo que cambió en doce horas es el host.
- **Diagnóstico medido:** 15,4 GB de RAM total y **2,2 GB libres (14,3 %)** — WSL 1,6 GB, Chrome 772 MB, dos procesos de Claude ~900 MB, Edge WebView 448 MB, Opera 363 MB. Con esa presión WSL2 pierde caché de disco y un scan de índice sobre 25.000 filas se va de 60 a 185 ms. El contenedor está sano: 96 MB de 7,4 GB, CPU 0 %, 16 núcleos.

**EL PRESUPUESTO NO SE MUEVE, y tampoco se le pone una mediana de tres para que pase** — eso es aflojarlo con otra ropa. Lo que esto dice es que **N13 es tan dependiente de la máquina como P20**, y eso NO estaba anotado: se registró como si fuera un número de servidor estable. `monotonic_down` se va a negar a aflojarlo, que es el brazo funcionando. **Contrapartida real: `npm run verify` —y por lo tanto el hook de pre-commit— necesita una máquina desahogada.**

### 🚨 LA CUENTA DE ALOWARE SE SUSPENDE EL 15/08/2026 (2026-08-05)
Leído en el banner del panel real: *"we did not receive a payment for your most recent invoice … your Aloware account will be suspended on 08/15/2026."*

**La Puerta 2 corre contra esa cuenta.** Si se suspende, G2 no queda pendiente: queda **imposible de correr**, y con ella el módulo 9 entero, cuatro aserciones DEMO, el estado `blocked` del riel, la señal de contacto reciente y todos los gates de cumplimiento — bloqueados por una factura y no por un límite técnico. La ventana son diez días **menos** lo que tarde la medición: la sonda de reintento puede necesitar horas y el vocabulario de disposiciones exige varias llamadas llevadas a propósito a contestada, sin respuesta, ocupado y buzón.

- **Y encima cada marcado del spike es facturable.** La pestaña del two-legged avisa con estas palabras: *"Two-Legged Call API usage is considered **automated & paid**."*
- ⚠️ **La palabra `automated` queda marcada por otra razón y sin sacar conclusión:** en TCPA la clasificación de un discador como automatizado tiene peso legal, y acá es el proveedor clasificando así su propio camino two-legged. Es pregunta de dueño, no de arquitectura.
- **Nada en este repositorio toca el flujo de pago.**

### ✅ PRIMEROS INTERCAMBIOS REALES CAPTURADOS · ⚠️ UNA LATENCIA QUE PONE EN DUDA N10 (2026-08-05)
Cuatro sondas contra la cuenta viva, todas de sólo lectura, todas gratis, ningún teléfono sonó. **`ref.capability_probe` tiene sus primeras filas con procedencia real.**

**`contact_lookup` — `GET /api/v1/webhook/contact/phone-number`, con el token en la QUERY STRING.** Tercera ubicación distinta de autenticación (cuerpo en two-legged, query acá): **no hay un esquema único que asumir**, y es la vindicación concreta de `SPIKE010` por segunda vez.

- **Sujeto: `2025550100`**, del rango ficticio reservado norteamericano (555-0100..0199). No pertenece a ninguna persona y no está en los contactos de la cuenta — que es lo que lo hace un sujeto lícito para una fila que **E9 no purga nunca**.
- ✅ **El token NO llegó a la fila permanente:** quedó `api_token=%5BREDACTED%5D`. Esa redacción se escribió **antes** de saber que este endpoint existía, y éste es exactamente el caso que protege.
- ✅ **El CHECK del digest aguantó contra un cuerpo real del proveedor**, y el cuerpo guardado es `{"error":"Contact not found."}`, la forma 404 documentada al pie.
- ✅ **El token sirve.** Un 404 en la forma documentada prueba que la autenticación fue aceptada; uno malo contesta 401 o 403.
- ⚠️ **Un 404 acá NO es evidencia de `absent`** — el endpoint contestó en su propia forma documentada. `contact_lookup` sigue en `unknown`, y la razón por la que **no puede** pasar a `verified` importa: **CAP003 exige un 2xx, y un 2xx acá sería el registro de un consumidor real en una fila que no se purga jamás.** Verificarla lícitamente necesita un contacto sintético que todavía no existe, y crearlo es un cambio de cuenta — decisión de Jorge, no de la arquitectura.

⚠️ **LA LATENCIA: 1447 · 1506 · 1388 · 1278 ms.** Un lookup trivial cuesta **1,3–1,5 s de forma consistente** — cuatro llamadas seguidas con 228 ms de reparto no son ruido de handshake.

- **N10 fija `POST /api/calls` (gate + ack del dial) en p95 ≤ 300 ms más un ack medido en G2**, y P3 volvió a meter el dial **adentro** del request. Si el piso del proveedor son segundos y no milisegundos, ese presupuesto no se sostiene como está escrito, y los 10 s de `ARR-MVP-26` dejan de ser holgura cómoda.
- 🔴 **DOS COSAS QUE ESTE NÚMERO NO ES, dichas antes de que alguien lo cite:** (1) **no es el dial** — el two-legged devuelve `202` al establecer, no al atender, así que puede ser mucho más rápido; (2) **se midió desde una laptop, no desde la región de producción.** G0 fijó producción en Ohio o Virginia y esto corrió desde la máquina del dueño: la distancia de red sola podría explicar casi todo. **Es un techo y una alarma, no el número de producción** — la misma salvedad de dependencia de máquina que carga P20, sobre un número al que nadie había pensado en pegársela.

### 🧹 SPIKE DESARMADO · Y UN HALLAZGO MÍO RETRACTADO (2026-08-05)
Webhook borrado de la cuenta (por Jorge, en el panel), después túnel y receptor cortados **en ese orden** — nunca al revés, porque un hostname `trycloudflare` se recicla y una suscripción viva apuntando ahí entregaría datos de llamadas a un desconocido. Verificado: URL pública muerta (530), puertos libres, **cuatro procesos que sobrevivieron a `TaskStop` terminados por PID**. Evidencia conservada: 22 webhooks, 8 probes en `ref.capability_probe`.

🔴 **RETRACTADO: registré que `Test & Validate` no entregaba nada. Es falso — el clic nunca aterrizaba.** El menú de acciones se cierra antes de que un clic llegue a sus ítems; se descubrió al intentar borrar el webhook, donde cinco clics de `Delete` reportaron éxito y no hicieron nada. Cuando uno finalmente conectó, `{"test_payload":true}` llegó al receptor en segundos.

- **Lo que hizo sobrevivir al hallazgo falso fue verificar lo equivocado.** Consulté el receptor —correctamente— y estaba en silencio; **nunca comprobé que el clic hubiera hecho algo.** Le atribuí la ausencia de efecto a la función en vez de a mi propia entrada, y todo lo que siguió heredó el error.
- **Es el mismo fallo que el `grep` vacuo y que el receptor huérfano, con un tercer disfraz: una observación que no distingue "no pasó" de "no lo hice".** Tres veces en una sesión, en tres formas distintas.
- **Consecuencia práctica:** `Test & Validate` **sí** dispara entregas a demanda, así que (c), (d) y (k) se podían haber medido sin llamadas facturables. Las respuestas siguen siendo válidas; el camino fue más caro de lo necesario.

### 🔓 MIGRACIÓN 0030 — `two_legged_call` VERIFICADA, y el candado del módulo 9 cede (2026-08-05)
`0030_promote_two_legged_call.sql`. **258 → 259 tests.** `npm run verify` **entero en verde**, presupuestos incluidos.

**No agrega ninguna función: quita un candado.** `alowareCapability('two_legged_call')` devuelve una unión discriminada y sólo la variante `verified` tiene `.call`, así que hasta hoy la pantalla de llamadas **no compilaba**. Ahora sí.

🔴 **LA DECISIÓN DE DISEÑO QUE HUBO QUE TOMAR: la evidencia VIAJA DENTRO DE LA MIGRACIÓN.** Los probes los escribe `spike:probe` contra la cuenta real, así que la fila capturada existe en **una sola laptop**. Una migración que apenas referenciara su uuid aplicaría ahí y **fallaría en toda otra base** —CI, un clon nuevo, producción— porque la fila apuntada nunca se creó. Así que los bytes capturados se transcriben en el archivo: el cuerpo (`{"message":"Two legged call established."}`), el digest y el `observed_at`. Dos consecuencias, las dos buscadas: **la evidencia es reproducible en toda base que corra la cadena**, y `capability_probe_digest_matches` **la re-verifica en cada aplicación**. Un cuerpo mal transcripto o un digest mal tipeado es un deploy fallido, no una mentira silenciosa.

- **Se eligió el probe de `g2-dial-02`** sobre `g2-dial-01` —los dos con `202`— porque es el marcado que llegó hasta el final: pierna de agente atendida, pierna del lead conectada, 63 s de conversación y grabación producida. **Los dos prueban el endpoint; sólo uno prueba que la capacidad hace lo que el producto necesita.**
- ✅ **`CAP010` es nuevo y probado por mutación:** un bloque final que se niega si la promoción resultó un no-op. Apuntando el `UPDATE` a un nombre de capacidad con typo, la migración **aborta** con *"this migration verified nothing"* en vez de pasar en verde sin verificar nada.
- 🔴 **UN GUARDIÁN TUVO QUE CAMBIAR, que es para lo que se escribió.** El test asserteaba *"toda capacidad sembrada arranca en `unknown`"* y se puso rojo en cuanto la 0030 movió el hecho — igual que los dos guardianes del ratchet cuando se midió P20. Reemplazado por dos aserciones más fuertes: **exactamente una** capacidad verificada, y que su probe sea **de ella misma** (CAP002), **2xx** (CAP003) y con **`verified_at` = `observed_at`** (CAP004).

⚠️ **LO QUE LA 0030 NO DESBLOQUEA, dicho antes de escribirla y no después:**

| | |
|---|---|
| `two_legged_call` | ✅ verificada |
| `sms_send` | ❌ sin probe — verificarla es un envío real y facturable; el 10DLC aprobado **no** es evidencia de que el endpoint conteste |
| `contact_lookup` | ❌ sus cuatro probes son `404`, y un `2xx` sería un consumidor real en una fila que E9 no purga nunca |
| `webhook_subscription` | 🔴 **no puede promoverse con la tabla como está** |

🔴 **Y ése último es un hueco del diseño que sólo apareció al usar el mecanismo:** hay **20 entregas reales capturadas**, evidencia más fuerte que cualquier probe — pero `ref.capability_probe` modela **una petición saliente y su respuesta**, y un webhook es **entrante**. No hay forma para esa evidencia. Como la capacidad es `mvp_required`, **la aserción de boot sigue rechazando producción**. Es una decisión de diseño abierta (cómo se acredita una capacidad de entrada), registrada en vez de tapada inventando un probe que nunca ocurrió.

### 🟢 (k) LA PREGUNTA QUE NADIE HIZO, CONTESTADA · (f) CERRADA (2026-08-05)
G2 la señala aparte: *"la pregunta que ningún candidato hizo: ¿exige el proveedor una respuesta síncrona por debajo de ~1 s?"*. Se armó el receptor para recibir una entrega entrante real y **simplemente no contestarla**.

**Retenida 110.023 ms — un minuto y cincuenta segundos — y `client_aborted: false`: Aloware NUNCA cortó**, y aceptó el 204 cuando por fin llegó. §4.2 regla 5 planteaba dos desenlaces (*"si exige sub-segundo, write-first es cómodo; si exige sub-100 ms, se mueve el límite de admisión del ingest"*): **no aplica ninguno. El límite de admisión no se mueve.** ⚠️ Los 110 s son **nuestro** techo, no el suyo: el hallazgo es una cota inferior.

🔗 **Y LEÍDAS JUNTAS, (c) Y (k) DICEN ALGO QUE NINGUNA DICE SOLA:** *sin reintento nunca, y un plazo de respuesta de al menos 110 segundos.* **Un solo tiro por evento, con una ventana enorme para darlo.** La postura correcta en el borde es la inversa del reflejo:

- **Nunca fallar rápido.** Un `500` devuelto en 2 ms es pérdida permanente de datos.
- **Ser lento es casi gratis.** Tardar cinco segundos en hacer durables los bytes no le molesta al proveedor.
- Bajo presión, el borde debe **encolar, bloquear y tomarse el tiempo** — nunca tirar carga, nunca devolver no-2xx, nunca limitar tasa. `ADR-SEC-06` ya decía *"los webhooks se admiten, no se limitan"* razonando que limitar convierte una ráfaga en una ráfaga reintentada más larga. **Ese razonamiento resulta ser demasiado generoso con el proveedor:** no hay ráfaga reintentada, porque una entrega rechazada sencillamente no vuelve. La regla es correcta y su justificación ahora es más fuerte que la que le escribieron.

✅ **(f) cerrada en la misma llamada: `InboundPhoneCall-DispositionMissed`** — una disposición sobre la familia entrante, no un evento aparte. Es exactamente lo que §4.3 ya dictaba (*"una entrante perdida no es un evento separado"*). **La forma del proveedor y el modelo canónico coinciden.** ⚠️ Con el matiz de que la IA de AloAi se interpone: si atiende ella, la llamada nunca llega a estar perdida.

### 🚨 (c) ALOWARE NO REINTENTA — el peor hallazgo de la puerta (2026-08-05)
Receptor armado para contestar **`HTTP 500` a todo**, y dejado así. **Seis entregas reales rechazadas, dos familias de eventos, más de tres horas: cero reintentos.** Tres `OutboundAppointment` (ids 940968066 · 941049357 · 941081975) y, con el mismo brazo activo, los tres de una llamada entrante real (`InboundPhoneCall`, `InboundPhoneCall-DispositionCompleted`, `Recording-Saved`, id 941083416). **Ningún cuerpo repetido, ningún par `(evento, id)` repetido.**

`ARR-INT-02` mandaba *"asumir at-least-once, fuera de orden, posiblemente sin firmar, hasta que el spike diga otra cosa"*. **El spike dijo otra cosa, y la verdad es la opuesta al supuesto en la dirección que duele.** Junto con todo lo demás medido:

> **sin firma · sin id de evento · sin reintento · sin API de call-list**

Eso es **entrega "como mucho una vez", sin ningún camino de recuperación**. Un webhook perdido porque el ingest estuvo caído treinta segundos se pierde **para siempre**: el proveedor no lo reenvía y no hay endpoint de listado contra el cual reconciliar.

- **`ARR-INT-07` ("nada se descarta nunca") pasa a tener que sostenerse en el BORDE, de forma absoluta.** El diseño write-first ya era correcto; esto lo vuelve portante de un modo que antes no era. Cualquier condición en que el endpoint devuelva algo distinto de 2xx —un deploy, un reinicio, un disco lleno, un event loop saturado— es **pérdida permanente de datos**, no una demora.
- **El DLQ deja de ser red de seguridad y pasa a ser autopsia:** sólo puede contener lo que ya recibimos.
- **La disponibilidad del ingest se vuelve una propiedad de CORRECCIÓN, no de rendimiento.** Argumento fuerte a favor de que el bulkhead sea real (proceso propio) antes que después.
- ⚠️ **Fan-out medido: 6 webhooks por saliente completada, 3 por entrante, 2 por saliente fallida.** Ése es el multiplicador que OQ-2 necesitaba.
- **Tres convenciones de nombres en el mismo stream:** `OutboundPhoneCall-DispositionCompleted` · `InboundPhoneCall-DispositionCompleted` · `Recording-Saved` · y en minúscula con puntos `transcription.call.summarized`. Un mapeo contra una sola convención pierde eventos en silencio.
- ✅ **El dial falla RÁPIDO y con motivo:** sin agente disponible devuelve `422 {"errors":{"user":["...can not find any available inbox users..."]}}` en ~2 s, y no crea llamada. Es exactamente la rama de fallo síncrono que `ARR-INT-03` pide.

🔴 **Y UNA AFIRMACIÓN MÍA QUE ESTABA MAL, corregida en el documento.** Dije que el filtro `Skip lines → Local Presence` confinaba la suscripción a la Test Line. **No lo hace:** una cita **no tiene línea**, así que una exclusión por línea no puede aplicarle, y llega igual por `communication.disposed` — en el modelo de Aloware una cita también es una "comunicación". Consecuencia inmediata: **llegó tráfico de producción al receptor del spike pese a un filtro que yo había descrito como suficiente.** Y consecuencia para el producto: **un filtro por línea no sirve para acotar una suscripción de webhooks.**

### 🟢 (b) CERRADA EN EL CABLE · 🔴 Y UN HALLAZGO QUE NADIE BUSCABA (2026-08-05)
Se creó la suscripción (filtrada con `Skip lines` para saltear Local Presence, así no se copia tráfico de producción) y `Save and Test Webhook` disparó una entrega. Aloware la reporta **VALID & ACTIVE**. Lo capturado:

```
POST /hooks/aloware -> 204 en 1 ms · 21 bytes · {"test_payload":true}
Host · User-Agent: GuzzleHttp/7 · Content-Length · Accept-Encoding: gzip
Connection: keep-alive · Content-Type: application/json
```

**Esos seis son TODO lo que manda Aloware.** Los otros diez de la captura (`Cf-*`, `X-Forwarded-*`, `Cdn-Loop`) son del túnel — la trampa que había anotado una hora antes, viva en la primerísima entrega.

**(b) queda contestada: no hay firma.** Ni `X-Aloware-Signature`, ni timestamp, ni nonce. El panel lo decía y el cable lo confirma.

🔴 **Y EL HALLAZGO QUE NADIE FUE A BUSCAR: tampoco hay id de entrega ni id de evento en los headers.**

- La escalera de idempotencia de §4.4 tiene como **primer peldaño** un índice único de dedupe de transporte sobre `(tenant_id, provider, provider_event_id)` — el que *"permite que una tormenta de 20.000 webhooks aterrice sin tocar el dominio"*. Y el hallazgo de la firma ya había ascendido ese mismo índice a **la única defensa contra replay que queda**, porque nada prueba frescura.
- Así que todo ese peldaño depende ahora de que `provider_event_id` venga **en el cuerpo**, y el cuerpo de prueba es `{"test_payload":true}`: no trae ningún id. **Hasta capturar un cuerpo de evento real, no se sabe si esa columna se puede poblar.** Si no se puede: el dedupe de transporte se queda sin clave y la supresión de duplicados baja a los peldaños de call/message, que **mergean en vez de rechazar** —más caro por entrega, justo en el camino que una tormenta golpea más fuerte— y **el replay se queda sin defensa**, porque el índice que hacía de sustituto no se puede construir.
- **Es el desconocido de mayor valor de toda la puerta, y se contesta con una sola llamada real.**

**Dos datos menores que vale guardar:** `User-Agent: GuzzleHttp/7` (el emisor es PHP/Guzzle y el UA es genérico — no se puede identificar al proveedor por ahí), y `Cf-Connecting-Ip: 35.93.153.75`, o sea **AWS `us-west-2`, Oregon**. Una allowlist de IP es posible en principio, aunque un rango de nube es un control débil; y refina la latencia: el proveedor está en la costa **oeste**, mientras G0 puso producción en Ohio o Virginia.

### 🔴 ALOWARE NO FIRMA SUS WEBHOOKS — `ARR-INT-02` resuelto por la mitad peor (2026-08-05)
`/integrations/webhooks` existe, con botón **Add Webhook**. Hoy no hay ninguno configurado y el toggle de la integración está apagado. **`webhook_subscription` EXISTE.**

**El formulario liquida la pregunta de la firma: `Authentication Method` es `None` · `Basic` · `Bearer`. No hay HMAC, no hay secreto de firma, no hay header de firma.** Lo que ofrece es una **credencial estática que nosotros damos y él repite**. La caracterización honesta es **autenticado pero sin firmar** — que no es lo mismo que "sin firmar y sin autenticar", y tampoco es lo mismo que una firma:

| | Firma HMAC | Lo que Aloware ofrece |
|---|---|---|
| Ata el **cuerpo** al secreto | ✅ | ❌ |
| Detecta payload manipulado | ✅ | ❌ |
| Resiste replay | ✅ | ❌ — una request capturada se reproduce para siempre |
| Prueba que quien llama tiene el secreto | ✅ | ✅ |

- ✅ **§4.2 regla 3 fue diseñada exactamente para esto y aguanta.** `signature_valid boolean NULL` era nullable *"a propósito, porque el spike no estableció si Aloware firma, y un `NOT NULL` nos obligaría a registrar una mentira"*. Ahora la columna tiene significado permanente: con `Bearer` registra validez **de credencial**, que es una afirmación más débil que su nombre. **O se renombra o su comentario carga este párrafo** — un campo llamado `signature_valid` guardando un chequeo de bearer es cómo un lector futuro le cree de más a un payload.
- 🔴 **El replay no es defendible en el borde.** Nada en la request prueba frescura, así que el índice único de dedupe de transporte `(tenant_id, provider, provider_event_id)` **deja de ser una comodidad de idempotencia y pasa a ser lo único que separa una request capturada de un replay ilimitado.** Es un control de seguridad y hay que documentarlo como tal.
- **La línea permanente de *"no podemos verificar"* en `/admin/integration-health` deja de ser provisoria.**

**12 eventos suscribibles — el vocabulario real de §4.3:** Contact Created · Contact Updated · Contact Disposed · Contact DNC Updated · Communication Initiated · Communication Disposed · Appointment Saved · **Call Disposed** · **Voicemail Saved** · **Recording Saved** · **Transcription Saved** · **Call Summarized**.

- ⚠️ **No hay evento de SMS con ese nombre.** Probablemente el SMS entrante llegue como `Communication Initiated` —Aloware parece llamar "communication" a llamadas y textos por igual— pero §4.3 mapea SMS entrante a `message.received` con clave `provider_message_id`, y ese binding está **sin probar**.
- 🔴 **NO HAY `Call Answered`. Sólo `Communication Initiated` y `Call Disposed`.** Si el proveedor empuja al arrancar y al cerrar y nada en el medio, entonces **el estado de llamada en vivo —uno de los exactamente DOS canales que SSE tiene permitido llevar— no tiene fuente de webhook.** El silencio de 5-15 segundos del two-legged es justo el intervalo sin ningún evento adentro. Después de la firma, es lo más consecuente de esta pantalla.
- **Hay un toggle `Delay`** (segundos antes de enviar) y **filtros**: Direction · Type · Communication Disposition Status · Contacts · **Skip lines** · Duration.
- ✅ **`Skip lines` es lo que hace posible una suscripción segura:** salteando la línea 65123 (Local Presence, producción) queda sólo la 63949 (Test Line) — sujetos sintéticos únicamente, que es lo que E9 exige y no una preferencia.
- **`Save and Test Webhook` manda una entrega de prueba**, así que la forma de headers y cuerpo se puede observar **sin gastar una llamada facturable**. Es la primera medición más barata que existe.

### 🟢 10DLC APROBADO · 🎯 EL VOCABULARIO REAL DE DISPOSICIONES · 🔴 LA CUENTA ES PRODUCCIÓN (2026-08-05)
Lectura del panel real. **La aserción (h) de G2 CIERRA y es la mejor respuesta posible.**

**Business Registration ✅ · A2P Brand ✅ · A2P Campaigns ✅ · líneas registradas ✅**, más *"your phone numbers are registered for Voice Integrity"*. El brand está **a nombre de la agencia ("Tu Familia Protegida") y ya aprobado**, así que la instrucción de G2 de *"arrancar el trámite 10DLC en paralelo porque es externo, aprobado por terceros y rechazable"* **no tiene nada que arrancar**. Contesta también la pregunta abierta de `06-conversations.md` sobre quién es dueño del registro. **La puerta A2P que hacía de SMS-dark una dependencia externa está satisfecha:** SMS-dark sigue siendo una decisión, ya no una restricción.

🎯 **EL VOCABULARIO REAL: 11 disposiciones, 4.511 comunicaciones, y NO es una taxonomía de telefonía.** `No Answer` **4.066 (90,1 %)** · Call back 166 · Not interested 131 · Demo completed 36 · Voicemail 32 · Wrong number 23 · **Closed deal 22** · Disconnected 18 · Out of range 14 · DNC 2 · Interested-follow up 1.

- **La lista mezcla dos preguntas en un campo.** `No Answer`/`Voicemail`/`Wrong number`/`Disconnected`/`Out of range` son telefonía; `Closed deal`/`Demo completed`/`Interested`/`Not interested`/`Call back` son **venta**. La revisión adversarial del módulo 6 exigía justamente partirlo en `connection_result` y `sales_outcome` y llamaba al campo único *"una discusión de semántica donde cada automatización dispara sobre lo equivocado"*. **La cuenta real le da la razón.**
- **Son escritas por la agencia y bilingües**, con descripciones en español. El mapeo no puede ser un enum de strings del proveedor fijado en código: los valores crudos son dato del tenant.
- 🔴 **`DNC - Do not call` documenta un proceso manual entre dos sistemas: *"Marcar DNC en GHL."*** La agencia corre **GoHighLevel** hoy (su toggle está encendido). Una supresión crítica de cumplimiento depende hoy de que un humano se acuerde de espejarla en otro producto — exactamente el fallo que la feature 26 existe para eliminar. **Y es un hecho de migración que nadie había registrado: este CRM reemplaza a GHL.**
- **90,1 % de no-contesta es la forma real del trabajo**, y es lo que vuelve material —y no curioso— el hallazgo de la `RVM API`.

🔴 **LA CUENTA ES PRODUCCIÓN EN VIVO, no un sandbox:** ~150 llamadas y textos por día esta semana. Dos líneas: **63949 "Test Line"** con un número (`+1 737 427 3994`) y **65123 "Local Presence" con 58 números**. Dos inboxes: **29109** (Default, con las dos líneas) y **29696** (IUL – Live Transfers, 3 usuarios). Usuario logueado **120776**, Company Admin.

- **Existe una "Test Line" con un solo número**, así que el spike disca desde `line_id=63949` y nunca desde el pool de producción.
- 🔴 **El pool de 58 números contradice el mapa de identidad como está especificado.** §5 pone `UNIQUE (tenant_id, from_number_e164)` —*un número, exactamente un vendedor*— y US-601 lo assertea. Un pool rotativo no tiene binding estable. Dos cosas lo ablandan y ninguna lo resuelve: el two-legged toma `user_id` explícito, así que la atribución **saliente** no necesita el número; y `06-conversations.md` **cortó** local presence *"porque el riesgo regulatorio y de reputación de carrier no es nuestro para asumir"* — decisión tomada sin saber que el cliente ya lo usa. Queda abierta la atribución **entrante**: una devolución a un número del pool no tiene dueño bajo el índice actual.

⚠️ **La franja de 14 pestañas está leída entera y el menú de Account tiene 22 ítems: `call_list` y la suscripción de webhooks NO aparecen en ninguno de los dos.** Ahora es una ausencia **buscada** y no una sin leer — pero todavía no es conclusión: la config de webhooks puede vivir por línea, adentro de las tarjetas de Integrations, o sólo por soporte (*"If you need more API functions, please contact our support"*). **No se registra `absent` hasta chequear eso.**

### 🔎 PRIMERA LECTURA DEL PANEL REAL: `two_legged_call` EXISTE, Y ME ENCONTRÓ UN DEFECTO (2026-08-05)
`POST https://app.aloware.io/api/v1/webhook/two-legged-call` · campos `api_token`, `user_id | ring_group_id`, `contact_phone_number | contact_id`, `line_phone_number | line_id`.

🔴 **EL HALLAZGO MÁS CONSECUENTE DEL SPIKE HASTA AHORA ES UN DEFECTO DEL PROPIO SPIKE.** El token va **en el cuerpo**, no en un header `Authorization: Bearer` — que es lo que mi prober asumía. Contra ese endpoint, Bearer devuelve 401, **y un 401 desde una ruta con `source` es exactamente lo que este gate lee como `absent`**, sobre la única capacidad cuya ausencia hace que el MVP no sea entregable. Corregido: la autenticación se declara por sonda y el marcador `[API_TOKEN]` —el que usa la propia documentación de Aloware— se sustituye sólo en la copia que se le entrega a `fetch`.

- ✅ **Redacción probada contra un espejo local, no descrita:** el proveedor recibió `"api_token":"SUPERSECRET-TOKEN-XYZ"` y la evidencia guardó `"api_token":"[API_TOKEN]"`. **El marcador ES el mecanismo** — el cuerpo declarado es el que se loguea y físicamente no contiene el secreto.
- **La ruta está bajo `/webhook/`**, un endpoint saliente con nombre de entrante. Ninguna cantidad de cuidado adivina eso: es la vindicación concreta de `SPIKE010`.
- ✅ **Una pregunta abierta de Fase 2, contestada:** `line_phone_number` va **por llamada**, así que el two-legged **sí** puede presentar caller ID por vendedor en vez de discar desde una línea compartida. El mapa de identidad es construible como está especificado.
- **`SPIKE014` es nuevo:** un `[PLACEHOLDER]` sin resolver no sale de esta máquina. Faltan `RING_GROUP_ID`, `LINE_E164` y `DESTINATION_E164`, y un cuerpo a medio llenar vuelve 4xx — otra vez indistinguible de capacidad ausente.
- **Aparece una `RVM API`** — voicemail ringless. `06-conversations.md` lo cargaba como pregunta abierta con la advertencia explícita *"no se verificó en Fase 1 y no debe asumirse"*. Existe. Y un **MCP (BETA)** que no está en ningún lado del corpus.
- 🔴 **Siguen sin ubicarse, y las dos son `mvp_required`:** el endpoint de **call-list** y la configuración de **suscripción de webhooks**. La franja de pestañas sigue más a la derecha de lo leído; **su ausencia en lo visto no es evidencia de ausencia.**

⚠️ **DOS FORMAS EN QUE UNA SONDA MIENTE, LAS DOS PISADAS PROBANDO EL INSTRUMENTO.** (1) **Un 2xx del listener equivocado es indistinguible del éxito:** el receptor no arrancó (`EADDRINUSE`) y la sonda igual reportó `HTTP 204 in 42 ms`. `source` protege contra una **ruta** equivocada; nada protegía contra un **listener** equivocado, y sólo se destapó porque el archivo de evidencia que el receptor debía escribir no existía.

- 🔴 **CORRECCIÓN, dos horas después, cuando hizo falta el puerto otra vez.** Escribí que el puerto lo tenía *"otro proceso Node ajeno"*. **Estaba mal.** Leer la línea de comando del proceso mostró que era **este mismo receptor, huérfano de una corrida en background anterior que nunca murió**: `TaskStop` mató el envoltorio de `npm` y dejó al hijo `node` escuchando. **La lección corregida es peor que la que reemplaza:** no contestaba el proceso de un extraño sino **otra instancia de nuestro propio instrumento**, así que ese `204` era exactamente lo que produce una corrida correcta —mismo status, misma clase de latencia, misma forma— porque *era* una corrida correcta, del build equivocado, escribiendo su evidencia donde nadie miraba. **Un proceso ajeno habría contestado raro y se habría notado. El nuestro contestó perfecto.** Consecuencias: un script `tsx` en background se mata **por PID**, no parando su shell; y antes de creerle a una medición local, confirmar que quien escucha es el proceso que acabás de arrancar. (2) **Un chequeo que lee la ruta equivocada pasa en el vacío:** el primer control de fuga corrió `grep` sobre un directorio inexistente por el desfase de rutas Git-Bash/Windows, así que *"el secreto no aparece"* era cierto de nada. Rehecho con rutas absolutas y contando bytes junto al veredicto. **Las dos son el mismo fallo con distinta ropa: una aserción que no distingue entre haber pasado y no haber corrido nunca.**

### 🔴 PUERTA 2 (ALOWARE) ABIERTA: EL APARATO EXISTE, LA MEDICIÓN NO (2026-08-05)
`scripts/spike/aloware-receiver.ts` · `aloware-probe.ts` · `aloware-probes.json` · migración **0029** · [`docs/sprint-0/g2-aloware.md`](docs/sprint-0/g2-aloware.md).

**Ninguna de las once aserciones de G2 está contestada, y eso es el estado, no un pendiente.** Lo que existe es el instrumento. La separación está escrita en rojo en el documento del gate justamente para que el salto de *"construimos el aparato"* a *"medimos algo"* no se cruce en silencio.

**E9 IMPLEMENTADA, Y TACHA EL DDL QUE `05c` §7.7.6 TODAVÍA CARGA.** El registro de cierre especifica `ref.capability_probe` con `raw_payload_id NOT NULL` apuntando a la bóveda; E9 es rango 1 y lo borra. Lo que entra: `response_body bytea NOT NULL` propio, **sin `raw_payload_id`**, y el digest comparado contra `sha256(response_body)` **en la misma fila**. El diseño tachado habría hecho que producción saliera con código distinto de cero en cada arranque, uno a tres meses después de este spike, mientras dev y CI seguían verdes todo el intervalo.

- **El CHECK del digest reemplaza a media aserción de arranque:** el motor rechaza la fila en el INSERT en vez de negarse a bootear meses más tarde.
- 🔴 **Un defecto mío atrapado antes de aplicar:** `length(response_body) > 0` habría rechazado un **204 legítimo sin cuerpo**, y un probe que no puede guardar lo que recibió es un probe presionado a inventar algo que sí pueda guardar. El carve-out es por status y por nada más (`204, 304`); un cuerpo vacío bajo un `200` sigue rechazado, que es el caso que de verdad sería alguien fabricando.
- **`CAP002` es un agregado mío sobre lo que §7.7.6 pide.** El CHECK prueba que hay un probe *adjunto*; no puede probar que sea **el correcto**. Sin ese brazo, `two_legged_call` se marca verificada contra el probe de `contact_lookup` —un 200 de un endpoint que no tiene nada que ver con discar— y pasa todo lo demás.
- ⚠️ **DICHO Y NO INSINUADO: esto NO es infalsificable.** Quien pueda escribir la tabla puede inventar un cuerpo y guardar su `sha256()` al lado. Lo que compra el digest es que fabricar una verificación ahora cuesta un **documento** fabricado en vez de la palabra `'spike'` en una columna de texto libre. La propiedad que pesa está antes del hash: la clase `reference` le da a `crm_app` **SELECT y nada más**, así que ningún camino de código que sirva un request puede acuñar un probe.
- ✅ **APLICADA Y PROBADA, no sólo escrita.** La cadena entera **0000 → 0029** aplica limpia sobre una base **nueva** (volumen tirado y reconstruido), y `capability-probe.test.ts` agrega **15 aserciones** contra el motor, adentro de `npm run verify` y por lo tanto adentro del hook de pre-commit. **243 → 258 tests.** 🎯 **Tres mutaciones, cada una roja en exactamente un test:** desactivar el brazo `CAP002` · borrar el CHECK del digest · poner `immutable = false` en el registro. La suite también assertea que **el camino feliz pasa** — un gate que sólo niega no se distingue de uno roto.
- **La primera aserción del archivo es estructural y no de comportamiento:** que la tabla **tiene** `response_body` y **no tiene** `raw_payload_id`. Existe porque `05c` §7.7.6 sigue cargando el DDL tachado, y un test es lo único que puede notar que alguien está siguiendo un documento.

**LOS DOS INSTRUMENTOS, LOS DOS EJECUTADOS CONTRA SÍ MISMOS.** El receptor no parsea nunca (la forma del payload es una de las cosas que el gate viene a aprender) y captura **todo path** salvo `/_spike/*`. Cuatro entregas sintéticas probaron lo que hace falta: `aborted=true` con `response_status=null` a los **1003 ms** —la forma exacta que tendrá la respuesta a la pregunta que nadie hizo— y dos entregas con el **mismo sha256**, que es cómo se detecta un duplicado.

- 🔴 **Un hueco de captura encontrado releyendo:** el handler de aborto estaba registrado adentro del de cuerpo-completo, así que un cliente que cortara **a mitad del cuerpo** no dejaba rastro alguno. Movido antes de leer el cuerpo, con guarda de escritura única — una captura escrita dos veces se leería como una entrega duplicada y corrompería justo la pregunta que el instrumento contesta.
- **En el prober cada `request` arranca en `null` y ésa es la decisión.** Un endpoint **recordado** en vez de leído de la cuenta real devuelve un 404 indistinguible de la capacidad ausente — y `absent` sobre una fila `mvp_required` es el hallazgo que frena el MVP. `SPIKE010` se niega a correr una sonda sin `source`. 🎯 **Probado por mutación por los dos lados:** con path inventado y sin fuente → rojo y exit 1; agregándole la fuente, la misma sonda sale a la red de verdad.
- **Un fallo de transporte NUNCA se escribe como probe.** `absent` tiene que significar que el proveedor contestó que no, no que se cayó el DNS de la laptop.
- 🔴 **Y encontré código muerto en mi propio guard:** el filtro previo ya descartaba las sondas sin `source`, así que la negativa `SPIKE010` adentro de `execute()` **no podía dispararse nunca**. Reestructurado para que exista una sola negativa y sea la que se ve. Un guard inalcanzable que parece un guard es peor que no tenerlo.

⚠️ **OQ-2 REENCUADRADA, y es una corrección al enunciado del propio gate.** Los *10.000–20.000 webhooks/día* son un supuesto desde Fase 0, y un spike no puede observar un día de tráfico real en una cuenta sin vendedores. Lo que sí se mide exacto es el **multiplicador de fan-out**: cuántos webhooks produce **una** llamada y con qué espaciado. El número diario es ese multiplicador por el volumen real de la agencia — aritmética sobre algo medido, en vez de un número que nadie midió. Queda dicho ahora y no después, cuando reportar una cifra modelada como si se hubiera observado sería gratis.

⚠️ **`npm run verify` VENÍA EN ROJO, y no por esto.** El `perf` fallaba con `PERF003` — *"el manifest del cliente no tiene el chunk `node_modules/@react-router/dev/…/entry.client.tsx`"*— y **el mismo rojo aparece en `HEAD` limpio**, verificado con `stash` y no supuesto. La clave real era `../../../node_modules/…`: esta sesión corre en un **worktree cuyo `node_modules` estaba vacío**, así que todo resolvía desde el checkout padre tres niveles arriba y Vite escribió la clave relativa a eso.

- **El arreglo tentador era hacer al checker tolerante al prefijo `../`, y es exactamente el movimiento que la constitución prohíbe.** El checker no estaba equivocado: se negó en vez de medir un grafo más chico del que el navegador realmente baja, que es su trabajo. **Se arregló el entorno** (`npm ci` adentro del worktree) y el gate pasó solo: P12 **111.068/128.000 bytes**, P13 **2.462/16.384**.
- ⚠️ **Toda sesión futura en un worktree se lo come**, y parece un defecto del árbol en vez de un directorio vacío.

⚠️ **Tres textos viejos que apuntan mal, anotados en el documento del gate:** `05c` §7.7.6 (tachado por E9) · las referencias a *"Puerta 7"* en §784/§1751/§2073, que son la numeración previa a la fusión de ladders —Aloware es **G2** en §9— · y `.env.example`, que decía *"Gate 11 … whether webhooks are signed"* y **se corrigió**: la Puerta 11 es bundle y first paint, y cerró el 2026-08-03.

### 🚪 PUERTA 11 CERRADA: P20 MEDIDO EN 2251 ms (2026-08-03)
`tests/e2e/tti.spec.ts` · `fixtures/lighthouse.ts` · migración **0028** · perfil **`lh-ci`**. **241 → 243 tests · 82 → 83 e2e.** La Puerta 11 pasa de **mitad cerrada** a **cerrada**.

**LO QUE FALTABA NUNCA FUE EL FIXTURE.** La propia lista `blocked_on` de la fila nombraba `perf-500`, y la Puerta 12 lo construyó hace semanas. Lo que no existía era **algo que corriera Lighthouse**. El número quedó en `null` mientras el archivo, visto desde afuera, se parecía exactamente a un presupuesto que se aplica.

**Medido: 2251 ms**, mediana de cinco corridas con un reparto de **49 ms** (2227 2248 2251 2265 2276), con la auditoría `interactive` de Lighthouse contra el **build de producción** en :3001, sobre las 500 tarjetas del fixture, con sesión de la vendedora del fixture y el preset móvil de Lighthouse **sin tocar** (4× de CPU, 4G lento simulado, viewport de teléfono). §8.1 redondea hacia arriba al siguiente 100: **presupuesto 2300**, techo 3000. Registrado en `ref.ci_ratchet` por la 0028.

- **El algoritmo de TTI NO está reimplementado**, y ésa es toda la razón de la dependencia. *"La primera ventana de cinco segundos después del FCP sin long task y con dos pedidos en vuelo como máximo"* es lo bastante sutil como para que una versión propia salga **plausiblemente mal** — y un número plausiblemente mal es peor que ninguno una vez que está ratcheteado.
- **Corre en la suite e2e y NO en un job nocturno de Actions**, y es una rebaja deliberada del plan. §9.4.1 hace que el control de costo de este proyecto sea la ausencia de método de pago, así que un job programado es un gate que se apaga antes de atrapar nada. La suite ya levanta este mismo build para P6.
- ✅ **Las dos aserciones probadas por mutación.** Bajar el presupuesto a 1000 lo pone rojo con el número y la negativa AP002. Devolver una cookie falsa hace que Lighthouse mida **la pantalla de login** —un formulario sin tarjetas, interactivo casi al instante, reportando un número precioso de la página equivocada— y la aserción de `finalUrl` lo atrapa.
- **FCP y TTI caen en el mismo milisegundo, y es una propiedad real de esta arquitectura**, no una medición rota: el tablero es SSR, así que los píxeles existen en el primer pintado, y React hidrata 500 tarjetas en tramos interrumpibles que nunca producen una tarea de más de 50 ms (TBT: 0–10 ms). Si alguna de las dos cosas deja de ser cierta, TTI se despega de FCP y este presupuesto es lo que lo nota.
- ⚠️ **A DIFERENCIA DE P12/P13, ESTE NÚMERO DEPENDE DE LA MÁQUINA.** Aquéllos cuentan bytes; éste multiplica por cuatro las duraciones observadas **de esta máquina**. En un runner más lento la medición es mayor, se pone rojo, y `monotonic_down` se **niega** a aflojarlo. Eso es el brazo funcionando, no fallando: mudar un presupuesto a otro hardware debería costar una decisión.

🔴 **DOS GUARDIANES TUVIERON QUE CAMBIAR, que es exactamente para lo que se escribieron.** `ci-ratchet.test.ts` asserteaba que P20 tenía **cero** filas de valor y `perf-budgets.test.ts` que su valor era **null**. Los dos existían para mantener visible el agujero declarado de E6; los dos ahora assertean que está cerrado y acotado. **Un agujero que se cierra porque nadie se dio cuenta es el fallo que este arreglo previene, en las dos direcciones.**

- **`PERF007` es nuevo:** un presupuesto que nombra un tier que nadie corre ahora rompe el build. El reporte encabezaba las otras filas con *"su tier todavía no existe"*, que era cierto cuando sólo el bundle estaba medido y **había dejado de serlo** para N13 y P6. Ahora cada tier nombra el comando que lo corre.

🔴 **UN TEST CON FECHA DE VENCIMIENTO.** `card-anatomy` asserteaba riel azul sobre Ruth Alvarez, y `fresh` es cero intentos **Y una llegada de menos de SESENTA MINUTOS**. El seed le da *"llegó cuando corrió el seed"*, así que la aserción era cierta **una hora** después de `db:seed` y falsa para siempre después. Pasó semanas porque el demo se re-sembraba seguido. **La ventana no se ensancha:** sesenta minutos es la definición del producto, y moverla para que pase un test cambia la definición por la comodidad.

- ⚠️ **CONSECUENCIA PARA EL DEMO, no sólo para el test:** un tablero mostrado **más de una hora** después de `npm run db:seed` **no tiene ninguna tarjeta fresca**. El riel azul y el `NEW` simplemente no están. Si el demo va a mostrar ese estado, hay que sembrar antes.

📐 **P6 está al borde y quedó anotado, no tocado.** En la suite completa las tres corridas dan máximos de 33,3–50,0 ms contra un presupuesto de 34: **la mediana pasa con 0,6 ms de margen y una de cada tres corridas se pasa**. Con la máquina ocupada (el Chrome de Jorge son once procesos) falla. Aislado pasa siempre. El presupuesto **no se mueve** — lo que esto dice es que la mediana de tres es lo único que lo sostiene, y que la virtualización del tablero sigue siendo la respuesta real.

### ➕ EL BUCLE SE CIERRA: N13 MEDIDO Y `Quick-add this number` ES UN CONTROL (2026-08-03)
`app/routes/api/quick-add.ts` · `search-overlay.tsx` · migración **0027** · `perf-budgets.json`. **231 → 241 tests · 80 → 82 e2e.** `DEMO-08` sigue **parcial**, y por una razón que ahora está escrita en el registro.

**N13 — EL PRESUPUESTO DE LA BÚSQUEDA, MEDIDO Y APLICADO. La primera medición fue 1.053 ms, y no cambió nada del esquema para arreglarlo.** La migración 0011 ya tenía el índice correcto —un GIN compuesto con el predicado de dueño ADENTRO— y la consulta estaba escrita de forma que **no podía usarlo**: acotar en un CTE y machear en un LATERAL fuerza un scan secuencial del tenant en cada tecla. Reescrita como ramas indexadas unidas con `UNION` + `DISTINCT ON`: **59,7 ms p95 sobre 25.000 contactos en cincuenta libros.** Registrado en 120 en `perf-budgets.json` y en `ref.ci_ratchet` con el brazo `monotonic_down`. **Escribí una migración con índices nuevos y después la borré**: el índice ya existía, el problema era mío.

- 🔴 **Seis índices que ninguna migración había declarado**, encontrados por la extensión de `snapshot-chain.test.ts`. `contact_name_trgm_idx` existía a mano desde la 0011, el generador no lo tenía en ningún snapshot y propuso crearlo **de nuevo**; contra una base limpia falló con *"already exists"* y —porque el migrador de drizzle es **UNA transacción**— revirtió **toda la cadena**. `crm_test` quedó con cero tablas. Un índice sin declarar es peor que una tabla sin declarar: la tabla queda sin gestionar, el índice deja la base nueva **inaplicable**.
- **Los 500 ms de punta a punta de `US-LCP-08` NO están ratcheteados, a propósito:** P5.3 los llama una *consecuencia*, no un presupuesto.

**`Quick-add this number` DEJA DE SER COPY.** El estado vacío ya ofrecía el número normalizado; ahora abre una hoja con ese número **precargado y de sólo lectura**, porque volver a tipearlo es el paso que convierte *"doy de alta este lead"* en *"lo doy de alta después"*. `Save` aterriza en la ficha del contacto.

- 🔴 **EL DUPLICADO LO RECHAZA UNA RESTRICCIÓN, NUNCA UNA CONSULTA PREVIA.** `contact_phone_owner_uidx` es UNIQUE sobre `(tenant_id, owner_user_id, phone_e164)` desde la migración 0010. Un `Save` tocado dos veces, o dos pestañas abiertas, pierden la segunda escritura **en la base** — un leer-y-después-escribir dejaría pasar las dos. El endpoint no previene el duplicado: sólo traduce la negativa a `You already have {name} with this number.` con un camino a la ficha, que es la parte que una restricción no puede hacer. **Si la fila no es legible está en el libro de otra persona, y se reporta SIN nombre:** nombrarla sería una filtración entre silos disfrazada de mensaje amable.
- 🔴 **Tres defectos que encontraron los tests, los tres invisibles en el camino feliz.** (1) Drizzle **reenvuelve** el error del driver, así que el SQLSTATE quedaba un nivel abajo en `cause` y la restricción disparaba perfecto mientras la aplicación no podía enterarse — una negativa diseñada llegando como un 500. **Una garantía en la base es media garantía hasta que la aplicación sabe RECONOCER la negativa.** (2) Una violación **aborta la transacción**, así que la consulta que da el nombre del duplicado no puede correr en la misma: atrapar una negativa de la base y después preguntarle a la base son **siempre dos unidades de trabajo** en Postgres. (3) `FormData.get` devuelve `string | File`, y `String(unFile)` habría escrito `[object File]` en el nombre de un contacto.
- **Dos de los cuatro campos que ratifica §4.11 NO están, y honestamente:** `lead_source_id` es del módulo de intake y el enum `activity_type` no tiene miembro `note`, así que ninguno tiene columna donde caer. Un campo que descarta en silencio lo que la vendedora tipeó es peor que un campo que no está. **`Save & call` tampoco:** es el primario de §4.11 y necesita la puerta de Aloware; un botón que guarda y no llama sería la única mentira que esta hoja podría decir.

🔴 **UN TEST QUE DEPENDÍA DEL HISTORIAL DE LA BASE, no de lo que protegía.** `card-anatomy.spec` asserteaba `Not called yet` sobre `main article` **`.first()`**. El tablero ordena por `stage_entered_at DESC`, así que la primera tarjeta es **la que se movió más recientemente** — y mover tarjetas es lo que hace media suite. Pasaba sólo mientras nada hubiera arrastrado nada nunca. Anclado a **Ruth Alvarez** por nombre, que es el único lead sembrado con cero intentos. **No lo encontró una revisión: lo hizo fallar correr la suite entera después de agregarle dos e2e.**

### 🔎 LA BÚSQUEDA GLOBAL, Y UNA PUERTA QUE ME ATRAPÓ DOS VECES (2026-08-03)
`app/routes/api/search.ts` · `contact.ts` · `app/components/search/search-overlay.tsx` · `app/routes/ui/contact.tsx` · `app/lib/phone/e164.ts` · migración **0026**. **207 → 231 tests · 69 → 80 e2e.**

**`DEMO-08` pasa de BLOQUEADO a parcial**, y la cadena de snapshots de Drizzle quedó saldada.

**LA CADENA DE SNAPSHOTS.** La migración **0026 no lleva SQL: existe por su snapshot.** Cinco objetos estaban en la base y en ningún archivo de esquema — `ref.timing_constant` (desde la 0009), `scheduled_job.claimed_at`, el enum `ratchet_direction` y las dos tablas del ratchet, más los cambios de `tenant`. Ahora `npm run db:generate` vuelve a funcionar y reporta *no schema changes*, verificado además contra una base construida desde cero.

- ⚠️ **Una afirmación mía que estaba MAL y corregí:** el primer comentario decía que la cadena atrasada habría emitido `DROP TABLE ref.ci_ratchet`. **No.** Drizzle compara snapshots contra archivos de esquema, **nunca contra la base** — esa tabla no estaba en ninguno de los dos, así que era invisible al diff, no estaba en peligro. El riesgo real era más aburrido: `CREATE TYPE` de un tipo que existe, y una migración que falla en su primera sentencia. La exposición callada era la otra: una relación que Postgres tiene y los archivos de esquema no está **fuera del alcance del generador**, coordinada con nada.
- ✅ **`snapshot-chain.test.ts`** falla si el snapshot queda atrás o si una migración crea una tabla que nadie declaró — y **escribirlo encontró `ref.timing_constant`**, sin declarar desde la 0009. Es la tabla que guarda `undo_deadline_ms` y `projection_reveal_delay_ms`.
- **Su primera versión consultaba `information_schema` y pasaba sola pero fallaba en la suite:** `silo.test.ts` crea tablas a propósito y `crm_test` es compartida. La pregunta es estática, así que ahora lee los archivos de migración — sin base, sin orden, sin limpieza. **Tercera vez que este proyecto paga la firma del estado compartido.**

**LA BÚSQUEDA.** Tres campos y no más — nombre, teléfono, email, que es lo que `search.idle` dice en pantalla para que nadie pruebe con un número de póliza y concluya que está rota.

- **La normalización E.164 es lo que sostiene el camino de recuperación de §7:** suena el teléfono, la vendedora tipea el número como lo lee, y `937-555-0142`, `(937) 555-0142`, `9375550142`, `+19375550142` y `1 937 555 0142` encuentran el registro. Los últimos cuatro dígitos también. **Normalizar no es validar**, y están separadas a propósito: un typo devuelve nada en vez de ser rechazado, y el estado vacío recupera el número para ofrecer el alta.
- **El overlay vive en el SHELL**, porque *"desde cualquier superficie"* es el requisito y un atajo cableado por pantalla funciona en las pantallas que alguien se acordó. Asertado en tres. **Escape devuelve el foco a lo que lo abrió** — la regla que todos saltean y la que un mouse nunca prueba.
- **La pantalla de contacto NO tiene loader**, y no por estilo: `ui.loader_whitelist` es `shrink_only` y habría rechazado un cuarto con `AP005`. **El motor forzó la arquitectura que §1.1 quería igual.** Un id ajeno, uno inexistente y uno mal formado son indistinguibles ahí: los tres leen *"That contact isn't in your book"*, nunca un 403. Eso es `DEMO-04` sobre la pantalla en la que realmente aterriza una URL pegada.
- 🔬 **Otra mutación verde, anotada:** abrir el predicado de dueño del endpoint a `true` dejó todo pasando, porque la política RLS `owner_scoped` ya había acotado las filas. **El silo lo sostiene la base**; mi predicado es la segunda capa. Los tests prueban la propiedad, no qué capa la entrega.

🔴 **LA PUERTA DE FRONTERA ME ATRAPÓ DOS VECES EN LA MISMA SESIÓN, y la segunda es la que vale.** Importé una constante desde un módulo de ruta a un componente — otra vez — y postgres volvió al bundle del navegador. El síntoma: `ReferenceError: Buffer is not defined` y una pantalla de login que nunca renderizaba, en **todos** los tests a la vez. La puerta nombró el archivo, el especificador y el arreglo **antes de que terminara de fallar el e2e**.

**La nota también existía** — en el mensaje del commit anterior. No me detuvo. Ésa es la diferencia entre una nota y un mecanismo, demostrada sobre mí mismo, y quedó escrita en el módulo donde la constante vive ahora.

- **Dos correcciones más por el camino:** `setState` en el cuerpo de un efecto otra vez —resuelto **derivando** los estados en vez de guardarlos, y dejando sólo la respuesta, que ahora carga la consulta a la que pertenece para descartar una respuesta tardía de algo que la vendedora ya dejó atrás—; y el spec presionando `Ctrl+K` antes de la hidratación, que falló con *"Ctrl+K did nothing"* mientras el único test que hacía `focus()` primero pasaba. **El mismo accidente que `undo-keyboard.spec` registra desde el otro lado.**
- ⚠️ **Un chunk `db-*.js` nuevo en el directorio del cliente.** Verificado, no supuesto: **ninguna ruta lo descarga** — mismo fenómeno ya documentado para `identity-*.js`, infraestructura de servidor emitida al directorio del cliente y jamás referenciada. Cuesta tamaño de deploy, no bytes del vendedor. P12 subió 1,7 KB (el overlay), no 121.

⚠️ **Lo que la búsqueda NO tiene** — ~~el presupuesto~~ ~~y el alta rápida~~, **ambos cerrados el mismo día por la entrada de arriba** (N13 a 59,7 ms, y el alta rápida es un control). Lo que queda sin medir es la **mitad percibida**: N13 mide el SERVIDOR, y nadie mide lo que el ojo de la vendedora realmente espera. Ése es el número de `US-LCP-08` y P5.3 lo llama una consecuencia, no un presupuesto — así que `DEMO-08` sigue parcial **por eso** y no por lo otro.

### ⛔ EL RELOJ QUE NO ENTRÓ: P6 LO RECHAZÓ DOS VECES, Y EL CAMINO DEJÓ UNA PUERTA (2026-08-03)
`scripts/client-server-boundary.test.ts`. **203 → 207 tests.** El reloj `NEW` **no se shippeó**, y eso es el resultado, no un pendiente.

**Intenté el reloj que tictaquea de §2.7 (`NEW 04:12` contando desde el timestamp del servidor). Lo construí entero, lo medí, y P6 lo rechazó dos veces. El presupuesto no se toca, así que el reloj no entra.**

🔴 **PRIMERO, UN DEFECTO QUE NO SE PARECÍA EN NADA A SU CAUSA.** Exporté el helper `mmss` desde `app/routes/api/board.ts` —al lado de la derivación que produce el string, que se lee bien y está mal— y lo importé desde un componente. **Esa ruta importa `~/db` y `~/lib/auth/identity`, así que una función arrastró postgres, drizzle y better-auth al bundle del CLIENTE.**

- **Lo que se veía en pantalla: el tablero de 500 tarjetas renderizaba las 500 y después simplemente nunca armaba el drag.** Sin error, sin pantalla en blanco, nada en la consola. La página había mandado un driver de base de datos al navegador y lo seguía parseando. **P6 lo atrapó como un locator que nunca resolvía**, que está lejísimos de *"el módulo equivocado está en el bundle"*.
- **Diagnosticado por bisección, no por lectura:** `git stash` → P6 verde en HEAD (p95 16,8 · max 33,3 · long task 0) → el problema estaba en lo no commiteado. Después, desactivar sólo el chip fresco **no** lo arregló, lo que descartó el reloj y dejó al import como único sospechoso.
- ✅ **Y ahí quedó la puerta que sí vale: `client-server-boundary.test.ts`.** Un componente no puede importar un módulo de `~/routes/**` **en runtime**, ni `~/db`, ni `~/lib/auth/*`. Los `import type` siguen permitidos y hay un test que lo dice, para que nadie endurezca la regla hasta romper todas las tarjetas. 🎯 **Probado por mutación con el import exacto que causó esto:** rojo, nombrando archivo, especificador y el arreglo (*"movelo a `app/lib/**`, que no importa nada del servidor"*).

📐 **LOS NÚMEROS DEL RELOJ, medidos y anotados para que el próximo intento no arranque de cero.** El fixture `perf-500` crea sus 500 tarjetas de una vez y sin intentos, así que **las 500 son `fresh`** — el peor caso real, no artificial: un vendedor que acaba de importar su libro tiene exactamente eso.

| Intento | max frame | worst long task | Presupuesto |
|---|---|---|---|
| Tictaqueando cada chip | **116,7 ms** | **84,0 ms** | 34 / 50 |
| Sólo los chips EN PANTALLA (IntersectionObserver compartido) | **50,0 ms** | **53,0 ms** | 34 / 50 |
| Sin reloj (lo que está en el árbol) | 33,3 ms | **0,0 ms** | 34 / 50 |

- **Dos optimizaciones reales por el camino, las dos insuficientes solas.** El `subscribe` copiaba un arreglo por suscriptor —el patrón que usé para `Notification.permission`, donde hay UN suscriptor— y con 500 eso es O(n²): ~125.000 copias durante la hidratación. Pasado a `Set`. Después, acotar el tick a lo visible bajó de 116,7 a 50,0. **Sigue arriba del presupuesto.**
- **La conclusión honesta: 500 relojes simultáneos no son viables sin virtualización**, o sin escribir el DOM fuera de React para ese texto. El chip renderiza la forma correcta y no avanza; la próxima tentativa arranca desde esta tabla.
- ⚠️ **Y una nota de método sobre el propio gate:** una corrida dio `worstLongTask=61 ms` **en HEAD**, con la máquina todavía asentándose después de reiniciar Docker; dos corridas siguientes dieron 0,0. La mediana de 3 protege el `max_frame` pero **no** protege igual al long task. Si aparece rojo ahí sin cambios de código, correrlo de nuevo antes de creerle.

⚠️ **Docker Desktop se cayó solo a mitad de sesión.** El síntoma fue el webServer de Playwright saliendo con código 1 y `ECONNRESET` en :3000 — el dev server anuncia el puerto y **muere en el primer request** cuando no llega a Postgres (el pliegue perezoso en dev, ya anotado). Vale reconocerlo rápido: no es el código.

### 🩺 EL RIEL DE SALUD, Y UN DISEÑO TACHADO QUE SEGUÍA VIVO EN LA BASE (2026-08-03)
`app/routes/api/board.ts` · `pipeline-columns.tsx` · migración **0025** · `tests/integration/card-health.test.ts` · `one-decay-threshold.test.ts` · `scripts/seed.ts`. **188 → 203 tests · 66 → 69 e2e.**

Lo que le faltaba a `DEMO-07`. La tarjeta rinde ahora **seis de los siete hechos** de `04b` §2.4.

🔴 **EL HALLAZGO, y lo encontré porque el riel necesitaba leer el número: `app.tenant` traía `rotting_threshold_days`, un `cold_threshold_days` con default 14 y un CHECK que forzaba el primero por debajo del segundo.** Eso es **el diseño de dos niveles que R6 borró**, codificado exacto, en la base, desde la migración 0001. La regla que lo prohíbe es de rango 1 y tiene una sola frase — **R1.7**: *"One threshold: `cold_threshold_days`, default 7, configurable. There is no separate 'rot' threshold."*

- **Nadie leía la columna, así que nada podía notarlo.** Los dos defectos que habría producido son silenciosos: el aviso de *going cold* disparando a los **14 días en vez de a los 7** —una semana entera de más sobre la señal que existe para que un lead no se abandone en silencio— y el rojo conservando un segundo significado, que es justo lo que R6 lo borra para evitar. En esta cara de tarjeta el rojo significa *no podés contactar a esta persona*, y un color con dos significados no tiene ninguno.
- **Migración 0025** dropea la columna y el CHECK, y pone el default en 7. El `UPDATE` de filas existentes está acotado a `= 14` y explicado: un tenant que hubiera *elegido* 14 sería indistinguible de uno que nunca eligió. Hoy es teórico —hay un tenant sembrado y ninguna pantalla de configuración— y por eso corre en una migración que pasó una vez, antes de que esa pantalla exista.
- ✅ **El check R2-6 de `04b` §9 ahora EXISTE.** Declaraba que *"cualquier string, setting o code path que mencione un `rot_threshold`"* rompe el build; no había nada. Ahora es un test que mira el motor **y** el árbol. 🎯 **Atrapó dos veces mis propios comentarios** —uno en `schema/tenant.ts` y otro en `board.ts`, los dos explicando la eliminación— y las dos veces lo correcto fue reescribir el comentario: un archivo vivo es exactamente donde un concepto prohibido vuelve.

**EL RIEL Y EL SLOT, los dos calculados en el SERVIDOR.** §2.8 da la razón en una frase: el tablero, My Book y My Day tienen que ser **idénticos byte a byte** sobre si un lead se está enfriando, y tres pantallas decidiendo cada una por su cuenta son tres respuestas a una pregunta que el vendedor hace una vez.

- **El riel es un GRADIENTE, no un color.** Debajo del umbral se llena desde arriba en `days_since_touch ÷ cold_threshold_days`: una tarjeta al día 4 de 7 ya muestra el 57% del riel, así que el vendedor **ve venir** el deterioro en vez de encontrárselo. Las dos señales —el tono dice *cuál* estado, la altura dice *cuánto falta*— son requisito de WCAG 1.4.1, no adorno. R6 borró los dos límites y **se quedó con el gradiente**, que es lo que el diseño de dos niveles compraba en realidad.
- ⚠️ **LOS DOS ÓRDENES DE PRECEDENCIA SON DISTINTOS, a propósito, y parece un bug.** El riel es `blocked > overdue > fresh > going_cold > ok` (§2.8); el slot es `recent contact > fresh > overdue > going cold > needs reply > no next step` (§2.7). Un lead que llegó hace minutos con un callback ya vencido muestra **riel rojo y chip `NEW`** — los dos documentos cumplidos, no uno equivocado. Hay un test que assertea la diferencia justamente para que nadie la "arregle".
- **Exactamente una señal por tarjeta**, y `signal` es un valor y no un arreglo para que agregar una segunda sea un cambio de tipo que alguien tenga que mirar.
- **Suprimidas por completo en etapas `earning` y `lost`** (ítem 32 del MVP, no negociable). §2.7 da la consecuencia: *"si no, toda tarjeta está en ámbar el primer lunes y la señal se vuelve empapelado."*
- ⚠️ **Una lectura de un SILENCIO, marcada como tal en el código:** §2.7 suprime las *señales* en etapas cerradas y §2.8 no dice nada del riel — así que una tarjeta ganada renderizaba un riel azul de *fresh*. Encontrado mirando el tablero. Un riel que dice "llamá ahora" sobre la columna del dinero es desinformación, así que `fresh` y `going_cold` también se suprimen ahí; **`overdue` sobrevive** a propósito, porque una actividad vencida sobre un trato cerrado sigue siendo algo que el vendedor le debe a alguien.
- **Dos renderizados por señal, que §2.7 ratifica como un solo concepto:** `Going cold · 9d` en la cara (≤16 porque la tarjeta mide 264px) y la frase completa de R11 como nombre accesible. La palabra que R11 prohíbe no aparece en ninguno de los dos — ni en los comentarios, ahora.
- 🎯 **Probado por mutación por los dos lados:** colapsar la precedencia del slot a la del riel → **2 rojos**; sacar la supresión → **1 rojo** nombrando la tarjeta ganada con su chip de *going cold*.

🔴 **Y LAS EDADES DE LAS TARJETAS DEL DEMO ERAN ALEATORIAS.** `random() * 12 días`, así que el tablero se veía distinto en cada siembra y **ninguna tarjeta estaba garantizada en ningún estado** — el riel no se podía demostrar ni assertear. Peor: todas tenían `created_at` en `now()`, así que con cero intentos **todas computaban `fresh`** y los estados de deterioro eran inalcanzables pasara lo que pasara con `last_activity_at`. Ahora hay **una tarjeta por estado**, con edades fijas: Ruth (fresh) · Curtis (going cold, 9d) · Alma (deteriorándose, 4 de 7 → riel al 57%) · Wendell (vencida hace 3 h).

⚠️ **JOBS003 se probó solo, una sesión después de escribirse.** Volví a encadenar `db:migrate` con el arranque del contenedor y volvió a competir — pero esta vez **pg-boss no se instaló**, así que la base era recuperable con un `db:migrate` y no con un `db:reset`.

⚠️ **Lo que NO tiene la tarjeta, y por qué:** el chip `NEW` **no tictaquea** (§2.7 quiere `NEW 04:12` desde el timestamp del servidor) — diferido a propósito, porque un timer por tarjeta sobre 500 tarjetas es exactamente la forma de regresión que P6 existe para atrapar, y necesita **un** tick compartido y no quinientos. Faltan también el chip de contacto reciente (prioridad 1 por diseño: ping-post vende el mismo consumidor a dos vendedores dentro de la hora) y `needs reply`, los dos esperando Aloware; el estado `blocked` espera la misma puerta; y la segunda mitad de la regla de supresión —nunca sobre tarjetas importadas jamás trabajadas— espera `imported_at` del módulo de intake. **El día que aterrice un CSV, mil tarjetas sin tocar se ponen ámbar a la vez si `signalsSuppressed` no crece esa cláusula.**

### 🎯 EL RANK-AND-GAP, EL CHECKLIST, Y UNA TRAMPA DE PRECEDENCIA QUE PAGUÉ (2026-08-03)
`app/components/leaderboard/rank-and-gap.tsx` · `standing-block.tsx` · `empty-copy.ts` · `app/components/home/first-run-checklist.tsx` · `app/routes/api/home-setup.ts` · migración **0024** · `scripts/seed.ts` · `scripts/install-jobs.ts` · `scripts/check-perf-budgets.ts`. **163 → 188 tests · 33 → 66 e2e.**

Los puntos **1 a 4 y 6** de la lista anterior, cerrados. Lo que sigue es lo que aprendí construyéndolos.

🔴 **LA TRAMPA MÁS CARA: construí el bloque de rank-and-gap con el texto equivocado y lo descubrí DESPUÉS de commitearlo.** Lo saqué de la narrativa de §7 (`$6,900 behind Dana R.`) y del mock ASCII de `04b` §4.1, que dice lo mismo. **Las dos están superadas adentro del propio `04b`:**
- **R5.4** dicta que la pantalla de inicio del vendedor se especifica en `04b`, no en los flujos de `04`.
- La fila *"Gap sentence variants"* de §4.1, **tres líneas debajo de ese mock**, lista `{amount} to pass {peer_short}` y agrega *"never invent a gap sentence that is not motivating"*.
- §4.8 ratifica lo mismo como `lb.self.gap`, bajo una tabla cuya regla es **"keys not listed do not exist"**.

**Dos fuentes coinciden contra un dibujo desactualizado.** Y la diferencia no es de estilo: `behind` es marco de pérdida, `to pass` es marco de meta, y la feature 30 del módulo de leaderboard **prohíbe** el primero — los mensajes de ranking van *"always phrased as a gap and an action, never as a loss"*. `behind` sobrevive en un solo lugar: `earn.celebrate.*`, el toast del momento en que el vendedor **acaba de pasar** a alguien.

**Lección de método, no de código: leí la narrativa y el mock, que es lo que un humano lee primero, y no la tabla de strings ratificados.** Cada string inventado quedó reemplazado por su clave (`lb.self.leading` · `lb.self.tied` · `lb.self.zero_alltime` · `lb.supervisor_total` · `See the board` · `We couldn't load your rank.`).

- **La brecha se resta en el SERVIDOR** y cruza el cable como string de centavos enteros. Los dos operandos viajan en la misma respuesta, que es lo que hace a este el lugar más tentador del producto para hacer aritmética de dinero en el cliente. Un test assertea **las comillas en el body serializado**, no sólo el valor.
- **Derivado de las filas del propio tablero, no de una segunda consulta** — errata **E2** satisfecha estructuralmente: hay una expresión de orden y una de población, y ninguna segunda implementación que pueda discrepar. 🔬 **La variante `rank - 1` es indistinguible hoy y la mutación quedó VERDE** (los rangos son contiguos por construcción). Anotado en el comentario en vez de reclamar cobertura.
- **El bloque busca su propio dato, y NO con `useFetcher`:** una `Response` lanzada desde el loader de una resource route la renderiza el error boundary más cercano, y `api/leaderboard` es top-level sin ninguno — un 500 borraría el día del vendedor **a través del framework** en vez de a través de un loader de página. §1.1 razón 2 nombra esta pantalla; un e2e lo assertea devolviendo 500 y mirando que My Day siga entero.
- **Sin intervalo, a propósito.** La cadencia registrada del canal leaderboard (N6, 5000 ms) está presupuestada a 0,6 de duty de **una** pestaña por vendedor; un segundo cliente permanente mueve el piso firmado de N20 (~898.000 req/día) un ~13%, y mover un número de la tabla P5.3 es un ruling, no un detalle. Refresca al montar y al volver el foco.

🔴 **DOS DEFECTOS QUE SÓLO APARECIERON MIRANDO LA PANTALLA:**
1. **El seed escribía el nombre de pila pelado en `display_name`**, así que la línea decía *"behind Priya"*. Todos los ejemplos del corpus son `First L.` — Marcus T., Dana R., Carlos J., Maria R. **No es sólo copy:** en un piso de cincuenta productores dos comparten nombre de pila, y un tablero público con dos filas que dicen `Maria` es un tablero donde nadie encuentra su propia posición.
2. **En teléfono la frase envuelve y el último `·` quedaba colgando** al final de la primera línea. Debajo del breakpoint de densidad el salto de línea **es** ese separador, así que se quita en vez de quedar huérfano. Las dos formas se assertean por perfil: un patrón que aceptara cualquiera no podría ver desaparecer el punto en escritorio.

**EL CHECKLIST DE PRIMERA CORRIDA (US-9.14, C-41).** Cada ítem es **una pregunta hecha al dato** — sin `dismissed_at`, sin tabla de completado, sin nada que el vendedor pueda tildar — así que *"colapsa cuando los cuatro están y no vuelve"* es aritmética y no una bandera que alguien tiene que acordarse de poner.

- ⚠️ **NO PUEDE COMPLETARSE en este build, y lo digo en vez de esconderlo.** El ítem 1 pregunta si el número de llamadas está verificado y `aloware_number_mapping` no existe, así que la respuesta es no para todo vendedor de todo tenant. El colapso se prueba contra una lectura de setup **stubbeada**.
- ⚠️ **El camino "concedido" del ítem 4 se prueba contra un objeto `Notification` stubbeado.** Medido primero: **Chromium headless reporta `denied` pase lo que pase**, y `context.grantPermissions(['notifications'])` no lo mueve.
- `Number(` es error de build fuera de `app/lib/money`, así que contar cuatro booleanos es `filter(Boolean).length`. `Notification.permission` se lee con `useSyncExternalStore`, no copiándolo a estado desde un efecto — que era, además, lo único que el linter de React rechazaba.

**LAS CUATRO LÍNEAS VACÍAS DEL TABLERO, Y POR QUÉ ERAN INALCANZABLES.** El estado vacío colgaba de `rows.length === 0`, pero la migración 0017 hizo que el tablero arranque del **roster**: `rows` nunca está vacío una vez que el tenant tiene vendedores. Ahora cuelga del **total del piso en cero**, que es exactamente el tablero del ítem protegido 9 — cincuenta nombres, cincuenta $0, la nota al pie, y ahora una línea que dice qué pasa después, con los nombres todavía ahí.

- La copy anterior reportaba ausencia dos veces (`Nothing closed in this period yet` sobre `Try All time to see the full history`) y **mandaba al vendedor a otro tablero** la única mañana en que el producto más necesita que cierre algo. §4.10 abre con la regla que rompía: *"a state that only reports absence is a defect"*.
- Las cuatro viven en un módulo de datos para que la propiedad que importa se assertee **sin renderizar**: cuatro títulos distintos, cuatro cuerpos distintos, cada uno nombrando su propio período. El atajo que esto previene no es pereza sino prolijidad — una sola frase con `{period_label}` interpolado se lee bien y colapsa justo la distinción que §4.10 pide.

🔴 **DOS EXIGENCIAS DE §1529 QUE LA LISTA PROTEGIDA NUNCA REGISTRÓ COMO FALTANTES: el seed no abarcaba los cuatro períodos y no tenía ninguna reversa.** Medido, no supuesto: day, week, month y all-time tenían **el mismo número** ($56.717,88), porque `stage_move` sólo puede estampar `now()`. El selector de período no demostraba nada en el minuto 0:30.

- Ahora la primera venta de cada vendedor sigue yendo por la puerta real y **el resto se retrofecha por `ledger_append`**, anclado a los **límites de período actuales en la zona horaria de negocio del tenant** y nunca a una cantidad fija de días: *"siete días atrás"* abarca buckets distintos según el día de la semana, y un demo que funciona los jueves es peor que uno que nunca funcionó.
- Resultado: hoy $26.339,88 · mes $30.557,88 · all-time $31.997,88, **y el top tres se re-rankea entre pestañas.** Una reversa, retrofechada para que no mueva ningún tablero acotado.
- 🎯 **Encontrado por la constraint haciendo su trabajo:** `earnings_deal_context_present` rechazó la reversa con `opportunity_id` nulo. Una fila de dinero sin trato detrás es un número que nadie puede explicar nunca.

🔴 **JOBS003 — UNA TRAMPA QUE DISPARÉ YO Y DESPUÉS CERRÉ.** Un comando encadenado corrió `db:jobs` después de un `db:migrate` que había competido con el arranque del contenedor, **y la base quedó irrecuperable**: `harden()` falla cerrado ante un esquema sin clasificar, la migración 0020 es la que clasifica `pgboss`, y varias migraciones llaman a `harden()`. Todo migrate posterior levantaba `HR001` para siempre. Sin migraciones de vuelta, el único arreglo era `db:reset`.

- `install-jobs.ts` ahora **se niega** nombrando el comando a correr primero. Chequeo en dos pasos, porque el propio registro llega en la 0000 y un guard que revienta en una base nueva no enseña nada. **Probado por los dos lados: exit 1 sin la fila de registro, exit 0 con ella.** El runbook ya decía migrate primero — un runbook es documentación, esto es el mecanismo.

**LA ALTURA DE TARJETA DEJA DE SER UN NÚMERO EN UNA HOJA DE ESTILOS.** `04b` cargaba **tres** alturas (108/92 en §3.6, **112 en el mock de §2**, 120/156 en §1) y el ruling N17 tachó las dos primeras. Hasta hoy la tarjeta **no tenía altura fija ninguna**: era un grid que se estiraba con su contenido.

- Migración **0024** registra `ui.card_h_desktop` (120) y `ui.card_h_mobile` (156) con el brazo **`pinned`**. Dos nombres, no uno: 44px de target y tipografía móvil necesitan la caja más alta para las mismas cuatro filas, y un nombre para dos geometrías es cómo las dos convergen en silencio.
- **La puerta se cierra en dos mitades y ninguna alcanza sola:** `card-height.test.ts` ata el token CSS al número fijado (compara **valores**, nunca nombres — E7/NEW-1) y prueba que `AP004` rechaza 96 y acepta que se re-afirme 120; `card-anatomy.spec.ts` ata el token a lo que un navegador realmente renderiza, en los dos perfiles, y assertea el **pitch uniforme por separado** — una tarjeta mal es una variante, una columna entera corrida por lo mismo es un token.
- **Por qué carga peso y no es cosmética:** un pitch de columna uniforme es lo que hace virtualizable una columna de 500 tarjetas, y la virtualización es lo que hace alcanzables los 60 fps de P6 y el presupuesto de LCP. Una tarjeta que crece una fila porque alguien agregó un chip **no se ve rota** — le come la holgura a la puerta de drag.
- **P6 sigue verde con la caja fija.**

**EL CHECKER DE PRESUPUESTOS POR FIN LEE EL MOTOR.** La migración 0022 movió el rechazo a Postgres hace ocho commits y **nada comparaba las dos cosas**: el motor podía rechazar un valor que el archivo ya estaba shippeando.

- Tres discrepancias, cada una con su frase: un nombre que el motor nunca oyó · un valor distinto · **un presupuesto que el archivo llama `null` mientras el motor tiene una medición**, que es la forma más barata de hacer desaparecer un incumplimiento.
- 🎯 **Probado por mutación:** archivo aflojado a 400.000 contra los 128.000 del motor → **`PERF006`, exit 1**, nombrando los dos números. Ese es exactamente el paseo que esto existe para frenar.
- ⚠️ **LO QUE NO ES, dicho y no insinuado:** cierra el hueco en el hook de **pre-commit**, que es por donde pasan los commits de este proyecto. **NO cubre el CI:** eso necesita `crm_ci` con LOGIN y contraseña puestos fuera de banda y la cadena de conexión como secreto del repo. Las dos cosas son de Jorge; hasta entonces el CI imprime un cuadro que dice que el cruce no corrió. **Un motor inalcanzable pasa en vez de fallar, y ése es el único borde blando acá** — fallar duro dejaría el checker incorrible sin base, incluido el CI que todavía no tiene credencial.

⚠️ **Contradicción encontrada al pasar y NO tocada:** §4.8 marca `lb.footnote.golive` como *"Permanent footnote"* y a `lb.footnote.tracked_since` como *"Replaces the above"*. Las dos no pueden ser ciertas. Hoy se renderizan **las dos**, que es lo que preserva la frase del ruling D8 (*"imported history isn't counted"*) — reemplazarla por una fecha de inicio perdería justo la honestidad que el ítem protegido 9 existe para sostener. Queda como está, anotado.

⚠️ **Deuda de higiene nueva: los ids de tenant de los tests de integración se asignan a mano y nada impide una colisión.** `crm_test` es compartida entre archivos y mi primer fixture chocó con `scheduling.test.ts` en `...0000f7`. Se resolvió cambiando el mío; no hay mecanismo.

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

### 🏷️ El tablero honesto y el chip de Demo (2026-08-02)
`scripts/seed.ts`, `app/routes/api/leaderboard.ts`, `shell.tsx`, `leaderboard.tsx`, `undo-bar.tsx`, `tests/e2e/honest-board.spec.ts`. **33 e2e** (+2).

Los ítems protegidos 9 y 10 son la **contraparte del confeti**: la parte que dice la verdad en vez de celebrar. Ninguno se puede sostener con un tipo ni una constraint — son copy en pantalla, así que un test que lee la pantalla es el único mecanismo disponible.

- **`tenant.is_demo` existía desde la migración 0001 con índice único parcial, y el seed NUNCA lo marcaba.** O sea que el chip no podía aparecer aunque estuviera construido. **Una columna que nadie escribe es una columna que no existe.**
- **Tres textos, cada uno con su razón escrita:** *"The board starts at go-live — imported history isn't counted."* (permanente, es el ruling D8 en una frase, y su atajo asesino es borrarlo *"por ser ruido"*); *"Earnings tracked since <fecha>"* (un total sin fecha de inicio invita al lector a inventarse una); y *"Demo tenant — these numbers are seeded."* sólo en el tenant sembrado.
- **El chip vive en el SHELL, no en una pantalla**, y el test lo comprueba en las tres. Un marcador que sólo está en el tablero **falta justo en la captura que alguien saca de My Day** — que es el fallo que el ítem 10 describe: una captura del demo indistinguible de las cifras de un cliente real.

🔴 **Y EL CHIP DESTAPÓ UN BUG DE LAYOUT QUE NO CAUSÓ — lo empujó al borde.** El e2e móvil del undo empezó a fallar con *"intercepts pointer events"*, que **es un bug de layout disfrazado de fallo de test**. La cabecera del shell ya estaba a un elemento de desbordar un teléfono; el chip la pasó, el documento ganó scroll horizontal, y **la barra de undo —`position: fixed`, centrada en el viewport— dejó de ser clickeable en sus propias coordenadas**.

- ⚠️ **Tres hipótesis mías equivocadas antes de medirlo bien, y las anoto porque el método falló, no sólo el código:** creí que era orden de apilado (subí el `z-index` de 10 a 30 → seguía fallando), después que era desbordamiento de texto empujando el botón fuera del `overflow: hidden` (agregué truncado → seguía fallando). **Un probe con el escenario exacto mostró el botón perfectamente clickeable**, lo que descartó las dos. Lo que lo resolvió fue **quitar el chip y ver que pasaba** — la comparación que debí hacer primero.
- **Los dos cambios intermedios se quedan porque son correctos igual:** el `z-index` 30 sí hacía falta (la barra ahora precede a las columnas en el DOM, así que ya no gana por orden de pintado), y el truncado con `flexShrink: 0` en las acciones evita que un nombre largo empuje el botón fuera de la barra.
- **El arreglo real: la cabecera envuelve (`flexWrap`) y el gap baja de 6 a 3.** En 482 px el gap viejo era la mayor parte del desbordamiento.

### 🔴🟢 La PRIMERA corrida del CI, y falló en 29 segundos (2026-08-02)
`package-lock.json`, `.github/workflows/verify.yml`.

**El repositorio por fin tiene remoto** — `github.com/RuizGoge/CRM-Agency`, privado, 44 commits. Y el CI, que nunca se había ejecutado, **falló a los 29 segundos**: demasiado rápido para ser un test, así que murió en el arranque.

🎯 **Diagnosticado reproduciéndolo, no leyendo el log** (que no tenía a mano): corrí el `npm ci` del CI dentro de un contenedor `node:24` con Docker, que es exactamente lo que hace el runner. Falló idéntico:

```
npm error code EUSAGE
npm ci can only install packages when your package.json and
package-lock.json are in sync.
Missing: @emnapi/core@2.0.0-alpha.3 from lock file
Missing: @emnapi/runtime@2.0.0-alpha.3 from lock file
```

**El lockfile se generó en Windows y le faltaban dos dependencias transitivas que npm sólo resuelve fuera de Windows.** `npm install` local nunca se quejó —resuelve lo que su plataforma necesita—; **`npm ci` es estricto por diseño y se niega**. El lockfile estuvo así todo el proyecto y nada podía notarlo, porque nunca había corrido en Linux.

- **Regenerado dentro del contenedor Linux y verificado en las DOS plataformas antes de aplicarlo:** 458 → 460 entradas, **exactamente las dos que faltaban agregadas, cero quitadas, las 13 entradas de `win32` intactas**. `npm ci` real en Linux: exit 0. `npm ci --dry-run` en Windows: verde.
- ⚠️ **Y una segunda divergencia encontrada al comparar, que el propio workflow desmentía.** Su comentario decía *"la misma imagen que usa el compose local"* — cierto para la imagen, **falso para la configuración**: el compose local crea el cluster con `--locale-provider=icu --icu-locale=en-US` y el CI lo creaba con locale de libc. **Ordenamiento y comparación difieren entre los dos**, así que un `ORDER BY` correcto local podía ser distinto en CI — o peor, correcto en CI y equivocado en la pantalla de un vendedor. Agregado a los dos bloques de servicio.
- **Lección de método:** con Docker disponible, **reproducir el entorno del CI es más rápido que conseguir su log** — y da un ciclo de corrección que no depende de esperar a nadie.

### 🧯 `db:generate` se niega mientras la cadena de snapshots esté atrasada (2026-08-02)
`scripts/guard-db-generate.ts`, `package.json`.

La deuda que encontré al hacer 0022 era **una trampa cargada, no una molestia**. drizzle-kit genera una migración **diffeando los archivos de esquema contra el snapshot MÁS NUEVO**; el más nuevo es 0018 y desde entonces hay **cinco** migraciones escritas a mano, dos de las cuales **alteraron tablas** (0019 sumó constraints a `earnings_ledger`, 0020 sumó `scheduled_job.claimed_at`). Ninguna quedó en un snapshot.

Correr `db:generate` habría emitido una migración que **re-agrega objetos que ya existen o dropea los que no puede explicarse** — contra una base cuya regla es que **no hay migraciones de vuelta: el rollback es la imagen anterior**. O sea que no es algo que se deshaga.

- **Convertido en una negativa con instrucciones (`DBGEN003`), misma postura que `BOOT002` y `JOBS002`.** Nombra el snapshot más nuevo, la migración más nueva, y lista las cinco escritas a mano.
- **Bloquea el GENERADOR, no el trabajo.** Seguir escribiendo SQL a mano —que es lo que hicieron las últimas cinco— no toca este guard.
- 🎯 **Probado por los dos lados:** con la cadena sincronizada sale 0; desincronizada sale 1. Un guard que siempre dispara se termina borrando.
- **No estaba roto hoy sólo porque nadie había corrido el comando.** Esa es la definición de trampa cargada.

### 🚦 La tensión del loader SSR: eran TRES, no dos (2026-08-02)
`contracts/ui-loader-whitelist.json`, `scripts/ui-loader-whitelist.test.ts`, migración **0023**. **6 tests nuevos.** Total: **163**.

La tensión estaba marcada como *"sin resolver"* desde el ítem del kanban. Al leer el texto normativo aparecieron dos cosas que la nota no decía.

- **§1.2 tiene nombre y ya elegía ganador: *"The one whitelisted UI loader"*, y es el PIPELINE.** No era una pregunta abierta entre leaderboard y kanban: el kanban es el sancionado porque su primer pintado carga el presupuesto de LCP con 500 leads. Y §1.2 pide explícitamente **un archivo de lista blanca versionado**, que **no existía** — por eso el número derivó sin que nada pudiera notarlo.
- 🔴 **Y son TRES, no dos: `my-day.tsx` también tiene loader de datos y nunca se había contado.** `CONTEXT.md` registraba la deriva como dos. **Un conteo que nadie puede ver es un conteo que se equivoca.**
- **§1.1 da cuatro razones ancladas en el registro contra los loaders de datos**, y la segunda **nombra a My Day explícitamente**: cada bloque es un fetch independiente con su propio error y su propio reintento, así que un bloque de ranking caído no puede tirar abajo My Day. **Un loader de página es justo el patrón que el registro prohíbe ahí** — lo que hace a My Day el candidato más fuerte a removerse de los tres.
- **`shell.tsx` y `home.tsx` NO cuentan y no son una exención:** resuelven identidad y redirigen, sin dato de aplicación. Un test impide la escotilla obvia —reetiquetar un loader de datos como "navigation" para bajar el conteo— exigiendo que un loader de navegación **redirija** y **no llame a ningún `readX()`**.
- ✅ **Registrado como ratchet `shrink_only` (migración 0023), y probado por los dos lados contra la base:** agregar un cuarto loader → **`AP005: ui.loader_whitelist refused, {app/routes/ui/new-screen.tsx} is not in the previous set`**; encoger al único sancionado → aceptado. **Es el primer uso real de la máquina construida en 0022**, y §11.3 clasifica exactamente así las listas de este estilo: agregar es aflojar.
- ⚠️ **DECISIÓN ABIERTA, de Jorge, y no la tomé yo:** qué hacer con los dos loaders fuera de presupuesto. Sacar el del leaderboard cuesta el primer pintado de **la pantalla que abre el demo** (DEMO-10 quiere rango y brecha arriba del pliegue en los primeros diez segundos); sacar el de My Day es el que el registro pide por su propio texto. **El motor sólo garantiza que el número no puede volverse cuatro en silencio.**
- ⚠️ **Y una lección que pagué: sondear un ratchet append-only tiene consecuencias permanentes.** Mi prueba del brazo insertó filas reales y dejó el baseline de `crm_dev` encogido. **No se puede borrar — por diseño.** Se arregla con `db:reset`, y la migración sólo siembra `WHERE NOT EXISTS`. **Probar una tabla append-only es escribir en ella.**

### 📋 La Lista Protegida deja de ser prosa: `DEMO-01..10` (2026-08-02)
`contracts/protected-list.json`, `scripts/protected-list.test.ts`, `tests/e2e/demo-protected.spec.ts`. **8 tests de registro + 3 e2e.** Totales: **157** y **31 e2e**.

`04-ux-flows.md` §8 lo dice sin ambigüedad: ***"La Lista Protegida es ejecutable, o no está protegida."*** Y su regla 1 nombra el modo de falla exacto: *la función se entrega, el test se desactiva "temporalmente", y el detalle ya no está para cuando alguien corre un demo*. Hasta hoy no había nada capaz de distinguir *"cubierto por un test"* de *"nadie miró"*.

- **Los diez ítems, con estado y verificado por máquina.** `covered` nombra un test **que tiene que existir** —un id mal escrito rompe el build—; `blocked` nombra qué lo bloquea (mínimo 30 caracteres: "TODO" no califica); `partial` lista **en palabras** qué falta. **`partial` no es un estado que apruebe**: existe para que un ítem a medias se lea como a medias en vez de contar como hecho.
- **Estado real, sin maquillaje: 3 de 10 cubiertos.** Un test assertea ese número, así que moverlo es una decisión y no una deriva. `DEMO-02 · 05 · 06 · 08` bloqueados (Aloware, búsqueda global); `DEMO-07 · 09 · 10` parciales con su lista de faltantes.
- **`DEMO-03`** (la etapa earning rechaza el drop y abre la puerta) y **`DEMO-04`** (id ajeno → not-found, **nunca 403**) verdes.
- 🎯 **`DEMO-01` traía una trampa de precedencia:** §7 pide que la segunda pantalla re-rankee **"en 5 s"**, y ese número está **tachado**. La proyección pública retiene toda entrada más joven que `undo_window` (5000) + guard (500), así que **un re-rank en 5 s es aritméticamente imposible en un producto CORRECTO** — el tablero se niega a publicar una venta que todavía se puede deshacer. §8.3 lo retira y **P21** lo reemplaza por 6,5 s push / 10,5 s poll. Asertar el número viejo habría fallado para siempre y el "arreglo" habría sido romper el undo. **Medido: 6.063 ms**, después del cierre de la ventana y dentro de P21.

🔴 **Y UNA FALSA ALARMA DE DINERO QUE CASI REPORTO COMO DEFECTO.** La primera versión de `DEMO-01` midió que el tablero público publicaba la venta **2.517 ms** después de ocurrir — o sea dentro de la ventana de undo, que es exactamente el defecto que la migración 0019 cerró. **No era real.** Era contaminación entre tests: `DEMO-03` cerraba una venta justo antes y **esa** venta afloraba 5,5 s después, dentro de la ventana de medición de `DEMO-01`. Dos correcciones, en este orden:
1. **Aserción demasiado ancha:** comparaba el texto **entero** de `main`, así que cualquier cambio contaba como re-rank. Ahora se extrae el monto de Renata.
2. **`DEMO-03` dejó de cerrar la venta.** Su ítem es *"el tablero RECHAZA el drop y la puerta se abre"* — que la puerta aparezca, sin unidad preseleccionada y con el valor requerido, **es** la aserción. Cerrar el trato es trabajo de `DEMO-01`.
3. **Y `DEMO-01` ahora espera a que el tablero se ESTABILICE** antes de arrancar el cronómetro, porque otros specs (celebración) también acreditan dinero. Suelto pasaba, en la suite no: **la firma de estado compartido, no de un bug.**

**Es la misma lección que la suite comiéndose sus propias tarjetas, un nivel más arriba: un test que acredita dinero se filtra a todo test que mira dinero.**

- ⚠️ **Hallazgo colateral: el tablero "público" NO es público.** `/earnings` vive dentro del layout `shell`, que redirige sin sesión — una segunda pantalla anónima mira el login re-renderizarse para siempre, que es como falló mi primera versión. La segunda pantalla del test entra como **otro vendedor** (Priya), que es el momento del demo tal como está escrito. **Si debe ser alcanzable sin sesión es una pregunta de producto, sin resolver.**

### ⌨️ La barra de undo era el ÚLTIMO elemento tabulable de la pantalla (2026-08-02)
`tests/e2e/undo-keyboard.spec.ts`, `app/routes/ui/board.tsx`. **28 e2e** (+1); 149 de unit/integración sin cambios.

🔴 **MEDIDO, no supuesto — y `CONTEXT.md` decía lo contrario.** La nota anterior afirmaba que la barra estaba *"temprano en el DOM del `main`"*. Se renderizaba **después de `PipelineColumns`**, así que en orden de tabulación quedaba detrás del enlace "Move" de **cada tarjeta del tablero**: **focusable #14 de 15** en el tenant demo. Con las 500 tarjetas de un vendedor real son ~500 pulsaciones, dentro de una ventana que se cierra a los cinco segundos.

**Y axe la aprobaba todo el tiempo.** La barra es focusable, etiquetada y con contraste correcto. **axe lee una instantánea y no tiene noción de PLAZO**, así que *"alcanzable por teclado"* y *"alcanzable mientras existe"* le parecen la misma propiedad. Sólo la segunda es la promesa.

- ✅ **Corregido moviéndola ANTES de las columnas: #14 → #5.** Es `position: fixed`, así que **nada se mueve en pantalla** — el orden del DOM *es* el orden de tabulación, y eso era todo.
- ⚠️ **DOS instrumentaciones mías equivocadas antes de obtener el número real, las dos reportando algo halagüeño.** Manejar el teclado de verdad devolvió **1 tab**: `document.body.focus()` es un no-op porque `body` no tiene `tabindex`, y —lo que no sabía— **aun con `activeElement` en `BODY` tras un `blur()`, Chromium conserva su *sequential focus navigation starting point* donde ocurrió el último clic**. O sea que la caminata empezaba al lado del botón que buscaba. **Es la segunda vez que este proyecto paga esta lección** (la primera fue el anillo de foco "faltante" que sí existía). Ahora se cuenta el **índice entre los focusables en orden de DOM**, que es el número que experimenta un vendedor y no depende de ninguna de esas peculiaridades.
- **El tope es 6 y es un gate**, no una observación: sin un número, esto vuelve la próxima vez que alguien agregue una sección arriba del tablero.

### ⚙️ `ref.ci_ratchet` — el presupuesto deja de poder aflojarse editando un archivo (2026-08-02)
Migración **0022**, `tests/integration/ci-ratchet.test.ts`. **15 tests nuevos.** Total: **149**.

`perf-budgets.json` ya pone el build en rojo, que es mecanismo de verdad. Lo que **no** era es incaminable: aflojar un número ahí es editar un archivo, y la regla fundacional nombra al actor contra el que hay que diseñar — *"Claude lo escribe y nadie lee el diff"*. Esto mueve el rechazo al motor.

🔴 **TRAMPA DE PRECEDENCIA, y era de las caras: construí §11.3, NO §10.0.1.** El texto de §10.0.1 pone `direction` como columna de la fila de valor y ofrece un brazo `frozen_set`. **§11.3 tacha las dos cosas**, y las dos razones son el punto entero:
- **Una dirección elegida por quien escribe la fila más nueva la elige el atacante.** Ahora vive en `ref.ci_ratchet_name`, inmutable y keyed por nombre; cambiar un brazo exige **dropear un trigger protegido**, no editar una fila.
- **`frozen_set` era superset-only** — el brazo equivocado para toda lista que protegía. *"El modelo edita el literal"* reconstruido como *"el modelo inserta una fila"*. El vocabulario correcto es `monotonic_down · monotonic_up · pinned · shrink_only · sealed_set`.

**Construir §10.0.1 primero y "corregirlo después" habría dejado el guard invertido en producción en el medio.**

- **Seis rechazos, cada uno con su SQLSTATE** para que un build rojo diga *cuál* garantía se violó: `AP002` (monotonic_down), `AP003` (up), `AP004` (pinned), `AP005` (shrink_only), `AP006` (sealed_set), `AP007` (nombre sin brazo registrado), `AP008` (forma de fila que no corresponde al brazo).
- ✅ **Los cinco brazos probados por los DOS lados.** Un brazo que siempre rechaza pasa un test ingenuo y se termina borrando la primera vez que bloquea algo legítimo; uno que nunca rechaza pasa el mismo test para siempre.
- **La suite corre como el DUEÑO a propósito** — la credencial que *puede* debilitar cosas. Probar el trigger con un rol restringido no diría nada sobre el caso que importa. `UPDATE`, `DELETE WHERE false` y `TRUNCATE` levantan `AP001` incluso para el migrador.
- 🎯 **Y la aserción que vale sola:** `INSERT` de 400000 sobre `perf.P12` → **`AP002: perf.P12_initial_js_gzip loosened from 128000 to 400000`**. Ese es exactamente el paseo que esta tabla existe para frenar.
- **`crm_ci` se crea `NOINHERIT` y SIN contraseña ni LOGIN**, igual que `crm_app`: una credencial en una migración es una credencial en el repositorio, en la imagen y en cada clon. Tiene `INSERT, SELECT` sobre los valores y **`SELECT` solo** sobre los brazos — el CI registra lo que midió y **nunca puede reclasificar qué significa una medición**.
- **E6 queda satisfecha, no anticipada:** los cuatro nombres registrados con su brazo y su justificación (≥20 caracteres por `CHECK`), y **`perf.P20` sin fila de valor** porque nada lo midió todavía. Un test asegura que ese hueco siga visible.
- 🔬 **Una mutación quedó VERDE y la anoto en vez de taparla.** Cambié el trigger para comparar contra la última fila en vez de `min(value_num)` y los 15 tests siguieron pasando. **La razón es que bajo `monotonic_down` los dos números son el mismo por inducción**: toda inserción aceptada es ≤ al mínimo, así que la última fila *es* el mínimo. El agregado es defensivo, no load-bearing, y sólo difiere si alguna fila aterriza sin el trigger. **El test que decía probar esa distinción afirmaba una propiedad que la regla vuelve inalcanzable — reescrito para decir lo que sí prueba.**
- ⚠️ **LO QUE ESTO TODAVÍA NO HACE, dicho claro:** el checker `check-perf-budgets.ts` **sigue comparando sólo contra el archivo**. Que lea el ratchet exige la credencial de `crm_ci` en el CI, y eso exige el remoto que todavía no existe. Hoy la garantía es: *el motor rechaza el aflojamiento* — probado, con 15 tests. Falta: *el CI no puede correr con un archivo que discrepe del motor.*

⚠️ **DEUDA DE HIGIENE ENCONTRADA AL PASAR: la cadena de snapshots de Drizzle está desenganchada desde 0018.** Las migraciones **0019 y 0020 alteraron tablas** (constraints y la columna `claimed_at`) sin actualizar `meta/*_snapshot.json`, y 0019–0022 son SQL escrito a mano. **Consecuencia: `npm run db:generate` compararía contra un estado cuatro migraciones viejo** y podría emitir un diff que re-agrega o dropea cosas. No es un problema hoy porque nadie lo corrió; **es una trampa cargada para la próxima sesión que cambie una tabla vía Drizzle.**

### 🧨 P6 medía el DEV SERVER, y Closed Lost por fin se puede usar (2026-08-02)
`playwright.config.ts` (dos servidores), `scripts/seed.ts` (+7 razones de pérdida), `tests/e2e/lost-gate.spec.ts`. **27 e2e** (+1); 134 de unit/integración sin cambios.

🔴 **EL HALLAZGO MÁS IMPORTANTE DE LA SESIÓN, y salió de un cambio hecho por otro motivo. El gate de performance estaba midiendo el servidor de desarrollo de Vite.**

Cuando puse `reuseExistingServer: false` —por la razón correcta, cerrar el falso verde del mutation testing— la Puerta 12 se cayó de **6 de 6 verdes a 1 de 4**, con long tasks de 54 a 89 ms. La causa no era el producto: antes se reutilizaba un dev server **caliente**, y ahora cada corrida pagaba las transformaciones de uno **frío**. Un dev server de Vite entrega módulos sin minificar, el cliente de HMR, source maps y transformaciones bajo demanda. **Nada de eso lo baja un vendedor.** P12 ya medía el build de producción; que P6 midiera `npm run dev` era la incoherencia.

- ✅ **Contra el build de producción el resultado es otro: `max = 16,8 ms`, o sea CERO frames perdidos**, p95 16,8 ms, cero long tasks, **5 de 5 verdes**. Los 33,3 ms de base contra un límite de 34 —que yo había llamado "no es holgura, es suerte"— **eran enteramente el dev server**. Ahora hay 2× de holgura real.
- **Dos servidores, y el segundo no es comodidad:** los specs funcionales siguen contra `npm run dev` (que es lo que hace el CI y lo que da errores legibles); el de performance corre contra `npm run build && npm start` en el puerto 3001.
- 🎯 **Dientes reconfirmados por el camino nuevo:** 60 ms de bloqueo por `dragenter` → rojo (max 50,1 · long task 64). Revertido → verde con max 16,8.
- **`npm start` NO lee `.env`** (sólo `npm run dev`, vía Vite), así que hay que pasarle el entorno explícito. **Lo atraparon en el acto las propias negativas de arranque G4(a) y JOBS002** — el mecanismo funcionando.
- **Al servidor de medición se le quita el rol `worker` a propósito:** un tick del despachador cayendo en medio del drag es ruido en el único número que ese perfil existe para producir.

🔴 **Y CLOSED LOST DEJA DE SER INUSABLE.** El seed no creaba **ni una** fila en `app.lost_reason`. El selector "Why?" es `required`, la puerta de pérdida es un `CHECK` (`current_stage_type <> 'lost' OR lost_reason_id IS NOT NULL`), y sin opciones **la base rechaza todo movimiento a una etapa perdida**. Nada del producto estaba roto: faltaba el dato del que depende, y **toda la suite pasaba igual porque ningún test había intentado perder un trato jamás**.

- **7 razones sembradas**, con `code` como clave de reporte y `label` como texto humano — renombrar una etiqueta no puede mover un número, la misma regla que ata las puertas a `stage_type` y no al nombre de la etapa.
- **A nivel TENANT, no por vendedor:** cada vendedor configura sus etapas (D4), pero el reporte compara motivos de pérdida en toda la agencia, y una lista por vendedor volvería incomparable el único número que un dueño quiere.
- 🎯 **Probado por mutación con el estado exacto en que estaba el demo:** desactivando las razones, rojo con *"Closed Lost is unusable with no loss reasons seeded"*.
- ⚠️ **Una aserción mía mal planteada, corregida:** un `<option>` dentro de un `<select>` cerrado **no es "visible"** para Playwright, así que `toBeVisible()` fallaba sobre un selector que funciona perfecto. Lo que importa es la cantidad, no la visibilidad. Y se selecciona **por etiqueta y no por índice**, porque el índice 0 es el placeholder deshabilitado que existe justo para que ningún motivo quede preseleccionado.
- ⚠️ **Trampa de herramienta anotada: Playwright BORRA `test-results/` al arrancar.** Tenía ahí un script de restauración y se lo llevó a mitad de un mutation test, dejando el demo con las razones desactivadas. **No usar `test-results/` como scratch.**

### 🏁 PUERTA 12 CERRADA — el drag medido a 60 fps con 500 tarjetas (2026-08-02)
`tests/e2e/fixtures/perf-500.ts`, `tests/e2e/drag-perf.spec.ts`, perfil `dnd-ci`, `perf-budgets.json` (P6), `pipeline-columns.tsx`. **26 e2e** (+1); 134 de unit/integración sin cambios.

El drag existía desde el ítem de escritorio. **Lo que nunca existió es la mitad que le da el nombre a la puerta: la medición.** *"Drag a 60 fps sin long task > 50 ms"* era una línea de `CLAUDE.md` que nada comprobaba.

- **Nomenclatura fijada, porque hay dos cosas que se llaman 12:** en el corpus de Fase 5 **"Puerta 12" es la puerta de PUBLICACIÓN** (deuda de contradicciones, *"el silencio no es una resolución"*); **`G12` es la del drag** (05c §1508). La escalera de `CONTEXT.md` usa la segunda.
- **`perf-500` tiene TENANT PROPIO, y las dos razones son estructurales:** el tablero lee etapas por `owner_user_id` (las etapas son *del vendedor*, ruling D4), así que darle a Renata las 6 etapas que el fixture pide **reescribiría el tablero que se muestra en el demo**; y `leaderboard_read` devuelve todo vendedor del tenant, así que un vendedor de performance **aparecería en el tablero público en $0 para siempre**. Un tenant aparte es invisible a las dos cosas.
- **El fixture se ASSERTEA antes de medir nada** (`04b` §3.6: *"una 'mejora' causada por un fixture más chico falla"*). 🎯 Probado por mutación: bajándolo a 200 tarjetas, **rojo con "perf-500 must hold exactly 500 cards"**. Un drag es rápido sobre 200 y el presupuesto habría pasado por la razón equivocada.
- **Perfil `dnd-ci`**: `desktop-ci` con **2× de CPU throttle** (`04b` §3.1), aplicado por CDP porque Playwright no tiene opción declarativa. Los otros dos perfiles **ignoran** este spec explícitamente: correrlo sin throttle produciría un segundo P6 más fácil que pasa.
- ✅ **RESULTADO: p95 = 16,8 ms** (60 fps clavado, en todas las corridas), **max 33,3 ms**, **cero long tasks**, con 500 tarjetas bajo throttle 2×. Presupuesto: p95 ≤ 20 · frame ≤ 34 · long task ≤ 50.

🔴 **DOS DEFECTOS EN MI PROPIA MEDICIÓN, los dos encontrados corriéndola:**
1. **La instrumentación costaba más que lo medido.** Llamaba `getComputedStyle` en cada iteración del loop — un flush de estilo síncrono sobre 500 tarjetas, ~70 veces. **El arnés tiraba los frames que después reportaba.** Ahora se muestrea una vez por columna.
2. **Y al corregirlo, leía demasiado pronto:** chequeaba el anillo en el mismo tick que despachaba `dragenter`, antes de que React re-renderizara, así que reportaba *"el drag nunca se encendió"*. **Instrumentación que cuesta de más reporta su propio peso; instrumentación que lee de más temprano reporta un producto que no hizo nada.**

🔴 **Y EL MÁS GRAVE — UN FALSO VERDE EN EL MUTATION TESTING, que casi me hace sacar la conclusión opuesta.** Dos mutaciones que debían poner el gate rojo **pasaron**, y estuve a punto de escribir *"el gate no tiene dientes"*. La causa: **`reuseExistingServer: !CI` reutilizaba un dev server huérfano que servía código viejo** — la mutación nunca llegaba al navegador. Con servidor fresco y un bloqueo de 60 ms por `dragenter`, **las tres aserciones disparan a la vez**: p95 33,3 · max 50,1 · long task 97,0 ms. **Cambiado a `reuseExistingServer: false`.** Cuesta ~4 s por corrida y compra que la suite pruebe siempre el árbol de trabajo y no lo que hubiera abierto.

- 🔬 **Una hipótesis mía REFUTADA por la medición, y la anoto porque el resultado fue útil igual.** Creí que el frame perdido venía de re-renderizar las 500 tarjetas en cada cambio de columna. **Puse `memo` en `Card` + callbacks estables con `useCallback` y el número no se movió.** La optimización es real y correcta —sin ella cada `setOverStageId` redibujaba las 500, y `memo` solo no habría alcanzado porque los handlers eran arrows inline que cambiaban de identidad en cada render— pero **no era la causa del frame perdido**.
- **La causa real y el arreglo correcto: `04b` §3.1 define los perfiles como *"3 runs, median reported"* y yo reportaba una sola corrida.** El frame suelto de 50 ms aparecía ~1 vez de 3, siempre con **cero long tasks** y p95 clavado en 16,8 — un frame que el compositor headless no agendó, no trabajo del producto. **Las dos salidas fáciles estaban prohibidas** (subir `max_frame` es debilitar un presupuesto para aprobar; dejarlo flaky produce un gate que se borra en vez de arreglarse). Aplicar el protocolo que el spec ya prescribe no es ninguna de las dos: una regresión real está en las tres corridas y la mediana la sigue; un artefacto de agendado no. **6 de 6 verdes después.**
- **El spec imprime la atribución de los peores frames** (distancia al `dragenter` más cercano) y los máximos de las tres corridas, así que un build rojo dice **dónde** se fue el frame y no sólo que se fue.

### 📏 PUERTA 11 (mitad) — el presupuesto de performance deja de ser una frase (2026-08-02)
`perf-budgets.json`, `scripts/check-perf-budgets.ts`, `scripts/perf-budgets.test.ts`, `vite.config.ts`, `package.json`. **5 tests nuevos.** Total: **134**.

🔴 **EL HALLAZGO, y es del tipo que esta constitución existe para prevenir: el gate no existía.** `CLAUDE.md` afirmaba *"un presupuesto nulo falla el build"* y la errata **E6** (rango 1) lo dice más fuerte todavía — *"el fallo de build por presupuesto nulo es el único gate hasta entonces"*. Busqué el mecanismo en `vite.config.ts`, en los scripts de `package.json`, en el workflow y en los tests: **no estaba en ninguna parte.** El build estaba verde **porque nadie medía**, no porque algo pasara. Documentación presentada como garantía, exactamente.

**Dos trampas de precedencia atrapadas al leer, no al construir:**
- La tabla §8 marca P12 (250 KB) como *"held — this is the number that did not move"*, pero **E6 lo tacha** y E6 es rango 1. Gana la errata: nombre registrado, **sin fila de valor** hasta medir.
- §8.1 dice que mide *"Gate 8"*; **G13 ya lo había corregido** a *"NO VALUE — set by G11"*. La escalera de `CONTEXT.md` era la buena y `CLAUDE.md` cargaba el número viejo. **Corregido en `CLAUDE.md`.**

- ✅ **MEDIDO, y el número desmonta la premisa.** La ruta pipeline carga **108.086 bytes gzip** (105,6 KB) de JS inicial y **2.368 bytes** de CSS — contra los 250 KB disputados. La contradicción "250 KB vs 2,0 s TTI" era real en el papel; **el producto real está al 43% de ese techo.**
- 🎯 **El cálculo determinista se validó contra la realidad antes de confiar en él.** Derivo el JS inicial del grafo de módulos del manifest de Vite; lo crucé con un navegador de verdad en los dos perfiles de Playwright y las cuatro rutas coincidieron **al byte y en cantidad de archivos** (board 105,6 KB/10, earnings 104,2/10, my-day 102,8/9, sign-in 101,4/8). Por eso el gate **no necesita navegador, ni base, ni sesión** — que importa porque `/board` redirige estando fuera, y un chequeo pre-merge que depende de auth es un chequeo que se saltea.
- 🔍 **Un hallazgo colateral: `identity-*.js` pesa 147 KB gzip y NO lo descarga ninguna ruta.** Es infraestructura de servidor de better-auth (kysely, dialectos bun/d1/node-sqlite) emitida al directorio del cliente y jamás referenciada. Hoy cuesta tamaño de deploy, no bytes del vendedor. **Es exactamente la forma de la regresión que P12 existe para atrapar** el día que alguien lo importe desde una ruta de vendedor.
- 🎯 **Los cuatro modos de falla probados por mutación:** presupuesto por debajo de lo medido → `PERF100` con los bytes; valor `null` en el tier aplicado → rojo **nombrando E6**; **lista vaciada** → `PERF005` (vaciar la lista es la forma más barata de aprobar, así que es fallo y no verde); y sin build → `PERF001`. **El checker se niega en vez de saltear**: una métrica que no se puede computar es un fallo, porque un presupuesto silenciosamente no medido pasa para siempre.
- **Los números elegidos y por qué:** P12 = **128.000** bytes (~18% de aire sobre lo medido) y P13 = **16.384**. No es cero aire a propósito: el presupuesto existe para atrapar una **regresión**, no para romper el build la próxima vez que una pantalla gane un componente. Los dos son `monotonic_down` — apretar es libre, aflojar es deliberado.
- ⚠️ **LA PUERTA 11 QUEDA CERRADA A MEDIAS, y el archivo lo dice en lugar de esconderlo.** P20 (TTI móvil) sigue con valor `null` y `tier: nightly`, bloqueado por dos cosas que no existen: el tier nocturno de Lighthouse y el fixture **perf-500** de 500 tarjetas. **La Puerta 12 necesita el mismo fixture**, así que salen más baratas juntas. Un test asegura que la fila P20 **no se puede borrar** para poner el gate en verde y hacer desaparecer la deuda en el mismo commit.
- ⚠️ **Lo que este gate TODAVÍA no es: no está anclado fuera del árbol.** `05c` §10.0.1 especifica `ref.ci_ratchet` en Postgres con rol `crm_ci` (INSERT/SELECT), trigger que rechaza el aflojamiento y `AP002`. **No está construido**, así que hoy aflojar un presupuesto sigue siendo editar un archivo. Es la diferencia entre *"el build se pone rojo"* (que ya es cierto) y *"nadie puede aflojarlo sin una migración"* (que todavía no).
- **`build.manifest: true` en `vite.config.ts`** es lo que hace posible el cálculo; React Router limpia su propio manifest del build de servidor.
- **El costo asumido: `npm run verify` ahora construye.** Son **3,6 s** más por commit, y compra que el gate mida el artefacto que baja un vendedor y no una versión vieja tirada en disco.

#### 🔴 Y de paso cayó el test intermitente que el ítem anterior dejó abierto — era un defecto real
El `verify` de este ítem por fin **capturó el mensaje** que dos corridas anteriores se habían llevado sin dejar: `PostgresError: more than one row returned by a subquery used as an expression`.

**La causa es la regla central de este esquema, evadida por un test.** `auth-identity.test.ts` resolvía el asiento con `SELECT auth_user_id FROM app.app_user WHERE id = ...` — **sin `tenant_id`**. Pero acá **toda tabla tiene PK compuesta `(tenant_id, id)`**, así que `WHERE id = ?` **no es una búsqueda única**: dos tenants pueden tener el mismo `id` legítimamente, y el diseño lo dice. `job-dispatch.test.ts` (del ítem de pg-boss) siembra `OWNER_A` con **exactamente el mismo UUID** que `SEAT_ACTIVE`, bajo otro tenant, y su `afterAll` **sólo cierra la conexión: no borra nada**. Comparten la base `crm_test` de la corrida.

- **La intermitencia era el ORDEN de archivos de vitest, y el defecto era el query.** Cuando `job-dispatch` corría primero, había dos filas con ese `id` y el subquery reventaba. Agregar archivos de test cambió ese orden, que es por qué apareció ahora y no antes. **Latente desde el ítem de pg-boss.**
- 🎯 **Probado reproduciendo la condición en SQL, no por deducción:** dos tenants con el mismo `app_user.id`, el query viejo levanta **el mismo mensaje exacto**, el nuevo pasa. Corregido agregando `tenant_id` a las dos búsquedas.
- **Mi primera hipótesis estaba mal y la medición la mató:** creí que era agotamiento de conexiones; el pico real eran **13 de 100**. Nueve corridas sueltas no lo reprodujeron. **Lo que lo resolvió fue capturar el mensaje, no reintentar** — y eso es exactamente lo que la nota que dejé abierta decía que había que hacer.

### 🧩 SPRINT 1 — La topología plegable deja de ser una declaración (2026-08-02)
`app/entry.server.tsx` (revelado), `app/jobs/boot.ts`, `app/jobs/worker.test.ts`, job `e2e` del CI. **7 tests nuevos.** Total: **129**.

El ítem de pg-boss dejó las dos mitades del pliegue —`npm run worker` para el proceso separado, `workerEnabled()` leyendo `PROCESS_ROLES`— y **nada que arrancara el worker dentro del proceso web**. Jorge exigió que los tres procesos sean *configuración de despliegue, no supuesto arquitectónico*; afirmar que se pliega sin haberlo corrido nunca es exactamente lo que este proyecto llama documentación. Ahora corre.

- **`app/entry.server.tsx` existe por UNA razón** y por lo demás es el default del framework: es el único módulo que el proceso web carga una vez al arrancar, sin importar qué ruta se pida. El arranque va a **scope de módulo, no dentro de `handleRequest`** — el worker es propiedad del PROCESO, y arrancarlo en el primer render ataría *si los recordatorios disparan* a *si alguien abrió una página*.
- **Decisión tomada, no descubierta (Jorge, hoy): sin el esquema de pg-boss el proceso SE NIEGA A ARRANCAR.** Misma postura que G4(a) y por la misma razón: la alternativa no tiene síntoma. Un web que sirve cada página perfectamente y no dispara ninguno de sus recordatorios se ve sano desde todos los ángulos, y **en topología plegada no hay un segundo proceso cuya ausencia alguien note**. Un recordatorio es artefacto legal, no comodidad. Consecuencia asumida y ahora escrita en todos lados: **`npm run db:jobs` es requisito de `npm run dev`.**
- ✅ **PLIEGUE VERIFICADO CORRIENDO, no en test.** Sembré dos jobs vencidos en el tenant demo (−1 min y −40 min) y **el proceso web** los reclamó y escribió las dos filas terminales: `skipped: sms_disabled` y `dropped: 40m late`. Son **exactamente los mismos dos resultados** que el ítem anterior obtuvo con el worker separado. Eso no cierra la Puerta 5, pero es la primera evidencia real de equivalencia plegado/separado que el proyecto tiene.
- ✅ **La negativa verificada por los DOS lados, contra el build de producción.** Con el esquema dropeado y el rol `worker` presente: **exit 1** con el mensaje que nombra `npm run db:jobs`. Con `PROCESS_ROLES=web,ingest` y el mismo esquema ausente: **arranca y sirve**. Un guard que dispara siempre se termina borrando; éste tiene su escotilla documentada y probada.
- ⚠️ **Matiz honesto sobre "se niega a arrancar": el puerto se anuncia ANTES de morir.** `react-router-serve` imprime su URL y el proceso muere a continuación con código 1. Para un deploy es un fallo duro igual, pero no es "nunca escuchó" — y decir lo segundo sería vender más de lo medido.
- 🔴 **Y un hecho que había que medir: EN DEV EL PLIEGUE ES PEREZOSO.** `npm run dev` imprimió *Local: http://localhost:3000* **sin arrancar el worker**; la línea `[worker] folded…` recién apareció tras el primer request, porque Vite carga `entry.server.tsx` bajo demanda. O sea que en desarrollo la garantía es *"muere en el primer request"*, no *"no levanta"*. En producción sí es al boot, verificado arriba. **Lo supuse al revés y la sonda me corrigió.**
- **El arranque exitoso IMPRIME una línea.** Sin ella, un worker plegado que corre y uno que nunca arrancó se ven idénticos en consola — y que el pliegue sea observable es el punto entero de este ítem.
- 🔴 **Filo del CI que esta decisión abría y que ya está cerrado:** el job `e2e` corre `db:migrate` y `db:seed` pero **no** `db:jobs`, y `playwright.config.ts` arranca `npm run dev`. Sin agregar ese paso, **los 25 e2e se habrían puesto rojos en la primera corrida del CI** sobre un servidor que nunca levantó. Agregado con su razón.
- **Sin handler de SIGTERM/SIGINT, y es decisión y no olvido.** Una muerte abrupta a mitad de despacho **ya es un caso cubierto**: `claimed_at` es un lease, y el lease es deliberadamente más corto que los 15 minutos tras los cuales un recordatorio se descarta. Un hook de apagado que el `process.exit` del dev server puede cortar por la mitad sería una segunda vía más débil hacia una garantía que el lease ya sostiene.
- **Guard contra HMR:** el flag de arranque vive en `Symbol.for` sobre `globalThis`, no en scope de módulo. Vite re-evalúa el grafo SSR en cada cambio, así que un flag de módulo se resetea y **cada edición arrancaría una segunda instancia de pg-boss** sosteniendo conexiones contra un pool cuyo techo son 8.
- 🎯 **Los dos tests nuevos probados por mutación.** Sacando la llamada de `entry.server.tsx` → rojo (es la única regresión silenciosa disponible acá: typecheck, lint y todo lo demás quedan verdes mientras la topología vuelve a estar declarada y no cableada). Cambiando el match de rol a `includes` sobre la cadena cruda → rojo con `expected true to be false`, que es el bug clásico: `PROCESS_ROLES=web,workers` arrancaría un despachador que nadie pidió. **Mi primera mutación de ese caso estaba mal planteada y quedó verde; el test no tenía la culpa.**
- **Lo que los tests NO prueban, dicho en voz alta:** que el worker arranque y despache está verificado **corriendo el proceso**, igual que el ítem anterior. La aserción de cableado es sobre el texto fuente y es débil a propósito.
- **Cuatro errores de lint del default del framework, corregidos sin desactivar reglas** (`loadContext` sin usar, dos `let` que son `const`, y un `reject` con `unknown`). Ese último se resolvió preservando la identidad del `Error` real en vez de silenciar la regla.
- ⚠️ **CONSECUENCIA OPERATIVA NUEVA del pliegue: un dev server huérfano ya no es inerte.** Encontré dos procesos node escuchando en :3000 que sobrevivieron a la corrida de Playwright — antes eran inofensivos; **ahora cada uno corre un despachador que tickea cada minuto** contra `crm_dev`. Los maté. **Al terminar de trabajar conviene comprobar que el puerto 3000 quedó libre**, porque un proceso olvidado ahora toca la base sola.
- 🟢 **EL TEST INTERMITENTE: DIAGNOSTICADO Y CORREGIDO** (ver la entrada de la Puerta 11, donde se capturó el mensaje). Era **un defecto real del test, no ruido**: `auth-identity.test.ts` buscaba `WHERE id = ...` **sin `tenant_id`**, y `job-dispatch.test.ts` siembra el **mismo UUID bajo otro tenant** y no borra nada al terminar. La intermitencia era el **orden de archivos** de vitest; el defecto era el query. **Perseguirlo en vez de reintentarlo fue lo correcto.**

### 🎉 SPRINT 1 — La celebración, y la PUERTA 10 CERRADA (2026-08-02)
Migración **0021**, `app/modules/earnings/celebration.ts`, `app/components/board/celebration.tsx`, `app/routes/api/celebrate.ts`, **8 tests de integración + 3 e2e**. Totales: **122** y **25 e2e**.

**Construido sobre el ruling P2 de Fase 5, y una trampa de precedencia atrapada al leerlo.** El texto de mecanismo de P2.1 llama a `app.undo_window()` — **esa función no existe y no debe existir**: la errata E7/NEW-1 la tachó porque un nombre que significa dos duraciones **rechaza en silencio toda celebración en una rama y revela en la otra una venta deshecha en un tablero público**. Las erratas le ganan a Part I. El claim usa `undo_deadline_ms`; el guard de 500 ms es de la proyección pública y nunca de esto.

- **Un solo timer, y es el de la barra de undo.** No hay job de pg-boss, no hay reloj del servidor, no hay segundo cronómetro. Un job encolado en un proceso plegado no sostiene los ±100 ms que pide D3-05, **y un confeti que llega tarde dispara después de que el vendedor siguió con lo suyo, que es peor que no tener confeti**. El único modo de falla posible es *sin* confeti, nunca *tarde*.
- **`app.celebrate_once` son cuatro rechazos en UNA sentencia condicional:** *demasiado pronto* (la ventana sigue abierta — celebrar algo que todavía puede deshacerse), *demasiado tarde* (pasada la gracia de 30 s: "no se repite mañana" es un `WHERE`, no disciplina del cliente), **reversado** (la pesadilla que la Puerta 10 nombra: *toda la oficina viendo confeti por una venta cancelada* — y **la migración 0019 hizo que la reversa NOMBRE la entrada que cancela**, así que es una comprobación exacta y no una adivinanza sobre un total), y *concurrente* (un UPDATE condicional es atómico: dos reclamantes, un ganador, sin lock ni retry).
- **El ancla es el ledger, no una columna `won_at`** — que no existe. La entrada `sale` es la misma fila y el mismo reloj que el tablero público retiene, así que **el confeti y la revelación pública no pueden discrepar sobre cuándo ocurrió la venta.** Desviación anotada, no silenciosa.
- **El token es una CLASE cuyo `toJSON` lanza.** P2.5 pide un tipo no serializable, y un objeto plano produciría `{}` en silencio — que es exactamente cómo un reload tres horas después dispara confeti por una venta que nadie acaba de hacer. Cruza el cable una vez como payload plano y se **envuelve al llegar**; la restricción es sobre *persistirlo*, no sobre transmitirlo. Con test.
- **Un reload dentro de la ventana no repite nada**, y es estructural: `useNavigationType()` responde `Pop` en un documento nuevo. El payload sobrevive al reload porque es loader data; el token no. **Probado por mutación:** sacando ese gate, sólo el test del reload se pone rojo.

🔴 **EL DEFECTO, y sólo se veía en pantalla: la celebración se borraba sola ~200 ms después de aparecer.** El claim va por un `fetcher`, un envío de fetcher **revalida la ruta**, el loader revalidado ya no ofrece celebración para una venta que acaba de registrar, y el confeti se desmontaba. **En pantalla era un flash. El e2e estaba en verde porque miró una sola vez, dentro del flash.** Corregido capturando el token en estado **en el instante en que la ventana cierra**, que además es lo que el ruling quiere decir con *"vive sólo en la memoria de esa página"*: una vez tomado, no depende de lo que el servidor diga después. La aserción que lo habría atrapado ahora existe: **sigue ahí un segundo real después**.

- ✅ **VERIFICADO EN PANTALLA con muestreo cada 200 ms:** barra a los **207 ms** sin celebración → a los **5.212 ms** la barra se va y aparece **"SOLD · $2,399.88 · Beatriz Nuñez"** con 24 piezas de confeti → a los **9.217 ms** se retira. `$199.99 × 12 = $2,399.88` exacto, que es el número que en coma flotante daría `2399.8799999`. Y el claim quedó registrado **5.136 ms después de la venta**: pasada la ventana, dentro de la gracia.
- **También verificado sin querer: "una vez por oportunidad, para siempre".** Mi primera prueba en pantalla no mostró confeti — la tarjeta ya había sido celebrada en una corrida anterior del e2e. Comportamiento correcto, comprobado por accidente.
- **`reduced-motion`: el confeti es MOVIMIENTO y se va; la tarjeta que dice el monto es FEEDBACK y se queda**, con la misma duración que recibe todo el mundo. Ese bloque quita movimiento, nunca feedback.
- 🏁 **PUERTA 10 CERRADA.** Los 5000 ms viven ahora en cuatro representaciones —TypeScript, CSS, el predicado SQL de la proyección pública y el claim de la celebración— y el test de deriva **compara valores, nunca nombres**, incluida la aserción de que `celebrate_once` **no** menciona `projection_reveal_delay_ms`.

#### 🔴 La suite e2e se estaba comiendo a sí misma
**Cada spec movía tarjetas hacia adelante y ninguno las devolvía, y el spec de celebración cierra ventas a propósito.** Cada corrida dejaba el tenant demo con menos tarjetas abiertas que la anterior: tras un puñado, "New Lead" y "Quoted" quedaron vacías, el spec de drag falló con *"the demo needs a card in an open column"* y el de celebración se quedó sin nada que ganar. **La suite tenía un número finito de corridas adentro y nada lo decía.** Es la misma lección que fijar una columna de partida, un nivel más arriba.

- **Cada spec que necesita una tarjeta ahora se la crea y la borra** (`tests/e2e/fixtures/board-data.ts`), así el tenant demo termina cada corrida como empezó. **El ledger y las transiciones se quedan**: son append-only por trigger de sentencia, y un fixture que pudiera borrarlos sería el agujero que todo el diseño cierra.
- ⚠️ **Y un FALSO VERDE encontrado y cerrado: `expectCount(x, 0)` pasa apenas ve cero — y una página que todavía no renderizó también lo cumple.** El test del reload pasaba *antes de que el reload terminara*, y el test móvil del drag habría seguido pasando **si el drag empezara a aparecer en teléfonos**. Ahora el tablero expone `data-drag` con **tres** estados (ausente hasta que el efecto decide, luego `on`/`off`), así que toda aserción de ausencia espera primero un ancla positiva y las del drag son aserciones positivas en los dos sentidos.
- **Otra trampa de `dragTo`:** apunta al **centro** de lo que se le da, y el centro de una columna se mueve con cuántas tarjetas tiene — pocas y se corre al encabezado, muchas y se pasa del pliegue, donde el scroll necesario rompe el drag. Los dos fallos se veían como *"el handler de drop no funciona"*. Ahora se suelta en un **punto fijo** de la zona.
- Suite corrida tres veces seguidas, verde las tres.

### ⏰ SPRINT 1 — pg-boss cableado, y un "claim" que no clameaba nada (2026-08-02)
Migración **0020**, `app/jobs/**`, `app/modules/calendar/dispatch.ts`, `scripts/install-jobs.ts` + `scripts/worker.ts`, **8 tests nuevos**. Total: **114**.

El ítem 6 dejó la capa de dominio completa —intención, idempotencia por episodio, estados terminales, equidad por tenant— y **nada que la consumiera**. Este es el consumidor.

🔴 **EL DEFECTO: `app.scheduled_job_claim` era un SELECT pelado. No tomaba lock y no dejaba marca**, así que dos despachadores en el mismo segundo recibían **las mismas filas y disparaban las dos**. `scheduled_job_resolve` actualiza `WHERE status='pending'`, o sea que la segunda resolución es un no-op inocuo — **el efecto ya ocurrió dos veces para entonces, y el efecto acá es un mensaje al teléfono de un consumidor**. Un recordatorio es un artefacto legal: tiene que disparar una vez, en el instante correcto, dentro de la ventana legal de llamada. **Dos veces no es una versión degradada de esa promesa, es otra promesa.** Invisible hasta hoy por una buena razón: nadie lo llamaba. **Un supuesto de un solo llamador se vuelve bug de concurrencia exactamente cuando aparece el segundo.**

- **Dos mecanismos, y hacen falta los DOS.** `FOR UPDATE SKIP LOCKED` impide que dos claims en vuelo elijan la misma fila; **`claimed_at` sobrevive a la transacción** — sin él el lock termina en cuanto el claim retorna, y el tick siguiente levanta el mismo job antes de que el trabajo se resuelva. 🎯 **Probado por mutación:** con el claim viejo, `expected length 1 but got 2` — el doble disparo, reproducido.
- **El lease es deliberadamente MÁS CORTO que los 15 minutos** tras los cuales un recordatorio se descarta: un reintento entra en la ventana, y un job que sigue fallando llega a su fila `dropped_late` en vez de reintentarse toda la noche. `claimed_at` entró a `protected_columns` — un rol de aplicación que puede limpiarlo puede hacer que un recordatorio dispare dos veces, que es el defecto reintroducido por un `UPDATE` plano.
- 🔴 **Y un problema de diseño que sólo apareció al testear: la equidad entrega UN job POR TENANT POR LLAMADA.** Un tick de una sola llamada sería **un recordatorio por tenant por minuto**, y un tenant con cuarenta vencidos tardaría cuarenta minutos — muy por encima de los quince tras los cuales cada uno se descarta. El tick ahora **drena por rondas**, acotadas. **La equidad sobrevive intacta porque se preserva ENTRE rondas:** el tenant tormentoso sigue sin recibir un segundo job antes de que el tranquilo reciba el primero. El caudal lo dan las rondas; el orden lo da el claim.
- **Las dos reglas con filo legal, como filas terminales y no líneas de log:** más de 15 minutos tarde → **`dropped_late`** con el número en la razón (*"dropped: 40m late"*) — un recordatorio tarde puede caer fuera de la ventana legal, y **uno meramente inútil es mejor resultado que uno ilegal**; y SMS apagado → **`skipped: sms_disabled`**, leído de **`tenant.sms_enabled`** (columna, §10.16) y no del entorno, con test que voltea la fila para probar que la columna decide.
- ⚠️ **`catch {}` que corregí antes de que se quedara.** La primera corrida reportó `1 failed` y nada más — indistinguible de un despachador roto de una forma que nadie puede nombrar. **Ahora imprime la razón**, y eso encontró el bug de inmediato: el driver devuelve `fire_at` como **string**, no `Date`, así que `getTime is not a function`. Compilaba limpio. Ahora se pide como ISO-8601 UTC explícito, no `::text`, cuya salida `new Date` parsea por buena voluntad del motor y no por especificación.

**pg-boss, con un esquema que NO puede modificar.** Instalado por el **migrador en el deploy** (`npm run db:jobs`); el worker corre con **`migrate: false`** y `crm_app` **no tiene CREATE** sobre el esquema. pg-boss migra su propio esquema al arrancar si lo dejás, y **una librería emitiendo DDL contra producción bajo la credencial de la aplicación es el cambio que nadie vería**. Medido antes de confiar: **en pg-boss 12 una cola es no particionada por default**, así que nada de lo que hace en runtime necesita crear un objeto — verificado con `has_schema_privilege` y `prosecdef`.

- ✅ **La exención de esquema es load-bearing, y lo probé volteándola:** sin la fila en `security.schema_policy`, `harden()` levanta **`HR001: relation pgboss.version has no security.table_registry row`** y el deploy muere. `managed_relations()` escanea **todo** esquema. Eso es el gate funcionando; por eso la exención está escrita con su razón en la migración y no descubierta en un deploy rojo.
- **La puerta del claim es una FUNCIÓN, no una tercera puerta.** La forma obvia sería `withoutTenantContext(fn)` y sería *segura* —sin contexto toda política evalúa contra NULL y devuelve cero filas, que la suite del silo ya asserta—, pero sería **una escotilla de propósito general en el único módulo que existe para que no haya una**. `claimDueJobs()` corre una sentencia y devuelve filas; no hay nada que pasarle.
- ⚠️ **Declarado y NO cableado: la topología plegada.** `npm run worker` corre el proceso separado y `workerEnabled()` lee `PROCESS_ROLES`, pero **el worker todavía NO arranca dentro del proceso web**. Afirmar que es plegable sin haberlo cableado sería exactamente el fallo de "documentación, no mecanismo". Lo que sí es cierto hoy: nada del despachador sabe en cuál de los dos está.
- **Verificado corriendo el proceso de verdad**, no sólo en test: dos jobs sembrados, uno a −1 min y otro a −40, y el worker resolvió `skipped: sms_disabled` y `dropped: 40m late`.
- ⚠️ **Y un test flaky mío, atrapado por el hook de pre-commit y corregido, no reintentado.** El test del undo del ítem anterior usaba un hueco de 1,1 s contra una ventana de 900 ms, así que la segunda aserción necesitaba que la reversa siguiera siendo joven **después de dos round trips más** — falló una vez bajo la carga del `verify` completo, por una razón que no tenía nada que ver con el ledger. Ahora el hueco es 2,5 s contra 2,0 s, y **el fixture se assertea a sí mismo antes de assertear el producto**: lee las edades de las dos filas y exige venta > ventana > reversa. **Una máquina lenta ahora reporta un defecto de cronómetro con ese nombre, en vez de un defecto de ledger que no existe.** *Un test de dinero flaky es un test de dinero que falla.* Cuatro corridas completas seguidas, verde las cuatro.
- ⚠️ **Trampa de sintaxis anotada:** un comentario SQL con backticks dentro de un template literal **cierra el literal**. `-- epoch, never \`milliseconds\`` rompió el parseo del archivo entero.

### 🖱️ SPRINT 1 — El drag, y una transición CSS que impedía que un color existiera (2026-08-02)
`app/components/board/pipeline-columns.tsx`, `board.tsx` refactorizado, `tests/e2e/drag.spec.ts`. **22 tests e2e**; 106 de unit/integración sin cambios.

**El drag es ADITIVO y ese orden es el diseño (G12).** La move-sheet se construyó primero y es el camino universal —móvil, teclado, tecnologías de asistencia—, así que **nada de esto es la única forma de hacer nada**: si el drag se rompe, el producto sigue funcionando y el fallo queda confinado a una superficie en una clase de dispositivo. Cada test del drag comprueba además que la move-sheet sigue ahí.

- **Se arma con `>=BREAKPOINTS.lg` Y `pointer: fine`, juntas.** Sólo ancho lo encendería en una tablet grande, donde un drag compite con el gesto de scroll y **un vendedor pierde una tarjeta intentando desplazar el tablero**. El número sale del módulo de tokens; dos breakpoints hardcodeados en el árbol rompen el build.
- **Un drop sobre una etapa con gate ABRE LA MOVE-SHEET, no falla.** Un drop no puede llevar el valor del deal ni el motivo de pérdida, y la base rechaza el movimiento sin ellos. **No es un fallback tras un rechazo: es el gate apareciendo donde aplica, antes de que al vendedor le digan que no.**
- 🔴 **`moved_via` estaba mintiendo, y ahora se ve.** La acción escribía `'move_sheet'` fijo en TODA transición. Ahora se elige de una **lista cerrada** —nunca se pasa el valor del formulario—, porque el enum tiene siete etiquetas incluidas `automation` y `api`, y **un POST a mano no puede archivar el drag de un vendedor como algo que hizo una máquina**. Verificado en la base: `kanban_drag` para el drag, `move_sheet` para la sheet.
- **El error del drop llega por el `fetcher`, no por `actionData`** — canal distinto, misma exigencia. Leer sólo `actionData` habría puesto la corrección en pantalla **sin explicación**, que es exactamente el fallo de corrección silenciosa que `CLAUDE.md` prohíbe.
- **La colocación optimista NO mueve los totales de columna, a propósito.** Moverlos sería el cliente sumando y restando centavos, cosa que no hace nunca. Durante las decenas de milisegundos intermedias la tarjeta se movió y los totales no; la tarjeta se dibuja al 55% de opacidad justo por eso. **Un tablero brevemente honesto sobre estar en vuelo le gana a uno brevemente equivocado sobre dinero.**

🔴 **EL DEFECTO DEL ÍTEM: `transition: background …` impedía que el color de destino APLICARA, para siempre.** El estilo inline decía `var(--color-selected-bg)` y el `backgroundColor` computado se quedaba en el valor viejo **los 500 ms completos que lo muestreé**. Chromium no interpola entre dos custom properties y el resultado no fue "sin animación": fue **el color nuevo no llegando nunca**. La columna de destino se veía inerte mientras el código decía que estaba resaltada.

Lo instructivo: **el anillo sí se dibujaba** (misma condición, otra propiedad), así que al lado de un resalte que funcionaba el tinte faltante era invisible — **ninguna captura de pantalla lo habría mostrado**. Encontrado leyendo estilo computado en el tiempo. Convertido en test: la aserción es sobre `getComputedStyle`, no sobre el atributo.

- **La otra mitad de la condición no la alcanzaba ningún perfil.** `mobile-ci` es un Pixel 7 a 412 px, o sea **excluido por ANCHO antes de que se consulte el puntero** — se podía borrar la cláusula `pointer: fine` y los dos perfiles seguían verdes. Agregado un caso con `test.use({ viewport: 1366, hasTouch, isMobile })`: ancho suficiente, puntero grueso. **Es el caso para el que la cláusula se escribió.**
- 🎯 **Las dos condiciones probadas por mutación:** sacando `pointer: fine` → rojo (8 tarjetas arrastrables donde debía haber 0); haciendo que un drop sobre etapa earning se envíe directo → rojo (la sheet no aparece).
- ⚠️ **No verificado y anotado como tal:** la **re-evaluación en vivo** al cruzar el borde de 1024 px. La emulación de viewport por CDP **no dispara `resize` ni el `change` de `matchMedia`** —lo comprobé con listeners propios, cero disparos—, así que en este entorno sólo es observable la evaluación inicial, que sí está verificada de los dos lados. El listener es estándar; **no lo estoy afirmando probado**.
- **Tres fragilidades de test cerradas, todas del mismo origen —una suite que comparte un tenant demo—:** el drag se arma en un efecto, así que hay que **esperar a que exista una tarjeta arrastrable** antes de arrastrarla (si no, `dragTo` es un no-op que falla mucho después y en otro lado); **qué columna abierta tiene tarjetas se DESCUBRE**, no se asume (fijar "New Lead" es fijarle fecha de vencimiento al test); y **el drop va sobre la zona, no sobre la `section`** — `dragTo` apunta al centro, y el centro de una sección se corre al encabezado cuando la columna queda corta. Suite corrida tres veces seguidas, verde las tres.

### ♿ SPRINT 1 — axe-core bajo `test:e2e`: el gate de WCAG deja de ser una declaración (2026-08-02)
`tests/e2e/a11y.spec.ts` + `undo-window.spec.ts` + `fixtures/`, `playwright.config.ts`, job `e2e` en CI. **16 tests e2e** (8 casos × dos perfiles) sobre los **106** de unit/integración.

**`test:e2e` era un script de `package.json` sin un solo test detrás.** WCAG 2.1 AA con cero hallazgos serios o críticos está declarado como gate en `CLAUDE.md`; hasta hoy estaba declarado y nada más. **Un gate que nadie puede ver ponerse rojo es documentación.**

- **Seis superficies escaneadas, en los dos perfiles:** sign-in (fuera de sesión), My Day, el tablero, **la move-sheet** (que es el camino universal, así que tiene que ser alcanzable en móvil antes que en escritorio), el leaderboard público y **la barra de undo**.
- **Acotado a `serious` y `critical` a propósito.** Los buckets `minor`/`moderate` de axe traen reglas consultivas que una pantalla puede incumplir siendo perfectamente usable; meterlos hace el número ruidoso, y **a un gate ruidoso se le sube el umbral**. Los dos que quedan son los que significan que un vendedor con lector de pantalla o con teclado no puede hacer la cosa.
- 🎯 **Verde a la primera es sospechoso, así que lo muté.** Puse `--color-text-link-inverse` en el valor que ya había medido como reprobado (2,03:1) y el gate se puso **rojo con `color-contrast`, nombrando el elemento**. Revertido.
- 🔴 **Flakiness estructural encontrada y cerrada: todos los tests entran al MISMO tenant demo y varios mueven una tarjeta.** Con workers en paralelo —y los dos perfiles corren concurrentes— se pisan el tablero: un test movió la tarjeta cuya move-sheet otro acababa de abrir, y el segundo recibió el rechazo en vez de la barra. **`fullyParallel: false`, `workers: 1`**, con la razón escrita. Un tenant por test compraría el paralelismo de vuelta; no vale la pena todavía, y **un gate de accesibilidad flaky es un gate que se borra en vez de arreglarse**.
- ⚠️ **TRAMPA DE HERRAMIENTA QUE COSTÓ UNA PASADA Y QUEDA ANOTADA: con `page.clock.install()`, el auto-wait de Playwright deja de reintentar.** `expect(locator).toBeVisible()` y `waitForSelector` **hacen su poll DENTRO de la página**, así que un reloj congelado convierte una aserción de cinco segundos en **una sola comprobación** tomada en el instante en que el click retorna — antes de que aterrice un submit de React Router. Lo que lo volvió difícil de ver: **la misma aserción PASABA en el otro spec**, porque ahí el click ocurría antes de la hidratación y el form se enviaba nativamente (navegación completa, que `click()` sí espera). Dos tests, el mismo código, resultados opuestos, decididos por el timing de hidratación. Cerrado con `tests/e2e/fixtures/clock.ts`: todo espera con **`expect.poll`, que corre desde Node**.
- **El reloj falso tampoco está perfectamente congelado.** Medido: **filtra ~5 ms de tiempo real por round trip de protocolo**, así que `fastForward(4999)` aterriza *pasados* los 5000 y la barra ya no está. Mi primera versión afirmaba el límite al milisegundo y **fallaba por eso, no por el producto**. Ahora es un **corchete verificado** —se comprueba con `Date.now()` de la página que realmente falta para el plazo— y el comentario dice qué precisión da la herramienta. **El número exacto lo fija el test de deriva; este prueba que la barra en pantalla gasta ese número.**
- 🎯 **Probado por mutación también:** con la barra a 30 s, rojo.
- **CI: job `e2e` propio**, con su Postgres, `db:migrate`, `db:seed` y **sólo chromium** (los dos perfiles son Chromium — Desktop Chrome y Pixel 7 — así que bajar firefox y webkit triplica la descarga por cero cobertura). Job separado para que una regresión de accesibilidad y un test unitario roto sean **dos luces rojas distintas**. Sube el reporte de Playwright como artefacto sólo si falla.
- **Los movimientos de los tests son siempre entre etapas ABIERTAS, y está aserido** (`input[name="premium"]` con count 0), no supuesto. Una suite que corre en cada push **no puede apendear al ledger**: es append-only y sin job de recomputo, así que un test que acredita dinero lo deja acreditado.

### ↩️ SPRINT 1 — El undo de 5 s, y el defecto que sólo aparece cuando el undo existe (2026-08-02)
Migración **0019**, `app/components/board/undo-bar.tsx`, `app/routes/ui/board.tsx`, **5 tests nuevos**. Total: **106**.

🔴 **EL HALLAZGO DEL ÍTEM: `leaderboard_read` publicaba una venta ya deshecha, durante ~3 segundos, en el tablero público.** Retener las entradas más jóvenes que `projection_reveal_delay_ms` convierte al tablero en una **reproducción diferida** del ledger. Eso es correcto para una corrección y **exactamente equivocado para un undo**, porque un undo son DOS filas y el retardo se mide sobre cada una por separado:

| t | Evento | Proyección | Público |
|---|---|---|---|
| 0,0 s | venta +$2.220 | $2.220 | $0 (retenida) |
| 3,0 s | reversa −$2.220 | $0 | $0 (las dos retenidas) |
| 5,5 s | la **venta** envejece y sale de la ventana | $0 | **$2.220 ← MAL** |
| 8,5 s | la reversa envejece | $0 | $0 |

Tres segundos mostrando una venta que el vendedor ya canceló, y después retirándola. **Es el fallo que la regla R1.3 existe para hacer imposible.** Vivía desde el ítem 3 y era estrecho porque la única forma de producir una reversa era arrastrar una tarjeta fuera de una etapa earning; **el día que `Undo` es un botón en cada venta, pasa a ser el caso normal**.

**La regla, escrita una sola vez:** *una reversa registrada dentro de `undo_deadline_ms` de la entrada que revierte es un UNDO, y ninguna de las dos mitades se publica jamás.* Registrada más tarde es una **corrección** ordinaria y conserva el retardo ordinario. Los dos intervalos hacen trabajos distintos y por primera vez aparecen juntos: el **reveal** decide *cuándo* una entrada se hace pública; el **undo deadline** decide *si el par es un undo*.

- **`reverses_entry_id` dejó de ser decorativo.** `stage_move` le pasaba `NULL` — un campo que documentaba una intención que nada usaba. Ahora la reversa **nombra** el crédito que cancela, con `CHECK` que rechaza una reversa sin objetivo, FK compuesta (una reversa hacia otro tenant no se rechaza: es inescribible) y **único parcial** para que no haya dos reversas de la misma entrada.
- **`SM005`:** salir de una etapa earning sin crédito sin revertir detrás ahora **levanta**, en vez de escribir un delta negativo que empujaría el total público bajo cero sin job de recomputo que lo note.
- 🎯 **Probado por mutación y con el número del síntoma.** Saqué las dos cláusulas del predicado y el test se puso rojo con `expected 88800n to be 0n` — la venta cancelada, publicada. Revertido.
- ✅ **VERIFICADO EN PANTALLA, que es lo que decide.** Venta de **$9.000** deshecha a los **3.102 ms** medidos en el ledger, con el tablero público muestreado **57 veces en 11,4 segundos**: **un solo valor distinto**, $11.429,88. La banda 5,0–10,5 s —donde el predicado viejo habría mostrado $20.429,88— quedó plana. Un primer intento con un undo de 92 ms **no probaba nada** y lo repetí: con esa separación el defecto viejo dura 92 ms y el muestreo lo habría pasado por alto.
- **El undo NO es un camino privilegiado.** Es un POST al mismo `stage_move` con el mismo gate; no borra nada, apendea una reversa. **Quién publica el par lo decide la distancia entre las dos filas del ledger, no qué botón se apretó** — así que un vendedor que arrastra la tarjeta de vuelta a mano dentro de la ventana queda protegido igual. Eso es lo que lo hace mecanismo y no característica de un botón.
- **Un error refutado por medirlo.** Escribí que el riel de cuenta atrás sobrevivía a `prefers-reduced-motion`; el bloque pone `animation-duration: 1ms !important` sobre `*`. Le puse exención explícita a `.undo-window-rail` **con su razón** (un riel colapsado a 1 ms informa que el plazo se agotó con 4,5 s por delante: eso es quitar *feedback*, que es justo lo que ese bloque dice no hacer). **Mi primera sonda fue inválida** —midió con el `@media` inactivo— y la rehíce aislando la especificidad: **riel 5 s, todo lo demás 1 ms**.
- **El error del undo tiene dónde verse.** Un movimiento rechazado fuera de la move-sheet no tenía superficie: la tarjeta volvía sola y en silencio. Ahora hay `role="alert"` a nivel de pantalla, verificado con un `SM404` real → *"That card is no longer where it was. Nothing changed."* — nunca "no podés", que confirmaría que el registro existe.
- ✅ **Puerta 10 casi cerrada: existe el test de deriva.** Compara **valores, nunca nombres** (E7/NEW-1 registra que un test que compara nombres sigue verde a través del fallo exacto que fue escrito para atrapar) entre **TypeScript, CSS y SQL**, más la relación `reveal = undo + guard` en vez del literal 5500. Falta la cuarta representación, el scheduler de la celebración, que todavía no existe.
- ⏳ **Observado y NO corregido:** una tarjeta que vuelve de Closed Won conserva su prima, así que **columnas abiertas ahora muestran total** ("New Lead $9,000"). Es valor de pipeline y el color lo distingue del de earnings, pero comparten ranura visual. Decisión de tablero, de Jorge.

#### 🌱 Tres defectos del seed, encontrados al intentar verificar en pantalla
Ninguno tiene que ver con el undo; los tres bloqueaban verificarlo, y los tres se descubren **corriendo el procedimiento que el propio `CONTEXT.md` manda correr al retomar una sesión**.

1. 🔴 **`npm run db:seed` sobre una base ya sembrada DUPLICABA el tenant demo.** Tenant, usuarios y pipeline tenían `ON CONFLICT DO NOTHING`; etapas, contactos y oportunidades no. El tablero volvió con **cada columna y cada tarjeta dos veces** — y, invisible ahí, **cada duplicado pasó por `stage_move`, así que se apendeó un segundo juego completo de entradas y el total PÚBLICO de cada vendedor se duplicó**. Es el tenant que se muestra en un demo comercial. **No hay limpieza posible y eso es el diseño:** `earnings_ledger` rechaza UPDATE, DELETE y TRUNCATE por trigger de sentencia, al dueño y al superusuario, no sólo a `crm_app`. **El único reset de un ledger es una base nueva**, y eso es lo que el script ahora dice al negarse.
2. **El comando que ese mensaje imprimía no funcionaba.** `db:down` deja el volumen nombrado en su lugar, así que el cluster vuelve con todas las filas y el mensaje se imprime otra vez. Agregado **`npm run db:reset`** (`down -v`). *Un consejo que no funciona es peor que ninguno.*
3. 🔴 **El seed no podía correr contra una base genuinamente nueva.** `auth` era import estático, y el adaptador drizzle de better-auth abre su pool **como `crm_app` al cargar el módulo** — o sea antes de la línea que fija la contraseña. Murió con `password authentication failed for user "crm_app"`. El archivo ya tenía comentado ese mismo peligro para `~/db` y lo resolvía con import dinámico; **`auth` tenía el peligro idéntico y se pasó por alto**. Invisible desde la migración 0018 porque toda corrida cayó sobre una base que ya tenía contraseña. **Un camino que nunca se ejecutó no es infraestructura verificada.**

- ⏳ **Observado y no corregido:** el seed no crea ni un `lost_reason`, así que en el demo el selector "Why?" de Closed Lost está vacío y **la columna Closed Lost es inusable**. Candidato directo a las aserciones `DEMO-01..10` pendientes.

### 🔒 CI + G4(a): la app se niega a arrancar si puede saltear el silo (2026-08-02)
`.github/workflows/verify.yml`, migración **0018**, `app/db/boot-assert.ts`, **3 tests nuevos**. Total: **101**.

**CI existe por fin.** Hasta ahora `npm run verify` corría **sólo en la máquina de Jorge**, por el hook de pre-commit. La regla fundacional del proyecto dice que una garantía es un mecanismo o no es nada — y *"el build se pone rojo"* no era cierto en ningún lugar que una segunda persona pudiera ver. Eso convertía cada gate del repositorio en folklore local. El control de costo sigue siendo **la ausencia de método de pago** (§9.4.1): agotar la cuota es un apagón, no una factura. `concurrency` con `cancel-in-progress` para que una cola de corridas obsoletas no se coma el presupuesto sin que nadie lo decida.

🔴 **G4(a) CERRADO, y su primer acto fue atrapar una configuración rota que estuvo viva ocho ítems.** La app ahora **se niega a arrancar** si el usuario de conexión es superusuario, tiene `BYPASSRLS`, o es dueño del esquema `app`/`ref`. Al correrla por primera vez **falló inmediatamente**: `DATABASE_URL` no estaba seteada y el default del pool era `crm:crm` — el superusuario que entrega `docker compose`. **El silo se sostenía sólo porque `withTenant` se acordaba de hacer `SET LOCAL ROLE`, nunca por quién estaba conectado.**

- **Ahora hay DOS roles en TODOS los entornos**, incluido desarrollo. `crm_app` recibió `LOGIN` (migración 0018) y es quien conecta la aplicación; `crm_migrator`/dueño es sólo para migraciones y seed. **Un default equivocado en desarrollo no es un problema de desarrollo: es la configuración que todos copian.**
- **La contraseña de `crm_app` NO va en la migración**, deliberadamente: una credencial en una migración es una credencial en el repositorio, en la imagen y en cada clon. Se fija fuera de banda — `db:seed` en local, la consola del proveedor en producción. Misma forma que exige la errata E1b para el token de DDL.
- **Los tests ahora corren bajo el conjunto de privilegios de producción**: `vitest` apunta `DATABASE_URL` al rol `crm_app`, así que `withTenant` deja de ser un superusuario fingiendo estar scopeado. Los 98 tests previos siguen pasando, lo que es evidencia de que las políticas alcanzan de verdad.
- **El guard se prueba por los dos lados** — rechaza la credencial de dueño nombrando cada razón, y acepta la de aplicación. Uno solo pasaría por la razón equivocada: un guard que nunca dispara no prueba nada, y uno que siempre dispara se termina borrando.
- **Deriva corregida:** `.env.example` decía `SMS_ENABLED=false` como variable de entorno. §10.16 la hace **columna en `tenant`** y prohíbe `process.env.SMS*` en todo el árbol. Era exactamente el tipo de línea vieja desde la que alguien implementa.

### ✨ SPRINT 1 — Pulido de las tres superficies (2026-08-02)
- ✅ **El gate WCAG de foco visible SE CUMPLE.** Primero reporté que no había anillo de foco en ninguna parte; **estaba equivocado**. Mis tabulaciones sintéticas nunca entraban al documento (`activeElement` era `BODY`). Con el foco realmente dentro, `:focus-visible` del reset dibuja su outline de 2px. **Lección: verificar que la herramienta hizo lo que creo antes de reportar un defecto.**
- **Filas del leaderboard con superficie propia.** Antes sólo la fila del propio vendedor tenía fondo, así que las de abajo del podio flotaban en blanco y se leían sin terminar al lado.
- **El total de columna del kanban pasó abajo del nombre.** Empujado a la derecha aterrizaba contra el encabezado de la columna siguiente, y dos columnas se leían como una sola línea corrida.
- **Podio alineado a una línea base.** Dimensionar la barra no alcanzaba: con alturas distintas, las etiquetas de arriba se escalonan. Hizo falta un pozo de altura fija con la barra apoyada abajo, así los tres ítems miden lo mismo y nombres y montos caen en una sola línea. **Un podio existe para leerse como grupo; escalonado no cumple su única función.**

### 📋 SPRINT 1 — El pipeline kanban, y el camino del dinero VISIBLE (2026-08-02)
`app/routes/api/board.ts`, `app/routes/ui/board.tsx`, seed con tarjetas abiertas.

✅ **CAMINO DEL DINERO PROBADO DE PUNTA A PUNTA EN PANTALLA.** Moví "Ruth Alvarez" a Closed Won con **$185 mensuales** y observé, en una sola acción de UI: la move-sheet pidió el valor **porque el escenario es de tipo `earning`** (no por su nombre) → `×12` anualizado **en el servidor** en centavos enteros → `stage_move` escribió transición y ledger **en una transacción** → la proyección se mantuvo → **la columna pasó de $9,029.88 a $11,249.88** → y el **tablero público** mostró a Renata en **$11,249.88** después de la ventana de undo. `$185 × 12 = $2,220`, exacto.

- **La move-sheet se construyó PRIMERO, como manda G12**, y es server-rendered: funciona sin JavaScript, es alcanzable por teclado y por tecnologías de asistencia. **El drag se ata después y sólo a ≥1024px con puntero fino** — así, si el drag falla, el producto sigue funcionando y el fallo queda confinado a una superficie.
- **El gate se ve donde ocurre:** "Closed Won" muestra valor + unidad (**sin default preseleccionado** — una unidad sin elegir es cómo una prima mensual se convierte en anual en silencio); "Closed Lost" muestra motivo.
- El `action` sólo traduce la excepción de la base a copy accionable. **No puede dejar pasar un movimiento malo ni queriendo**, porque el gate vive en el `CHECK`.
- Los totales por columna los **suma la base**; el cliente nunca suma dinero.
- El seed incluye a propósito tarjetas **sin valor**: un tablero donde todas las tarjetas ya están calificadas demuestra el gate no disparando nunca.
- ⚠️ **Tensión de precedencia sin resolver, anotada y no tapada:** `CLAUDE.md` dice *"exactamente UNA ruta de `routes/ui/**` puede servir datos de tablero como HTML SSR"*. Hoy el leaderboard **y** el kanban tienen loader. El kanban es el que carga el presupuesto de LCP con 500 leads, así que probablemente sea él quien deba quedarse con el slot. **Requiere pasar `precedence-checker` antes de decidir.**
- ⏳ Debido: drag ≥1024px, undo optimista de 5 s, y el encabezado de columna aprieta el total contra la columna siguiente.

### 🧭 SPRINT 1 — El shell de navegación (2026-08-02)
`app/routes/ui/shell.tsx` como layout, `app/routes/api/sign-out.ts`, `/` ahora redirige.

Tres pantallas sin forma de ir de una a otra son tres prototipos, no un producto. El shell trae **encabezado con las pantallas, quién sos, el rol si no sos vendedor, y salir**. La redirección de no-autenticado vive **en el layout, una sola vez**, en vez de repetida por pantalla.

🔴 **Un bug que sólo aparece haciendo clic: el sign out daba 405 Method Not Allowed.** Un `<Form method="post">` **sin `action`** postea a la **ruta activa**, y un layout **no tiene path propio** — así que el request resolvió a `/`, que tiene loader y no action. Corregido con una ruta dedicada `/sign-out`, que además es la forma más honesta: terminar una sesión es una operación, no una propiedad del marco donde viven las pantallas.

**Verificado de punta a punta:** entrar → navegar entre My Day y Earnings con el shell persistente → salir → y confirmar que `/my-day` y `/earnings` **redirigen a `/sign-in`** estando fuera.

- **Lección de método:** los primeros dos clics en "Sign out" fallaron porque el dev server todavía no había recogido la ruta nueva. **Casi lo diagnostico como un bug de código.** Mirar la red antes de teorizar fue lo que lo separó.
- `/` dejó de ser la pantalla de fundación de la Fase 6 y ahora redirige a **My Day** si hay sesión, a `/sign-in` si no. Los tokens que esa pantalla existía para probar ahora los cargan pantallas que un vendedor usa de verdad, que es una prueba más fuerte.

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

> ⚠️ **Esta sección se reescribió el 2026-08-02.** La versión anterior listaba los diez ítems del Sprint 1 como si ninguno estuviera hecho, mientras el detalle de arriba decía lo contrario. Una sesión nueva habría leído el plan viejo — el fallo exacto contra el que advierte la cadena de precedencia.

### 🟢 SPRINT 1 — estado real

| # | Historia | Estado |
|---|---|---|
| 1 | Fundaciones de datos + arnés de RLS | ✅ `harden()` genera políticas; 12 tests |
| 2 | Auth, sesión y contexto de scope | ✅ `begin_request` + better-auth |
| 3 | Espina dorsal del dinero | ✅ ledger, `ledger_append`, `annualize`, `leaderboard_read` |
| 4 | Contactos + dedupe | ✅ fixture de colisión con canario a nivel de bytes |
| 5 | Pipeline + ambos gates | ✅ gates como CHECK; `stage_move` atómico |
| 6 | Calendario + recordatorios | ✅ dominio **y** despachador: pg-boss cableado, claim con lease, 15-min drop y SMS-dark |
| 7 | Leaderboard público | ✅ tablero, undo honrado **y celebración** |
| 8 | My Day | ✅ |
| 9 | Aloware | 🔴 **bloqueado por la Puerta 2** — necesita la cuenta real. (Decía "Puerta 11", que es la del bundle y el primer paint; se cerró el 2026-08-03 y Aloware sigue bloqueado, que es como se notó el error) |
| 10 | Datos demo | 🟡 siembra por el camino real, se niega a duplicarse, `lost_reason` sembrados, **y desde el 2026-08-03 ABARCA LOS CUATRO PERÍODOS con una reversa** — las dos exigencias de §1529 que el registro nunca había anotado como faltantes. `DEMO-01..10` sigue siendo un registro verificado por máquina: **3 cubiertos, 4 bloqueados por Aloware/búsqueda, 3 parciales**, y los tres parciales encogieron |

**Extra, no planificado:** shell de navegación, CI en GitHub Actions, aserción de arranque G4(a), **undo de 5 s**, **el test de deriva de la Puerta 10**, **el gate de axe-core con su job de CI**, **el drag de escritorio**, **el despachador de jobs** y **la celebración**.

### 🔴 SPRINT 0 — estado real de la escalera

| # | Puerta | Estado |
|---|---|---|
| 0 | Región EE.UU. en el plan a contratar | ✅ **APROBADO** — Ohio y Virginia en los tres tipos de recurso, workspace Hobby |
| 1 | Sonda de plataforma | 🟡 **G1e cerrado** (`btree_gin`/uuid existe, probado con planner). Faltan `max_connections` real, PgBouncer en modo transacción, y si concede `CREATE EVENT TRIGGER` — **todo requiere la instancia de Render** |
| 2 | Aloware contra la cuenta real | 🔴 bloqueado, es de Jorge |
| 3 | Camino del dinero | ✅ mayormente — append-only por trigger de sentencia (incluye TRUNCATE), exactly-once, transacción del gate atómica. **Falta:** proceso muerto a mitad del gate sin dejar lock |
| 4 | Silo de punta a punta | 🟡 **(a) cerrado** (se niega a arrancar si el usuario puede saltear RLS). El resto lo cubre la suite de silo salvo el contexto heredado entre job y request en la misma conexión pooleada |
| 5 | Equivalencia plegado/separado | 🟡 **el pliegue EXISTE y corrió.** El worker arranca dentro del proceso web (`app/jobs/boot.ts`) y produjo **las mismas dos filas terminales** que el proceso separado — `skipped: sms_disabled` y `dropped: 40m late`. Falta lo que da nombre a la puerta: equivalencia **bajo carga y en los bordes**, no en un caso feliz |
| 6 | Tormenta de 20.000 webhooks | ⬜ no empezado |
| 7 | SSE detrás del proxy | ⬜ no empezado |
| 8 | pg-boss bajo estrés de versión | ⬜ no empezado |
| 9 | Simulacro de restauración | ⬜ no empezado |
| 10 | Los 5000 ms en cuatro representaciones | ✅ **CERRADA.** Las cuatro existen —TS · CSS · predicado SQL de la proyección · claim de la celebración— y el test de deriva compara **valores, nunca nombres**, incluida la aserción de que `celebrate_once` no menciona `projection_reveal_delay_ms` |
| 11 | Bundle y primer paint medidos | ✅ **CERRADA (2026-08-03).** Bundle **medido y aplicado**: P12 = 111.068 bytes gzip contra 128.000, P13 = 2.462 contra 16.384, vía `npm run perf` dentro de `verify`. **TTI medido y aplicado**: P20 = 2.251 ms medidos, presupuesto 2.300, techo 3.000, por `tests/e2e/tti.spec.ts` en el perfil `lh-ci` — el tier nocturno se **descartó**, no se pospuso. **El ancla fuera del árbol está cableada:** el checker lee `ref.ci_ratchet` y falla con `PERF006` si el archivo y el motor discrepan, y con `PERF007` si un presupuesto nombra un tier que nadie corre. **Lo único que falta es que el CRUCE corra en el CI**, que necesita `crm_ci` con LOGIN y contraseña fuera de banda (de Jorge). Hoy corre en el hook de pre-commit |
| 12 | Drag a 60 fps con 500 tarjetas | ✅ **CERRADA.** Perfil `dnd-ci` (2× CPU throttle) sobre `perf-500`, **contra el BUILD DE PRODUCCIÓN**: **p95 16,8 ms · max 16,8 ms (cero frames perdidos) · cero long tasks**, contra p95≤20 / frame≤34 / longtask≤50. El fixture se assertea antes de medir, y el gate está probado con dientes (bloqueo de 60 ms → las tres aserciones rojas) |
| 13 | Publicar las contradicciones | ✅ `docs/sprint-0/g13-published-contradictions.md` |

### ▶️ LO SIGUIENTE — sesión del 2026-08-03, cierre

**`master` = `origin/master` + commits locales sin empujar. 243 tests · 83 e2e · árbol limpio · demo sembrado.** Los puntos 1, 2, 3, 4 y 6 de la lista anterior están cerrados, y también el riel de salud que abría esta lista (ver las entradas del 2026-08-03 arriba).

**Lo que NO depende de nadie — por acá seguir, en este orden:**

1. **El reloj `NEW` que tictaquea** — intentado, medido y **rechazado por P6 dos veces** (ver la entrada de arriba con la tabla). Tictaqueando todo: 116,7 ms / 84 ms. Acotado a lo visible: 50,0 ms / 53,0 ms. Presupuesto: 34 / 50. **No vuelve a intentarse sin virtualización del tablero o sin escribir ese texto en el DOM fuera de React** — y con virtualización el problema se disuelve solo, porque dejan de existir 500 nodos.
2. ~~**P20 (TTI móvil)**~~ — **HECHO (2026-08-03), y la Puerta 11 está CERRADA.** 2251 ms medidos, presupuesto 2300, en el perfil `lh-ci` dentro de la suite e2e. **El tier nocturno no se construyó: se descartó** — con el control de costo siendo la ausencia de método de pago, un job programado es un gate que se apaga. Lo que queda abierto de este tema es el punto 3, que es de Jorge.
3. **Cerrar el cruce del ratchet en el CI.** El checker ya lee `ref.ci_ratchet` y **falla con `PERF006`** cuando el archivo y el motor discrepan — probado por mutación. Falta sólo lo que no puedo hacer yo: darle a `crm_ci` LOGIN y contraseña **fuera de banda** y poner la cadena como secreto `CI_RATCHET_DATABASE_URL`. Hasta entonces el CI imprime el cuadro de "el cruce no corrió".
4. ~~**El presupuesto de la búsqueda como GATE**~~ — **CERRADA LA MITAD DEL SERVIDOR (2026-08-03):** N13 mide 59,7 ms p95 sobre 25.000 contactos y está en el ratchet. La sospecha del `ILIKE` sin índice trigram **era falsa** — el índice existía desde la 0011 y la consulta no podía usarlo. **Lo que queda es la mitad PERCIBIDA**, que necesita el mismo tier nocturno que P20 (punto 2) y por eso deja de ser una tarea aparte.
5. ~~**`Quick-add this number`**~~ — **HECHO (2026-08-03).** Es un control, con el número precargado, y el duplicado lo rechaza el índice UNIQUE de la 0010 en vez de una consulta previa. Faltan dos de los cuatro campos de §4.11 y `Save & call`, los tres por falta de columna o de la puerta de Aloware — anotado arriba y en `contracts/protected-list.json`.
6. **La franja de actividad de hoy** (`day.strip.*`: Dials · Contacts · Appointments set) — lo último de `DEMO-09`, y el único número que se mueve antes de la primera venta. Cuenta desde `call.completed` con cualquier resultado, **así que espera a Aloware**.

**Dos DECISIONES DE JORGE, ninguna bloquea lo de arriba:**

- **Cuál loader SSR fuera de presupuesto se saca** (`contracts/ui-loader-whitelist.json`). §1.2 sanciona **uno** (el pipeline) y hay **tres**. ⚠️ **La razón que ese archivo daba para conservar el del leaderboard era falsa y quedó corregida:** decía que era *"la pantalla donde DEMO-10 quiere rango y brecha arriba del pliegue"* — §7 pone los primeros diez segundos en la **pantalla de inicio del vendedor**, y `home.tsx` redirige a My Day, donde el rank-and-gap ahora vive en un bloque que busca su propio dato. Lo que ese loader todavía compra es el primer pintado de `/earnings`, que es la **segunda** pantalla del demo (DEMO-01). El caso para conservarlo es más débil de lo que el archivo afirmaba; My Day sigue siendo el que el registro pide sacar por su propio texto (§1.1 razón 2 lo nombra). **El motor sólo garantiza que no puedan volverse cuatro.**
- **Si `/earnings` debe ser alcanzable SIN sesión.** El ítem protegido 1 lo llama *"el tablero público"*, pero vive dentro del layout `shell`, que redirige. Hoy una segunda pantalla necesita una cuenta.


### 🧾 DEUDA TÉCNICA DECLARADA (no perder de vista)
- **E9 está firmada pero NO implementada:** no existe `ref.capability_probe`. Llega con el módulo Aloware.
- 🟢 **Snapshots de Drizzle desenganchados desde 0018** — 0019–0023 son SQL a mano y dos alteraron tablas. **Ya no es una trampa: `npm run db:generate` se NIEGA (`DBGEN003`)** nombrando el desfase. Reconciliar la cadena sigue pendiente, pero ahora es una decisión y no un accidente.
- **R13 abierto:** `raw_payload_vault` purga por drop de partición mientras `dead_letter` tiene FK hacia ella.
- **Loaders SSR fuera de presupuesto:** §1.2 sanciona **uno** (el pipeline) y hay **tres**. Enumerados en `contracts/ui-loader-whitelist.json` y acotados por el ratchet `ui.loader_whitelist`. **Falta la decisión de cuál sacar** — My Day es el que el registro pide por su propio texto; el del leaderboard ya no compra el primer pintado del demo (ese pasó a My Day el 2026-08-03), sino el de la segunda pantalla.
- **Ids de tenant de los tests de integración asignados a mano**, sobre la base compartida `crm_test`, sin nada que impida una colisión. Ya chocaron una vez (`...0000f7`, con `scheduling.test.ts`) y el síntoma fue un `duplicate key` en `beforeAll`, no algo que se lea como lo que es.
- **`04b` §4.8 se contradice sobre la nota al pie del tablero:** marca `lb.footnote.golive` como *permanente* y a `lb.footnote.tracked_since` como *que la reemplaza*. Hoy se renderizan las dos, que es lo que conserva la frase del ruling D8. Sin resolver, a propósito.
- **`lead_source_id` omitido** en `contact` a propósito; llega con el módulo de intake.
- **Trigger diferido "un lead nunca existe sin tarjeta"** — pendiente, necesita cruzar `contact` y `opportunity`.

**En paralelo y con reloj externo: el registro 10DLC.** Semanas de trámite, puede ser rechazado. **APARCADO por decisión de Jorge (2026-08-01):** "por ahora dejemos eso para después". Sigue sin decidirse quién firma (reco: la entidad de la agencia del cliente). **Consecuencia asumida:** el reloj externo no arranca, así que la fecha en que el SMS se puede encender se corre junto con esta decisión. El producto lanza SMS-dark de todos modos, así que esto no bloquea la construcción — sólo la fecha del SMS.

### 🖥️ Para retomar en una sesión nueva
```bash
npm run db:up      # Docker Postgres 18 — puede necesitar abrir Docker Desktop a mano
npm run db:migrate
npm run db:jobs    # NO ES OPCIONAL, Y VA DESPUÉS DE db:migrate: correrlo antes
                   # deja la base IRRECUPERABLE (harden() falla cerrado sobre el
                   # esquema pgboss sin clasificar, y la 0020 es la que lo
                   # clasifica). Desde el 2026-08-03 se NIEGA con JOBS003.
                   # Instala el esquema de pg-boss COMO MIGRADOR.
                   # Sin esto `npm run dev` se niega a arrancar (JOBS002), porque
                   # PROCESS_ROLES incluye "worker" y el worker se pliega adentro.
npm run db:seed    # crea el tenant demo Y fija la contraseña dev de crm_app
npm run dev        # http://localhost:3000 — el worker corre DENTRO de este proceso
npm run worker     # sólo para la topología SEPARADA. Con el default plegado no hace
                   # falta: `npm run dev` ya despacha, y lo dice al arrancar.
```
⚠️ **Si `npm run dev` muere con `JOBS002`, falta `npm run db:jobs`** — el mensaje lo dice y nombra el comando. Para servir la web sin worker: `PROCESS_ROLES=web,ingest`.
Entrar con `renata@demo.test` / `demo-password-1234`. Otros: `priya@`, `marcus@`, `dana@`, `tomas@` (este último con **cero ventas** a propósito: es el caso que probó que el tablero debía incluirlo).

Hace falta un `.env` (copiar de `.env.example`; está en `.gitignore`, así que un clon nuevo no lo trae y sin él la app **no arranca**, por diseño de G4(a)).

**`db:seed` se niega si la base ya está sembrada**, y tiene razón: sembrar dos veces duplicaba las tarjetas y el total público. Para volver a empezar de verdad:
```bash
npm run db:reset && npm run db:up && npm run db:migrate && npm run db:seed
```
`db:down` **no** alcanza — deja el volumen y las filas vuelven.

⏳ **El estado `fresh` del tablero dura SESENTA MINUTOS desde `npm run db:seed`.** `fresh` es cero intentos **y** una llegada de menos de una hora, y el seed le da a Ruth Alvarez *"llegó cuando corrió el seed"*. Un tablero mostrado más tarde **no tiene ninguna tarjeta fresca**: ni riel azul ni `NEW`. Si el demo va a mostrar ese estado, sembrar antes. Encontrado el 2026-08-03 porque un e2e que lo asserteaba se puso rojo por primera vez.

✅ **El tenant demo de esta máquina fue RESETEADO el 2026-08-03 y está limpio.** Con el seed que abarca períodos, el tablero arranca en: **hoy $26.339,88 · mes $30.557,88 · all-time $31.997,88**, y el top tres se re-rankea entre pestañas. Renata queda **#2 en all-time con $9.029,88** y **#3 en hoy** — que es justo lo que hace demostrable el selector de período.

📐 **Medido, no estimado: cada corrida completa de `npm run test:e2e` le suma exactamente $3.720 a Renata.** Verificado dos veces el 2026-08-02 — quedó en $16.469,88 tras dos corridas ($9.029,88 + 2 × $3.720). Reseteado después.

⚠️ **Y ese crédito cae en HOY**, así que la deriva del e2e mueve las pestañas Today/This week/This month y deja all-time como el único número estable de Renata. Los specs nuevos lo asumen: los que necesitan un número que no se mueva leen a **Priya**, a la que ningún spec toca.

⚠️ **Pero el demo se vuelve a derivar cada vez que corrés `npm run test:e2e`, y eso es por diseño.** `celebration.spec.ts` lo dice en su propio encabezado: cerrar un trato *es* lo que ese spec prueba y no existe versión que no toque el ledger, así que **cada corrida deja una venta real de $310 × 12 = $3.720** en el vendedor con el que entra. El ledger es append-only y **no hay job de recomputo**, por diseño. **Antes de un demo comercial, reseteá** con el bloque de arriba; el CI corre el e2e contra su propia base efímera, así que allá no importa.

✅ **REMOTO CREADO Y EMPUJADO el 2026-08-02:** `github.com/RuizGoge/CRM-Agency`, privado, `master` rastreando `origin/master`. El CI corrió por primera vez. (Texto histórico abajo.) ~~ESTE REPOSITORIO SIGUE SIN REMOTO~~ — pendiente de Jorge al 2026-08-02. **Decidido:** va a GitHub bajo `RuizGoge`, **privado** (los repos privados igual tienen cuota gratuita de Actions; el control de costo sigue siendo la ausencia de método de pago, §9.4.1). Falta sólo el paso manual: crear el repo **vacío** en github.com/new —sin README, sin .gitignore, sin licencia, porque cualquiera de los tres fuerza un merge antes del primer push— y después `git remote add origin <url> && git push -u origin master`. El workflow ya dispara sobre `[master, main]`, así que no hace falta renombrar la rama. **Hasta que eso pase: no hay copia fuera de este disco, y el CI de GitHub Actions nunca se ejecutó** — o sea que *"el build se pone rojo"* sigue sin haberlo visto nadie más que esta máquina.

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

### ~~D7–D9 abiertas~~ — RESUELTAS (2026-07-31). Texto histórico, no un pendiente.
> ⚠️ **Esta sección decía "abiertas" mientras la línea 454 las daba por resueltas, y las dos estuvieron vivas a la vez.** Marcado el 2026-08-02. Lo que manda es la resolución: **D7 sí** (selector de período sobre un solo tablero) · **D8 no** (el ledger arranca en el go-live; la historia va como saldos iniciales de admin, auditados) · **D9** se verifica en el spike de Aloware y, si el aviso legal no se dispara, se desactiva la grabación a nivel de cuenta. Abajo queda el razonamiento original.

- **D7 · Selector de período en el ranking** (Today/Week/Month/All-time, default All-time). *Reco: adoptar* — el tablero all-time el día 1 son 50 filas de $0 y el demo muere; `period_key` ya está en cada fila del ledger. Es un filtro, no un segundo tablero.
- **D8 · ¿Las ventas históricas importadas escriben en el ledger?** *Reco: NO* — el ledger arranca en el go-live y el tablero se rotula honestamente ("Desde el lanzamiento"). Si quieres historia, va como saldos iniciales ingresados por admin y auditados.
- **D9 · Grabación de llamadas:** Aloware graba a nivel de CUENTA y no está verificado si el aviso legal se dispara en la llamada por API. CA/FL/PA/IL/WA/MA exigen consentimiento de ambas partes. *Reco:* verificar en el spike; si no se dispara, **desactivar grabación a nivel de cuenta** para el MVP.

## Archivo (fases cerradas)
1. ~~GATE 1~~ y ~~GATE 2~~ aprobados.
2. Fase 2 (Opus/alto): mapa funcional completo por módulo (propósito, funcionalidades, pantallas+estados, datos, eventos emit/consume, automatizaciones, permisos, KPIs) + capacidades transversales → `docs/02-functional-map.md` y `docs/02b-integration-map.md` (catálogo de eventos + Mermaid + 3–5 historias de integración).
3. Anclar todo en Fase 0 (silos, Earnings, Aloware, leaderboard) y Fase 1 (Top 20 patrones, diferenciadores).
