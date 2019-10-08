<template>
  <div>
    <div class="sc-launcher" :class="{opened: isOpen}" @click.prevent="isOpen ? onClose() : openAndFocus()" :style="{backgroundColor: colors.launcher.bg}">
      <div v-if="newMessagesCount > 0 && !isOpen" class="sc-new-messsages-count">
        {{newMessagesCount}}
      </div>
      <img v-if="isOpen" class="sc-closed-icon" :src="icons.close.img"  :alt="icons.close.name" />
      <img v-else class="sc-open-icon" :src="icons.open.img"  :alt="icons.open.name" />
    </div>
    <div class="sc-chat-window" :class="{opened: isOpen, closed: !isOpen}">
      <div class="sc-header" :style="{background: colors.header.bg, color: colors.header.text}">
        <slot>
          <div v-if="!showTeamList" class="sc-header--title enabled" @click="toggleUserList(null)">← {{title}}</div>
          <div v-else class="sc-header--title"> {{title}} </div>
        </slot>
          <div class="sc-header--close-button" @click="onClose">
            <img :src="icons.close.img" :alt="icons.close.name" />
          </div>
      </div>
      <div class="user-list" v-if="showTeamList">
        <table class="" style="padding-top: 5px">
          <tbody>
            <tr v-for="t in teams" :key="t.id">
                <div class="user-element enabled" @click="toggleUserList(t)">{{t.name}}</div>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="sc-message-list" v-if="!showTeamList" ref="scrollList">
        <div class="sc-message" v-for="message in messages" :message="message" :key="message.id" :colors="colors" :messageStyling="messageStyling" @remove="$emit('remove', message)" :style="{backgroundColor: colors.messageList.bg}" @scroll="handleScroll">
          <div class="sc-message--content" :class="{
            sent: message.userId == user.id,
            received: message.userId != user.id
            }">
            <div :title="authorName" class="sc-message--avatar">{{message.user.name}} :</div>

            <div class="sc-message--text" :messageStyling="messageStyling" @remove="$emit('remove')" :style="determineMessageColors()">
              <template>
                <div class="sc-message--toolbox" :style="colors.receivedMessage.bg">
                  <slot name="text-message-toolbox" :message="message" :me="me">
                  </slot>
                </div>
              </template>
              <slot :message="message" :messageText="messageText" :messageColors="colors.sentMessage.bg" :me="me">
                <p class="sc-message--text-content">{{message.text}}</p>
                <p class='sc-message--meta'>{{message.createdAt}}</p>
              </slot>
            </div>
          </div>
        </div>
      </div>
      <div v-if="!showTeamList" @onType="$emit('onType')" @edit="$emit('edit', $event)">
        <div class="sc-suggestions-row" :style="{background: colors.messageList.bg}">
            <button class="sc-suggestions-element" v-for="(suggestion, idx) in getSuggestions()" v-on:click="$emit('sendSuggestion', suggestion)"
            :style="{borderColor: colors.sentMessage.bg, color: colors.sentMessage.bg}" :key="idx">{{suggestion}}</button>
        </div>
        <form class="sc-user-input" :class="{active: true}" :style="{background: colors.userInput.bg}">
          <div
           role="button"
           tabIndex="0"
           @focus="setInputActive(true)"
           @blur="setInputActive(false)"
           @keydown="handleKey"
           contentEditable="true"
           :placeholder="placeholder"
           class="sc-user-input--text"
           ref="userInput"
           :style="{color: colors.userInput.text}"
           @focusUserInput="focusUserInput()"
         >
         </div>
         <div class="sc-user-input--buttons">
           <div class="sc-user-input--button"></div>
           <div class="sc-user-input--button"></div>
           <div class="sc-user-input--button"></div>
           <div class="sc-user-input--button">
             <button class="sc-user-input--button-icon-wrapper" @click.prevent="onSubmitMessage">
               <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 18 18" aria-labelledby="Send" role="presentation">
                <title :id="Send" lang="en">{{Send}}</title>
                <g fill="currentColor">
                  <path d="M17.218,2.268L2.477,8.388C2.13,8.535,2.164,9.05,2.542,9.134L9.33,10.67l1.535,6.787c0.083,0.377,0.602,0.415,0.745,0.065l6.123-14.74C17.866,2.46,17.539,2.134,17.218,2.268 M3.92,8.641l11.772-4.89L9.535,9.909L3.92,8.641z M11.358,16.078l-1.268-5.613l6.157-6.157L11.358,16.078z"/>
                </g>
              </svg>
             </button>
           </div>
         </div>
       </form>
     </div>
    </div>
  </div>
