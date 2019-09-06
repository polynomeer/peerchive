<template>
  <Modal>
    <div slot="header">
      <h2>
        Create new board
        <a href="" class="modal-default-button"
          @click.prevent="SET_IS_ADD_BOARD(false)">&times;</a>
      </h2>
    </div>
    <div slot="body">
      <form id="add-board-form"
        @submit.prevent="addBoard">
        <select style="margin-bottom: 10px" v-model="selectTeam" v-if="!$route.params.tid">
          <option v-bind:value="null">-- Create Team --</option>
          <option v-for="t in teams" v-bind:value="t.id">{{t.name}}</option>
        </select>
        <select style="margin-bottom: 10px" v-model="selectLanguage">
          <option disabled v-bind:value="null">-- Select Main Language --</option>
          <option v-for="l in languages" v-bind:value="l">{{l}}</option>
        </select>
        <input class="form-control" type="text" v-model="input" ref="input" placeholder="board title">
        <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        v-model="description" ref="inputDesc"></textarea>
      </form>
    </div>
    <div slot="footer">
      <button class="btn" :class="{'btn-success': valid && valid2 && selectLanguage}" type="submit"
        form="add-board-form" :disabled="!(valid && valid2 && selectLanguage)">
        Create <span v-if="$route.params.tid">{{team.name}}</span> Board</button>
    </div>
  </Modal>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'
import Modal from './Modal.vue'

export default {
  components: {
    Modal
  },
  data() {
    return {
      tid: 0,
      input: '',
      description: '',
      selectTeam: null,
      selectLanguage: null,
      valid: false,
      valid2: false,
      languages: ['Assembly language', 'C', 'C++', 'C#', 'Delphi/Object Pascal', 'Go', 'Groovy', 'Java', 'JavaScript', 'MATLAB', 'Objective-C', 'Perl','PHP', 'Python', 'R', 'Ruby', 'SQL', 'Swift', 'Visual Basic', 'Visual Basic.NET','etc'],
    }
  },
  computed: {
    ...mapState({
      team: 'team',
      teams: 'teams'
    })
  },
  watch: {
    input(v) {
      this.valid = v.trim().length > 0
    },
    description(v) {
      this.valid2 = v.trim().length > 0
    }
  },
  mounted() {
    this.$refs.input.focus()
    if(this.$route.params.tid) this.selectTeam = this.$route.params.tid
  },
  methods: {
    ...mapMutations([
      'SET_IS_ADD_BOARD'
    ]),
    ...mapActions([
      'ADD_BOARD',
      'FETCH_BOARDS'
    ]),
    addBoard() {
      this.ADD_BOARD({title: this.input, description: this.description, teamId: this.selectTeam})
        .then(({id}) => this.$router.push(`/b/${id}`))
        .catch(err => console.error(err))
        .finally(() => this.SET_IS_ADD_BOARD(false))
    }
  }
}
</script>

<style>

</style>
