/**
 * 파일 이름 정리와 Content-Disposition 헤더(RFC 6266 + RFC 5987).
 *
 * 파일 이름은 표시·내려받기 이름으로만 씁니다(저장 경로에는 쓰지 않음). 헤더 주입·경로 조작을 막도록
 * 제어 문자·경로 구분자를 없애고, ASCII 대체 이름(`filename`)과 UTF-8 이름(`filename*`)을 함께 보냅니다.
 */

export const FILE_NAME_MAX = 200

/**
 * 사용자가 보낸 파일 이름 정리: 경로 부분 제거, 제어 문자·경로 구분자·따옴표 계열 제거, 공백 정리, 길이 제한.
 * 결과가 비면 null(호출자가 422로 거부).
 */
export function sanitizeFileName(input: string): string | null {
  const base = input.normalize('NFC').split(/[/\\]/).pop() ?? ''
  const cleaned = base
    // C0/C1 제어 문자, DEL, 줄 구분자, 방향 제어 문자(확장자 위장에 쓰임) 제거
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/["<>:|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) return null
  if (cleaned.length <= FILE_NAME_MAX) return cleaned
  // 확장자를 남기고 앞을 자릅니다.
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : ''
  return cleaned.slice(0, FILE_NAME_MAX - ext.length) + ext
}

/** RFC 5987 ext-value 인코딩(attr-char 이외는 %XX). */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `filename`용 ASCII 대체 이름. 출력 가능한 ASCII 이외와 `"`, `\`, `%`, `;`는 `_`로 바꿉니다. */
export function asciiFallbackName(value: string): string {
  const ascii = value.replace(/[^\x20-\x7e]|["\\%;]/g, '_').trim()
  return ascii || 'download'
}

/** Content-Disposition 값. 이미지는 inline, 그 밖은 attachment. */
export function contentDisposition(fileName: string, inline: boolean): string {
  const name = sanitizeFileName(fileName) ?? 'download'
  return `${inline ? 'inline' : 'attachment'}; filename="${asciiFallbackName(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`
}
