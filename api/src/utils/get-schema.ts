import SchemaInspector from '@directus/schema';
import { Accountability, Filter, SchemaOverview } from '@directus/shared/types';
import { toArray } from '@directus/shared/utils';
import { Knex } from 'knex';
import { mapValues } from 'lodash';
import { getCache, setSystemCache } from '../cache';
import { ALIAS_TYPES } from '../constants';
import getDatabase from '../database';
import { systemCollectionRows } from '../database/system-data/collections';
import { systemFieldRows } from '../database/system-data/fields';
import env from '../env';
import logger from '../logger';
import { RelationsService } from '../services';
import getDefaultValue from './get-default-value';
import getLocalType from './get-local-type';
import { parseJSON } from './parse-json';

export async function getSchema(options?: {
	accountability?: Accountability;
	database?: Knex;
}): Promise<SchemaOverview> {
	const database = options?.database || getDatabase();
	const schemaInspector = SchemaInspector(database);
	const { systemCache } = getCache();

	let result: SchemaOverview;

	if (env.CACHE_SCHEMA !== false) {
		let cachedSchema;

		try {
			cachedSchema = (await systemCache.get('schema')) as SchemaOverview;
		} catch (err: any) {
			logger.warn(err, `[schema-cache] Couldn't retrieve cache. ${err}`);
		}

		if (cachedSchema) {
			result = cachedSchema;
		} else {
			result = await getDatabaseSchema(database, schemaInspector);

			try {
				await setSystemCache('schema', result);
			} catch (err: any) {
				logger.warn(err, `[schema-cache] Couldn't save cache. ${err}`);
			}
		}
	} else {
		result = await getDatabaseSchema(database, schemaInspector);
	}

	return result;
}

async function getDatabaseSchema(
	database: Knex,
	schemaInspector: ReturnType<typeof SchemaInspector>
): Promise<SchemaOverview> {
	const result: SchemaOverview = {
		collections: {},
		relations: [],
		relationMap: {},
	};

	const schemaOverview = await schemaInspector.overview();

	const collections = [
		...(await database
			.select('collection', 'singleton', 'note', 'sort_field', 'accountability', 'is_soft_delete', 'schema')
			.from('directus_collections')
			.where('is_external_source', false)
			.orWhereNull('is_external_source')),
		...systemCollectionRows,
	];

	for (const [collection, info] of Object.entries(schemaOverview)) {
		if (toArray(env.DB_EXCLUDE_TABLES).includes(collection)) {
			logger.trace(`Collection "${collection}" is configured to be excluded and will be ignored`);
			continue;
		}

		if (!info.primary) {
			logger.warn(`Collection "${collection}" doesn't have a primary key column and will be ignored`);
			continue;
		}

		if (collection.includes(' ')) {
			logger.warn(`Collection "${collection}" has a space in the name and will be ignored`);
			continue;
		}

		const collectionMeta = collections.find((collectionMeta) => collectionMeta.collection === collection);
		result.collections[collection] = {
			collection,
			primary: info.primary,
			singleton:
				collectionMeta?.singleton === true || collectionMeta?.singleton === 'true' || collectionMeta?.singleton === 1,
			note: collectionMeta?.note || null,
			sortField: collectionMeta?.sort_field || null,
			accountability: collectionMeta ? collectionMeta.accountability : 'all',
			isSoftDelete: collectionMeta?.is_soft_delete || false,
			schema: collectionMeta?.schema || '',
			fields: mapValues(schemaOverview[collection].columns, (column) => {
				return {
					field: column.column_name,
					defaultValue: getDefaultValue(column) ?? null,
					nullable: column.is_nullable ?? true,
					generated: column.is_generated ?? false,
					type: getLocalType(column),
					dbType: column.data_type,
					precision: column.numeric_precision || null,
					scale: column.numeric_scale || null,
					special: [],
					note: null,
					validation: null,
					alias: false,
				};
			}),
			depends_on: [],
		};
	}

	const fields = [
		...(await database
			.select<
				{
					id: number;
					collection: string;
					field: string;
					special: string;
					note: string | null;
					validation: string | Record<string, any> | null;
				}[]
			>('id', 'collection', 'field', 'special', 'note', 'validation')
			.from('directus_fields')),
		...systemFieldRows,
	].filter((field) => (field.special ? toArray(field.special) : []).includes('no-data') === false);

	for (const field of fields) {
		if (!result.collections[field.collection]) continue;

		const existing = result.collections[field.collection].fields[field.field];
		const column = schemaOverview[field.collection].columns[field.field];
		const special = field.special ? toArray(field.special) : [];

		if (ALIAS_TYPES.some((type) => special.includes(type)) === false && !existing) continue;

		const type = (existing && getLocalType(column, { special })) || 'alias';
		let validation = field.validation ?? null;

		if (validation && typeof validation === 'string') validation = parseJSON(validation);

		result.collections[field.collection].fields[field.field] = {
			field: field.field,
			defaultValue: existing?.defaultValue ?? null,
			nullable: existing?.nullable ?? true,
			generated: existing?.generated ?? false,
			type: type,
			dbType: existing?.dbType || null,
			precision: existing?.precision || null,
			scale: existing?.scale || null,
			special: special,
			note: field.note,
			alias: existing?.alias ?? true,
			validation: (validation as Filter) ?? null,
		};
	}

	const relationsService = new RelationsService({ knex: database, schema: result });
	result.relations = await relationsService.readAll();
	for (const relation of result.relations) {
		if (!result.relationMap[relation.collection]) result.relationMap[relation.collection] = [];
		result.relationMap[relation.collection].push(relation);
		if (relation.related_collection) {
			if (!result.relationMap[relation.related_collection]) result.relationMap[relation.related_collection] = [];
			result.relationMap[relation.related_collection].push(relation);
		}
	}

	return result;
}
