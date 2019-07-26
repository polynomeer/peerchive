<template>
  <div class="team_box" style="background-color: rgba(255, 0, 0, 0); padding-left:10px; padding-bottom: 10px">
    <div class="image-cropper">
        <img src="../assets/images/user_icon.png"/>
    </div>
    <div class="user-info">{{user.email}}</div>
    <div class="user-info">{{user.name}} 님</div>
    <a class="user-info-btn" href="" @click.prevent="$router.push('/mypage')">My page</a>
    <a class="user-info-btn" href="" @click.prevent="logout">Logout</a>
  </div>
</template>

<script>
import {mapState, mapMutations, mapActions} from 'vuex'

export default {
  data() {
    return {
      loading: false,
      error: ''
    }
  },
  computed: {
    ...mapState({
      user: 'user',
    })
  },
  created() {
    this.fetchData()
  },
  methods: {
    ...mapMutations([
      'LOGOUT'
    ]),
    ...mapActions([
      'FETCH_USER',
      'UPDATE_USER'
    ]),
    fetchData() {
      this.loading = true
      this.FETCH_USER().finally(_=> {
        this.loading = false
      })
    },
    logout() {
      this.UPDATE_USER({isOnline: false})
      this.LOGOUT()
      this.$router.push('/login')
    }
  }
}
</script>

<style>
.team_box{
  /* background-color: rgba(255, 0, 0, 0);
  padding-left:25px;
  padding-bottom: 15px; */
  background-color:white;
  margin:0px;
}
.user-info {
  padding: 15px;
  font-size: 18px;
  color: white;
  font-weight: bold;
}
.user-info-btn {
  padding: 5px 8px;
  font-size: 18px;
  color: white;
  font-weight: bold;

  text-decoration: none;
  border-radius: 4px;
  /* padding: 2px 10px; */
  height: auto;
  /* margin-bottom: 15px; */
  margin: 3px;
  display: inline-block;
  color: #fff;
  background-color: rgba(255,255,255,.2);
}
.user-info-btn:hover,
.user-info-btn:focus {
  background-color: rgba(0,0,0,.15);
  cursor: pointer;
}
.image-cropper {
    float:left;
    margin: 0 20px 20px 0;

    width: 100px;
    height: 100px;
    overflow: hidden;
    border-radius: 50%;
    text-align: center;
}
img {
    vertical-align: middle;
    /* display: inline; */
    height: 100%;
    width: auto;
}
</style>
