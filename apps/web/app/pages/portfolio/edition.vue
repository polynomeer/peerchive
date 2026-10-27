<script setup lang="ts">
/**
 * 포트폴리오 판 만들기(T-14, PROOFU_EVOLUTION_PLAN §10.1·§10.4, ADR 0014): 대표 케이스 고르기(게시한 것, 최대 5) → 역량(직무 프리셋·직접 입력, 최대 12)과
 * 칸마다 근거(그 케이스가 인용한 공개 기록) → 자기 선언 스킬 → 미리보기 → 판 공개. 판은 만든 뒤 바꾸지 않고, 새 판이 지금 판이 됩니다.
 * 근거 추천은 프리셋의 근거 종류 규칙(@peerchive/domain suggestCompetencyEvidence)이며 고치거나 뺄 수 있습니다.
 * 판은 페르소나에 붙습니다(S-01, ADR 0028): 기본은 실명 프로필, `?persona=<id>`면 그 페르소나. 표시명 프로필의 판에는 대표 케이스를 넣지 않습니다
 * (공개 사례에 계정 이름이 있어 두 프로필이 이어지므로).
 */
import { suggestCompetencyEvidence, type CaseJobTarget, type CaseSnapshot } from '@peerchive/domain'
import type { CaseCitationRef, CaseStudyDto, CaseStudySummaryDto, MyPersonasDto, PortfolioEditionDto, PortfolioViewDto, PublicationCheckDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '포트폴리오 판 만들기 — Peerchive' })

type EvidenceRef = Pick<CaseCitationRef, 'kind' | 'key'>
interface CompetencyRow {
  uid: number
  label: string
  preset: string | null
  /** caseStudyId → 고른 근거 id(`kind:key`). */
  picks: Record<string, string[]>
}

const { me } = useAuth()
const requestFetch = useRequestFetch()
const { data: mine } = await useAsyncData('edition-case-studies', () => requestFetch<CaseStudySummaryDto[]>('/api/v1/me/case-studies'))
const { data: editions } = await useAsyncData('edition-list', () => requestFetch<PortfolioEditionDto[]>('/api/v1/me/portfolio-editions'))
const { data: personaList } = await useAsyncData('edition-personas', () => requestFetch<MyPersonasDto>('/api/v1/me/personas'))
const route = useRoute()
const persona = computed(() => {
  const list = personaList.value?.personas ?? []
  return list.find((p) => p.id === route.query.persona) ?? list.find((p) => p.kind === 'real') ?? null
})
const isDisplay = computed(() => persona.value?.kind === 'display')
const publishedCases = computed(() => (isDisplay.value ? [] : (mine.value ?? []).filter((c) => c.status === 'published')))

const current = computed(() => editions.value?.find((e) => e.current && e.persona.id === persona.value?.id) ?? null)
const headline = ref(current.value?.headline ?? '')
const featured = ref<string[]>(current.value?.featured.map((f) => f.caseStudyId).filter((id) => publishedCases.value.some((c) => c.id === id)) ?? [])
const skillsText = ref(current.value?.skillsDeclared.join(', ') ?? '')
const presetTarget = ref<CaseJobTarget>('general')
let uid = 0
const competencies = ref<CompetencyRow[]>([])
const newLabel = ref('')

// 대표 케이스의 상세(인용한 근거·스냅샷)를 불러옵니다.
const details = ref<Record<string, CaseStudyDto>>({})
async function loadDetail(id: string) {
  if (details.value[id]) return
  details.value = { ...details.value, [id]: await $fetch<CaseStudyDto>(`/api/v1/case-studies/${id}`) }
}
const citedOf = (id: string): Array<EvidenceRef & { label: string }> => {
  const dto = details.value[id]
  if (!dto) return []
  const seen = new Set<string>()
  return dto.sections
    .flatMap((s) => s.sentences.flatMap((x) => x.citations))
    .filter((c) => c.kind !== 'summary' && c.label)
    .filter((c) => (seen.has(citationId(c)) ? false : (seen.add(citationId(c)), true)))
    .map((c) => ({ kind: c.kind, key: c.key, label: c.label! }))
}
function suggestFor(row: CompetencyRow, caseId: string): string[] {
  const dto = details.value[caseId]
  if (!row.preset || !dto?.snapshot) return []
  return suggestCompetencyEvidence(dto.snapshot as unknown as CaseSnapshot, citedOf(caseId), row.preset).map(citationId)
}
async function toggleFeatured(id: string, on: boolean) {
  if (on) {
    if (featured.value.length >= FEATURED_CASE_LIMIT || featured.value.includes(id)) return
    featured.value = [...featured.value, id]
    await loadDetail(id)
    for (const row of competencies.value) row.picks[id] ??= suggestFor(row, id)
  } else {
    featured.value = featured.value.filter((x) => x !== id)
  }
}
function moveFeatured(index: number, delta: number) {
  const list = [...featured.value]
  const target = index + delta
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target]!, list[index]!]
  featured.value = list
}
await Promise.all(featured.value.map((id) => loadDetail(id).catch(() => undefined)))

