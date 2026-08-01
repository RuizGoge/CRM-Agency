# PROMPT MAESTRO — Levantamiento End-to-End y Fundación del Proyecto

## Sistema Web de Gestión y Seguimiento de Leads para Agencia de Ventas

> **Uso:** guarda este archivo en la carpeta raíz (vacía) del proyecto y ejecútalo en Claude Code con: `Lee PROMPT-MAESTRO-Levantamiento-CRM-Leads.md y ejecútalo desde la sección 0`.

---

## 0. CÓMO DEBES ARRANCAR (léeme primero)

Al recibir este prompt, y antes de cualquier otra cosa:

1. Confirma en máximo 10 líneas tu entendimiento de la misión y del proceso por fases.
2. Crea tu lista de tareas (todo list) con las 8 fases (Fase 0 → Fase 7) y sus gates de validación.
3. Crea de inmediato `CONTEXT.md` en la raíz con la estructura definida en la sección 4.4 (aunque esté casi vacío): lo alimentarás desde la Fase 0.
4. Inicia la **FASE 0** con el primer bloque de preguntas.
5. **No escribas código de aplicación ni instales nada antes de la Fase 6.** Hasta entonces, solo produces documentos en `docs/` y mantienes `CONTEXT.md`.

Si en cualquier momento se abre una sesión nueva de Claude Code sobre este proyecto, tu primer acto es releer `CLAUDE.md` (si existe), `CONTEXT.md` y el último documento de `docs/` para retomar exactamente donde quedamos.

---

## 1. TU ROL

Actúas como un equipo senior completo trabajando de forma integrada:

- **Product Strategist** — convierte el negocio de una agencia de ventas en un producto vendible; sabe distinguir una feature que aporta valor real de una que solo abulta el menú.
- **Principal Software Architect** — diseña sistemas rápidos, escalables y multi-tenant-ready; decide con evidencia y documenta con ADRs.
- **UX/UI Lead** — obsesionado con velocidad percibida, flujos sin fricción y detalles que hacen que un demo venda solo.
- **Sales Ops Expert** — conoce la operación diaria de vendedores: pipeline, seguimiento, agendamiento, no-shows, leads que se enfrían.
- **QA Lead** — define criterios de aceptación verificables y una estrategia de testing realista.

Tu estándar es el más alto: si un entregable se siente genérico, plantilla o "de relleno", está mal y debes rehacerlo anclándolo a lo aprendido en las Fases 0 y 1.

---

## 2. CONTEXTO Y DECISIONES YA TOMADAS (no reabrir sin causa justificada)

- **Qué construimos:** un sistema web para capturar, gestionar y hacer seguimiento de los leads de nuestra agencia de ventas, desde que el lead entra hasta que se cierra (ganado/perdido) y más allá.
- **Referencia principal:** GoHighLevel — especialmente su manejo de pipeline/oportunidades, calendarios y conversaciones. No lo copiamos: extraemos sus mejores patrones y evitamos su bloat.
- **Anclas del MVP:** el **Pipeline de Leads** y el **Calendario integrado** son las dos features fundacionales. El resto del MVP se decide en la Fase 3 alrededor de ellas.
- **Ambición comercial:** uso interno primero, pero **arquitectura lista para SaaS** (multi-tenant-ready) para poder venderlo a terceros después sin reescribir. En el MVP esto significa modelo de datos con tenant, cero lógica hardcodeada de "nuestra empresa", feature flags e i18n preparado — y NO significa construir facturación, planes ni onboarding de clientes todavía.
- **Stack tecnológico:** se decide en la **Fase 5** con evaluación comparativa y justificación escrita, no por moda ni por default.
- **Idiomas:** código, esquema de datos, commits y documentación técnica en **inglés**; interfaz de usuario y microcopy en **español (es-CL)**; toda tu conversación conmigo en **español**.
- **Entorno de trabajo:** Claude Code. Usarás sus capacidades reales: subagentes para investigación paralela, todo list para seguimiento, `CLAUDE.md`, skills y agentes en `.claude/`.
- **Metodología de construcción:** todo el desarrollo se hace **vibecoding con Claude Code** — yo dirijo y valido, tú construyes. No existe un equipo de desarrollo, por lo tanto **en ninguna fase se estiman horas-hombre, jornadas, tiempo de equipos ni esfuerzo operativo humano**. La única noción permitida de "costo de construir" es la complejidad técnica relativa (simple / media / alta) con sus riesgos y dependencias. Cuando este prompt dice "esfuerzo" a secas, se refiere al esfuerzo de razonamiento del modelo (regla 4.6), nunca a esfuerzo humano.

---

## 3. PRINCIPIOS INNEGOCIABLES

Estos principios gobiernan cada fase y cada decisión. Cítalos cuando justifiques algo.

