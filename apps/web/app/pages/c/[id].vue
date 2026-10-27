<script setup lang="ts">
/**
 * 과목 허브(T-13, PROOFU_EVOLUTION_PLAN §8.2·§13.2 "과목 페이지: 이 과목은 얼마나 걸리고 어디서 막히나?"). 로그인 없이 봅니다.
 * - 공개 API(`/api/v1/public/courses/:id`)만 부릅니다. SSR에서 쿠키를 넘기지 않고, 레이아웃도 로그인 상태를 읽지 않습니다.
 * - 과목·학교·태그·노트는 학생이 쓴 내용입니다("학생 작성"). 교수 실명·평가는 다루지 않습니다.
 * - 병합된 과목 id로 들어오면 정본 주소로 바꿉니다. 파일럿 동안 기본 noindex.
 * - 신호 버튼·선배 노트 쓰기·신고(T-15)는 화면이 뜬 뒤 클라이언트에서 로그인 여부를 확인합니다.
 * - 막힘 Q&A(C-09): 커뮤니티 질문과 채택된 답변을 두 사람의 동의로 옮긴 복사본입니다. 각자 고른 이름만 보이고 원 글로 가는 링크는 없습니다.
 */
import type { PublicCourseHubDto } from '~~/shared/types/api'

definePageMeta({ layout: 'public' })

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, error } = await useAsyncData(
  () => `public-course:${id.value}`,
  () => $fetch<PublicCourseHubDto>(`/api/v1/public/courses/${encodeURIComponent(id.value)}`),
)

if (data.value && data.value.course.id !== id.value) {
  await navigateTo(`/c/${data.value.course.id}`, { replace: true, redirectCode: 301 })
}

const status = computed(() => ((error.value as { statusCode?: number } | null)?.statusCode === 503 ? 503 : 404))
const indexing = usePublicIndexing()
const indexable = computed(() => indexing.value && !!data.value)
if (import.meta.server) {
  useResponseHeader('cache-control').value = 'no-store'
  useResponseHeader('referrer-policy').value = 'no-referrer'
  if (!indexable.value) useResponseHeader('x-robots-tag').value = 'noindex, nofollow'
  const event = useRequestEvent()
  if (event && error.value) setResponseStatus(event, status.value)
}

const courseName = computed(() => {
  const c = data.value?.course
  return c ? `${c.title}${c.code ? ` (${c.code})` : ''}` : ''
})
useSeoMeta({
  title: () => (data.value ? `${courseName.value} · ${data.value.course.school.name} — Peerchive` : '과목 — Peerchive'),
  description: () => (data.value ? `${data.value.course.school.name} ${data.value.course.title}의 공개 사례·막힘·선배 노트(학생 작성)` : undefined),
  robots: () => (indexable.value ? 'index, follow' : 'noindex, nofollow'),
})

const { loggedIn, load } = useMySignals()
onMounted(() => {
  void load()
})

const workloadRows = computed(() => {
  const stats = data.value?.workload.stats
  if (!stats) return []
  const total = Object.values(stats.timeBuckets).reduce((a, b) => a + b, 0) || 1
  return (Object.keys(CHECKIN_BUCKET_LABELS) as Array<keyof typeof CHECKIN_BUCKET_LABELS>).map((bucket) => ({
    label: CHECKIN_BUCKET_LABELS[bucket],
    count: stats.timeBuckets[bucket],
    percent: Math.round((stats.timeBuckets[bucket] / total) * 100),
  }))
})
const difficultyText = computed(() => {
  const d = data.value?.workload.stats?.difficulty
  if (!d) return ''
  return (['1', '2', '3', '4', '5'] as const).map((k) => `${k}점 ${d[k]}`).join(' · ')
})
</script>

