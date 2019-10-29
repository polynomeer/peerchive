<template>
  <div class="YU-notice">
    <div class="team_box study_box">
      <div class="home-title">New Teams</div>
      <hr style="border: solid 2px #6281B8; margin: 0px;">
      <div class="entire-teams" v-for="et in entireTeams">
        <router-link style="text-decoration: none;" :to="`/t/${et.id}`">
          <div class="content">{{et.name}}</div>
        </router-link>
        <hr style="border: solid 0.5px black; margin: 0px; margin-left: 5px; margin-right: 5px"
        v-if = "et != entireTeams[entireTeams.length - 1]">
      </div>
    </div><br>

    <div class="team_box yu-box">
      <div class="home-title">
        <a style="color:black; text-decoration: none;" href="http://www.yu.ac.kr/_korean/main/index.php">
          YU notice
        </a>
      </div>
      <hr style="border: solid 2px #6281B8; margin: 0px;">
      <div class="yu-list" v-for="yu in yuList">
        <a :href="`${yu.url}`" class="content" target="_blank">{{yu.title}}</a>
        <hr v-if = "yu != yuList[yuList.length - 1]">
      </div>
    </div>
  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import AddBoard from './AddBoard.vue'
import UserInfo from './UserInfo.vue'
import YUnotice from './YUnotice.vue'

export default {
  data() {
    return {
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      yuList: 'yuList',
      entireTeams: 'entireTeams'
    })
  },
  created() {
    this.fetchData()
  },
  methods: {
    ...mapActions([
      'FETCH_YU',
      'FETCH_ENTIRE_TEAMS',
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_YU().finally(_=> {
        this.FETCH_ENTIRE_TEAMS().finally(_=> {
          this.loading = false
        })
      })
    }
  }
}
</script>

<style>
.yu-list{
  padding:5px;
  text-overflow:ellipsis;
  /* white-space:nowrap; */
  overflow: hidden;
}
.YU-notice {
  /* width:100%; */
  height:auto;
  /* float:left; */
  /* margin:5px; */
}
.study_box{
  background-color:white;
  /* margin:10px; */
}
.yu-box{
  background-color:white;
  /* margin:10px; */
}
.content {
  text-decoration: none;
  /* padding: 5px; */
  /* padding-left: 20px; */
  /* font-size: 15px; */
  color: black;
  text-decoration: none;
}
.home-title {
  /* padding: 10px; */
  font-size: 18px;
  font-weight: bold;
}
</style>