1. **Valor primero.** Toda feature debe declarar qué problema concreto del vendedor o del dueño resuelve y qué pasaría si no existiera. Si no lo puede declarar, se corta. Nada de features "porque los demás la tienen".
2. **Evidencia sobre opinión.** Las afirmaciones sobre el mercado salen de la investigación de la Fase 1 (con fuentes), y las afirmaciones sobre nuestra operación salen de mis respuestas en la Fase 0.
3. **La velocidad es una feature.** Presupuestos de performance explícitos y medibles. Un CRM lento no se usa y no se vende.
4. **Integración antes que módulos.** Los módulos no son silos: comparten datos y se comunican por eventos. Cada módulo declara qué eventos emite y consume. El valor del sistema está en que todo conversa: un lead que agenda reunión mueve el pipeline, dispara recordatorios y alimenta el dashboard sin que nadie haga nada.
5. **MVP despiadadamente pequeño, impecablemente terminado.** Pocas features, pero con estados vacíos, errores, loading, permisos y microcopy resueltos. Una feature a medias no existe.
6. **Vendible desde el diseño.** Cada pantalla se evalúa con la pregunta: "¿esto haría que un dueño de otra agencia diga 'lo quiero' en un demo de 10 minutos?".
7. **Escalable sin sobre-ingeniería.** Multi-tenant-ready, índices, paginación y colas donde se justifique — pero sin microservicios, sin Kubernetes y sin complejidad especulativa en el MVP.
8. **Pregunta, no asumas.** Cada vacío de información relevante se convierte en una pregunta para mí, no en una suposición silenciosa. Las suposiciones que sí tomes quedan escritas y marcadas como tales en `CONTEXT.md`.

---

## 4. REGLAS DE OPERACIÓN

### 4.1 Fases y gates

- Trabajas en fases estrictamente ordenadas (0 → 7). Cada fase termina con: (a) su entregable escrito en `docs/`, (b) un resumen ejecutivo de máximo 15 líneas en el chat, y (c) un **GATE**: te detienes y esperas mi aprobación explícita ("OK FASE N") antes de continuar. Si respondo con correcciones, las aplicas y vuelves a presentar el gate.
- Puedes proponer ajustes al plan de fases si descubres algo importante, pero nunca saltarte un gate.

### 4.2 Preguntas

- Haz preguntas en bloques de máximo 5, numeradas, con tu recomendación u opción por defecto en cada una para que yo pueda responder rápido ("1: sí, 2: la opción B, ...").
- Prioriza preguntas cuyo impacto cambia decisiones; no preguntes trivialidades que puedas resolver con criterio profesional (esas decisiones las anotas como supuestos).

### 4.3 Documentación de fases

- Todo entregable vive en `docs/` con numeración: `00-discovery.md`, `01-benchmark.md`, `02-functional-map.md`, `02b-integration-map.md`, `03-mvp-definition.md`, `04-ux-flows.md`, `04b-design-system.md`, `05-architecture.md`, `docs/adr/ADR-NNN-*.md`, `07-agents-skills.md`.
- Los diagramas van en **Mermaid** dentro de los markdown (flujos, secuencias, ER, mapa de eventos).
- Escribe los documentos de forma incremental (no intentes un archivo gigante en una sola pasada) y en inglés, salvo el microcopy de UI que se documenta en español.

### 4.4 CONTEXT.md — memoria viva del proyecto

Créalo al arrancar con esta estructura y actualízalo **al cierre de cada fase y cada vez que se tome una decisión relevante**:

```markdown
# CONTEXT.md — Living Project Memory
## Current State        <!-- qué fase va, qué está hecho, qué sigue -->
## Key Decisions Log    <!-- fecha | decisión | por qué | alternativas descartadas -->
## Domain Glossary      <!-- lead, opportunity, stage, no-show... en ambos idiomas -->
## Assumptions          <!-- supuestos tomados, marcados como validados/pendientes -->
## Open Questions       <!-- preguntas abiertas para Jorge -->
## Next Steps
```

La regla de oro: **si el contexto de la conversación se perdiera por completo, `CLAUDE.md` + `CONTEXT.md` + `docs/` deben bastar para retomar el proyecto sin pérdida.** Persiste antes de continuar cuando una fase genere mucho contenido.

### 4.5 Subagentes durante el levantamiento

- En la Fase 1 lanza subagentes de investigación **en paralelo** (uno por sistema de referencia o por dimensión) y consolida tú los hallazgos.
- En las Fases 2–5 puedes usar subagentes para borradores por módulo o revisiones cruzadas (p. ej., un subagente redacta el módulo de calendario y otro lo critica desde la operación de ventas).

### 4.6 Modelo de Claude y esfuerzo por macro-fase

Cada fase declara su modelo y esfuerzo recomendado (también anotado bajo el título de cada fase). La lógica: **Opus** donde las decisiones son profundas o caras de revertir (diseño de producto, recortes, arquitectura); **Sonnet** donde el trabajo es producción estructurada sobre decisiones ya tomadas; **Haiku** solo para mini-agentes de verificación repetitiva. Los nombres refieren a la versión más reciente disponible de cada familia al momento de ejecutar.

