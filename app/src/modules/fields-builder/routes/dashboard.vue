<template>
	<private-view
		:title="
			currentCollectionName ? `${t('fields-query-builder')} - ${currentCollectionName}` : `${t('fields-query-builder')}`
		"
	>
		<template #title-outer:prepend>
			<v-button class="header-icon" rounded disabled icon secondary>
				<v-icon name="insights" />
			</v-button>
		</template>

		<template #navigation>
			<Navigation :current-collection="currentCollectionName" />
		</template>

		<template #actions></template>

		<template #sidebar>
			<sidebar-detail icon="info_outline" :title="t('information')" close>
				<div v-md="t('page_help_insights_overview')" class="page-description" />
			</sidebar-detail>
		</template>
		<div class="flex-container ml-15">
			<div class="col-5">
				<span class="label">Field Selector</span>
				<v-card class="field-list">
					<v-field-list :collection="currentCollectionName" :disabled-fields="fieldNames" @select-field="addField" />
				</v-card>
			</div>
			<div class="col-5 ml-15 mr-9" style="max-width: 100vh !important; overflow-x: scroll">
				<span class="label">Field List</span>
				<v-checkbox v-model="useWildCard" @change="updateUrlValue()">Use Wildcard</v-checkbox>
				<v-table :items="filteredFields" :headers="headers" class="mt-6" :showResize="true">
					<template #[`item.fieldName`]="{ item }">{{ getFieldDisplayName(item.name) }}</template>
					<template #[`item.useWildcard`]="{ item }">
						<v-checkbox v-model="wildCards[item.name]" :disabled="!item.hasChildren"></v-checkbox>
					</template>
					<template #[`item.action`]="{ item }">
						<v-icon
							v-tooltip="t('delete_field')"
							class="delete-field"
							name="delete"
							clickable
							@click="removeField(item.name)"
						/>
					</template>
				</v-table>
				<div class="footer">
					<div class="pagination">
						<v-pagination
							v-if="totalPages > 1"
							:length="totalPages"
							:total-visible="3"
							show-first-last
							:model-value="page"
							@update:model-value="toPage"
						/>
					</div>
				</div>
			</div>
		</div>
		<div class="flex-container mt-15 ml-15 mb-15">
			<v-input
				v-model="url"
				v-tooltip="'Press enter to process'"
				small
				placeholder="Input your url"
				@keypress.enter="editUrl"
			/>
		</div>
		<div class="flex-container mt-15 ml-15 mb-15">
			<div class="col-5" style="max-width: 100vh">
				<span class="label">Result</span>
				<v-button class="ml-9" x-small primary @click="tryIt">Try</v-button>
				<interface-input-code class="mt-6" :value="json" language="json" :line-wrapping="true"></interface-input-code>
			</div>
			<div class="col-5 ml-15 mr-9" style="max-width: 100vh">
				<span class="label">Response</span>
				<interface-input-code
					class="mt-9"
					:value="response"
					language="json"
					:line-wrapping="true"
				></interface-input-code>
			</div>
		</div>
	</private-view>
</template>

<script lang="ts">
import { defineComponent, Ref, ref, computed, watch, toRefs } from 'vue';
import { useI18n } from 'vue-i18n';
import { md } from '@/utils/md';
import { useCollectionsStore, useFieldsStore, useRelationsStore } from '@/stores/';
import Navigation from '../components/navigation.vue';
import VCard from '@/components/v-card/v-card.vue';
import { HeaderRaw } from '@/components/v-table/types';
import { extractFieldFromFunction } from '@/utils/extract-field-from-function';
import { Relation, Field } from '@directus/shared/types';
import { getRelationType } from '@directus/shared/utils';
import api from '@/api';
import { notify } from '@/utils/notify';

