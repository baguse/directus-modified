import SchemaInspector from '@directus/schema';
import { Knex } from 'knex';
import { getCache, clearSystemCache } from '../cache';
import { ALIAS_TYPES } from '../constants';
import getDatabase, { getSchemaInspector } from '../database';
import { systemCollectionRows } from '../database/system-data/collections';
import env from '../env';
import { ForbiddenException, InvalidPayloadException } from '../exceptions';
import { FieldsService } from '../services/fields';
import { ItemsService } from '../services/items';
import Keyv from 'keyv';
import { AbstractServiceOptions, Collection, CollectionMeta, MutationOptions } from '../types';
import { Accountability, FieldMeta, Filter, Query, RawField, SchemaOverview } from '@directus/shared/types';
import { Table } from 'knex-schema-inspector/dist/types/table';
import { addFieldFlag } from '@directus/shared/utils';
import { getHelpers, Helpers } from '../database/helpers';

export type RawCollection = {
	collection: string;
	fields?: RawField[];
	schema?: Partial<Table> | null;
	meta?: Partial<CollectionMeta> | null;
};

const SCHEMA_TYPES = ['public', 'datacore', 'configuration'];

export class CollectionsService {
	knex: Knex;
	helpers: Helpers;
	accountability: Accountability | null;
	schemaInspector: ReturnType<typeof SchemaInspector>;
	schema: SchemaOverview;
	cache: Keyv<any> | null;
	systemCache: Keyv<any>;
	options:
		| {
				isSystem?: boolean;
		  }
		| undefined;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.helpers = getHelpers(this.knex);
		this.accountability = options.accountability || null;
		this.schemaInspector = options.knex ? SchemaInspector(options.knex) : getSchemaInspector();
		this.schema = options.schema;
		this.options = options.options;

