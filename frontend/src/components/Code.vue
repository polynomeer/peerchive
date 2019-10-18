<template>
  <code-modal>
    <div slot="header">
      <h2>
        Project Source Code
        <a href="" class="modal-default-button"
          @click.prevent="SET_IS_SHOW_CODE(false)">&times;</a>
      </h2>
    </div>

    <div slot="body" class="code" :class="{hide: isHide}">
      <h3>{{data.language}} Source Code</h3>
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
        v-on:processfile="FETCH_BOARD({id: $route.params.bid})"
        v-on:processfilerevert="onProcessFileRevert"
        v-on:removefile="onRemoveFile"/>
      <!--file-pond
        name="test"
        ref="pond"
        label-idle="Drop files here..."
        allow-multiple="true"
        accepted-file-types="image/jpeg, image/png"
        server="http://165.229.126.52:10000/api/image"
        v-bind:files="myFiles"
        v-on:init="handleFilePondInit"
        v-on:addfile="onAddFile"
        v-on:processfile="handlePondFile"/-->

    </div>

    <div slot="footer">
        <button class="btn btn-success" type="submit" :disabled="invalidInput">
          <a href="" @click.prevent="SET_IS_SHOW_CODE(false)">OK</a>
        </button>
        <button class="btn btn-success" type="submit" :disabled="invalidInput">
          <a href="" @click.prevent="SET_IS_SHOW_CODE(false)">Cancel</a>
        </button>
    </div>
  </code-modal>
</template>

<script>
import { mapState, mapMutations, mapActions } from 'vuex'
import CodeModal from './CodeModal.vue'
// Import Vue FilePond
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
  components: { CodeModal, FilePond },
  props: ['data'],
  data () {
    return {
      server: {
        //url: "http://165.229.126.52:10000",
        url: "http://localhost:3000",
        process: `/boardfiles/${this.data.id}`,
        revert: '/files/',
        //restore: `/files/${this.board.id}`,
        load: '/upload/boardfiles/'
      },
      myFiles: [],
      isHide: true,
    }
  },
  created () {
    this.data.boardfiles.forEach(file => {
        console.log(file.name)
        this.myFiles.push({ source: `${this.data.id}/` + file.name, options: {  type: 'local'}})
    })
    this.isHide = ((this.team.members.map(value => value.userId)).includes(this.user.id) == false)
  },
  computed:{
    ...mapState({
      board: 'board',
      team: 'team',
      user: 'user',
    }),
    invalidInput() {
      return true
    }
  },
  methods: {
    ...mapMutations([
      'SET_IS_SHOW_CODE'
    ]),
    ...mapActions([
      'FETCH_BOARD',
      'DELETE_BOARDFILE'
    ]),
    handleFilePondInit() {
    },
    onProcessFileRevert(file) {
      this.DELETE_BOARDFILE({name:file.serverId.split('\"')[3].split("/")[4], boardId:this.board.id})
    },
    onRemoveFile(error, file) {
      if(file.origin == 3) {//file.orign == local
        this.DELETE_BOARDFILE({name:file.file.name, boardId:this.board.id})
      }
    }
  }
}
</script>

<style>
.dropbox {
   outline: 2px dashed #aaa;
   background: #7fb4dd;
   width: 300px;
   height: 300px;
   position: relative;
    margin: 0 auto;
 }
 .dropbox > h2{
   position: absolute;
   top: 50px;
   left: 0;
   z-index: 2;
 }
 .input-file{
   position: absolute;
   opacity: 0;
   width:100%;
   height:100%;
   top:0;
   left:0;
    z-index: 3;
 }
.code * .filepond--root {
   max-height: 500px;
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
</style>
