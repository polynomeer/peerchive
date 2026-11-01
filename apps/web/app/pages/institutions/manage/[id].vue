<script setup lang="ts">
/**
 * 기관 운영 화면(I-02, ADR 0044). 그 기관 운영진과 운영자만(아니면 "찾을 수 없습니다"). P2 플래그 institutions가 꺼져 있으면 API가 404라 같은 화면입니다.
 * - 기관 페이지 링크(여는 것은 운영자), 기수 방 목록·만들기(기수마다 하나, 방장 없음, 그 기수 인증만 들어옴).
 * - 초대 코드 발급·목록·철회(자기 기관만, 원문은 발급 직후 한 번만 보임).
 * - 기관 집계: 모든 수는 5 미만이면 "5명 미만"으로 가립니다. 사람 목록·작성자·멤버 프로필·과제 공간은 이 화면에 없습니다.
 */
import type { InstitutionOverviewDto, InstitutionStatsDto, InviteCodeDto, IssuedInviteCodeDto, RoomNameMode, SpaceDetailDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '기관 운영 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const id = computed(() => String(route.params.id))
const { data: overview, error, refresh } = await useFetch<InstitutionOverviewDto>(() => `/api/v1/community/institutions/${id.value}`)
const { data: stats } = await useFetch<InstitutionStatsDto>(() => `/api/v1/community/institutions/${id.value}/stats`)
const { data: codes, refresh: refreshCodes } = await useFetch<InviteCodeDto[]>(() => `/api/v1/institutions/${id.value}/invite-codes`)
const denied = computed(() => !!error.value)
if (import.meta.server && denied.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
const masked = (n: number | null | undefined) => (n === null || n === undefined ? '5 미만' : `${n}`)

// ── 기수 방 ──
const room = reactive<{ cohortLabel: string; name: string; nameMode: RoomNameMode }>({ cohortLabel: '', name: '', nameMode: 'display' })
async function createRoom() {
  busy.value = 'room'
  notice.value = null
  try {
    const created = await $fetch<SpaceDetailDto>(`/api/v1/community/institutions/${id.value}/cohort-rooms`, {
      method: 'POST',
      body: { cohortLabel: room.cohortLabel, name: room.name || null, nameMode: room.nameMode },
    })
    notice.value = { kind: 'ok', text: `‘${created.name}’ 기수 방을 만들었습니다.` }
    room.cohortLabel = ''
    room.name = ''
    await refresh()
  } catch (e) {
    const err = apiError(e)
    notice.value = {
      kind: 'error',
      text:
        err.code === 'cohort_room_exists'
          ? '이 기수의 방이 이미 있습니다.'
          : err.fields.cohortLabel
            ? '기수 이름을 확인하세요(20자까지).'
            : err.fields.name
              ? '방 이름을 확인하세요(`공식`·`운영진` 같은 말은 쓸 수 없음).'
              : '기수 방을 만들지 못했습니다.',
    }
  } finally {
    busy.value = null
  }
}

// ── 초대 코드 ──
const issue = reactive({ maxUses: 30, expiresInDays: 14, cohortLabel: '' })
const issued = ref<IssuedInviteCodeDto | null>(null)
async function issueCode() {
  busy.value = 'code'
  notice.value = null
  issued.value = null
  try {
    issued.value = await $fetch<IssuedInviteCodeDto>(`/api/v1/institutions/${id.value}/invite-codes`, {
      method: 'POST',
      body: { maxUses: Number(issue.maxUses), expiresInDays: Number(issue.expiresInDays), cohortLabel: issue.cohortLabel || null },
    })
    await refreshCodes()
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: err.fields.maxUses ? '사용 한도는 1~1000입니다.' : err.fields.expiresInDays ? '유효 기간은 1~90일입니다.' : '코드를 발급하지 못했습니다.' }
  } finally {
    busy.value = null
  }
}
async function revoke(code: InviteCodeDto) {
  if (!window.confirm('이 초대 코드를 철회할까요? 이미 인증한 사람의 인증은 그대로입니다.')) return
  busy.value = code.id
  try {
    await $fetch(`/api/v1/invite-codes/${code.id}/revoke`, { method: 'POST' })
    await refreshCodes()
  } catch {
    notice.value = { kind: 'error', text: '철회하지 못했습니다.' }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="operator-page">
    <template v-if="denied">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>이 기관의 운영진만 볼 수 있습니다.</p>
    </template>
    <template v-else-if="overview">
      <h1>{{ overview.institution.name }} 운영</h1>
      <p class="hint">
        기관 운영진은 기관 페이지·기수 방에서 모더레이터와 같은 운영 조치(가리기·되돌리기·공지·게시판·소개 관리)만 합니다. 익명 글의 작성자를 확인하거나
        소속 사용자의 프로필·과제 공간을 기관 단위로 조회할 수 없습니다. 작성자 확인이 필요하면 신고로 Peerchive 운영자에게 넘기세요.
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <section aria-labelledby="inst-page">
        <h2 id="inst-page">기관 페이지</h2>
        <p v-if="overview.page">
          <NuxtLink :to="`/community/s/${overview.page.slug}`">{{ overview.page.name }}</NuxtLink>
          <template v-if="overview.page.status !== 'active'"> · {{ SPACE_STATUS_LABELS[overview.page.status] }}</template>
        </p>
        <p v-else class="muted">아직 기관 페이지가 없습니다. 개설은 Peerchive 운영자가 합니다.</p>
      </section>

      <section aria-labelledby="inst-rooms">
        <h2 id="inst-rooms">기수 방</h2>
        <ul v-if="overview.cohortRooms.length" class="plain hub-list">
          <li v-for="r in overview.cohortRooms" :key="r.slug" class="hub-card">
            <p><NuxtLink :to="`/community/s/${r.slug}`"><strong>{{ r.name }}</strong></NuxtLink> · {{ r.cohortLabel }}</p>
            <p class="small muted">이름 표시: {{ NAME_MODE_LABELS[r.nameMode] }} · 멤버 {{ masked(r.memberCount) }}명<template v-if="r.status !== 'active'"> · {{ SPACE_STATUS_LABELS[r.status] }}</template></p>
          </li>
        </ul>
        <p v-else class="muted">기수 방이 없습니다.</p>
        <form class="stack" @submit.prevent="createRoom">
          <label>기수 <input v-model="room.cohortLabel" required maxlength="20" placeholder="예: 12기" /></label>
          <label>방 이름(비우면 “기관 이름 기수”) <input v-model="room.name" maxlength="40" /></label>
          <label>
            이름 표시
            <select v-model="room.nameMode">
              <option value="display">표시명</option>
              <option value="real">실명</option>
              <option value="anonymous">익명</option>
            </select>
          </label>
          <p class="hint">그 기수로 인증한 계정(초대 코드·기수 승인·수료증 확인)만 들어오고, 인증이 끝나면 더 읽지 못합니다. 운영진은 멤버가 아니므로 멤버 목록·방별 프로필·명부를 보지 않습니다.</p>
          <p class="actions"><button type="submit" :disabled="busy === 'room'">기수 방 만들기</button></p>
        </form>
      </section>

      <section aria-labelledby="inst-codes">
        <h2 id="inst-codes">초대 코드</h2>
        <form class="stack" @submit.prevent="issueCode">
          <label>사용 한도 <input v-model.number="issue.maxUses" type="number" min="1" max="1000" required /></label>
          <label>유효 기간(일) <input v-model.number="issue.expiresInDays" type="number" min="1" max="90" required /></label>
          <label>기수(선택) <input v-model="issue.cohortLabel" maxlength="20" placeholder="예: 12기" /></label>
          <p class="actions"><button type="submit" :disabled="busy === 'code'">코드 발급</button></p>
        </form>
        <p v-if="issued" class="notice ok" role="status" data-testid="issued-code">
          발급한 코드: <strong>{{ issued.code }}</strong> — 이 화면을 벗어나면 다시 볼 수 없습니다. 원문은 저장하지 않습니다.
        </p>
        <ul v-if="codes?.length" class="plain hub-list">
          <li v-for="c in codes" :key="c.id" class="hub-card">
            <p class="small">
              {{ c.cohortLabel ?? '기수 없음' }} · {{ c.usedCount }}/{{ c.maxUses }}회 · {{ seoulDay(c.expiresAt) }}까지
              <template v-if="c.revokedAt"> · 철회됨</template>
            </p>
            <p v-if="!c.revokedAt" class="actions"><button type="button" class="secondary" :disabled="busy === c.id" @click="revoke(c)">철회</button></p>
          </li>
        </ul>
      </section>

      <section v-if="stats" aria-labelledby="inst-stats">
        <h2 id="inst-stats">기관 집계</h2>
        <p class="hint">모든 수는 {{ stats.minGroup }} 미만이면 가립니다. 합계·사람 목록은 없습니다.</p>
        <ul class="plain">
          <li>인증 {{ standingLabelFor(overview.institution.kind, 'student') }}: {{ masked(stats.verifiedMembers.student) }}명</li>
          <li>인증 {{ standingLabelFor(overview.institution.kind, 'alumni') }}: {{ masked(stats.verifiedMembers.alumni) }}명</li>
          <li v-if="stats.page">기관 페이지 최근 30일: 글 {{ masked(stats.page.posts30d) }} · 댓글 {{ masked(stats.page.comments30d) }}</li>
          <li>기수 방 {{ stats.cohortRooms }}개</li>
        </ul>
      </section>
    </template>
  </div>
</template>
