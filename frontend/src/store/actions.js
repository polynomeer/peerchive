import * as api from '../api'

const actions = {
  LOGIN ({commit}, {email, password}) {
    return api.auth.login(email, password)
      .then(({accessToken}) => commit('LOGIN', accessToken))
  },
  ADD_USER (_, {email, password, name}) {
    return api.user.create(email, password, name).then(data => data.item)
  },
  FETCH_USER ({commit}) {
    return api.user.fetch().then(data => {
      commit('SET_USER', data.item)
    })
  },
  UPDATE_USER (_, {name, git, isOnline}) {
    return api.user.update({name, git, isOnline})
  },
  DELETE_USER (_) {
    return api.user.destroy()
  },
  UPDATE_USER_PW (_, {password, newpassword}) {
    return api.user.updatepw({password, newpassword})
  },

  ADD_TEAM ({dispatch}, {name}) {
    return api.team.create({name})
      .then(_ => dispatch('FETCH_TEAMS'))
  },
  FETCH_TEAM ({commit}, {id}) {
    return api.team.fetch(id).then(data => {
      commit('SET_TEAM', data.item)
    })
  },
  FETCH_TEAMS ({commit}) {
    return api.team.fetch().then(data => {
      commit('SET_TEAMS', data.list)
    })
  },
  FETCH_ENTIRE_TEAMS ({commit}) {
    return api.team.entireFetch().then(data => {
      commit('SET_ENTIRE_TEAMS', data.list)
    })
  },
  UPDATE_TEAM({ state, dispatch }, { id, name, git }) {
    return api.team.update(id, {name, git})
      .then(_ => {
        dispatch('FETCH_TEAM', {id: state.team.id})
        dispatch('FETCH_TEAMS')
      })
  },

  ADD_MEMBER ({dispatch}, {userId, teamId}) {
    return api.member.create({userId, teamId})
      .then(_ => dispatch('FETCH_TEAMS'))
  },
  FETCH_MEMBERS ({commit}, {id}) {
    return api.team.fetch().then(data => {
      commit('SET_TEAMS', data.list)
    })
  },
  UPDATE_MEMBER({ state, dispatch }, { teamId, userId, field, part }) {
    return api.member.update({ teamId, userId, field, part })
      .then(_ => {
        dispatch('FETCH_TEAM', {id: teamId})
      })
  },
  DELETE_MEMBER({state, dispatch}, {teamId, userId}) {
    return api.member.destroy({teamId, userId})
      .then(_ => {
        dispatch('FETCH_TEAM', {id: teamId})
        dispatch('FETCH_TEAMS')
      })
  },

  ADD_BOARD (_, {title, description, language, teamId}) {
    return api.board.create({title, description, language, teamId}).then(data => data.item)
  },
  FETCH_ENTIRE_BOARDS ({commit}) {
    return api.board.entireFetch().then(data => {
      commit('SET_ENTIRE_BOARDS', data.list)
    })
  },
  FETCH_BOARDS ({commit}) {
    return api.board.fetch().then(data => {
      commit('SET_BOARDS', data.list)
    })
  },
  FETCH_TEAM_BOARDS ({commit}, {teamId}) {
    return api.board.teamFetch(teamId).then(data => {
      commit('SET_TEAM_BOARDS', data.list)
    })
  },
  FETCH_BOARD ({commit}, {id}) {
    return api.board.fetch(id).then(data => {
      commit('SET_BOARD', data.item)
    })
  },
  SEARCH_BOARDS ({commit}, {keyword}) {
    return api.board.entireFetch(keyword).then(data => {
      commit('SET_SEARCH_RESULT', data.list)
    })
  },
  UPDATE_BOARD({ state, dispatch }, { id, title, description, language, bgColor }) {
    return api.board.update(id, { title, description, language, bgColor })
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },
  DELETE_BOARD(_, {id}) {
    return api.board.destroy(id)
  },
  HIT_BOARD({ state, dispatch }, {id}) {
    return api.board.hit(id)
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },

  ADD_LIST ({state, dispatch}, {title, boardId, pos}) {
    return api.list.create({title, pos, boardId})
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },
  UPDATE_LIST ({ state, dispatch }, {id, pos, title}) {
    return api.list.update(id, { pos, title })
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },
  DELETE_LIST({dispatch, state}, {id}) {
    return api.list.destroy(id)
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },

  ADD_CARD({dispatch, state}, {title, listId, pos}) {
    return api.card.create(title, listId, pos)
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },
  FETCH_CARD({ commit }, {id}) {
    return api.card.fetch(id).then(data => {
      commit('SET_CARD', data.item)
    })
  },
  UPDATE_CARD({ state, dispatch }, {id, title, description, pos, listId}) {
    return api.card.update(id, {title, description, pos, listId})
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },
  DELETE_CARD({state, dispatch}, {id}) {
    return api.card.destroy(id)
      .then(_ => dispatch('FETCH_BOARD', {id: state.board.id}))
  },

  ADD_JOIN({state, dispatch}, {teamId}) {
    return api.join.create({teamId})
      .then(_ => dispatch('FETCH_TEAM', {id: state.team.id}))
  },
  DELETE_JOIN({dispatch, state}, {teamId, userId}) {
    return api.join.destroy({teamId, userId})
      .then(_ => dispatch('FETCH_TEAM', {id: state.team.id}))
  },

  FETCH_MESSAGES ({commit}, {teamId}) {
    return api.message.fetch(teamId).then(data => {
      commit('SET_MESSAGES', data.list)
    })
  },
  ADD_MESSAGE ({dispatch}, {text, teamId}) {
    return api.message.create({text, teamId})
      .then(_ => dispatch('FETCH_MESSAGES',{teamId}))
  },

  DELETE_BOARDFILE({dispatch}, {name, boardId}) {
    return api.boardfile.destroy({name, boardId})
      .then(_ => dispatch('FETCH_BOARD', {id: boardId}))
  },
  DELETE_CARDFILE({state, dispatch}, {name, cardId}) {
    return api.cardfile.destroy({name, cardId})
      .then(_ => {
        dispatch('FETCH_BOARD', {id: state.board.id})
        dispatch('FETCH_CARD', {id: cardId})
      })
  },

  FETCH_YU({ commit }) {
    return api.html.fetchYU().then(data => {
      commit('SET_YU', data.list)
    })
  },
}

export default actions
