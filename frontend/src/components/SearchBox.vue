<template>
  <form class="search-box" @submit.prevent="onSubmit">
    <input class="form-control" type="text" name="projectSearch"
      v-model="projectSearch" autofocus placeholder="project search">
    </input>
    <button class="search-btn">Search</button>
  </form>
</template>

<script>

export default {
  data() {
    return {
      projectSearch: ''
    }
  },
  created() {
    if(this.$route.params.keyword)
      this.projectSearch = this.$route.params.keyword.replace(/[+]/gi, ' ')
  },
  methods: {
    onSubmit() {
      this.$router.push(`/s/${this.projectSearch.trim().replace(/[ ]/gi, '+')}`)
      this.projectSearch = this.projectSearch.trim()
    }
  }
}
</script>

<style>
.search-box{
  width: 100%;
  /* margin:10px 10px 10px 10px; */
}
.form-control{
  display:inline-block;
  width:90%;
}
.search-box button {
  /* display:inline-block; */
  text-decoration: none;
  border-radius: 4px;
  padding: 7px 10px;
  height: auto;
  display: inline-block;
  color: #fff;
  background-color: rgba(255,255,255,.2);
}
.search-box button:hover,
.search-box button:focus {
  background-color: rgba(0,0,0,.15);
  cursor: pointer;
}
</style>
