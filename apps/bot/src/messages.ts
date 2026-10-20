/**
 * 봇이 보내는 안내 문장. 실패는 이유를 자세히 밝히지 않습니다(다른 사람의 연결·멤버 여부가 드러나지 않게).
 */
import type { BindResponse, LinkResponse, LogResponse, PinDecisionResponse, PinResponse } from '@peerchive/bot-protocol'
import { TAG_LABELS } from './commands'

export const GENERIC_ERROR = '지금은 Peerchive에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.'

export const linkGuide = (siteUrl: string) =>
  `먼저 Peerchive 계정을 연결해 주세요. ${siteUrl}/onboarding#discord 에서 연결 코드를 만든 뒤 \`/peerchive link 코드\`를 입력하면 됩니다.`

export const HELP = [
  '**Peerchive 봇 사용법**',
  '1. 웹 → 프로필 설정 → 디스코드 연결에서 코드를 만들고 `/peerchive link 코드`',
  '2. 과제 owner가 과제 화면 → 디스코드 연결에서 코드를 만들고, 기록할 채널에서 `/peerchive bind 코드`',
  '3. 연결된 채널에서 `/log 태그 내용` 또는 메시지에 📌 반응',
  '   · 내 메시지에 📌 → 바로 🔨 진행 로그 · 남의 메시지에 📌 → 작성자가 승인해야 저장',
  '봇은 연결된 채널에서 명령·📌을 단 메시지만 읽고, 다른 대화는 저장하지 않습니다.',
].join('\n')

export function linkMessage(res: LinkResponse): string {
  switch (res.status) {
    case 'linked':
      return '✅ Peerchive 계정에 연결했어요. 이제 연결된 채널에서 `/log`와 📌로 기록할 수 있어요.'
    case 'relinked':
      return '✅ 이 디스코드 계정으로 연결을 바꿨어요(이전에 연결돼 있던 디스코드 계정은 해제됨).'
    case 'already_linked':
      return '이미 이 Peerchive 계정에 연결돼 있어요.'
    case 'discord_account_in_use':
      return '이 디스코드 계정은 다른 Peerchive 계정에 연결돼 있어요. 그 계정의 웹 설정에서 먼저 연결을 해제해 주세요.'
    case 'rate_limited':
      return '시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.'
    case 'invalid_code':
      return '코드가 맞지 않거나 만료됐어요(10분, 한 번만). 웹에서 새 코드를 만들어 주세요.'
  }
}

export function bindMessage(res: BindResponse, siteUrl: string): string {
  switch (res.status) {
    case 'bound':
      return `✅ 이 채널을 「${res.projectTitle}」에 연결했어요. 여기서 \`/log\`와 📌로 기록할 수 있어요. ${res.projectUrl ?? ''}`.trim()
    case 'already_bound':
      return `이미 「${res.projectTitle}」에 연결된 채널이에요.`
    case 'not_linked':
      return linkGuide(siteUrl)
    case 'not_owner':
      return '과제 owner만 채널을 연결할 수 있어요.'
    case 'channel_taken':
      return '이 채널은 이미 다른 과제에 연결돼 있어요. 그 과제 owner가 웹에서 연결을 해제해야 해요.'
    case 'rate_limited':
      return '시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.'
    case 'invalid_code':
      return '코드가 맞지 않거나 만료됐어요. 코드를 만든 owner 계정에 연결된 디스코드 계정으로, 10분 안에 한 번만 쓸 수 있어요.'
  }
}

const FIELD_LABELS: Record<string, string> = {
  body: '내용',
  'payload.symptom': '증상',
  'payload.timeBucket': '막힌 시간',
  'payload.options': '선택지(2개 이상, 한 줄에 하나)',
  'payload.criteria': '기준',
  'payload.choice': '선택',
  'payload.target': '검증 대상',
  'payload.conditions': '조건',
  'payload.result': '결과',
}
const CODE_LABELS: Record<string, string> = {
  required: '필수',
  too_long: '너무 김',
  too_few: '더 필요',
  too_many: '너무 많음',
  invalid: '형식 오류',
}

