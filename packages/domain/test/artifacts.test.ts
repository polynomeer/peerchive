import { describe, expect, it } from 'vitest'
import {
  ALLOWED_MEDIA_TYPES,
  PROJECT_ROLES,
  SCAN_STATUSES,
  canAttachAsEvidence,
  canReadArtifactContent,
  canUploadArtifact,
  decideFileType,
  extensionMatches,
  fileExtension,
  isAllowedMediaType,
  isFinalScanStatus,
  isInlineMediaType,
  nextScanStatus,
  type Membership,
  type ProjectRole,
  type ScanEvent,
  type ScanStatus,
} from '../src'

const project = { id: 'p1' }
const m = (userId: string, role: ProjectRole, overrides: Partial<Membership> = {}): Membership => ({
  projectId: 'p1',
  userId,
  role,
  status: 'active',
  ...overrides,
})
const as = (userId: string) => ({ userId })

describe('canUploadArtifact', () => {
  it.each(PROJECT_ROLES)('only active owner/editor upload (%s)', (role) => {
    expect(canUploadArtifact(as('u1'), project, m('u1', role))).toBe(role === 'owner' || role === 'editor')
  })

  it('denies non-members, inactive members, anonymous, other-project memberships and admin bypass', () => {
    expect(canUploadArtifact(as('u1'), project, null)).toBe(false)
    expect(canUploadArtifact(as('u1'), project, m('u1', 'editor', { status: 'left' }))).toBe(false)
    expect(canUploadArtifact({ userId: null }, project, m('u1', 'owner'))).toBe(false)
    expect(canUploadArtifact(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }))).toBe(false)
    expect(canUploadArtifact(as('u1'), project, m('u2', 'owner'))).toBe(false)
    expect(canUploadArtifact({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
  })
})

describe('canReadArtifactContent', () => {
  it.each(SCAN_STATUSES)('members read content only when clean (%s)', (status) => {
    for (const role of PROJECT_ROLES) {
      expect(canReadArtifactContent(as('u1'), project, m('u1', role), status)).toBe(status === 'clean')
    }
  })

  it('never for non-members, former members, anonymous or admins, even when clean', () => {
    expect(canReadArtifactContent(as('u1'), project, null, 'clean')).toBe(false)
    expect(canReadArtifactContent(as('u1'), project, m('u1', 'viewer', { status: 'removed' }), 'clean')).toBe(false)
    expect(canReadArtifactContent({ userId: null }, project, m('u1', 'viewer'), 'clean')).toBe(false)
    expect(canReadArtifactContent({ userId: 'admin', isAdmin: true }, project, null, 'clean')).toBe(false)
    expect(canReadArtifactContent(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }), 'clean')).toBe(false)
  })
})

describe('nextScanStatus', () => {
  const table: Array<[ScanStatus, ScanEvent, ScanStatus | null]> = [
    ['pending', 'start', 'scanning'],
    ['scanning', 'start', 'scanning'], // 중단된 검사 재실행
    ['failed', 'start', 'scanning'], // 큐 자동 재시도
    ['clean', 'start', null],
    ['quarantined', 'start', null],
    ['scanning', 'pass', 'clean'],
    ['scanning', 'reject', 'quarantined'],
    ['scanning', 'error', 'failed'],
    ['pending', 'pass', null],
    ['pending', 'reject', null],
    ['failed', 'pass', null],
    ['clean', 'reject', null],
    ['quarantined', 'pass', null],
    ['failed', 'retry', 'pending'],
    ['pending', 'retry', null],
    ['clean', 'retry', null],
    ['quarantined', 'retry', null],
  ]
  it.each(table)('%s --%s--> %s', (current, event, expected) => {
    expect(nextScanStatus(current, event)).toBe(expected)
  })

  it('final states never change', () => {
    for (const status of SCAN_STATUSES.filter(isFinalScanStatus)) {
      for (const event of ['start', 'pass', 'reject', 'error', 'retry'] as const) {
        expect(nextScanStatus(status, event)).toBeNull()
      }
    }
    expect(SCAN_STATUSES.filter(isFinalScanStatus)).toEqual(['clean', 'quarantined'])
  })
})

describe('canAttachAsEvidence', () => {
  it('pending/scanning/clean can be attached; quarantined/failed cannot', () => {
    expect(SCAN_STATUSES.filter(canAttachAsEvidence)).toEqual(['pending', 'scanning', 'clean'])
  })
})

describe('allowed types and extensions', () => {
  it('allows only PNG, JPEG, WebP, GIF and PDF', () => {
    expect(ALLOWED_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])
    for (const t of ['image/svg+xml', 'text/html', 'application/zip', 'application/octet-stream', '', 'toString', 'constructor']) {
      expect(isAllowedMediaType(t)).toBe(false)
    }
  })

  it('reads the last extension in lower case and ignores directories and dotfiles', () => {
    expect(fileExtension('Report.Final.PDF')).toBe('pdf')
    expect(fileExtension('a/b\\c.png')).toBe('png')
    expect(fileExtension('.png')).toBe('')
    expect(fileExtension('noext')).toBe('')
    expect(fileExtension('x.png.exe')).toBe('exe')
  })

  it('matches declared type and extension', () => {
    expect(extensionMatches('image/jpeg', 'photo.JPG')).toBe(true)
    expect(extensionMatches('image/jpeg', 'photo.jpeg')).toBe(true)
    expect(extensionMatches('image/png', 'photo.jpg')).toBe(false)
    expect(extensionMatches('application/pdf', 'report.pdf.html')).toBe(false)
  })

  it('only images are inline', () => {
    expect(isInlineMediaType('image/png')).toBe(true)
    expect(isInlineMediaType('application/pdf')).toBe(false)
    expect(isInlineMediaType('image/svg+xml')).toBe(false)
  })
})

describe('decideFileType', () => {
  it('accepts when detected = declared and the extension fits', () => {
    expect(decideFileType('image/png', 'a.png', 'image/png')).toEqual({ ok: true, mediaType: 'image/png' })
    expect(decideFileType('application/pdf', '보고서.PDF', 'application/pdf')).toEqual({ ok: true, mediaType: 'application/pdf' })
  })

  it.each(['svg', 'html', 'xml', 'zip', 'ole', 'executable', 'script'] as const)('quarantines %s as disallowed', (kind) => {
    expect(decideFileType('image/png', 'a.png', kind)).toEqual({ ok: false, reason: 'disallowed_type' })
  })

  it('quarantines unknown content, mismatched declared type and mismatched extension', () => {
    expect(decideFileType('image/png', 'a.png', 'unknown')).toEqual({ ok: false, reason: 'unknown_type' })
    expect(decideFileType('image/png', 'a.png', 'image/gif')).toEqual({ ok: false, reason: 'type_mismatch' })
    expect(decideFileType('image/png', 'a.gif', 'image/png')).toEqual({ ok: false, reason: 'extension_mismatch' })
  })
})
