<template>
	<v-list-group
		v-if="isGroup && matchesSearch"
		v-context-menu="'contextMenu'"
		:to="to"
		scope="content-navigation"
		:value="collection.collection"
		query
		:arrow-placement="false"
	>
		<template #activator>
			<navigation-item-content
				:search="search"
				:name="collection.name"
				:icon="collection.meta?.icon"
				:color="collection.meta?.color"
				:tags="collection.meta?.tags"
			/>
		</template>
		<navigation-item
			v-for="childCollection in childCollections"
			:key="childCollection.collection"
			:collection="childCollection"
			:search="search"
		/>
		<!-- <navigation-bookmark v-for="bookmark in childBookmarks" :key="bookmark.id" :bookmark="bookmark" /> -->
	</v-list-group>

	<v-list-item
		v-else-if="matchesSearch"
		v-context-menu="hasContextMenu ? 'contextMenu' : null"
		:to="to"
		:value="collection.collection"
		:class="{ hidden: collection.meta?.hidden }"
		query
	>
		<navigation-item-content
			:search="search"
			:name="collection.name"
			:icon="collection.meta?.icon"
			:color="collection.meta?.color"
			:tags="collection.meta?.tags"
		/>
	</v-list-item>

	<v-menu v-if="hasContextMenu" ref="contextMenu" show-arrow placement="bottom-start">
		<v-list>
			<v-list-item v-if="isAdmin" clickable :to="`/settings/data-model/${collection.collection}`">
				<v-list-item-icon>
					<v-icon name="list_alt" />
				</v-list-item-icon>
				<v-list-item-content>
					<v-text-overflow :text="t('edit_collection')" />
				</v-list-item-content>
			</v-list-item>
			<v-list-item v-if="moduleEnabled['erd-viewer']" clickable :to="`/erd-viewer/${collection.collection}`">
				<v-list-item-icon>
					<v-icon name="device_hub" />
				</v-list-item-icon>
				<v-list-item-content>
					<v-text-overflow :text="t('goto_collection_erd')" />
				</v-list-item-content>
			</v-list-item>
			<v-list-item v-if="moduleEnabled['fields-builder']" clickable :to="`/fields-builder/${collection.collection}`">
				<v-list-item-icon>
					<v-icon name="memory" />
				</v-list-item-icon>
				<v-list-item-content>
					<v-text-overflow :text="t('goto_collection_fields_builder')" />
				</v-list-item-content>
			</v-list-item>
		</v-list>
	</v-menu>
</template>

<script lang="ts">
import { defineComponent, PropType, computed } from 'vue';
import { Collection } from '@/types';
import { Preset } from '@directus/shared/types';
import { useUserStore, useCollectionsStore, usePresetsStore, useSettingsStore } from '@/stores';
import NavigationItemContent from './navigation-item-content.vue';
// import NavigationBookmark from './navigation-bookmark.vue';
import { useI18n } from 'vue-i18n';
import { orderBy } from 'lodash';
import { MODULE_BAR_DEFAULT } from '@/constants';

export default defineComponent({
	name: 'NavigationItem',
	components: { NavigationItemContent },
	props: {
		collection: {
			type: Object as PropType<Collection>,
			required: true,
		},
		showHidden: {
			type: Boolean,
			default: false,
		},
		search: {
			type: String,
			default: null,
		},
	},
	setup(props) {
		const { t } = useI18n();

		const { isAdmin } = useUserStore();
		const collectionsStore = useCollectionsStore();
		const presetsStore = usePresetsStore();

		const childCollections = computed(() => getChildCollections(props.collection));

		const childBookmarks = computed(() => getChildBookmarks(props.collection));

		const isGroup = computed(() => childCollections.value.length > 0 || childBookmarks.value.length > 0);

		const to = computed(() => (props.collection.schema ? `/content/${props.collection.collection}` : ''));

		let moduleBars = MODULE_BAR_DEFAULT;

		const settingsStore = useSettingsStore();
		if (typeof settingsStore.settings?.module_bar == 'string') {
			moduleBars = JSON.parse(settingsStore.settings.module_bar);
		} else {
			moduleBars = settingsStore.settings?.module_bar || [];
		}

		const moduleEnabled: { [moduleId: string]: boolean } = {};

		for (const moduleBar of moduleBars) {
			moduleEnabled[moduleBar.id] = moduleBar.enabled;
		}

		const matchesSearch = computed(() => {
			if (!props.search || props.search.length < 3) return true;

			const searchQuery = props.search.toLowerCase();

			return matchesSearch(props.collection) || childrenMatchSearch(childCollections.value, childBookmarks.value);

			function childrenMatchSearch(collections: Collection[], bookmarks: Preset[]): boolean {
				return (
					collections.some((collection) => {
						const childCollections = getChildCollections(collection);
						const childBookmarks = getChildBookmarks(collection);

						return matchesSearch(collection) || childrenMatchSearch(childCollections, childBookmarks);
					}) || bookmarks.some((bookmark) => bookmarkMatchesSearch(bookmark))
				);
			}

			function matchesSearch(collection: Collection) {
				return collection.collection.includes(searchQuery) || collection.name.toLowerCase().includes(searchQuery);
			}

			function bookmarkMatchesSearch(bookmark: Preset) {
				return bookmark.bookmark?.toLowerCase().includes(searchQuery);
			}
		});

		const hasContextMenu = computed(() => isAdmin);

		return {
			childCollections,
			childBookmarks,
			isGroup,
			to,
			matchesSearch,
			isAdmin,
			t,
			hasContextMenu,
			moduleEnabled,
		};

		function getChildCollections(collection: Collection) {
			let collections = collectionsStore.collections.filter(
				(childCollection) => childCollection.meta?.group === collection.collection
			);

			if (props.showHidden === false) {
				collections = collections.filter((collection) => collection.meta?.hidden !== true);
			}

			return orderBy(collections, ['meta.sort', 'collection']);
		}

		function getChildBookmarks(collection: Collection) {
			return presetsStore.bookmarks.filter((bookmark) => bookmark.collection === collection.collection);
		}
	},
});
</script>

<style scoped>
.hidden {
	--v-list-item-color: var(--foreground-subdued);
}
</style>
