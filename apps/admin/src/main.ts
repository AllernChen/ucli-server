import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles.css'
import './forms.css'
import Dashboard from './Dashboard.vue'
import Channels from './views/Channels.vue'
import Models from './views/Models.vue'
import Skills from './views/Skills.vue'
import Reports from './views/Reports.vue'
import Governance from './views/Governance.vue'
import Organizations from './views/Organizations.vue'

const routes = [
  { path: '/', name: 'overview', component: Dashboard },
  { path: '/usage', name: 'usage', component: Dashboard },
  { path: '/channels', name: 'channels', component: Channels },
  { path: '/models', name: 'models', component: Models },
  { path: '/skills', name: 'skills', component: Skills },
  { path: '/reports', name: 'reports', component: Reports },
  { path: '/governance', name: 'governance', component: Governance },
  { path: '/organizations', name: 'organizations', component: Organizations }
]
createApp(App).use(createRouter({ history: createWebHistory(), routes })).mount('#app')