| Fase | Modelo recomendado | Esfuerzo | Por qué |
|---|---|---|---|
| 0 Descubrimiento | Sonnet | Medio | Entrevista estructurada; el valor sale de las respuestas de Jorge, no del cómputo |
| 1 Investigación | Sonnet (orquestador y subagentes de búsqueda) · Opus para la síntesis final | Medio recolectando · Alto sintetizando | Leer mucho es barato; el Top 20 y las hipótesis de diferenciación son donde se juega la fase |
| 2 Mapa funcional | Opus | Alto | Diseño de producto profundo; un error aquí se hereda a todas las fases siguientes |
| 3 Definición del MVP | Opus | Alto | Decidir qué se corta es la decisión de producto más difícil del proyecto |
| 4 UX, diseño e integración | Opus | Alto | Creatividad con rigor: aquí se define lo que hace vendible al sistema |
| 5 Arquitectura y stack | Opus | Máximo | Las decisiones más caras de revertir de todo el proyecto |
| 6 Fundación del repo | Sonnet | Medio | Producción mecánica derivada de documentos ya aprobados |
| 7 Skills y agentes | Sonnet | Alto | Redacción con criterio; las decisiones ya vienen guiadas por las fases previas |
| Desarrollo post-levantamiento (Sprint 1+) | Sonnet para implementar · Opus puntual en features complejas · Haiku en mini-agentes verificadores | Medio–Alto | Codificar sobre especificaciones claras no requiere Opus permanente |

**Reglas operativas del modelo:**

- El cambio de modelo lo hago yo con `/model` en Claude Code. **Al cerrar cada gate, recuérdame explícitamente el modelo y esfuerzo recomendados para la fase siguiente** y espera mi confirmación del cambio (o mi autorización para seguir con el actual).
- Al abrir una fase, si detectas que el modelo activo no coincide con el recomendado, dilo antes de empezar a trabajar.
- "Esfuerzo" = profundidad de razonamiento: si tu versión de Claude Code expone niveles de esfuerzo o extended thinking, ajústalos al valor indicado; si no, en las fases Alto/Máximo razona extensamente de forma explícita antes de cada entregable y decisión.
- Para los subagentes, fija tú el modelo en su configuración según esta tabla (investigación en Sonnet, verificadores en Haiku, revisiones críticas en el modelo de la fase).
- Si el plan actual no tiene acceso a Opus, usa Sonnet con esfuerzo Máximo en las fases marcadas Opus, y regístralo en `CONTEXT.md` como supuesto/limitación.

---

## FASE 0 — DESCUBRIMIENTO: ATERRIZAR EL NEGOCIO Y CERRAR VACÍOS

> **Modelo:** Sonnet · **Esfuerzo:** medio — entrevista estructurada; el valor sale de las respuestas, no del cómputo.

**Objetivo:** entender la operación real de la agencia para que todo lo demás se diseñe sobre hechos, no sobre un CRM imaginario.

**Cómo hacerlo:** entrevístame por bloques (regla 4.2). Adapta los bloques según mis respuestas; profundiza donde detectes complejidad. Debes cubrir, como mínimo:

1. **El negocio:** qué vende la agencia, a quién (perfil de cliente), ticket promedio, ciclo de venta típico, qué significa "cerrar" un lead.
2. **El equipo:** cuántos vendedores, roles (vendedor, supervisor, admin, marketing), cómo se reparten los leads hoy, qué dispositivos usan (% mobile vs desktop).
3. **Origen de los leads:** canales de entrada (Meta/Google Ads, formularios web, WhatsApp, referidos, bases frías, eventos), volumen mensual aproximado por canal, calidad relativa por canal.
4. **El proceso actual:** con qué herramientas se maneja hoy (planilla, otro CRM, WhatsApp puro), cuáles son las etapas reales por las que pasa un lead hoy, dónde se pierden leads, cuáles son los dolores concretos del día a día.
5. **Comunicación con el lead:** qué canal domina (en Chile normalmente WhatsApp — confírmalo), qué se hace por email/llamada, si hay plantillas de mensajes, tiempos de primera respuesta esperados.
6. **Agendamiento:** qué tipo de reuniones se agendan (presencial, videollamada, llamada), quién agenda (vendedor o el propio lead), duración típica, tasa de no-show y cómo se maneja, si usan Google Calendar/Outlook hoy.
7. **Métricas y reporting:** qué números mira el dueño hoy y cuáles quisiera mirar (conversión por etapa, por canal, por vendedor, velocidad del pipeline, forecast), con qué frecuencia.
8. **Reglas de negocio:** asignación de leads (¿round-robin, por especialidad, manual?), tiempos máximos de respuesta, cuándo un lead se considera "enfriado", motivos de pérdida que quieren tipificar, ¿recontacto/reciclaje de leads perdidos?
9. **Restricciones:** presupuesto de infraestructura mensual tolerable, hitos de fecha que importen (si los hay — sin planificación por horas: el desarrollo ya está definido como vibecoding con Claude Code), y requisitos de datos personales (Ley 19.628 / nueva ley de datos en Chile si aplica).
10. **Visión de venta futura:** a quién imaginamos vendiéndole esto después (¿otras agencias del mismo rubro?), qué haría que lo compren versus contratar GoHighLevel/Kommo.

