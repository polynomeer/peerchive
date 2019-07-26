<template>
  <div class="login">
    <h2 style="color:white">Log in to ProofU</h2>
    <form @submit.prevent="onSubmit">
      <div>
        <!--<label for="email">Email</label>-->
        <input class="form-control" type="text" name="email"
          v-model="email" autofocus placeholder="email" />
      </div>
      <div>
        <!--<label for="password">Passwrod</label>-->
        <input class="form-control" type="password"
          v-model="password" placeholder="password" />
      </div>
      <button class="btn" :class="{'btn-success': !invalidForm}" type="submit"
        :disabled="invalidForm">Log In</button>
      <router-link class="btn" :class="'btn-success'" style="text-decoration: none;" :to="`/signup`">
        <div>Sign Up</div>
      </router-link>
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
      name: '',
      error: '',
      rPath: ''
    }
  },
  computed: {
    invalidForm() {
      return !this.email || !this.password
    }
  },
  created() {
    this.rPath = this.$route.query.rPath || '/'
  },
  methods: {
    ...mapActions([
      'LOGIN'
    ]),
    onSubmit() {
      this.LOGIN({email: this.email, password: this.password})
        .then(data => {
          this.$router.push(this.rPath)
        })
        .catch(err => {
          this.error = err.data.error
        })
    }
  }
}
</script>

<style>
.login {
  width: 400px;
  margin: 0 auto;
}
.error {
  color: #f00;
}

</style>
