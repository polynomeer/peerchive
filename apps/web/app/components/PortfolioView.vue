<script setup lang="ts">
/**
 * 공개 포트폴리오 보기(T-14, PROOFU_EVOLUTION_PLAN §10.1·§10.3·§10.4·§11). 공개 프로필·인쇄 보기·판 미리보기가 같은 컴포넌트를 씁니다.
 * - 오직 서버가 만든 `PortfolioViewDto`만으로 그립니다(공개 API 응답 또는 미리보기 응답).
 * - 대표 케이스는 포트폴리오 요약 보기(문제·역할·결정·근거·결과·한계 순)로, 문장마다 출처 칩이 공개 사례 페이지의 그 기록(`/p/<slug>#public-<키>`)으로 갑니다.
 * - 볼 수 없게 된 케이스는 글 없이 안내만 보입니다.
 * - 매트릭스 칸은 근거의 종류와 개수만 글자로 보여 주고 점수·색 농도를 쓰지 않습니다.
 */
import type { PortfolioViewDto } from '~~/shared/types/api'

const props = defineProps<{
  view: PortfolioViewDto
  /** 인쇄 보기: 링크 주소를 글로 함께 보여 줌. */
  print?: boolean
  /** 같은 화면에 두 번 그릴 때 id 충돌 방지. */
  idPrefix?: string
}>()

const base = computed(() => props.idPrefix ?? 'pf')
const titleOf = (ref: string) => props.view.matrix.columns.find((c) => c.ref === ref)?.title ?? ''
</script>

<template>
  <div class="portfolio-view">
    <section :aria-labelledby="`${base}-cases`">
      <h2 :id="`${base}-cases`">대표 케이스 스터디 <span class="muted small">({{ view.featured.length }})</span></h2>
      <p v-if="!view.featured.length" class="muted">아직 대표 케이스 스터디가 없습니다.</p>
      <article
        v-for="item in view.featured"
        :id="`${base}-${item.anchor}`"
        :key="item.anchor"
        class="case-card"
        :aria-labelledby="`${base}-${item.anchor}-title`"
      >
        <template v-if="item.available">
          <h3 :id="`${base}-${item.anchor}-title`" class="case-title">{{ item.title }}</h3>
          <p class="small muted case-meta">
            <span class="badge">{{ item.jobTargetLabel }} 관점</span>
            <span v-if="item.termLabel">{{ item.termLabel }}</span>
            <span>공개 버전 v{{ item.releaseVersion }}</span>
            <span>사례 속 본인 표시: {{ item.selfLabel }}</span>
          </p>
          <section v-for="section in item.sections" :key="section.key" class="case-section">
            <h4>{{ section.label }}</h4>
            <ul class="case-sentences">
              <li v-for="(sentence, i) in section.sentences" :key="i">
                <p class="case-sentence" :class="{ 'moderated-item muted': sentence.moderated }">
                  <span v-if="sentence.reflection" class="badge">{{ REFLECTION_LABEL }}</span>
                  {{ sentence.text }}
                </p>
                <p v-if="sentence.citations.length" class="chips citation-chips">
                  <span class="visually-hidden">출처:</span>
                  <a v-for="(c, ci) in sentence.citations" :key="ci" class="chip static citation-chip" :href="c.path">
                    {{ c.label }}<span v-if="print" class="print-url"> ({{ c.path }})</span>
                  </a>
                </p>
              </li>
            </ul>
          </section>
          <p class="small">
            <a :href="item.path">원본 공개 사례 보기</a><span v-if="print" class="print-url"> ({{ item.path }})</span>
          </p>
        </template>
        <template v-else>
          <h3 :id="`${base}-${item.anchor}-title`" class="case-title muted">볼 수 없는 케이스 스터디</h3>
          <p class="muted">{{ item.message }}</p>
        </template>
      </article>
    </section>

    <section v-if="view.matrix.rows.length" :aria-labelledby="`${base}-matrix`">
      <h2 :id="`${base}-matrix`">역량 × 근거</h2>
      <p class="hint">칸에는 근거의 종류와 개수만 적습니다. 점수나 수준을 매기지 않습니다. 근거를 누르면 공개 기록으로 갑니다.</p>
      <div class="matrix-scroll" role="region" :aria-labelledby="`${base}-matrix`" tabindex="0">
        <table class="matrix-table">
          <thead>
            <tr>
              <th scope="col">역량</th>
              <th v-for="col in view.matrix.columns" :key="col.ref" scope="col">
                <a v-if="col.available" :href="`#${base}-${col.ref}`">{{ col.title }}</a>
                <span v-else class="muted">{{ col.title }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in view.matrix.rows" :key="row.label">
              <th scope="row">{{ row.label }}</th>
              <td v-for="cell in row.cells" :key="cell.column">
                <span :class="{ muted: !cell.available || !cell.counts.length }">{{ cell.text }}</span>
                <details v-if="cell.evidence.length" class="matrix-evidence">
                  <summary>근거 {{ cell.evidence.length }}개<span class="visually-hidden"> — {{ row.label }}, {{ titleOf(cell.column) }}</span></summary>
                  <ul class="small">
                    <li v-for="(e, i) in cell.evidence" :key="i">
                      <a :href="e.path">{{ e.label }}</a><span v-if="print" class="print-url"> ({{ e.path }})</span>
                    </li>
                  </ul>
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="view.evidenceBackedCompetencies.length || view.skillsDeclared.length" :aria-labelledby="`${base}-skills`">
      <h2 :id="`${base}-skills`">역량과 스킬</h2>
      <dl class="kv">
        <template v-if="view.evidenceBackedCompetencies.length">
          <dt>경험 근거가 있는 역량</dt>
          <dd>{{ view.evidenceBackedCompetencies.join(', ') }}</dd>
        </template>
        <template v-if="view.skillsDeclared.length">
          <dt>자기 선언 스킬 <span class="small">(본인 입력, 근거 연결 없음)</span></dt>
          <dd>{{ view.skillsDeclared.join(', ') }}</dd>
        </template>
      </dl>
    </section>
  </div>
</template>
