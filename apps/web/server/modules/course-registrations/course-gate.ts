/**
 * 과목 모집 글의 등록 확인(ADR 0060 D-05, PROOFU_EVOLUTION_PLAN §8.8).
 *
 * 돌려주는 값은 (본인, 과목) 참거짓 하나뿐입니다. 사람 목록·수·학기·등록 시각은 싣지 않으며, 호출하는 쪽은 **요청한 본인의 id만** 넘깁니다
 * (다른 사람의 등록 여부가 응답에 드러나지 않게). 학기 판정: 정본 과목(+ 그 과목으로 병합된 과목)의 어느 학기든 아직 끝나지 않았으면(`course_terms.ends_at`, 지금 학기
 * 또는 앞으로의 학기, @peerchive/domain registrationPhase의 끝남과 같은 기준) 참입니다. 모집 글의 학기와 맞추지 않습니다: 12월에 봄학기를 등록한 학생도 같은 과목의 모집을 봅니다.
 */
import { courseRegistrations, courseTerms, sql, type DbExecutor } from '@peerchive/db'
import { courseScopeSql } from '../course-hub/public-scope'

export async function isRegisteredForCourse(db: DbExecutor, userId: string, canonicalCourseId: string, now: Date): Promise<boolean> {
  const rows = await db.execute<{ yes: boolean }>(sql`
    select exists (
      select 1 from ${courseRegistrations} r
      join ${courseTerms} ct on ct.id = r.course_term_id
      where r.user_id = ${userId}
        and ct.course_id in ${courseScopeSql(canonicalCourseId)}
        and ct.ends_at > ${now.toISOString()}::timestamptz
    ) as yes`)
  return rows[0]?.yes === true
}
