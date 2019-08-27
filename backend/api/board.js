const models = require('../models')

const create = async (req, res) => {
  const userId = req.user.id
  let { title, description, language, teamId } = req.body

  if (!title) res.status(400).end('no title')
  if (!description) res.status(400).end('no description')
  if (!language) res.status(400).end('no language')

  if(!teamId) {
    const team = models.Team.build({ name: title})
    await team.save()
    teamId = team.id

    const member = models.Member.build({ part: 'Board Creater', userId, teamId})
    await member.save()
  }

  const board = models.Board.build({ title, description, language, teamId})
  await board.save()
  await models.List.bulkCreate([
    { title: 'Todo', pos: 65535,  boardId: board.id},
    { title: 'Doing', pos: 65535 * 2, boardId: board.id},
    { title: 'Done', pos: 65535 * 4, boardId: board.id},
  ])

  res.status(201).json({ item: board })
}

const query = async (req, res) => {
  const userId = req.user.id
  const teamlist = await models.Member.findAll({ attributes:['teamId'], where: {userId} })
  const list = await models.Board.findAll({
    where: {
      teamId: {
        [models.Op.in]: teamlist.map(value => value.teamId)
      }
    },
    include: [{
      model: models.Team,
      include: [{
        model: models.Member,
        where: {userId}
      }],
    }],
  })
  res.json({ list })
}

const team = async (req, res) => {
  let { teamId } = req.params
  const list = await models.Board.findAll({
    where: { teamId }
  })
  res.json({ list })
}

const get = async (req, res) => {
  const { id } = req.params
  const item = await models.Board.findOne({
    where: { id },
    include: [{
      model: models.BoardFile
      },
      {
      model: models.List,
      include: [{
        model: models.Card,
        include: [{
          model: models.CardFile,
        }]
      }]
    }],
  })
  if (!item) return res.status(404).end()

  item.lists.sort((a, b) => a.pos - b.pos)
  item.lists.forEach(list => {
    list.cards.sort((a, b) => a.pos - b.pos)
  })

  res.json({ item })
}

const update = async (req, res) => {
  const { id } = req.params
  let body = req.body

  let board = await models.Board.findOne({ where: { id } })

  if (!board) return res.status(404).end()

  Object.keys(body).forEach(key => {
    let value = body[key]
    if (typeof value === 'string') value = value.trim()

    if (!value) return
    board[key] = value
  })

  await board.save()

  res.json({ item: board })
}

const destroy = async (req, res) => {
  const { id } = req.params
  await models.Board.destroy({ where: { id } })
  res.status(204).end()
}

const entire = async (req, res) => {
  const list = await models.Board.findAll({
    order: [
      ['hits', 'DESC']
    ],
    limit: 10
  })
  res.json({ list })
}

const search = async (req, res) => {
  const { keyword } = req.params
  let searchkeyword = "%" + keyword.replace(/[+]/gi, '%') + '%'
  const list = await models.Board.findAll({
    where: {
      [models.Op.or]: [
        {
          title: {
            [models.Op.like]: searchkeyword
          }
        },
        {
          description: {
            [models.Op.like]: searchkeyword
          }
        }
      ]
    },
    order: [
      ['hits', 'DESC']
    ]
  })
  res.json({ list })
}

const hit = async (req, res) => {
  const { id } = req.params

  let board = await models.Board.findOne({ where: { id } })

  if (!board) return res.status(404).end()

  board.hits += 1

  await board.save()

  res.json({ item: board })
}

module.exports = {
  create,
  query,
  get,
  update,
  destroy,
  entire,
  search,
  hit,
  team
}
