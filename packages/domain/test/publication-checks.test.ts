import { describe, expect, it } from 'vitest'
import {
  LONG_CODE_LINES,
  findAnonymousNames,
  findEmails,
  findPrivateRepoRefs,
  findPhoneNumbers,
  findPrivateUrls,
  findResidentIds,
  findStudentIds,
  isPrivateUrl,
  longestCodeBlock,
  looksLikeAnswerFile,
  maskSample,
  runPublicationChecks,
  type CheckItem,
} from '../src'

describe('phone numbers', () => {
  it('finds Korean mobile and landline numbers with or without separators', () => {
    expect(findPhoneNumbers('연락: 010-1234-5678')).toEqual(['010-1234-5678'])
    expect(findPhoneNumbers('01012345678로 문자')).toEqual(['01012345678'])
    expect(findPhoneNumbers('011 234 5678')).toEqual(['011 234 5678'])
    expect(findPhoneNumbers('사무실 02-123-4567, 031)123-4567')).toEqual(['02-123-4567', '031)123-4567'])
  })

  it('ignores dates, versions, longer digit runs and numbers inside identifiers', () => {
    expect(findPhoneNumbers('2026-10-20 회의, 버전 10.1.2')).toEqual([])
    expect(findPhoneNumbers('0101234567890')).toEqual([])
    expect(findPhoneNumbers('id a01012345678')).toEqual([])
    // 구분자 없는 0으로 시작하는 수(지역번호처럼 보이는)는 전화로 보지 않습니다.
    expect(findPhoneNumbers('offset 0212345678')).toEqual([])
  })
})

describe('emails', () => {
  it('finds addresses', () => {
    expect(findEmails('메일 kim.student@univ.ac.kr 로')).toEqual(['kim.student@univ.ac.kr'])
  })

  it('ignores annotations, example domains, localhost and git SSH remotes', () => {
    expect(findEmails('@Component class, user@localhost, a@b')).toEqual([])
    expect(findEmails('noreply@example.com, dev@team.test')).toEqual([])
    expect(findEmails('git clone git@github.com:org/repo.git')).toEqual([])
  })
})

describe('resident registration numbers', () => {
  it('finds birthdate + gender digit patterns', () => {
    expect(findResidentIds('990101-1234567')).toEqual(['990101-1234567'])
    expect(findResidentIds('주민번호 0203154123456 입니다')).toEqual(['0203154123456'])
  })

  it('ignores impossible dates, other gender digits and long timestamps', () => {
    expect(findResidentIds('991399-1234567')).toEqual([])
    expect(findResidentIds('990101-9234567')).toEqual([])
    expect(findResidentIds('timestamp 1697712345678')).toEqual([])
  })
})

describe('student ids', () => {
  it('finds 8–10 digit numbers that start with an entry year', () => {
    expect(findStudentIds('학번 2019123456')).toEqual(['2019123456'])
    expect(findStudentIds('21학번 아님, 201912345')).toEqual(['201912345'])
  })

  it('ignores dates, units, hashes, decimals, grouped numbers and other prefixes', () => {
    expect(findStudentIds('마감 20261020')).toEqual([])
    expect(findStudentIds('버퍼 20480000 bytes, 20480000원')).toEqual([])
    expect(findStudentIds('commit a2019123456b, 2019abcd')).toEqual([])
    expect(findStudentIds('3.2019123456, 2,019,123,456')).toEqual([])
    expect(findStudentIds('12345678, 1234567890')).toEqual([])
    expect(findStudentIds('20191234567890')).toEqual([])
  })
})

