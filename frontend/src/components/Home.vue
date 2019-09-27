<template>
  <div class="body">
    <div class="left-body">
      <UserInfo />
      <hr style="border: solid 2px rgba(255,255,255, 0.25); margin: 20px 10px 30px 10px;">
      <TeamBox class="myProjectTeam"/>
    </div>

    <div class="contain">
      <div class="team_box">
        <div class="home-title">Project</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div class="entire-boards" v-for="eb in entireBoards">
          <router-link style="text-decoration: none;" :to="`/b/${eb.id}`">
            <div class="content">{{eb.title}}</div>
          </router-link>
          <hr style="border: solid 0.5px black; margin: 0px; margin-left: 5px; margin-right: 5px"
          v-if = "eb != entireBoards[entireBoards.length - 1]">
        </div>
      </div><br>

      <div class="team_box board-box">
        <div class="home-title">Personal Boards</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div class="board-list" ref="boardList">
          <div class="board-item" v-for="b in boards" :key="b.id"
            :data-bgcolor="b.bgColor" ref="boardItem">
            <router-link :to="`/b/${b.id}`">
              <div class="board-item-title">{{b.title}}</div>
            </router-link>
          </div>
          <div class="board-item board-item-new">
            <a class="new-board-btn" href="" @click.prevent="SET_IS_ADD_BOARD(true)">
              Create new board...
            </a>
          </div>
        </div>
        <AddBoard v-if="isAddBoard" />
      </div>
    </div>

    <div class="right-body">
      <!-- <div class="team_box">test</div> -->
      <YUnotice />
    </div>

  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import AddBoard from './AddBoard.vue'
import UserInfo from './UserInfo.vue'
import TeamBox from './TeamBox.vue'
import SearchBox from './SearchBox.vue'
import YUnotice from './YUnotice.vue'

export default {
  components: {
    UserInfo,
    TeamBox,
    AddBoard,
    SearchBox,
    YUnotice
  },
  data() {
    return {
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      isAddBoard: 'isAddBoard',
      boards: 'boards',
      entireBoards: 'entireBoards'
    })
  },
  created() {
    this.fetchData()
    this.SET_THEME()
  },
  updated() {
    this.$refs.boardItem.forEach(el => {
      el.style.backgroundColor = el.dataset.bgcolor
    })
  },
  methods: {
    ...mapMutations([
      'SET_IS_ADD_BOARD',
      'SET_THEME'
    ]),
    ...mapActions([
      'FETCH_BOARDS',
      'FETCH_ENTIRE_BOARDS'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_ENTIRE_BOARDS().finally(_=> {
        this.FETCH_BOARDS().finally(_=> {
          this.loading = false
        })
      })
    }
  }
}
</script>

<style src="../css/main.css">
</style>
