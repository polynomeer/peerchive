<script setup lang="ts">
/**
 * 동문회·OB 방의 모임 화면(A-02, PROOFU_EVOLUTION_PLAN §8.9.9, ADR 0039). 로그인 전용·noindex, 방 멤버에게만.
 * - 일정: 다가오는 회차마다 참석·불참·미정 버튼과 응답 수, 응답자 보기(이 방 멤버에게만, 익명 방은 수만). 방장·운영진은 일정 만들기·취소.
 * - 투표: 선택지별 표 수만(누가 무엇을 골랐는지는 아무에게도 보이지 않음), 한 번만 투표, 마감. 방장·운영진은 만들기·일찍 마감.
 * - 앨범: 이미지(PNG·JPEG·WebP)만, 파일 검사·위치 정보(EXIF) 제거를 통과한 사진만 보입니다. 사진 주소는 5분 동안 나에게만 맞습니다.
 * - 운영진 공지(읽음 수)는 방의 "공지" 게시판에서 씁니다.
 * P2 alumni 플래그가 꺼져 있거나 멤버가 아니면 "찾을 수 없습니다"(서버 404).
 */
import type {
  AlbumDto,
  AlbumUploadDto,
  RoomEventDto,
  RoomEventOccurrenceDto,
  RoomEventRespondentsDto,
  RoomEventsDto,
  RoomPollDto,
  RoomPollsDto,
  RsvpResponse,
  ScanStatus,
  SpaceDetailDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const base = computed(() => `/api/v1/community/spaces/${slug.value}`)
const fetcher = useRequestFetch()
const { data: space } = await useAsyncData(`gatherings-space-${slug.value}`, () => fetcher<SpaceDetailDto>(`/api/v1/community/spaces/${slug.value}`).catch(() => null))
const { data: events, error } = await useAsyncData(`gatherings-events-${slug.value}`, () => fetcher<RoomEventsDto>(`${base.value}/events`))
const { data: polls } = await useAsyncData(`gatherings-polls-${slug.value}`, () => fetcher<RoomPollsDto>(`${base.value}/polls`).catch(() => null))
const { data: album, refresh: refreshAlbum } = await useAsyncData(`gatherings-album-${slug.value}`, () => fetcher<AlbumDto>(`${base.value}/album`).catch(() => null), { server: false })
const missing = computed(() => !events.value && !!error.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
const noticeBoard = computed(() => space.value?.boards.find((b) => b.kind === 'notice') ?? null)

const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref<string | null>(null)
const fieldErrors = ref<Record<string, string>>({})
const FIELD_TEXT: Record<string, string> = {
  required: '꼭 적어야 합니다.',
  too_long: '너무 깁니다.',
  invalid: '형식이 맞지 않습니다.',
  out_of_range: '가능한 범위를 벗어났습니다.',
  not_allowed: '반복하지 않는 일정에는 쓰지 않습니다.',
  count: '선택지는 2~10개입니다.',
  duplicate: '같은 선택지가 있습니다.',
  unsupported_type: 'PNG·JPEG·WebP 이미지만 올릴 수 있습니다.',
  extension_mismatch: '파일 확장자가 형식과 맞지 않습니다.',
  too_large: '10MB까지 올릴 수 있습니다.',
}
const fieldText = (k: string) => (fieldErrors.value[k] ? (FIELD_TEXT[fieldErrors.value[k]!] ?? fieldMessage(fieldErrors.value[k])) : null)

function fail(e: unknown) {
  const err = apiError(e)
  fieldErrors.value = err.fields
  notice.value = { kind: 'error', text: err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code) }
}
async function run(key: string, fn: () => Promise<void>, ok?: string) {
  busy.value = key
  notice.value = null
  fieldErrors.value = {}
  try {
    await fn()
    if (ok) notice.value = { kind: 'ok', text: ok }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = null
  }
}

/** datetime-local 값(서울 시각) → 시간대가 있는 ISO. */
const seoulIso = (local: string) => (local ? `${local.length === 16 ? `${local}:00` : local}+09:00` : '')
const when = (iso: string) => formatDateTime(iso)

// ── 일정 ──
const eventForm = reactive({ title: '', startsAt: '', endsAt: '', locationText: '', description: '', recurrence: 'none' as 'none' | 'weekly' | 'monthly', repeatUntil: '' })
const showEventForm = ref(false)
async function createEvent() {
  await run(
    'event-create',
    async () => {
      await $fetch<RoomEventDto>(`${base.value}/events`, {
        method: 'POST',
        body: {
          title: eventForm.title,
          startsAt: seoulIso(eventForm.startsAt) || null,
          endsAt: seoulIso(eventForm.endsAt) || null,
          locationText: eventForm.locationText || null,
          description: eventForm.description || null,
          recurrence: eventForm.recurrence,
          repeatUntil: eventForm.recurrence === 'none' ? null : eventForm.repeatUntil || null,
        },
      })
      events.value = await $fetch<RoomEventsDto>(`${base.value}/events`)
      Object.assign(eventForm, { title: '', startsAt: '', endsAt: '', locationText: '', description: '', recurrence: 'none', repeatUntil: '' })
      showEventForm.value = false
    },
    '일정을 올렸습니다.',
  )
}
function replaceEvent(updated: RoomEventDto) {
  if (!events.value) return
  events.value = { ...events.value, events: events.value.events.map((e) => (e.id === updated.id ? updated : e)) }
}
async function respond(ev: RoomEventDto, occ: RoomEventOccurrenceDto, response: RsvpResponse | null) {
  await run(`rsvp-${ev.id}-${occ.date}`, async () => {
    replaceEvent(await $fetch<RoomEventDto>(`${base.value}/events/${ev.id}/rsvp`, { method: 'PUT', body: { date: occ.date, response } }))
    delete respondents[`${ev.id}:${occ.date}`]
  })
}
async function cancelEvent(ev: RoomEventDto) {
  if (!confirm(`"${ev.title}" 일정을 취소할까요? 응답은 더 받지 않습니다.`)) return
  await run(`cancel-${ev.id}`, async () => replaceEvent(await $fetch<RoomEventDto>(`${base.value}/events/${ev.id}/cancel`, { method: 'POST' })), '일정을 취소했습니다.')
}
const respondents = reactive<Record<string, RoomEventRespondentsDto>>({})
async function loadRespondents(ev: RoomEventDto, occ: RoomEventOccurrenceDto) {
  await run(`who-${ev.id}-${occ.date}`, async () => {
    respondents[`${ev.id}:${occ.date}`] = await $fetch<RoomEventRespondentsDto>(`${base.value}/events/${ev.id}/rsvps`, { query: { date: occ.date } })
  })
}
const RSVP_ORDER: RsvpResponse[] = ['going', 'not_going', 'maybe']

// ── 투표 ──
const pollForm = reactive({ question: '', options: ['', ''], closesAt: '' })
const showPollForm = ref(false)
async function createPoll() {
  await run(
    'poll-create',
    async () => {
      await $fetch<RoomPollDto>(`${base.value}/polls`, {
        method: 'POST',
        body: { question: pollForm.question, options: pollForm.options.map((o) => o.trim()).filter(Boolean), closesAt: seoulIso(pollForm.closesAt) || null },
      })
      polls.value = await $fetch<RoomPollsDto>(`${base.value}/polls`)
      Object.assign(pollForm, { question: '', options: ['', ''], closesAt: '' })
      showPollForm.value = false
    },
    '투표를 올렸습니다.',
  )
}
function replacePoll(updated: RoomPollDto) {
  if (!polls.value) return
  polls.value = { ...polls.value, polls: polls.value.polls.map((p) => (p.id === updated.id ? updated : p)) }
}
const choice = reactive<Record<string, number | undefined>>({})
async function vote(p: RoomPollDto) {
  const index = choice[p.id]
  if (index === undefined) return
  await run(`vote-${p.id}`, async () => replacePoll(await $fetch<RoomPollDto>(`${base.value}/polls/${p.id}/votes`, { method: 'POST', body: { optionIndex: index } })), '투표했습니다.')
}
async function closePoll(p: RoomPollDto) {
  if (!confirm('지금 마감할까요?')) return
  await run(`close-${p.id}`, async () => replacePoll(await $fetch<RoomPollDto>(`${base.value}/polls/${p.id}/close`, { method: 'POST' })), '투표를 마감했습니다.')
}
const percent = (p: RoomPollDto, count: number) => (p.totalVotes ? Math.round((count / p.totalVotes) * 100) : 0)

// ── 앨범 ──
const PHOTO_STATUS: Record<ScanStatus, string> = { pending: '검사 대기', scanning: '검사 중', clean: '통과', quarantined: '검사를 통과하지 못함', failed: '처리하지 못함' }
const photoFile = ref<File | null>(null)
const caption = ref('')
function onPhotoFile(event: Event) {
  photoFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
}
async function uploadPhoto() {
  const file = photoFile.value
  if (!file) return
  await run(
    'photo-upload',
    async () => {
      const created = await $fetch<AlbumUploadDto>(`${base.value}/album/photos`, {
        method: 'POST',
        body: { declaredType: file.type, fileName: file.name, byteSize: file.size, caption: caption.value.trim() || null },
      })
      await $fetch(created.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': 'application/octet-stream' } })
      photoFile.value = null
      caption.value = ''
      await refreshAlbum()
    },
    '사진을 받았습니다. 검사와 위치 정보 제거가 끝나면 멤버에게 보입니다.',
  )
}
async function deletePhoto(id: string) {
  if (!confirm('이 사진을 지울까요?')) return
  await run(`photo-delete-${id}`, async () => {
    await $fetch(`${base.value}/album/photos/${id}`, { method: 'DELETE' })
    await refreshAlbum()
  }, '사진을 지웠습니다.')
}
</script>

<template>
  <div class="community-page">
    <template v-if="missing">
      <h1>찾을 수 없습니다</h1>
      <p>주소가 틀렸거나, 이 방의 멤버가 아닙니다.</p>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="events">
      <p class="small"><NuxtLink :to="`/community/s/${slug}`">← {{ space?.name ?? '방으로' }}</NuxtLink></p>
      <h1>모임</h1>
      <p class="hint">이 방 멤버에게만 보입니다. 공개 프로필·검색·피드에는 나오지 않습니다. 방을 나가면 내 참석 응답·공지 읽음·투표는 지워집니다(올린 사진은 방에 남으니 먼저 지우세요).</p>
      <nav aria-label="모임 메뉴" class="row small">
        <a href="#events">일정</a> · <a href="#polls">투표</a> · <a href="#album">앨범</a>
        <template v-if="noticeBoard"> · <NuxtLink :to="`/community/b/${noticeBoard.id}`">운영진 공지</NuxtLink></template>
      </nav>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

      <!-- 일정 -->
      <section id="events" aria-labelledby="events-title">
        <h2 id="events-title">일정</h2>
        <p v-if="events.canManage" class="actions">
          <button type="button" class="secondary" :aria-expanded="showEventForm" @click="showEventForm = !showEventForm">일정 만들기</button>
        </p>
        <form v-if="showEventForm && events.canManage" class="stack" novalidate data-testid="event-form" @submit.prevent="createEvent">
          <div class="field">
            <label for="ev-title">제목</label>
            <input id="ev-title" v-model="eventForm.title" maxlength="80" />
            <p v-if="fieldText('title')" class="field-error">{{ fieldText('title') }}</p>
          </div>
          <div class="field">
            <label for="ev-start">시작 (한국 시각)</label>
            <input id="ev-start" v-model="eventForm.startsAt" type="datetime-local" />
            <p v-if="fieldText('startsAt')" class="field-error">{{ fieldText('startsAt') }}</p>
          </div>
          <div class="field">
            <label for="ev-end">끝 (선택)</label>
            <input id="ev-end" v-model="eventForm.endsAt" type="datetime-local" />
            <p v-if="fieldText('endsAt')" class="field-error">{{ fieldText('endsAt') }}</p>
          </div>
          <div class="field">
            <label for="ev-location">장소 (선택)</label>
            <input id="ev-location" v-model="eventForm.locationText" maxlength="100" />
          </div>
          <div class="field">
            <label for="ev-description">설명 (선택)</label>
            <textarea id="ev-description" v-model="eventForm.description" rows="3" maxlength="1000" />
          </div>
          <div class="field">
            <label for="ev-recurrence">반복</label>
            <select id="ev-recurrence" v-model="eventForm.recurrence">
              <option v-for="(label, key) in ROOM_EVENT_RECURRENCE_LABELS" :key="key" :value="key">{{ label }}</option>
            </select>
            <p class="hint">반복 일정은 회차마다 따로 응답합니다. 시각·반복은 만든 뒤 바꿀 수 없습니다.</p>
          </div>
          <div v-if="eventForm.recurrence !== 'none'" class="field">
            <label for="ev-until">반복 끝나는 날</label>
            <input id="ev-until" v-model="eventForm.repeatUntil" type="date" />
            <p v-if="fieldText('repeatUntil')" class="field-error">{{ fieldText('repeatUntil') }}</p>
          </div>
          <p class="actions"><button type="submit" :disabled="busy === 'event-create'">올리기</button></p>
        </form>

        <ul v-if="events.events.length" class="plain hub-list" data-testid="event-list">
          <li v-for="ev in events.events" :key="ev.id" class="hub-card">
            <p>
              <strong>{{ ev.title }}</strong>
              <span v-if="ev.status === 'cancelled'" class="badge">취소됨</span>
              <span v-else-if="ev.ended" class="badge">끝남</span>
              <span v-if="ev.recurrence !== 'none'" class="small muted"> · {{ ROOM_EVENT_RECURRENCE_LABELS[ev.recurrence] }} ({{ ev.repeatUntil }}까지)</span>
            </p>
            <p v-if="ev.locationText" class="small">장소: {{ ev.locationText }}</p>
            <p v-if="ev.description" class="small pre">{{ ev.description }}</p>
            <ul class="plain">
              <li v-for="occ in ev.occurrences" :key="occ.date" class="stack" :data-testid="`occurrence-${occ.date}`">
                <p class="small">
                  <strong>{{ when(occ.startsAt) }}</strong><template v-if="occ.endsAt"> ~ {{ when(occ.endsAt) }}</template>
                  · <span v-for="r in RSVP_ORDER" :key="r">{{ RSVP_RESPONSE_LABELS[r] }} {{ occ.counts[r] }} </span>
                </p>
                <div v-if="occ.canRespond && events.writable" class="row" role="group" :aria-label="`${when(occ.startsAt)} 참석 응답`">
                  <button
                    v-for="r in RSVP_ORDER"
                    :key="r"
                    type="button"
                    :class="occ.myResponse === r ? '' : 'secondary'"
                    :aria-pressed="occ.myResponse === r"
                    :disabled="busy === `rsvp-${ev.id}-${occ.date}`"
                    @click="respond(ev, occ, occ.myResponse === r ? null : r)"
                  >
                    {{ RSVP_RESPONSE_LABELS[r] }}
                  </button>
                </div>
                <p v-else-if="occ.myResponse" class="small muted">내 응답: {{ RSVP_RESPONSE_LABELS[occ.myResponse] }}</p>
                <p class="small">
                  <button type="button" class="link" @click="loadRespondents(ev, occ)">{{ events.namesHidden ? '응답 수 보기' : '응답자 보기' }}</button>
                </p>
                <ul v-if="respondents[`${ev.id}:${occ.date}`]" class="plain small" data-testid="respondents">
                  <li v-for="r in RSVP_ORDER" :key="r">
                    {{ RSVP_RESPONSE_LABELS[r] }} {{ respondents[`${ev.id}:${occ.date}`]!.groups[r].count }}명<template
                      v-if="respondents[`${ev.id}:${occ.date}`]!.groups[r].names.length"
                      >: {{ respondents[`${ev.id}:${occ.date}`]!.groups[r].names.join(', ') }}</template
                    >
                  </li>
                  <li v-if="respondents[`${ev.id}:${occ.date}`]!.namesHidden" class="muted">익명 방이라 이름 없이 수만 보입니다.</li>
                </ul>
              </li>
            </ul>
            <p v-if="events.canManage && ev.status === 'scheduled' && !ev.ended" class="actions">
              <button type="button" class="secondary" :disabled="busy === `cancel-${ev.id}`" @click="cancelEvent(ev)">일정 취소</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 일정이 없습니다.</p>
      </section>

      <!-- 투표 -->
      <section v-if="polls" id="polls" aria-labelledby="polls-title">
        <h2 id="polls-title">투표</h2>
        <p class="hint">결과는 선택지별 표 수만 보입니다. 누가 무엇을 골랐는지는 방장·운영진에게도 보이지 않습니다. 투표는 한 번만, 바꿀 수 없습니다.</p>
        <p v-if="polls.canManage" class="actions">
          <button type="button" class="secondary" :aria-expanded="showPollForm" @click="showPollForm = !showPollForm">투표 만들기</button>
        </p>
        <form v-if="showPollForm && polls.canManage" class="stack" novalidate data-testid="poll-form" @submit.prevent="createPoll">
          <div class="field">
            <label for="poll-question">질문</label>
            <input id="poll-question" v-model="pollForm.question" maxlength="120" />
            <p v-if="fieldText('question')" class="field-error">{{ fieldText('question') }}</p>
          </div>
          <fieldset>
            <legend>선택지 (2~10개)</legend>
            <div v-for="(_, i) in pollForm.options" :key="i" class="field">
              <label :for="`poll-option-${i}`">선택지 {{ i + 1 }}</label>
              <input :id="`poll-option-${i}`" v-model="pollForm.options[i]" maxlength="50" />
            </div>
            <p class="actions">
              <button v-if="pollForm.options.length < 10" type="button" class="secondary" @click="pollForm.options.push('')">선택지 더하기</button>
            </p>
            <p v-if="fieldText('options')" class="field-error">{{ fieldText('options') }}</p>
          </fieldset>
          <div class="field">
            <label for="poll-closes">마감 (한국 시각)</label>
            <input id="poll-closes" v-model="pollForm.closesAt" type="datetime-local" />
            <p v-if="fieldText('closesAt')" class="field-error">{{ fieldText('closesAt') }}</p>
          </div>
          <p class="actions"><button type="submit" :disabled="busy === 'poll-create'">올리기</button></p>
        </form>
        <ul v-if="polls.polls.length" class="plain hub-list" data-testid="poll-list">
          <li v-for="p in polls.polls" :key="p.id" class="hub-card">
            <p>
              <strong>{{ p.question }}</strong>
              <span class="badge">{{ p.open ? '진행 중' : '마감' }}</span>
              <span class="small muted"> · {{ p.open ? `${when(p.closesAt)} 마감` : `${when(p.closesAt)} 마감됨` }} · {{ p.totalVotes }}표</span>
            </p>
            <form v-if="p.canVote" class="stack" @submit.prevent="vote(p)">
              <fieldset>
                <legend class="small">하나를 고르세요</legend>
                <label v-for="o in p.options" :key="o.index" class="check">
                  <input v-model="choice[p.id]" type="radio" :name="`poll-${p.id}`" :value="o.index" /> {{ o.label }}
                </label>
              </fieldset>
              <p class="actions"><button type="submit" :disabled="choice[p.id] === undefined || busy === `vote-${p.id}`">투표</button></p>
            </form>
            <ul class="plain small" :aria-label="`${p.question} 결과`">
              <li v-for="o in p.options" :key="o.index">
                {{ o.label }}: {{ o.count }}표 ({{ percent(p, o.count) }}%)<template v-if="p.myVote === o.index"> · 내 선택</template>
              </li>
            </ul>
            <p v-if="p.canClose" class="actions">
              <button type="button" class="secondary" :disabled="busy === `close-${p.id}`" @click="closePoll(p)">지금 마감</button>
            </p>
          </li>
        </ul>
        <p v-else class="muted">아직 투표가 없습니다.</p>
      </section>

      <!-- 앨범 -->
      <section id="album" aria-labelledby="album-title">
        <h2 id="album-title">앨범</h2>
        <p class="hint">
          PNG·JPEG·WebP 사진만, 한 장 10MB까지 올립니다. 올린 사진은 파일 검사를 거치고 위치 정보(EXIF·GPS) 같은 메타데이터를 지운 뒤에 멤버에게 보입니다. 올린 사람 이름은
          보이지 않습니다.
        </p>
        <template v-if="album">
          <form v-if="album.writable" class="stack" novalidate data-testid="photo-form" @submit.prevent="uploadPhoto">
            <div class="field">
              <label for="photo-file">사진</label>
              <input id="photo-file" type="file" :accept="ALBUM_PHOTO_MEDIA_TYPES.join(',')" @change="onPhotoFile" />
              <p v-if="fieldText('declaredType') || fieldText('fileName') || fieldText('byteSize')" class="field-error">
                {{ fieldText('declaredType') ?? fieldText('fileName') ?? fieldText('byteSize') }}
              </p>
            </div>
            <div class="field">
              <label for="photo-caption">설명 (선택)</label>
              <input id="photo-caption" v-model="caption" maxlength="100" />
            </div>
            <p class="actions"><button type="submit" :disabled="!photoFile || busy === 'photo-upload'">올리기</button></p>
          </form>
          <ul v-if="album.photos.length" class="plain album-grid" data-testid="album-list">
            <li v-for="ph in album.photos" :key="ph.id" class="hub-card">
              <img v-if="ph.url" :src="ph.url" :alt="ph.caption ?? '앨범 사진'" loading="lazy" referrerpolicy="no-referrer" />
              <p v-else class="small muted">{{ PHOTO_STATUS[ph.scanStatus] }}</p>
              <p v-if="ph.caption" class="small">{{ ph.caption }}</p>
              <p class="small muted">
                {{ when(ph.createdAt) }}<template v-if="ph.mine"> · 내가 올림</template>
              </p>
              <p v-if="ph.canDelete" class="actions">
                <button type="button" class="secondary" :disabled="busy === `photo-delete-${ph.id}`" @click="deletePhoto(ph.id)">지우기</button>
              </p>
            </li>
          </ul>
          <p v-else class="muted">아직 사진이 없습니다.</p>
          <p class="small muted">사진 주소는 5분 동안만 쓸 수 있습니다. 사진이 보이지 않으면 <button type="button" class="link" @click="refreshAlbum()">다시 불러오기</button>.</p>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}
.album-grid img {
  width: 100%;
  height: auto;
  border-radius: 4px;
}
</style>
