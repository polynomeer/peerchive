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
        <div class="home-title">My Page{{boards.filter(function(item){return item.language === "Go"}).length}}</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div style="padding-top: 15px; padding-bottom: 10px">
          <div class="team_box" style="background-color: rgba(255, 0, 0, 0); padding-left:25px; padding-bottom: 15px">
            <div class="image-cropper">
                <img src="../assets/images/user_icon.png"/>
            </div>
            <div class="user-info" style="color:black">Email : {{user.email}}</div>
            <div class="user-info" style="color:black">Name : {{user.name}}</div>
            <div style="margin-bottom: 15px; color:black; padding: 15px;
              font-size: 18px;
              font-weight: bold;" >
              Git url :
              <a class="home-title-btn git"
              :href="user.git" target="_blank" v-if="user.git"><img src="../assets/images/git.png"></a>
              <span v-else>-- Not Set --</span>
            </div>
            <a class="home-title-btn" href="" @click.prevent="$router.push('/profile')">Edit Profile</a>
          </div>
        </div>
      </div><br>

      <div class="team_box">
        <div class="home-title">My Statistics</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div style="margin: 15px 15px 15px 15px">
          <!-- <canvas id="ability_chart" count="2"></canvas>
          <chartjs-radar target="ability_chart" :backgroundcolor="'rgba(255, 99, 132, 0.2)'" :bordercolor="'rgb(255, 99, 132)'" :pointBackgroundColor="'rgb(255, 99, 132)'" :labels="ability_label" :data="ability_set1" :bind="true"></chartjs-radar>
          <chartjs-radar target="ability_chart"  :backgroundcolor="'rgba(54, 162, 235, 0.2)'" :bordercolor="'rgb(54, 162, 235)'" :pointBackgroundColor="'rgb(54, 162, 235)'"
          :pointBorderColor="'rgb(54, 162, 235)'" :labels="ability_label" :data="ability_set" :bind="true"></chartjs-radar> -->
          <br>
          <!-- <canvas id="field_chart"></canvas> -->
          <column-chart title="Team Fields" :colors="['#ea80fc']" :data="fieldData"></column-chart>
          <br>
          <bar-chart title="Programming Languages" :data="languageData"></bar-chart>
        </div>
      </div><br>

      <div class="team_box">
        <div class="home-title">TimeLine</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <section class="timeline">
        <ol>
          <li v-for="b in boards">
            <router-link :to="`/b/${b.id}`">
              <div class="board-item board-item-title" :style="`background:${b.bgColor}`">
                <time>{{b.createdAt.substr(0,10)}}<br><br></time>
                -{{b.language}}- {{b.title}}<br><br>
                Desc : {{b.description}}<br><br>
                Part : {{b.team.name}} - {{b.team.members[0].field}} - {{b.team.members[0].part}}
              </div>
            </router-link>
          </li>
          <li>
            <div class="board-item board-item-new" style="padding:0; margin:0;">
              <a class="new-board-btn" href="" @click.prevent="SET_IS_ADD_BOARD(true)">
                Create new board...
              </a>
            </div>
          </li>
          <li></li>
        </ol>
      </section>
      <AddBoard v-if="isAddBoard" />
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
      // ability_label: ['Projects', 'Codes', 'gits', 'OpenSources', 'Contest', 'Paper'],
      // ability_set:         [75, 96, 60, 41, 56, 65],
      // ability_set1:        [85, 76, 80, 81, 66, 75],

      timeLine: null,
      loading: false,
      languages: ['Assembly language', 'C', 'C++', 'C#', 'Delphi/Object Pascal', 'Go', 'Groovy', 'Java', 'JavaScript', 'MATLAB', 'Objective-C', 'Perl','PHP', 'Python', 'R', 'Ruby', 'SQL', 'Swift', 'Visual Basic', 'Visual Basic.NET','etc'],
      fields: ['알고리즘','시스템','보안','게임','웹','모바일','임베디드','빅데이터','인공지능','etc'],
      languageData: [],
      fieldData: [],
      languageColor: ['#b00', '#666'],
      fieldColor: [],
      error: ''
    }
  },
  computed: {
    ...mapState({
      isAddBoard: 'isAddBoard',
      user: 'user',
      boards: 'boards',
      entireBoards: 'entireBoards',
      teams: 'teams',
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
  mounted() {
  },
  methods: {
    ...mapMutations([
      'SET_IS_ADD_BOARD',
      'SET_THEME',
      'LOGOUT'
    ]),
    ...mapActions([
      'FETCH_USER',
      'FETCH_BOARDS',
      'FETCH_ENTIRE_BOARDS'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_USER().finally(_=> {
        this.FETCH_ENTIRE_BOARDS().finally(_=> {
          this.FETCH_BOARDS().finally(_=> {
            this.languages.forEach(language => {
              this.languageData.push([language, this.boards.filter(function(board) { return board.language === language }).length])
            })
            let userId = this.user.id
            this.fields.forEach(field => {
               this.fieldData.push([field, this.teams.filter(function(team) { return team.members.filter(function(member) { return member.userId === userId && member.field === field}).length != 0 }).length])
            })
            console.log(this.fieldData)
            this.loading = false
          })
        })
      })
    }
  }
}
</script>


<style>
.timeline {
  white-space: nowrap;
  overflow-x: auto;
}

.timeline ol {
  font-size: 0;
  width: 100vw;
  padding: 250px 0;
  transition: all 1s;
}

.timeline ol li {
  position: relative;
  display: inline-block;
  list-style-type: none;
  width: 160px;
  height: 3px;
  background: Black;

}

.timeline ol li:last-child {
  width: 280px;
}

.timeline ol li:not(:first-child) {
  margin-left: 14px;
}

.timeline ol li:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 50%;
  left: calc(100% + 1px);
  bottom: 0;
  width: 12px;
  height: 12px;
  transform: translateY(-50%);
  border-radius: 50%;
  background: #6281B8;
}
.timeline ol li div {
  position: absolute;
  left: calc(100% + 7px);
  width: 280px;
  height: 150px;
  padding: 15px;
  font-size: 1rem;
  white-space: normal;
  color: white;
}
.timeline ol li div::before {
  content: '';
  position: absolute;
  top: 100%;
  left: 0;
  width: 0;
  height: 0;
  border-style: solid;
}
.timeline ol li:nth-child(odd) div {
  top: -16px;
  transform: translateY(-100%);
}
.timeline ol li:nth-child(odd) div::before {
  top: 100%;
  border-width: 8px 8px 0 0;
  border-color: black transparent transparent transparent;
}
.timeline ol li:nth-child(even) div {
  top: calc(100% + 16px);
}
.timeline ol li:nth-child(even) div::before {
  top: -8px;
  border-width: 8px 0 0 8px;
  border-color: transparent transparent transparent black;
}
.timeline .arrows {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}
.timeline .arrows .arrow__prev {
  margin-right: 20px;
}
.timeline .disabled {
  opacity: .5;
}
.timeline .arrows img {
  width: 45px;
  height: 45px;
}
</style>

<style src="../css/main.css">
</style>
