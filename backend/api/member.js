const models = require('../models')

const create = async (req, res) => {
  let {userId, teamId} = req.body

  const member = models.Member.build({ part: 'New Member', userId, teamId})
  await member.save()

  res.status(201).json({ item: member })
}

const update = async (req, res) => {
  const userId = req.user.id
  let body = req.body

  let member = await models.Member.findOne({ where: { teamId: body.teamId, userId } })
  if (!member) return res.status(404).json({error: 'no member'})

  Object.keys(body).forEach(key => {
    if(key != 'teamId'){
      let value = body[key]
      if (typeof value === 'string') value = value.trim()

      if (!value) return
      member[key] = value
    }
  })

  await member.save()

  res.json({ item: member })
}

const destroy = async (req, res) => {
  let {userId, teamId} = req.body
  await models.Member.destroy({ where: {userId, teamId} })
  res.status(204).end()
}

module.exports = {
  create,
  update,
  destroy
}