<template>
  <div class="course-hub">
    <template v-if="error || !data">
      <template v-if="status === 503">
        <h1>잠시 과목 페이지를 볼 수 없습니다</h1>
        <p>점검 중입니다. 잠시 뒤 다시 열어 주세요.</p>
      </template>
      <template v-else>
        <h1>과목을 찾을 수 없습니다</h1>
        <p>주소가 틀렸거나 없는 과목입니다. <NuxtLink to="/search">검색</NuxtLink>으로 찾아보세요.</p>
      </template>
    </template>
    <template v-else>
      <header>
        <p class="small muted">{{ data.course.school.name }} <span class="badge">학생 작성</span></p>
        <h1>{{ courseName }}</h1>
        <p class="hint">
          학교·과목 이름과 아래 내용은 학생이 직접 쓴 것입니다. 공식 강의 정보가 아니며, 교수 개인 평가나 과제 정답은 다루지 않습니다.
        </p>
        <ClientOnly><CourseTeamFindingLink :course-id="data.course.id" /></ClientOnly>
        <p v-if="data.conceptTags.length" class="chips" aria-label="개념 태그">
          <span v-for="tag in data.conceptTags" :key="tag.id" class="chip static">#{{ tag.label }}</span>
        </p>
        <form class="hub-search" role="search" action="/search" method="get">
          <input type="hidden" name="course" :value="data.course.id" />
          <label class="visually-hidden" for="hub-search-q">이 과목에서 검색</label>
          <input id="hub-search-q" name="q" type="search" placeholder="이 과목의 막힘·사례·노트 검색" maxlength="100" />
          <button type="submit" class="secondary">검색</button>
        </form>
      </header>

      <section aria-labelledby="hub-workload">
        <h2 id="hub-workload">체감 소요 시간·난이도</h2>
        <template v-if="data.workload.stats">
          <p class="small muted">통계 공유에 동의한 {{ data.workload.stats.contributors }}명의 주간 체크인(익명 집계)</p>
          <table class="ledger-table workload-table">
            <caption class="visually-hidden">주당 투입 시간 분포</caption>
            <thead>
              <tr><th scope="col">주당 시간</th><th scope="col">체크인 수</th><th scope="col">비율</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in workloadRows" :key="row.label">
                <th scope="row">{{ row.label }}</th>
                <td>{{ row.count }}</td>
                <td>{{ row.percent }}%</td>
              </tr>
            </tbody>
          </table>
          <p class="small">난이도(1 쉬움 ~ 5 어려움): {{ difficultyText }}</p>
        </template>
        <p v-else class="notice">{{ data.workload.message }} — 통계 공유에 동의한 학생이 {{ data.workload.minGroup }}명 이상이면 보여 줍니다.</p>
      </section>

      <section aria-labelledby="hub-stuck">
        <h2 id="hub-stuck">자주 막히는 지점</h2>
        <p class="hint">공개 사례의 🧱막힘 기록입니다. "나도 여기서 막혔어요"가 많은 순서로 보여 줍니다. 해결 방법은 사례 페이지에서 확인하세요.</p>
        <ol v-if="data.stuckItems.length" class="plain hub-list">
          <li v-for="item in data.stuckItems" :key="`${item.slug}:${item.key}`" class="hub-card">
            <p class="hub-card-title"><NuxtLink :to="item.path">{{ item.symptom }}</NuxtLink></p>
            <p class="small muted">
              <span class="badge" :class="{ resolved: item.resolved }">{{ item.resolved ? '해결됨' : '미해결' }}</span>
              <template v-if="item.timeBucket"> · 걸린 시간 {{ TIME_BUCKET_LABELS[item.timeBucket as keyof typeof TIME_BUCKET_LABELS] ?? item.timeBucket }}</template>
              · 사례: {{ item.caseTitle }}
            </p>
            <p v-if="item.keywords.length" class="small">키워드: {{ item.keywords.join(', ') }}</p>
            <SignalButtons :target="{ kind: 'stuck_item', slug: item.slug, itemKey: item.key }" :counts="item.signals" :kinds="['me_too', 'helped']" />
          </li>
        </ol>
        <p v-else class="muted">아직 공개된 막힘 기록이 없습니다.</p>
      </section>

      <section aria-labelledby="hub-qa" data-testid="hub-qa">
        <h2 id="hub-qa">막힘 Q&amp;A</h2>
        <p class="hint">
          커뮤니티 질문 게시판의 질문과 채택된 답변을, 질문한 학생과 답한 학생이 모두 동의해 옮긴 것입니다. 이름은 두 사람이 각자 고른 대로 보입니다. 원리·접근 위주
          답변을 권장하며 과제 정답 공유는 허용하지 않습니다.
        </p>
        <ul v-if="data.qaItems.length" class="plain hub-list">
          <li v-for="qa in data.qaItems" :id="`qa-${qa.id}`" :key="qa.id" class="hub-card">
            <p class="hub-card-title">Q. {{ qa.questionTitle }}</p>
            <p class="small muted"><strong>{{ qa.asker }}</strong> · <span class="badge">학생 작성</span></p>
            <p class="pre qa-text">{{ qa.questionBody }}</p>
            <p class="small muted"><strong>A. {{ qa.answerer }}</strong></p>
            <p class="pre qa-text">{{ qa.answerBody }}</p>
            <SignalButtons :target="{ kind: 'course_qa', qaId: qa.id }" :counts="qa.signals" :kinds="['me_too', 'helped']" />
            <p class="small">
              <ReportButton
                :targets="[{ id: 'qa', label: `막힘 Q&A(${qa.questionTitle})`, targetType: 'course_qa', targetRef: { qaId: qa.id } }]"
                :id-prefix="`qa-${qa.id}`"
                :label="'이 Q&A 신고'"
              />
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 막힘 Q&amp;A가 없습니다.</p>
      </section>

      <section aria-labelledby="hub-notes">
        <h2 id="hub-notes">선배 노트</h2>
        <p class="hint">과목을 마친 학생이 후배에게 남긴 짧은 회고입니다.</p>
        <p>
          <NuxtLink :to="`/senior-notes?course=${data.course.id}`">선배 노트 쓰기</NuxtLink>
          <span v-if="loggedIn === false" class="small muted"> (로그인 필요)</span>
        </p>
        <ul v-if="data.seniorNotes.length" class="plain hub-list">
          <li v-for="note in data.seniorNotes" :id="noteAnchor(note.id)" :key="note.id" class="hub-card">
            <p class="small muted">
              <strong>{{ note.author }}</strong>
              <template v-if="note.termLabel"> · {{ note.termLabel }}</template>
              <template v-if="note.totalTimeBucket"> · 총 {{ SENIOR_NOTE_TIME_BUCKET_LABELS[note.totalTimeBucket] }}</template>
              · <span class="badge">학생 작성</span>
            </p>
            <dl class="note-answers">
              <template v-for="q in SENIOR_NOTE_QUESTIONS" :key="q">
                <template v-if="note.answers[q]">
                  <dt>{{ SENIOR_NOTE_QUESTION_LABELS[q] }}</dt>
                  <dd class="pre">{{ note.answers[q] }}</dd>
                </template>
              </template>
            </dl>
            <SignalButtons :target="{ kind: 'senior_note', noteId: note.id }" :counts="note.signals" :kinds="['helped']" />
            <p class="small">
              <ReportButton
                :targets="[{ id: 'note', label: `선배 노트(${note.author})`, targetType: 'senior_note', targetRef: { noteId: note.id } }]"
                :id-prefix="`note-${note.id}`"
                label="이 노트 신고"
              />
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 선배 노트가 없습니다.</p>
      </section>

      <section aria-labelledby="hub-cases">
        <h2 id="hub-cases">공개 사례</h2>
        <ul v-if="data.cases.length" class="plain hub-list">
          <li v-for="c in data.cases" :key="c.slug" class="hub-card">
            <p class="hub-card-title"><NuxtLink :to="c.path">{{ c.title }}</NuxtLink></p>
            <p class="small muted">
              <template v-if="c.termLabel">{{ c.termLabel }} · </template>{{ c.kind === 'team' ? `팀 과제${c.teamSize ? ` ${c.teamSize}명` : ''}` : '개인 과제' }}
              · {{ LEVEL_LABELS[c.level] }} · 마일스톤 {{ c.milestoneCount }} · 막힘 {{ c.stuckCount }}
              <template v-if="c.forkCount"> · 계획 포크 {{ c.forkCount }}명</template>
              <span v-if="c.retrospective" class="badge retro">사후 작성</span>
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 공개된 사례가 없습니다.</p>
      </section>

      <section v-if="data.otherSchools.length" aria-labelledby="hub-others">
        <h2 id="hub-others">다른 학교에서는</h2>
        <p class="hint">같은 개념 태그를 가진 다른 학교 과목입니다.</p>
        <ul class="plain">
          <li v-for="o in data.otherSchools" :key="o.id">
            <NuxtLink :to="`/c/${o.id}`">{{ o.schoolName }} · {{ o.title }}<template v-if="o.code"> ({{ o.code }})</template></NuxtLink>
            <span class="small muted"> — {{ o.sharedTags.map((t) => `#${t.label}`).join(' ') }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.qa-text {
  overflow-wrap: anywhere;
}
</style>
