/**
 * 운영자 확인(T-10, ADR 0010). 운영자는 학교·과목·개념 태그 병합, 학기 종료 시각 조정, 엠바고 낮추기·학기 엠바고만 할 수 있습니다.
 * 비공개 과제 공간을 읽는 권한은 주지 않습니다(§8): 프로젝트 내용 API는 여전히 멤버십으로만 판정합니다.
 * 부여·회수는 CLI(`pnpm --filter @peerchive/db grant-operator <email>`)로만 하며 API는 없습니다.
 */
import { and, eq, isNull, operators, type DbExecutor } from '@peerchive/db'
import { type Actor, forbidden } from '../errors'

export async function isOperator(db: DbExecutor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: operators.userId })
    .from(operators)
    .where(and(eq(operators.userId, userId), isNull(operators.revokedAt)))
    .limit(1)
  return Boolean(row)
}

/** 운영자가 아니면 403. 운영자 API는 대상 존재 여부보다 먼저 이것을 확인합니다. */
export async function requireOperator(db: DbExecutor, actor: Actor): Promise<void> {
  if (!(await isOperator(db, actor.userId))) throw forbidden('operator_only')
}
