/**
 * 빌드 로그 입력 검증 (T-04, PROOFU_EVOLUTION_PLAN §6.2, SYSTEM_DESIGN §6.3).
 *
 * - 태그별 payload는 정해진 키만 받습니다(모르는 키는 422 unknown_key).
 * - 오류 경로는 `payload.symptom`, `links.0.url`처럼 필드별 코드로 돌려줍니다.
 * - 근거 링크는 http/https만 받고, 서버는 그 URL을 가져오지 않습니다(SSRF·추적 방지).
 * - DB가 필요한 검사(해결 대상, 회의 참석자)는 서비스(logs.ts)가 합니다.
 */
import { z } from 'zod'
import { BODY_REQUIRED_TAGS, LOG_TAGS, type LogTag } from '@peerchive/domain'
import { issuesToFields } from '../validation'
import type { LogLinkDto, LogPayload } from '../../../shared/types/api'

export const BODY_MAX = 5000
export const LINKS_MAX = 10
export const TIME_BUCKETS = ['lt30m', 'lt2h', 'half_day', 'day_plus'] as const

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

/** 모르는 키는 unknown_key, 객체가 아니면 required/invalid. */
const strictError = (issue: { code?: string; input?: unknown }) =>
  issue.code === 'unrecognized_keys' ? 'unknown_key' : issue.input === undefined ? 'required' : 'invalid'

const text = (max: number) =>
  z
    .string({ error: requiredOr('invalid') })
    .trim()
    .min(1, { error: 'required' })
    .max(max, { error: 'too_long' })

/** 선택 문자열. 빈 문자열은 키를 빼고 저장합니다. */
const optionalText = (max: number) =>
  z
    .string({ error: 'invalid' })
    .trim()
    .max(max, { error: 'too_long' })
    .nullish()
    .transform((value) => (value ? value : undefined))

const list = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item, { error: 'invalid' }).max(max, { error: 'too_many' })

const timeBucket = z.enum(TIME_BUCKETS, { error: requiredOr('invalid') })

const PAYLOAD_SCHEMAS = {
  progress: z.strictObject({}, { error: strictError }),
  retro: z.strictObject({}, { error: strictError }),
  stuck: z.strictObject(
    {
      symptom: text(200),
      keywords: list(text(40), 10).default([]),
      errorText: optionalText(2000),
      attempts: list(text(500), 10).default([]),
      timeBucket,
      // 막힘 로그 작성 시 "적은 내용이 과제 답 자체가 아님"을 확인했는지(선택, §6.2).
      answerCheck: z.boolean({ error: 'invalid' }).default(false),
    },
    { error: strictError },
  ),
  solution: z.strictObject(
    {
      method: text(2000),
      timeBucket: timeBucket.optional(),
      // 해결 방법은 과제 답 자체가 아님을 확인해야 저장합니다(§6.2).
      notAnswerConfirmed: z.literal(true, { error: 'confirm_required' }),
    },
    { error: strictError },
  ),
  decision: z.strictObject(
    {
      options: list(text(200), 6).min(2, { error: 'too_few' }),
      criteria: text(1000),
      // 선택지 중 하나가 아니어도 됩니다(예: "둘 다 버리고 제3안").
      choice: text(200),
      hindsight: optionalText(2000),
    },
    { error: strictError },
  ),
  validation: z.strictObject(
    {
      target: text(1000),
      conditions: text(1000),
      result: text(1000),
      openQuestions: optionalText(1000),
    },
    { error: strictError },
  ),
  meeting: z.strictObject(
    {
      // 같은 프로젝트 멤버인지는 서비스가 확인합니다. 중복은 하나로 합칩니다.
      attendees: list(z.uuid({ error: 'invalid' }), 20)
        .default([])
        .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
      decisions: list(text(500), 20).default([]),
      followUps: list(text(500), 20).default([]),
    },
    { error: strictError },
  ),
} satisfies Record<LogTag, z.ZodType>

/** URL이 http/https이고 계정 정보가 없는지. javascript:, data:, file: 등은 거부합니다. */
export function isAllowedLinkUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  return url.hostname.length > 0
}

const linkSchema = z.strictObject(
  {
    url: z
      .string({ error: requiredOr('invalid') })
      .trim()
      .min(1, { error: 'required' })
      .max(2000, { error: 'too_long' })
      .refine(isAllowedLinkUrl, { error: 'invalid_url' })
      .transform((value) => new URL(value).href),
    title: z
      .string({ error: 'invalid' })
      .trim()
      .max(200, { error: 'too_long' })
      .nullish()
      .transform((value) => (value ? value : null)),
  },
  { error: strictError },
)

export const linksSchema = list(linkSchema, LINKS_MAX)

const bodySchema = z.string({ error: 'invalid' }).trim().max(BODY_MAX, { error: 'too_long' })

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 실제 달력 날짜인 YYYY-MM-DD. */
export const claimedDateSchema = z
  .string({ error: 'invalid' })
  .regex(DATE_PATTERN, { error: 'invalid_format' })
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }, { error: 'invalid_format' })

/** 파일 근거(같은 프로젝트의 산출물 버전 id, 최대 10개). 중복은 하나로 합치고 순서를 유지합니다. */
export const EVIDENCE_MAX = 10
const evidenceVersionIdsSchema = z
  .array(z.uuid({ error: 'invalid' }), { error: 'invalid' })
  .max(EVIDENCE_MAX, { error: 'too_many' })
  .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))])

