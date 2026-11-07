import { createApp, h } from 'vue';
import { App } from './App';
import { startTheme } from './lib/theme';
import { startDashboard } from './state';
import './fonts.css';
import './styles.css';

startTheme();
createApp({ render: () => h(App) }).mount('#app');
void startDashboard();
