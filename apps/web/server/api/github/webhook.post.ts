import { readRawBody } from 'h3'
import { GithubApiError } from '../../modules/github/client'
import { MAX_WEBHOOK_BODY_BYTES, WebhookRejected, receiveWebhook } from '../../modules/github/webhook'

/**
 * POST /api/github/webhook — GitHub App 웹훅(E-11, ADR 0056). `/api/v1` 밖이라 Origin 기반 CSRF 검사를 받지 않고, 세션 쿠키도 보지 않습니다.
 * 서명(X-Hub-Signature-256, 원문 바이트·상수 시간)·본문 1MB·전달 id 재사용 거부(409)는 modules/github/webhook.ts.
 * 꺼져 있으면 404. GitHub API 확인이 실패하면 502(전달 id를 남기지 않아 GitHub가 다시 보낼 수 있음).
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  event.context.auth = null
  const github = useGithubClient()
  if (!github) throw createError({ statusCode: 404, statusMessage: 'Not Found', data: { code: 'not_found' } })
  // 서명 확인 전에 읽는 본문이므로 크기를 먼저 제한합니다.
  const declared = Number(getRequestHeader(event, 'content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Payload Too Large', data: { code: 'too_large' } })
  }
  const body = (await readRawBody(event, false)) ?? Buffer.alloc(0)
  try {
    const result = await receiveWebhook(
      requireDb(),
      { secret: github.config.webhookSecret, client: github.client },
      {
        event: getRequestHeader(event, 'x-github-event'),
        deliveryId: getRequestHeader(event, 'x-github-delivery'),
        signature: getRequestHeader(event, 'x-hub-signature-256'),
        body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      },
    )
    return result
  } catch (error) {
    if (error instanceof WebhookRejected) {
      if (error.status === 401 || error.status === 409) console.warn(`[github-webhook] rejected delivery (${error.code})`)
      throw createError({ statusCode: error.status, statusMessage: error.code, data: { code: error.code } })
    }
    if (error instanceof GithubApiError) {
      console.warn(`[github-webhook] ${error.message}`)
      throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', data: { code: 'github_unavailable' } })
    }
    throw error
  }
})
