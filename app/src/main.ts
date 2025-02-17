/* eslint-disable no-console */

import { createPinia } from 'pinia';
import { createApp } from 'vue';
import { version } from '../package.json';
import App from './app.vue';
import { registerComponents } from './components/register';
import { DIRECTUS_LOGO } from './constants';
import { registerDirectives } from './directives/register';
import { registerPanels } from './panels/register';
import { registerDisplays } from './displays/register';
import { registerInterfaces } from './interfaces/register';
import { i18n } from './lang/';
import { registerLayouts } from './layouts/register';
import { loadModules } from './modules/register';
import { router } from './router';
import './styles/main.scss';
import { registerViews } from './views/register';
import { registerOperations } from './operations/register';
import 'viewerjs/dist/viewer.css';
import VueViewer from 'v-viewer';

init();

async function init() {
	console.log(DIRECTUS_LOGO);
	// console.info(
	// 	`Hey! Interested in helping build this open-source data management platform?\nIf so, join our growing team of contributors at: https://directus.chat`
	// );

	if (import.meta.env.DEV) {
		console.info(`%cStarting MV Datacore v${version}...`, 'color:Blue');
	} else {
		console.info(`%cStarting MV Datacore...`, 'color:Blue');
	}

	console.time('🕓 Application Loaded');

	const app = createApp(App);

	app.use(router);
	app.use(i18n);
	app.use(createPinia());
	app.use(VueViewer);

	registerDirectives(app);
	registerComponents(app);
	registerViews(app);

	await Promise.all([
		registerInterfaces(app),
		registerPanels(app),
		registerDisplays(app),
		registerLayouts(app),
		registerOperations(app),
		loadModules(),
	]);

	app.mount('#app');

	console.timeEnd('🕓 Application Loaded');

	console.group(`%c✨ Project Information`, 'color:DodgerBlue'); // groupCollapsed

	if (import.meta.env.DEV) {
		console.info(`%cVersion: v${version}`, 'color:DodgerBlue');
	}

	console.info(`%cEnvironment: ${import.meta.env.MODE}`, 'color:DodgerBlue');
	console.groupEnd();

	// Prevent the browser from opening files that are dragged on the window
	window.addEventListener('dragover', (e) => e.preventDefault(), false);
	window.addEventListener('drop', (e) => e.preventDefault(), false);
}
