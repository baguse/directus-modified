<template>
	<v-list nav>
		<v-button v-if="$props.collections.length === 0" full-width outlined dashed>Empty</v-button>

		<v-list-item v-for="navItem in $props.collections" v-else :key="navItem" :to="`/erd-viewer/${navItem.name}`">
			<v-list-item-icon><v-icon :name="navItem.icon" :color="navItem.color" /></v-list-item-icon>
			<v-list-item-content>
				<v-text-overflow :text="navItem.label" />
			</v-list-item-content>
		</v-list-item>
	</v-list>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue';

export default defineComponent({
	name: 'ERDNavigation',
	props: {
		collections: {
			type: Array as PropType<
				Array<{
					icon?: string;
					name: string;
					label: string;
					color?: string | null;
				}>
			>,
			required: true,
		},
	},
});
</script>
