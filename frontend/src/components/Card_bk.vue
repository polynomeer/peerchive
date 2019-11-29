<!-- <template>
  <Modal class="modal-card">
    <div slot="header" class="modal-card-header">
      <div class="modal-card-header-title">
        <input class="form-control" type="text" :value="card.title"
          :readonly="!toggleTitle" @click="toggleTitle=true" @blur="onBlurTitle"
          ref="inputTitle" v-if="user.id == board.userId">
        <label for="email" v-else>{{card.title}}</label>
      </div>
      <a class="modal-close-btn" href="" @click.prevent="onClose">&times;</a>
    </div>
    <div slot="body">
      <h3>Description</h3>
      <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        :readonly="!toggleDesc" @click="toggleDesc=true" @blur="onBlurDesc"
        v-model="card.description" ref="inputDesc" v-if="user.id == board.userId"></textarea>
      <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        :readonly="true" v-model="card.description" ref="inputDesc" v-else></textarea>

    </div>
    <div slot="footer"></div>
  </Modal>
</template> -->

<template>
  <card-modal class="modal-card">
    <div slot="header" class="modal-card-header">
      <div class="modal-card-header-title">
        <input class="form-control" type="text" :value="card.title" :readonly="!toggleTitle"
          @click.prevent="toggleTitle=!toggleTitle" @blur="onBlurTitle"
          ref="inputTitle">
      </div>
      <a class="modal-close-btn" href="" @click.prevent="onClose">&times;</a>
      <!-- <a class="modal-close-btn" href="" @click.prevent="onClickClose">&times;</a> -->
    </div>

    <div slot="description" class="modal-card-body">
      <h3>Description</h3>
      <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        :readonly="!toggleDesc"
        @click.prevent="toggleDesc=!toggleDesc" @blur="onBlurInputDesc"
        ref="inputDesc" v-model="card.description"></textarea>
    </div>

    <div slot="activity" class="modal-card-body">
      <h3>Activity</h3>
      <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
        :readonly="!toggleDesc"
        @click.prevent="toggleDesc=!toggleDesc" @blur="onBlurInputDesc"
        ref="inputDesc" v-model="card.activity"></textarea>
    </div>

  <!-- <div slot="menu" class="modal-card-menu"> -->
  <div slot="menu" class="modal-card-menu">
    <a class="list1" href="" @click.prevent="onClick1">click1</a><br><br>
    <a class="list1" href="" @click.prevent="onClick1">click1</a><br><br>
    <a class="list1" href="" @click.prevent="onClick1">click1</a><br><br>
  </div>

    <div slot="footer" class="modal-footer"></div>
  </card-modal>
</template>

<script>
// import Modal from './Modal.vue'
import CardModal from './CardModal.vue'
import {mapState, mapActions} from 'vuex'

export default {
  components: {CardModal},
  data() {
    return {
      toggleTitle: false,
      toggleDesc: false
    }
  },
  computed: {
    ...mapState({
      card: 'card',
      board: 'board',
      user: 'user'
    })
  },
  created() {
    this.fetchCard()
  },
  methods: {
    ...mapActions([
      'FETCH_CARD',
      'UPDATE_CARD'
    ]),
    fetchCard() {
      const id = this.$route.params.cid
      this.FETCH_CARD({id})
    },
    onClose() {
      this.$router.push(`/b/${this.board.id}`)
    },
    onBlurTitle() {
      if (this.user.id != this.board.userId) return
      this.toggleTitle = false
      const title = this.$refs.inputTitle.value.trim()
      if (!title) return
      this.UPDATE_CARD({id: this.card.id, title})
        .then(()=> this.fetchCard())
    },
    onBlurDesc() {
      if (this.user.id != this.board.userId) return
      this.toggleDesc = false
      const description = this.$refs.inputDesc.value.trim()
      this.UPDATE_CARD({id: this.card.id, description})
    }
  }
}
</script>

<style>
.modal-card .modal-container {
  min-width: 300px;
  max-width: 800px;
  width: 60%;
  /* height: 70%; */
}
.modal-card-header-title {
  padding-right: 30px;
}
.modal-close-btn {
  position: absolute;
  top: 0px;
  right: 0px;
  font-size: 24px;
  text-decoration: none;
}
.modal-card-header {
  position: relative;
}
.modal-default-button {
  float: right;
  text-decoration: none;
  color: #999;
}

.modal-card-menu {
  width: 30%;
  margin: 15% 15% 15% 15%;  /* up right down left */
  /* padding: 10% 10% 10% 10%; */
}
.modal-card-menu a {
  border-radius: 2px;
  /* margin: 20px 0 20px 0; */
  padding: 5px 100% 5px 100%;
  background-color: rgba(0,0,0, .2);
  color: black;
  transition: all .3s;
}
.modal-card-menu a:hover,
.modal-card-menu a:focus {
  background-color: rgba(0,0,0, .4);
}
</style>
