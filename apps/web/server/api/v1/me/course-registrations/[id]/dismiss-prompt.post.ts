import { dismissRegistrationPrompt } from '../../../../../modules/course-registrations/registrations'

/** POST /api/v1/me/course-registrations/:id/dismiss-prompt — 학기 종료 알림 닫기(E-01, 멱등). 알림이 없으면 409 `no_prompt`. */
export default defineApiHandler((event) => dismissRegistrationPrompt(requireDb(), requireActor(event), getRouterParam(event, 'id')))
