<template>
  <Modal class="modal-card">
    <div slot="header" class="modal-card-header">
      <div class="modal-card-header-title">
        <input class="form-control" type="text" :value="card.title"
          :readonly="!toggleTitle" @click="toggleTitle=true" @blur="onBlurTitle"
          ref="inputTitle" v-if="(team.members.map(value => value.userId)).includes(user.id)">
        <label for="email" v-else>{{card.title}}</label>
      </div>
      <a class="modal-close-btn" href="" @click.prevent="onClose">&times;</a>
    </div>
    <div slot="body" class="modal-card-body">
      <div class="body-left">
        <div class="decription">
          <h3>Description</h3><br>
          <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
            :readonly="!toggleDesc" @click="toggleDesc=true" @blur="onBlurDesc"
            v-model="card.description" ref="inputDesc" v-if="(team.members.map(value => value.userId)).includes(user.id)"></textarea>
          <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
            :readonly="true" v-model="card.description" ref="inputDesc" v-else></textarea>
        </div>

        <div class="activity">
          <h3>Activity</h3><br>
          <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
            :readonly="!toggleDesc" @click="toggleDesc=true" @blur="onBlurDesc"
            v-model="card.description" ref="inputDesc" v-if="(team.members.map(value => value.userId)).includes(user.id)"></textarea>
          <textarea  class="form-control" cols="30" rows="3" placeholder="Add a more detailed description..."
            :readonly="true" v-model="card.description" ref="inputDesc" v-else></textarea>
        </div>
        <div class="card" :class="{hide: isHide}">
          <h3>File</h3><br>
          <file-pond
            name="file"
            ref="pond"
            class-name="my-pond"
            label-idle="Drop files here..."
            allow-multiple="true"
            :allow-drop="!isHide"
            :allow-browse="!isHide"
            :allow-paste="!isHide"
            :server="server"
            instantUpload="true"
            v-bind:files="myFiles"
            v-on:init="handleFilePondInit"
            v-on:processfile="FETCH_BOARD({id: board.id})"
            v-on:processfilerevert="onProcessFileRevert"
            v-on:removefile="onRemoveFile"/>
        </div>
      </div>

      <div class="modal-card-menu">
        <h3>Menu</h3><br>
        <a class="list1" href="" @click.prevent="onClick1">&nbsp;&nbsp;Join&nbsp;&nbsp;</a><br><br>
        <a class="list1" href="" @click.prevent="onClick2">&nbsp;Label&nbsp;</a><br><br>
        <a class="list1" href="" @click.prevent="onClick3">&nbsp;Move&nbsp;</a><br><br>
        <a class="list1" href="" @click.prevent="onClick4">&nbsp;Share</a><br><br>
      </div>

      <div class="clear">
        <!-- make block visible -->
      </div>
    </div>

    <div slot="footer">
    </div>

  </Modal>
</template>

<script>
// import CardModal from './CardModal.vue'
import Modal from './Modal.vue'
import {mapState, mapActions} from 'vuex'

import vueFilePond,{setOptions} from 'vue-filepond';

// Import image preview and file type validation plugins
import FilePondPluginFileValidateType from 'filepond-plugin-file-validate-type';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import FilePondPluginGetFile  from 'filepond-plugin-get-file';
import FilePondPluginMediaPreview from 'filepond-plugin-media-preview';

// Import image preview plugin styles
import 'filepond/dist/filepond.min.css';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.min.css';
import 'filepond-plugin-get-file/dist/filepond-plugin-get-file.min.css';
import 'filepond-plugin-media-preview/dist/filepond-plugin-media-preview.min.css';

// Create component
const FilePond = vueFilePond(FilePondPluginGetFile, FilePondPluginFileValidateType, FilePondPluginMediaPreview, FilePondPluginImagePreview);

export default {
  components: {Modal, FilePond },
  data() {
    return {
      toggleTitle: false,
      toggleDesc: false,
      server: {
        //url: "http://165.229.126.52:10000",
        url: "http://localhost:3000",
        process: '/cardfiles/',
        revert: '/files/',
        //restore: `/files/${this.board.id}`,
        load: '/upload/cardfiles/'
      },
      myFiles: [],
      isHide: true,
    }
  },
  computed: {
    ...mapState({
      card: 'card',
      board: 'board',
      team: 'team',
      user: 'user'
    })
  },
  created() {
    this.fetchCard()
  },
  methods: {
    ...mapActions([
      'FETCH_BOARD',
      'FETCH_CARD',
      'UPDATE_CARD',
      'DELETE_CARDFILE'
    ]),
    fetchCard() {
      const id = this.$route.params.cid
      this.FETCH_CARD({id}).finally(_=> {
        this.server = {
          //url: "http://165.229.126.52:10000",
          url: "http://localhost:3000",
          process: `/cardfiles/${this.card.id}`,
          revert: '/files/',
          //restore: `/files/${this.board.id}`,
          load: '/upload/cardfiles/'
        }
        this.card.cardfiles.forEach(file => {
            console.log(file.name)
            this.myFiles.push({ source: `${this.card.id}/` + file.name, options: {  type: 'local'}})
            this.isHide = ((this.team.members.map(value => value.userId)).includes(this.user.id) == false)
        })
      })
    },
    onClose() {
      this.$router.push(`/b/${this.board.id}`)
    },
    onBlurTitle() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.toggleTitle = false
      const title = this.$refs.inputTitle.value.trim()
      if (!title) return
      this.UPDATE_CARD({id: this.card.id, title})
        .then(()=> this.fetchCard())
    },
    onBlurDesc() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.toggleDesc = false
      const description = this.$refs.inputDesc.value.trim()
      this.UPDATE_CARD({id: this.card.id, description})
    },
    handleFilePondInit() {
      setOptions({
        server: {
          //url: "http://165.229.126.52:10000",
          url: "http://localhost:3000",
          process: `/cardfiles/${this.card.id}`,
          revert: '/files/',
          load: '/upload/cardfiles/'
        }
      })
    },
    onProcessFileRevert(file) {
      //console.log(file.serverId)
      //console.log(file.serverId.split('\"')[3].split("/")[4])
      this.DELETE_CARDFILE({name:file.serverId.split('\"')[3].split("/")[4], cardId:this.board.id})
    },
    onRemoveFile(error, file) {
      if(file.origin == 3) {//file.orign == local
        this.DELETE_CARDFILE({name:file.file.name, cardId:this.card.id})
      }
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
.body-left{
  float:left;
  width:65%;
  /* margin: 0 1px 0 1px; */
  /* padding: 0 1px 0 1px; */
}
.modal-card-menu {
  float:right;
  width: 30%;
  /* margin: 5px 5px 5px 5px; */
  /* up right down left */
  /* padding: 1px 1px 1px 1px; */
}
.modal-card-menu a {
  border-radius: 2px;
  /* margin: 20px 0 20px 0; */
  padding: 5px 35% 5px 35%;
  background-color: rgba(0,0,0, .2);
  color: black;
  transition: all .3s;
}
.modal-card-menu a:hover,
.modal-card-menu a:focus {
  background-color: rgba(0,0,0, .4);
}

.card * .filepond--root {
    max-height: 300px;
}
.hide * * .filepond--drop-label {
    display: none;
}
.hide * * * * * * * .filepond--file-action-button.filepond--action-remove-item {
    display: none;
}
.hide * * * * * * * .filepond--file-info {
    transform: translate3d(0px, 0px, 0px);
}
/* make float block as visible */
.clear {
  clear: both;
}
</style>
