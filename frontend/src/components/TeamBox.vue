<template lang="html">
  <div class="team_box">
    <div class="home-title">My Project Team</div>
    <hr style="border: solid 2px #6281B8; margin: 0px;">
    <div v-for="t in teams" :key="t.id">
      <router-link style="text-decoration: none;" :to="`/t/${t.id}`">
        <div class="content">{{t.name}}</div>
      </router-link>
      <hr style="border: solid 0.5px black; margin: 0px 5px 0px 5px;">
    </div>
    <div class="home-title" href="" @click.prevent="SET_IS_ADD_TEAM(true)">
      <a href="#" style="text-decoration:none; color:black">&nbsp;&nbsp;&plus; Create Team</a>
      <!-- &plus; Create Team -->
    </div>
    <AddTeam v-if="isAddTeam" />
  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import AddTeam from './AddTeam.vue'

export default {
  components: {
    AddTeam,
  },
  data() {
    return {
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      isAddTeam: 'isAddTeam',
      teams: 'teams'
    })
  },
  created() {
    this.fetchData()
  },
  methods: {
    ...mapMutations([
      'SET_IS_ADD_TEAM',
    ]),
    ...mapActions([
      'FETCH_TEAMS'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_TEAMS().finally(_=> {
        this.loading = false
      })
    }
  }
}
</script>

<style>
.team_box{
  color:black;
  background-color:white;
  /* margin:10px; */
}
</style>
