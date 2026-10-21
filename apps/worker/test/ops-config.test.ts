import { describe, expect, it } from 'vitest'
import { hashSubject, pepperKeyId, resolvePepper } from '@peerchive/db'
import { DEFAULT_CRONS, OPS_TASK_NAMES, cronEnvName, isCronExpression, loadOpsConfig } from '../src/ops/config'
import { parseLedgerEntry } from '../src/ops/ledger'

const STRONG = 'a3f1c9e07b5d4e2a8c6f0b1d9e7a5c3f'

describe('ops config', () => {
  it('uses default schedules, a 7-day grace period and dev peppers outside production', () => {
    const config = loadOpsConfig({ NODE_ENV: 'development' })
    expect(config.graceDays).toBe(7)
    expect(config.batchSize).toBe(500)
    expect(config.crons).toEqual(DEFAULT_CRONS)
    expect(Object.keys(config.crons)).toEqual([...OPS_TASK_NAMES])
    expect(config.deletionPepper).toMatch(/dev-only/)
    expect(config.analyticsPepper).not.toBe(config.deletionPepper)
  })

  it('overrides or turns off individual schedules and validates them', () => {
    expect(cronEnvName('account-purge')).toBe('PEERCHIVE_CRON_ACCOUNT_PURGE')
    const config = loadOpsConfig({ NODE_ENV: 'test', PEERCHIVE_CRON_ACCOUNT_PURGE: '* * * * *', PEERCHIVE_CRON_OUTBOX: 'off', PEERCHIVE_DELETION_GRACE_DAYS: '0' })
    expect(config.crons['account-purge']).toBe('* * * * *')
    expect(config.crons.outbox).toBeNull()
    expect(config.graceDays).toBe(0)
    expect(() => loadOpsConfig({ NODE_ENV: 'test', PEERCHIVE_CRON_SESSIONS: 'every hour' })).toThrow(/PEERCHIVE_CRON_SESSIONS/)
    expect(() => loadOpsConfig({ NODE_ENV: 'test', PEERCHIVE_DELETION_GRACE_DAYS: '-1' })).toThrow(/GRACE/)
    expect(isCronExpression('*/15 * * * *')).toBe(true)
    expect(isCronExpression('* * * *')).toBe(false)
    expect(isCronExpression("1 * * * *; rm")).toBe(false)
  })

  it('refuses to start in production without a strong deletion pepper; analytics pepper is optional', () => {
    expect(() => loadOpsConfig({})).toThrow(/PEERCHIVE_DELETION_PEPPER/)
    expect(() => loadOpsConfig({ PEERCHIVE_DELETION_PEPPER: 'short' })).toThrow(/PEERCHIVE_DELETION_PEPPER/)
    expect(() => loadOpsConfig({ PEERCHIVE_DELETION_PEPPER: 'dev-only-deletion-pepper-not-for-real-data' })).toThrow()
    const config = loadOpsConfig({ PEERCHIVE_DELETION_PEPPER: STRONG })
    expect(config.production).toBe(true)
    expect(config.analyticsPepper).toBeNull()
    expect(resolvePepper({ PEERCHIVE_ANALYTICS_PEPPER: STRONG }, 'PEERCHIVE_ANALYTICS_PEPPER')).toBe(STRONG)
  })

  it('hashes subjects deterministically per pepper without exposing the pepper', () => {
    const id = crypto.randomUUID()
    expect(hashSubject(STRONG, id)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSubject(STRONG, id.toUpperCase())).toBe(hashSubject(STRONG, id))
    expect(hashSubject(`${STRONG}x`, id)).not.toBe(hashSubject(STRONG, id))
    expect(pepperKeyId(STRONG)).toMatch(/^[0-9a-f]{8}$/)
    expect(STRONG).not.toContain(pepperKeyId(STRONG))
  })

  it('parses ledger lines strictly', () => {
    const ok = { subjectHash: 'a'.repeat(64), entityKind: 'profile', count: 1, requestedAt: null, purgedAt: '2027-01-01T00:00:00Z', source: 'purge' }
    expect(parseLedgerEntry(ok)).toEqual({ ...ok, purgedAt: '2027-01-01T00:00:00.000Z' })
    expect(parseLedgerEntry({ ...ok, subjectHash: 'user@example.com' })).toBeNull()
    expect(parseLedgerEntry({ ...ok, entityKind: 'Profile Name' })).toBeNull()
    expect(parseLedgerEntry({ ...ok, count: -1 })).toBeNull()
    expect(parseLedgerEntry({ ...ok, source: 'manual' })).toBeNull()
    expect(parseLedgerEntry({ ...ok, purgedAt: 'yesterday' })).toBeNull()
  })
})
