/**
 * Turns `contracts/events/catalog.json` into `app/lib/events/catalog.generated.ts`.
 *
 * CLAUDE.md describes app/lib/events/** as "the 49-event contract, generated
 * from contracts/events/". This is the generator that sentence assumed.
 *
 * WHY GENERATE INSTEAD OF HAND-WRITING THE TYPES. The catalog is 49 events with
 * an emitter, a consumer list and a payload each. Hand-maintaining a TypeScript
 * mirror of that is a second source of truth, and a second source of truth for
 * an event name is precisely the failure §2 of 02b spent a whole reconciliation
 * pass removing — 262 declared events, forty real ones, and every collision a
 * silent integration failure. One source, generated, with a test that fails on
 * drift, is the only shape that keeps the count honest.
 *
 * The output is formatted with the repository's own prettier config so that
 * `npm run format:check` is satisfied by the generator rather than by a human
 * remembering to run `npm run format` after regenerating — and so that the
 * drift test can compare strings byte for byte.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { format, resolveConfig } from 'prettier'

const CONTRACT = 'contracts/events/catalog.json'
const OUTPUT = 'app/lib/events/catalog.generated.ts'

/** The type vocabulary the contract is allowed to use. */
const PRIMITIVES: Readonly<Record<string, string>> = {
  uuid: 'string',
  string: 'string',
  int: 'number',
  bool: 'boolean',
  money: 'Money',
  ts: 'string',
  ts_ms: 'number',
  'uuid[]': 'readonly string[]',
  'string[]': 'readonly string[]',
  json: 'JsonValue',
  'json[]': 'readonly JsonValue[]',
}

interface ContractEvent {
  readonly name: string
  readonly emitter: string
  readonly amendment?: number
  readonly payload: Readonly<Record<string, string>> | 'derived'
  readonly payload_fields?: Readonly<Record<string, string>>
  readonly consumers: readonly string[]
  readonly note: string
}

interface ContractGhost {
  readonly ghost: string
  readonly use: string
  readonly consequence: string
}

interface Contract {
  readonly count: { readonly core: number; readonly amendment_1: number; readonly total: number }
  readonly envelope: { readonly fields: Readonly<Record<string, string>> }
  readonly events: readonly ContractEvent[]
  readonly ghosts: { readonly names: readonly ContractGhost[] }
}

export function readContract(): Contract {
  return JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract
}

/** The declared fields of an event, whether ratified in §4 or derived in §4b. */
export function fieldsOf(event: ContractEvent): Readonly<Record<string, string>> {
  if (event.payload === 'derived') {
    if (event.payload_fields === undefined) {
      throw new Error(`${event.name} is marked derived but declares no payload_fields`)
    }
    return event.payload_fields
  }
  return event.payload
}

/** `enum:won|lost?` and `uuid?` both mean "or null"; everything else is a lookup. */
export function tsType(spec: string): string {
  if (spec.startsWith('enum:')) {
    const body = spec.slice('enum:'.length)
    const nullable = body.endsWith('?')
    const members = (nullable ? body.slice(0, -1) : body).split('|')
    const union = members.map((member) => `'${member}'`).join(' | ')
    return nullable ? `${union} | null` : union
  }

  const nullable = spec.endsWith('?')
  const base = nullable ? spec.slice(0, -1) : spec
  const mapped = PRIMITIVES[base]
  if (mapped === undefined) {
    throw new Error(`unknown type "${spec}" in ${CONTRACT} — the vocabulary is closed on purpose`)
  }
  return nullable ? `${mapped} | null` : mapped
}

