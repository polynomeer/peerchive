const Sequelize = require('sequelize')
const Op = Sequelize.Op

const sequelize = new Sequelize(
  // dialect: 'sqlite',
  // storage: './db-dev.sqlite',
  // // https://github.com/sequelize/sequelize/issues/8417
  // operatorsAliases: Sequelize.Op,
  // logging: console.log
  {
    "username": "root",
    "password": "proofu",
    "database": "proofu",
    "host": "localhost",
    "port": 3306,
    "dialect": "mysql",
    "operatorsAliases": false
  }
);

const User = sequelize.define('user', {
  email: {
    type: Sequelize.STRING,
    unique: true
  },
  password: {
    type: Sequelize.STRING,
  },
  name: {
    type: Sequelize.STRING,
  },
  git: {
    type: Sequelize.STRING,
    defaultValue: null
  },
  isOnline: {
    type: Sequelize.BOOLEAN,
    defaultValue: false
  }
})


const Team = sequelize.define('team', {
  name: {
    type: Sequelize.STRING,
  },
  git: {
    type: Sequelize.STRING,
    defaultValue: null
  }
})

const Member = sequelize.define('member', {
  field: {
    type: Sequelize.ENUM('알고리즘','시스템','보안','게임','웹','모바일','임베디드','빅데이터','인공지능','etc'),
    defaultValue: null
  },
  part: {
    type: Sequelize.STRING,
  }
})
Member.belongsTo(User)
Team.hasMany(Member)

const Board = sequelize.define('board', {
  title: {
    type: Sequelize.STRING
  },
  description: {
    type: Sequelize.TEXT
  },
  language: {
    type: Sequelize.ENUM('Assembly language', 'C', 'C++', 'C#', 'Delphi/Object Pascal', 'Go', 'Groovy', 'Java', 'JavaScript', 'MATLAB', 'Objective-C', 'Perl','PHP', 'Python', 'R', 'Ruby', 'SQL', 'Swift', 'Visual Basic', 'Visual Basic.NET','etc')
  },
  bgColor: {
    type: Sequelize.STRING,
    defaultValue: '#6281B8'
  },
  bgColor: {
    type: Sequelize.STRING,
    defaultValue: '#6281B8'
  },
  hits: {
    type: Sequelize.INTEGER,
    defaultValue: 0
  }
})
Board.belongsTo(Team)

const List = sequelize.define('list', {
  title: {
    type: Sequelize.STRING
  },
  pos: {
    type: Sequelize.DOUBLE,
    defaultValue: 65535
  }
})
Board.hasMany(List)

const Card = sequelize.define('card', {
  title: {
    type: Sequelize.STRING
  },
  description: {
    type: Sequelize.TEXT
  },
  pos: {
    type: Sequelize.DOUBLE,
    defaultValue: 65535
  }
})
List.hasMany(Card)

const Join = sequelize.define('join', {
})
Join.belongsTo(User)
Team.hasMany(Join)

const Message = sequelize.define('message', {
  text: {
    type: Sequelize.TEXT
  }
})
Message.belongsTo(User)
Team.hasMany(Message)

const BoardFile = sequelize.define('boardfile', {
  name: {
    type: Sequelize.STRING
  }
})
Board.hasMany(BoardFile)

const CardFile = sequelize.define('cardfile', {
  name: {
    type: Sequelize.STRING
  }
})
Card.hasMany(CardFile)

module.exports = {
  sequelize,
  Op,
  User,
  Board,
  List,
  Card,
  Team,
  Member,
  Join,
  Message,
  BoardFile,
  CardFile
}
