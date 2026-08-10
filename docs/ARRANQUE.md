# ARRANQUE — levantar el entorno local

Este archivo existe para que Jorge pueda pedir **QA funcional sin explicar nada**: seguir estos pasos
deja el producto corriendo con datos de demo a escala, y la sección *"Cómo saber que quedó bien"* dice
exactamente qué tiene que verse en pantalla.

> Verificado de punta a punta el **2026-08-07** contra Node v24.12.0, npm 11.6.2, Docker 29.1.3,
> Windows 11. Lo que no verifiqué está marcado como tal.

---

## 0 · Requisitos

| | |
|---|---|
| **Node** | **24 o superior** (`engines` lo declara). `node --version` |
| **Docker** | Para el Postgres local. **Docker Desktop tiene que estar abierto**, no sólo instalado. |
| **PostgreSQL** | **No lo instales**. Lo levanta el compose, y tiene que ser **18** — el mismo major que producción. |

**Costo: cero.** Todo corre local, sin cuenta de proveedor y sin términos de free tier que cumplir.

---

## 1 · Instalar

```bash
npm ci
```

`npm ci`, no `npm install` — el lockfile está clavado a propósito y `install` puede moverlo
(ver §10 de [`CLAUDE.md`](../CLAUDE.md), versiones clavadas).

---

## 2 · Variables de entorno

`.env` está en `.gitignore`. **Un clon nuevo —o un worktree nuevo— no lo trae, y sin él la app no
arranca, por diseño** (la aserción de arranque G4(a) se niega a correr sin credenciales explícitas).

```bash
cp .env.example .env
```

Después, **lo único que hay que rellenar a mano** es el secreto de sesión:

```bash
openssl rand -base64 32
```

y pegarlo en `SESSION_SECRET=`. Los demás valores del ejemplo ya apuntan al Postgres del compose y
sirven tal cual para desarrollo.

### Las tres variables que importan entender

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Conecta como **`crm_app`**. Es el rol sin privilegios con el que corren los procesos. **La app se niega a arrancar si esta URL nombra un rol que puede saltear RLS** — por eso desarrollo usa dos roles y no uno. |
| `MIGRATION_DATABASE_URL` | Conecta como **`crm`**, el rol de bootstrap (superusuario en local). Lo usan **sólo** drizzle-kit y el seed; nunca está en un proceso de la app. El que **posee el esquema** es `crm_migrator`, que es `NOLOGIN` a propósito: no se conecta nadie con él. |
| `PROCESS_ROLES` | `web,worker,ingest` por defecto. **Con `worker` en la lista, el proceso web pliega el dispatcher adentro** y se niega a arrancar si pg-boss no tiene esquema. Para servir la web sin worker: `PROCESS_ROLES=web,ingest`. |

---

## 3 · Base de datos — **el orden no es negociable**

```bash
npm run db:up
```

```bash
npm run db:migrate
```

```bash
npm run db:jobs
```

```bash
npm run db:seed
```

**Por qué ese orden exacto:**

- **`db:jobs` va DESPUÉS de `db:migrate`.** Al revés dejaba la base **irrecuperable**: el loop de
  hardening falla cerrado sobre el esquema `pgboss` sin clasificar, y la migración 0020 es justamente
  la que lo clasifica. Desde el 2026-08-03 se niega con `JOBS003` en vez de romper, pero el orden sigue
  siendo el orden.
- **`db:jobs` no es opcional.** Instala el esquema de pg-boss **como migrador** (nunca al arrancar: una
  librería no debe emitir DDL bajo la credencial de la aplicación). Sin él, `npm run dev` muere con
  **`JOBS002`**.
- **`db:seed` hace dos cosas**, y la segunda no es obvia: crea el tenant demo **y fija la contraseña de
  desarrollo de `crm_app`**. Esa contraseña se pone **fuera de banda**, nunca en una migración — una
  credencial en una migración es una credencial en el repositorio, en la imagen y en cada clon.

> ⚠️ **`db:seed` se niega si la base ya está sembrada, y tiene razón:** sembrar dos veces duplicaba las
> tarjetas y el total público.

---

## 4 · Correr

```bash
npm run dev
```

→ **http://localhost:3000**

El worker corre **dentro de este proceso** y lo dice al arrancar. `npm run worker` es sólo para la
topología separada; con el default plegado no hace falta.

> **Si el puerto 3000 está ocupado** (por ejemplo otra sesión de Claude Code levantó su propio dev
> server), corré `npx react-router dev --port 3100`. Ojo que `APP_URL` en `.env` asume :3000.

---

## 5 · Credenciales de prueba

**Contraseña para todos: `demo-password-1234`**

| Email | Vendedora/or | Para qué sirve en el demo |
|---|---|---|
| `renata@demo.test` | Renata Ochoa | **La cuenta principal.** Es "YOU" en el tablero. |
| `priya@demo.test` | Priya Nair | **#1 all-time.** Ningún spec la toca, así que su número **no se mueve**. |
| `marcus@demo.test` | Marcus Bell | #3 |
| `dana@demo.test` | Dana Reyes | #4 |
| `tomas@demo.test` | Tomás Guerra | **Cero ventas, a propósito.** Es el caso que probó que el tablero debía incluirlo igual. Ojo: el email va **sin tilde** — la primera versión del seed escribió `tomás@demo.test`, better-auth aceptó el alta y después el formulario de login no podía encontrarlo. |

---

## 6 · Cómo saber que quedó bien

Entrá con `renata@demo.test`. Aterrizás en **Earnings**. Tiene que verse esto:

- [ ] **El podio con las cinco personas**, Priya #1 y Renata #2 marcada **YOU**.
- [ ] **Tomás Guerra visible en la lista con $0.** Si no está, el tablero está excluyendo gente y eso
      es un defecto, no una optimización.