function addCompetency(label: string, preset: string | null) {
  const trimmed = label.trim()
  if (!trimmed || competencies.value.length >= COMPETENCY_LIMIT) return
  if (competencies.value.some((c) => c.label === trimmed)) return
  const row: CompetencyRow = { uid: ++uid, label: trimmed, preset, picks: {} }
  for (const id of featured.value) row.picks[id] = suggestFor(row, id)
  competencies.value.push(row)
}
function togglePick(row: CompetencyRow, caseId: string, id: string, on: boolean) {
  const list = row.picks[caseId] ?? []
  row.picks[caseId] = on ? [...new Set([...list, id])] : list.filter((x) => x !== id)
}
const titleOf = (id: string) => publishedCases.value.find((c) => c.id === id)?.title ?? details.value[id]?.title ?? '케이스'

function body() {
  const skills = skillsText.value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    ...(persona.value && { personaId: persona.value.id }),
    headline: headline.value,
    featuredCaseStudyIds: featured.value,
    competencies: competencies.value.map((c) => ({
      label: c.label,
      preset: c.preset,
      evidence: featured.value
        .map((caseStudyId) => ({
          caseStudyId,
          citations: (c.picks[caseStudyId] ?? []).flatMap((pid) => {
            const found = citedOf(caseStudyId).find((x) => citationId(x) === pid)
            return found ? [{ kind: found.kind, key: found.key }] : []
          }),
        }))
        .filter((e) => e.citations.length > 0),
    })),
    skillsDeclared: skills,
  }
}