const expectedRevision = z
  .number({ error: requiredOr('invalid') })
  .int({ error: 'invalid' })
  .min(1, { error: 'invalid' })

/** POST /projects/:id/logs. payload는 tag를 안 뒤에 따로 검증합니다. */
export const createLogSchema = z.object({
  tag: z.enum(LOG_TAGS, { error: requiredOr('invalid') }),
  body: bodySchema.nullish(),
  payload: z.unknown().optional(),
  links: linksSchema.nullish(),
  claimedDate: claimedDateSchema.nullish(),
  resolvesEntryId: z.uuid({ error: 'invalid' }).nullish(),
  evidenceVersionIds: evidenceVersionIdsSchema.nullish(),
  /** 이 로그가 속한 마일스톤(같은 프로젝트, 선택, T-06). */
  milestoneId: z.uuid({ error: 'invalid' }).nullish(),
  /** 재전송 중복 방지용 클라이언트 생성 UUID(선택). */
  clientId: z.uuid({ error: 'invalid' }).optional(),
})

/**
 * POST /logs/:id/revisions. 생략한 필드(undefined)는 이전 revision 값을 이어받고, null은 비웁니다.
 * payload는 전체를 다시 보냅니다(부분 병합 없음). tag는 바꿀 수 없으며 보낸다면 현재 태그와 같아야 합니다.
 */
export const reviseLogSchema = z.object({
  expectedRevision,
  tag: z.unknown().optional(),
  body: bodySchema.nullish(),
  payload: z.unknown().optional(),
  links: linksSchema.nullish(),
  claimedDate: claimedDateSchema.nullish(),
  resolvesEntryId: z.uuid({ error: 'invalid' }).nullish(),
  evidenceVersionIds: evidenceVersionIdsSchema.nullish(),
  milestoneId: z.uuid({ error: 'invalid' }).nullish(),
})

/** 목록 조회 쿼리. */
export const listLogsQuerySchema = z.object({
  tag: z.enum(LOG_TAGS, { error: 'invalid' }).optional(),
  author: z.uuid({ error: 'invalid' }).optional(),
  /** 현재 revision이 이 마일스톤에 속한 로그만(T-06). */
  milestone: z.uuid({ error: 'invalid' }).optional(),
  cursor: z.string({ error: 'invalid' }).max(200, { error: 'invalid' }).optional(),
  limit: z.coerce
    .number({ error: 'invalid' })
    .int({ error: 'invalid' })
    .min(1, { error: 'invalid' })
    .max(50, { error: 'invalid' })
    .default(20),
})

/** 검증을 마친 로그 내용(한 revision에 저장할 값). */
export interface LogContent {
  body: string
  payload: LogPayload
  links: LogLinkDto[]
  claimedDate: string | null
  resolvesEntryId: string | null
  /** 같은 프로젝트의 마일스톤(존재·프로젝트 확인은 서비스가 함). */
  milestoneId: string | null
}

/** UTC 기준 오늘 + 1일까지 허용합니다(한국 시간 오늘을 포함하도록 하루 여유). */
export function latestAllowedClaimedDate(now: Date): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 태그에 맞게 내용을 검증합니다. DB 없이 할 수 있는 검사만 하며, 오류는 필드별 코드 맵으로 돌려줍니다.
 * - body: progress·retro는 필수, 나머지는 선택(최대 5000자)
 * - payload: 태그별 스키마(progress·retro는 빈 객체이며 생략 가능)
 * - resolvesEntryId: solution은 필수, 그 밖의 태그는 허용하지 않음
 * - claimedDate: 내일(UTC 기준 +1일)보다 미래면 거부. 이전 revision에서 이어받은(바뀌지 않은) 값은 다시 검사하지 않습니다.
 */
export function validateLogContent(
  tag: LogTag,
  input: {
    body: string
    payload: unknown
    links: LogLinkDto[]
    claimedDate: string | null
    resolvesEntryId: string | null
    milestoneId?: string | null
  },
  now: Date,
  previousClaimedDate?: string | null,
): { content: LogContent; fields: null } | { content: null; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  if (BODY_REQUIRED_TAGS.includes(tag) && input.body.length === 0) fields.body = 'required'

  const rawPayload = input.payload === undefined && BODY_REQUIRED_TAGS.includes(tag) ? {} : input.payload
  const parsed = PAYLOAD_SCHEMAS[tag].safeParse(rawPayload)
  if (!parsed.success) Object.assign(fields, issuesToFields(parsed.error.issues, 'payload'))

  if (tag === 'solution' && !input.resolvesEntryId) fields.resolvesEntryId = 'required'
  if (tag !== 'solution' && input.resolvesEntryId) fields.resolvesEntryId = 'not_allowed'

  if (
    input.claimedDate &&
    input.claimedDate !== previousClaimedDate &&
    input.claimedDate > latestAllowedClaimedDate(now)
  ) {
    fields.claimedDate = 'too_far_future'
  }

  if (Object.keys(fields).length > 0 || !parsed.success) return { content: null, fields }
  return {
    content: {
      body: input.body,
      // undefined 값(빈 선택 필드)은 JSON 저장 때 빠집니다.
      payload: JSON.parse(JSON.stringify(parsed.data)) as LogPayload,
      links: input.links,
      claimedDate: input.claimedDate,
      resolvesEntryId: input.resolvesEntryId,
      milestoneId: input.milestoneId?.toLowerCase() ?? null,
    },
    fields: null,
  }
}
