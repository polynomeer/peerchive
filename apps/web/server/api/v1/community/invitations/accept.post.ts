import { acceptSpaceInvitation } from '../../../../modules/community/invitations'

/** POST /api/v1/community/invitations/accept {token} — 초대 수락(한 번만). 410, 409 already_member·space_full, 404(학교 자격). */
export default defineApiHandler(async (event) => acceptSpaceInvitation(requireDb(), requireActor(event), await readJsonBody(event)))
