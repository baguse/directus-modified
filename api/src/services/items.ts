import { Accountability, Action, PermissionsAction, Query, SchemaOverview } from '@directus/shared/types';
import Keyv from 'keyv';
import { Knex } from 'knex';
import { assign, clone, cloneDeep, pick, without } from 'lodash';
import { getCache } from '../cache';
import getDatabase from '../database';
import runAST from '../database/run-ast';
import emitter from '../emitter';
import env from '../env';
import { ForbiddenException, InvalidPayloadException } from '../exceptions';
import { RecordNotUniqueException } from '../exceptions/database/record-not-unique';
import { RecordNotUniqueCombinationException } from '../exceptions/database/record-not-unique-combination';
import { translateDatabaseError } from '../exceptions/database/translate';
import { AbstractService, AbstractServiceOptions, Item as AnyItem, MutationOptions, PrimaryKey } from '../types';
import getASTFromQuery from '../utils/get-ast-from-query';
import { validateKeys } from '../utils/validate-keys';
import { AuthorizationService } from './authorization';
import { ActivityService, RevisionsService, PayloadService } from './index';

export type QueryOptions = {
	stripNonRequested?: boolean;
	permissionsAction?: PermissionsAction;
	transformers?: {
		conceal?: boolean;
		hash?: boolean;
		json?: boolean;
		'json-stringify'?: boolean;
	};
};

export class ItemsService<Item extends AnyItem = AnyItem> implements AbstractService {
	collection: string;
	knex: Knex;
	accountability: Accountability | null;
	eventScope: string;
	schema: SchemaOverview;
	cache: Keyv<any> | null;
	bearerToken: string | null;

	constructor(collection: string, options: AbstractServiceOptions) {
		this.collection = collection;
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.eventScope = this.collection.startsWith('directus_') ? this.collection.substring(9) : 'items';
		this.schema = options.schema;
		this.cache = getCache().cache;
		this.bearerToken = options?.options?.bearerToken || null;

		return this;
	}

	async getKeysByQuery(query: Query): Promise<PrimaryKey[]> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		const readQuery = cloneDeep(query);
		readQuery.fields = [primaryKeyField];

		// Allow unauthenticated access
		const itemsService = new ItemsService(this.collection, {
			knex: this.knex,
			schema: this.schema,
		});

