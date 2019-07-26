<template>
  <div class="signup">
    <h2 style="color:white">Sign Up to ProofU</h2>
    <form @submit.prevent="onSubmit">
      <div>
        <label style="color:white" for="email">Email</label>
        <input class="form-control" type="text" name="email"
          v-model="email" autofocus placeholder="email" />
      </div>
      <div>
        <label style="color:white" for="password">Passwrod</label>
        <input class="form-control" type="password"
          v-model="password" placeholder="password" />
      </div>
      <div>
        <label style="color:white" for="passwordcheck">Passwrod Check</label>
        <input class="form-control" type="password"
          v-model="passwordcheck" placeholder="password check" />
      </div>
      <div>
        <label style="color:white" for="password">Name</label>
        <input class="form-control" type="text"
          v-model="name" placeholder="name" />
      </div>
      <button class="btn" :class="{'btn-success': !invalidForm}" type="submit"
        :disabled="invalidForm">Sign Up</button>
    </form>
    <p class="error" v-if="error">{{error}}</p>
  </div>
</template>

<script>
import {mapActions} from 'vuex'

export default {
  data() {
    return {
      email: '',
      password: '',
      passwordcheck: '',
      name: '',
      error: ''
    }
  },
  computed: {
    invalidForm() {
      return !this.email || !this.password || !this.passwordcheck || !this.name
    }
  },
  created() {
    this.rPath = this.$route.query.rPath || '/'
  },
  methods: {
    ...mapActions([
      'ADD_USER'
    ]),
    onSubmit() {
      if(this.password != this.passwordcheck) {
          this.error = '비밀번호가 일치하지 않습니다.'
          return
      }
      this.ADD_USER({email: this.email, password: this.password, name: this.name})
        .then(data => {
          this.$router.push('/')
        })
        .catch(err => {
          this.error = err.data.error
        })
    }
  }
}
</script>

<style>
.signup {
  width: 400px;
  margin: 0 auto;
}
.error {
  color: #f00;
}

</style>