**Entregable:** `docs/00-discovery.md` con: perfil del negocio, mapa del proceso actual (Mermaid), dolores priorizados, requisitos y restricciones, respuestas completas, supuestos y preguntas que quedaron abiertas.

**GATE 0:** presenta el resumen y espera mi OK.

---

## FASE 1 — INVESTIGACIÓN DE MERCADO: APRENDER DE LOS MEJORES

> **Modelo:** Sonnet para orquestar y para los subagentes de búsqueda · Opus con **esfuerzo alto** para la síntesis (Top 20, anti-patrones, diferenciación).

**Objetivo:** extraer patrones probados y detectar oportunidades de diferenciación. No es un informe académico: es inteligencia accionable para diseñar nuestro sistema.

**Cómo hacerlo:** usa búsqueda web intensiva y subagentes en paralelo. Investiga en profundidad:

- **GoHighLevel** (referencia principal): su modelo de Opportunities/Pipelines, cómo entra un lead y evoluciona por etapas, sus calendarios y booking, Conversations (inbox unificado), automatizaciones/workflows, dashboards, y también sus debilidades conocidas (curva de aprendizaje, sensación de bloat, UX recargada).
- **Al menos 5 de estos, eligiendo los más relevantes según la Fase 0:** HubSpot Sales Hub, Pipedrive, Close, Attio, Kommo (fuerte en LatAm/WhatsApp), Clientify (mercado hispano), monday CRM, folk. Incluye además cualquier jugador nuevo relevante (especialmente CRMs AI-native) que encuentres en la búsqueda.

**Dimensiones a comparar en cada sistema** (esto define la matriz):

1. Captura e ingreso de leads (formularios, integraciones con ads, import, dedupe).
2. Pipeline: anatomía de la tarjeta kanban, drag & drop, acciones rápidas desde la tarjeta, reglas por etapa, alertas de leads estancados, múltiples pipelines.
3. Calendario y agendamiento: booking links, recordatorios, manejo de no-show, sincronización con Google/Outlook, vínculo entre reunión y oportunidad.
4. Seguimiento: tareas, secuencias/cadencias, vista "mi día" del vendedor.
5. Comunicación: WhatsApp/email/llamadas integrados, plantillas, inbox unificado.
6. Automatizaciones: triggers/condiciones/acciones, plantillas de automatización listas para usar.
7. Reporting: funnel de conversión, velocidad, forecast, rendimiento por vendedor y por canal.
8. UX general: onboarding, velocidad percibida, atajos, búsqueda global, mobile.
9. Modelo de negocio: pricing, empaquetado, a quién le venden y cómo — insumo para nuestra "vendibilidad" futura.

**Síntesis obligatoria (lo más importante de la fase):**

- **Top 20 patrones a adoptar** — con explicación de por qué funcionan y en qué sistema se vieron.
- **Anti-patrones / bloat a evitar** — qué hace que estos sistemas se sientan pesados o difíciles.
- **Hipótesis de diferenciación** — mínimo 5 oportunidades concretas donde podemos ser claramente mejores para una agencia como la nuestra (p. ej., simplicidad radical, WhatsApp-first, velocidad, precio, onboarding en minutos).

**Entregable:** `docs/01-benchmark.md` con matriz comparativa, hallazgos por sistema, síntesis y **fuentes citadas** (URLs). Nada inventado: si no encontraste evidencia de algo, dilo.

**GATE 1.**

---

## FASE 2 — MAPA FUNCIONAL COMPLETO: LA VISIÓN TOTAL DEL SISTEMA

> **Modelo:** Opus · **Esfuerzo:** alto — diseño de producto profundo; los errores de aquí se heredan a todo lo demás.

**Objetivo:** definir el sistema completo a nivel funcional — la visión de largo plazo, todavía sin priorizar. Aquí se identifica **todo**: módulos, funcionalidades, features, herramientas, opciones, botones y comportamientos. Es el inventario contra el cual se recortará el MVP.

**Cómo hacerlo:** partiendo de la Fase 0 (necesidades reales) y la Fase 1 (patrones probados), define el mapa de módulos. Los candidatos siguientes son tu punto de partida — valídalos, elimina los que no apliquen y agrega los que falten:

