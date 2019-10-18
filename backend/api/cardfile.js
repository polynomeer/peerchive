const models = require('../models')

const create = async (req, res) => {
  let {cid} = req.params
  let uploadFile = req.files.file
  let name = `${Date.now()}_${req.files.file.name}`
  uploadFile.mv(
    `./upload/cardfiles/${cid}/${name}`,
    function (err) {
      if (err) {
        return res.status(500).send(err)
      }

      res.json({
          file: `./upload/cardfiles/${cid}/${name}`,
      })
    }
  )

  const cardFile = models.CardFile.build({ name, cardId:cid})
  await cardFile.save()

  res.status(201).json({ item: cardFile })
}

const destroy = async (req, res) => {
  let {name, cardId} = req.body
  await models.CardFile.destroy({ where: {name, cardId} })
  res.status(204).end()
}

module.exports = {
  create,
  destroy
}
