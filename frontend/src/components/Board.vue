<template>
  <div>
    <div class="board-wrapper">
      <div class="board">
        <div class="board-header">
          <input class="form-control" v-if="isEditTitle" type="text" v-model="inputTitle"
            ref="inputTitle" @keyup.enter="onSubmitTitle" @blur="onSubmitTitle">
          <span v-else class="board-title" @click="onClickTitle">{{board.title}}</span>
          <router-link class="board-header-btn team-page"  :to="`/t/${board.teamId}`">Team Page</router-link>
          <a class="board-header-btn team-join" @click="onJoinTeam"
          v-if="(team.members.map(value => value.userId)).includes(user.id) == false">
          Team Join</a>
          <a class="board-header-btn git" v-if="team.git" :href="team.git" target="_blank"><img src="../assets/images/git.png"></a>
          <a class="board-header-btn calendar" href="" @click.prevent="onClickCalendar">Calendar</a>
          <a class="board-header-btn source-code" href="" @click.prevent="onClickCode">Code</a>
          <a class="board-header-btn show-menu" href="" @click.prevent="onShowSettings">
            ... Show Menu
          </a>
        </div>
        <div class="list-section-wrapper">
          <div class="list-section">
            <div class="list-wrapper" v-for="list in board.lists" :key="list.pos" :data-list-id="list.id">
              <List :data="list" />
            </div>
            <div class="list-wrapper">
              <AddList v-if="(team.members.map(value => value.userId)).includes(user.id)" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <left></left>    <!-- slide menu -->
    <Code :data="board" v-if="isShowCode" />
    <Calendar v-if="isShowCalendar" />
    <BoardSettings v-if="isShowBoardSettings" />
    <router-view></router-view>
  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import List from './List.vue'
import BoardSettings from './BoardSettings.vue'
import AddList from './AddList.vue'
import Left from './Left.vue'
import Code from './Code.vue'
import Calendar from './Calendar.vue'
import dragger from '../utils/dragger'

