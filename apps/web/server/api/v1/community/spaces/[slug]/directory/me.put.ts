import { putMyDirectoryEntry } from '../../../../../../modules/community/member-directory'

/** PUT /api/v1/community/spaces/:slug/directory/me {consent: true, cohortLabel?, currentWork?, interests?, contactMethod?} — 명부 동의·항목 바꾸기(A-03). */
export default defineApiHandler(async (event) => putMyDirectoryEntry(requireDb(), requireActor(event), getRouterParam(event, 'slug'), await readJsonBody(event)))
