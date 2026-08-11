import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'

const [, , sourceFile] = process.argv
const databaseUrl = process.env.DATABASE_URL?.trim()

if (!databaseUrl) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}

if (!sourceFile) {
  console.error('Usage: DATABASE_URL=postgres://... node services/api/scripts/migrate-admin-json-to-postgres.mjs /path/admin-config.json')
  process.exit(1)
}

const raw = await readFile(sourceFile, 'utf8')
const payload = JSON.parse(raw)

const summary = {
  users: payload.users?.length ?? 0,
  assets: payload.generatedAssets?.length ?? 0,
  usage: payload.usageLedger?.length ?? 0,
  rechargeOrders: payload.rechargeOrders?.length ?? 0,
  hasAdmin: Boolean(payload.adminAuth),
  hasImageKey: Boolean(payload.imageSkillApiKey),
  hasVideoKey: Boolean(payload.videoSkillApiKey),
  modelKeyCount: Object.values(payload.modelProviderApiKeys ?? {}).filter(Boolean).length,
  hasPaymentKey: Boolean(payload.paymentGatewayKey),
}

const pool = new Pool({ connectionString: databaseUrl })
try {
  await pool.query(`
    create table if not exists moyuan_admin_state (
      id text primary key,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `)
  await pool.query(
    `
      insert into moyuan_admin_state (id, payload, created_at, updated_at)
      values ($1, $2::jsonb, now(), now())
      on conflict (id) do update set payload = excluded.payload, updated_at = now()
    `,
    ['main', JSON.stringify(payload)],
  )
  console.log(JSON.stringify({ migrated: true, sourceFile, summary }, null, 2))
} finally {
  await pool.end()
}