export default defineComponent({
	name: 'FieldsBuilder',
	components: {
		Navigation,
		VCard,
	},
	props: {
		collection: {
			type: String,
			default: '',
		},
	},
	emits: ['update:modelValue'],
	setup(props) {
		const { allCollections } = useCollectionsStore();
		const fieldsStore = useFieldsStore();
		const relationsStore = useRelationsStore();

		const { t } = useI18n();

		interface FieldList {
			name: string;
			hasChildren: boolean;
			useWildcard?: boolean;
		}

		const fields: Ref<FieldList[]> = ref([]);

		const fieldNames = computed(() => {
			const fildNamesMapped = fields.value.map((x) => x.name);
			if (useWildCard.value) {
				return ['*', ...fildNamesMapped];
			}
			return fildNamesMapped;
		});

		const page = ref(1);

		const MAX_ITEM = 5;

		const wildCards: Ref<{ [key: string]: boolean }> = ref({});

		const useWildCard = ref(true);

		const filteredFields = computed(() => {
			if (fields.value.length <= MAX_ITEM) return fields.value;

			const start = MAX_ITEM * (page.value - 1);
			const end = MAX_ITEM * (page.value - 1) + MAX_ITEM;

			return fields.value.slice(start, end);
		});

		const totalPages = computed(() => {
			return Math.ceil(fields.value.length / MAX_ITEM);
		});

		const json = computed(() => {
			return JSON.stringify(
				fieldNames.value.map((fieldName: string) => {
					const useWildcard = wildCards.value[fieldName];
					if (useWildcard) return `${fieldName}.*`;
					return fieldName;
				}),
				null,
				2
			);
		});

		const response = ref('{}');

		const defaultCollectionName = allCollections.length > 0 ? ref(allCollections[0].collection) : ref('');

		const newCollectionName = ref('');

		const headers: HeaderRaw[] = [
			{
				text: 'Field Name',
				value: 'fieldName',
				width: 450,
				sortable: false,
			},
			{
				text: 'Wildcard',
				value: 'useWildcard',
				width: 100,
				sortable: false,
			},
			{
				text: 'Action',
				value: 'action',
				width: 100,
				sortable: false,
			},
		];

		const collectionNameFromProps = toRefs(props).collection;

		watch(collectionNameFromProps, () => {
			newCollectionName.value = props.collection;
			fields.value = [];
			response.value = '';
			wildCards.value = {};
		});

		watch(useWildCard, () => {
			updateUrlValue();
		});

		const currentCollectionName = computed(() => {
			return newCollectionName.value || props.collection || defaultCollectionName.value;
		});

		const newUrl = ref('');

		const url = computed({
			get() {
				const fieldNameList = fieldNames.value.map((fieldName: string) => {
					const useWildcard = wildCards.value[fieldName];
					if (useWildcard) return `${fieldName}.*`;
					return fieldName;
				});
				return `/items/${currentCollectionName.value}?fields=${fieldNameList.join(',')}`;
			},
			set(value: string) {
				newUrl.value = value;
			},
		});

		return {
			t,
			md,
			addField,
			selectCollection,
			fields,
			removeField,
			headers,
			getFieldDisplayName,
			toPage,
			page,
			totalPages,
			filteredFields,
			json,
			fieldNames,
			wildCards,
			response,
			tryIt,
			useWildCard,
			currentCollectionName,
			url,
			editUrl,
			newUrl,
			updateUrlValue,
		};

		function addField(field: string, currrentUseWildcard = false) {
			const fieldConfig = fieldsStore.getField(currentCollectionName.value, field);
			let fieldRelation: string[] = [];
			if (fieldConfig && !fieldNames.value.includes(field)) {
				fieldRelation = getRelatedCollections(fieldConfig);
				const hasChildren = !!fieldRelation.length;

				fields.value = [
					...fields.value,
					{
						name: field,
						hasChildren,
						useWildcard: currrentUseWildcard,
					},
				];

				if (hasChildren) wildCards.value[field] = currrentUseWildcard;

				updateUrlValue();
			}
		}

		function removeField(fieldKey: string) {
			fields.value = fields.value.filter((field) => field.name !== fieldKey);
			if (fields.value.length <= MAX_ITEM) page.value = 1;
			updateUrlValue();
		}

		function selectCollection(collection: string) {
			newCollectionName.value = collection;
			fields.value = [];
			response.value = '{}';
			wildCards.value = {};
		}

		function getFieldDisplayName(fieldKey: string) {
			const fieldParts = fieldKey.split('.');

			const fieldNames = fieldParts.map((fieldKey, index) => {
				const hasFunction = fieldKey.includes('(') && fieldKey.includes(')');

				let key = fieldKey;
				let functionName;

				if (hasFunction) {
					const { field, fn } = extractFieldFromFunction(fieldKey);
					functionName = fn;
					key = field;
				}

				const pathPrefix = fieldParts.slice(0, index);
				const field = fieldsStore.getField(currentCollectionName.value, [...pathPrefix, key].join('.'));

				const name = field?.name ?? key;

				if (hasFunction) {
					return t(`functions.${functionName}`) + ` (${name})`;
				}

				return name;
			});

			return fieldNames.join(' -> ');
		}

		function toPage(currentPage: number) {
			page.value = currentPage;
		}

		function getRelatedCollections(field: Field): string[] {
			const relation = getRelationForField(field);
			if (!relation?.meta) return [];
			const relationType = getRelationType({ relation, collection: field.collection, field: field.field });

			switch (relationType) {
				case 'o2m':
					return [relation!.meta!.many_collection];
				case 'm2o':
					return [relation!.meta!.one_collection!];
				case 'm2a':
					return relation!.meta!.one_allowed_collections!;
				default:
					return [];
			}
		}

		function getRelationForField(field: { collection: string; field: string }) {
			const relations = [...relationsStore.getRelationsForField(field.collection, field.field)];

			return relations.find(
				(relation: Relation) =>
					(relation.collection === field.collection && relation.field === field.field) ||
					(relation.related_collection === field.collection && relation.meta?.one_field === field.field)
			);
		}

		async function tryIt() {
			try {
				const fieldNames = JSON.parse(json.value).join(',');
				const {
					data: { data },
				} = await api.get(`/items/${currentCollectionName.value}?fields=${fieldNames}&limit=1`);
				if (data[0]) {
					response.value = JSON.stringify(data[0], null, 2);
				}
				// copyToClipboard(`/items/${currentCollectionName.value}?fields=${fieldNames}`, {
				// 	success: 'Success & Path copied to clipboard',
				// });
				notify({
					title: 'Succes',
					type: 'success',
				});
			} catch {
				notify({
					title: 'Failed to execute endpoint',
					type: 'error',
				});
			}
		}

		function editUrl() {
			try {
				const urlData = new URL(`http://localhost${newUrl.value}`);

				const query = urlData.search.replace('?', '');

				const queryArr = query.split('&');

				const currentFieldNames: string[] = [];

				for (const queryData of queryArr) {
					const fieldQuery = queryData.split('=');
					if (fieldQuery[0] == 'fields[]') {
						currentFieldNames.push(fieldQuery[1]);
					}
				}

				const collectionArr = urlData.pathname.split('/items/');
				if (collectionArr.length <= 1) return;
				const [_, collectionName] = collectionArr;

				selectCollection(collectionName);

				let fieldsQuery = urlData.searchParams.get('fields') || '';

				if (currentFieldNames.length) {
					if (fieldsQuery) fieldsQuery += `,${currentFieldNames.join(',')}`;
					else fieldsQuery = currentFieldNames.join(',');
				}

				if (fieldsQuery) {
					const fieldsArr = fieldsQuery.split(',');
					let wildCard = false;
					for (const field of fieldsArr) {
						if (field == '*') {
							wildCard = true;
						} else {
							if (field) {
								const generatedFieldName = field.split('.');
								const lastField = generatedFieldName.pop();
								let currentUseWildcard = false;
								if (lastField == '*') {
									currentUseWildcard = true;
								} else if (lastField) {
									generatedFieldName.push(lastField);
								}
								addField(
									generatedFieldName.length ? generatedFieldName.join('.') : (lastField as string),
									currentUseWildcard
								);
							}
						}
					}

					useWildCard.value = wildCard;

					updateUrlValue();
				}
			} catch (_e) {
				notify({
					title: 'Failed to parse url',
					type: 'error',
				});
			}
		}

		function updateUrlValue() {
			const fieldNameList = fieldNames.value.map((fieldName: string) => {
				const useWildcard = wildCards.value[fieldName];
				if (useWildcard) return `${fieldName}.*`;
				return fieldName;
			});
			newUrl.value = `/items/${currentCollectionName.value}?fields=${fieldNameList.join(',')}`;
		}
	},
});
</script>