describe('private urls', () => {
  it('flags loopback, private ranges and internal host names', () => {
    for (const url of [
      'http://localhost:3000/projects/1',
      'http://127.0.0.1/admin',
      'https://10.0.0.5/x',
      'http://172.20.1.1',
      'http://192.168.0.10:8080',
      'http://169.254.169.254/latest',
      'http://[::1]:3000',
      'https://wiki.corp/page',
      'http://nas.local/share',
    ]) {
      expect(isPrivateUrl(url), url).toBe(true)
    }
  })

  it('does not flag public hosts, IPs in paths or look-alike names', () => {
    for (const url of [
      'https://github.com/org/repo',
      'https://8.8.8.8/',
      'http://172.32.0.1',
      'https://example.com/10.0.0.1',
      'https://192.168.example.com',
      'https://localhost.example.com',
      'not a url',
    ]) {
      expect(isPrivateUrl(url), url).toBe(false)
    }
    expect(findPrivateUrls('참고 https://github.com/a 와 http://localhost:5173/debug)')).toEqual(['http://localhost:5173/debug'])
  })
})

describe('answer-like file names', () => {
  it('flags problem sheets and answers in Korean and English', () => {
    for (const name of ['중간고사 문제지.pdf', '3주차_정답.png', '답안지.pdf', '기출 모음.pdf', 'hw2-solution.pdf', 'Answers.PDF', 'answer_key.png', 'lab3 solutions.zip']) {
      expect(looksLikeAnswerFile(name), name).toBe(true)
    }
  })

  it('ignores words that merely contain the English keywords', () => {
    for (const name of ['resolution.png', 'dissolution-test.pdf', 'answering-machine.png', '발표자료.pdf', 'final-report.pdf']) {
      expect(looksLikeAnswerFile(name), name).toBe(false)
    }
  })
})

describe('long code blocks', () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `  x${i} = f(x${i - 1});`).join('\n')

  it('flags long fenced blocks and long runs of code-like lines', () => {
    expect(longestCodeBlock(['설명', '```c', code(LONG_CODE_LINES), '```'].join('\n'))).toBe(LONG_CODE_LINES)
    expect(longestCodeBlock(code(20))).toBe(20)
    // 닫히지 않은 울타리도 코드로 봅니다.
    expect(longestCodeBlock(['```', ...Array.from({ length: 16 }, (_, i) => `line ${i}`)].join('\n'))).toBe(16)
  })

  it('ignores short snippets and long prose', () => {
    expect(longestCodeBlock(['```', code(5), '```'].join('\n'))).toBe(0)
    expect(longestCodeBlock(Array.from({ length: 30 }, (_, i) => `${i}번째 문장은 평범한 설명입니다.`).join('\n'))).toBe(0)
    // 짧은 코드 줄이 문단 사이에 흩어져 있으면 연속으로 세지 않습니다.
    const scattered = Array.from({ length: 30 }, (_, i) => (i % 2 ? '  return x;' : '설명 문장')).join('\n')
    expect(longestCodeBlock(scattered)).toBe(0)
  })
})

describe('anonymous names', () => {
  it('finds names of anonymous members, case-insensitively, ignoring 1-letter names', () => {
    expect(findAnonymousNames('김민수가 API를 맡음, Alex review', ['김민수', 'alex', '이'])).toEqual(['김민수', 'alex'])
    expect(findAnonymousNames('팀원 A가 맡음', ['김민수'])).toEqual([])
  })
})