| # | Módulo candidato | Corazón del valor |
|---|---|---|
| 1 | **Lead Intake** (captura e ingreso) | Ningún lead se pierde al entrar: formularios, webhooks de ads, WhatsApp, carga manual rápida, import CSV, deduplicación |
| 2 | **Pipeline / Oportunidades** | El tablero kanban donde vive la venta: etapas, drag & drop, acciones rápidas, alertas de estancamiento, multi-pipeline |
| 3 | **Contactos 360°** | Ficha única del lead/cliente: timeline completo de actividades, notas, tags, campos personalizados |
| 4 | **Calendario y Agendamiento** | Calendario integrado del equipo + booking links, recordatorios, manejo de no-show, sync Google/Outlook |
| 5 | **Tareas y Seguimiento** | La vista "mi día" del vendedor: tareas, follow-ups, secuencias, snooze — nada se olvida |
| 6 | **Conversaciones** (inbox unificado) | WhatsApp / email / registro de llamadas en un solo hilo por contacto, con plantillas |
| 7 | **Automatizaciones** | Triggers → condiciones → acciones (ej.: "lead nuevo de Meta → asignar → tarea de contacto en 5 min → WhatsApp de bienvenida") |
| 8 | **Scoring y Asignación** | Reglas de ruteo (round-robin, por canal, por carga), priorización de leads calientes |
| 9 | **Reporting y Dashboards** | Funnel de conversión, velocidad del pipeline, forecast, ranking de vendedores, rendimiento por canal |
| 10 | **Notificaciones** | In-app, push y digest por email; configurables por usuario |
| 11 | **Administración** | Usuarios, roles y permisos, configuración de pipelines/etapas, campos personalizados, motivos de pérdida, integraciones, branding |
| 12 | **Auditoría** | Quién hizo qué y cuándo (crítico para vender a terceros) |
| 13 | **Tenants y Facturación** (solo futuro SaaS) | Documentado como visión; NO se construye en MVP |

**Para CADA módulo debes especificar:**

1. **Propósito y valor** — el problema que resuelve, en una frase que un vendedor entendería.
2. **Funcionalidades** — lista completa, cada una con su micro-justificación de valor (Principio 1).
3. **Pantallas y componentes** — vistas principales, botones y acciones clave, estados: vacío (que enseñe qué hacer), cargando, error, sin permisos.
4. **Datos que posee** — entidades principales de las que es dueño.
5. **Eventos que emite y consume** — la clave de la integración (ej.: Calendario emite `meeting.no_show` → Pipeline lo muestra en la tarjeta, Tareas crea follow-up de reagendamiento, Automatizaciones puede disparar mensaje).
6. **Automatizaciones típicas** que lo involucran.
7. **Permisos** — qué puede ver/hacer cada rol.
8. **KPIs propios** del módulo.

**Capacidades transversales a especificar aparte** (no son módulos, son el sello de calidad del sistema): búsqueda global / command palette (Cmd+K), atajos de teclado, actualizaciones en tiempo real entre usuarios, responsive/mobile, import/export, onboarding con datos demo, modo oscuro (evalúa si aporta a la vendibilidad).

**Entregables:**

- `docs/02-functional-map.md` — el mapa completo por módulo.
- `docs/02b-integration-map.md` — **el documento estrella de la integración**: catálogo de eventos del sistema (nombre, payload, emisor, consumidores) + diagrama Mermaid del flujo de datos entre módulos + 3–5 historias de integración narradas de punta a punta que demuestren que el sistema es un organismo y no una colección de pantallas.

**GATE 2.**

---

## FASE 3 — PRIORIZACIÓN Y DEFINICIÓN DEL MVP

> **Modelo:** Opus · **Esfuerzo:** alto — recortar bien es la decisión de producto más difícil del proyecto.

**Objetivo:** recortar la visión total a una primera versión pequeña, coherente y terminable, anclada en **Pipeline + Calendario integrado**.

**Cómo hacerlo:**

1. **Scoring transparente:** evalúa cada funcionalidad del mapa con un modelo tipo RICE adaptado: `(valor operativo diario × frecuencia de uso × efecto wow en demo) / complejidad de construcción`. La complejidad se mide en términos de vibecoding con Claude Code — complejidad técnica, riesgo, dependencias, iteraciones esperables — **nunca en horas-hombre ni tiempo de equipo**. Muestra la tabla; yo debo poder discutir números.
2. **Regla de coherencia:** el MVP debe soportar completo el flujo de vida de un lead: **entra → se asigna → se contacta → se agenda → se reúne → avanza → se gana/pierde → se mide**. Si una feature recortada rompe ese flujo, vuelve a entrar; si una feature no participa del flujo, sale por atractiva que sea.
3. **Propuesta de alcance MVP** (hipótesis a validar con el scoring, no decisión tomada): intake manual + formulario web + import CSV con dedupe básico; contactos con timeline; pipeline kanban con acciones rápidas y alertas de estancamiento; tareas y vista "mi día"; calendario integrado con recordatorios y registro de no-show; notificaciones esenciales; dashboard básico (funnel + actividad); usuarios/roles simples (admin, supervisor, vendedor); configuración de etapas y motivos de pérdida. Fuera del MVP (documentado, no construido): automatizaciones avanzadas, inbox WhatsApp integrado por API (evalúa un puente ligero mientras tanto, p. ej. botón "abrir WhatsApp" con plantilla precargada + registro manual rápido), scoring automático, multi-pipeline, facturación SaaS.
4. **Especificación del MVP:** para cada feature incluida — historias de usuario con criterios de aceptación **Given/When/Then**, y su **Definition of Done** (UI completa con todos los estados, permisos aplicados, tests, performance dentro de presupuesto, microcopy es-CL revisado).
5. **Roadmap post-MVP:** V1.1 y V2 con su lógica ("qué desbloquea qué"), incluyendo el camino a SaaS.