const preview = ref<(PortfolioViewDto & { warnings: PublicationCheckDto[] }) | null>(null)
const busy = ref(false)
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const errorText = (e: unknown) => {
  const err = apiError(e)
  if (err.status === 422) {
    const [key, code] = Object.entries(err.fields)[0] ?? []
    return `${key ? `${key}: ` : ''}${fieldText(code) ?? '입력을 확인하세요.'}`
  }
  return portfolioErrorMessage(err.code)
}
async function runPreview() {
  busy.value = true
  message.value = null
  try {
    preview.value = await $fetch<PortfolioViewDto & { warnings: PublicationCheckDto[] }>('/api/v1/portfolio-editions/preview', { method: 'POST', body: body() })
  } catch (e) {
    message.value = { kind: 'error', text: errorText(e) }
  } finally {
    busy.value = false
  }
}
async function publish() {
  busy.value = true
  message.value = null
  try {
    const edition = await $fetch<PortfolioEditionDto>('/api/v1/portfolio-editions', { method: 'POST', body: body() })
    message.value = { kind: 'ok', text: `포트폴리오 판 v${edition.version}을 공개했습니다. 공개 프로필에 이 판이 보입니다.` }
    preview.value = null
  } catch (e) {
    message.value = { kind: 'error', text: errorText(e) }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <p class="small"><NuxtLink to="/portfolio">← 포트폴리오</NuxtLink></p>
    <h1>포트폴리오 판 만들기</h1>
    <p class="hint">판은 만든 뒤 바꾸지 않습니다. 고치고 싶으면 새 판을 만드세요(이전 판은 남지만 공개하지 않습니다).</p>
    <p v-if="persona" class="small">
      {{ isDisplay ? '표시명 프로필' : '실명 프로필' }} <strong>@{{ persona.handle }}</strong>의 판입니다.
      <template v-if="isDisplay">표시명 프로필의 판에는 대표 케이스 스터디를 넣을 수 없습니다(공개 사례에 계정 이름이 있어 두 프로필이 이어집니다).</template>
    </p>

    <form class="stack" novalidate @submit.prevent="runPreview">
      <div class="field">
        <label for="edition-headline">한 줄 소개 <span class="muted">(선택, 비우면 프로필의 한 줄 소개)</span></label>
        <input id="edition-headline" v-model="headline" maxlength="120" />
      </div>

      <fieldset v-if="!isDisplay">
        <legend>대표 케이스 스터디 (최대 {{ FEATURED_CASE_LIMIT }}개)</legend>
        <p v-if="!publishedCases.length" class="muted small">게시한 케이스 스터디가 없습니다. <NuxtLink to="/portfolio">케이스 스터디</NuxtLink>를 먼저 게시하세요.</p>
        <label v-for="c in publishedCases" :key="c.id" class="check">
          <input
            type="checkbox"
            :checked="featured.includes(c.id)"
            :disabled="!featured.includes(c.id) && featured.length >= FEATURED_CASE_LIMIT"
            @change="toggleFeatured(c.id, ($event.target as HTMLInputElement).checked)"
          />
          {{ c.title }} <span class="small muted">({{ CASE_JOB_TARGET_LABELS[c.jobTarget] }} 관점)</span>
        </label>
        <ol v-if="featured.length > 1" class="small">
          <li v-for="(id, i) in featured" :key="id">
            {{ titleOf(id) }}
            <button type="button" class="secondary icon-button" :disabled="i === 0" :aria-label="`${titleOf(id)} 위로`" @click="moveFeatured(i, -1)">▲</button>
            <button type="button" class="secondary icon-button" :disabled="i === featured.length - 1" :aria-label="`${titleOf(id)} 아래로`" @click="moveFeatured(i, 1)">▼</button>
          </li>
        </ol>
      </fieldset>

      <fieldset>
        <legend>역량 × 근거 (최대 {{ COMPETENCY_LIMIT }}개)</legend>
        <p class="hint">칸에는 근거의 종류와 개수만 보입니다. 근거는 그 케이스가 인용한 공개 기록에서만 고를 수 있습니다.</p>
        <div class="field">
          <label for="preset-target">직무 프리셋</label>
          <select id="preset-target" v-model="presetTarget">
            <option v-for="t in CASE_JOB_TARGETS" :key="t" :value="t">{{ CASE_JOB_TARGET_LABELS[t] }}</option>
          </select>
        </div>
        <p class="chips">
          <button
            v-for="pid in JOB_TARGET_PRESETS[presetTarget]"
            :key="pid"
            type="button"
            class="secondary"
            :disabled="competencies.some((c) => c.label === COMPETENCY_PRESETS[pid]!.label) || competencies.length >= COMPETENCY_LIMIT"
            @click="addCompetency(COMPETENCY_PRESETS[pid]!.label, pid)"
          >
            + {{ COMPETENCY_PRESETS[pid]!.label }}
          </button>
        </p>
        <div class="citation-picker">
          <label for="custom-competency" class="visually-hidden">직접 입력할 역량 이름</label>
          <input id="custom-competency" v-model="newLabel" maxlength="40" placeholder="직접 입력(예: 문서화)" />
          <button type="button" class="secondary" :disabled="!newLabel.trim()" @click="addCompetency(newLabel, null); newLabel = ''">역량 더하기</button>
        </div>
        <ul class="plain">
          <li v-for="(row, ri) in competencies" :key="row.uid" class="hub-card">
            <p class="actions">
              <strong>{{ row.label }}</strong>
              <span v-if="row.preset" class="badge">프리셋</span>
              <button type="button" class="danger" @click="competencies.splice(ri, 1)">빼기</button>
            </p>
            <p v-if="!featured.length" class="small muted">대표 케이스를 고르면 근거를 넣을 수 있습니다.</p>
            <fieldset v-for="caseId in featured" :key="caseId" class="evidence-options">
              <legend class="small">{{ titleOf(caseId) }}의 근거</legend>
              <p v-if="!citedOf(caseId).length" class="small muted">이 케이스가 인용한 기록이 없습니다.</p>
              <label v-for="c in citedOf(caseId)" :key="citationId(c)" class="check small">
                <input
                  type="checkbox"
                  :checked="(row.picks[caseId] ?? []).includes(citationId(c))"
                  @change="togglePick(row, caseId, citationId(c), ($event.target as HTMLInputElement).checked)"
                />
                {{ c.label }}
              </label>
            </fieldset>
          </li>
        </ul>
      </fieldset>

      <div class="field">
        <label for="skills">자기 선언 스킬 <span class="muted">(쉼표로 구분, 최대 {{ SKILL_LIMIT }}개 — 근거 있는 역량과 따로 표시)</span></label>
        <textarea id="skills" v-model="skillsText" rows="2" />
      </div>

      <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>
      <p class="actions">
        <button type="submit" class="secondary" :disabled="busy">미리보기</button>
        <button type="button" :disabled="busy" @click="publish">이 판으로 공개</button>
        <NuxtLink v-if="me?.profile" :to="`/u/${me.profile.handle}`">공개 프로필 보기</NuxtLink>
      </p>
    </form>

    <section v-if="preview" class="card" aria-labelledby="preview-heading">
      <h2 id="preview-heading">미리보기 <span class="badge preview-badge">아직 공개되지 않음</span></h2>
      <p v-if="preview.headline">“{{ preview.headline }}”</p>
      <div v-if="preview.warnings.length" class="notice" role="note">
        <p><strong>공개 전 점검</strong>: 직접 쓴 글에 다음 내용이 있습니다.</p>
        <ul class="small">
          <li v-for="(w, i) in preview.warnings" :key="i">{{ CHECK_RULE_LABELS[w.rule] }} — <span class="mono">{{ w.sample }}</span></li>
        </ul>
      </div>
      <PortfolioView :view="preview" id-prefix="preview" />
    </section>
  </div>
</template>