/** `opportunity.stage_changed` → `OpportunityStageChanged`. */
export function pascal(name: string): string {
  return name
    .split(/[.\-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function payloadInterface(event: ContractEvent): string {
  const fields = Object.entries(fieldsOf(event))
    .map(([field, spec]) => `  readonly ${field}: ${tsType(spec)}`)
    .join('\n')
  const provenance =
    event.payload === 'derived'
      ? `\n *\n * PAYLOAD IS DERIVED, NOT RATIFIED. Amendment 1 gave this event an emitter, a\n * trigger and a rationale but no field list; these fields follow from those and\n * the module that first emits it should settle them.`
      : ''
  return `/**\n * ${event.note}${provenance}\n */\nexport interface ${pascal(event.name)}Payload {\n${fields}\n}`
}

export async function renderCatalog(): Promise<string> {
  const contract = readContract()
  const { events, ghosts } = contract

  const names = events.map((event) => event.name)
  const header = `/**
 * GENERATED FROM ${CONTRACT} — DO NOT EDIT.
 *
 * Run \`npm run events:generate\`. \`scripts/events-contract.test.ts\` fails the
 * build when this file and the contract disagree, in both directions.
 *
 * The catalog is ${contract.count.total}: ${contract.count.core} from §4 of docs/02b-integration-map.md and
 * ${contract.count.amendment_1} from its Amendment 1. An event outside it is a bug, not a feature.
 */

import type { Money } from '~/lib/money/money'

/** Structured payload fields the contract types as \`json\`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }`

  const envelope = `/**
 * §3. Not one of the 262 originally-declared events carried an envelope; this
 * is the missing spine and it is non-negotiable.
 *
 * Default-deny scoping: every consumer filters by \`tenant_id\` and — unless it
 * is the leaderboard projection, the one legitimate cross-silo broadcast — by
 * \`owner_user_id\`. \`event_id\` is the idempotency key because Aloware WILL
 * deliver twice, and \`recorded_at_utc_ms\` is separate from
 * \`occurred_at_utc_ms\` so a webhook forty seconds late still threads correctly.
 */
export interface EventEnvelope {
${Object.entries(contract.envelope.fields)
  .map(([field, spec]) => `  readonly ${field}: ${tsType(spec)}`)
  .join('\n')}
}`

  const nameUnion = `/** Every canonical event name, in catalog order. */
export const EVENT_NAMES = [
${names.map((name) => `  '${name}',`).join('\n')}
] as const

/**
 * THE MECHANISM. \`emit\` is typed on this union, so an invented event name is a
 * compile error rather than a runtime surprise nobody notices.
 */
export type EventName = (typeof EVENT_NAMES)[number]`

  const payloads = events.map(payloadInterface).join('\n\n')

  const payloadMap = `/** Name → payload, so a handler cannot read a field the event does not carry. */
export interface EventPayloads {
${events.map((event) => `  readonly '${event.name}': ${pascal(event.name)}Payload`).join('\n')}
}

/** An event on the wire: the envelope, its name, and the payload that name implies. */
export type CanonicalEvent<N extends EventName = EventName> = {
  readonly [K in N]: EventEnvelope & { readonly name: K; readonly payload: EventPayloads[K] }
}[N]`

  const emitters = `/** The single module allowed to emit each event. Two emitters is two truths. */
export const EVENT_EMITTERS: { readonly [N in EventName]: string } = {
${events.map((event) => `  '${event.name}': '${event.emitter}',`).join('\n')}
}

/** Declared consumers, from the catalog. A consumer nobody registered is a consumer nobody notices going quiet. */
export const EVENT_CONSUMERS: { readonly [N in EventName]: readonly string[] } = {
${events
  .map((event) => `  '${event.name}': [${event.consumers.map((c) => `'${c}'`).join(', ')}],`)
  .join('\n')}
}`

  const moneyFields = `/**
 * Payload fields carrying \`Money\`, per event.
 *
 * Money is \`bigint\` cents behind a branded type and crosses JSON as a string of
 * whole cents, never a JS number. A serialiser that misses one field ships a
 * float onto a public leaderboard, so the list is generated rather than
 * remembered.
 */
export const MONEY_FIELDS: { readonly [N in EventName]: readonly string[] } = {
${events
  .map((event) => {
    const money = Object.entries(fieldsOf(event))
      .filter(([, spec]) => spec === 'money' || spec === 'money?')
      .map(([field]) => `'${field}'`)
    return `  '${event.name}': [${money.join(', ')}],`
  })
  .join('\n')}
}`

  const ghostBlock = `/** A name that was ruled out, what to use instead, and what breaks if you don't. */
export interface Ghost {
  /** The canonical event to use, or \`null\` when the name was deleted outright. */
  readonly use: EventName | null
  readonly consequence: string
}

/**
 * THE HALF THAT ACTUALLY CATCHES THINGS. §2 of 02b calls the ghosts the real
 * finding: a module waiting for \`opportunity.closed_won\` never fires on a sale
 * and nothing anywhere goes red. A positive registry sees an unknown name; this
 * map knows the name was RULED OUT and can say what the silence costs.
 */
export const GHOSTS: { readonly [name: string]: Ghost } = {
${ghosts.names
  .map(
    (ghost) =>
      `  '${ghost.ghost}': { use: ${ghost.use === '' ? 'null' : `'${ghost.use}'`}, consequence: ${JSON.stringify(ghost.consequence)} },`,
  )
  .join('\n')}
}`

  const source = [
    header,
    envelope,
    nameUnion,
    payloads,
    payloadMap,
    emitters,
    moneyFields,
    ghostBlock,
  ].join('\n\n')

  const prettierConfig = await resolveConfig(OUTPUT)
  return format(source, { ...prettierConfig, parser: 'typescript' })
}

async function main(): Promise<void> {
  const rendered = await renderCatalog()
  writeFileSync(OUTPUT, rendered)
  const contract = readContract()
  process.stdout.write(`${OUTPUT} — ${String(contract.events.length)} events, `)
  process.stdout.write(`${String(contract.ghosts.names.length)} ghosts\n`)
}

// Only when run as a command, so the test can import the renderer without
// writing to the tree.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
