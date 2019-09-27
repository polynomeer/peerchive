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
        <div class="home-title">Search Result</div>
        <hr style="border: solid 2px #6281B8; margin: 0px;">
        <div class="board-list" ref="boardList" style="max-height:750px; overflow:auto" v-if="searchResult.length > 0">
          <div v-for="sr in searchResult" style="width:90%">
            <div class="board-item" style="float:left; margin-right: 50px":key="sr.id"
              :data-bgcolor="sr.bgColor" ref="boardItem">
              <router-link :to="`/b/${sr.id}`">
                <div class="board-item-title">-{{sr.language}}- {{sr.title}}</div>
              </router-link>
            </div>
            <p style="font-weight:bold">{{sr.title}}</p>
            <ul>
              <li>Main language: {{sr.language}}</li>
              <li>Period: {{sr.createdAt.split('T')[0]}} ~ {{sr.updatedAt.split('T')[0]}}</li>
              <li>Project Description</li>
              <ul v-if="sr.description.length > 100">{{sr.description.substr(0, 100)}}...</ul>
              <ul v-else>{{sr.description}}</ul>
              <li>Hits: {{sr.hits}}</li>
            </ul>
          </div>
        </div>
        <div style="padding: 20px;" v-else>
          <p>'{{$route.params.keyword.replace(/[+]/gi, ' ')}}'에 대한 검색결과가 없습니다.</p>
          <ul>
            <li>단어의 철자가 정확한지 확인해 보세요.</li>
            <li>한글을 영어로 혹은 영어를 한글로 입력했는지 확인해 보세요.</li>
            <li>검색어의 단어 수를 줄이거나, 보다 일반적인 검색어로 다시 검색해 보세요.</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="right-body">
      <YUnotice />
    </div>

  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import UserInfo from './UserInfo.vue'
import TeamBox from './TeamBox.vue'
import YUnotice from './YUnotice.vue'
import SearchBox from './SearchBox.vue'

export default {
  components: {
    UserInfo,
    TeamBox,
    SearchBox,
    YUnotice
  },
  data() {
    return {
      projectSearch:'',
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      user: 'user',
      searchResult: 'searchResult'
    })
  },
  created() {
    if(this.$route.params.keyword)
      this.projectSearch = this.$route.params.keyword.replace(/[+]/gi, ' ')
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
      'SET_THEME',
      'LOGOUT'
    ]),
    ...mapActions([
      'SEARCH_BOARDS'
    ]),
    fetchData() {
      this.loading = true
      this.SEARCH_BOARDS({keyword: this.$route.params.keyword}).finally(_=> {
        this.loading = false
      })
    }
  }
}
</script>

<style src="../css/main.css">
</style>
