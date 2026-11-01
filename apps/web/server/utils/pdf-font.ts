/**
 * 지원용 PDF의 한글 글꼴(E-08, ADR 0052). `server/assets/fonts/Pretendard-Regular.ttf`(SIL OFL 1.1, 같은 폴더의 Pretendard-OFL.txt)를
 * nitro 서버 자산(`assets:server`)으로 읽습니다 — 빌드하면 서버 번들에 들어가고 공개 정적 파일로는 나가지 않습니다.
 * 프로세스마다 한 번 읽어 둡니다(읽기에 실패하면 다음 요청에서 다시 시도).
 */
const FONT_KEY = 'fonts:Pretendard-Regular.ttf'
let cached: Promise<Uint8Array> | undefined

export function loadPortfolioPdfFont(): Promise<Uint8Array> {
  cached ??= useStorage('assets:server')
    .getItemRaw(FONT_KEY)
    .then((raw: unknown) => {
      if (raw instanceof Uint8Array) return raw
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
      throw new Error(`PDF font asset is missing: ${FONT_KEY}`)
    })
    .catch((error: unknown) => {
      cached = undefined
      throw error
    })
  return cached
}
