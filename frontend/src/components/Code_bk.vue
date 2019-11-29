<template>
  <code-modal>
    <div slot="header">
      <h2>
        Project Source Code
        <a href="" class="modal-default-button"
          @click.prevent="SET_IS_SHOW_CODE(false)">&times;</a>
      </h2>
    </div>
    <div slot="body">
      <h3>Description</h3>
      <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        :readonly="!toggleDesc"></textarea>

    </div>
    <div slot="footer">
      <button class="btn" type="submit">
        <a href="" @click.prevent="SET_IS_SHOW_CODE(false)">OK</a>
      </button>
      <button class="btn" type="button">
        <a href="" @click.prevent="SET_IS_SHOW_CODE(false)">Cancel</a>
      </button>
    </div>
  </code-modal>
</template>

<script>
import CodeModal from './CodeModal.vue'
import { mapMutations, mapActions } from 'vuex'

export default {
  components: { CodeModal },
  data () {
    return {
      inputBoardTitle: '',
      // isValidInput: true
    }
  },
  watch: {
    inputBoardTitle(val) {
      this.isValidInput = !!val.trim().length
    }
  },
  mounted () {
    // this.$refs.inputBoardTitle.focus()
  },
  methods: {
    ...mapMutations([
      'SET_IS_SHOW_CODE'
    ]),
    ...mapActions([
      // 'ADD_BOARD'
    ])
  }
}
</script>
