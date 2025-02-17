import { getCollectionType } from '../../src/utils';
import { Collection } from '../../src/types';

const TableCollection: Collection = {
	collection: 'table',
	schema: {
		name: 'table',
	},
	meta: null,
};

const AliasCollection: Collection = {
	collection: 'table',
	schema: null,
	meta: {
		collection: 'table',
		note: '',
		hidden: true,
		singleton: true,
		icon: 'box',
		color: '#abcabc',
		translations: null,
		display_template: null,
		sort_field: null,
		archive_field: null,
		archive_value: null,
		unarchive_value: null,
		archive_app_filter: true,
		item_duplication_fields: null,
		accountability: null,
		sort: null,
		group: null,
		collapse: 'open',
		is_soft_delete: false,
		schema: 'public',
	},
};

const UnknownCollection: Collection = {
	collection: 'unknown',
	schema: null,
	meta: null,
};

describe('getCollectionType', () => {
	it('returns "table" when collection has schema information', () => {
		expect(getCollectionType(TableCollection)).toStrictEqual('table');
	});

	it('returns "alias" when collection has schema information', () => {
		expect(getCollectionType(AliasCollection)).toStrictEqual('alias');
	});

	it('returns "unknown" when collection has schema information', () => {
		expect(getCollectionType(UnknownCollection)).toStrictEqual('unknown');
	});
});
