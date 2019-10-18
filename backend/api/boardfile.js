const models = require('../models')

const create = async (req, res) => {
  let {bid} = req.params
  let uploadFile = req.files.file
  let name = `${Date.now()}_${req.files.file.name}`
  uploadFile.mv(
    `./upload/boardfiles/${bid}/${name}`,
    function (err) {
      if (err) {
        return res.status(500).send(err)
      }

      res.json({
          file: `./upload/boardfiles/${bid}/${name}`,
      })
    }
  )

  const boardFile = models.BoardFile.build({ name, boardId:bid})
  await boardFile.save()

  res.status(201).json({ item: boardFile })
}

const destroy = async (req, res) => {
  let {name, boardId} = req.body
  await models.BoardFile.destroy({ where: {name, boardId} })
  res.status(204).end()
}

module.exports = {
  create,
  destroy
}
