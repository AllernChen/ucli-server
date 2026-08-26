import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './styles.css'
import './forms.css'
import './model-test.css'
import './analytics.css'
import './procurement-costs.css'
import './procurement-costs-responsive.css'
import './device-grants.css'
import Dashboard from './Dashboard.vue'
import Channels from './views/Channels.vue'
import Models from './views/Models.vue'
import Skills from './views/Skills.vue'
import Reports from './views/Reports.vue'
import Governance from './views/Governance.vue'
import Organizations from './views/Organizations.vue'
import Usage from './views/Usage.vue'
import Connect from './views/Connect.vue'
import ChannelDetail from './views/ChannelDetail.vue'
import ModelDetail from './views/ModelDetail.vue'
import ModelTest from './views/ModelTest.vue'
import ProcurementCosts from './views/ProcurementCosts.vue'
import Users from './views/Users.vue'
import UserDetail from './views/UserDetail.vue'
import DeviceGrants from './views/DeviceGrants.vue'

const routes = [
  { path: '/', name: 'overview', component: Dashboard },
  { path: '/usage', name: 'usage', component: Usage },
  { path: '/channels', name: 'channels', component: Channels },
  { path: '/channels/:id', name: 'channel-detail', component: ChannelDetail },
  { path: '/models', name: 'models', component: Models },
  { path: '/models/:id', name: 'model-detail', component: ModelDetail },
  { path: '/model-test', name: 'model-test', component: ModelTest },
  { path: '/procurement-costs', name: 'procurement-costs', component: ProcurementCosts },
  { path: '/analytics', name: 'analytics', component: () => import('./views/Analytics.vue') },
  { path: '/skills', name: 'skills', component: Skills },
  { path: '/reports', name: 'reports', component: Reports },
  { path: '/users', name: 'users', component: Users },
  { path: '/users/:id', name: 'user-detail', component: UserDetail },
  { path: '/device-grants', name: 'device-grants', component: DeviceGrants },
  { path: '/governance', name: 'governance', component: Governance },
  { path: '/organizations', name: 'organizations', component: Organizations },
  { path: '/connect', name: 'connect', component: Connect, meta: { public: true } }
]
createApp(App).use(createRouter({ history: createWebHistory(), routes })).mount('#app')
