/**
 * 공개 페이지 색인 허용(서버 환경 변수 PEERCHIVE_PUBLIC_INDEXING, 기본 꺼짐 = noindex). 서버에서만 읽고 useState로 클라이언트에 넘깁니다.
 * 공개 조회 API의 X-Robots-Tag와 같은 설정입니다.
 */
export function usePublicIndexing() {
  return useState<boolean>('public-indexing', () =>
    import.meta.server ? ['1', 'true', 'yes', 'on'].includes(String(process.env.PEERCHIVE_PUBLIC_INDEXING ?? '').trim().toLowerCase()) : false,
  )
}
