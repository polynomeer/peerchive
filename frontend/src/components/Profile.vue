<template>
  <div class="profile">
    <div class="left-body">
      <UserInfo />
      <hr style="border: solid 2px #A1C1F8; margin: 20px; margin-left: 10px; margin-right: 10px;">
      <TeamBox />
    </div>
    <div class="contain">
      <div class="team_box">
        <div class="home-title">Edit Profile</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <form @submit.prevent="onSubmit">
          <div class="image-cropper" style="margin-left:20px">
              <img src="../../user_icon.png"/>
          </div>
          <div style="margin:20px 10px 20px 10px;">
            <label class="content" for="email">Email : </label>
            <label class="content" style="font-weight:bold" for="email">{{email}}</label>
          </div>
          <div style="margin:20px 10px 20px 10px;">
            <label class="content" for="name">Name</label>
            <input class="form-control" style="margin-top:10px; margin-left:150px; width:200px" type="text"
              v-model="name" autofocus placeholder="name" />
          </div>
          <div style="margin:20px 10px 20px 10px;">
            <label class="content" for="git">Git url</label>
            <input class="form-control" style="margin-top:10px; margin-left:150px; width:200px" type="text"
              v-model="git" autofocus placeholder="git url" />
          </div>
          <div style="padding:20px 10px 20px 20px;">
            <button class="btn" :class="{'btn-success': !invalidForm}" @click.prevent="onUpdateUser"
              :disabled="invalidForm">Update</button>
            <router-link class="btn" :class="'btn-success'" style="text-decoration: none;" :to="`/mypage/changepw`">
              <div>Change pw</div>
            </router-link>
            <button class="btn" :class="'btn-success'" @click.prevent="onDeleteUser">Account Delete</button>
          </div>
        </form>
        <p class="error" v-if="error">{{error}}</p>
      </div>
    </div>

    <div class="left-body">
      <YUnotice />
    </div>

  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import UserInfo from './UserInfo.vue'
import TeamBox from './TeamBox.vue'
import SearchBox from './SearchBox.vue'
import YUnotice from './YUnotice.vue'

export default {
  components: {
    UserInfo,
    TeamBox,
    SearchBox,
    YUnotice
  },
  data() {
    return {
      loading: false,
      email: '',
      name: '',
      git: '',
      error: '',
    }
  },
  computed: {
    ...mapState({
      user: 'user',
    }),
    invalidForm() {
      return !this.email || !this.name
    }
  },
  created() {
    this.fetchData()
    this.SET_THEME()
    this.email = this.user.email
    this.name = this.user.name
    this.git = this.user.git
  },
  updated() {
    this.$refs.boardItem.forEach(el => {
      el.style.backgroundColor = el.dataset.bgcolor
    })
  },
  methods: {
    ...mapMutations([
      'SET_THEME'
    ]),
    ...mapActions([
      'FETCH_USER',
      'UPDATE_USER',
      'DELETE_USER'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_USER().finally(_=> {
      })
    },
    onUpdateUser() {
      this.UPDATE_USER({name: this.name, git: this.git})
      .then(_=> this.$router.push('/'))
    },
    onDeleteUser() {
      if (!confirm(`Delete ${this.user.email} Account?`)) return
      this.DELETE_USER()
      .then(_=> this.LOGOUT())
      .then(_=> this.$router.push('/login'))
    },
  }
}
</script>

<style>

/* .side_box {
  width:23%;
  height:auto;
  float:left;
  margin:5px;
}
.contain{
  width:50%;
  height:auto;
  float:left;
  margin:5px;
} */
.profile{
  display:flex;
}
.left-body {
  width:25%;
  height:auto;
}
.contain{
  width:50%;
  height:auto;
  margin:10px;
}
.right-body{
  width:25%;
}
.team_box{
  background-color:white;
}
.content {
  text-decoration: none;
  padding: 5px;
  padding-left: 20px;
  font-size: 15px;
}
.error {
  color: #f00;
}
.user-info {
  padding: 5px;
  font-size: 18px;
  color: white;
  font-weight: bold;
}
.user-info a {
  text-decoration: none;
  border-radius: 4px;
  padding: 2px 10px;
  height: auto;
  margin-bottom: 15px;
  display: inline-block;
  color: #fff;
  background-color: rgba(255,255,255,.2);
}
.user-info a:hover,
.user-info a:focus {
  background-color: rgba(0,0,0,.15);
  cursor: pointer;
}
.myProjectTeam a {
  text-decoration: none;
  color:black;
  display: block;
  width:100%;
  height: 100%;
}
.myProjectTeam a:hover,
.myProjectTeam a:focus {
  background-color: rgba(0,0,0, .2);
  color: rgba(0,0,0, .5);
  /* border-radius: 10px; */
}
.right-body a {
  text-decoration: none;
  display: block;
  width:100%;
  height: 100%;
}
.right-body a:hover,
.right-body a:focus {
  background-color: rgba(0,0,0, .2);
  color: #666;
}

.home-title {
  padding: 10px;
  font-size: 18px;
  font-weight: bold;
}
.entire-boards a {
  text-decoration: none;
  display: block;
  width:100%;
  height: 100%;
}
.entire-boards a:hover,
.entire-boards a:focus {
  background-color: rgba(0,0,0, .2);
  color: #666;
  /* border-radius: 10px; */
}

.home-title {
  padding: 10px;
  font-size: 18px;
  font-weight: bold;
}
.board-list {
  padding: 20px;
  display: flex;
  flex-wrap: wrap;
}
.board-item {
  width: 48%;
  height: 200px;
  margin: 0 1% 20px 1%;
  border-radius: 10px;
}
.board-item-new {
  background-color: #ddd;
}
.board-item a {
  text-decoration: none;
  display: block;
  width:100%;
  height: 100%;
}
.board-item a:hover,
.board-item a:focus {
  background-color: rgba(0,0,0, .1);
  color: #666;
  border-radius: 10px;
}
.board-item-title {
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  padding: 20px;
}
.board-item a.new-board-btn {
  display: table-cell;
  vertical-align: middle;
  text-align: center;
  height: inherit;
  width: 1%;
  color: #888;
  font-weight: 700;
}
.image-cropper {
    float:left;
    margin-right: 20px;
    width: 100px;
    height: 100px;
    overflow: hidden;
    border-radius: 50%;
    text-align: center;
}
img {
    vertical-align: middle;
    display: inline;
    height: 100%;
    width: auto;
}
</style>
