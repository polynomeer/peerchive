const models = require('../models')

const create = async (req, res) => {
  const userId = req.user.id
  let {text, teamId} = req.body

  if (!text) return res.status(400).end('no text')
  if (!teamId) return res.status(400).end('no teamId')

  const message = models.Message.build({ text, teamId, userId })
  await message.save()

  res.status(201).json({ item: message })
}


const get = async (req, res) => {
  const { teamId } = req.params
  const list = await models.Message.findAll({
    where: {
      teamId
    },
    include: [{
      model: models.User,
      attributes: ['id', 'email', 'name', 'isOnline'],
    }],
  })
  res.json({ list })
}

module.exports = {
  create,
  get
}
