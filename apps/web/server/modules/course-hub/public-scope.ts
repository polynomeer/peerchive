/**
 * 과목 허브·검색·신호·포크가 함께 쓰는 "지금 공개인가" SQL 조건 (T-13, SYSTEM_DESIGN §1-1·§1-4·§11, ADR 0012·0013).
 *
 * 불변조건: 모든 공개 읽기 경로는 **게시된 release 스냅샷**(또는 게시된 선배 노트)만 읽고, 게시 상태를 **같은 쿼리에서** 확인합니다.
 * 검색 문서·유용성 신호 같은 파생 테이블은 이 조건과 조인해서만 읽으므로, worker 정리가 늦어도 철회된 내용이 보이지 않습니다.
 *
 * `servableReleaseSql`은 도메인 `canServePublicRelease`(공개 published + release published + 지금 release + 엠바고 없음)를
 * SQL로 옮긴 것입니다. 엠바고 판정은 `computeEffectiveEmbargo`와 같습니다: max(projects.embargo_until, 지금 학기의 학기 엠바고,
 * 프로젝트 엠바고) > now 이면 막힘(해제된 명시적 엠바고는 무시). 쿼리의 FROM에는 publications, publication_candidates, projects가
 * 별칭 없이 있어야 합니다.
 */
import { courses, embargoes, projects, publicationCandidates, publications, sql, type SQL } from '@peerchive/db'

const ts = (now: Date) => sql`${now.toISOString()}::timestamptz`

/** 프로젝트에 지금 적용 중인 엠바고가 있는지(projects가 FROM에 있어야 함). */
export function embargoActiveSql(now: Date): SQL {
  return sql`(coalesce(${projects.embargoUntil} > ${ts(now)}, false)
    or exists (select 1 from ${embargoes} pe where pe.project_id = ${projects.id} and pe.revoked_at is null and pe.until > ${ts(now)})
    or exists (select 1 from ${embargoes} te where ${projects.courseTermId} is not null and te.course_term_id = ${projects.courseTermId}
      and te.revoked_at is null and te.until > ${ts(now)}))`
}

/** 지금 공개로 내줄 수 있는 release인지(공개·release·지금 release·엠바고). */
export function servableReleaseSql(now: Date): SQL {
  return sql`(${publications.status} = 'published'
    and ${publicationCandidates.status} = 'published'
    and ${publicationCandidates.id} = ${publications.currentReleaseId}
    and ${publicationCandidates.publicationId} = ${publications.id}
    and ${publicationCandidates.releaseNo} is not null
    and ${publicationCandidates.publishedAt} is not null
    and ${projects.id} = ${publications.projectId}
    and not ${embargoActiveSql(now)})`
}

/** 정본 과목과 그 과목으로 병합된 과목 id들(병합 때 옮기지만, 읽기도 병합된 id를 함께 봅니다). */
export function courseScopeSql(canonicalCourseId: string): SQL {
  return sql`(select ${courses.id} from ${courses} where ${courses.id} = ${canonicalCourseId} or ${courses.mergedInto} = ${canonicalCourseId})`
}
