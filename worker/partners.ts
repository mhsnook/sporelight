import { z } from 'zod'

export const orgIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{2,62}$/, 'Use 3 to 63 lowercase letters, digits and hyphens, starting with a letter or digit.')
export const partnerSecretSchema = z.string().min(16, 'Use at least 16 characters.').max(200)

export type Partner = { id: string; org: string; claimed: boolean }

// Workers refuses PBKDF2 above 100,000 iterations.
const ITERATIONS = 100_000

const toHex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))

async function hashSecret(secret: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256)
}

// Claims `org` for this secret if nobody holds it, or checks the secret against
// the one it was claimed with. Two first posts at once both try the insert; the
// one that loses is checked against the winner's secret.
export async function identifyPartner(db: D1Database, org: string, secret: string, now = new Date().toISOString()): Promise<Partner | null> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const id = crypto.randomUUID()
  await db
    .prepare(`INSERT INTO partners (id, org, secret_salt, secret_hash, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (org) DO NOTHING`)
    .bind(id, org, toHex(salt), toHex(await hashSecret(secret, salt)), now)
    .run()
  const row = await db.prepare(`SELECT id, secret_salt, secret_hash FROM partners WHERE org = ?`).bind(org).first<{ id: string; secret_salt: string; secret_hash: string }>()
  if (!row) return null
  if (row.id === id) return { id, org, claimed: true }
  const given = await hashSecret(secret, fromHex(row.secret_salt))
  if (!crypto.subtle.timingSafeEqual(given, fromHex(row.secret_hash))) return null
  await db.prepare(`UPDATE partners SET last_used_at = ? WHERE id = ?`).bind(now, row.id).run()
  return { id: row.id, org, claimed: false }
}