</template>
<script>
import {mapState, mapMutations, mapActions} from 'vuex'
// import chatIcon from 'vue-beautiful-chat/src/assets/chat-icon.svg'
// import CloseIcon from 'vue-beautiful-chat/src/assets/close-icon.png'
// import OpenIcon from 'vue-beautiful-chat/src/assets/logo-no-bg.svg'
// import FileIcon from 'vue-beautiful-chat/src/assets/file.svg'
// import CloseIconSvg from 'vue-beautiful-chat/src/assets/close.svg'
import chatIcon from '../assets/images/chat-icon.svg'
import CloseIcon from '../assets/images/close-icon.png'
import OpenIcon from '../assets/images/logo-no-bg.svg'
import FileIcon from '../assets/images/file.svg'
import CloseIconSvg from '../assets/images/close.svg'

export default {
  data() {
    return {
      icons:{
        open:{
          img: OpenIcon,
          name: 'default',
        },
        close:{
          img: CloseIcon,
          name: 'default',
        },
        file:{
          img: FileIcon,
          name: 'default',
        },
        closeSvg:{
          img: CloseIconSvg,
          name: 'default',
        },
      },
      newMessagesCount: 0,
      showTypingIndicator: '', // when set to a value matching the participant.id it shows the typing indicator for the specific user
      colors: {
        header: {
          bg: '#4e8cff',
          text: '#ffffff'
        },
        launcher: {
          bg: '#4e8cff'
        },
        messageList: {
          bg: '#ffffff'
        },
        sentMessage: {
          bg: '#4e8cff',
          text: '#ffffff'
        },
        receivedMessage: {
          bg: '#eaeaea',
          text: '#222222'
        },
        userInput: {
          bg: '#f4f7f9',
          text: '#565867'
        }
      }, // specifies the color scheme for the component
      alwaysScrollToBottom: false, // when set to true always scrolls the chat to the bottom when new events are in (new message, user starts typing...)
      messageStyling: true, // enables *bold* /emph/ _underline_ and such (more info at github.com/mattezza/msgdown)
      showTeamList: true,
      inUserList: false,
      isOpen: false,
      title: 'Chat',
      placeholder: 'Write something...',
      Send: '',
      team: {},
    }
  },
  computed: {
    ...mapState({
      user: 'user',
      teams: 'teams',
      messages: 'messages',
      socket: 'socket'
    }),
    defaultChatIcon() {
      return chatIcon
    },
    authorName(){
      return this.user && this.user.name;
    },
    chatImageUrl(){
      return (this.user && this.user.imageUrl) || this.chatIcon;
    },
    authorName(){
      return this.user && this.user.name;
    },
    chatImageUrl(){
      return (this.user && this.user.imageUrl) || this.chatIcon;
    },
    messageText() {
      //const escaped = escapeGoat.escape(this.message.data.text)
      //return Autolinker.link(this.messageStyling ? fmt(escaped) : escaped, {
      //  className: 'chatLink',
      //  truncate: { length: 50, location: 'smart' }
      //})
    },
    me(message){
      return message.author === 'me';
    },
    isEditing() {
      //return (store.editMessage && store.editMessage.id) == this.message.id;
    },

    editMessageId() {
      //return this.isEditing && store.editMessage.id;
    },
    isEditing() {
      //return store.editMessage && store.editMessage.id
    }
  },
  mounted () {
    //this.$root.$on('focusUserInput', () => {
    //  this.focusUserInput()
    //})
  },
  updated () {
    if(this.$refs.scrollList)
      this.$nextTick(this._scrollDown())
    if(this.team) {
      this.socket.on('chat', (data) => {
        this.FETCH_MESSAGES({teamId: this.team.id})
      });
    }
  },
  methods: {
    ...mapActions([
      'ADD_MESSAGE',
      'FETCH_MESSAGES',
    ]),
    openAndFocus() {
      this.onOpen();
      this.$root.$emit('focusUserInput');
    },
    toggleUserList(team) {
      if(team){
        this.title = team.name
        this.team = team
        this.FETCH_MESSAGES({teamId: team.id})
        this.socket.emit('join', {teamId: team.id})
      }
      else{
        this.title = 'Chat'
        this.team = null
        this.$refs.scrollList.scrollTop = 0
        this.socket.emit('leave')
      }
      this.showTeamList = !this.showTeamList
    },
    handleUserListToggle(showTeamList) {
      this.showTeamList = showTeamList
    },
    getSuggestions(){
      //return this.messages.length > 0 ? this.messages[this.messages.length - 1].suggestions : []
    },
    sendMessage (text) {
      if (text.length > 0) {
        this.newMessagesCount = this.isChatOpen ? this.newMessagesCount : this.newMessagesCount + 1
        this.onMessageWasSent({ author: 'support', type: 'text', data: { text } })
      }
    },
    onMessageWasSent (message) {
      // called when the user sends a message
      this.messageList = [ ...this.messageList, message ]
    },
    onOpen () {
      // called when the user clicks on the fab button to open the chat
      this.isOpen = true
      this.newMessagesCount = 0
    },
    onClose () {
      // called when the user clicks on the botton to close the chat
      if(this.team) {
        this.title = 'Chat'
        this.team = null
        this.$refs.scrollList.scrollTop = 0
        this.showTeamList = true
        this.socket.emit('leave')
      }
      this.isOpen = false
    },
    handleScrollToTop () {
      // called when the user scrolls message list to top
      // leverage pagination for loading another page of messages
  	},
    handleOnType () {
      console.log('Emit typing event')
    },
    editMessage(message){
      const m = this.messageList.find(m=>m.id === message.id);
      m.isEdited = true;
      m.data.text = message.data.text;
    },
    _scrollDown () {
      this.$refs.scrollList.scrollTop = this.$refs.scrollList.scrollHeight
    },
    handleScroll (e) {
        if (e.target.scrollTop === 0) {
            this.$emit('scrollToTop')
        }
    },
    shouldScrollToBottom() {
      return this.alwaysScrollToBottom || (this.$refs.scrollList.scrollTop > this.$refs.scrollList.scrollHeight - 600)
    },
    profile(author) {
    },
    sentColorsStyle() {
      return {
        color: this.colors.sentMessage.text,
        backgroundColor: this.colors.sentMessage.bg
      }
    },
    receivedColorsStyle() {
      return {
        color: this.colors.receivedMessage.text,
        backgroundColor: this.colors.receivedMessage.bg
      }
    },
    determineMessageColors() {
      //return this.message.author === 'me' ? this.sentColorsStyle() : this.receivedColorsStyle()
    },

    cancelFile () {
      this.file = null
    },
    setInputActive (onoff) {
      this.inputActive = onoff
    },
    handleKey (event) {
      if (event.keyCode === 13) {
        this.onSubmitMessage()
        event.preventDefault()
      }
    },
    focusUserInput() {
      this.$nextTick(() => {
        this.$refs.userInput.focus();
      })
    },
    _submitSuggestion(suggestion) {
      this.onSubmit({author: 'me', type: 'text', data: { text: suggestion }})
    },
    _submitText (event) {
      const text = this.$refs.userInput.textContent
      if (text && text.length > 0) {
        this.onSubmit({
          author: 'me',
          type: 'text',
          data: { text }
        });
        this.$refs.userInput.innerHTML = ''
      }
    },
    _editText (event) {
      const text = this.$refs.userInput.textContent;
      if (text && text.length) {
        this.$emit('edit', {
          author: 'me',
          type: 'text',
          //id: store.editMessage.id,
          data: { text }
        });
        this._editFinish();
      }
    },
    _handleEmojiPicked (emoji) {
      this.onSubmit({
        author: 'me',
        type: 'emoji',
        data: { emoji }
      })
    },
    _handleFileSubmit (file) {
      this.file = file
    },
    _editFinish(){
      //this.store.editMessage = null;
    },
    onSubmitMessage(){
      const text = this.$refs.userInput.textContent
      if (text && text.length > 0) {
        this.socket.emit('chat');
        this.ADD_MESSAGE({text: text, teamId: this.team.id})
        this.$refs.userInput.textContent = ''
      }
    }
  },
  watch: {
    editMessageId(m){
      /*if (store.editMessage != null && store.editMessage != undefined){
        this.$refs.userInput.focus();
        this.$refs.userInput.textContent = store.editMessage.data.text;
      } else {
        this.$refs.userInput.textContent = '';
      }*/
    }
  },
}
</script>
<style scoped>
.sc-launcher {
  width: 60px;
  height: 60px;
  background-position: center;
  background-repeat: no-repeat;
  position: fixed;
  right: 25px;
  bottom: 25px;
  border-radius: 50%;
  box-shadow: none;
  transition: box-shadow 0.2s ease-in-out;
  cursor: pointer;
}
.sc-launcher:before {
  content: '';
  position: relative;
  display: block;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  transition: box-shadow 0.2s ease-in-out;
}
.sc-launcher .sc-open-icon,
.sc-launcher .sc-closed-icon {
  width: 60px;
  height: 60px;
  position: fixed;
  right: 25px;
  bottom: 25px;
  transition: opacity 100ms ease-in-out, transform 100ms ease-in-out;
}
.sc-launcher .sc-closed-icon {
  transition: opacity 100ms ease-in-out, transform 100ms ease-in-out;
  width: 60px;
  height: 60px;
}
.sc-launcher .sc-open-icon {
  padding: 20px;
  box-sizing: border-box;
  opacity: 1;
}
.sc-launcher.opened .sc-open-icon {
  transform: rotate(-90deg);
  opacity: 1;
}
.sc-launcher.opened .sc-closed-icon {
  transform: rotate(-90deg);
  opacity: 1;
}
.sc-launcher.opened:before {
  box-shadow: 0px 0px 400px 250px rgba(148, 149, 150, 0.2);
}
.sc-launcher:hover {
  box-shadow: 0 0px 27px 1.5px rgba(0,0,0,0.2);
}
.sc-new-messsages-count {
  position: absolute;
  top: -3px;
  left: 41px;
  display: flex;
  justify-content: center;
  flex-direction: column;
  border-radius: 50%;
	width: 22px;
  height: 22px;
  background: #ff4646;
  color: white;
  text-align: center;
  margin: auto;
  font-size: 12px;
  font-weight: 500;
}
.sc-header {
  min-height: 75px;
  border-top-left-radius: 9px;
  border-top-right-radius: 9px;
  padding: 10px;
  box-shadow: 0 1px 4px rgba(0,0,0,.2);
  position: relative;
  box-sizing: border-box;
  display: flex;
}
.sc-header--img {
  border-radius: 50%;
  align-self: center;
  padding: 10px;
}
.sc-header--title {
  align-self: center;
  padding: 10px;
  flex: 1;
  user-select: none;
  font-size: 20px;
}
.sc-header--title.enabled {
  cursor: pointer;
  border-radius: 5px;
}
.sc-header--title.enabled:hover {
  box-shadow: 0px 2px 5px rgba(0.2, 0.2, 0.5, .1);
}
.sc-header--close-button {
  width: 40px;
  align-self: center;
  height: 40px;
  margin-right: 10px;
  box-sizing: border-box;
  cursor: pointer;
  border-radius: 5px;
  margin-left: auto;
}
.sc-header--close-button:hover {
  box-shadow: 0px 2px 5px rgba(0.2, 0.2, 0.5, .1);
}
.sc-header--close-button img {
  width: 100%;
  height: 100%;
  padding: 0px;
  box-sizing: border-box;
}
@media (max-width: 450px) {
  .sc-header {
    border-radius: 0px;
  }
}

