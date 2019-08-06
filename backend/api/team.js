const models = require('../models')

const create = async (req, res) => {
  const userId = req.user.id
  let {name} = req.body

  if (!name) return res.status(400).end('no name')

  const team = models.Team.build({ name })
  await team.save()

  const member = models.Member.build({ part: 'Team Creater', userId, teamId: team.id})
  await member.save()

  res.status(201).json({ item: team })
}

const get = async (req, res) => {
  const { id } = req.params
  const item = await models.Team.findOne({
    where: { id },
    include: [
      {
        model: models.Member,
        include: [{
          model: models.User,
          attributes: ['id', 'email', 'name', 'isOnline']}],
      },
      {
        model: models.Join,
        include: [{
          model: models.User,
          attributes: ['id', 'email', 'name', 'isOnline']}],
      }
    ],

  })
  if (!item) return res.status(404).end()

  res.json({ item })
}

const query = async (req, res) => {
  const userId = req.user.id

  const teamlist = await models.Member.findAll({ attributes:['teamId'], where: {userId} })

  const list = await models.Team.findAll({
    where: {
      id: {
        [models.Op.in]: teamlist.map(value => value.teamId)
      }
    },
    include: [
      {model: models.Member},
      {model:models.Join}
    ],
  })

  res.json({ list })
}

const entire = async (req, res) => {
  const list = await models.Team.findAll({
    order: [
      ['createdAt', 'DESC']
    ],
    limit: 10
  })
  res.json({ list })
}

const update = async (req, res) => {
  const { id } = req.params
  let body = req.body

  let team = await models.Team.findOne({ where: { id } })

  if (!team) return res.status(404).end()

  Object.keys(body).forEach(key => {
    let value = body[key]
    if (typeof value === 'string') value = value.trim()

    if (!value) return
    team[key] = value
  })

  await team.save()

  res.json({ item: team })
}

module.exports = {
  create,
  get,
  query,
  entire,
  update
}
