/**
 * 공감 라운지 미디어 (A-04, PROOFU_EVOLUTION_PLAN §8.9.9 "공감 라운지 — 이미지·짧은 영상도 올릴 수 있습니다. 업로드는 기존 파일 검사·격리
 * 파이프라인을 그대로 거칩니다", SYSTEM_DESIGN §6.7.2 "공감 라운지 미디어", DELIVERY_PLAN §4.3 A-04, ADR 0041).
 *
 * - **라운지 = 공식 학교 페이지의 자유 게시판**(공감 토픽은 A-05에서 같은 규칙을 씀). 그 밖의 게시판 글에는 미디어를 붙이지 않습니다.
 * - **이미지만**(PNG·JPEG·WebP, 앨범과 같은 형식·10MB). 글 하나에 4개. 검사·EXIF/GPS 제거는 앨범 사진과 같은 단계(ADR 0039)를 거칩니다.
 * - **짧은 영상은 미룹니다**(DELIVERY_PLAN §4.3 "투입 시간이 부족하면 … 라운지 영상(A-04)을 먼저 미루고"). 영상 길이 확인·컨테이너 메타데이터
 *   제거를 의존성 없이 안전하게 할 수 없어서입니다(ADR 0041 "영상"). 들어오면 `unsupported_type`(422)입니다.
 * - 붙이기·지우기는 **글쓴이 본인**만, 게시 중인 글에만. 보는 것은 그 글을 읽을 수 있는 사람만(짧은 서명 URL).
 *
 * 런타임 의존성 없음.
 */
import type { BoardKind, SpaceKind } from './community'
import { type AlbumPhotoMediaType, type AlbumPhotoUploadCheck, ALBUM_PHOTO_MAX_BYTES, ALBUM_PHOTO_MEDIA_TYPES, checkAlbumPhotoUpload } from './room-gatherings'

/** 라운지 미디어 형식(이미지만 — 영상은 미룸). 앨범 사진과 같은 목록입니다. */
export const LOUNGE_MEDIA_TYPES: readonly AlbumPhotoMediaType[] = ALBUM_PHOTO_MEDIA_TYPES
/** 이미지 하나의 최대 크기(10MB, 앨범과 같음). */
export const LOUNGE_MEDIA_MAX_BYTES = ALBUM_PHOTO_MAX_BYTES
/** 글 하나에 붙일 수 있는 미디어 수(검사 대기·통과를 셈, 격리·실패는 세지 않음). */
export const LOUNGE_MEDIA_PER_POST = 4
/** 올리기 요청: 사용자·시간당 20개. */
export const LOUNGE_MEDIA_UPLOAD_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 }
/** 올리기 요청 뒤 내용을 보낼 수 있는 시간. */
export const LOUNGE_MEDIA_UPLOAD_TTL_MS = 15 * 60 * 1000
/** 미디어 서명 URL 유효 시간(보는 사람에게만 맞는 서명). */
export const LOUNGE_MEDIA_URL_TTL_MS = 5 * 60 * 1000

/** 미디어를 붙일 수 있는 게시판인지: 공식 학교 페이지의 자유 게시판(공감 라운지). */
export function isLoungeBoard(spaceKind: SpaceKind, boardKind: BoardKind): boolean {
  return spaceKind === 'official_school' && boardKind === 'free'
}

/** 올리기 요청 검사(형식·확장자·크기). 앨범 사진과 같은 규칙이며, 영상 형식은 `declaredType: unsupported_type`입니다. */
export function checkLoungeMediaUpload(input: { declaredType: unknown; fileName: unknown; byteSize: unknown }): AlbumPhotoUploadCheck {
  return checkAlbumPhotoUpload(input)
}