.sc-chat-window {
  width: 370px;
  height: calc(100% - 120px);
  max-height: 590px;
  position: fixed;
  right: 25px;
  bottom: 100px;
  box-sizing: border-box;
  box-shadow: 0px 7px 40px 2px rgba(148, 149, 150, 0.1);
  background: white;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border-radius: 10px;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  animation: fadeIn;
  animation-duration: 0.3s;
  animation-timing-function: ease-in-out;
}
.sc-chat-window.closed {
  opacity: 0;
  display: none;
  bottom: 90px;
}
@keyframes fadeIn {
  0% {
    display: none;
    opacity: 0;
  }
  100% {
    display: flex;
    opacity: 1;
  }
}
.sc-message--me {
  text-align: right;
}
.sc-message--them {
  text-align: left;
}
@media (max-width: 450px) {
  .sc-chat-window {
    width: 100%;
    height: 100%;
    max-height: 100%;
    right: 0px;
    bottom: 0px;
    border-radius: 0px;
  }
  .sc-chat-window {
    transition: 0.1s ease-in-out;
  }
  .sc-chat-window.closed {
    bottom: 0px;
  }
}
  .user-list {
    height: 100%;
    overflow: auto;
    padding-left: 5px;
    padding-top: 8px;
  }
  .img-msg {
    border-radius: 50%;
    width: 50px;
    margin-right: 5px;
  }
  .user-element {
    font-size: 20px;
    vertical-align: middle;
    align-self: center;
    padding: 10px;
    flex: 1;
    user-select: none;
    font-size: 20px;
  }
  .user-element.enabled {
    cursor: pointer;
    border-radius: 5px;
  }
  .user-element.enabled:hover {
    box-shadow: 0px 2px 5px rgba(0.8, 0.8, 2, .4);
  }