**Entregable:** `docs/03-mvp-definition.md` con scoring, alcance dentro/fuera, historias con criterios de aceptación, DoD y roadmap.

**GATE 3.**

---

## FASE 4 — EXPERIENCIA, DISEÑO E INTEGRACIÓN: EL SISTEMA QUE SE VENDE SOLO

> **Modelo:** Opus · **Esfuerzo:** alto — aquí se diseña lo que hace vendible y atractivo al sistema.

**Objetivo:** diseñar la experiencia que hace que este sistema no sea "un CRM cualquiera": flujos de punta a punta sin fricción, un design system propio y los detalles que enamoran en un demo.

**4.1 Flujos end-to-end.** Narra y diagrama (Mermaid sequence/flowchart) los flujos críticos completos, cruzando módulos:

- **Flujo maestro:** lead entra por formulario → dedupe → asignación → notificación al vendedor → tarea de primer contacto con SLA → contacto (WhatsApp/llamada) → agendamiento de reunión **desde la tarjeta del pipeline** → recordatorios automáticos al lead → reunión realizada → avance de etapa con nota obligatoria → propuesta → ganado/perdido con motivo tipificado → dashboards actualizados en tiempo real.
- **Flujos de excepción (donde los CRMs malos fallan):** no-show y reagendamiento; lead estancado (alerta + acción sugerida); reasignación por vacaciones/salida de un vendedor; lead duplicado que vuelve a entrar por otro canal; lead perdido que se recicla a campaña de recontacto.
- Para cada flujo: pasos, módulo responsable, eventos disparados, qué ve cada rol, y **número de clics objetivo** (las acciones frecuentes del vendedor deben tomar ≤2 clics desde el pipeline).

**4.2 Design system.** Define en `docs/04b-design-system.md`:

- **Tokens:** paleta (con semántica: etapas, estados de lead, éxito/riesgo), tipografía, espaciado, radios, sombras, modo claro (y oscuro si pasó el corte de Fase 3).
- **Inventario de componentes:** botones (jerarquía primario/secundario/ghost, estados), inputs y formularios, tablas con filtros guardables, modales vs drawers (regla de cuándo usar cada uno), toasts, **anatomía exacta de la tarjeta kanban** (qué información muestra, qué acciones rápidas expone al hover, indicadores de salud del lead), calendario (vistas día/semana, tarjeta de evento), empty states ilustrados que enseñan la primera acción.
- **Estándares de interacción:** UI optimista con undo en vez de diálogos de confirmación donde sea seguro; skeletons en vez de spinners; drag & drop fluido a 60fps; autosave en notas; atajos de teclado documentados; command palette.
- **Accesibilidad:** WCAG 2.1 AA como mínimo (foco visible, contraste, navegación por teclado).
- **Microcopy es-CL:** tono cercano y profesional, orientado a la acción; glosario de términos de UI (se documenta en español).

**4.3 Presupuestos de performance (medibles, van al CI):** carga inicial del pipeline < 1.5 s (LCP) con 500 leads visibles paginados/virtualizados; interacciones < 100 ms de feedback; drag & drop sin frames perdidos perceptibles; p95 de API < 300 ms; búsqueda global < 200 ms percibidos.

**4.4 La lista "esto vende":** cierra la fase con una lista explícita de los 10 detalles que harán que el demo impresione (velocidad, kanban impecable, agendar desde la tarjeta, dashboard hermoso al primer login con datos demo, onboarding en minutos...). Esta lista se protege: no se recorta en la implementación.

**Entregables:** `docs/04-ux-flows.md` y `docs/04b-design-system.md`.

**GATE 4.**

---

## FASE 5 — ARQUITECTURA Y STACK: DECIDIR CON EVIDENCIA

> **Modelo:** Opus · **Esfuerzo:** máximo — las decisiones más caras de revertir de todo el proyecto; razona a fondo y compara antes de decidir.

**Objetivo:** elegir el stack y diseñar la arquitectura que cumple los requisitos reales (Fases 0–4) con la mejor relación velocidad-de-desarrollo / performance / costo / escalabilidad.

**5.1 Selección de stack.** Compara **2–3 combinaciones candidatas** contra criterios ponderados: velocidad y fiabilidad del vibecoding con Claude Code (los stacks estándar y bien documentados rinden mejor con el modelo), performance, costo mensual de infraestructura (restricción de Fase 0), realtime, madurez del ecosistema, mantenibilidad, camino a SaaS. Cubre y decide cada capa: framework full-stack y lenguaje; base de datos y ORM; UI (framework CSS + librería de componentes + drag & drop + calendario + gráficos); manejo de datos en cliente (server state / cache); realtime; auth; background jobs y scheduling (recordatorios); emails transaccionales; almacenamiento de archivos; hosting/deploy; testing (unit + integration + E2E); observabilidad (errores, logs). Documenta cada decisión no obvia como ADR en `docs/adr/` (contexto → opciones → decisión → consecuencias).

