<template>
	<private-view :title="schema ? `${t('erd_viewer')} - ${schema}` : `${t('erd_viewer')}`">
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded disabled icon secondary>
				<v-icon name="insights" />
			</v-button>
		</template>

		<template #navigation>
			<ERDNavigation :collections="collections" />
		</template>

		<template #actions></template>

		<template #sidebar>
			<sidebar-detail icon="info_outline" :title="t('information')" close>
				<div v-md="t('page_help_insights_overview')" class="page-description" />
			</sidebar-detail>
		</template>
		<v-card class="ml-3">
			<v-select
				v-model="schema"
				:items="schemas"
				:fullWidth="true"
				:placeholder="t('interfaces.system-display-template.select_a_schema')"
				@click="changeSchema"
			/>
		</v-card>
		<div v-if="schema" v-viewer class="images">
			<img v-for="src in [url]" :key="src" :src="src" style="max-height: 700px" />
		</div>
	</private-view>
</template>

<script lang="ts">
import { defineComponent, computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { md } from '@/utils/md';
import { getRootPath } from '@/utils/get-root-path';
import { useUserStore, useCollectionsStore } from '@/stores/';
import ERDNavigation from '../components/navigation.vue';
import VCard from '@/components/v-card/v-card.vue';
import usePreset from '@/composables/use-preset';

export default defineComponent({
	name: 'ERDViewer',
	components: { ERDNavigation, VCard },
	setup() {
		const { currentUser } = useUserStore();
		const { allCollections } = useCollectionsStore();
		const { savePreset } = usePreset(ref('erd_viewer'));
		const theme = currentUser?.theme || 'auto';

		const lineColor = theme == 'light' ? 'black' : 'white';

		const { t } = useI18n();

		const url = computed(() => {
			return `${getRootPath()}datacore/entities/mermaid-erd/schema/${schema.value}?lineColor=${lineColor}`;
		});

		const schema = ref('');

		const schemas = computed(() => {
			const resultSchema = allCollections.map((x) => x.meta?.schema).filter((x) => x);
			const schemaList = [...new Set(resultSchema)].map((x) => ({ text: x, value: x }));
			return schemaList;
		});

		const collections = computed(() => {
			return allCollections
				.filter((x) => x.meta?.schema == schema.value)
				.map((x) => ({ icon: x.meta?.icon || 'box', color: x.meta?.color, label: x.name, name: x.collection }));
		});

		return {
			t,
			md,
			url,
			schema,
			schemas,
			collections,
			changeSchema,
		};

		async function changeSchema() {
			await savePreset({
				collection: 'erd-viewer',
				layout_options: {
					schema: schema.value,
				},
			});
		}
	},
});
</script>

<style scoped>
.ml-3 {
	margin-left: 3px;
}

.viewer-canvas {
	background-color: blue !important;
}
</style>
