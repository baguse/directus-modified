import ERDOverview from './routes/overview.vue';
import ERDViewer from './routes/dashboard.vue';
import { defineModule } from '@directus/shared/utils';

export default defineModule({
	id: 'erd-viewer',
	name: '$t:erd_viewer',
	icon: 'device_hub',
	routes: [
		{
			name: 'erd-viewer-collection',
			path: ':collectionName',
			component: ERDOverview,
			props: true,
		},
		{
			name: 'erd-viewer',
			path: '',
			component: ERDViewer,
			props: true,
		},
	],
	preRegisterCheck(user) {
		const admin = user.role.admin_access;

		if (admin) return true;

		// const permission = permissions.find(
		// 	(permission) => permission.collection === 'directus_dashboards' && permission.action === 'read'
		// );

		// return !!permission;

		return false;
	},
});
