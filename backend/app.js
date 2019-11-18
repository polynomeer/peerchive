const express = require('express')
const bodyParser = require('body-parser')
const logger = require('morgan')
const cors = require('cors')
const http = require('http')
const fileUpload = require('express-fileupload')

const authService = require('./auth')
const auth = require('./api/auth')
const user = require('./api/user')
const team = require('./api/team')
const member = require('./api/member')
const board = require('./api/board')
const list = require('./api/list')
const card = require('./api/card')
const join = require('./api/join')
const message = require('./api/message')
const boardfile = require('./api/boardfile')
const cardfile = require('./api/cardfile')
const html = require('./api/html')

const app = express()

const server = http.createServer(app)
const io = require('socket.io')(server)

io.on('connection', function(socket){
  console.log('***connect '+ socket.id);

  socket.on('join', function(data) {
    console.log('***join ' + socket.id + ' chat' + data.teamId);
    socket.teamId = data.teamId;
    socket.join('chat' + socket.teamId);
  });

  socket.on('leave', function() {
    console.log('***leave ' + socket.id + ' chat' + socket.teamId);
    socket.leave('chat' + socket.teamId);
    socket.room = null;
  });

  socket.on('chat',function(){
    socket.broadcast.to('chat' + socket.teamId).emit('chat');
  });

  socket.on('disconnect', function() {
    console.log('***user disconnected: ' + socket.id);
    socket.disconnect()
  });
});

server.listen(10000);

app.use(cors())
app.use(logger('dev'))
app.use(bodyParser.json({ limit : '50mb' }))
app.use(bodyParser.urlencoded({ limit : '50mb', extended: false }))
app.use(fileUpload({createParentPath: true}))
app.use(express.static('public'))
app.use('/upload/',express.static('upload'))

app.post('/login', auth.login)

app.post('/users', user.create)
app.get('/users', authService.ensureAuth(), user.get)
app.put('/users', authService.ensureAuth(), user.update)
app.delete('/users', authService.ensureAuth(), user.destroy)
app.put('/users/pw', authService.ensureAuth(), user.updatepw)

app.post('/teams', authService.ensureAuth(), team.create)
app.get('/teams', authService.ensureAuth(), team.query)
app.get('/teams/entire', team.entire)
app.get('/teams/:id', authService.ensureAuth(), team.get)
app.put('/teams/:id', authService.ensureAuth(), team.update)

app.post('/members', authService.ensureAuth(), member.create)
app.put('/members', authService.ensureAuth(), member.update)
app.delete('/members', authService.ensureAuth(), member.destroy)

app.post('/boards', authService.ensureAuth(), board.create)
app.get('/boards', authService.ensureAuth(), board.query)
app.get('/boards/entire', board.entire)
app.get('/boards/team/:teamId', authService.ensureAuth(), board.team)
app.get('/boards/:id', authService.ensureAuth(), board.get)
app.put('/boards/hit/:id', board.hit)
app.put('/boards/:id', authService.ensureAuth(), board.update)
app.delete('/boards/:id', authService.ensureAuth(), board.destroy)
app.get('/search/:keyword', board.search)

// app.get('/lists', authService.ensureAuth(), list.query)
// app.get('/lists/:id', authService.ensureAuth(), list.get)
app.post('/lists', authService.ensureAuth(), list.create)
app.put('/lists/:id', authService.ensureAuth(), list.update)
app.delete('/lists/:id', authService.ensureAuth(), list.destroy)

app.post('/cards', authService.ensureAuth(), card.create)
// app.get('/cards', authService.ensureAuth(), card.query)
app.get('/cards/:id', authService.ensureAuth(), card.get)
app.put('/cards/:id', authService.ensureAuth(), card.update)
app.delete('/cards/:id', authService.ensureAuth(), card.destroy)

app.post('/joins', authService.ensureAuth(), join.create)
app.delete('/joins', authService.ensureAuth(), join.destroy)

app.post('/messages', authService.ensureAuth(), message.create)
app.get('/messages/:teamId', authService.ensureAuth(), message.get)

app.get('/html/yu', html.getYU)

app.post('/boardfiles/:bid', boardfile.create)
app.delete('/boardfiles', boardfile.destroy)

app.post('/cardfiles/:cid', cardfile.create)
app.delete('/cardfiles', cardfile.destroy)

app.delete("/files", (req, res, next) => {
});

const startT = Date.now()
app.use('/health', (_, res) => res.json({time: Date.now() - startT}))

app.use((req, res, next) => {
  res.status = 404
  next(Error('not found'))
})

app.use((err, req, res, next) => {
  console.log(err)
  res.status(res.statusCode || 500)
  res.json({ error: err.message || 'internal server error' })
})


module.exports = app