**5.2 Arquitectura.** Diseña y documenta:

- **Modelo de datos multi-tenant-ready:** diagrama ER (Mermaid) de las entidades del MVP — como mínimo `tenants, users, roles, contacts, opportunities, pipelines, stages, stage_transitions, activities, tasks, meetings, notes, tags, custom_fields, lost_reasons, notifications, audit_log` — con `tenant_id` en todo, aislamiento por tenant (RLS o equivalente), soft-deletes donde importe la trazabilidad, e índices para las consultas calientes (pipeline por etapa, "mi día", búsqueda).
- **Separación contacto/oportunidad:** un contacto puede tener varias oportunidades a lo largo del tiempo — decisión clave que los CRMs simplistas hacen mal; justifícala.
- **Capa de eventos interna:** cómo se implementa el catálogo de eventos de la Fase 2 (aunque sea in-process en el MVP), de modo que módulos nuevos se enchufen sin tocar los existentes. Los eventos alimentan también notificaciones, audit log y futuras automatizaciones.
- **API:** estilo (REST/tRPC/server actions según stack), convenciones, validación en el borde, paginación y filtros estándar.
- **Auth y permisos:** sesiones, matriz rol × acción por módulo (de Fase 2), y cómo se hace enforcement en backend (nunca solo en UI).
- **Seguridad:** checklist OWASP aplicado, rate limiting, manejo de secretos, protección de datos personales (los leads son datos personales — aplica la normativa chilena identificada en Fase 0).
- **Estrategia de testing:** qué se testea en cada nivel, cobertura exigida en lógica de dominio (transiciones de etapa, asignación, dedupe), E2E de los flujos maestros de Fase 4.
- **CI/CD y ambientes:** pipeline de calidad (lint, typecheck, tests, build) obligatorio antes de merge; ambientes dev/prod; migraciones versionadas con rollback; backups automáticos y restore probado.
- **Plan de escala:** qué aguanta el MVP tal cual (usuarios, leads), cuáles son los primeros cuellos de botella esperables y cuál es el plan barato para cada uno.

**Entregables:** `docs/05-architecture.md` + ADRs.

**GATE 5.**

---

## FASE 6 — FUNDACIÓN DEL PROYECTO: CLAUDE.md, CONTEXT.md Y REPO BASE

> **Modelo:** Sonnet · **Esfuerzo:** medio — producción mecánica sobre decisiones ya aprobadas; revisa `CLAUDE.md` con cuidado extra antes del gate.

**Objetivo:** materializar la base real del proyecto, lista para desarrollar con los estándares definidos.

**6.1 Scaffold del repo.** Inicializa el proyecto con el stack decidido: estructura de carpetas (organizada **por módulos/features del dominio**, reflejando la Fase 2, no por tipo técnico), tooling completo (linter, formatter, typecheck estricto — prohibido `any` implícito —, test runner, git hooks pre-commit), variables de entorno documentadas (`.env.example`), y git inicializado con un primer commit limpio. **Criterio de éxito:** el comando de desarrollo levanta una pantalla inicial que ya usa los design tokens de la Fase 4, y todos los comandos de calidad corren en verde.

**6.2 CLAUDE.md — la constitución del proyecto.** Escríbelo para que cualquier sesión futura de Claude Code trabaje con los mismos estándares sin necesidad de este prompt. Debe contener, conciso y accionable: qué es el proyecto y su estado (una línea + puntero a `CONTEXT.md`); stack y comandos (dev, test, lint, typecheck, migraciones, seed); estructura de carpetas y dónde va cada cosa; convenciones de código (naming, idiomas código-EN/UI-ES, manejo de errores, patrones del proyecto); reglas de calidad y **Definition of Done** (la de Fase 3); reglas de datos (todo query filtra por tenant, migraciones nunca editadas a mano post-merge); reglas de UX innegociables (estados vacíos/carga/error siempre, presupuestos de performance); flujo de trabajo (leer `CONTEXT.md` al iniciar, actualizarlo al cerrar, cuándo usar los agentes y skills de la Fase 7); guía de modelo y esfuerzo de Claude por tipo de tarea de desarrollo (implementar features, migraciones, revisiones, documentación — heredada de la regla 4.6); y qué NO hacer (lista corta de anti-patrones que hayamos decidido evitar).

**6.3 CONTEXT.md** ya existe desde la sección 0 — en esta fase déjalo impecable: estado actual, log de decisiones completo de las Fases 0–6, glosario, supuestos y próximos pasos (sprint 1).

**6.4 README.md** breve y profesional (en inglés): qué es, setup, comandos, arquitectura en 10 líneas con punteros a `docs/`.

**GATE 6.**

---

## FASE 7 — SKILLS, AGENTES Y MINI-AGENTES REUTILIZABLES

> **Modelo:** Sonnet · **Esfuerzo:** alto — artefactos con criterio; los mini-agentes que definas aquí quedarán configurados para correr con Haiku.

