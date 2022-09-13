import getDatabase from '../database';
import { getSchema } from './get-schema';
import { CollectionsService, FieldsService, RelationsService } from '../services';
import { version } from '../../package.json';
import { Snapshot, SnapshotField, SnapshotRelation } from '../types';
import { Knex } from 'knex';
import { omit, sortBy, toPairs, fromPairs, mapValues, isPlainObject, isArray } from 'lodash';
import { Query, SchemaOverview } from '@directus/shared/types';

export async function getSnapshot(options?: {
	database?: Knex;
	schema?: SchemaOverview;
	collections?: string[];
}): Promise<Snapshot> {
	const database = options?.database ?? getDatabase();
	const schema = options?.schema ?? (await getSchema({ database }));

	const collectionsService = new CollectionsService({ knex: database, schema });
	const fieldsService = new FieldsService({ knex: database, schema });
	const relationsService = new RelationsService({ knex: database, schema });

	const collectionQuery: {
		includePhysicalTable: boolean;
		query?: Query;
	} = {
		includePhysicalTable: false,
	};

	if (options?.collections) {
		collectionQuery.query = {
			filter: {
				collection: {
					_in: options.collections,
				},
			},
		};
	}

	const [collectionsRaw, fieldsRaw, relationsRaw] = await Promise.all([
		collectionsService.readByQuery(collectionQuery),
		fieldsService.readAll(),
		relationsService.readAll(),
	]);

	let collectionsFiltered = collectionsRaw;
	if (options?.collections) {
		collectionsFiltered = collectionsRaw.filter((c) => options.collections?.includes(c.collection));
	}
	const collectionsFilteredByTag = collectionsFiltered.filter((item: any) => excludeByTag(item));
	const collectionsAllFilteredByTag = collectionsRaw.filter((item: any) => excludeByTag(item));
	const collectionNames = collectionsAllFilteredByTag.map((c) => c.collection);

	const fieldsFiltered = fieldsRaw.filter((item: any) => excludeSystem(item)).map(omitID) as SnapshotField[];
	const fieldsFilteredByCollection = fieldsFiltered.filter((f) => collectionNames.includes(f.collection));
	const fieldsFixedLength = fieldsFilteredByCollection.map((f) => {
		const length = f.schema?.max_length || 0;
		if (f.schema && length < 0) f.schema.max_length = 512;
		return f;
	});

	const relationsFiltered = relationsRaw.filter((item: any) => excludeSystem(item)).map(omitID) as SnapshotRelation[];
	let relationsFilteredByCollection: SnapshotRelation[] = [];

	if (options?.collections?.length) {
		relationsFilteredByCollection = relationsFiltered.filter((r) => {
			if (!collectionNames.includes(r.collection)) return false;
			return true;
		});
	} else {
		relationsFilteredByCollection = relationsFiltered.filter((r) => {
			if (!collectionNames.includes(r.collection) || !collectionNames.includes(r.related_collection || ''))
				return false;
			return true;
		});
	}

	const collectionsSorted = sortBy(mapValues(collectionsFilteredByTag, sortDeep), ['collection']);
	const fieldsSorted = sortBy(mapValues(fieldsFixedLength, sortDeep), ['collection', 'field']);
	const relationsSorted = sortBy(mapValues(relationsFilteredByCollection, sortDeep), ['collection', 'field']);

	return {
		version: 1,
		directus: version,
		collections: collectionsSorted,
		fields: fieldsSorted,
		relations: relationsSorted,
		patch: options?.collections?.length ? true : false,
	};
}

function excludeSystem(item: { meta?: { system?: boolean } }) {
	if (item?.meta?.system === true) return false;
	return true;
}

function excludeByTag(item: {
	collection: string;
	meta?: { tags?: string[]; is_submission_form?: boolean; system?: boolean };
}) {
	if (item?.meta?.system) return true;
	const tags = item?.meta?.tags;
	if (!tags) return false;
	if (!tags.length) return false;
	if (tags.includes('removeable') || tags.includes('testing') || tags.includes('submission')) return false;
	if (item.meta?.is_submission_form) return false;
	return true;
}

function omitID(item: Record<string, any>) {
	return omit(item, 'meta.id');
}

function sortDeep(raw: any): any {
	if (isPlainObject(raw)) {
		const mapped = mapValues(raw, sortDeep);
		const pairs = toPairs(mapped);
		const sorted = sortBy(pairs);
		return fromPairs(sorted);
	}

	if (isArray(raw)) {
		return sortBy(raw);
	}

	return raw;
}
