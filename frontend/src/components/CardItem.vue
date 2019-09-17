<template>
  <div class="card-item" :data-card-id="data.id" :data-card-pos="data.pos">
    <router-link :to="`/b/${boardId}/c/${data.id}`">
      <div>{{data.title}}</div>
      <div class="card-item-meta" v-if="data.description">&equiv;</div>
    </router-link>
    <file-pond
      name="file"
      ref="pond"
      class-name="my-pond"
      label-idle="Files"
      allow-multiple="true"
      allow-drop="false"
      allow-browse="false"
      allow-paste="false"
      :server="server"
      instantUpload="true"
      v-bind:files="myFiles"
      v-on:processfile="FETCH_BOARD({id: $route.params.bid})"
      v-on:processfilerevert="onProcessFileRevert"
      v-on:removefile="onRemoveFile"/>
    <a class="delete-card-btn" href="" @click.prevent="onDelete" v-if="(team.members.map(value => value.userId)).includes(user.id)">&times;</a>
  </div>
</template>

<script>
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
  components: {FilePond },
  props: ['data'],
  data () {
    return {
      server: {
        //url: "http://165.229.126.52:10000",
        url: "http://localhost:3000",
        process: `/cardfiles/${this.data.id}`,
        revert: '/files/',
        //restore: `/files/${this.board.id}`,
        load: '/upload/cardfiles/'
      },
      myFiles: []
    }
  },
  created() {
    this.data.cardfiles.forEach(file => {
        console.log(file.name)
        this.myFiles.push({ source: `${this.data.id}/` + file.name, options: {  type: 'local'}})
    })
  },
  computed: {
    ...mapState({
      board: 'board',
      user: 'user',
      team: 'team',
      'boardId': state => state.board.id
    })
  },
  methods: {
    ...mapActions([
      'FETCH_BOARD',
      'DELETE_CARD',
      'DELETE_CARDFILE'
    ]),
    onDelete() {
      if (!window.confirm('Delete this card?')) return
      this.DELETE_CARD({id: this.data.id})
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
.card-item {
  background-color: #fff;
  border-radius: 3px;
  margin: 8px;
  padding: 6px 20px 2px 8px;
  box-shadow: 0 1px 0 #ccc;
  position: relative;
}
.card-item a {
  text-decoration: none;
  color: #444;
  word-wrap: break-word;
  white-space: normal;
  overflow: hidden;
  display: block;
}
.card-item:hover,
.card-item:focus {
  background-color: rgba(0,0,0, .1);
  cursor: pointer;
}
.card-item-meta {
  font-size: 26px;
  padding: 5px 0 0 3px;
  color: #8c8c8c;
}
.delete-card-btn {
  position: absolute;
  right: 10px;
  top: 4px;
  text-decoration: none;
  font-size: 18px;
  color: #aaa;
}
.card-item * * .filepond--drop-label {
    display: none;
}
.card-item * * * * * * * .filepond--file-action-button.filepond--action-remove-item {
    display: none;
}
.card-item * * * * * * * .filepond--file-info {
    transform: translate3d(0px, 0px, 0px);
}
</style>
