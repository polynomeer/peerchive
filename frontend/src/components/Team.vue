<template>
  <div class="body">
    <div class="left-body">
      <UserInfo />
      <hr style="border: solid 2px rgba(255,255,255, 0.25); margin: 20px 10px 30px 10px;">
      <TeamBox class="myProjectTeam"/>
    </div>

    <div class="contain">
      <!-- <SearchBox /> -->
      <div class="team_box">
        <div class="team-title">
          <input class="form-control" style="width:200px" v-if="isEditName" type="text" v-model="inputName"
            ref="inputName" @keyup.enter="onSubmitName" @blur="onSubmitName">
          <span class="home-title" v-else @click="onClickName">
            {{team.name}}
            <button class="btn btn-success" @click="onJoinTeam" style="margin-left:10px"
            v-if="(team.members.map(value => value.userId)).includes(user.id) == false">
            Team Join</button>
          </span>
          <span class="home-title-tab">
            <a class="home-title-btn git" v-if="team.git" :href="team.git" target="_blank"><img src="../assets/images/git.png"></a>
            <a class="home-title-btn calendar" href="" @click.prevent="onClickCalendar">Calendar</a>
          </span>
        </div>

        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div class="content">
          <span>Git url :</span>
          <input class="form-control" style="display:inline" v-if="isEditGit" type="text" v-model="inputGit"
            ref="inputGit" @keyup.enter="onSubmitGit()" @blur="onSubmitGit()">
          <span @click="onClickGit()" v-else>{{team.git ? team.git : '-- Not Set --'}}</span>
        </div>
      </div>
      <br>

      <div class="team_box">
        <div class="home-title">Team Members</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div v-for="tm in team.members">
          <div class="content">
            <span>Name : {{tm.user.name}}</span>
            <span style="margin-left:30px;">Email : {{tm.user.email}}</span>
            <span style="margin-left:30px;">Field : </span>
            <select :disabled="tm.userId!=user.id" @change="onChangeField(tm, $event)">
              <option disabled v-bind:value="null" :selected="tm.field == null">-- Select Field --</option>
              <option v-for="f in fields" v-bind:value="f" :selected="tm.field == f">{{f}}</option>
            </select>
            <span style="margin-left:30px;">Part : </span>
            <input class="form-control" style="width:150px; display:inline" v-if="isEditPart && tm.userId==user.id" type="text" v-model="inputPart"
              ref="inputPart" @keyup.enter="onSubmitPart(tm)" @blur="onSubmitPart(tm)">
            <span @click="onClickPart(tm)" v-else-if="tm.userId==user.id">{{tm.part}}</span>
            <span v-else>{{tm.part}}</span>
            <span style="margin-left:30px;">State : </span>
            <b style="color: Green;" v-if="tm.user.isOnline == 1">Online</b>
            <b style="color: Red;" v-else>Offline</b>
            <button class="btn btn-success" @click="onDrop(tm.user)" style="margin-left:20px; background-color:red; box-shadow: 0 1px 0 darkred;"
            v-if="tm.userId==user.id">Drop</button>
          </div>
          <hr style="border: solid 0.5px black; margin: 0px; margin-left: 5px; margin-right: 5px"
          v-if = "tm != team.members[team.members.length - 1]">
        </div>
      </div><br>

      <div class="team_box" v-if="(team.members.map(value => value.userId)).includes(user.id) && team.joins.length > 0">
        <div class="home-title">Join Users</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div v-for="tj in team.joins">
          <div class="content">
            <span>Name : {{tj.user.name}}</span>
            <span style="margin-left:30px;">Email : {{tj.user.email}}</span>
            <button class="btn btn-success" @click="onJoin(tj.user)" style="margin-left:10px;">Accept</button>
            <button class="btn btn-success" @click="onDecline(tj.user)"
            style="margin-left:10px; background-color:red; box-shadow: 0 1px 0 darkred;">Decline</button>
          </div>
          <hr style="border: solid 0.5px black; margin: 0px; margin-left: 5px; margin-right: 5px"
          v-if = "tj != team.joins[team.joins.length - 1]">
        </div>
      </div>

      <div class="team_box">
        <div class="home-title">Team Boards</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div class="board-list" style="max-height:500px; overflow:auto" ref="boardList">
          <div class="board-item" v-for="tb in teamBoards" :key="tb.id"
            :data-bgcolor="tb.bgColor" ref="boardItem">
            <router-link :to="`/b/${tb.id}`">
              <div class="board-item-title">{{tb.title}}</div>
            </router-link>
          </div>
          <div class="board-item board-item-new" v-if="(team.members.map(value => value.userId)).includes(user.id)">
            <a class="new-board-btn" href="" @click.prevent="SET_IS_ADD_BOARD(true)">
              Create new team board...
            </a>
          </div>
        </div>
        <AddBoard v-if="isAddBoard && (team.members.map(value => value.userId)).includes(user.id)" />
      </div>
    </div>

    <div class="right-body">
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
      isEditName: false,
      inputName: '',
      isEditPart: false,
      inputPart: '',
      isEditGit: false,
      inputGit: '',
      fields: ['알고리즘','시스템','보안','게임','웹','모바일','임베디드','빅데이터','인공지능','etc'],
      tid: 0,
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      isAddBoard: 'isAddBoard',
      teamBoards: 'teamBoards',
      team: 'team',
      user: 'user'
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
  beforeRouteUpdate (to, from, next) {
    next()
    this.fetchData()
  },
  methods: {
    ...mapMutations([
      'SET_IS_ADD_BOARD',
      'SET_THEME'
    ]),
    ...mapActions([
      'FETCH_TEAM_BOARDS',
      'FETCH_TEAM',
      'UPDATE_TEAM',
      'ADD_JOIN',
      'DELETE_JOIN',
      'ADD_MEMBER',
      'DELETE_MEMBER',
      'UPDATE_MEMBER'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_TEAM({id: this.$route.params.tid}).finally(_=> {
        this.FETCH_TEAM_BOARDS({teamId: this.$route.params.tid}).finally(_=> {
          this.inputName = this.team.name
          this.inputGit = this.team.git
          this.loading = false
        })
      })
    },
    onClickName() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditName = true
      this.$nextTick(_=> this.$refs.inputName.focus())
    },
    onSubmitName() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditName = false

      this.inputName = this.inputName.trim()
      if (!this.inputName) return

      const id = this.team.id
      const name = this.inputName
      if (name === this.team.name) return

      this.UPDATE_TEAM({ id, name })
    },
    onJoinTeam() {
      if (!confirm(`Join Team?`)) return
      this.ADD_JOIN({teamId: this.team.id})
    },
    onJoin(user) {
      if (!confirm(`Join ${user.name}?`)) return
      this.ADD_MEMBER({teamId: this.team.id, userId:user.id})
      this.DELETE_JOIN({teamId: this.team.id, userId:user.id})
    },
    onDecline(user) {
      if (!confirm(`Decline ${user.name}?`)) return
      this.DELETE_JOIN({teamId: this.team.id, userId:user.id})
    },
    onDrop(user) {
      if (!confirm(`Drop ${user.name} from ${this.team.name}?`)) return
      this.DELETE_MEMBER({teamId: this.team.id, userId:user.id})
      .then(_=> this.$router.push('/'))
    },
    onClickPart(member) {
      if(member.userId != this.user.id) return
      this.isEditPart = true
      this.$nextTick(_=> this.$refs.inputPart[0].focus())
      this.inputPart = member.part
    },
    onSubmitPart(member) {
      if(member.userId != this.user.id) return
      this.isEditPart = false

      this.inputPart = this.inputPart.trim()
      if (!this.inputPart) return

      const teamId = this.team.id
      const userId = member.userId
      const part = this.inputPart
      if (part === member.part) return

      this.UPDATE_MEMBER({ teamId, userId, part })
    },
    onChangeField(member, event) {
      if(member.userId != this.user.id) return

      const field = event.target.value.trim()
      if (!field) return

      const teamId = this.team.id
      const userId = member.userId
      if (field === member.field) return

      this.UPDATE_MEMBER({ teamId, userId, field })
    },
    onClickGit() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditGit = true
      this.$nextTick(_=> this.$refs.inputGit.focus())
    },
    onSubmitGit() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditGit = false

      this.inputGit = this.inputGit.trim()
      if (!this.inputGit) return

      const id = this.team.id
      const git = this.inputGit
      if (git === this.team.git) return

      this.UPDATE_TEAM({ id, git })
    },
  }
}
</script>

<style>
.team-title{
    padding: 5px 0 5px 0;
}
</style>

<style src="../css/main.css">
</style>
