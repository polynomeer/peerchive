const app = require('./app')
const models = require('./models')
const PORT = process.env.PORT || 3000

models.sequelize.sync()
.then(_=> {
  app.listen(PORT, () => console.log(`server is running localhost:${PORT}`))
})
