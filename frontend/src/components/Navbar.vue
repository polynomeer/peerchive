<template>
  <nav class="header">
    <left class="slider" v-if="isAuth" ></left>    <!-- slide menu -->
    <div class="search-box" v-if="isAuth">
      <form class="search-form" @submit.prevent="onSubmit">
        <input class="form-control" type="text" name="projectSearch"
          v-model="projectSearch" autofocus placeholder="project search">
        </input>
      </form>
    </div>
    <button class="search-btn" v-if="isAuth"  @submit.prevent="onSubmit"><img src="../assets/images/glass.png"></button>

    <div class="header-logo">
      <router-link to="/"><img src="../assets/images/home_logo.png"></router-link>      <!-- 홈 화면으로 가는 링크 -->
    </div>

    <div class="header-auth">
      <a href="" v-if="isAuth" @click.prevent="logout">Logout</a>
      <router-link v-else to="/login">Login</router-link>
    </div>
  </nav>
</template>

<script>
import {mapState, mapGetters, mapMutations, mapActions} from 'vuex'
import Left from './Left.vue'

export default {
  components:{
    Left
  },
  data() {
    return {
      projectSearch: ''
    }
  },
  computed: {
    ...mapState({
      navbarColor: 'navbarColor',
      bodyColor: 'bodyColor',
    }),
    ...mapGetters([
      'isAuth'
    ]),
  },
  watch: {
    'bodyColor': 'updateTheme'
  },
  created() {
    if(this.$route.params.keyword)
      this.projectSearch = this.$route.params.keyword.replace(/[+]/gi, ' ')
  },
  mounted() {
    this.updateTheme()
  },
  methods: {
    ...mapMutations([
      'LOGOUT'
    ]),
    ...mapActions([
        'UPDATE_USER'
    ]),
    logout() {
      this.UPDATE_USER({isOnline: false})
      this.LOGOUT()
      this.$router.push('/login')
      this.$el.style.backgroundColor = this.navbarColor
      const body = document.querySelector('body')
      const container = document.querySelector('.container')
      if (body) body.style.backgroundColor = '#6281B8'
      if (container) container.style.backgroundColor = '#6281B8'
    },
    updateTheme() {
      this.$el.style.backgroundColor = this.navbarColor
      const body = document.querySelector('body')
      const container = document.querySelector('.container')
      if (body) body.style.backgroundColor = this.bodyColor
      if (container) container.style.backgroundColor = this.bodyColor
    },
    onSubmit() {
      this.$router.push(`/s/${this.projectSearch.trim().replace(/[ ]/gi, '+')}`)
      this.projectSearch = this.projectSearch.trim()
    }
  }
}
</script>

<style>
.header {
  flex: none;
  background-color: rgba(0,0,0,.15);
  height: 42px;
  padding: 6px;
}
.header a {
  display: block;
  height: 30px;
  line-height: 30px;
  text-decoration: none;
  color: rgba(255,255,255,.5);
}
.search-box {
  position: absolute;
  /* position:fixed; */
  display:inline-block;
  left: 70px;
  /* text-align: center; */
}
.header-logo {
  position: absolute;
  /* position: fixed; */
  left: 50%;
  top: 5px;  /* logo 높이 */
  margin-left: -30px;
  text-align: center;
  font-weight: bolder;
  font-size: 24px;
}
.header-logo a:hover,
.header-logo a:focus {
  color: rgba(255,255,255,.9);
}
.header-auth {
  /* position: absolute; */
  position:fixed;
  right: 15px;
  top: 5px;
}
.header-auth a {
  border-radius: 2px;
  padding: 0 10px;
  background-color: rgba(255,255,255, .3);
  color: white;
  transition: all .3s;
}
.header-auth a:hover,
.header-auth a:focus {
  background-color: rgba(255,255,255, .5);
}

/* .slider{
  z-index:1;
}
.search-box{
  z-index:2;
} */
.search-form{
  /* position: absolute; */
  width: 200px;
  /* margin:10px 10px 10px 10px; */

}
.form-control{
  /* display:inline-block; */
  width:100%;
}
.search-btn {
  display:inline-block;
  left: 270px;
  /* position:absolute; */
  position:relative;
  text-decoration: none;
  font-size:14px;
  border-radius: 4px;
  padding: 5px 8px;
  height: auto;
  color: #fff;
  background-color: rgba(255,255,255,.2);
}
.search-btn:hover,
.search-btn:focus {
  background-color: rgba(0,0,0,.15);
  cursor: pointer;
}

</style>
