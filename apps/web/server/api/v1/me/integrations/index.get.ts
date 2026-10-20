import { getIntegrations } from '../../../../modules/discord/accounts'

/** GET /api/v1/me/integrations — 본인 디스코드 연결 상태. */
export default defineApiHandler((event) => getIntegrations(requireDb(), requireActor(event)))