describe('runPublicationChecks', () => {
  const at = (kind: CheckItem['kind'], value: string, key = 'l1', field = 'body'): CheckItem => ({
    kind,
    value,
    location: { kind: 'log', key, field },
  })

  it('reports rule, location and a masked sample (never the full value)', () => {
    const warnings = runPublicationChecks([
      at('text', '연락은 010-1234-5678 또는 kim.student@univ.ac.kr'),
      at('text', '주민 990101-1234567', 'l2'),
      at('url', 'http://192.168.0.10:8080/admin', 'l2', 'links.0.url'),
      { kind: 'file_name', value: 'hw2-solution.pdf', location: { kind: 'artifact', key: 'v1', field: 'fileName' } },
      at('text', '김민수 담당', 'l3'),
    ], { anonymousNames: ['김민수'] })
    expect(warnings).toEqual([
      { rule: 'phone', location: { kind: 'log', key: 'l1', field: 'body' }, sample: '010-****-**78' },
      { rule: 'email', location: { kind: 'log', key: 'l1', field: 'body' }, sample: 'ki*.*******@****.*c.kr' },
      { rule: 'resident_id', location: { kind: 'log', key: 'l2', field: 'body' }, sample: '******-*******' },
      { rule: 'private_url', location: { kind: 'log', key: 'l2', field: 'links.0.url' }, sample: '192.168.0.10:8080' },
      { rule: 'answer_file', location: { kind: 'artifact', key: 'v1', field: 'fileName' }, sample: 'hw2-solution.pdf' },
      { rule: 'anonymous_name', location: { kind: 'log', key: 'l3', field: 'body' }, sample: '김**' },
    ])
    expect(JSON.stringify(warnings)).not.toContain('1234-5678')
    expect(JSON.stringify(warnings)).not.toContain('kim.student')
  })

  it('reports each finding once per location and nothing for clean text', () => {
    expect(runPublicationChecks([at('text', '010-1234-5678, 010-1234-5678')])).toHaveLength(1)
    expect(runPublicationChecks([at('text', '2026-10-20 회의에서 범위를 줄이기로 했다. https://github.com/org/repo')])).toEqual([])
    expect(runPublicationChecks([at('text', '')])).toEqual([])
  })

  it('warns pdf_metadata for PDFs with author properties, using only the stored masked sample', () => {
    const warnings = runPublicationChecks([], {
      pdfAuthorMetadata: [
        { artifactVersionId: 'v1', sample: 'Author: 홍**' },
        { artifactVersionId: 'v1', sample: 'Author: 홍**' },
      ],
    })
    expect(warnings).toEqual([
      { rule: 'pdf_metadata', location: { kind: 'artifact', key: 'v1', field: 'metadata' }, sample: 'Author: 홍**' },
    ])
  })

  it('masks short values completely', () => {
    expect(maskSample('abc')).toBe('***')
    expect(maskSample('2019123456', 2, 0)).toBe('20********')
  })
})

describe('private GitHub repository links (E-11)', () => {
  const repos = ['https://github.com/team/capstone']

  it('matches the repository itself and paths under it, ignoring case', () => {
    expect(findPrivateRepoRefs('https://github.com/team/capstone', repos)).toEqual(['team/capstone'])
    expect(findPrivateRepoRefs('커밋 https://github.com/Team/Capstone/commit/abc 참고', repos)).toEqual(['team/capstone'])
    expect(findPrivateRepoRefs('(https://github.com/team/capstone/pull/3)', repos)).toEqual(['team/capstone'])
  })

  it('does not match other repositories with a longer name or no repositories', () => {
    expect(findPrivateRepoRefs('https://github.com/team/capstone-public', repos)).toEqual([])
    expect(findPrivateRepoRefs('https://github.com/other/capstone', repos)).toEqual([])
    expect(findPrivateRepoRefs('https://github.com/team/capstone', [])).toEqual([])
  })

  it('warns on log links and text but not on file names', () => {
    const items: CheckItem[] = [
      { kind: 'url', location: { kind: 'log', key: 'l1', field: 'links.0.url' }, value: 'https://github.com/team/capstone/pull/7' },
      { kind: 'text', location: { kind: 'log', key: 'l2', field: 'body' }, value: '저장소 https://github.com/team/capstone 에서' },
      { kind: 'file_name', location: { kind: 'artifact', key: 'v1', field: 'fileName' }, value: 'https://github.com/team/capstone' },
    ]
    const warnings = runPublicationChecks(items, { privateRepoUrls: repos }).filter((w) => w.rule === 'github_private')
    expect(warnings.map((w) => w.location.key)).toEqual(['l1', 'l2'])
    expect(warnings[0]!.sample).toBe('team/capstone')
    expect(runPublicationChecks(items).some((w) => w.rule === 'github_private')).toBe(false)
  })
})
