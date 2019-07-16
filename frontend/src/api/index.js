import axios from 'axios'
import router from '../router'

//const DOMAIN = 'http://165.229.126.52:10000'
const DOMAIN = 'http://localhost:3000'
const UNAUTHORIZED = 401
const onUnauthorized = () => {
  router.push(`/login?rPath=${encodeURIComponent(location.pathname)}`)
}

const request = (method, url, data) => {
  return axios({
    method,
    url: DOMAIN + url,
    data
  }).then(result => result.data)
    .catch(result => {
      const {status} = result.response
      if (status === UNAUTHORIZED && url == '/login') onUnauthorized()
      throw result.response
    })
}

export const setAuthInHeader = token => {
  axios.defaults.headers.common['Authorization'] = token ? `Bearer ${token}` : null;
}

export const user = {
  create(email, password, name) {
    return request('post', '/users', {email, password, name})
  },
  fetch() {
    return request('get', `/users`)
  },
  update(payload) {
    return request('put', `/users`, payload)
  },
  destroy() {
    return request('delete', `/users`)
  },
  updatepw(payload) {
    return request('put', '/users/pw', payload)
  }
}

export const team = {
  create(payload) {
    return request('post', '/teams', payload)
  },
  fetch(id) {
    return id ? request('get', `/teams/${id}`) : request('get', '/teams')
  },
  entireFetch() {
    return request('get', '/teams/entire')
  },
  update(id, payload) {
    return request('put', `/teams/${id}`, payload)
  },
}

export const member = {
  create(payload) {
    return request('post', '/members', payload)
  },
  update(payload) {
    return request('put', '/members', payload)
  },
  destroy(payload) {
    return request('delete', '/members', payload)
  },
}

export const board = {
  fetch(id) {
    return id ? request('get', `/boards/${id}`) : request('get', '/boards')
  },
  create(payload) {
    return request('post', '/boards', payload)
  },
  update(id, payload) {
    return request('put', `/boards/${id}`, payload)
  },
  destroy(id) {
    return request('delete', `/boards/${id}`)
  },
  entireFetch(keyword) {
    return keyword ? request('get', `/search/${keyword}`) : request('get', '/boards/entire')
  },
  teamFetch(teamId) {
    return request('get', `/boards/team/${teamId}`)
  },
  hit(id) {
    return request('put', `/boards/hit/${id}`)
  }
}

export const list = {
  create(payload) {
    return request('post', '/lists', payload)
  },
  update(id, payload) {
    return request('put', `/lists/${id}`, payload)
  },
  destroy(id) {
    return request('delete', `/lists/${id}`)
  }
}

export const card = {
  fetch(id) {
    return request('get', `/cards/${id}`)
  },
  create(title, listId, pos) {
    return request('post', '/cards', {title, listId, pos})
  },
  update(id, payload) {
    return request('put', `/cards/${id}`, payload)
  },
  destroy(id) {
    return request('delete', `/cards/${id}`)
  }
}

export const auth = {
  login(email, password) {
    return request('post', '/login', {email, password})
  }
}

export const join = {
  create(payload) {
    return request('post', '/joins', payload)
  },
  destroy(payload) {
    return request('delete', '/joins', payload)
  }
}


export const message = {
  fetch(teamId) {
    return request('get', `/messages/${teamId}`)
  },
  create(payload) {
    return request('post', '/messages', payload)
  }
}

export const boardfile= {
  destroy(payload) {
    return request('delete', '/boardfiles', payload)
  }
}
export const cardfile= {
  destroy(payload) {
    return request('delete', '/cardfiles', payload)
  }
}

export const html = {
  fetch(url) {
    return request('get', '/html', {url})
  },
  fetchYU() {
    return request('get', '/html/yu')
  }
}
