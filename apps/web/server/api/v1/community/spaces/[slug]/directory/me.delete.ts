import { withdrawMyDirectoryEntry } from '../../../../../../modules/community/member-directory'

/** DELETE /api/v1/community/spaces/:slug/directory/me — 명부 동의 철회(A-03). 내 행을 바로 지웁니다(멱등). */
export default defineApiHandler(async (event) => withdrawMyDirectoryEntry(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
