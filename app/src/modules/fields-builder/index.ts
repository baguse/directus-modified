import Index from './routes/dashboard.vue';
import { defineModule } from '@directus/shared/utils';

export default defineModule({
	id: 'fields-builder',
	name: '$t:fields-query-builder',
	icon: 'memory',
	routes: [
		{
			name: 'fields-builder',
			path: '',
			component: Index,
		},
		{
			name: 'fields-builder-collection',
			path: ':collection',
			component: Index,
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
