/**
 * 공개 준비·동의 화면 문구(T-11). 상태는 색이 아니라 글자로 보여 줍니다.
 */
import type {
  CandidateStatus,
  ConsentStatus,
  LogSource,
  PublicationBlockerDto,
  PublicationCheckRule,
  PublicationLevel,
  PublicationStatus,
  UsageTerms,
} from '~~/shared/types/api'

export const PUBLIC_TITLE_MAX = 80
export const PUBLIC_SUMMARY_MAX = 1000
export const CONSENT_NOTE_MAX = 300

export const LEVEL_LABELS: Record<PublicationLevel, string> = {
  summary: '📄 요약 공개',
  full: '🌐 전체 공개',
}
export const LEVEL_HINTS: Record<PublicationLevel, string> = {
  summary: '과제 요약·마일스톤·고른 로그·역할 선언. 파일과 마일스톤 스냅샷은 싣지 않습니다.',
  full: '요약 공개 + 고른 파일 버전과 마일스톤 스냅샷.',
}

export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  draft: '준비 중',
  embargoed: '엠바고',
  awaiting_consent: '동의 대기',
  ready: '게시 준비 완료',
  published: '게시됨',
  withdrawn: '철회됨',
  restricted: '제한됨',
}

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  awaiting_consent: '동의 대기',
  ready: '게시 준비 완료',
  superseded: '새 후보로 대체됨',
  published: '게시됨',
  withdrawn: '철회됨',
  replaced: '새 버전으로 바뀜',
}

export const CONSENT_STATUS_LABELS: Record<ConsentStatus, string> = {
  pending: '응답 대기',
  granted: '동의함',
  declined: '동의하지 않음',
  revoked: '철회함',
}

export const SCOPE_LABELS: Record<string, string> = {
  name: '이름 공개',
  anonymous_label: '익명(팀원 A/B…)으로 표시',
  logs: '내가 쓴 로그',
  meetings: '회의 참석 표시',
  claims: '내 역할 선언',
  artifacts: '내가 올린 파일',
  title_summary: '공개 제목·요약 작성',
}

export const SOURCE_LABELS: Record<LogSource, string> = {
  web: '웹',
  discord: '디스코드',
  ai: 'AI 초안',
  task: '할 일에서 전환',
  retro: '사후 작성',
}

export const CHECK_RULE_LABELS: Record<PublicationCheckRule, string> = {
  phone: '전화번호로 보이는 값',
  email: '메일 주소',
  resident_id: '주민등록번호로 보이는 값',
  student_id: '학번으로 보이는 숫자',
  private_url: '사설·로컬 주소 링크(공개 페이지에서 열리지 않거나 내부 시스템을 드러냄)',
  answer_file: '문제지·답안으로 보이는 파일 이름',
  long_code: '긴 코드(과제 답 코드일 수 있음 — 저장소 링크와 핵심 발췌를 권장)',
  anonymous_name: '익명으로 고른 팀원의 이름',
  pdf_metadata: 'PDF 문서 속성에 작성자 정보가 있습니다 — 공개 전에 문서 속성을 지우고 다시 올리세요',
}

export const CHECK_LOCATION_LABELS: Record<string, string> = {
  title: '공개 제목',
  summary: '요약',
  log: '로그',
  claim: '역할 선언',
  milestone: '마일스톤',
  artifact: '파일',
}

export function usageLabel(usage: UsageTerms): string {
  switch (usage.kind) {
    case 'license':
      return `재사용 허용: ${usage.spdx}`
    case 'external':
      return `외부 자료의 원래 조건: ${usage.source}`
    default:
      return '열람만 허용'
  }
}

export function blockerLabel(blocker: PublicationBlockerDto, nameOf: (userId: string) => string): string {
  switch (blocker.kind) {
    case 'consent_missing':
      return `${nameOf(blocker.userId)}: ${blocker.status === 'declined' ? '동의하지 않음' : blocker.status === 'revoked' ? '동의 철회' : '응답 대기'}`
    case 'consent_stale':
      return `${nameOf(blocker.userId)}: 이전 내용에 대한 동의(다시 동의 필요)`
    case 'file_not_clean':
      return '검사를 통과하지 않은 파일이 있습니다'
    case 'hold_open':
      return '운영 보류 중'
    case 'embargo_active':
      return `엠바고 중(${new Date(blocker.until).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지) — 게시할 수 없습니다`
    case 'superseded':
      return '새 후보로 대체되었습니다'
    case 'subject_inactive':
      return `${nameOf(blocker.userId)}: 탈퇴·정지한 계정(동의가 유효하지 않음 — 이 사람의 자료를 빼고 새 후보를 만드세요)`
  }
}

export const PUBLICATION_ERROR_MESSAGES: Record<string, string> = {
  embargo_active: '엠바고 기간에는 공개 후보를 만들 수 없습니다.',
  stale_manifest: '그 사이 공개 내용이 바뀌었습니다. 새 미리보기를 확인한 뒤 다시 결정하세요.',
  superseded: '이 후보는 새 후보로 대체되었습니다. 최신 후보를 확인하세요.',
  not_subject: '이 후보에 동의할 당사자가 아닙니다.',
  no_declined: '동의하지 않은 사람이 없습니다.',
  publication_locked: '운영 조치로 제한된 공개입니다. 조치가 풀릴 때까지 바꿀 수 없습니다.',
  publish_blocked: '게시 조건이 그 사이 바뀌었습니다. 아래 “게시를 막는 것”을 확인하세요.',
  not_published: '게시 중인 공개가 아닙니다.',
  locked: '한 번 게시한 공개의 주소는 바꿀 수 없습니다.',
}

/** 게시 확인 대화상자·공개 페이지의 사본 안내(PROOFU_EVOLUTION_PLAN §9.3, SYSTEM_DESIGN §11). */
export const COPY_RECALL_NOTICE =
  '철회하면 공개 페이지와 파일은 바로 닫히지만, 이미 내려받은 사본이나 외부 검색엔진·다른 사이트에 남은 사본은 회수를 보장할 수 없습니다.'

export const WITHDRAW_CAUSE_LABELS: Record<'owner' | 'consent_revoked', string> = {
  owner: '운영 책임자가 철회',
  consent_revoked: '당사자가 동의를 철회',
}

/** 게시 안내 문구. */
export const PUBLISH_NOTE =
  '게시할 때 서버가 엠바고·동의(지금 내용 해시)·파일 검사·권한을 한 번 더 확인합니다. 그 사이 바뀐 것이 있으면 게시되지 않습니다.'
