<script setup lang="ts">
/**
 * 공감 라운지 글의 이미지(A-04, ADR 0041). 공식 학교 페이지 자유 게시판 글에만 있고, P2 alumni 플래그가 꺼지면 글 응답에 `lounge`가 없어 보이지 않습니다.
 * - 이미지는 검사·EXIF/GPS 제거를 통과한 것만, 이 사람에게만 맞는 5분 서명 URL로 보입니다(새로 열면 새 URL).
 * - 글쓴이는 이미지를 붙이고(PNG·JPEG·WebP, 10MB, 글당 4개) 지울 수 있습니다. 검사 중·통과하지 못한 이미지는 글쓴이에게만 상태로 보입니다.
 * - 짧은 영상은 아직 받지 않습니다.
 */
import type { LoungeMediaUploadDto, LoungePostMediaDto, ScanStatus } from '~~/shared/types/api'

const props = defineProps<{ postId: string; lounge: LoungePostMediaDto }>()
const emit = defineEmits<{ changed: [] }>()

const STATUS: Record<ScanStatus, string> = { pending: '검사 대기', scanning: '검사 중', clean: '통과', quarantined: '검사를 통과하지 못함', failed: '처리하지 못함' }
const file = ref<File | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
const inputKey = ref(0)
const maxMb = computed(() => Math.round(props.lounge.limits.maxBytes / (1024 * 1024)))

function onFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}
function fail(e: unknown) {
  const err = apiError(e)
  if (err.code === 'validation_failed') error.value = `PNG·JPEG·WebP 이미지(${maxMb.value}MB까지)만 붙일 수 있습니다.`
  else if (err.code === 'post_not_open') error.value = '지워졌거나 가려진 글에는 이미지를 붙일 수 없습니다.'
  else error.value = communityErrorMessage(err.code)
}
async function upload() {
  const f = file.value
  if (!f) return
  busy.value = true
  error.value = null
  try {
    const created = await $fetch<LoungeMediaUploadDto>(`/api/v1/community/posts/${props.postId}/media`, {
      method: 'POST',
      body: { declaredType: f.type, fileName: f.name, byteSize: f.size },
    })
    await $fetch(created.uploadUrl, { method: 'PUT', body: f, headers: { 'content-type': 'application/octet-stream' } })
    file.value = null
    inputKey.value++
    emit('changed')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
async function remove(id: string) {
  if (!window.confirm('이 이미지를 지울까요?')) return
  busy.value = true
  error.value = null
  try {
    await $fetch(`/api/v1/community/posts/${props.postId}/media/${id}`, { method: 'DELETE' })
    emit('changed')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section aria-label="이미지" data-testid="lounge-media">
    <ul v-if="lounge.items.length" class="plain lounge-grid" data-testid="lounge-media-list">
      <li v-for="m in lounge.items" :key="m.id">
        <img v-if="m.url" :src="m.url" alt="글에 붙인 이미지" loading="lazy" referrerpolicy="no-referrer" />
        <p v-else class="small muted">{{ STATUS[m.scanStatus] }}</p>
        <button v-if="m.canDelete" type="button" class="link-button small" :disabled="busy" @click="remove(m.id)">이미지 지우기</button>
      </li>
    </ul>
    <form v-if="lounge.canAttach" class="stack" novalidate data-testid="lounge-media-form" @submit.prevent="upload">
      <div class="field">
        <label for="lounge-media-file">이미지 붙이기</label>
        <input id="lounge-media-file" :key="inputKey" type="file" :accept="lounge.limits.types.join(',')" @change="onFile" />
        <p class="hint">PNG·JPEG·WebP, {{ maxMb }}MB까지, 글 하나에 {{ lounge.limits.perPost }}개. 위치(GPS) 등 사진 정보는 지운 뒤 보입니다. 영상은 아직 올릴 수 없습니다.</p>
      </div>
      <p class="actions"><button type="submit" :disabled="!file || busy">올리기</button></p>
    </form>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.lounge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
  gap: 0.75rem;
}
.lounge-grid img {
  width: 100%;
  height: auto;
  border-radius: 4px;
}
</style>