.sc-message-list {
  height: 80%;
  overflow-y: auto;
  background-size: 100%;
  padding: 40px 0px;
}

.sc-message {
  width: 300px;
  margin: auto;
  padding-bottom: 10px;
  display: flex;
  .sc-message--edited{
    opacity: 0.7;
    word-wrap: normal;
    font-size: xx-small;
    text-align: center;
  }
}
.sc-message--content {
  width: 100%;
  display: flex;
}
.sc-message--content.sent {
  justify-content: flex-end;
}
.sc-message--content.system {
  justify-content: center;
}
.sc-message--content.sent .sc-message--avatar {
  display: none;
}
.sc-message--avatar {
  background-repeat: no-repeat;
  background-size: 100%;
  background-position: center;
  min-width: 30px;
  min-height: 30px;
  border-radius: 50%;
  align-self: center;
  margin-right: 15px;
}
.sc-message--content.sent .sc-message--meta {
  font-size: xx-small;
  margin-bottom: 0px;
  color: white;
  text-align: center;
}
.sc-message--content.received .sc-message--meta {
  font-size: xx-small;
  margin-bottom: 0px;
  color: black;
  text-align: center;
}
@media (max-width: 450px) {
  .sc-message {
    width: 80%;
  }
}
.sc-message--text {
  padding: 5px 20px;
  border-radius: 6px;
  font-weight: 300;
  font-size: 14px;
  line-height: 1.4;
  position: relative;
  -webkit-font-smoothing: subpixel-antialiased;
  .sc-message--text-body{
    .sc-message--text-content{
      white-space: pre-wrap;
    }
  }
  &:hover .sc-message--toolbox{
    left: -20px;
    opacity: 1;
  }
  .sc-message--toolbox{
    transition: left 0.2s ease-out 0s;
    white-space: normal;
    opacity: 0;
    position: absolute;
    left: 0px;
    width: 25px;
    top: 0;
    button {
      background: none;
      border: none;
      padding: 0px;
      margin: 0px;
      outline: none;
      width:100%;
      text-align: center;
      cursor: pointer;
      &:focus {
        outline: none;
      }
    }
  }
}
.sc-message--content.sent .sc-message--text {
  color: white;
  background-color: #4e8cff;
  max-width: calc(100% - 120px);
  word-wrap: break-word;
}
.sc-message--text code {
  font-family: 'Courier New', Courier, monospace !important;
}
.sc-message--content.received .sc-message--text {
  color: #263238;
  background-color: #eaeaea;
  margin-right: 40px;
}
.tooltip {
  display: block !important;
  z-index: 10000;
  .tooltip-inner {
    background: black;
    color: white;
    border-radius: 16px;
    padding: 5px 10px 4px;
  }
  .tooltip-arrow {
    width: 0;
    height: 0;
    border-style: solid;
    position: absolute;
    margin: 5px;
    border-color: black;
    z-index: 1;
  }
  &[x-placement^="top"] {
    margin-bottom: 5px;
    .tooltip-arrow {
      border-width: 5px 5px 0 5px;
      border-left-color: transparent !important;
      border-right-color: transparent !important;
      border-bottom-color: transparent !important;
      bottom: -5px;
      left: calc(50% - 5px);
      margin-top: 0;
      margin-bottom: 0;
    }
  }
  &[x-placement^="bottom"] {
    margin-top: 5px;
    .tooltip-arrow {
      border-width: 0 5px 5px 5px;
      border-left-color: transparent !important;
      border-right-color: transparent !important;
      border-top-color: transparent !important;
      top: -5px;
      left: calc(50% - 5px);
      margin-top: 0;
      margin-bottom: 0;
    }
  }
  &[x-placement^="right"] {
    margin-left: 5px;
    .tooltip-arrow {
      border-width: 5px 5px 5px 0;
      border-left-color: transparent !important;
      border-top-color: transparent !important;
      border-bottom-color: transparent !important;
      left: -5px;
      top: calc(50% - 5px);
      margin-left: 0;
      margin-right: 0;
    }
  }
  &[x-placement^="left"] {
    margin-right: 5px;
    .tooltip-arrow {
      border-width: 5px 0 5px 5px;
      border-top-color: transparent !important;
      border-right-color: transparent !important;
      border-bottom-color: transparent !important;
      right: -5px;
      top: calc(50% - 5px);
      margin-left: 0;
      margin-right: 0;
    }
  }
  &[aria-hidden='true'] {
    visibility: hidden;
    opacity: 0;
    transition: opacity .15s, visibility .15s;
  }
  &[aria-hidden='false'] {
    visibility: visible;
    opacity: 1;
    transition: opacity .15s;
  }
  &.info {
    $color: rgba(#004499, .9);
    .tooltip-inner {
      background: $color;
      color: white;
      padding: 24px;
      border-radius: 5px;
      box-shadow: 0 5px 30px rgba(black, .1);
    }
    .tooltip-arrow {
      border-color: $color;
    }
  }
  &.popover {
    $color: #f9f9f9;
    .popover-inner {
      background: $color;
      color: black;
      padding: 24px;
      border-radius: 5px;
      box-shadow: 0 5px 30px rgba(black, .1);
    }
    .popover-arrow {
      border-color: $color;
    }
  }
}
a.chatLink {
  color: inherit !important;
}

.sc-user-input {
  min-height: 55px;
  margin: 0px;
  position: relative;
  bottom: 0;
  display: flex;
  background-color: #f4f7f9;
  border-bottom-left-radius: 10px;
  border-bottom-right-radius: 10px;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.sc-user-input--text {
  width: 300px;
  resize: none;
  border: none;
  outline: none;
  border-bottom-left-radius: 10px;
  box-sizing: border-box;
  padding: 18px;
  font-size: 15px;
  font-weight: 400;
  line-height: 1.33;
  white-space: pre-wrap;
  word-wrap: break-word;
  color: #565867;
  -webkit-font-smoothing: antialiased;
  max-height: 200px;
  overflow: scroll;
  bottom: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
.sc-user-input--text:empty:before {
  content: attr(placeholder);
  display: block; /* For Firefox */
  /* color: rgba(86, 88, 103, 0.3); */
  filter: contrast(15%);
  outline: none;
  cursor: text;
}
.sc-user-input--buttons {
  width: 100px;
  position: absolute;
  right: 30px;
  height: 100%;
  display: flex;
}
.sc-user-input--button:first-of-type {
  width: 40px;
}
.sc-user-input--button {
  width: 30px;
  height: 55px;
  margin-left: 2px;
  margin-right: 2px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.sc-user-input.active {
  box-shadow: none;
  background-color: white;
  box-shadow: 0px -5px 20px 0px rgba(150, 165, 190, 0.2);
}
.sc-user-input--button label {
  position: relative;
  height: 24px;
  padding-left: 3px;
  cursor: pointer;
}
.sc-user-input--button label:hover path {
  fill: rgba(86, 88, 103, 1);
}
.sc-user-input--button input {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  z-index: 99999;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  overflow: hidden;
}
.file-container {
  background-color: #f4f7f9;
  border-top-left-radius: 10px;
  padding: 5px 20px;
  color: #565867;
}
.delete-file-message {
  font-style: normal;
  float: right;
  cursor: pointer;
  color: #c8cad0;
}
.delete-file-message:hover {
  color: #5d5e6d;
}
.icon-file-message {
  margin-right: 5px;
}

.sc-suggestions-row {
  text-align: center;
  background: inherit;
}
.sc-suggestions-element {
  margin: 3px;
  padding: 5px 10px 5px 10px;
  border: 1px solid;
  border-radius: 15px;
  font-size: 14px;
  background: inherit;
  cursor: pointer;
}

.sc-user-input--button-icon-wrapper {
  background: none;
  border: none;
  padding: 0px;
  margin: 0px;
  outline: none;
  cursor: pointer;
  &:focus{
    outline: none;
  }
  svg {
    height: 20px;
    width: 20px;
    cursor: pointer;
    align-self: center;
    outline: none;
    &:hover path{
      filter: contrast(15%);
    }
  }
}
svg {
  display: inline-block;
  vertical-align: baseline;
  margin-bottom: -2px; /* yes, I'm that particular about formatting */
}
</style>
