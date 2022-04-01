import { Knex } from 'knex';
import getDatabase from '../database';
import { systemCollectionRows } from '../database/system-data/collections';
import { ForbiddenException, InvalidPayloadException } from '../exceptions';
import { AbstractServiceOptions, PrimaryKey } from '../types';
import { Accountability, SchemaOverview } from '@directus/shared/types';
import standardDeviation from 'ml-array-standard-deviation';

export class SagesService {
	knex: Knex;
	accountability: Accountability | null;
	schema: SchemaOverview;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.schema = options.schema;
	}

	async core(insight: any): Promise<any> {
		try {
			const credential = await this.knex
				.select('c.id', 'c.dialect', 'd.prefix_query')
				.from('credentials as c')
				.leftJoin('sage_dialects as d', 'c.dialect', 'd.id')
				.where('c.id', insight.credential)
				.first();

			if (!credential) throw new Error("Can't get credential");

			const statements = await this.knex
				.select('ss.name', 'ss.placement')
				.from('sage_statements as ss')
				.where('ss.dialect', credential.dialect);

			const expressions = await this.knex
				.select('e.expression', 'e.placement')
				.from('sage_expressions as e')
				.where('e.dialect', credential.dialect);

			let classifications = await this.knex
				.select(
					'c.custom_column',
					'c.join',
					'c.filter',
					'c.sort',
					'c.summarize',
					'c.summarize_by',
					'c.limit_row',
					't.syntax',
					'c.weight'
				)
				.from('sage_classification as c')
				.leftJoin('sage_templates as t', 'c.template', 't.id')
				.where('c.dialect', insight.credential);

			classifications = classifications.map((classification: any) => {
				const { custom_column, join, filter, sort, summarize, summarize_by, limit_row, syntax } = classification;

				let { weight } = classification;

				const models = [custom_column, join, filter, sort, summarize, summarize_by, limit_row];

				if (!weight) weight = standardDeviation(models);

				return {
					models, // [1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07]
					weight, // std. dev
					syntax, // SELECT #columns FROM #table
				};
			});

			const sample = {
				model: Array.from({ length: 7 }, (_v, _i) => 0),
				weight: 0,
				syntax: '',
			};

			if (insight.custom_columns.length > 0) sample.model[0] = 1.01;
			if (insight.join) sample.model[1] = 1.02;
			if (insight.filters.length > 0) sample.model[2] = 1.03;
			if (insight.sorts.length > 0) sample.model[3] = 1.04;
			if (insight.summarizes.length > 0) sample.model[4] = 1.05;
			if (insight.summarizes_by.length > 0) sample.model[5] = 1.06;
			if (insight.limit_row > 0) sample.model[6] = 1.07;

			// [1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07]

			sample.weight = standardDeviation(sample.model);

			const [distance] = classifications
				.map((d: { syntax: any; weight: number }) => {
					return {
						syntax: d.syntax,
						distance: Math.abs(d.weight - sample.weight),
					};
				})
				.sort((a: any, b: any) => a.distance - b.distance);

			sample.syntax = distance.syntax;

			if (credential.prefix_query) sample.syntax = `${credential.prefix_query} ${sample.syntax}`;
			if (!insight.database) throw new Error('database undefined');
			if (!insight.table) throw new Error('table undefined');
			const columns = insight.columns.map((d: { name: any; as: any }) => `${d.name} AS ${d.as}`).join(', '); // name AS name, code AS code
			const conditions = insight.filters
				.map((d: { column: any; operator: any; value: any }) => `${d.column} ${d.operator} ${d.value}`) // ["column_name #equal 1", "column_name2 #not_equal 2"]
				.join(' AND '); // column_name #equal 1 AND column_name2 #not_equal 2
			const orders = insight.sorts.map((d: { column: any; type: any }) => `${d.column} ${d.type}`).join(', ');
			const summarizes_by = insight.summarizes_by.map((d: any) => `${d}`).join(', ');
			const summarizes = insight.summarizes.map((d: any) => `${d.function}("${d.column}") AS ${d.name}`).join(', ');
			const custom_columns = insight.custom_columns.map((d: any) => `${d.formula} AS ${d.name}`).join(', ');

			sample.syntax = sample.syntax
				.replace(/#database/g, insight.database)
				.replace(/#table/g, insight.table)
				.replace(/#columns/g, columns)
				.replace(/#conditions/g, conditions)
				.replace(/#orders/g, orders)
				.replace(/#summarizes_by/g, summarizes_by)
				.replace(/#summarizes/g, summarizes)
				.replace(/#custom_columns/g, custom_columns);

			for (const statement of statements) {
				sample.syntax = sample.syntax.replace(new RegExp(statement.placement, 'g'), statement.name);
			}

			for (const expression of expressions) {
				sample.syntax = sample.syntax.replace(new RegExp(expression.placement, 'g'), expression.expression);
			}

			if (insight.join) {
				sample.syntax = sample.syntax
					.replace(/#join_type/g, String(insight.join.join_type).toUpperCase())
					.replace(/#table/g, insight.table)
					.replace(/#left_column/g, insight.join.left_column)
					.replace(/#right_table/g, insight.join.right_table)
					.replace(/#right_column/g, insight.join.right_column);
			}

			if (insight.limit_row > -1) sample.syntax = sample.syntax.replace(/#limit_row/g, String(insight.limit_row));

			return {
				result: sample,
				error: undefined,
			};
		} catch (err) {
			const error = err as Error;
			return {
				result: undefined,
				error: error?.message ?? error,
			};
		}
	}
}
