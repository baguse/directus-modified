import { Knex } from 'knex';
import getDatabase from '../database';
import { ForbiddenException } from '../exceptions';
import { AbstractServiceOptions } from '../types';
import { Accountability, Query, SchemaOverview } from '@directus/shared/types';
import { applyFilter, applySearch } from '../utils/apply-query';

export class MetaService {
	knex: Knex;
	accountability: Accountability | null;
	schema: SchemaOverview;
	deletedAtField = 'deleted_at';

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.schema = options.schema;
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	async getMetaForQuery(collection: string, query: any): Promise<Record<string, any> | undefined> {
		if (!query || !query.meta) return;
		const { fields } = this.schema.collections[collection];

		let totalCount = 0;

		for (const fieldName in fields) {
			const { special } = fields[fieldName];
			if (special.includes('date-deleted')) {
				this.deletedAtField = fieldName;
				break;
			}
		}

		const results = await Promise.all(
			query.meta.map(async (metaVal: string) => {
				if (metaVal === 'total_count') return this.totalCount(collection, query);
				if (metaVal === 'filter_count') return this.filterCount(collection, query);
				if (metaVal === 'current_page') return Number(query.page);
				if (metaVal === 'limit') return Number(query.limit);
				if (metaVal === 'total_page') return this.getTotalPage(collection, query, totalCount);
				if (metaVal === 'count') {
					totalCount = await this.getTotalCount(collection, query);
					return totalCount;
				}
			})
		);

		return results.reduce((metaObject: Record<string, any>, value, index) => {
			return {
				...metaObject,
				[query.meta![index]]: value,
			};
		}, {});
	}

	async totalCount(collection: string, query: Query): Promise<number> {
		const dbQuery = this.knex(collection).count('*', { as: 'count' }).first();
		const { isSoftDelete } = this.schema.collections[collection];

		if (isSoftDelete) {
			if (!query.showSoftDelete) {
				dbQuery.where(this.deletedAtField, null);
			}
		}

		if (this.accountability?.admin !== true) {
			const permissionsRecord = this.accountability?.permissions?.find((permission) => {
				return permission.action === 'read' && permission.collection === collection;
			});

			if (!permissionsRecord) throw new ForbiddenException();

			const permissions = permissionsRecord.permissions ?? {};

			applyFilter(this.knex, this.schema, dbQuery, permissions, collection);
		}

		const result = await dbQuery;

		return Number(result?.count ?? 0);
	}

	async filterCount(collection: string, query: Query): Promise<number> {
		const dbQuery = this.knex(collection).count('*', { as: 'count' });
		const { isSoftDelete } = this.schema.collections[collection];

		if (isSoftDelete) {
			if (!query.showSoftDelete) {
				dbQuery.where(this.deletedAtField, null);
			}
		}
		let filter = query.filter || {};

		if (this.accountability?.admin !== true) {
			const permissionsRecord = this.accountability?.permissions?.find((permission) => {
				return permission.action === 'read' && permission.collection === collection;
			});

			if (!permissionsRecord) throw new ForbiddenException();

			const permissions = permissionsRecord.permissions ?? {};

			if (Object.keys(filter).length > 0) {
				filter = { _and: [permissions, filter] };
			} else {
				filter = permissions;
			}
		}

		if (Object.keys(filter).length > 0) {
			applyFilter(this.knex, this.schema, dbQuery, filter, collection);
		}

		if (query.search) {
			applySearch(this.schema, dbQuery, query.search, collection);
		}

		const records = await dbQuery;

		return Number(records[0].count);
	}

	async getTotalCount(collection: string, query: Query): Promise<number> {
		const totalCount = await this.filterCount(collection, {
			filter: query.filter,
			search: query.search,
			aggregate: query.aggregate,
			group: query.group,
			fields: query.fields,
			showSoftDelete: query.showSoftDelete,
		});

		return totalCount;
	}

	async getTotalPage(collection: string, query: Query, totalCount?: number): Promise<number> {
		if (totalCount) return Math.ceil(totalCount / (query.limit || 0));
		else {
			totalCount = await this.getTotalCount(collection, query);
			return Math.ceil(totalCount / (query.limit || 0));
		}
	}
}
