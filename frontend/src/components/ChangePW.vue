<template>
  <div class="mypage">
    <h2 style="color:white">My Page - Change Password</h2>
    <form @submit.prevent="onSubmit">
      <div style="margin-bottom:10px">
        <label style="color:white" for="email">Password</label>
        <input class="form-control" type="password"
          v-model="password" autofocus placeholder="password" />
      </div>
      <div>
        <label style="color:white" for="newpassword">New Password</label>
        <input class="form-control" type="password"
          v-model="newpassword" placeholder="new password" />
      </div>
      <div>
        <label style="color:white" for="newpasswordcheck">New Password Check</label>
        <input class="form-control" type="password"
          v-model="newpasswordcheck" placeholder="new password check" />
      </div>
      <button class="btn" :class="{'btn-success': !invalidForm}" @click.prevent="onUpdateUserPW"
        :disabled="invalidForm">Update</button>
    </form>
    <p class="error" v-if="error">{{error}}</p>
  </div>
</template>

<script>
import {mapState, mapActions} from 'vuex'

export default {
  data() {
    return {
      password: '',
      newpassword: '',
      newpasswordcheck: '',
      error: ''
    }
  },
  computed: {
    ...mapState({
      user: 'user'
    }),
    invalidForm() {
      return !this.password || !this.newpassword || !this.newpasswordcheck
    }
  },
  methods: {
    ...mapActions([
      'UPDATE_USER_PW'
    ]),
    onUpdateUserPW() {
      if(this.newpassword != this.newpasswordcheck) {
          this.error = '새 비밀번호가 일치하지 않습니다.'
          return
      }
      this.UPDATE_USER_PW({password: this.password, newpassword: this.newpassword})
        .then(data => {
          this.$router.push('/')
        })
        .catch(err => {
          this.error = err.data.error
        })
    },
  }
}
</script>

<style>
.mypage {
  width: 400px;
  margin: 0 auto;
}
.error {
  color: #f00;
}

</style>