<style lang="scss" scoped>
.ml-3 {
	margin-left: 3px;
}

.ml-6 {
	margin-left: 6px;
}

.ml-9 {
	margin-left: 9px;
}

.ml-12 {
	margin-left: 12px;
}

.ml-15 {
	margin-left: 15px;
}

.mt-3 {
	margin-top: 3px;
}

.mt-6 {
	margin-top: 6px;
}

.mt-9 {
	margin-top: 9px;
}

.mt-12 {
	margin-top: 12px;
}

.mt-15 {
	margin-top: 15px;
}

.mb-3 {
	margin-bottom: 3px;
}

.mb-6 {
	margin-bottom: 6px;
}

.mb-9 {
	margin-bottom: 9px;
}

.mb-12 {
	margin-bottom: 12px;
}

.mb-15 {
	margin-bottom: 15px;
}

.mr-3 {
	margin-right: 3px;
}

.mr-6 {
	margin-right: 6px;
}

.mr-9 {
	margin-right: 9px;
}

.mr-12 {
	margin-right: 12px;
}

.mr-15 {
	margin-right: 15px;
}

.v-table {
	--v-table-sticky-offset-top: var(--layout-offset-top);

	display: contents;
}

.delete-field {
	--v-icon-color: var(--foreground-subdued);
	--v-icon-color-hover: var(--danger);

	.delete,
	&:hover {
		opacity: 1;
	}
}

.field-list {
	max-height: 45vh;
	overflow-x: hidden;
}

.table {
	max-height: 30vh;
	overflow-x: hidden;
	min-height: 40vh;
}

.flex-container {
	display: flex;
}

.col-1 {
	flex-grow: 1;
}

.col-2 {
	flex-grow: 2;
}

.col-3 {
	flex-grow: 3;
}

.col-4 {
	flex-grow: 4;
}

.col-5 {
	flex-grow: 5;
}

.col-6 {
	flex-grow: 6;
}

.col-7 {
	flex-grow: 7;
}

.col-8 {
	flex-grow: 8;
}

.col-9 {
	flex-grow: 9;
}

.col-10 {
	flex-grow: 10;
}

.footer {
	position: sticky;
	left: 0;
	display: flex;
	align-items: center;
	justify-content: space-between;
	width: 100%;
	padding: 32px var(--content-padding);
	align-content: center;

	.pagination {
		display: inline-block;
	}
}

.label {
	color: var(--foreground-normal);
}
</style>