		const { cache, systemCache } = getCache();
		this.cache = cache;
		this.systemCache = systemCache;
	}

	/**
	 * Create a single new collection
	 */
	async createOne(payload: RawCollection, opts?: MutationOptions): Promise<string> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		if (!SCHEMA_TYPES.includes(payload.meta?.schema || ''))
			throw new InvalidPayloadException('Schema is not registered');

		if (!payload.collection) throw new InvalidPayloadException(`"collection" is required`);

		if (payload.collection.startsWith('directus_')) {
			throw new InvalidPayloadException(`Collections can't start with "directus_"`);
		}

		const setting = await this.knex('directus_settings').select('*').first();

		if (setting?.mode == 'PRODUCTION') {
			if ((payload.meta?.schema || '').toUpperCase() !== 'PUBLIC') {
				throw new InvalidPayloadException('Cant create collection with that schema');
			}
		}

		try {
			const existingCollections: string[] = [
				...((await this.knex.select('collection').from('directus_collections'))?.map(({ collection }) => collection) ??
					[]),
				...Object.keys(this.schema.collections),
			];

			if (existingCollections.includes(payload.collection)) {
				throw new InvalidPayloadException(`Collection "${payload.collection}" already exists.`);
			}

			// Create the collection/fields in a transaction so it'll be reverted in case of errors or
			// permission problems. This might not work reliably in MySQL, as it doesn't support DDL in
			// transactions.
			await this.knex.transaction(async (trx) => {
				if (payload.schema) {
					// Directus heavily relies on the primary key of a collection, so we have to make sure that
					// every collection that is created has a primary key. If no primary key field is created
					// while making the collection, we default to an auto incremented id named `id`
					if (!payload.fields)
						payload.fields = [
							{
								field: 'id',
								type: 'integer',
								meta: {
									hidden: true,
									interface: 'numeric',
									readonly: true,
								},
								schema: {
									is_primary_key: true,
									has_auto_increment: true,
								},
							},
						];

					// Ensure that every field meta has the field/collection fields filled correctly
					payload.fields = payload.fields.map((field) => {
						if (field.meta) {
							field.meta = {
								...field.meta,
								field: field.field,
								collection: payload.collection!,
							};
						}

						// Add flag for specific database type overrides
						const flagToAdd = this.helpers.date.fieldFlagForField(field.type);
						if (flagToAdd) {
							addFieldFlag(field, flagToAdd);
						}

						return field;
					});

					const fieldsService = new FieldsService({ knex: trx, schema: this.schema });

					await trx.schema.createTable(payload.collection, (table) => {
						for (const field of payload.fields!) {
							if (field.type && ALIAS_TYPES.includes(field.type) === false) {
								fieldsService.addColumnToTable(table, field);
							}
						}
					});

					const fieldItemsService = new ItemsService('directus_fields', {
						knex: trx,
						accountability: this.accountability,
						schema: this.schema,
					});

					const fieldPayloads = payload.fields!.filter((field) => field.meta).map((field) => field.meta) as FieldMeta[];
					await fieldItemsService.createMany(fieldPayloads);
				}

				if (payload.meta) {
					const collectionItemsService = new ItemsService('directus_collections', {
						knex: trx,
						accountability: this.accountability,
						schema: this.schema,
					});

					await collectionItemsService.createOne({
						...payload.meta,
						collection: payload.collection,
					});
				}

				return payload.collection;
			});

			return payload.collection;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}

	/**
	 * Create multiple new collections
	 */
	async createMany(payloads: RawCollection[], opts?: MutationOptions): Promise<string[]> {
		try {
			const collections = await this.knex.transaction(async (trx) => {
				const service = new CollectionsService({
					schema: this.schema,
					accountability: this.accountability,
					knex: trx,
				});

				const collectionNames: string[] = [];

				for (const payload of payloads) {
					const name = await service.createOne(payload, { autoPurgeCache: false });
					collectionNames.push(name);
				}

				return collectionNames;
			});

			return collections;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}

	/**
	 * Read all collections. Currently doesn't support any query.
	 */
	async readByQuery(opts?: {
		includePhysicalTable?: boolean;
		includeExternalTable?: boolean;
		includeSystemTable?: boolean;
		query?: Query;
	}): Promise<Collection[]> {
		const includePhysicalTable = typeof opts?.includePhysicalTable == 'undefined' ? false : opts.includePhysicalTable;
		const includeExternalTable = typeof opts?.includeExternalTable == 'undefined' ? false : opts.includeExternalTable;
		const includeSystemTable = typeof opts?.includeSystemTable == 'undefined' ? true : opts.includeSystemTable;
		const collectionItemsService = new ItemsService('directus_collections', {
			knex: this.knex,
			schema: this.schema,
			accountability: this.accountability,
		});

		let tablesInDatabase = await this.schemaInspector.tableInfo();

		const isExternalSourceFilter: Filter = includeExternalTable
			? {
					is_external_source: {
						_eq: true,
					},
			  }
			: {
					_or: [
						{
							is_external_source: {
								_eq: false,
							},
						},
						{
							is_external_source: {
								_null: true,
							},
						},
					],
			  };

		const query: Query = {
			limit: -1,
			filter: isExternalSourceFilter,
		};

		if (opts?.query) {
			query.limit = opts.query.limit || -1;
			if (!opts.query.filter) {
				query.filter = isExternalSourceFilter;
			} else {
				query.filter = {
					_and: [opts.query.filter, isExternalSourceFilter],
				};
			}
		}

		let meta = (await collectionItemsService.readByQuery(query)) as CollectionMeta[];

		if (includeSystemTable) meta.push(...systemCollectionRows);

		if (this.accountability && this.accountability.admin !== true) {
			const collectionsGroups: { [key: string]: string } = meta.reduce(
				(meta, item) => ({
					...meta,
					[item.collection]: item.group,
				}),
				{}
			);

			let collectionsYouHavePermissionToRead: string[] = this.accountability
				.permissions!.filter((permission) => {
					return permission.action === 'read';
				})
				.map(({ collection }) => collection);

			for (const collection of collectionsYouHavePermissionToRead) {
				const group = collectionsGroups[collection];
				if (group) collectionsYouHavePermissionToRead.push(group);
				delete collectionsGroups[collection];
			}

			collectionsYouHavePermissionToRead = [...new Set([...collectionsYouHavePermissionToRead])];

			tablesInDatabase = tablesInDatabase.filter((table) => {
				return collectionsYouHavePermissionToRead.includes(table.name);
			});

			meta = meta.filter((collectionMeta) => {
				return collectionsYouHavePermissionToRead.includes(collectionMeta.collection);
			});
		}

		const collections: Collection[] = [];

		const allCollection: string[] = [];

		for (const collectionMeta of meta) {
			allCollection.push(collectionMeta.collection);
			const { system } = collectionMeta;
			const collection: Collection = {
				collection: collectionMeta.collection,
				meta: collectionMeta,
				schema: tablesInDatabase.find((table) => table.name === collectionMeta.collection) ?? null,
			};

			if (typeof this.options?.isSystem == 'undefined') {
				collections.push(collection);
			} else if (this.options?.isSystem === true) {
				if (system) collections.push(collection);
			} else {
				if (!system) collections.push(collection);
			}
		}

		for (const table of tablesInDatabase) {
			const exists = !!collections.find(({ collection }) => collection === table.name);
			if (!exists && !allCollection.includes(table.name) && includePhysicalTable) {
				collections.push({
					collection: table.name,
					schema: table,
					meta: null,
				});
			}
		}

		if (env.DB_EXCLUDE_TABLES) {
			return collections.filter((collection) => env.DB_EXCLUDE_TABLES.includes(collection.collection) === false);
		}

		return collections;
	}

	/**
	 * Get a single collection by name
	 */
	async readOne(collectionKey: string): Promise<Collection> {
		const result = await this.readMany([collectionKey]);

		if (result.length === 0) throw new ForbiddenException();

		return result[0];
	}

	/**
	 * Read many collections by name
	 */
	async readMany(collectionKeys: string[]): Promise<Collection[]> {
		if (this.accountability && this.accountability.admin !== true) {
			const permissions = this.accountability.permissions!.filter((permission) => {
				return permission.action === 'read' && collectionKeys.includes(permission.collection);
			});

			if (collectionKeys.length !== permissions.length) {
				const collectionsYouHavePermissionToRead = permissions.map(({ collection }) => collection);

				for (const collectionKey of collectionKeys) {
					if (collectionsYouHavePermissionToRead.includes(collectionKey) === false) {
						throw new ForbiddenException();
					}
				}
			}
		}

		const collections = await this.readByQuery();
		return collections.filter(({ collection }) => collectionKeys.includes(collection));
	}

	/**
	 * Update a single collection by name
	 */
	async updateOne(collectionKey: string, data: Partial<Collection>, opts?: MutationOptions): Promise<string> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		try {
			const collectionItemsService = new ItemsService('directus_collections', {
				knex: this.knex,
				accountability: this.accountability,
				schema: this.schema,
			});

			const payload = data as Partial<Collection>;

			if (!payload.meta) {
				return collectionKey;
			}

			const exists = !!(await this.knex
				.select('collection')
				.from('directus_collections')
				.where({ collection: collectionKey })
				.first());

			if (exists) {
				await collectionItemsService.updateOne(collectionKey, payload.meta, opts);
			} else {
				await collectionItemsService.createOne({ ...payload.meta, collection: collectionKey }, opts);
			}

			return collectionKey;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}

	/**
	 * Update multiple collections by name
	 */
	async updateMany(collectionKeys: string[], data: Partial<Collection>, opts?: MutationOptions): Promise<string[]> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		try {
			await this.knex.transaction(async (trx) => {
				const service = new CollectionsService({
					schema: this.schema,
					accountability: this.accountability,
					knex: trx,
				});

				for (const collectionKey of collectionKeys) {
					await service.updateOne(collectionKey, data, { autoPurgeCache: false });
				}
			});

			return collectionKeys;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}

	/**
	 * Delete a single collection This will delete the table and all records within. It'll also
	 * delete any fields, presets, activity, revisions, and permissions relating to this collection
	 */
	async deleteOne(collectionKey: string, opts?: MutationOptions): Promise<string> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		try {
			const collections = await this.readByQuery();

			const collectionToBeDeleted = collections.find((collection) => collection.collection === collectionKey);

			if (!!collectionToBeDeleted === false) {
				throw new ForbiddenException();
			}

			await this.knex.transaction(async (trx) => {
				if (collectionToBeDeleted!.schema) {
					await trx.schema.dropTable(collectionKey);
				}

				// Make sure this collection isn't used as a group in any other collections
				await trx('directus_collections').update({ group: null }).where({ group: collectionKey });

				if (collectionToBeDeleted!.meta) {
					const collectionItemsService = new ItemsService('directus_collections', {
						knex: trx,
						accountability: this.accountability,
						schema: this.schema,
					});

					await collectionItemsService.deleteOne(collectionKey);
				}

				if (collectionToBeDeleted!.schema) {
					const fieldsService = new FieldsService({
						knex: trx,
						accountability: this.accountability,
						schema: this.schema,
					});

					await trx('directus_fields').delete().where('collection', '=', collectionKey);
					await trx('directus_presets').delete().where('collection', '=', collectionKey);

					const revisionsToDelete = await trx
						.select('id')
						.from('directus_revisions')
						.where({ collection: collectionKey });

					if (revisionsToDelete.length > 0) {
						const keys = revisionsToDelete.map((record) => record.id);
						await trx('directus_revisions').update({ parent: null }).whereIn('parent', keys);
					}

					await trx('directus_revisions').delete().where('collection', '=', collectionKey);

					await trx('directus_activity').delete().where('collection', '=', collectionKey);
					await trx('directus_permissions').delete().where('collection', '=', collectionKey);
					await trx('directus_relations').delete().where({ many_collection: collectionKey });

					const relations = this.schema.relations.filter((relation) => {
						return relation.collection === collectionKey || relation.related_collection === collectionKey;
					});

					for (const relation of relations) {
						// Delete related o2m fields that point to current collection
						if (relation.related_collection && relation.meta?.one_field) {
							await fieldsService.deleteField(relation.related_collection, relation.meta.one_field);
						}

						// Delete related m2o fields that point to current collection
						if (relation.related_collection === collectionKey) {
							await fieldsService.deleteField(relation.collection, relation.field);
						}
					}

					const a2oRelationsThatIncludeThisCollection = this.schema.relations.filter((relation) => {
						return relation.meta?.one_allowed_collections?.includes(collectionKey);
					});

					for (const relation of a2oRelationsThatIncludeThisCollection) {
						const newAllowedCollections = relation
							.meta!.one_allowed_collections!.filter((collection) => collectionKey !== collection)
							.join(',');
						await trx('directus_relations')
							.update({ one_allowed_collections: newAllowedCollections })
							.where({ id: relation.meta!.id });
					}
				}
			});

			return collectionKey;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}

	/**
	 * Delete multiple collections by key
	 */
	async deleteMany(collectionKeys: string[], opts?: MutationOptions): Promise<string[]> {
		if (this.accountability && this.accountability.admin !== true) {
			throw new ForbiddenException();
		}

		try {
			await this.knex.transaction(async (trx) => {
				const service = new CollectionsService({
					schema: this.schema,
					accountability: this.accountability,
					knex: trx,
				});

				for (const collectionKey of collectionKeys) {
					await service.deleteOne(collectionKey, { autoPurgeCache: false });
				}
			});

			return collectionKeys;
		} finally {
			if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
				await this.cache.clear();
			}

			await clearSystemCache();
		}
	}
}
