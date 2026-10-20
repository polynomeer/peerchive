<script setup lang="ts">
/**
 * 공개 스냅샷 보기(T-11). 오직 `snapshot`(서버가 저장한 공개 DTO)만으로 그립니다 — 비공개 API를 부르지 않습니다.
 * 공개 준비 화면의 미리보기, 동의 요청 화면, 그리고 T-12의 공개 페이지가 같은 컴포넌트를 씁니다.
 * 파일 내용은 게시 후 release 확인 경로(T-12)로만 열 수 있으므로 여기서는 이름·크기·사용 조건만 보여 줍니다.
 * `fileUrl`을 주면(T-12) 파일 이름을 그 주소로 연결합니다.
 * 로그마다 `<idPrefix>-<로그 키>` id를 붙여 과목 허브의 막힘 카드가 `/p/<slug>#public-<키>`로 가리킬 수 있게 합니다(T-13).
 * 케이스 스터디의 출처 칩(T-14)을 위해 역할 선언·마일스톤은 `<idPrefix>-<키>`, 파일은 `<idPrefix>-f-<버전 id>`, 제목은 `<idPrefix>-title` id를 가집니다.
 * `hiddenItems`(T-15)를 주면 운영 조치로 가린 기록·선언·파일 자리에 "운영 조치로 가려진 항목"을 원래 위치에 그립니다(내용은 서버가 이미 뺌).
 */
import { HIDDEN_ITEM_PLACEHOLDER } from '@peerchive/domain'
import type { HiddenItemKind, HiddenItemPlaceholderDto, PublicLog, PublicSnapshot } from '~~/shared/types/api'

const props = defineProps<{
  snapshot: PublicSnapshot
  /** 미리보기 표시(게시 전). */
  preview?: boolean
  /** 게시 후 파일 열람 주소(T-12). 없으면 링크 없이 이름만. */
  fileUrl?: (artifactVersionId: string) => string | null
  /** 같은 화면에 두 번 그릴 때 id 충돌 방지. */
  idPrefix?: string
  /** 운영 조치로 가린 항목의 원래 자리(T-15). */
  hiddenItems?: HiddenItemPlaceholderDto[]
}>()

type Row<T> = { hidden: false; item: T } | { hidden: true; key: string }
/** 남은 항목 사이에 가린 항목 자리를 원래 위치대로 끼웁니다. */
function withPlaceholders<T>(items: readonly T[], kind: HiddenItemKind): Row<T>[] {
  const hidden = (props.hiddenItems ?? []).filter((h) => h.kind === kind).sort((a, b) => a.index - b.index)
  const out: Row<T>[] = []
  let next = 0
  for (const item of items) {
    while (next < hidden.length && hidden[next]!.index <= out.length) out.push({ hidden: true, key: hidden[next++]!.key })
    out.push({ hidden: false, item })
  }
  while (next < hidden.length) out.push({ hidden: true, key: hidden[next++]!.key })
  return out
}
const logRows = computed(() => withPlaceholders(props.snapshot.logs, 'log'))
const claimRows = computed(() => withPlaceholders(props.snapshot.claims, 'claim'))
const artifactRows = computed(() => withPlaceholders(props.snapshot.artifacts, 'artifact'))

const base = computed(() => props.idPrefix ?? 'snap')
const memberByKey = computed(() => new Map(props.snapshot.members.map((m) => [m.key, m])))
const memberLabel = (key: string | null) => (key ? (memberByKey.value.get(key)?.label ?? '팀원') : '작성자 비공개')
const artifactById = computed(() => new Map(props.snapshot.artifacts.map((a) => [a.artifactVersionId, a])))
const logByKey = computed(() => new Map(props.snapshot.logs.map((l) => [l.key, l])))
const milestoneByKey = computed(() => new Map(props.snapshot.milestones.map((m) => [m.key, m])))

const courseText = computed(() => {
  const c = props.snapshot.course
  if (!c) return null
  return `${c.school} · ${c.course}${c.code ? ` (${c.code})` : ''} · ${termLabel({ year: c.year, semester: c.semester })}`
})

function payloadView(log: PublicLog): string[] {
  const { attendees, ...rest } = log.payload as Record<string, unknown> & { attendees?: string[] }
  const lines = payloadLines(rest)
  if (Array.isArray(attendees) && attendees.length) lines.unshift(`참석: ${attendees.map((k) => memberLabel(k)).join(', ')}`)
  return lines
}