- [ ] **El selector de período** (Today / This week / This month / All time) **cambia el ranking**.
      Si los cuatro dan el mismo orden, el seed no abarcó los períodos.
- [ ] **El chip "Demo tenant — these numbers are seeded"** al pie.
- [ ] La nota **"Earnings tracked since …"** — el ledger arranca en el go-live, la historia importada
      no se cuenta.

Baseline de un demo **recién sembrado y sin derivar** (medido el 2026-08-07):

| | |
|---|---|
| Renata, all-time | **$9.029,88** — #2 |
| Priya, all-time | **$11.580** — #1 |
| Marcus | $8.088 — #3 · **Dana** $3.300 — #4 · **Tomás** $0 — #5 |

**Si el número de Renata es más alto que $9.029,88, alguien corrió `npm run test:e2e`.** Ver §8.

Después, en el tablero (`/pipeline`):

- [ ] Las tarjetas rinden **riel de salud** (un gradiente, no un color plano) y **chip de estado**.
- [ ] `Ctrl+K` abre la búsqueda global **desde cualquier pantalla**, y `Escape` devuelve el foco a lo
      que la abrió.
- [ ] Arrastrar a una columna *earning* **se rechaza** y abre la puerta de cierre.
- [ ] La columna **Closed Lost** tiene motivos en el select "Why?". Si está vacío, la base **rechaza
      todo movimiento** a esa columna y la columna es inusable.

---

## 7 · ⏳ La ventana de sesenta minutos — leer antes de un demo

**El estado `fresh` dura SESENTA MINUTOS desde `npm run db:seed`.** `fresh` es *cero intentos* **y**
*llegada de hace menos de una hora*, y el seed le da a Ruth Alvarez *"llegó cuando corrió el seed"*.

**Un tablero mostrado más de una hora después de sembrar no tiene ninguna tarjeta fresca:** ni riel
azul ni chip `NEW`. **Si el demo va a mostrar ese estado, hay que sembrar antes.**

La ventana **no se ensancha**: sesenta minutos es la definición del producto, y moverla para que pase
un test cambia la definición por comodidad.

---

## 8 · Resetear el demo

**Antes de un demo comercial, reseteá.** Cada corrida completa de `npm run test:e2e` acredita
**$3.720 reales** en el ledger de la vendedora con la que entra (`celebration.spec.ts` cierra un trato
de verdad — no existe versión de ese spec que no toque el ledger). El ledger es **append-only y no hay
job de recomputo**, por diseño: no se "corrige", se vuelve a sembrar. Ese crédito además cae en **hoy**,
así que mueve las pestañas Today / This week / This month.

```bash
npm run db:reset && npm run db:up && npm run db:migrate && npm run db:jobs && npm run db:seed
```

> **`npm run db:down` NO alcanza** — deja el volumen y las filas vuelven. `db:reset` es el que borra
> el volumen.

El CI corre el e2e contra su propia base efímera, así que allá esto no importa.

---

## 9 · Verificar que el repo está sano

```bash
npm run verify
```

= `typecheck` + `lint` + `format:check` + `test` + `perf`. **Verde antes de cada commit.**
Corrida de referencia del 2026-08-07: **26 archivos, 243 tests, ~53 s**, y los presupuestos
P12 111.068/128.000 · P13 2.462/16.384 con el cruce contra `ref.ci_ratchet` en verde.

```bash
npm run test:e2e
```

Playwright. Perfiles `desktop-ci`, `mobile-ci`, más `dnd-ci` (drag a 60 fps) y `lh-ci` (TTI con
Lighthouse). **Deriva el tenant demo — ver §8.**

---

## 10 · Cuando algo no arranca

| Síntoma | Causa | Arreglo |
|---|---|---|
| `JOBS002` al correr `npm run dev` | Falta `npm run db:jobs` | Corrélo. El mensaje nombra el comando. |
| `JOBS003` al correr `npm run db:jobs` | Lo corriste **antes** de `db:migrate` | `npm run db:migrate` primero. |
| La app no arranca y se queja del rol | `DATABASE_URL` apunta a un rol que puede saltear RLS | Usá `crm_app`, no el dueño. Es G4(a) haciendo su trabajo. |
| No existe `.env` | Está en `.gitignore` | `cp .env.example .env` + `SESSION_SECRET`. |
| `password authentication failed` para `crm_app` | Falta `npm run db:seed` (es quien la fija) | Corrélo. |
| El dev server anuncia el puerto y **muere en el primer request**, `ECONNRESET` | **Docker Desktop se cayó.** El pliegue es perezoso en dev, así que el fallo aparece recién en el primer request | Abrí Docker Desktop, `npm run db:up`. **No es el código.** |
| Puerto 3000 ocupado | Otra sesión levantó un dev server | `npx react-router dev --port 3100` |
| El tablero renderiza las 500 tarjetas pero **el drag nunca funciona** | Un componente importó un módulo de servidor y postgres viajó al bundle del navegador | Lo atrapa `scripts/client-server-boundary.test.ts`. El helper va a `app/lib/**`. |
| `db:seed` se niega | La base ya está sembrada | Es correcto. Si querés empezar de cero, §8. |

---

## 11 · Lo que **no** hay que hacer

- **No instales Postgres a mano.** El compose lo levanta con los mismos `POSTGRES_INITDB_ARGS` que usa
  el CI (`--locale-provider=icu --icu-locale=en-US`). Con otro locale, un orden correcto acá puede
  estar mal en la pantalla de un vendedor.
- **No edites una migración ya mergeada.** No hay down migrations: el rollback es la imagen anterior.
- **No corras `npm run test:e2e` justo antes de un demo comercial** sin resetear después.
