import Vue from 'vue'
import VueRouter from 'vue-router'
import Home from '../components/Home.vue'
import Login from '../components/Login.vue'
import SignUp from '../components/SignUp.vue'
import MyPage from '../components/MyPage.vue'
import Profile from '../components/Profile.vue'
import ChangePW from '../components/ChangePW.vue'
import Search from '../components/Search.vue'
import Board from '../components/Board.vue'
import Card from '../components/Card.vue'
import Team from '../components/Team.vue'
import NotFound from '../components/NotFound.vue'
import store from '../store'

Vue.use(VueRouter)

const requireAuth = (to, from, next) => {
  const loginPath = `/login?rPath=${encodeURIComponent(to.path)}`
  store.getters.isAuth ? next() : next(loginPath)
}

const router = new VueRouter({
  mode: 'history',
  routes: [
    {
      path: '/',
      component: Home,
      beforeEnter: requireAuth
    },
    {
      path: '/login',
      component: Login
    },
    {
      path: '/b/:bid',
      component: Board,
      beforeEnter: requireAuth,
      children: [{ path: 'c/:cid', component: Card }]
    },
    {
      path: '/t/:tid',
      component: Team,
      beforeEnter: requireAuth,
    },
    {
      path: '/signup',
      component: SignUp,
    },
    {
      path: '/mypage',
      component: MyPage,
      beforeEnter: requireAuth
    },
    {
      path: '/profile',
      component: Profile,
      beforeEnter: requireAuth
    },
    {
      path: '/mypage/changepw',
      component: ChangePW,
      beforeEnter: requireAuth
    },
    {
      path: '/s/:keyword?',
      component: Search,
      beforeEnter: requireAuth
    },
    {
      path: '*',
      component: NotFound
    }
  ]
})

export default router
