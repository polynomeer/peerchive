import Vue from 'vue'
import router from './router'
import App from './App.vue'
import store from './store'
import axios from 'axios'

import Vuetify from 'vuetify'
import DaySpanVuetify from 'dayspan-vuetify'
import Chartkick from 'vue-chartkick'
import Chart from 'chart.js'
import 'hchs-vue-charts'

import 'vuetify/dist/vuetify.css'
import 'material-design-icons-iconfont/dist/material-design-icons.css'
import 'dayspan-vuetify/dist/lib/dayspan-vuetify.min.css'

Vue.config.productionTip = false

Vue.use(Vuetify);

Vue.use(DaySpanVuetify, {
  methods: {
    getDefaultEventColor: () => '#1976d2'
  }
});

Vue.use(window.VueCharts)
Vue.use(Chartkick.use(Chart))

new Vue({
  el: '#app',
  router,
  store,
  render: h => h(App)
})
