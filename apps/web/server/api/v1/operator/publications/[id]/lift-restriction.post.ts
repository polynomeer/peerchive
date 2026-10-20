import { liftRestriction } from '../../../../../modules/moderation/operator'

/** POST /api/v1/operator/publications/:id/lift-restriction {note} — 운영자만. restricted → draft(owner가 후보·동의·게시를 다시 함). 409 not_restricted. */
export default defineApiHandler(async (event) => {
  const actor = requireActor(event)
  return liftRestriction(requireDb(), actor, getRouterParam(event, 'id'), await readJsonBody(event))
})
