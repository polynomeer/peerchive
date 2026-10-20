<script setup lang="ts">
/**
 * 진화 보기(T-06, PROOFU_EVOLUTION_PLAN §6.3): 마일스톤 순서대로 스냅샷을 왼쪽 → 오른쪽으로 나란히 보여 줍니다.
 *
 * - 가로로 넘치는 내용은 이 영역 안에서만 스크롤합니다(페이지 자체는 360px에서도 가로로 스크롤되지 않음).
 *   영역은 키보드 포커스를 받아 화살표 키로 스크롤할 수 있습니다.
 * - 이미지는 기존 내용 주소(검사 통과한 버전만)로 <img>에 대체 텍스트와 함께, PDF는 내려받기 카드로 보여 줍니다.
 */
import type { MilestoneDto, MilestoneSnapshotDto } from '~~/shared/types/api'

const props = defineProps<{ milestones: MilestoneDto[] }>()

const hasSnapshots = computed(() => props.milestones.some((m) => m.snapshots.length > 0))
const isImage = (snap: MilestoneSnapshotDto) => !!snap.contentUrl && !!snap.mediaType?.startsWith('image/')
const altFor = (milestone: MilestoneDto, snap: MilestoneSnapshotDto) =>
  `${milestoneLabel(milestone)} 스냅샷: ${snap.title} v${snap.versionNo}${snap.note ? ` — ${snap.note}` : ''}`
</script>

<template>
  <div class="evolution-block">
    <h3 id="evolution-heading">진화 보기</h3>
    <p v-if="!hasSnapshots" class="hint">마일스톤에 스냅샷을 지정하면 단계별 산출물을 왼쪽에서 오른쪽으로 나란히 볼 수 있습니다.</p>
    <template v-else>
      <p id="evolution-hint" class="hint">가로로 스크롤해 단계별 산출물을 비교하세요. 영역을 선택한 뒤 화살표 키로도 움직일 수 있습니다.</p>
      <div class="evolution" role="region" tabindex="0" aria-labelledby="evolution-heading" aria-describedby="evolution-hint">
        <ol class="evolution-track">
          <li v-for="(milestone, i) in milestones" :key="milestone.id" class="evolution-step">
            <section class="evolution-column" :aria-label="milestoneLabel(milestone)">
              <p class="evolution-title">
                <strong>{{ milestone.position }}. {{ milestone.title }}</strong>
                <span v-if="milestone.claimedAt || milestone.dueAt" class="muted small">
                  {{ milestone.claimedAt ? `${formatDay(milestone.claimedAt)} (자기 기입)` : `예정 ${formatDay(milestone.dueAt!)}` }}
                </span>
              </p>
              <p v-if="milestone.snapshots.length === 0" class="muted small">스냅샷 없음</p>
              <ul v-else class="plain evolution-snaps">
                <li v-for="snap in milestone.snapshots" :key="snap.artifactVersionId">
                  <figure class="evolution-figure">
                    <a v-if="isImage(snap)" :href="snap.contentUrl!" target="_blank" rel="noopener">
                      <img :src="snap.contentUrl!" :alt="altFor(milestone, snap)" class="evolution-image" loading="lazy" />
                    </a>
                    <a v-else-if="snap.contentUrl" :href="snap.contentUrl" download class="pdf-card">
                      <span aria-hidden="true">📄</span>
                      <span>PDF · {{ snap.title }} v{{ snap.versionNo }}</span>
                      <span class="small">내려받기</span>
                    </a>
                    <span v-else class="pdf-card muted">{{ snap.title }} v{{ snap.versionNo }} (열 수 없음)</span>
                    <figcaption class="small">
                      {{ snap.title }} v{{ snap.versionNo }}<template v-if="snap.note"> — {{ snap.note }}</template>
                    </figcaption>
                  </figure>
                </li>
              </ul>
            </section>
            <span v-if="i < milestones.length - 1" class="evolution-arrow" aria-hidden="true">→</span>
          </li>
        </ol>
      </div>
    </template>
  </div>
</template>
