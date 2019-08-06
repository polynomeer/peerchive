const models = require('../models')

const create = async (req, res) => {
  const userId = req.user.id
  let {teamId} = req.body

  if (!teamId) return res.status(400).end('no teamId')

  const check = await models.Join.findOne({
    where: { teamId, userId }
  })

  if (check) return res.status(401).json({ error: 'Join duplicate' })

  const join = models.Join.build({ teamId, userId })
  await join.save()

  res.status(201).json({ item: join })
}

const destroy = async (req, res) => {
  let { teamId, userId } = req.body
  await models.Join.destroy({ where: { teamId, userId } })
  res.status(204).end()
}

module.exports = {
  create,
  destroy
}
