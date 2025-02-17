<template>
	<div class="v-pagination">
		<v-button class="previous" :disabled="disabled || modelValue === 1" secondary icon small @click="toPrev">
			<v-icon name="chevron_left" />
		</v-button>

		<v-button
			v-if="showFirstLast && modelValue > Math.ceil(totalVisible / 2) + 1 && length > totalVisible"
			class="page"
			secondary
			small
			:disabled="disabled"
			@click="toPage(1)"
		>
			1
		</v-button>

		<span v-if="showFirstLast && modelValue > Math.ceil(totalVisible / 2) + 1 && length > totalVisible + 1" class="gap">
			...
		</span>

		<v-button
			v-for="page in visiblePages"
			:key="page"
			:class="{ active: modelValue === page }"
			class="page"
			secondary
			small
			:disabled="disabled"
			@click="toPage(page)"
		>
			{{ page }}
		</v-button>

		<span
			v-if="showFirstLast && modelValue < length - Math.ceil(totalVisible / 2) && length > totalVisible + 1"
			class="gap"
		>
			...
		</span>

		<v-button
			v-if="showFirstLast && modelValue <= length - Math.ceil(totalVisible / 2) && length > totalVisible"
			:class="{ active: modelValue === length }"
			class="page"
			secondary
			small
			:disabled="disabled"
			@click="toPage(length)"
		>
			{{ length }}
		</v-button>

		<v-button class="next" :disabled="disabled || modelValue === length" secondary icon small @click="toNext">
			<v-icon name="chevron_right" />
		</v-button>
	</div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { isEmpty } from '@/utils/is-empty';

export default defineComponent({
	props: {
		disabled: {
			type: Boolean,
			default: false,
		},
		length: {
			type: Number,
			default: null,
			required: true,
			validator: (val: number) => val % 1 === 0,
		},
		totalVisible: {
			type: Number,
			default: undefined,
			validator: (val: number) => val >= 0,
		},
		modelValue: {
			type: Number,
			default: null,
		},
		showFirstLast: {
			type: Boolean,
			default: false,
		},
	},
	emits: ['update:modelValue'],
	setup(props, { emit }) {
		const visiblePages = computed<number[]>(() => {
			if (props.totalVisible === undefined) return [];

			let startPage: number;
			let endPage: number;

			if (isEmpty(props.totalVisible) || props.length <= props.totalVisible) {
				startPage = 1;
				endPage = props.length;
			} else {
				const pagesBeforeCurrentPage = Math.floor(props.totalVisible / 2);
				const pagesAfterCurrentPage = Math.ceil(props.totalVisible / 2) - 1;

				if (props.modelValue <= pagesBeforeCurrentPage) {
					startPage = 1;
					endPage = props.totalVisible;
				} else if (props.modelValue + pagesAfterCurrentPage >= props.length) {
					startPage = props.length - props.totalVisible + 1;
					endPage = props.length;
				} else {
					startPage = props.modelValue - pagesBeforeCurrentPage;
					endPage = props.modelValue + pagesAfterCurrentPage;
				}
			}

			return Array.from(Array(endPage + 1 - startPage).keys()).map((i) => startPage + i);
		});

		return { toPage, toPrev, toNext, visiblePages };

		function toPrev() {
			toPage(props.modelValue - 1);
		}

		function toNext() {
			toPage(props.modelValue + 1);
		}

		function toPage(page: number) {
			emit('update:modelValue', page);
		}
	},
});
</script>

<style scoped>
:global(body) {
	--v-pagination-active-color: var(--primary);
}

.v-pagination {
	display: flex;
}

.gap {
	display: none;
	margin: 0 4px;
	color: var(--foreground-subdued);
	line-height: 2em;
}

@media (min-width: 600px) {
	.gap {
		display: inline;
	}
}

.v-button {
	--v-button-background-color-hover: var(--background-normal);
	--v-button-background-color: var(--background-subdued);
	--v-button-color: var(--foreground-normal);

	margin: 0 2px;
	vertical-align: middle;
}

.v-button.page:not(.active) {
	display: none;
}

@media (min-width: 600px) {
	.v-button.page:not(.active) {
		display: inline;
	}
}

.v-button :deep(.small) {
	--v-button-min-width: 32px;
}

.v-button:first-child {
	margin-left: 0;
}

.v-button:last-child {
	margin-right: 0;
}

.v-button.active {
	--v-button-background-color-hover: var(--primary) !important;
	--v-button-color-hover: var(--foreground-inverted) !important;
	--v-button-background-color: var(--primary) !important;
	--v-button-color: var(--foreground-inverted) !important;
}
</style>