export function fieldErrors(fields: Record<string, string> | undefined): string {
  return Object.entries(fields ?? {})
    .map(([field, code]) => {
      const name = FIELD_LABELS[field] ?? FIELD_LABELS[field.replace(/\.\d+$/, '')] ?? field
      return `${name}: ${CODE_LABELS[code] ?? code}`
    })
    .join(', ')
}

export function logMessage(res: LogResponse, tag: keyof typeof TAG_LABELS, siteUrl: string): string {
  switch (res.status) {
    case 'created':
      return `${TAG_LABELS[tag]} 로그를 남겼어요. ${res.logUrl ?? ''}`.trim()
    case 'duplicate':
      return `이미 저장된 요청이에요(로그는 하나만 남아요). ${res.logUrl ?? ''}`.trim()
    case 'not_bound':
      return '이 채널은 Peerchive 과제에 연결되어 있지 않아요. 과제 owner가 `/peerchive bind 코드`로 연결할 수 있어요.'
    case 'not_linked':
      return linkGuide(siteUrl)
    case 'not_writer':
      return '이 채널의 과제에 기록할 수 없어요(과제의 편집 권한이 필요해요).'
    case 'web_only':
      return `💡 해결은 어떤 막힘을 풀었는지 연결해야 해서 웹에서 남겨 주세요: ${res.projectUrl ?? siteUrl}`
    case 'invalid':
      return `저장하지 못했어요 — ${fieldErrors(res.fields)}. 웹에서 마저 채워 주세요: ${res.projectUrl ?? siteUrl}`
  }
}

/** 📌을 단 사람에게 보내는 DM. null이면 아무것도 보내지 않습니다. */
export function pinReactorMessage(res: PinResponse, siteUrl: string): string | null {
  switch (res.status) {
    case 'created':
      return `📌 메시지를 🔨 진행 로그로 남겼어요. ${res.logUrl ?? ''}`.trim()
    case 'duplicate':
      return '📌 이 메시지는 이미 로그로 남아 있어요.'
    case 'approval_requested':
      return '📌 작성자에게 로그로 옮겨도 될지 물어봤어요. 작성자가 승인해야 저장돼요(48시간).'
    case 'already_requested':
      return '📌 이 메시지는 이미 작성자의 승인을 기다리고 있어요.'
    case 'already_decided':
      return '📌 이 메시지는 작성자가 이미 결정했어요.'
    case 'not_linked':
      return linkGuide(siteUrl)
    case 'not_member':
      return '📌 이 채널의 과제에 기록할 수 없어요.'
    case 'author_unavailable':
      return '📌 작성자가 Peerchive에 연결돼 있지 않거나 이 과제에 기록할 수 없어 승인 요청을 보낼 수 없어요.'
    case 'empty':
      return '📌 옮길 내용이 없는 메시지예요.'
    case 'not_bound':
      return null
  }
}

export function approvalRequestMessage(approval: NonNullable<PinResponse['approval']>): string {
  return [
    `📌 팀원이 「${approval.projectTitle}」 채널의 내 메시지를 빌드 로그(🔨 진행)로 옮기자고 했어요.`,
    `> ${approval.preview}`,
    '승인하면 내 이름으로 저장되고, 거절하거나 48시간이 지나면 아무것도 저장되지 않아요.',
  ].join('\n')
}

export function decisionMessage(res: PinDecisionResponse): string {
  switch (res.status) {
    case 'approved':
      return `✅ 승인했어요. 내 🔨 진행 로그로 저장했어요. ${res.logUrl ?? ''}`.trim()
    case 'rejected':
      return '거절했어요. 아무것도 저장하지 않았어요.'
    case 'expired':
      return '요청이 만료됐어요(48시간). 아무것도 저장하지 않았어요.'
    case 'already_decided':
      return '이미 처리한 요청이에요.'
    case 'author_unavailable':
      return '지금은 이 과제에 기록할 수 없어 저장하지 않았어요.'
    case 'not_found':
      return '찾을 수 없는 요청이에요.'
  }
}