		// We read the IDs of the items based on the query, and then run `updateMany`. `updateMany` does it's own
		// permissions check for the keys, so we don't have to make this an authenticated read
		const items = await itemsService.readByQuery(readQuery);
		return items.map((item: AnyItem) => item[primaryKeyField]).filter((pk) => pk);
	}

	/**
	 * Create a single new item.
	 */
	async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		const fields = Object.keys(this.schema.collections[this.collection].fields);
		const isSoftDelete = this.schema.collections[this.collection].isSoftDelete;
		const aliases = Object.values(this.schema.collections[this.collection].fields)
			.filter((field) => field.alias === true)
			.map((field) => field.field);

		let deletedAtField = 'deleted_at';

		const fieldNames = Object.values(this.schema.collections[this.collection].fields)
			.filter((field) => {
				if (field.field == primaryKeyField) return false;
				else if (field.special.includes('date-deleted')) {
					if (isSoftDelete) deletedAtField = field.field;
					return false;
				} else if (field.special.includes('date-updated')) return false;
				else if (field.special.includes('date-created')) return false;
				else if (field.special.includes('user-created')) return false;
				else if (field.special.includes('user-updated')) return false;
				else return true;
			})
			.map((field) => field.field);

		let fieldMaybeUniques: { field: string; unique: boolean; unique_combination: boolean }[] = [];
		const excludedColections = ['directus_fields'];
		if (!excludedColections.includes(this.collection)) {
			const uniqueCombinationFields: string[] = [];
			fieldMaybeUniques = await this.knex
				.select('field', 'unique', 'unique_combination')
				.from('directus_fields')
				.whereIn('field', fieldNames)
				.andWhere('collection', this.collection);
			for (const field of fieldMaybeUniques) {
				const { unique, unique_combination: uniqueCombination, field: fieldName } = field;
				if (unique) {
					let count: string | number;
					if (!isSoftDelete) {
						const [{ count: countData }] = (await this.knex
							.count(fieldName, { as: 'count' })
							.from(this.collection)
							.where(fieldName, data[fieldName] || null)) as { count: string | number }[];
						count = countData;
					} else {
						const [{ count: countData }] = (await this.knex
							.count(fieldName, { as: 'count' })
							.from(this.collection)
							.where(fieldName, data[fieldName] || null)
							.andWhere(deletedAtField, null)) as { count: string | number }[];
						count = countData;
					}
					const counter = count ? Number(count) : 0;
					if (counter)
						throw new RecordNotUniqueException(fieldName, {
							collection: this.collection,
							field: fieldName,
							invalid: data[fieldName],
						});
				} else if (uniqueCombination) {
					uniqueCombinationFields.push(fieldName);
				}
			}

			const queryUniqueCombination = this.knex(this.collection).count('*', { as: 'count' });
			if (isSoftDelete) {
				queryUniqueCombination.where(deletedAtField, null);
			}
			for (const uniqueCombinationField of uniqueCombinationFields) {
				queryUniqueCombination.where(uniqueCombinationField, data[uniqueCombinationField] || null);
			}
			if (uniqueCombinationFields.length) {
				const [{ count }] = await queryUniqueCombination;
				if (Number(count) > 0) {
					const errs: RecordNotUniqueException[] = [];
					for (const field of uniqueCombinationFields) {
						errs.push(
							new RecordNotUniqueCombinationException(field, {
								collection: this.collection,
								field: field,
								invalid: data[field],
							})
						);
					}
					throw errs;
				}
			}
		}

		const payload: AnyItem = cloneDeep(data);

		// By wrapping the logic in a transaction, we make sure we automatically roll back all the
		// changes in the DB if any of the parts contained within throws an error. This also means
		// that any errors thrown in any nested relational changes will bubble up and cancel the whole
		// update tree
		const primaryKey: PrimaryKey = await this.knex.transaction(async (trx) => {
			// We're creating new services instances so they can use the transaction as their Knex interface
			const payloadService = new PayloadService(this.collection, {
				accountability: this.accountability,
				knex: trx,
				schema: this.schema,
			});

			const authorizationService = new AuthorizationService({
				accountability: this.accountability,
				knex: trx,
				schema: this.schema,
			});

			// Run all hooks that are attached to this event so the end user has the chance to augment the
			// item that is about to be saved
			const payloadAfterHooks =
				opts?.emitEvents !== false
					? await emitter.emitFilter(
							this.eventScope === 'items'
								? ['items.create', `${this.collection}.items.create`]
								: `${this.eventScope}.create`,
							payload,
							{
								collection: this.collection,
							},
							{
								database: trx,
								schema: this.schema,
								accountability: this.accountability,
								options: {
									headers: {
										bearerToken: this.bearerToken,
									},
								},
							}
					  )
					: payload;

			const payloadWithPresets = this.accountability
				? await authorizationService.validatePayload('create', this.collection, payloadAfterHooks)
				: payloadAfterHooks;

			const { payload: payloadWithM2O, revisions: revisionsM2O } = await payloadService.processM2O(payloadWithPresets);
			const { payload: payloadWithA2O, revisions: revisionsA2O } = await payloadService.processA2O(payloadWithM2O);

			const payloadWithoutAliases = pick(payloadWithA2O, without(fields, ...aliases));
			const payloadWithTypeCasting = await payloadService.processValues('create', payloadWithoutAliases);

			// In case of manual string / UUID primary keys, the PK already exists in the object we're saving.
			let primaryKey = payloadWithTypeCasting[primaryKeyField];

			try {
				const result = await trx
					.insert(payloadWithoutAliases)
					.into(this.collection)
					.returning(primaryKeyField)
					.then((result) => result[0]);

				const returnedKey = typeof result === 'object' ? result[primaryKeyField] : result;
				primaryKey = primaryKey ?? returnedKey;
			} catch (err: any) {
				throw await translateDatabaseError(err);
			}

			// Most database support returning, those who don't tend to return the PK anyways
			// (MySQL/SQLite). In case the primary key isn't know yet, we'll do a best-attempt at
			// fetching it based on the last inserted row
			if (!primaryKey) {
				// Fetching it with max should be safe, as we're in the context of the current transaction
				const result = await trx.max(primaryKeyField, { as: 'id' }).from(this.collection).first();
				primaryKey = result.id;
				// Set the primary key on the input item, in order for the "after" event hook to be able
				// to read from it
				payload[primaryKeyField] = primaryKey;
			}
			if (typeof primaryKey == 'object' && primaryKey.id) primaryKey = primaryKey.id;

			const { revisions: revisionsO2M } = await payloadService.processO2M(payload, primaryKey);

			// If this is an authenticated action, and accountability tracking is enabled, save activity row
			if (this.accountability && this.schema.collections[this.collection].accountability !== null) {
				const activityService = new ActivityService({
					knex: trx,
					schema: this.schema,
				});

				const activity = await activityService.createOne({
					action: Action.CREATE,
					user: this.accountability!.user,
					collection: this.collection,
					ip: this.accountability!.ip,
					user_agent: this.accountability!.userAgent,
					item: primaryKey,
				});

				// If revisions are tracked, create revisions record
				if (this.schema.collections[this.collection].accountability === 'all') {
					const revisionsService = new RevisionsService({
						knex: trx,
						schema: this.schema,
					});

					const revision = await revisionsService.createOne({
						activity: activity,
						collection: this.collection,
						item: primaryKey,
						data: await payloadService.prepareDelta(payload),
						delta: await payloadService.prepareDelta(payload),
					});

					// Make sure to set the parent field of the child-revision rows
					const childrenRevisions = [...revisionsM2O, ...revisionsA2O, ...revisionsO2M];

					if (childrenRevisions.length > 0) {
						await revisionsService.updateMany(childrenRevisions, { parent: revision });
					}

					if (opts?.onRevisionCreate) {
						opts.onRevisionCreate(revision);
					}
				}
			}

			return primaryKey;
		});

		if (opts?.emitEvents !== false) {
			emitter.emitAction(
				this.eventScope === 'items' ? ['items.create', `${this.collection}.items.create`] : `${this.eventScope}.create`,
				{
					payload,
					key: primaryKey,
					collection: this.collection,
				},
				{
					// This hook is called async. If we would pass the transaction here, the hook can be
					// called after the transaction is done #5460
					database: this.knex || getDatabase(),
					schema: this.schema,
					accountability: this.accountability,
					options: {
						headers: {
							bearerToken: this.bearerToken,
						},
					},
				}
			);
		}

		if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return primaryKey;
	}

	/**
	 * Create multiple new items at once. Inserts all provided records sequentially wrapped in a transaction.
	 */
	async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const primaryKeys = await this.knex.transaction(async (trx) => {
			const service = new ItemsService(this.collection, {
				accountability: this.accountability,
				schema: this.schema,
				knex: trx,
			});

			const primaryKeys: PrimaryKey[] = [];

			for (const payload of data) {
				const primaryKey = await service.createOne(payload, { ...(opts || {}), autoPurgeCache: false });
				primaryKeys.push(primaryKey);
			}

			return primaryKeys;
		});

		if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return primaryKeys;
	}

	/**
	 * Get items by query
	 */
	async readByQuery(query: Query, opts?: QueryOptions): Promise<Item[]> {
		if (!this.schema.collections[this.collection])
			throw new InvalidPayloadException(`Collection ${this.collection} doesn't exist`);
		const { isSoftDelete, fields } = this.schema.collections[this.collection];

		let queryData: Partial<Query> = { ...query };
		if (isSoftDelete) {
			let deletedAtField = 'deleted_at';
			for (const fieldName in fields) {
				const { special } = fields[fieldName];
				if (special.includes('date-deleted')) {
					deletedAtField = fieldName;
					break;
				}
			}
			const filter = queryData.filter as any;
			if (!query.showSoftDelete) {
				if (filter) {
					if (filter._and) {
						queryData.filter = {
							_and: [
								...filter._and,
								{
									[deletedAtField]: {
										_null: true,
									},
								},
							],
						};
					} else if (filter._or) {
						queryData.filter = {
							_and: [
								{
									_or: filter._or,
								},
								{
									_and: [
										{
											[deletedAtField]: {
												_null: true,
											},
										},
									],
								},
							],
						};
					} else {
						queryData.filter = {
							...queryData.filter,
							[deletedAtField]: {
								_null: true,
							},
						};
					}
				} else {
					queryData = {
						...queryData,
						filter: {
							[deletedAtField]: {
								_null: true,
							},
						},
					};
				}
			}
		}

		let ast = await getASTFromQuery(this.collection, queryData, this.schema, {
			accountability: this.accountability,
			// By setting the permissions action, you can read items using the permissions for another
			// operation's permissions. This is used to dynamically check if you have update/delete
			// access to (a) certain item(s)
			action: opts?.permissionsAction || 'read',
			knex: this.knex,
		});

		if (this.accountability && this.accountability.admin !== true) {
			const authorizationService = new AuthorizationService({
				accountability: this.accountability,
				knex: this.knex,
				schema: this.schema,
			});

			ast = await authorizationService.processAST(ast, opts?.permissionsAction);
		}

		const records = await runAST(ast, this.schema, {
			knex: this.knex,
			// GraphQL requires relational keys to be returned regardless
			stripNonRequested: opts?.stripNonRequested !== undefined ? opts.stripNonRequested : true,
			transformers: opts?.transformers,
		});
		if (records === null) {
			throw new ForbiddenException();
		}
		const filteredRecords = await emitter.emitFilter(
			this.eventScope === 'items' ? ['items.read', `${this.collection}.items.read`] : `${this.eventScope}.read`,
			records,
			{
				query,
				collection: this.collection,
			},
			{
				database: this.knex,
				schema: this.schema,
				accountability: this.accountability,
				options: {
					headers: {
						bearerToken: this.bearerToken,
					},
				},
			}
		);

		emitter.emitAction(
			this.eventScope === 'items' ? ['items.read', `${this.collection}.items.read`] : `${this.eventScope}.read`,
			{
				payload: filteredRecords,
				query,
				collection: this.collection,
			},
			{
				database: this.knex || getDatabase(),
				schema: this.schema,
				accountability: this.accountability,
				options: {
					headers: {
						bearerToken: this.bearerToken,
					},
				},
			}
		);
		return filteredRecords as Item[];
	}

	/**
	 * Get single item by primary key
	 */
	async readOne(key: PrimaryKey, query: Query = {}, opts?: QueryOptions): Promise<Item> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, key);

		const filterWithKey = assign({}, query.filter, { [primaryKeyField]: { _eq: key } });
		const queryWithKey = assign({}, query, { filter: filterWithKey });

		const results = await this.readByQuery(queryWithKey, opts);

		if (results.length === 0) {
			throw new ForbiddenException();
		}

		return results[0];
	}

	/**
	 * Get multiple items by primary keys
	 */
	async readMany(keys: PrimaryKey[], query: Query = {}, opts?: QueryOptions): Promise<Item[]> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, keys);

		const filterWithKey = { _and: [{ [primaryKeyField]: { _in: keys } }, query.filter ?? {}] };
		const queryWithKey = assign({}, query, { filter: filterWithKey });

		// Set query limit as the number of keys
		if (Array.isArray(keys) && keys.length > 0 && !queryWithKey.limit) {
			queryWithKey.limit = keys.length;
		}

		const results = await this.readByQuery(queryWithKey, opts);

		return results;
	}

	/**
	 * Update multiple items by query
	 */
	async updateByQuery(query: Query, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		const keys = await this.getKeysByQuery(query);

		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, keys);

		return keys.length ? await this.updateMany(keys, data, opts) : [];
	}

	/**
	 * Update a single item by primary key
	 */
	async updateOne(key: PrimaryKey, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, key);

		await this.updateMany([key], data, opts);
		return key;
	}

	/**
	 * Update many items by primary key
	 */
	async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		const isSoftDelete = this.schema.collections[this.collection].isSoftDelete;
		const fields = Object.keys(this.schema.collections[this.collection].fields);
		const aliases = Object.values(this.schema.collections[this.collection].fields)
			.filter((field) => field.alias === true)
			.map((field) => field.field);

		let deletedAtField = 'deleted_at';

		const fieldNames = Object.values(this.schema.collections[this.collection].fields)
			.filter((field) => {
				if (field.field == primaryKeyField) return false;
				else if (field.special.includes('date-deleted')) {
					if (isSoftDelete) deletedAtField = field.field;
					return false;
				} else if (field.special.includes('date-updated')) return false;
				else if (field.special.includes('date-created')) return false;
				else if (field.special.includes('user-created')) return false;
				else if (field.special.includes('user-updated')) return false;
				else return true;
			})
			.map((field) => field.field);

		//check uniqueness
		const fieldMaybeUniques: { field: string; unique: boolean; unique_combination: boolean }[] = await this.knex
			.select('field', 'unique', 'unique_combination')
			.from('directus_fields')
			.whereIn('field', fieldNames)
			.andWhere('collection', this.collection);
		const uniqueCombinationFields: string[] = [];

		for (const field of fieldMaybeUniques) {
			const { unique, field: fieldName, unique_combination: uniqueCombination } = field;
			if (unique) {
				let count: string | number;
				if (!isSoftDelete) {
					const [{ count: countData }] = (await this.knex
						.count(fieldName, { as: 'count' })
						.from(this.collection)
						.where(fieldName, data[fieldName] || null)
						.whereNotIn(primaryKeyField, keys)) as { count: string | number }[];
					count = countData;
				} else {
					const [{ count: countData }] = (await this.knex
						.count(fieldName, { as: 'count' })
						.from(this.collection)
						.where(fieldName, data[fieldName] || null)
						.whereNotIn(primaryKeyField, keys)
						.andWhere(deletedAtField, null)) as { count: string | number }[];
					count = countData;
				}
				const counter = count ? Number(count) : 0;
				if (counter)
					throw new RecordNotUniqueException(fieldName, {
						collection: this.collection,
						field: fieldName,
						invalid: data[fieldName],
					});
				if (keys.length > 1 && typeof data[fieldName] != 'undefined')
					throw new RecordNotUniqueException(fieldName, {
						collection: this.collection,
						field: fieldName,
						invalid: data[fieldName],
					});
			} else if (uniqueCombination) {
				uniqueCombinationFields.push(fieldName);
			}
		}

		// check unique with combination
		if (uniqueCombinationFields.length) {
			if (keys.length > 1) {
				let isMaybeNotUnique = false;
				const fieldUniqueNotProvideds = [];
				const errs: RecordNotUniqueCombinationException[] = [];
				for (const uniqueCombinationField of uniqueCombinationFields) {
					if (typeof data[uniqueCombinationField] != 'undefined') {
						errs.push(
							new RecordNotUniqueCombinationException(uniqueCombinationField, {
								collection: this.collection,
								field: uniqueCombinationField,
								invalid: data[uniqueCombinationField],
							})
						);
						isMaybeNotUnique = true;
					} else {
						fieldUniqueNotProvideds.push(uniqueCombinationField);
					}
				}

				if (isMaybeNotUnique) {
					const query = this.knex(this.collection)
						.count('*', { as: 'count' })
						.whereIn(primaryKeyField, keys)
						.orderBy('count', 'desc');
					if (isSoftDelete) {
						query.where(deletedAtField, null);
					}
					if (fieldUniqueNotProvideds.length > 0) {
						query.select(fieldUniqueNotProvideds).groupBy(fieldUniqueNotProvideds);
					} else {
						if (errs.length >= uniqueCombinationFields.length) throw errs;
					}
					const [{ count }] = await query;
					if (Number(count) > 1) throw errs;
				}
			} else if (keys.length === 1) {
				const queryCurrentData = this.knex(this.collection).select('*').where(primaryKeyField, keys[0]);
				const query = this.knex(this.collection).select('*').first();
				if (isSoftDelete) {
					queryCurrentData.where(deletedAtField, null);
					query.where(deletedAtField, null);
				}
				const currentData = await queryCurrentData.first();
				if (currentData) {
					const errs: RecordNotUniqueCombinationException[] = [];
					for (const uniqueCombinationField of uniqueCombinationFields) {
						const uniqueData =
							typeof data[uniqueCombinationField] == 'undefined'
								? currentData[uniqueCombinationField]
								: data[uniqueCombinationField];
						query.where(uniqueCombinationField, uniqueData);
						errs.push(
							new RecordNotUniqueCombinationException(uniqueCombinationField, {
								collection: this.collection,
								field: uniqueCombinationField,
								invalid: uniqueData,
							})
						);
					}
					query.whereNot(primaryKeyField, keys[0]);
					const existingData = await query;

					if (existingData) throw errs;
				}
			}
		}

		const payload: Partial<AnyItem> = cloneDeep(data);

		const authorizationService = new AuthorizationService({
			accountability: this.accountability,
			knex: this.knex,
			schema: this.schema,
		});

		// Run all hooks that are attached to this event so the end user has the chance to augment the
		// item that is about to be saved
		const payloadAfterHooks =
			opts?.emitEvents !== false
				? await emitter.emitFilter(
						this.eventScope === 'items'
							? ['items.update', `${this.collection}.items.update`]
							: `${this.eventScope}.update`,
						payload,
						{
							keys,
							collection: this.collection,
						},
						{
							database: this.knex,
							schema: this.schema,
							accountability: this.accountability,
							options: {
								headers: {
									bearerToken: this.bearerToken,
								},
							},
						}
				  )
				: payload;

		// Sort keys to ensure that the order is maintained
		keys.sort();

		if (this.accountability) {
			await authorizationService.checkAccess('update', this.collection, keys);
		}

		const payloadWithPresets = this.accountability
			? await authorizationService.validatePayload('update', this.collection, payloadAfterHooks)
			: payloadAfterHooks;

		await this.knex.transaction(async (trx) => {
			const payloadService = new PayloadService(this.collection, {
				accountability: this.accountability,
				knex: trx,
				schema: this.schema,
			});

			const { payload: payloadWithM2O, revisions: revisionsM2O } = await payloadService.processM2O(payloadWithPresets);
			const { payload: payloadWithA2O, revisions: revisionsA2O } = await payloadService.processA2O(payloadWithM2O);

			const payloadWithoutAliasAndPK = pick(payloadWithA2O, without(fields, primaryKeyField, ...aliases));
			const payloadWithTypeCasting = await payloadService.processValues('update', payloadWithoutAliasAndPK);

			if (Object.keys(payloadWithTypeCasting).length > 0) {
				try {
					await trx(this.collection).update(payloadWithTypeCasting).whereIn(primaryKeyField, keys);
				} catch (err: any) {
					throw await translateDatabaseError(err);
				}
			}

			const childrenRevisions = [...revisionsM2O, ...revisionsA2O];

			for (const key of keys) {
				const { revisions } = await payloadService.processO2M(payload, key);
				childrenRevisions.push(...revisions);
			}

			// If this is an authenticated action, and accountability tracking is enabled, save activity row
			if (this.accountability && this.schema.collections[this.collection].accountability !== null) {
				const activityService = new ActivityService({
					knex: trx,
					schema: this.schema,
				});

				const activity = await activityService.createMany(
					keys.map((key) => ({
						action: Action.UPDATE,
						user: this.accountability!.user,
						collection: this.collection,
						ip: this.accountability!.ip,
						user_agent: this.accountability!.userAgent,
						item: key,
					}))
				);

				if (this.schema.collections[this.collection].accountability === 'all') {
					const itemsService = new ItemsService(this.collection, {
						knex: trx,
						schema: this.schema,
					});

					const snapshots = await itemsService.readMany(keys);

					const revisionsService = new RevisionsService({
						knex: trx,
						schema: this.schema,
					});

					const revisions = (
						await Promise.all(
							activity.map(async (activity, index) => ({
								activity: activity,
								collection: this.collection,
								item: keys[index],
								data:
									snapshots && Array.isArray(snapshots) ? JSON.stringify(snapshots[index]) : JSON.stringify(snapshots),
								delta: await payloadService.prepareDelta(payloadWithTypeCasting),
							}))
						)
					).filter((revision) => revision.delta);

					const revisionIDs = await revisionsService.createMany(revisions);

					for (let i = 0; i < revisionIDs.length; i++) {
						const revisionID = revisionIDs[i];

						if (opts?.onRevisionCreate) {
							opts.onRevisionCreate(revisionID);
						}

						if (i === 0) {
							// In case of a nested relational creation/update in a updateMany, the nested m2o/a2o
							// creation is only done once. We treat the first updated item as the "main" update,
							// with all other revisions on the current level as regular "flat" updates, and
							// nested revisions as children of this first "root" item.
							if (childrenRevisions.length > 0) {
								await revisionsService.updateMany(childrenRevisions, { parent: revisionID });
							}
						}
					}
				}
			}
		});

		if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		if (opts?.emitEvents !== false) {
			emitter.emitAction(
				this.eventScope === 'items' ? ['items.update', `${this.collection}.items.update`] : `${this.eventScope}.update`,
				{
					payload,
					keys,
					collection: this.collection,
				},
				{
					// This hook is called async. If we would pass the transaction here, the hook can be
					// called after the transaction is done #5460
					database: this.knex || getDatabase(),
					schema: this.schema,
					accountability: this.accountability,
					options: {
						headers: {
							bearerToken: this.bearerToken,
						},
					},
				}
			);
		}

		return keys;
	}

	/**
	 * Upsert a single item
	 */
	async upsertOne(payload: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		const primaryKey: PrimaryKey | undefined = payload[primaryKeyField];

		if (primaryKey) {
			validateKeys(this.schema, this.collection, primaryKeyField, primaryKey);
		}

		const exists =
			primaryKey &&
			!!(await this.knex
				.select(primaryKeyField)
				.from(this.collection)
				.where({ [primaryKeyField]: primaryKey })
				.first());

		if (exists) {
			return await this.updateOne(primaryKey as PrimaryKey, payload, opts);
		} else {
			return await this.createOne(payload, opts);
		}
	}

	/**
	 * Upsert many items
	 */
	async upsertMany(payloads: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const primaryKeys = await this.knex.transaction(async (trx) => {
			const service = new ItemsService(this.collection, {
				accountability: this.accountability,
				schema: this.schema,
				knex: trx,
			});

			const primaryKeys: PrimaryKey[] = [];

			for (const payload of payloads) {
				const primaryKey = await service.upsertOne(payload, { ...(opts || {}), autoPurgeCache: false });
				primaryKeys.push(primaryKey);
			}

			return primaryKeys;
		});

		if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return primaryKeys;
	}

	/**
	 * Delete multiple items by query
	 */
	async deleteByQuery(query: Query, opts?: MutationOptions): Promise<PrimaryKey[]> {
		const keys = await this.getKeysByQuery(query);

		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, keys);

		return keys.length ? await this.deleteMany(keys, opts) : [];
	}

	/**
	 * Delete a single item by primary key
	 */
	async deleteOne(key: PrimaryKey, opts?: MutationOptions): Promise<PrimaryKey> {
		const primaryKeyField = this.schema.collections[this.collection].primary;
		validateKeys(this.schema, this.collection, primaryKeyField, key);

		await this.deleteMany([key], opts);
		return key;
	}

	/**
	 * Delete multiple items by primary key
	 */
	async deleteMany(keys: PrimaryKey[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const { isSoftDelete, primary: primaryKeyField, fields } = this.schema.collections[this.collection];
		validateKeys(this.schema, this.collection, primaryKeyField, keys);
		const relations = this.schema.relationMap[this.collection];

		if (relations) {
			for (const relation of relations) {
				const { related_collection, meta } = relation;
				if (related_collection == this.collection && meta) {
					const { one_field, many_collection, many_field } = meta;
					if (
						opts?.deleteds &&
						(opts?.deleteds?.includes(one_field as string) || opts?.deleteds?.includes(many_collection))
					) {
						const relatedService = new ItemsService(many_collection, {
							schema: this.schema,
							knex: this.knex,
							accountability: this.accountability,
						});
						const relatedKeys = await relatedService.getKeysByQuery({
							filter: {
								[many_field]: {
									_in: keys,
								},
							},
						});

						if (relatedKeys.length) await relatedService.deleteMany(relatedKeys, opts);
					}
				}
			}
		}

		const deletedAtFields = ['deleted_at'];
		let deletedByField: string | null = null;
		for (const fieldName in fields) {
			const { special } = fields[fieldName];
			if (special.includes('date-deleted')) {
				if (!deletedAtFields.includes(fieldName)) deletedAtFields.push(fieldName);
			} else if (special.includes('user-deleted')) {
				deletedByField = fieldName;
			}
		}

		if (this.accountability && this.accountability.admin !== true) {
			const authorizationService = new AuthorizationService({
				accountability: this.accountability,
				schema: this.schema,
				knex: this.knex,
			});

			await authorizationService.checkAccess('delete', this.collection, keys);
		}

		if (opts?.emitEvents !== false) {
			await emitter.emitFilter(
				this.eventScope === 'items' ? ['items.delete', `${this.collection}.items.delete`] : `${this.eventScope}.delete`,
				keys,
				{
					collection: this.collection,
				},
				{
					database: this.knex,
					schema: this.schema,
					accountability: this.accountability,
					options: {
						headers: {
							bearerToken: this.bearerToken,
						},
					},
				}
			);
		}

		await this.knex.transaction(async (trx) => {
			let action: string = Action.DELETE;
			if (isSoftDelete) {
				if (opts?.forceDelete) {
					await trx(this.collection).whereIn(primaryKeyField, keys).delete();
				} else {
					const payload = {
						...(deletedByField ? { [deletedByField]: this.accountability?.user } : {}),
					};
					const query = trx(this.collection).whereIn(primaryKeyField, keys);
					for (const deletedAtField of deletedAtFields) {
						payload[deletedAtField] = new Date().toISOString();
						query.andWhere(deletedAtField, null);
					}
					await query.update(payload);
					action = Action.SOFTDELETE;
				}
			} else {
				await trx(this.collection).whereIn(primaryKeyField, keys).delete();
			}

			if (this.accountability && this.schema.collections[this.collection].accountability !== null) {
				const activityService = new ActivityService({
					knex: trx,
					schema: this.schema,
				});

				await activityService.createMany(
					keys.map((key) => ({
						action,
						user: this.accountability!.user,
						collection: this.collection,
						ip: this.accountability!.ip,
						user_agent: this.accountability!.userAgent,
						item: key,
					}))
				);
			}
		});

		if (this.cache && env.CACHE_AUTO_PURGE && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		if (opts?.emitEvents !== false) {
			emitter.emitAction(
				this.eventScope === 'items' ? ['items.delete', `${this.collection}.items.delete`] : `${this.eventScope}.delete`,
				{
					payload: keys,
					keys: keys,
					collection: this.collection,
				},
				{
					// This hook is called async. If we would pass the transaction here, the hook can be
					// called after the transaction is done #5460
					database: this.knex || getDatabase(),
					schema: this.schema,
					accountability: this.accountability,
					options: {
						headers: {
							bearerToken: this.bearerToken,
						},
					},
				}
			);
		}

		return keys;
	}

	/**
	 * Read/treat collection as singleton
	 */
	async readSingleton(query: Query, opts?: QueryOptions): Promise<Partial<Item>> {
		query = clone(query);

		query.limit = 1;

		const records = await this.readByQuery(query, opts);
		const record = records[0];

		if (!record) {
			let fields = Object.entries(this.schema.collections[this.collection].fields);
			const defaults: Record<string, any> = {};

			if (query.fields && query.fields.includes('*') === false) {
				fields = fields.filter(([name]) => {
					return query.fields!.includes(name);
				});
			}

			for (const [name, field] of fields) {
				if (this.schema.collections[this.collection].primary === name) {
					defaults[name] = null;
					continue;
				}

				if (field.defaultValue) defaults[name] = field.defaultValue;
			}

			return defaults as Partial<Item>;
		}

		return record;
	}

	/**
	 * Upsert/treat collection as singleton
	 */
	async upsertSingleton(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		const primaryKeyField = this.schema.collections[this.collection].primary;

		const record = await this.knex.select(primaryKeyField).from(this.collection).limit(1).first();

		if (record) {
			return await this.updateOne(record[primaryKeyField], data, opts);
		}

		return await this.createOne(data, opts);
	}

	/**
	 * Restore data
	 */
	async restore(keys: PrimaryKey[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const { isSoftDelete, fields, primary: primaryKeyField } = this.schema.collections[this.collection];

		const payloadDeletedAt: { [fieldName: string]: null } = {};
		if (isSoftDelete) {
			let deletedByField: string | null = null;
			const deletedAtFields: string[] = [];
			for (const fieldName in fields) {
				const { special } = fields[fieldName];
				if (special && special.includes('date-deleted')) {
					if (!deletedAtFields.includes(fieldName)) {
						deletedAtFields.push(fieldName);
						payloadDeletedAt[fieldName] = null;
					}
				} else if (special && special.includes('user-deleted')) {
					deletedByField = fieldName;
				}
			}
			if (opts?.emitEvents !== false) {
				await emitter.emitFilter(
					this.eventScope === 'items'
						? ['items.restore', `${this.collection}.items.restore`]
						: `${this.eventScope}.restore`,
					keys,
					{
						collection: this.collection,
					},
					{
						database: this.knex,
						schema: this.schema,
						accountability: this.accountability,
						options: {
							headers: {
								bearerToken: this.bearerToken,
							},
						},
					}
				);
			}
			await this.knex.transaction(async (trx) => {
				const fieldNames = Object.values(this.schema.collections[this.collection].fields)
					.filter((field) => {
						if (field.field == primaryKeyField) return false;
						else if (field.special.includes('date-deleted')) return false;
						else if (field.special.includes('date-updated')) return false;
						else if (field.special.includes('date-created')) return false;
						else if (field.special.includes('user-created')) return false;
						else if (field.special.includes('user-updated')) return false;
						else if (field.special.includes('user-deleted')) return false;
						else {
							if (deletedAtFields.includes(field.field)) return false;
							return true;
						}
					})
					.map((field) => field.field);

				const fieldMaybeUniques: { field: string; unique: boolean }[] = await trx
					.select('field', 'unique')
					.from('directus_fields')
					.whereIn('field', fieldNames)
					.andWhere('collection', this.collection);

				const datas = await trx(this.collection).whereIn(primaryKeyField, keys).select('*');

				const payload = {
					...payloadDeletedAt,
					...(deletedByField ? { [deletedByField]: null } : {}),
				};

				for (const data of datas) {
					for (const field of fieldMaybeUniques) {
						const { unique, field: fieldName } = field;
						if (unique) {
							let count: string | number = 0;
							const query = trx
								.count(fieldName, { as: 'count' })
								.from(this.collection)
								.where(fieldName, data[fieldName] || null)
								.whereNot(primaryKeyField, data[primaryKeyField]);

							for (const deletedAtField of deletedAtFields) {
								query.andWhere(deletedAtField, null);
							}
							const [{ count: countData }] = (await query) as { count: string | number }[];
							count = countData;
							const counter = count ? Number(count) : 0;
							if (counter) {
								throw new RecordNotUniqueException(fieldName, {
									collection: this.collection,
									field: fieldName,
									invalid: data[fieldName],
								});
							}
						}
					}

					await trx(this.collection).whereIn(this.schema.collections[this.collection].primary, keys).update(payload);
				}

				if (this.accountability && this.schema.collections[this.collection].accountability !== null) {
					const activityService = new ActivityService({
						knex: trx,
						schema: this.schema,
					});

					await activityService.createMany(
						keys.map((key) => ({
							action: Action.RESTORE,
							user: this.accountability!.user,
							collection: this.collection,
							ip: this.accountability!.ip,
							user_agent: this.accountability!.userAgent,
							item: key,
						}))
					);
				}

				if (opts?.emitEvents !== false) {
					emitter.emitAction(
						this.eventScope === 'items'
							? ['items.restore', `${this.collection}.items.restore`]
							: `${this.eventScope}.restore`,
						{
							payload: keys,
							collection: this.collection,
						},
						{
							// This hook is called async. If we would pass the transaction here, the hook can be
							// called after the transaction is done #5460
							database: this.knex || getDatabase(),
							schema: this.schema,
							accountability: this.accountability,
							options: {
								headers: {
									bearerToken: this.bearerToken,
								},
							},
						}
					);
				}
			});
			return keys;
		}
		throw new InvalidPayloadException('Soft delete is not enabled for this collection');
	}
}