export default {
  components: {
    List,
    BoardSettings,
    AddList,
    Left,
    Code,
    Calendar
  },
  data() {
    return {
      bid: 0,
      loading: false,
      cDragger: null,
      lDragger: null,
      isEditTitle: false,
      inputTitle: ''
    }
  },
  computed: {
    ...mapState({
      board: 'board',
      isShowBoardSettings: 'isShowBoardSettings',
      user: 'user',
      team: 'team',
      isShowCode: 'isShowCode',
      isShowCalendar: 'isShowCalendar'
    })
  },
  created() {
    this.fetchData().then(() => {
      this.inputTitle = this.board.title
      this.SET_THEME(this.board.bgColor)
    })
    this.SET_IS_SHOW_BOARD_SETTINGS(false)
  },
  updated() {
    if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
    this.setCardDragabble()
    this.setListDragabble()
  },
  methods: {
    ...mapMutations([
      'SET_THEME',
      'SET_IS_SHOW_BOARD_SETTINGS',
      'SET_IS_SHOW_CODE',
      'SET_IS_SHOW_CALENDAR'
    ]),
    ...mapActions([
      'FETCH_USER',
      'FETCH_TEAM',
      'ADD_JOIN',
      'FETCH_BOARD',
      'UPDATE_CARD',
      'UPDATE_BOARD',
      'UPDATE_LIST',
      'HIT_BOARD'
    ]),
    fetchData() {
      this.loading = true
      return this.FETCH_BOARD({id: this.$route.params.bid}).then(() => {
          this.FETCH_TEAM({id: this.board.teamId}).then(() => {
            this.FETCH_USER().then(() => {
              if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false)
                this.HIT_BOARD({id: this.$route.params.bid})
            })
          })
          this.loading = false
        })
    },
    onShowSettings() {
      this.SET_IS_SHOW_BOARD_SETTINGS(true)
    },
    onClickTitle() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditTitle = true
      this.$nextTick(_=> this.$refs.inputTitle.focus())
    },
    onClickCode(){
      this.SET_IS_SHOW_CODE(true)
    },
    onClickCalendar(){
      this.SET_IS_SHOW_CALENDAR(true)
    },
    onSubmitTitle() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditTitle = false

      this.inputTitle = this.inputTitle.trim()
      if (!this.inputTitle) return

      const id = this.board.id
      const title = this.inputTitle
      if (title === this.board.title) return

      this.UPDATE_BOARD({ id, title })
    },
    setCardDragabble() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      if (this.cDragger) this.cDragger.destroy()

      this.cDragger = dragger.init(Array.from(this.$el.querySelectorAll('.card-list')))
      this.cDragger.on('drop', (el, wrapper, target, silblings) => {
        const targetCard = {
          id: el.dataset.cardId * 1,
          listId: wrapper.dataset.listId * 1,
          pos: 65535,
        }
        const {prev, next} = dragger.sibling({
          el,
          wrapper,
          candidates: Array.from(wrapper.querySelectorAll('.card-item')),
          type: 'card'
        })

        if (!prev && next) targetCard.pos = next.pos / 2
        else if (!next && prev) targetCard.pos = prev.pos * 2
        else if (next && prev) targetCard.pos = (prev.pos + next.pos) / 2
        this.UPDATE_CARD(targetCard)
      })
    },
    setListDragabble() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      if (this.lDragger) this.lDragger.destroy()

      const options = {
        invalid: (el, handle) => !/^list/.test(handle.className)
      }
      this.lDragger = dragger.init(
        Array.from(this.$el.querySelectorAll('.list-section')),
        options
      )
      this.lDragger.on('drop', (el, wrapper, target, silblings) => {
        const targetList = {
          id: el.dataset.listId * 1,
          pos: 65535,
        }
        const {prev, next} = dragger.sibling({
          el,
          wrapper,
          candidates: Array.from(wrapper.querySelectorAll('.list')),
          type: 'list'
        })

        if (!prev && next) targetList.pos = next.pos / 2
        else if (!next && prev) targetList.pos = prev.pos * 2
        else if (next && prev) targetList.pos = (prev.pos + next.pos) / 2
        this.UPDATE_LIST(targetList)
      })
    },
    onJoinTeam() {
      if (!confirm(`Join Team?`)) return
      this.ADD_JOIN({teamId: this.board.teamId})
    },
  }
}
</script>

<style>
.board-wrapper {
  position: absolute;
  /* position: fixed; */
  top: 0;
  bottom: 0;
  right: 0;
  left: 0;
}
.board {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.board-header {
  flex: none;
  padding: 5px 4px 10px 8px;
  margin: 0;
  height: 46px;
  line-height: 32px;
}
.button {
  border: 0;
  outline: 0;
}
.board-header input[type=text] {
  width: 200px;
}
.board-header-btn {
  border-radius: 4px;
  padding: 2px 10px;
  height: auto;
  margin-bottom: 15px;
  display: inline-block;
  color: #fff;
  background-color: rgba(255,255,255,.2);
}
.board-header-btn:hover,
.board-header-btn:focus {
  background-color: rgba(0,0,0,.15);
  cursor: pointer;
}
.board-title {
  font-weight: 700;
  font-size: 18px;
}
.show-menu {
  font-size: 14px;
  position: absolute;
  right: 15px;
}
.list-section-wrapper {
  flex-grow: 1;
  position: relative;
}
.list-section {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  padding: 0 10px;
}
.list-wrapper {
  display: inline-block;
  height: 100%;
  width: 272px;
  vertical-align: top;
  margin-right: 5px;
}
.card-item.gu-transit {
  background-color: #555 !important;
}
.card-item.gu-mirror {
  opacity: 1 !important;
  background-color: #fff !important;
  transform: rotate(3deg) !important;
}
::-webkit-scrollbar{width: 0px; height:12px;}
::-webkit-scrollbar-track {background-color:#536E9D;border-radius: 5px;}
::-webkit-scrollbar-thumb {background-color:#91A7CD;border-radius: 5px;}
::-webkit-scrollbar-thumb:hover {background: #3C5278;}
::-webkit-scrollbar-button:start:decrement,::-webkit-scrollbar-button:end:increment {
width:0px;height:0px;background:#536E9D;}
</style>
