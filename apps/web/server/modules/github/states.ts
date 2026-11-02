/**
 * GitHub 연결 흐름의 일회용 state(E-11, ADR 0056).
 *
 * - 원문은 CSPRNG 32바이트(base64url)이고 GitHub로 보내는 주소에만 실립니다. DB에는 `sha256('github-state:' + 원문)`만 저장합니다.
 *   서버에 저장한 무작위 값이라 서명 키 없이도 위조할 수 없고, 사용 여부를 DB에 기록해 한 번만 쓰입니다.
 * - 사용자에 묶입니다: 돌아온 요청의 로그인 사용자가 만든 사람과 다르면 쓰지 않고 실패(다른 사람 세션으로 흘려 넣기 방지).
 *   install·install_verify·select는 과제에도 묶입니다.
 * - 만료: identity·install·install_verify 10분, select(저장소 고르기) 30분.
 */
import { and, eq, githubOauthStates, gt, isNull, type DbExecutor, type GithubRepoChoice } from '@peerchive/db'
import { generateToken, looksLikeToken, sha256Hex } from '../security/tokens'

export type GithubStatePurpose = 'identity' | 'install' | 'install_verify' | 'select'

export const STATE_TTL_MS = 10 * 60 * 1000
export const SELECT_TTL_MS = 30 * 60 * 1000

export const hashState = (state: string) => sha256Hex(`github-state:${state}`)

export type StateRow = typeof githubOauthStates.$inferSelect

export async function createState(
  db: DbExecutor,
  input: { purpose: GithubStatePurpose; userId: string; projectId?: string | null; installationId?: number | null; repos?: GithubRepoChoice[] | null },
  now: Date,
): Promise<{ state: string; expiresAt: Date }> {
  const state = generateToken(32)
  const expiresAt = new Date(now.getTime() + (input.purpose === 'select' ? SELECT_TTL_MS : STATE_TTL_MS))
  await db.insert(githubOauthStates).values({
    purpose: input.purpose,
    stateHash: hashState(state),
    userId: input.userId,
    projectId: input.projectId ?? null,
    installationId: input.installationId ?? null,
    repos: input.repos ?? null,
    expiresAt,
    createdAt: now,
  })
  return { state, expiresAt }
}

/**
 * state를 한 번만 씁니다. 형식·용도·만료·사용 여부·사용자가 하나라도 맞지 않으면 null(이유는 구분하지 않음).
 * 다른 사용자가 쓰려 하면 그 state는 쓰지 않은 채로 둡니다(만든 사람이 다시 시도할 수 있게). 동시에 두 번 쓰면 한쪽만 성공합니다.
 */
export async function consumeState(
  db: DbExecutor,
  rawState: unknown,
  purposes: readonly GithubStatePurpose[],
  userId: string,
  now: Date,
): Promise<StateRow | null> {
  if (!looksLikeToken(rawState)) return null
  const [row] = await db
    .select()
    .from(githubOauthStates)
    .where(and(eq(githubOauthStates.stateHash, hashState(rawState)), isNull(githubOauthStates.usedAt), gt(githubOauthStates.expiresAt, now)))
    .limit(1)
  if (!row || !purposes.includes(row.purpose) || row.userId !== userId) return null
  const used = await db
    .update(githubOauthStates)
    .set({ usedAt: now })
    .where(and(eq(githubOauthStates.id, row.id), isNull(githubOauthStates.usedAt)))
    .returning({ id: githubOauthStates.id })
  return used.length === 1 ? row : null
}