const logLabel = (key: string) => {
  const log = logByKey.value.get(key)
  return log ? `${LOG_TAG_LABELS[log.tag]} ${logSummaryText(log)}` : '로그'
}
function logSummaryText(log: PublicLog): string {
  const p = log.payload as Record<string, unknown>
  const text = log.tag === 'stuck' ? String(p.symptom ?? '') : log.body || String(p.method ?? p.choice ?? p.target ?? '')
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}
const fileName = (id: string) => artifactById.value.get(id)?.displayName ?? '파일'
const CLAIM_STATUS: Record<'unconfirmed' | 'confirmed' | 'disputed', string> = {
  unconfirmed: '본인 설명 · 미확인',
  confirmed: '팀원 확인',
  disputed: '이의 있음',
}
</script>

<template>
  <article class="public-snapshot" :aria-labelledby="`${base}-title`">
    <header class="snapshot-header">
      <p v-if="preview" class="badge preview-badge">미리보기 · 아직 공개되지 않음</p>
      <h2 :id="`${base}-title`" class="snapshot-title">{{ snapshot.title }}</h2>
      <p class="actions">
        <span class="badge">{{ LEVEL_LABELS[snapshot.level] }}</span>
        <span v-if="snapshot.retrospective" class="badge retro">사후 작성</span>
        <span class="muted small">{{ snapshot.kind === 'team' ? '팀 과제' : '개인 과제' }}</span>
      </p>
      <p v-if="courseText" class="small muted">{{ courseText }}</p>
      <p class="pre">{{ snapshot.summary }}</p>
    </header>

    <section v-if="snapshot.members.length" :aria-labelledby="`${base}-members`">
      <h3 :id="`${base}-members`">참여한 사람</h3>
      <p class="chips">
        <span v-for="m in snapshot.members" :key="m.key" class="chip static">{{ m.label }}<span v-if="m.anonymous" class="visually-hidden"> (익명)</span></span>
      </p>
    </section>

    <section v-if="snapshot.milestones.length" :aria-labelledby="`${base}-milestones`">
      <h3 :id="`${base}-milestones`">마일스톤</h3>
      <ol class="snapshot-list">
        <li v-for="m in snapshot.milestones" :id="`${base}-${m.key}`" :key="m.key" class="snapshot-anchor" tabindex="-1">
          <strong>{{ m.position }}. {{ m.title }}</strong>
          <span v-if="m.retrospective" class="badge retro">사후 작성</span>
          <span class="small muted">
            <template v-if="m.dueAt"> · 예정 {{ formatDay(m.dueAt) }}</template>
            <template v-if="m.claimedAt"> · 도달(자기 기입) {{ formatDay(m.claimedAt) }}</template>
          </span>
          <ul v-if="m.snapshots.length" class="small">
            <li v-for="s in m.snapshots" :key="s.artifactVersionId">
              스냅샷: {{ fileName(s.artifactVersionId) }}<span v-if="s.retrospective"> · 사후 작성</span>
            </li>
          </ul>
        </li>
      </ol>
    </section>

    <section v-if="logRows.length" :aria-labelledby="`${base}-logs`">
      <h3 :id="`${base}-logs`">과정 기록</h3>
      <ol class="snapshot-list">
        <template v-for="row in logRows" :key="row.hidden ? `h-${row.key}` : row.item.key">
        <li v-if="row.hidden" :id="`${base}-${row.key}`" class="snapshot-log moderated-item muted" tabindex="-1">{{ HIDDEN_ITEM_PLACEHOLDER }}</li>
        <li v-else-if="row.item" :id="`${base}-${row.item.key}`" class="snapshot-log" tabindex="-1">
          <template v-for="log in [row.item]" :key="log.key">
          <p class="log-head">
            <strong>{{ LOG_TAG_LABELS[log.tag] }}</strong>
            <span class="small muted">{{ memberLabel(log.author) }} · 출처 {{ SOURCE_LABELS[log.source] }}</span>
            <span v-if="log.retrospective" class="badge retro">사후 작성</span>
          </p>
          <p v-if="log.body" class="pre">{{ log.body }}</p>
          <ul v-if="payloadView(log).length" class="small log-fields-list">
            <li v-for="(line, i) in payloadView(log)" :key="i" class="pre">{{ line }}</li>
          </ul>
          <p v-if="log.resolves" class="small">해결한 막힘: {{ logLabel(log.resolves) }}</p>
          <p v-if="log.milestone" class="small">마일스톤: {{ milestoneByKey.get(log.milestone)?.title }}</p>
          <p v-if="log.evidence.length" class="small">파일 근거: {{ log.evidence.map(fileName).join(', ') }}</p>
          <ul v-if="log.links.length" class="small">
            <li v-for="link in log.links" :key="link.url">
              <a :href="link.url" rel="noopener noreferrer nofollow" target="_blank">{{ link.title || link.url }}</a>
            </li>
          </ul>
          <p class="small muted">
            <template v-if="log.claimedDate">수행일(자기 기입) {{ formatDay(log.claimedDate) }} · </template>기록 {{ formatDateTime(log.recordedAt) }} · 버전 {{ log.revisionNo }}
          </p>
          </template>
        </li>
        </template>
      </ol>
    </section>

    <section v-if="claimRows.length" :aria-labelledby="`${base}-claims`">
      <h3 :id="`${base}-claims`">역할 선언</h3>
      <ul class="snapshot-list">
        <template v-for="row in claimRows" :key="row.hidden ? `h-${row.key}` : row.item.key">
        <li v-if="row.hidden" :id="`${base}-${row.key}`" class="snapshot-anchor moderated-item muted" tabindex="-1">{{ HIDDEN_ITEM_PLACEHOLDER }}</li>
        <li v-else-if="row.item" :id="`${base}-${row.item.key}`" class="snapshot-anchor" tabindex="-1">
          <template v-for="c in [row.item]" :key="c.key">
          <p>
            <strong>{{ memberLabel(c.member) }}</strong>: “{{ c.text }}”
          </p>
          <p class="small">
            {{ CLAIM_STATUS[c.status] }}<template v-if="c.confirmedCount"> · 확인 {{ c.confirmedCount }}명</template><template v-if="c.disputedCount"> · 이의 {{ c.disputedCount }}명</template>
            <span class="muted"> (버전 {{ c.revisionNo }})</span>
          </p>
          <p v-if="c.evidence.length" class="small">
            근거:
            {{ c.evidence.map((e) => (e.kind === 'log' ? logLabel(e.log) : fileName(e.artifactVersionId))).join(' / ') }}
          </p>
          </template>
        </li>
        </template>
      </ul>
    </section>

    <section v-if="artifactRows.length" :aria-labelledby="`${base}-files`">
      <h3 :id="`${base}-files`">파일</h3>
      <ul class="snapshot-list">
        <template v-for="row in artifactRows" :key="row.hidden ? `h-${row.key}` : row.item.artifactVersionId">
        <li v-if="row.hidden" :id="`${base}-f-${row.key}`" class="snapshot-anchor moderated-item muted" tabindex="-1">{{ HIDDEN_ITEM_PLACEHOLDER }}</li>
        <li v-else-if="row.item" :id="`${base}-f-${row.item.artifactVersionId}`" class="snapshot-anchor" tabindex="-1">
          <a v-if="fileUrl && fileUrl(row.item.artifactVersionId)" :href="fileUrl(row.item.artifactVersionId)!" rel="noopener">{{ row.item.displayName }}</a>
          <span v-else>{{ row.item.displayName }}</span>
          <span class="small muted"> · {{ formatBytes(row.item.bytes) }} · {{ usageLabel(row.item.usage) }}</span>
        </li>
        </template>
      </ul>
      <p v-if="!fileUrl" class="hint">파일 내용은 게시 후 공개 페이지에서 열 수 있습니다.</p>
    </section>

    <p v-if="!logRows.length && !snapshot.milestones.length && !claimRows.length && !artifactRows.length" class="muted">
      제목과 요약만 공개됩니다.
    </p>
    <p class="hint">
      기록 시각은 플랫폼에 들어온 시각이고, 수행일·도달일은 학생이 적은 날짜입니다. 팀원 확인은 팀원이 선언을 인정했다는 뜻이며 능력 인증이 아닙니다.
    </p>
  </article>
</template>
