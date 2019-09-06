<template>
  <div class="board-menu">

    <div class="board-menu-header">
      <div class="header-title">Menu</div>
      <a class="header-close-btn" href="" @click.prevent="onClose">&times;</a>
    </div>

    <ul class="menu-list">
      <li>Board Main Language</li>
      <ul>
        <select :disabled="(team.members.map(value => value.userId)).includes(user.id) == false" @change="onChangeLanguage($event)">
          <option disabled v-bind:value="null" :selected="board.language == null">-- Select Language --</option>
          <option v-for="l in languages" v-bind:value="l" :selected="board.language == l">{{l}}</option>
        </select>
      </ul>
      <li>Board Description</li>
      <textarea class="form-control" v-if="isEditDesc" type="text" v-model="inputDesc"
        ref="inputDesc" @keyup.enter="onSubmitDesc" @blur="onSubmitDesc"/>
      <ul v-else-if="board.description.length > 100" @click="onClickDesc">{{board.description.substr(0, 100)}}...</ul>
      <ul v-else @click="onClickDesc">{{board.description}}</ul>
    </ul>

    <ul class="menu-list" v-if="(team.members.map(value => value.userId)).includes(user.id)">
      <li><a href="" @click.prevent="onDeleteBoard" >Delete Board</a></li>
      <li>Change Background</li>
      <div class="color-picker">
        <a href="" data-value="#6281B8" @click.prevent="onChangeTheme"></a>
        <a href="" data-value="rgb(176, 70, 50)" @click.prevent="onChangeTheme"></a>
        <a href="" data-value="rgb(210, 144, 52)" @click.prevent="onChangeTheme"></a>
        <a href="" data-value="rgb(255, 192, 203)" @click.prevent="onChangeTheme"></a>
        <!-- <a href="" data-value="rgb(150, 123, 220)" @click.prevent="onChangeTheme"></a> -->
        <a href="" data-value="rgb(81, 152, 57)" @click.prevent="onChangeTheme"></a>
        <a href="" data-value="rgb(0, 121, 191)" @click.prevent="onChangeTheme"></a>
        <a href="" data-value="rgb(40, 40, 40)" @click.prevent="onChangeTheme"></a>
    </div>
    </ul>

  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'

export default {
  data() {
    return {
      languages: ['Assembly language', 'C', 'C++', 'C#', 'Delphi/Object Pascal', 'Go', 'Groovy', 'Java', 'JavaScript', 'MATLAB', 'Objective-C', 'Perl','PHP', 'Python', 'R', 'Ruby', 'SQL', 'Swift', 'Visual Basic', 'Visual Basic.NET','etc'],
      isEditDesc: false,
      inputDesc: ''
    }
  },
  computed: {
    ...mapState({
      board: 'board',
      user: 'user',
      team: 'team'
    })
  },
  mounted() {
    this.inputDesc = this.board.description
    Array.from(this.$el.querySelectorAll('.color-picker a')).forEach(el => {
      el.style.backgroundColor = el.dataset.value
    })
  },
  methods: {
    ...mapMutations([
      'SET_IS_SHOW_BOARD_SETTINGS',
      'SET_THEME',
    ]),
    ...mapActions([
      'DELETE_BOARD',
      'UPDATE_BOARD',
    ]),
    onClose() {
      this.SET_IS_SHOW_BOARD_SETTINGS(false)
    },
    onDeleteBoard() {
      if (!confirm(`Delete ${this.board.title} Board?`)) return
      this.DELETE_BOARD({id: this.board.id})
      .then(_=> this.SET_IS_SHOW_BOARD_SETTINGS(false))
      .then(_=> this.$router.push('/'))
    },
    onChangeTheme(el) {
      const id = this.board.id
      const bgColor = el.target.dataset.value
      this.UPDATE_BOARD({id, bgColor})
        .then(_=> this.SET_THEME(bgColor))
    },
    onClickDesc() {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditDesc = true
      this.$nextTick(_=> this.$refs.inputDesc.focus())
    },
    onSubmitDesc() {
      if ((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return
      this.isEditDesc = false

      this.inputDesc = this.inputDesc.trim()
      if (!this.inputDesc) return

      const id = this.board.id
      const description = this.inputDesc
      if (description === this.board.description) return

      this.UPDATE_BOARD({ id, description })
    },
    onChangeLanguage(event) {
      if((this.team.members.map(value => value.userId)).includes(this.user.id) == false) return

      const id = this.board.id
      const language = event.target.value.trim()
      if (!language) return
      if (language === this.board.language) return

      this.UPDATE_BOARD({ id, language })
    },
  }
}
</script>

<style>
.board-menu {
  /* position: absolute; */
  position: fixed;
  right: 0;
  top: 40px;
  height: 100%;
  background-color: #edeff0;
  width: 300px;
  /* padding: 10px 10px 10px 10px; */
  transition: all .3s;
}
/* .board-menu-enter-active, .board-menu-leave-active{
  transition: all 1s
}
.board-menu-enter , .board-menu-leave-to{
  left:-300px;
  width:0px;
}
.board-menu-enter-to , .board-menu-leave {
  left:0px;
  width:300px;
} */

.board-menu-header {
  height: 46px;
  padding: 0 6px 0 12px;
  border-bottom: #bbb solid 1px;
}
.header-title {
  font-size: 18px;
  text-align: center;
  line-height: 46px;
  font-weight:700;
}
.header-close-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  text-decoration: none;
  font-size: 24px;
  color: #999;
}
.menu-list {
  list-style: none;
  padding-left: 0px;
}
.menu-list li {
  height: 40px;
  line-height: 18px;
  padding: 10px;
  margin: 5px;
  border-radius: 3px;
  font-size: 18px;
  font-weight: 700;
  color: #111;
  margin-bottom: 5px;
  cursor: pointer;
}
.menu-list li:hover,
.menu-list li:focus {
  background-color: rgba(0,0,0, .1);
}
.menu-list li a {
  text-decoration: none;
  color: inherit;
}
.color-picker {
  margin: 0 15px;
}
.color-picker a {
  display: inline-block;
  width: 49%;
  height: 100px;
  border-radius: 8px;
}
</style>
