/**
 * 시작 시 내부 API(디스코드 봇용) 공유 비밀을 확정합니다. production에서 값이 약하면 예외로 서버가 뜨지 않고,
 * 값이 없으면 내부 API만 꺼집니다(503). 비밀 값은 출력하지 않습니다.
 */
export default defineNitroPlugin(() => {
  if (!internalSecret()) console.info('[internal-api] PEERCHIVE_INTERNAL_SECRET is not set; /api/internal is disabled')
})
