import { updateBinding } from '../../../modules/discord/bindings'

/** PATCH /api/v1/discord-bindings/:id {summaryEnabled} — owner만. */
export default defineApiHandler(async (event) =>
  updateBinding(requireDb(), requireActor(event), getRouterParam(event, 'id'), await readJsonBody(event)),
)
