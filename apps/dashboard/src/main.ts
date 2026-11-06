import { createApp, h } from 'vue';
import { App } from './App';
import { startDashboard } from './state';
import './styles.css';

createApp({ render: () => h(App) }).mount('#app');
void startDashboard();