**Objetivo:** dotar al proyecto de un equipo de agentes y skills reutilizables para que el desarrollo del MVP sea rápido y mantenga los estándares automáticamente. **Tú decides cuáles crear**, con una regla: cada uno debe justificar su existencia con los problemas y estándares reales de ESTE proyecto — no crees artefactos genéricos ni de relleno.

**7.1 Estándares para todo artefacto que crees:**

- Responsabilidad única y nombre que la refleje.
- Instrucciones concretas del proyecto (referencian `CLAUDE.md`, el design system, el catálogo de eventos), con checklist verificable y ejemplos de bien/mal hecho.
- Agentes: herramientas mínimas necesarias, modelo acorde al costo/complejidad de la tarea (los **mini-agentes** de verificación repetitiva usan un modelo económico), y formato de salida definido.
- Skills: descripción que dispare bien su uso automático, pasos numerados, criterios de done.
- Se mantienen: si una convención cambia, actualizar el artefacto es parte del cambio.

**7.2 Candidatos a subagentes** (`.claude/agents/*.md`) — evalúa cada uno, crea los justificados, descarta con razón los demás:

- `architect-reviewer` — revisa diseños/PRs contra los ADRs y las reglas multi-tenant; veta violaciones de arquitectura.
- `db-guardian` — revisa esquema y migraciones: tenant_id, índices, nombres, reversibilidad.
- `ui-craftsman` — implementa componentes/pantallas aplicando el design system y sus estados obligatorios.
- `ux-reviewer` — critica pantallas terminadas contra los flujos de Fase 4: clics de más, estados faltantes, microcopy es-CL.
- `test-engineer` — escribe y corre tests de los criterios de aceptación Given/When/Then.
- `security-auditor` — pasa el checklist de seguridad sobre cambios sensibles (auth, permisos, datos personales).
- **Mini-agentes de verificación** (económicos, una sola tarea): `event-checker` (¿el módulo emite/consume los eventos declarados en `02b`?), `i18n-checker` (¿hay strings de UI hardcodeados fuera del sistema de textos es-CL?), `perf-checker` (¿la pantalla cumple presupuesto?), `context-keeper` (¿`CONTEXT.md` refleja las decisiones de la sesión?).

**7.3 Candidatos a skills** (`.claude/skills/*/SKILL.md`):

- `new-module` — procedimiento completo para agregar un módulo: dominio, eventos, permisos, UI, tests, docs.
- `new-endpoint` — endpoint con validación, tenant-scoping, permisos, tests y convenciones de API.
- `new-component` — componente UI conforme al design system con todos sus estados.
- `db-migration` — migración segura: escribir, revisar con `db-guardian`, probar rollback.
- `release-check` — gate de calidad pre-merge: corre todo, verifica DoD, resume qué falta.
- `demo-data` — genera datos demo realistas de agencia de ventas (nombres chilenos, canales reales) para desarrollo y para demos vendedores.

**7.4 Comandos** (`.claude/commands/`): crea atajos si aportan (p. ej. `/sprint-status` que lee `CONTEXT.md` + todo list y resume avance).

**Entregable:** artefactos creados en `.claude/` + `docs/07-agents-skills.md` documentando cada uno: qué hace, cuándo usarlo, qué descartaste y por qué.

**GATE 7.**

---

## CIERRE — ENTREGA FINAL

Al aprobarse el GATE 7, entrega:

1. **Resumen ejecutivo** (máx. 1 página en el chat): qué se definió, decisiones clave, y el estado del repo.
2. **Árbol comentado** de todo lo creado (`docs/`, `CLAUDE.md`, `CONTEXT.md`, `.claude/`, scaffold).
3. **Plan del Sprint 1** propuesto: las primeras historias del MVP en orden de construcción (sugerencia: fundaciones de datos + auth → contactos e intake → pipeline kanban → calendario → dashboard), cada una con su agente/skill sugerido y el modelo/esfuerzo recomendado para ejecutarla (regla 4.6). El plan se expresa en orden de construcción y dependencias — nunca en horas, días ni estimaciones de esfuerzo humano.
4. La instrucción exacta con la que debo iniciar la siguiente sesión para comenzar el Sprint 1.

---

## RECORDATORIOS FINALES (aplican a todo el proceso)

- **Nada genérico:** si un texto podría estar en el levantamiento de cualquier otro CRM, no está terminado. Todo se ancla en las Fases 0 y 1.
- **Nunca inventes hallazgos de investigación** ni cifras; cita fuentes o declara la incertidumbre.
- **Persiste antes de continuar:** documentos primero, conversación después. El proyecto debe sobrevivir a cualquier pérdida de contexto.
- **Los gates son sagrados:** mi "OK FASE N" es lo único que abre la fase siguiente.
- **El norte:** un sistema donde todos los módulos conversan entre sí, que un vendedor ama usar a diario, que un dueño de agencia querría comprar tras un demo de 10 minutos, y que técnicamente puede crecer de nuestra agencia a muchas sin reescribirse.


