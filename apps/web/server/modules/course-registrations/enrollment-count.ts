/**
 * 과목 허브의 "이번 학기 수강 중 N명"(E-01, PROOFU_EVOLUTION_PLAN §8.7, ADR 0046).
 *
 * 과목 등록 테이블을 공개 경로에서 읽는 **유일한** 곳입니다(S-02 경계 테스트가 다른 공개·소셜 경로의 import를 막음).
 * 돌려주는 값은 익명 집계 하나뿐입니다: 정본 과목(+ 그 과목으로 병합된 과목)의 지금 학기(달력, @peerchive/domain currentTerm)에 등록한
 * active 계정의 서로 다른 사용자 수. 5명 미만이면 null이고 화면은 아무것도 보여 주지 않습니다. 사람 id·등록 시각은 싣지 않습니다.
 */
import { currentTerm, enrollmentCountForHub, termRefLabel } from '@peerchive/domain'
import { courseRegistrations, courseTerms, sql, users, type DbExecutor } from '@peerchive/db'
import { courseScopeSql } from '../course-hub/public-scope'

export async function hubEnrollment(db: DbExecutor, canonicalCourseId: string, now: Date): Promise<{ termLabel: string; count: number } | null> {
  const term = currentTerm(now)
  const rows = await db.execute<{ n: number }>(sql`
    select count(distinct r.user_id)::int as n
    from ${courseRegistrations} r
    join ${courseTerms} ct on ct.id = r.course_term_id
    join ${users} u on u.id = r.user_id
    where ct.course_id in ${courseScopeSql(canonicalCourseId)}
      and ct.year = ${term.year} and ct.semester = ${term.semester}
      and u.status = 'active'`)
  const count = enrollmentCountForHub(Number(rows[0]?.n ?? 0))
  return count === null ? null : { termLabel: termRefLabel(term), count }
}
