import { getSpaceDetail } from '../../../../../modules/community/spaces'

/** GET /api/v1/community/spaces/:slug — 멤버·학교 인증 구성원은 게시판까지, 가입 가능한 사람은 소개만(access preview), 그 밖은 404. */
export default defineApiHandler(async (event) => getSpaceDetail(requireDb(), requireActor(event), getRouterParam(event, 'slug')))
