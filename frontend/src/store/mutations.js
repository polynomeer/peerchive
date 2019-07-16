import {setAuthInHeader} from '../api'
import io from 'socket.io-client'

const mutations = {
  LOGIN (state, token) {
    if (!token) return
    //state.socket = io.connect('http://165.229.126.52:12000')  // chat server 주소
    state.socket = io.connect('http://localhost:10000')
    state.token = token
    localStorage.setItem('token', token)
    setAuthInHeader(token)
  },
  LOGOUT (state) {
    state.socket.disconnect()
    state.token = null
    delete localStorage.token
    setAuthInHeader(null)
  },
  SET_USER (state, user) {
    state.user = user
  },
  SET_IS_ADD_TEAM (state, toggle) {
    state.isAddTeam = toggle
  },
  SET_TEAMS(state, teams) {
    state.teams = teams
  },
  SET_ENTIRE_TEAMS(state, entireTeams) {
    state.entireTeams = entireTeams
  },
  SET_TEAM(state, team) {
    state.team = team
  },
  SET_IS_ADD_BOARD (state, toggle) {
    state.isAddBoard = toggle
  },
  SET_BOARDS (state, boards) {
    state.boards = boards
  },
  SET_TEAM_BOARDS (state, teamBoards) {
    state.teamBoards = teamBoards
  },
  SET_BOARD (state, board) {
    state.board = board
  },
  SET_CARD(state, card) {
    state.card = card
  },
  SET_ENTIRE_BOARDS (state, entireBoards) {
    state.entireBoards = entireBoards
  },
  SET_SEARCH_RESULT(state, searchResult) {
    state.searchResult = searchResult
  },
  SET_THEME (state, color) {
    state.bodyColor = color || '#6281B8'
    state.navbarColor = color ? 'rgba(0,0,0,.15)' : '#6281B8'
  },
  SET_IS_SHOW_BOARD_SETTINGS (state, toggle) {
    state.isShowBoardSettings = toggle
  },

  SET_IS_SHOW_CODE (state, toggle) {
    state.isShowCode = toggle
  },
  SET_IS_SHOW_CALENDAR (state, toggle) {
    state.isShowCalendar = toggle
  },
  SET_MESSAGES (state, messages) {
    state.messages = messages
  },
  SET_YU (state, list) {
    state.yuList = list
  },
}

export default mutations
